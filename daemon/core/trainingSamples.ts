import type { DecisionRecord } from "./governance.js";
import type { DispatchStateV1, WorkPlanV1 } from "./workPlanner.js";

export const REWARD_POLICY_VERSION = "m7-foundation-loop-v1";

export interface RewardAttribution {
  readonly reward: 1 | -1 | null;
  readonly reward_basis: string;
}

export interface TrainingSampleV1 {
  readonly sample_id: string;
  readonly run_id: string;
  readonly step_index: number;
  readonly state: DispatchStateV1;
  readonly action: WorkPlanV1;
  readonly reward: 1 | -1 | null;
  readonly reward_basis: string;
  readonly reward_policy_version: typeof REWARD_POLICY_VERSION;
  readonly ts: number;
}

export function attributeReward(
  terminal: DecisionRecord | undefined,
  action: WorkPlanV1,
): RewardAttribution {
  if (!terminal) return { reward: null, reward_basis: "terminal_missing" };

  const state = isRecord(terminal.data) ? terminal.data.state : undefined;
  const actionName = action.kind === "step" ? action.action : undefined;
  if (state === "merged") {
    return actionName === "implement" || actionName === "review"
      ? { reward: 1, reward_basis: "merged" }
      : { reward: null, reward_basis: "not_attributable" };
  }
  if (state === "cancelled" || terminal.reason === "cancelled") {
    return { reward: null, reward_basis: "cancelled" };
  }

  const reason = terminal.reason ?? "";
  if (reason === "approval_timeout_auto_reject") {
    return { reward: null, reward_basis: "approval_timeout" };
  }
  if (reason === "write_file denied" || reason === "approval_rejected") {
    return { reward: null, reward_basis: "human_reject" };
  }
  if (reason.startsWith("consensus_") || reason === "completed_reviews_below_quorum") {
    return actionName === "implement" || actionName === "review"
      ? { reward: -1, reward_basis: "consensus_reject" }
      : { reward: null, reward_basis: "not_attributable" };
  }

  return { reward: null, reward_basis: "not_attributable" };
}

export function exportTrainingSamplesJsonl(decisions: readonly DecisionRecord[]): string {
  return exportTrainingSamples(decisions)
    .map((sample) => JSON.stringify(sample))
    .join("\n");
}

export function exportTrainingSamples(decisions: readonly DecisionRecord[]): readonly TrainingSampleV1[] {
  const terminalByRunId = new Map<string, DecisionRecord>();
  for (const decision of decisions) {
    if (decision.decision_type === "run_terminal" && decision.run_id) {
      terminalByRunId.set(decision.run_id, decision);
    }
  }

  return decisions
    .filter((decision) => decision.decision_type === "training_sample_recorded")
    .map((decision) => sampleFromDecision(decision, terminalByRunId.get(decision.run_id ?? "")))
    .filter((sample): sample is TrainingSampleV1 => sample !== null);
}

function sampleFromDecision(
  decision: DecisionRecord,
  terminal: DecisionRecord | undefined,
): TrainingSampleV1 | null {
  if (!isRecord(decision.data)) return null;
  const state = decision.data.state;
  const action = decision.data.action;
  if (!isDispatchState(state) || !isWorkPlan(action)) return null;

  const reward = attributeReward(terminal, action);
  return {
    sample_id: typeof decision.data.sample_id === "string"
      ? decision.data.sample_id
      : `${state.run_id}:step:${state.step_index}`,
    run_id: state.run_id,
    step_index: state.step_index,
    state,
    action,
    reward: reward.reward,
    reward_basis: reward.reward_basis,
    reward_policy_version: REWARD_POLICY_VERSION,
    ts: decision.ts,
  };
}

function isDispatchState(value: unknown): value is DispatchStateV1 {
  return isRecord(value) && value.version === "DispatchState.v1" &&
    typeof value.run_id === "string" && typeof value.step_index === "number" &&
    Array.isArray(value.candidates);
}

function isWorkPlan(value: unknown): value is WorkPlanV1 {
  return isRecord(value) && value.version === "WorkPlan.v1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
