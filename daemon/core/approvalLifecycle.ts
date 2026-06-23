import type { Clock } from "./clock.js";
import type { ConnectionContext } from "./context.js";
import type { ApprovalRecord, RunRecord } from "./stores.js";
import { claimTerminal } from "./terminalRun.js";

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
    claimTerminal(run, ctx, clock, {
      state: "blocked",
      reason: "approval_timeout_auto_reject",
      eventName: "run_blocked",
      approvalId,
      payload: {
        reason: "approval_timeout_auto_reject",
      },
    });
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
