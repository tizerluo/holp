/**
 * `approval.resolve` handler — spec §7.
 *
 * - Unknown approval_id → approval_not_found (-32009).
 * - Already terminal approval → approval_already_resolved (-32010).
 * - Success → mark resolved, emit approval_resolved, resolve the pending Promise
 *   (unblocks the backend), return { approval_id, accepted:true }.
 *
 * The "resume backend" path: approval.resolve calls approval.resumeBackend(decision),
 * which resolves the Promise the backend's sendPrompt is awaiting. The backend
 * unblocks and continues its scenario. The resumeBackend closure is captured at approval-creation
 * time in orchestrate_run.ts's permissionHandler. There is no separate resolvePermission
 * call — the Promise is resolved exactly once via the closure.
 */

import { holpError, invalidRequest } from "../core/errors.js";
import { HolpRpcError } from "../core/dispatcher.js";
import { isObject } from "../core/internal.js";
import type { JsonRpcRequest } from "../runtime/jsonrpc.js";
import type { ConnectionContext } from "../core/context.js";
import { clearApprovalTimer, resumeWaitingRun } from "../core/approvalLifecycle.js";
import { systemClock, type Clock } from "../core/clock.js";

export function handleApprovalResolve(
  req: JsonRpcRequest,
  ctx: ConnectionContext,
  clock: Clock = systemClock,
): unknown {
  const params = isObject(req.params) ? req.params : {};

  const approvalId = params.approval_id;
  if (typeof approvalId !== "string" || !approvalId) {
    throw new HolpRpcError(
      invalidRequest("approval.resolve: params.approval_id (string) required"),
    );
  }

  const decision = params.decision;
  if (decision !== "approved" && decision !== "rejected") {
    throw new HolpRpcError(
      invalidRequest('approval.resolve: params.decision must be "approved" or "rejected"'),
    );
  }

  const by = typeof params.by === "string" ? params.by : "user:unknown";

  // Lookup approval.
  const approval = ctx.approvals.get(approvalId);
  if (!approval) {
    throw new HolpRpcError(
      holpError("approval_not_found", `approval '${approvalId}' not found`, {
        approval_id: approvalId,
      }),
    );
  }

  // Terminal check.
  if (approval.state !== "pending") {
    throw new HolpRpcError(
      holpError(
        "approval_already_resolved",
        `approval '${approvalId}' is already in state '${approval.state}'`,
        { approval_id: approvalId, state: approval.state },
      ),
    );
  }

  // Mark terminal.
  clearApprovalTimer(approval);
  approval.state = "resolved";
  approval.decision = decision;
  approval.by = by;

  // Remove from run's pending set.
  const run = ctx.runs.get(approval.run_id);
  if (run) {
    run.pendingApprovals.delete(approvalId);
    resumeWaitingRun(ctx, run, clock, "approval_resolved");
    ctx.governance.recordDecision({
      decision_type: "approval_resolved",
      run_id: run.run_id,
      approval_id: approvalId,
      reason: "user_decision",
      ts: clock.now(),
      data: { decision, by },
    });

    // Emit approval_resolved event (spec §7).
    run.bus.publish("approval", "approval_resolved", {
      approval_id: approvalId,
      state: "resolved",
      decision,
      reason: "user_decision",
      by,
    });
  }

  // Resume the backend (resolve its pending permissionHandler Promise).
  // decision "approved" → "allow"; "rejected" → "deny".
  // The resumeBackend closure was captured at approval-creation time in
  // orchestrate_run.ts's permissionHandler. This is the single resume path.
  const backendDecision = decision === "approved" ? "allow" : "deny";
  approval.resumeBackend(backendDecision);

  return { approval_id: approvalId, accepted: true };
}
