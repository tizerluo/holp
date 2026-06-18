import type { Clock } from "./clock.js";
import type { ConnectionContext } from "./context.js";
import type { ApprovalRecord, RunRecord } from "./stores.js";

export function clearApprovalTimer(approval: ApprovalRecord): void {
  approval.expiryTimer?.cancel();
  delete approval.expiryTimer;
}

export function expireApproval(
  ctx: ConnectionContext,
  approvalId: string,
  clock: Clock,
): boolean {
  const approval = ctx.approvals.get(approvalId);
  if (!approval || approval.state !== "pending") return false;

  clearApprovalTimer(approval);
  approval.state = "expired";

  const run = ctx.runs.get(approval.run_id);
  if (run) {
    run.pendingApprovals.delete(approvalId);
    run.bus.publish("approval", "approval_expired", {
      approval_id: approvalId,
      state: "expired",
      reason: "timeout",
      expired_at: clock.now(),
    });
    ctx.governance.recordDecision({
      decision_type: "approval_expired",
      run_id: run.run_id,
      approval_id: approvalId,
      reason: "approval_timeout_auto_reject",
      ts: clock.now(),
      data: { kind: approval.kind },
    });
    if (run.status === "active") {
      // Claim run terminal ownership before resuming the backend; driveRun checks
      // run.status after sendPrompt returns and must not emit a second terminal.
      run.status = "blocked";
      ctx.governance.transitionRun(run.run_id, "blocked", clock.now(), "approval_timeout_auto_reject");
      ctx.governance.recordDecision({
        decision_type: "run_terminal",
        run_id: run.run_id,
        approval_id: approvalId,
        reason: "approval_timeout_auto_reject",
        ts: clock.now(),
        data: { state: "blocked" },
      });
      run.bus.publish("run", "run_blocked", {
        reason: "approval_timeout_auto_reject",
      });
    }
  }

  approval.resumeBackend("deny");
  return true;
}

export function resumeWaitingRun(
  ctx: ConnectionContext,
  run: RunRecord,
  clock: Clock,
  reason: string,
): void {
  const state = ctx.governance.runStates.get(run.run_id)?.state;
  if (state === "waiting_approval") {
    ctx.governance.transitionRun(run.run_id, "running", clock.now(), reason);
  }
}
