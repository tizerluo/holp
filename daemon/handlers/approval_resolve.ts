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
import { emitGateReport } from "../core/gateReport.js";

const APPROVAL_KINDS = new Set([
  "merge_approval",
  "force_push_approval",
  "semantic_decision",
  "low_confidence",
  "budget_exceeded",
]);

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

  if (!APPROVAL_KINDS.has(approval.kind)) {
    throw new HolpRpcError(
      invalidRequest(`approval.resolve: unknown approval kind '${approval.kind}'`),
    );
  }

  const semanticAudit = approval.kind === "semantic_decision"
    ? semanticDecisionAudit(params)
    : undefined;

  const run = ctx.runs.get(approval.run_id);
  if (run && approval.kind === "semantic_decision" && run.status !== "active") {
    throw new HolpRpcError(
      invalidRequest("approval.resolve: semantic_decision approval cannot resolve a terminal run"),
    );
  }

  // Mark terminal.
  clearApprovalTimer(approval);
  approval.state = "resolved";
  approval.decision = decision;
  approval.by = by;

  // Remove from run's pending set.
  if (run) {
    run.pendingApprovals.delete(approvalId);
    resumeWaitingRun(ctx, run, clock, "approval_resolved");
    ctx.governance.recordDecision({
      decision_type: "approval_resolved",
      run_id: run.run_id,
      approval_id: approvalId,
      reason: semanticAudit?.reason ?? "user_decision",
      ts: clock.now(),
      data: { decision, by, kind: approval.kind, ...(semanticAudit ?? {}) },
    });

    // Emit approval_resolved event (spec §7).
    run.bus.publish("approval", "approval_resolved", {
      approval_id: approvalId,
      state: "resolved",
      decision,
      reason: semanticAudit?.reason ?? "user_decision",
      by,
      ...(approval.kind === "semantic_decision"
        ? { kind: "semantic_decision", ...semanticAudit }
        : {}),
    });
    if (approval.kind === "semantic_decision") {
      emitGateReport(run, ctx, clock);
    }
  }

  // Resume the backend (resolve its pending permissionHandler Promise).
  // decision "approved" → "allow"; "rejected" → "deny".
  // The resumeBackend closure was captured at approval-creation time in
  // orchestrate_run.ts's permissionHandler. This is the single resume path.
  const backendDecision = decision === "approved" ? "allow" : "deny";
  approval.resumeBackend(backendDecision);

  return { approval_id: approvalId, accepted: true };
}

function semanticDecisionAudit(params: Record<string, unknown>): {
  readonly reason: string;
  readonly previous_gate_outcome: string;
  readonly new_gate_outcome: string;
  readonly artifact_refs: readonly string[];
} {
  const reason = params.reason;
  const previous = params.previous_gate_outcome;
  const next = params.new_gate_outcome;
  const artifactRefs = params.artifact_refs;
  if (typeof reason !== "string" || !reason) {
    throw new HolpRpcError(
      invalidRequest("approval.resolve: semantic_decision params.reason (string) required"),
    );
  }
  if (typeof previous !== "string" || !previous) {
    throw new HolpRpcError(
      invalidRequest("approval.resolve: semantic_decision params.previous_gate_outcome (string) required"),
    );
  }
  if (typeof next !== "string" || !next) {
    throw new HolpRpcError(
      invalidRequest("approval.resolve: semantic_decision params.new_gate_outcome (string) required"),
    );
  }
  if (!Array.isArray(artifactRefs) || !artifactRefs.every((item) => typeof item === "string")) {
    throw new HolpRpcError(
      invalidRequest("approval.resolve: semantic_decision params.artifact_refs (string[]) required"),
    );
  }
  return {
    reason,
    previous_gate_outcome: previous,
    new_gate_outcome: next,
    artifact_refs: [...artifactRefs].sort(),
  };
}
