/**
 * `task.cancel` handler — spec §7.5.
 *
 * - Idempotent: terminal run (merged/gave_up/cancelled) → { run_id, cancelling:false }, no error.
 * - Unknown run → run_not_found (-32008).
 * - Active run → { run_id, cancelling:true }, call backend.cancel, emit approval_cancelled
 *   for each pending approval (resolving their Promises with deny), emit run_gave_up.
 */

import { holpError, invalidRequest } from "../core/errors.js";
import { HolpRpcError } from "../core/dispatcher.js";
import { isObject } from "../core/internal.js";
import type { JsonRpcRequest } from "../runtime/jsonrpc.js";
import type { ConnectionContext } from "../core/context.js";

export function handleTaskCancel(req: JsonRpcRequest, ctx: ConnectionContext): unknown {
  const params = isObject(req.params) ? req.params : {};

  const runId = params.run_id;
  if (typeof runId !== "string" || !runId) {
    throw new HolpRpcError(
      invalidRequest("task.cancel: params.run_id (string) required"),
    );
  }

  const run = ctx.runs.get(runId);
  if (!run) {
    throw new HolpRpcError(
      holpError("run_not_found", `run '${runId}' not found`, { run_id: runId }),
    );
  }

  // Idempotent: already terminal.
  if (run.status !== "active") {
    return { run_id: runId, cancelling: false };
  }

  // Mark cancelled.
  run.status = "cancelled";

  // Cancel backend (if available).
  if (run.backend && run.sessionId) {
    void run.backend.cancel(run.sessionId).catch(() => {});
  }

  // Emit approval_cancelled for each pending approval, resolving their Promises.
  for (const approvalId of run.pendingApprovals) {
    const approval = ctx.approvals.get(approvalId);
    if (approval && approval.state === "pending") {
      approval.state = "cancelled";
      run.bus.publish("approval", "approval_cancelled", {
        approval_id: approvalId,
        state: "cancelled",
        reason: "run_cancelled",
      });
      // Resolve the pending Promise with deny so the backend unblocks.
      approval.resumeBackend("deny");
    }
  }
  run.pendingApprovals.clear();

  // Emit terminal run_gave_up.
  run.bus.publish("run", "run_gave_up", { reason: "cancelled" });

  return { run_id: runId, cancelling: true };
}
