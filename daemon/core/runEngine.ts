/**
 * Run engine: drives the fake backend through the real protocol path.
 *
 * Honesty contract (spec §M1b brief rule 1-2):
 *   - The fake backend IS driven through the real AgentBackend contract.
 *   - The approval bridge is constructed in orchestrate_run.ts (the permissionHandler
 *     closure captures the run record and emits approval_requested, returning a PENDING
 *     Promise the fake awaits). The resume happens via approval.resumeBackend(decision)
 *     called from approval_resolve.ts — NOT via resolvePermission on the backend.
 *
 * This module is called by orchestrate_run.ts after the run record is created.
 */

import type { ConnectionContext } from "./context.js";
import type { RunRecord } from "./stores.js";
import type { Clock } from "./clock.js";
import type { AgentBackend } from "../../adapters/agent-backend.js";

/** Drives the full run lifecycle asynchronously (called fire-and-forget). */
export async function driveRun(
  run: RunRecord,
  backend: AgentBackend,
  ctx: ConnectionContext,
  clock: Clock,
): Promise<void> {
  const bus = run.bus;

  try {
    // 1. Emit run_started (seq=1)
    bus.publish("run", "run_started", { goal: run.goal, trigger: run.trigger });

    // Track whether the backend signalled a stop/error (e.g. approval denied).
    let aborted = false;
    let abortReason: string | undefined;

    // 2. Wire backend.onMessage → events
    backend.onMessage((msg) => {
      if (run.status !== "active") return;

      switch (msg.type) {
        case "status":
          if (msg.status === "starting" || msg.status === "running") {
            bus.publish("agent", "step_started", { status: msg.status, detail: msg.detail });
          } else if (msg.status === "stopped" || msg.status === "error") {
            // Backend signalled abort (e.g. approval denied path in fake).
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
          bus.publish("agent", "fs_edited", {
            description: msg.description,
            path: msg.path,
          });
          break;

        // permission-request messages are handled via the permissionHandler injected
        // into the backend at construction time (in orchestrate_run.ts).
        // model-output is skipped (not required by the brief's minimal scenario).
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

    // 4. Send the prompt (kicks off the deterministic scenario).
    //    This returns only after the fake scenario completes (including the
    //    pending permissionHandler Promise being resolved externally).
    await backend.sendPrompt(sessionId, run.goal);

    if (run.status !== "active") return; // Cancelled during run.

    // 5a. If the backend was aborted (e.g. approval rejected), emit run_blocked
    //     and skip artifact registration entirely.
    if (aborted) {
      run.status = "blocked";
      bus.publish("run", "run_blocked", {
        reason: abortReason ?? "approval_rejected",
      });
      return;
    }

    // 5b. Register the diff artifact.
    const diffContent =
      "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-// old\n+// fixed\n";
    const artifactId = `art_diff_${run.run_id}`;
    const now = clock.now();
    const envelope = {
      artifact_id: artifactId,
      type: "diff",
      mime: "text/x-diff",
      size: diffContent.length,
      sha256: "sha256-fake-" + artifactId,
      created_by: "fake-agent",
      created_at: now,
    };
    ctx.artifacts.set(artifactId, { envelope, content: diffContent });

    // 6. Emit terminal run_merged.
    run.status = "merged";
    bus.publish("run", "run_merged", {
      artifact_id: artifactId,
      reason: "run completed",
    });
  } catch (err) {
    if (run.status === "active") {
      run.status = "gave_up";
      bus.publish("run", "run_gave_up", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    await backend.dispose().catch(() => {});
  }
}
