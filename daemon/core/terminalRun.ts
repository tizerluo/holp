import type { Clock } from "./clock.js";
import type { ConnectionContext } from "./context.js";
import type { RunRecord, RunStatus } from "./stores.js";

type TerminalEventName = "run_merged" | "run_blocked" | "run_gave_up";

export interface TerminalClaim {
  readonly state: Extract<RunStatus, "merged" | "blocked" | "gave_up" | "cancelled">;
  readonly reason: string;
  readonly eventName: TerminalEventName;
  readonly payload?: Record<string, unknown>;
  readonly data?: Record<string, unknown>;
  readonly approvalId?: string;
}

export function claimTerminal(
  run: RunRecord,
  ctx: ConnectionContext,
  clock: Clock,
  claim: TerminalClaim,
): boolean {
  // First emission wins. Same-tick precedence is only caller order; no buffering
  // or terminal-label upgrade happens after a terminal event is emitted.
  if (run.status !== "active") return false;

  const ts = clock.now();
  ctx.governance.transitionRun(run.run_id, claim.state, ts, claim.reason);
  run.status = claim.state;
  ctx.governance.recordDecision({
    decision_type: "run_terminal",
    run_id: run.run_id,
    reason: claim.reason,
    ts,
    data: { state: claim.state, ...claim.data },
    ...(claim.approvalId ? { approval_id: claim.approvalId } : {}),
  });
  run.bus.publish("run", claim.eventName, claim.payload ?? { reason: claim.reason });
  return true;
}
