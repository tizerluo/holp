import { describe, expect, it } from "vitest";
import {
  parseMaxSteps,
  RuleWorkPlanner,
  runtimeActionFromWorkPlan,
  type DispatchStateV1,
  type WorkflowIdV1,
  type WorkPlanV1,
} from "./workPlanner.js";

function state(
  workflow_id: WorkflowIdV1,
  step_index: number,
  reviewer_panel_present = true,
): DispatchStateV1 {
  return {
    version: "DispatchState.v1",
    snapshot_id: `run_1:dispatch:${step_index}`,
    run_id: "run_1",
    goal: "ship it",
    trigger: "manual",
    decision_kind: "next_step",
    workflow_id,
    step_index,
    candidates: [
      { agent_id: "coder", role: "coder", transport: "fake", status: "ready" },
      { agent_id: "reviewer", role: "reviewer", transport: "fake", status: "ready" },
    ],
    constraints: {
      max_steps: 3,
      reviewer_panel_present,
      reviewer_quorum: reviewer_panel_present ? 1 : undefined,
      executable_actions: ["implement", "review"],
    },
    history: [],
  };
}

describe("RuleWorkPlanner", () => {
  it("returns deterministic steps for single-step, linear, and spec-driven workflows", () => {
    const planner = new RuleWorkPlanner();

    expect(planner.nextStep(state("single-step", 0))).toMatchObject({
      kind: "step",
      action: "implement",
      agent_id: "coder",
    });
    expect(planner.nextStep(state("single-step", 1))).toMatchObject({
      kind: "terminal",
      reason: "workflow_complete",
    });
    expect(planner.nextStep(state("linear", 0))).toMatchObject({ action: "implement" });
    expect(planner.nextStep(state("linear", 1))).toMatchObject({ action: "review" });
    expect(planner.nextStep(state("spec-driven", 0))).toMatchObject({ action: "plan" });
    expect(planner.nextStep(state("spec-driven", 1))).toMatchObject({ action: "implement" });
  });

  it("omits review when no reviewer panel is present", () => {
    const planner = new RuleWorkPlanner();

    expect(planner.nextStep(state("linear", 0, false))).toMatchObject({ action: "implement" });
    expect(planner.nextStep(state("linear", 1, false))).toMatchObject({
      kind: "terminal",
      reason: "workflow_complete",
    });
  });

  it("rejects invalid max_steps values", () => {
    for (const value of [0, -1, 1.5, "2", null]) {
      expect(() => parseMaxSteps(value)).toThrow("positive integer");
    }
    expect(parseMaxSteps(undefined)).toBe(1);
    expect(parseMaxSteps(2)).toBe(2);
  });

  it("maps only implement and review to executable runtime actions", () => {
    const blocked: WorkPlanV1 = {
      version: "WorkPlan.v1",
      kind: "step",
      action: "test",
      agent_id: "tester",
      role: "tester",
    };

    expect(runtimeActionFromWorkPlan(plannerStep("implement"))).toBe("implement");
    expect(runtimeActionFromWorkPlan(plannerStep("review"))).toBe("review");
    expect(runtimeActionFromWorkPlan(blocked)).toEqual({
      blocked_reason: "action_executor_not_available:test",
    });
  });

  it("produces JSON-serializable DispatchState without runtime handles", () => {
    const snapshot = state("linear", 0);
    const json = JSON.stringify(snapshot);

    expect(json).toContain('"DispatchState.v1"');
    expect(json).not.toContain("backend");
    expect(json).not.toContain("pendingApprovals");
    expect(json).not.toContain("expiryTimer");
  });
});

function plannerStep(action: "implement" | "review"): WorkPlanV1 {
  return {
    version: "WorkPlan.v1",
    kind: "step",
    action,
    agent_id: action === "implement" ? "coder" : "reviewer",
    role: action === "implement" ? "coder" : "reviewer",
  };
}
