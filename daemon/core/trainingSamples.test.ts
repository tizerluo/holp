import { describe, expect, it } from "vitest";
import type { DecisionRecord } from "./governance.js";
import {
  attributeReward,
  exportTrainingSamples,
  exportTrainingSamplesJsonl,
  REWARD_POLICY_VERSION,
} from "./trainingSamples.js";
import type { DispatchStateV1, WorkPlanV1 } from "./workPlanner.js";

const action: WorkPlanV1 = {
  version: "WorkPlan.v1",
  kind: "step",
  action: "implement",
  agent_id: "coder",
  role: "coder",
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
