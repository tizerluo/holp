import type { RuntimeSelectionMetadata } from "../../adapters/harness-declaration.js";

export type WorkflowIdV1 = "single-step" | "linear" | "spec-driven";

export type WorkActionV1 =
  | "plan"
  | "implement"
  | "test"
  | "review"
  | "fix"
  | "synthesize";

export type RuntimeActionV1 = "implement" | "review";

export interface DispatchCandidateV1 {
  readonly agent_id: string;
  readonly role: string;
  readonly transport: string;
  readonly status: string;
  readonly runtime?: RuntimeSelectionMetadata;
}

export interface DispatchHistoryEntryV1 {
  readonly step_index: number;
  readonly snapshot_id: string;
  readonly action: WorkPlanV1;
  readonly selected_agent_id?: string;
  readonly candidate_ids: readonly string[];
  readonly runtime?: RuntimeSelectionMetadata;
  readonly artifact_id?: string;
  readonly approval_decision_refs: readonly string[];
  readonly consensus_decision_refs: readonly string[];
  readonly outcome: "completed" | "failed" | "blocked" | "cancelled";
  readonly reason?: string;
}

export interface DispatchStateV1 {
  readonly version: "DispatchState.v1";
  readonly snapshot_id: string;
  readonly run_id: string;
  readonly goal: string;
  readonly trigger: string;
  readonly decision_kind: "next_step";
  readonly workflow_id: WorkflowIdV1;
  readonly step_index: number;
  readonly candidates: readonly DispatchCandidateV1[];
  readonly constraints: {
    readonly max_steps: number;
    readonly reviewer_panel_present: boolean;
    readonly reviewer_quorum?: number;
    readonly executable_actions: readonly RuntimeActionV1[];
  };
  readonly history: readonly DispatchHistoryEntryV1[];
}

export type WorkPlanV1 =
  | {
      readonly version: "WorkPlan.v1";
      readonly kind: "step";
      readonly action: WorkActionV1;
      readonly agent_id: string;
      readonly role: string;
    }
  | {
      readonly version: "WorkPlan.v1";
      readonly kind: "terminal";
      readonly reason: string;
    };

export interface WorkPlanner {
  nextStep(state: DispatchStateV1): WorkPlanV1;
}

export class RuleWorkPlanner implements WorkPlanner {
  nextStep(state: DispatchStateV1): WorkPlanV1 {
    const template = workflowTemplate(state.workflow_id, state.constraints.reviewer_panel_present);
    const nextAction = template[state.step_index];
    if (!nextAction || state.step_index >= state.constraints.max_steps) {
      return { version: "WorkPlan.v1", kind: "terminal", reason: "workflow_complete" };
    }

    if (nextAction === "review" && !state.constraints.reviewer_panel_present) {
      return { version: "WorkPlan.v1", kind: "terminal", reason: "reviewer_panel_absent" };
    }

    const role = roleForAction(nextAction);
    const candidate = state.candidates.find((item) => item.role === role);
    if (!candidate) {
      if (nextAction === "implement" || nextAction === "review") {
        return {
          version: "WorkPlan.v1",
          kind: "terminal",
          reason: `candidate_not_available:${role}`,
        };
      }
      return {
        version: "WorkPlan.v1",
        kind: "step",
        action: nextAction,
        agent_id: "unassigned",
        role,
      };
    }

    return {
      version: "WorkPlan.v1",
      kind: "step",
      action: nextAction,
      agent_id: candidate.agent_id,
      role,
    };
  }
}

export function workflowTemplate(
  workflowId: WorkflowIdV1,
  reviewerPanelPresent: boolean,
): readonly WorkActionV1[] {
  switch (workflowId) {
    case "single-step":
      return ["implement"];
    case "linear":
      return reviewerPanelPresent ? ["implement", "review"] : ["implement"];
    case "spec-driven":
      return reviewerPanelPresent ? ["plan", "implement", "review", "test"] : ["plan", "implement", "test"];
    default:
      return assertNever(workflowId);
  }
}

export function runtimeActionFromWorkPlan(
  plan: WorkPlanV1,
): RuntimeActionV1 | { readonly blocked_reason: string } {
  if (plan.kind !== "step") return { blocked_reason: "terminal_plan" };
  if (plan.action === "implement" || plan.action === "review") return plan.action;
  return { blocked_reason: `action_executor_not_available:${plan.action}` };
}

export function parseWorkflowId(value: unknown): WorkflowIdV1 {
  if (value === undefined || value === "single-step") return "single-step";
  if (value === "linear" || value === "spec-driven") return value;
  throw new Error("orchestrate.run: params.workflow must be single-step, linear, or spec-driven");
}

export function parseMaxSteps(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("orchestrate.run: params.max_steps must be a positive integer");
  }
  return value;
}

function roleForAction(action: WorkActionV1): string {
  switch (action) {
    case "implement":
    case "fix":
      return "coder";
    case "review":
      return "reviewer";
    case "test":
      return "tester";
    case "plan":
    case "synthesize":
      return "architect";
    default:
      return assertNever(action);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled workflow value: ${String(value)}`);
}
