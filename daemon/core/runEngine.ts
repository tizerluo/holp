/**
 * Run engine: drives an AgentBackend through the real protocol path.
 *
 * Honesty contract (spec §M1b brief rule 1-2):
 *   - Backends are driven through the real AgentBackend contract.
 *   - The approval bridge is constructed in orchestrate_run.ts (the permissionHandler
 *     closure captures the run record and emits approval_requested, returning a PENDING
 *     Promise the backend awaits). The resume happens via approval.resumeBackend(decision)
 *     called from approval_resolve.ts — NOT via resolvePermission on the backend.
 *
 * This module is called by orchestrate_run.ts after the run record is created.
 */

import type { ConnectionContext } from "./context.js";
import type { RunRecord } from "./stores.js";
import type { Clock } from "./clock.js";
import type { AgentBackend } from "../../adapters/agent-backend.js";
import { createHash } from "node:crypto";

/** Drives the full run lifecycle asynchronously (called fire-and-forget). */
export async function driveRun(
  run: RunRecord,
  backend: AgentBackend,
  ctx: ConnectionContext,
  clock: Clock,
): Promise<void> {
  const bus = run.bus;
  ctx.governance.ensureRunState(run.run_id, "queued", clock.now());

  try {
    ctx.governance.transitionRun(run.run_id, "running", clock.now(), "backend_starting");
    // 1. Emit run_started (seq=1)
    bus.publish("run", "run_started", {
      goal: run.goal,
      trigger: run.trigger,
      ...(run.runtime ? { runtime: run.runtime } : {}),
    });

    // Track whether the backend signalled a stop/error (e.g. approval denied).
    let aborted = false;
    let abortReason: string | undefined;
    let diffArtifactContent: string | undefined;
    let diffArtifactPath: string | undefined;

    // 2. Wire backend.onMessage → events
    backend.onMessage((msg) => {
      if (run.status !== "active") return;

      switch (msg.type) {
        case "status":
          if (msg.status === "starting" || msg.status === "running") {
            bus.publish("agent", "step_started", { status: msg.status, detail: msg.detail });
          } else if (msg.status === "stopped" || msg.status === "error") {
            // Backend signalled abort (e.g. approval denied by fake or real adapter).
            aborted = true;
            abortReason = msg.detail;
          }
          break;

        case "tool-call":
          bus.publish("agent", "tool_called", {
            tool_name: msg.toolName,
            args: msg.args,
            call_id: msg.callId,
          });
          break;

        case "tool-result":
          bus.publish("agent", "tool_result", {
            tool_name: msg.toolName,
            result: msg.result,
            call_id: msg.callId,
          });
          break;

        case "fs-edit":
          if (msg.diff) {
            diffArtifactContent = msg.diff;
            diffArtifactPath = msg.path;
          }
          bus.publish("agent", "fs_edited", {
            description: msg.description,
            path: msg.path,
          });
          break;

        case "model-output":
          bus.publish("agent", "model_output", {
            text_delta: msg.textDelta,
            full_text: msg.fullText,
          });
          break;

        case "event":
          bus.publish("agent", "agent_event", {
            name: msg.name,
            payload: msg.payload,
          });
          break;

        // permission-request messages are handled via the permissionHandler injected
        // into the backend at construction time (in orchestrate_run.ts).
        case "permission-request":
          break;

        default:
          break;
      }
    });

    // 3. Start the backend session.
    // NOTE: The permissionHandler (approval bridge) is constructed in orchestrate_run.ts
    // and injected via AgentBackendOptions when the backend is created. driveRun does
    // not duplicate that logic here — there is exactly one place where approvals are
    // created and approval_requested is emitted.
    const { sessionId } = await backend.startSession();
    run.sessionId = sessionId;

    // 4. Send the prompt. This returns only after the backend finishes its turn,
    // including any pending permissionHandler Promise being resolved externally.
    await backend.sendPrompt(sessionId, run.goal);

    // A lifecycle side path (cancel/expiry) may claim terminal ownership while
    // the backend was paused; in that case it already emitted the terminal event.
    if (run.status !== "active") return;

    // 5a. If the backend was aborted (e.g. approval rejected), emit run_blocked
    //     and skip artifact registration entirely.
    if (aborted) {
      ctx.governance.transitionRun(run.run_id, "blocked", clock.now(), abortReason ?? "approval_rejected");
      run.status = "blocked";
      ctx.governance.recordDecision({
        decision_type: "run_terminal",
        run_id: run.run_id,
        reason: abortReason ?? "approval_rejected",
        ts: clock.now(),
        data: { state: "blocked" },
      });
      bus.publish("run", "run_blocked", {
        reason: abortReason ?? "approval_rejected",
      });
      return;
    }

    // 5b. Register a diff artifact only when the backend emitted a real fs-edit diff.
    const artifactId = diffArtifactContent ? `art_diff_${run.run_id}` : undefined;
    if (artifactId && diffArtifactContent) {
      const now = clock.now();
      const envelope = {
        artifact_id: artifactId,
        type: "diff",
        mime: "text/x-diff",
        size: diffArtifactContent.length,
        sha256: createHash("sha256").update(diffArtifactContent).digest("hex"),
        created_by: "agent-backend",
        created_at: now,
      };
      ctx.artifacts.set(artifactId, { envelope, content: diffArtifactContent });
    }

    // 6. Emit terminal run_merged. A run may complete without a diff artifact
    // if the real provider produced only lifecycle/model output.
    ctx.governance.transitionRun(run.run_id, "merged", clock.now(), "run completed");
    run.status = "merged";
    ctx.governance.recordDecision({
      decision_type: "run_terminal",
      run_id: run.run_id,
      reason: "run completed",
      ts: clock.now(),
      data: { state: "merged", artifact_id: artifactId },
    });
    bus.publish("run", "run_merged", {
      ...(artifactId ? { artifact_id: artifactId } : {}),
      ...(diffArtifactPath ? { path: diffArtifactPath } : {}),
      reason: "run completed",
    });
  } catch (err) {
    if (run.status === "active") {
      ctx.governance.transitionRun(run.run_id, "gave_up", clock.now(), "run_error");
      run.status = "gave_up";
      ctx.governance.recordDecision({
        decision_type: "run_terminal",
        run_id: run.run_id,
        reason: err instanceof Error ? err.message : String(err),
        ts: clock.now(),
        data: { state: "gave_up" },
      });
      bus.publish("run", "run_gave_up", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    await backend.dispose().catch(() => {});
  }
}
