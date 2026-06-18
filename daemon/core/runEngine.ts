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
import type { ApprovalRecord, RunRecord } from "./stores.js";
import type { Clock } from "./clock.js";
import type { Scheduler } from "./scheduler.js";
import type { AgentBackend } from "../../adapters/agent-backend.js";
import { createHash } from "node:crypto";
import { expireApproval } from "./approvalLifecycle.js";
import {
  buildConsensusVerdict,
  inlineFindings,
  type ConsensusDegradedOutcome,
  type ConsensusDegradedPayload,
  type ConsensusReviewerResult,
  type ConsensusVerdictPayload,
} from "./consensus.js";

/** Drives the full run lifecycle asynchronously (called fire-and-forget). */
export async function driveRun(
  run: RunRecord,
  backend: AgentBackend,
  ctx: ConnectionContext,
  clock: Clock,
  scheduler?: Scheduler,
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

    if (run.consensus) {
      const consensusCanContinue = await runConsensusGate(
        run,
        ctx,
        clock,
        artifactId,
        scheduler,
      );
      if (!consensusCanContinue || run.status !== "active") return;
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

async function runConsensusGate(
  run: RunRecord,
  ctx: ConnectionContext,
  clock: Clock,
  artifactId: string | undefined,
  scheduler?: Scheduler,
): Promise<boolean> {
  const consensus = run.consensus;
  if (!consensus) return true;

  if (!artifactId) {
    const degraded = consensusDegradedPayload(run, undefined, consensus.quorum, {
      reason: "missing_reviewable_artifact",
      outcome: "reject",
      policy_action: "reject",
    });
    publishConsensusDegraded(run, ctx, clock, degraded, "missing_reviewable_artifact");
    blockRun(run, ctx, clock, "missing_reviewable_artifact");
    return false;
  }

  const panel = consensus.panel.map((reviewer) => reviewer.agent_id);
  const excludeAuthor = consensus.policy.exclude_author &&
    consensus.policy.author_provenance === "produced_by_agent_id";
  const target = {
    artifact_id: artifactId,
    produced_by_agent_id: consensus.producer_agent_id,
  };
  const excludedCount = excludeAuthor
    ? panel.filter((agent) => agent === consensus.producer_agent_id).length
    : 0;
  const eligible = panel.length - excludedCount;

  if (eligible < consensus.quorum) {
    const degraded = consensusDegradedPayload(run, artifactId, consensus.quorum, {
      reason: "quorum_unsatisfiable_after_author_exclusion",
      outcome: degradedOutcome(consensus.policy.on_quorum_unsatisfiable),
      policy_action: consensus.policy.on_quorum_unsatisfiable,
    });
    publishConsensusDegraded(
      run,
      ctx,
      clock,
      degraded,
      consensus.policy.on_quorum_unsatisfiable,
    );

    if (consensus.policy.on_quorum_unsatisfiable === "reject" || eligible === 0) {
      if (consensus.policy.on_quorum_unsatisfiable === "ask_human") {
        const approved = await requestSemanticDecisionApproval(run, ctx, clock, scheduler, degraded);
        if (approved) return true;
      }
      blockRun(run, ctx, clock, "quorum_unsatisfiable_after_author_exclusion");
      return false;
    }

    if (consensus.policy.on_quorum_unsatisfiable === "ask_human") {
      const approved = await requestSemanticDecisionApproval(run, ctx, clock, scheduler, degraded);
      if (!approved) {
        blockRun(run, ctx, clock, "consensus_semantic_decision_rejected");
        return false;
      }
      if (run.status !== "active") return false;
    }
  }

  const effectiveQuorum = eligible < consensus.quorum ? eligible : consensus.quorum;
  const results = fakeReviewerResults(panel);
  const verdict = buildConsensusVerdict({
    target,
    panel,
    quorum: effectiveQuorum,
    producedByAgentId: consensus.producer_agent_id,
    excludeAuthor,
    results,
  });

  if (!verdict.quorum.met) {
    publishConsensusDegraded(run, ctx, clock, verdict, "completed_reviews_below_quorum");
    blockRun(run, ctx, clock, "completed_reviews_below_quorum");
    return false;
  }

  ctx.governance.recordDecision({
    decision_type: "consensus_verdict",
    run_id: run.run_id,
    reason: verdict.outcome,
    ts: clock.now(),
    data: verdict,
  });
  run.bus.publish("consensus", "consensus_verdict", verdict);

  if (verdict.outcome === "approve") return true;

  blockRun(run, ctx, clock, `consensus_${verdict.outcome}`);
  return false;
}

function fakeReviewerResults(panel: readonly string[]): ConsensusReviewerResult[] {
  return panel.map((agent) => ({
    agent,
    status: "completed",
    verdict: "approve",
    max_severity: "NONE",
    findings: inlineFindings(agent, "approve"),
  }));
}

function consensusDegradedPayload(
  run: RunRecord,
  artifactId: string | undefined,
  required: number,
  detail: {
    reason: string;
    outcome?: ConsensusDegradedOutcome;
    policy_action?: ConsensusDegradedPayload["policy_action"];
  },
): ConsensusDegradedPayload {
  const consensus = run.consensus!;
  return {
    target: {
      artifact_id: artifactId ?? "missing",
      produced_by_agent_id: consensus.producer_agent_id,
    },
    outcome: detail.outcome ?? "ask_human",
    max_severity: "NONE",
    quorum: {
      required,
      eligible: Math.max(
        0,
        consensus.panel.length -
          (consensus.policy.exclude_author &&
          consensus.policy.author_provenance === "produced_by_agent_id"
            ? consensus.panel.filter((reviewer) =>
                reviewer.agent_id === consensus.producer_agent_id
              ).length
            : 0),
      ),
      met: false,
    },
    rule: "majority-non-author",
    reviews: [],
    excluded: consensus.policy.exclude_author &&
      consensus.policy.author_provenance === "produced_by_agent_id"
      ? consensus.panel
          .filter((reviewer) => reviewer.agent_id === consensus.producer_agent_id)
          .map((reviewer) => ({
            agent: reviewer.agent_id,
            reason: "produced_by_agent_id (author)",
          }))
      : [],
    errors: [],
    reason: detail.reason,
    policy_action: detail.policy_action,
  };
}

function publishConsensusDegraded(
  run: RunRecord,
  ctx: ConnectionContext,
  clock: Clock,
  payload: ConsensusDegradedPayload | ConsensusVerdictPayload,
  reason: string,
): void {
  ctx.governance.recordDecision({
    decision_type: "consensus_degraded",
    run_id: run.run_id,
    reason,
    ts: clock.now(),
    data: payload,
  });
  run.bus.publish("consensus", "consensus_degraded", payload);
}

function blockRun(
  run: RunRecord,
  ctx: ConnectionContext,
  clock: Clock,
  reason: string,
): void {
  if (run.status !== "active") return;
  ctx.governance.transitionRun(run.run_id, "blocked", clock.now(), reason);
  run.status = "blocked";
  ctx.governance.recordDecision({
    decision_type: "run_terminal",
    run_id: run.run_id,
    reason,
    ts: clock.now(),
    data: { state: "blocked" },
  });
  run.bus.publish("run", "run_blocked", { reason });
}

async function requestSemanticDecisionApproval(
  run: RunRecord,
  ctx: ConnectionContext,
  clock: Clock,
  scheduler: Scheduler | undefined,
  details: ConsensusVerdictPayload | ConsensusDegradedPayload,
): Promise<boolean> {
  const approvalKinds = ctx.initialized?.negotiated.approval.kinds ?? [];
  if (
    ctx.initialized?.negotiated.approval.supported !== true ||
    !approvalKinds.includes("semantic_decision")
  ) {
    ctx.governance.recordDecision({
      decision_type: "consensus_degraded",
      run_id: run.run_id,
      reason: "semantic_decision_approval_unsupported",
      ts: clock.now(),
      data: details,
    });
    return false;
  }

  const decision = await new Promise<"allow" | "deny">((resolve) => {
    run.approvalSeq += 1;
    const approvalId = `ap_${run.run_id}_${clock.now()}_${run.approvalSeq}`;
    const expiresAt = clock.now() + 300;
    const approvalRecord: ApprovalRecord = {
      approval_id: approvalId,
      run_id: run.run_id,
      kind: "semantic_decision",
      reason: "consensus quorum requires human semantic decision",
      expires_at: expiresAt,
      state: "pending",
      resumeBackend: resolve,
    };
    if (scheduler) {
      approvalRecord.expiryTimer = scheduler.schedule(expiresAt - clock.now(), () => {
        expireApproval(ctx, approvalId, clock);
      });
    }
    ctx.approvals.set(approvalId, approvalRecord);
    run.pendingApprovals.add(approvalId);
    ctx.governance.transitionRun(run.run_id, "waiting_approval", clock.now(), "approval_requested");
    ctx.governance.recordDecision({
      decision_type: "approval_requested",
      run_id: run.run_id,
      approval_id: approvalId,
      reason: "consensus quorum requires human semantic decision",
      ts: clock.now(),
      data: { kind: "semantic_decision" },
    });
    run.bus.publish("approval", "approval_requested", {
      approval_id: approvalId,
      kind: "semantic_decision",
      reason: "consensus quorum requires human semantic decision",
      expires_at: expiresAt,
      provenance: {
        step_id: "step_consensus",
        artifact_id: details.target.artifact_id,
      },
      details: {
        inline: true,
        type: "approval_details",
        mime: "application/json",
        content: JSON.stringify(details),
        truncated: false,
      },
    });
  });

  return decision === "allow";
}

function degradedOutcome(
  action: NonNullable<ConsensusDegradedPayload["policy_action"]>,
): ConsensusDegradedOutcome {
  switch (action) {
    case "degrade_quorum":
      return "degrade_quorum";
    case "reject":
      return "reject";
    case "ask_human":
      return "ask_human";
    default:
      return assertNever(action);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled consensus degraded action: ${String(value)}`);
}
