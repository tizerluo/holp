import type { DecisionRecord } from "./governance.js";
import {
  canonicalSha256,
  validateWorkPlanHardConstraints,
  type DispatchStateV1,
  type WorkPlanV1,
} from "./workPlanner.js";

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

export interface ReplayMetric {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number;
}

export interface ReplayRewardDeltaMetric extends ReplayMetric {
  readonly null_reward_count: number;
}

export interface ReplayEvaluationV1 {
  readonly version: "ReplayEvaluation.v1";
  readonly reward_policy_version: typeof REWARD_POLICY_VERSION;
  readonly sample_count: number;
  readonly invalid_action_rate: ReplayMetric;
  readonly constraint_violation_rate: ReplayMetric;
  readonly fallback_rate: ReplayMetric;
  readonly coverage: ReplayMetric;
  readonly reward_delta: ReplayRewardDeltaMetric;
}

export interface PromotionEvidenceV1 {
  readonly version: "PromotionEvidence.v1";
  readonly run_ids: readonly string[];
  readonly planner_version: string;
  readonly backing: "fixture_planner" | "real_learned_model";
  readonly reward_policy_version: typeof REWARD_POLICY_VERSION;
  readonly dispatch_state_stream_hash: string;
  readonly replay_fingerprint: string;
  readonly sample_counts: {
    readonly total: number;
    readonly reward_bearing: number;
    readonly null_reward: number;
  };
  readonly threshold_version: string;
  readonly created_at: number;
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

export function evaluateReplay(
  samples: readonly TrainingSampleV1[],
  predict: (state: DispatchStateV1) => WorkPlanV1 | undefined,
): ReplayEvaluationV1 {
  const rewardPolicyVersions = new Set(samples.map((sample) => sample.reward_policy_version));
  if (rewardPolicyVersions.size > 1) {
    throw new Error("replay evaluation cannot mix reward_policy_version values");
  }

  let invalid = 0;
  let violations = 0;
  let fallback = 0;
  let covered = 0;
  let rewardDelta = 0;
  let rewardBearing = 0;
  let nullReward = 0;

  for (const sample of samples) {
    const predicted = predict(sample.state);
    if (!predicted) continue;
    covered += 1;
    if (!isWorkPlan(predicted)) {
      invalid += 1;
      continue;
    }
    const validation = validateWorkPlanHardConstraints(predicted, sample.state);
    if (!validation.ok) violations += 1;
    if (predicted.kind === "terminal" && predicted.reason.includes("fallback")) fallback += 1;
    if (sample.reward === null) {
      nullReward += 1;
    } else {
      rewardBearing += 1;
      const learnedReward = sameAction(predicted, sample.action) ? sample.reward : 0;
      rewardDelta += learnedReward - sample.reward;
    }
  }

  const denominator = samples.length;
  return {
    version: "ReplayEvaluation.v1",
    reward_policy_version: REWARD_POLICY_VERSION,
    sample_count: samples.length,
    invalid_action_rate: metric(invalid, covered),
    constraint_violation_rate: metric(violations, covered),
    fallback_rate: metric(fallback, covered),
    coverage: metric(covered, denominator),
    reward_delta: {
      numerator: rewardDelta,
      denominator: rewardBearing,
      value: rewardBearing === 0 ? 0 : rewardDelta / rewardBearing,
      null_reward_count: nullReward,
    },
  };
}

export function dispatchStateStreamHash(samples: readonly TrainingSampleV1[]): string {
  return canonicalSha256(samples.map((sample) => sample.state));
}

export function replayFingerprint(samples: readonly TrainingSampleV1[]): string {
  return canonicalSha256(samples.map((sample) => ({
    sample_id: sample.sample_id,
    action: sample.action,
    reward: sample.reward,
    reward_basis: sample.reward_basis,
    reward_policy_version: sample.reward_policy_version,
  })));
}

export function createPromotionEvidence(args: {
  readonly samples: readonly TrainingSampleV1[];
  readonly planner_version: string;
  readonly backing: "fixture_planner" | "real_learned_model";
  readonly threshold_version: string;
  readonly created_at: number;
}): PromotionEvidenceV1 {
  const rewardPolicyVersions = new Set(args.samples.map((sample) => sample.reward_policy_version));
  if (rewardPolicyVersions.size > 1) {
    throw new Error("promotion evidence cannot mix reward_policy_version values");
  }
  const nullReward = args.samples.filter((sample) => sample.reward === null).length;
  return {
    version: "PromotionEvidence.v1",
    run_ids: [...new Set(args.samples.map((sample) => sample.run_id))],
    planner_version: args.planner_version,
    backing: args.backing,
    reward_policy_version: REWARD_POLICY_VERSION,
    dispatch_state_stream_hash: dispatchStateStreamHash(args.samples),
    replay_fingerprint: replayFingerprint(args.samples),
    sample_counts: {
      total: args.samples.length,
      reward_bearing: args.samples.length - nullReward,
      null_reward: nullReward,
    },
    threshold_version: args.threshold_version,
    created_at: args.created_at,
  };
}

export function promotionEvidenceFresh(
  evidence: PromotionEvidenceV1,
  now: number,
  maxAgeSeconds = 7 * 24 * 60 * 60,
): boolean {
  return now - evidence.created_at <= maxAgeSeconds;
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

function metric(numerator: number, denominator: number): ReplayMetric {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? 0 : numerator / denominator,
  };
}

function sameAction(a: WorkPlanV1, b: WorkPlanV1): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "terminal" && b.kind === "terminal") return a.reason === b.reason;
  if (a.kind === "step" && b.kind === "step") {
    return a.action === b.action && a.agent_id === b.agent_id && a.role === b.role;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
