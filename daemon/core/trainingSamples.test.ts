import { describe, expect, it } from "vitest";
import type { DecisionRecord } from "./governance.js";
import {
  attributeReward,
  createPromotionEvidence,
  dispatchStateStreamHash,
  evaluateReplay,
  exportStopDecisionSamples,
  exportStopDecisionSamplesJsonl,
  exportTrainingSamples,
  exportTrainingSamplesJsonl,
  promotionEvidenceFresh,
  REWARD_POLICY_VERSION,
  replayFingerprint,
} from "./trainingSamples.js";
import type { TrainingSampleV1 } from "./trainingSamples.js";
import type { DispatchStateV1, WorkPlanV1 } from "./workPlanner.js";

const action: WorkPlanV1 = {
  version: "WorkPlan.v1",
  kind: "step",
  action: "implement",
  agent_id: "coder",
  role: "coder",
};

const terminalAction: WorkPlanV1 = {
  version: "WorkPlan.v1",
  kind: "terminal",
  reason: "workflow_complete",
};

const state: DispatchStateV1 = {
  version: "DispatchState.v1",
  snapshot_id: "run_1:dispatch:0",
  run_id: "run_1",
  goal: "ship",
  trigger: "manual",
  decision_kind: "next_step",
  workflow_id: "linear",
  step_index: 0,
  candidates: [{ agent_id: "coder", role: "coder", transport: "fake", status: "ready" }],
  constraints: { max_steps: 2, reviewer_panel_present: false, executable_actions: ["implement", "review"] },
  history: [],
};

