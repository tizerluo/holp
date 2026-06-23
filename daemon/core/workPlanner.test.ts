import { describe, expect, it } from "vitest";
import {
  parseMaxSteps,
  RuleWorkPlanner,
  canarySelected,
  runtimeActionFromWorkPlan,
  validateWorkPlanHardConstraints,
  validateWorkflowRevisionHardConstraints,
  type DispatchStateV1,
  type WorkflowIdV1,
  type WorkPlanV1,
  type WorkflowRevisionV1,
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

  it("routes failed tests through bounded L1 fix then review", () => {
    const planner = new RuleWorkPlanner();
    const failedTest: WorkPlanV1 = {
      version: "WorkPlan.v1",
      kind: "step",
      action: "test",
      agent_id: "tester",
      role: "tester",
    };
    const fix: WorkPlanV1 = {
      version: "WorkPlan.v1",
      kind: "step",
      action: "fix",
      agent_id: "coder",
      role: "coder",
    };

    expect(planner.nextStep({
      ...state("linear", 1),
      history: [{
        step_index: 0,
        snapshot_id: "run_1:dispatch:0",
        action: failedTest,
        selected_agent_id: "tester",
        candidate_ids: ["tester"],
        approval_decision_refs: [],
        consensus_decision_refs: [],
        outcome: "failed",
        reason: "failed_test",
      }],
    })).toMatchObject({
      kind: "step",
      action: "fix",
      agent_id: "coder",
      role: "coder",
    });
    expect(planner.nextStep({
      ...state("linear", 2),
      history: [{
        step_index: 1,
        snapshot_id: "run_1:dispatch:1",
        action: fix,
        selected_agent_id: "coder",
        candidate_ids: ["coder"],
        approval_decision_refs: [],
        consensus_decision_refs: [],
        outcome: "completed",
      }],
    })).toMatchObject({
      kind: "step",
      action: "review",
      agent_id: "reviewer",
      role: "reviewer",
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
    expect(runtimeActionFromWorkPlan({
      version: "WorkPlan.v1",
      kind: "step",
      action: "fix",
      agent_id: "coder",
      role: "coder",
    })).toBe("implement");
    expect(runtimeActionFromWorkPlan(blocked)).toEqual({
      blocked_reason: "action_executor_not_available:test",
    });
  });

  it("validates candidate membership, role match, max_steps, and runtime metadata", () => {
    const validState: DispatchStateV1 = {
      ...state("linear", 0),
      candidates: [
        {
          agent_id: "coder",
          role: "coder",
          transport: "fake",
          status: "ready",
          runtime: runtime("coder", "coder_worktree"),
        },
        {
          agent_id: "reviewer",
          role: "reviewer",
          transport: "fake",
          status: "ready",
          runtime: runtime("reviewer", "read_only_review"),
        },
      ],
    };
    expect(validateWorkPlanHardConstraints(plannerStep("implement"), validState).ok)
      .toBe(true);
    expect(validateWorkPlanHardConstraints({
      version: "WorkPlan.v1",
      kind: "terminal",
      reason: "workflow_complete",
    }, {
      ...validState,
      step_index: validState.constraints.max_steps,
    }).ok).toBe(true);
    expect(validateWorkPlanHardConstraints(plannerStep("implement"), {
      ...validState,
      constraints: {
        ...validState.constraints,
        allowed_actions: ["review"],
      },
    })).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ code: "action_not_allowed" }),
      ]),
    });
    const invalid = validateWorkPlanHardConstraints({
      version: "WorkPlan.v1",
      kind: "step",
      action: "review",
      agent_id: "coder",
      role: "coder",
    }, state("linear", 3));

    expect(invalid).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ code: "max_steps_exceeded" }),
        expect.objectContaining({ code: "role_mismatch" }),
      ]),
    });
    expect(validateWorkPlanHardConstraints({
      version: "WorkPlan.v1",
      kind: "step",
      action: "bogus",
      agent_id: "coder",
      role: "coder",
    } as unknown as WorkPlanV1, validState)).toMatchObject({
      ok: false,
      violations: [expect.objectContaining({ code: "action_unsupported" })],
    });
  });

  it("validates workflow revisions as all-or-nothing pending graph replacements", () => {
    const validState: DispatchStateV1 = {
      ...state("linear", 1),
      candidates: [
        {
          agent_id: "coder",
          role: "coder",
          transport: "fake",
          status: "ready",
          runtime: runtime("coder", "coder_worktree"),
        },
        {
          agent_id: "reviewer",
          role: "reviewer",
          transport: "fake",
          status: "ready",
          runtime: runtime("reviewer", "read_only_review"),
        },
      ],
    };
    const revision: WorkflowRevisionV1 = {
      version: "WorkflowRevision.v1",
      revision_id: "rev_1",
      base_cursor: 1,
      pending_graph: {
        version: "WorkflowGraph.v1",
        cursor: 1,
        steps: [
          { id: "fix_1", action: "fix", agent_id: "coder", role: "coder" },
          { id: "review_1", action: "review", agent_id: "reviewer", role: "reviewer" },
        ],
      },
    };

    expect(validateWorkflowRevisionHardConstraints(revision, validState).ok).toBe(true);
    expect(validateWorkflowRevisionHardConstraints({
      ...revision,
      pending_graph: {
        ...revision.pending_graph,
        cursor: 2,
      },
    }, validState)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ code: "pending_graph_cursor_mismatch" }),
      ]),
    });
    expect(validateWorkflowRevisionHardConstraints({
      ...revision,
      pending_graph: {
        ...revision.pending_graph,
        steps: [
          { id: "bad", action: "review", agent_id: "coder", role: "coder" },
        ],
      },
    }, validState)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.objectContaining({ code: "role_mismatch" })]),
    });
  });

  it("assigns canary lanes deterministically with allowlist precedence", () => {
    const args = { runId: "run_1", seed: "seed", ratio: 0.25 };
    expect(canarySelected(args)).toBe(canarySelected(args));
    expect(canarySelected({ ...args, ratio: 0 })).toBe(false);
    expect(canarySelected({ ...args, ratio: 0, allowlist: ["run_1"] })).toBe(true);
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

function runtime(agent_id: string, isolation_profile: "coder_worktree" | "read_only_review") {
  return {
    agent_id,
    transport: "fake",
    runtime_surface: "headless" as const,
    runtime_kind: "fake",
    actual_fidelity: "streaming_controlled" as const,
    isolation_profile,
    isolation_status: "ready" as const,
    global_mutation_required: false,
    declared_not_enforced: true,
  };
}