describe("training sample export and reward attribution", () => {
  it("exports JSONL samples from governance decisions", () => {
    const decisions: DecisionRecord[] = [
      decision("training_sample_recorded", "run_1", {
        sample_id: "run_1:step:0",
        run_id: "run_1",
        step_index: 0,
        state,
        action,
      }),
      decision("stop_decision_sample_recorded", "run_1", {
        sample_id: "run_1:stop:1",
        state: { ...state, step_index: 1 },
        action: terminalAction,
      }),
      decision("run_terminal", "run_1", { state: "merged" }, "run completed"),
    ];

    const samples = exportTrainingSamples(decisions);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      sample_id: "run_1:step:0",
      reward: 1,
      reward_basis: "merged",
      reward_policy_version: REWARD_POLICY_VERSION,
    });
    expect(exportTrainingSamplesJsonl(decisions)).toContain('"sample_id":"run_1:step:0"');
  });

  it("exports dedicated stop-decision samples from synthetic governance decisions", () => {
    const decisions: DecisionRecord[] = [
      decision("stop_decision_sample_recorded", "run_1", {
        sample_id: "run_1:stop:2",
        state: { ...state, step_index: 2 },
        action: terminalAction,
      }),
      decision("run_terminal", "run_1", { state: "merged" }, "run completed"),
      decision("stop_decision_sample_recorded", "blocked", {
        state: { ...state, run_id: "blocked", step_index: 3 },
        action: terminalAction,
      }),
      decision("run_terminal", "blocked", { state: "blocked" }, "consensus_reject"),
      decision("stop_decision_sample_recorded", "gave_up", {
        state: { ...state, run_id: "gave_up", step_index: 4 },
        action: terminalAction,
      }),
      decision("run_terminal", "gave_up", { state: "gave_up" }, "backend_error"),
      decision("stop_decision_sample_recorded", "cancelled", {
        state: { ...state, run_id: "cancelled", step_index: 5 },
        action: terminalAction,
      }),
      decision("run_terminal", "cancelled", { state: "cancelled" }, "cancelled"),
      decision("stop_decision_sample_recorded", "missing", {
        state: { ...state, run_id: "missing", step_index: 6 },
        action: terminalAction,
      }),
    ];

    const samples = exportStopDecisionSamples(decisions);
    expect(samples).toHaveLength(5);
    expect(samples[0]).toMatchObject({
      version: "StopDecisionSample.v1",
      sample_id: "run_1:stop:2",
      run_id: "run_1",
      step_index: 2,
      action: terminalAction,
      reward: 1,
      reward_basis: "terminal_merged",
      reward_policy_version: REWARD_POLICY_VERSION,
    });
    expect(samples.map((sample) => sample.reward)).toEqual([1, -1, -1, null, null]);
    expect(samples.map((sample) => sample.reward_basis)).toEqual([
      "terminal_merged",
      "terminal_failed",
      "terminal_failed",
      "cancelled",
      "terminal_missing",
    ]);
    expect(samples.map((sample) => sample.sample_id)).toEqual([
      "run_1:stop:2",
      "blocked:stop:3",
      "gave_up:stop:4",
      "cancelled:stop:5",
      "missing:stop:6",
    ]);
    expect(exportStopDecisionSamplesJsonl(decisions)).toContain('"version":"StopDecisionSample.v1"');
  });

  it("ignores non-terminal actions in stop-decision exporter", () => {
    const decisions: DecisionRecord[] = [
      decision("stop_decision_sample_recorded", "run_1", {
        sample_id: "run_1:stop:0",
        state,
        action,
      }),
      decision("run_terminal", "run_1", { state: "merged" }, "run completed"),
    ];

    expect(exportStopDecisionSamples(decisions)).toEqual([]);
  });

  it("attributes each sample from its own run terminal", () => {
    const decisions: DecisionRecord[] = [
      decision("training_sample_recorded", "run_1", {
        sample_id: "run_1:step:0",
        state,
        action,
      }),
      decision("run_terminal", "run_1", { state: "merged" }, "run completed"),
      decision("training_sample_recorded", "run_2", {
        sample_id: "run_2:step:0",
        state: { ...state, run_id: "run_2" },
        action,
      }),
      decision("run_terminal", "run_2", { state: "blocked" }, "approval_timeout_auto_reject"),
    ];

    expect(exportTrainingSamples(decisions).map((sample) => sample.reward)).toEqual([1, null]);
    expect(exportTrainingSamples(decisions).map((sample) => sample.reward_basis)).toEqual([
      "merged",
      "approval_timeout",
    ]);
  });

  it("covers merged, consensus reject, approval timeout, cancel, human reject, and null cases", () => {
    expect(attributeReward(decision("run_terminal", "r", { state: "merged" }), action)).toEqual({
      reward: 1,
      reward_basis: "merged",
    });
    expect(attributeReward(decision("run_terminal", "r", { state: "blocked" }, "consensus_reject"), action)).toEqual({
      reward: -1,
      reward_basis: "consensus_reject",
    });
    expect(attributeReward(decision("run_terminal", "r", { state: "blocked" }, "approval_timeout_auto_reject"), action)).toEqual({
      reward: null,
      reward_basis: "approval_timeout",
    });
    expect(attributeReward(decision("run_terminal", "r", { state: "cancelled" }, "cancelled"), action)).toEqual({
      reward: null,
      reward_basis: "cancelled",
    });
    expect(attributeReward(decision("run_terminal", "r", { state: "blocked" }, "write_file denied"), action)).toEqual({
      reward: null,
      reward_basis: "human_reject",
    });
    expect(attributeReward(undefined, action)).toEqual({
      reward: null,
      reward_basis: "terminal_missing",
    });
  });

  it("evaluates replay metrics with explicit numerators and rejects mixed reward policies", () => {
    const sample: TrainingSampleV1 = {
      sample_id: "run_1:step:0",
      run_id: "run_1",
      step_index: 0,
      state: {
        ...state,
        candidates: [{
          ...state.candidates[0],
          runtime: {
            agent_id: "coder",
            transport: "fake",
            runtime_surface: "headless" as const,
            runtime_kind: "fake",
            actual_fidelity: "streaming_controlled" as const,
            isolation_profile: "coder_worktree" as const,
            isolation_status: "ready" as const,
            global_mutation_required: false,
            declared_not_enforced: true,
          },
        }],
      },
      action,
      reward: 1 as const,
      reward_basis: "merged",
      reward_policy_version: REWARD_POLICY_VERSION,
      ts: 1,
    };

    expect(evaluateReplay([sample], () => action)).toMatchObject({
      invalid_action_rate: { numerator: 0, denominator: 1, value: 0 },
      constraint_violation_rate: { numerator: 0, denominator: 1, value: 0 },
      fallback_rate: { numerator: 0, denominator: 1, value: 0 },
      coverage: { numerator: 1, denominator: 1, value: 1 },
      reward_delta: { numerator: 0, denominator: 1, value: 0, null_reward_count: 0 },
    });

    expect(() => evaluateReplay([
      sample,
      { ...sample, sample_id: "mixed", reward_policy_version: "other" } as unknown as TrainingSampleV1,
    ], () => action)).toThrow("reward_policy_version");
  });

  it("creates stable promotion evidence hashes and checks freshness", () => {
    const samples = exportTrainingSamples([
      decision("training_sample_recorded", "run_1", {
        sample_id: "run_1:step:0",
        state,
        action,
      }),
      decision("run_terminal", "run_1", { state: "merged" }, "run completed"),
    ]);
    const evidence = createPromotionEvidence({
      samples,
      planner_version: "fixture-v1",
      backing: "fixture_planner",
      threshold_version: "thresholds-v1",
      created_at: 100,
    });

    expect(evidence).toMatchObject({
      version: "PromotionEvidence.v1",
      run_ids: ["run_1"],
      planner_version: "fixture-v1",
      backing: "fixture_planner",
      dispatch_state_stream_hash: dispatchStateStreamHash(samples),
      replay_fingerprint: replayFingerprint(samples),
      sample_counts: { total: 1, reward_bearing: 1, null_reward: 0 },
    });
    expect(promotionEvidenceFresh(evidence, 100 + 7 * 24 * 60 * 60)).toBe(true);
    expect(promotionEvidenceFresh(evidence, 100 + 7 * 24 * 60 * 60 + 1)).toBe(false);
  });
});

function decision(
  decision_type: DecisionRecord["decision_type"],
  run_id: string,
  data: unknown,
  reason?: string,
): DecisionRecord {
  return {
    decision_id: `dec_${Math.random()}`,
    kind: "decision_made",
    decision_type,
    run_id,
    reason,
    ts: 1,
    data,
  };
}
