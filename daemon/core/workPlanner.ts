import type { RuntimeSelectionMetadata } from "../../adapters/harness-declaration.js";
import { createHash } from "node:crypto";

export type WorkflowIdV1 = "single-step" | "linear" | "spec-driven";

export type WorkActionV1 =
  | "plan"
  | "implement"
  | "test"
  | "review"
  | "fix"
  | "synthesize";

export type RuntimeActionV1 = "implement" | "review";

export type PlannerModeV1 = "rule" | "learned_shadow" | "learned_active" | "canary";
export type LearnedPlannerBacking = "fixture_planner" | "real_learned_model";

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
    readonly allowed_actions?: readonly WorkActionV1[];
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
  nextStep(state: DispatchStateV1): WorkPlanV1 | Promise<WorkPlanV1>;
}

export interface LearnedPlannerDecisionV1 {
  readonly version: "LearnedPlannerDecision.v1";
  readonly decision_type: "learned_router_prediction";
  readonly planner_version: string;
  readonly backing: LearnedPlannerBacking;
  readonly buffer: "shadow" | "active" | "canary";
  readonly output: WorkPlanV1 | WorkflowRevisionV1;
}

export interface LearnedWorkPlanner {
  predict(state: DispatchStateV1): LearnedPlannerDecisionV1 | Promise<LearnedPlannerDecisionV1>;
}

export interface WorkflowStepNodeV1 {
  readonly id: string;
  readonly action: WorkActionV1;
  readonly agent_id: string;
  readonly role: string;
}

export interface WorkflowGraphV1 {
  readonly version: "WorkflowGraph.v1";
  readonly cursor: number;
  readonly steps: readonly WorkflowStepNodeV1[];
}

export interface WorkflowRevisionV1 {
  readonly version: "WorkflowRevision.v1";
  readonly revision_id: string;
  readonly base_cursor: number;
  readonly pending_graph: WorkflowGraphV1;
  readonly reason?: string;
}

export interface HardConstraintViolation {
  readonly code: string;
  readonly detail?: unknown;
}

export type HardConstraintValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly HardConstraintViolation[] };

export class RuleWorkPlanner implements WorkPlanner {
  nextStep(state: DispatchStateV1): WorkPlanV1 {
    const l1 = boundedDynamicAction(state);
    if (l1) {
      const candidate = state.candidates.find((item) => item.role === l1.role);
      return candidate
        ? {
            version: "WorkPlan.v1",
            kind: "step",
            action: l1.action,
            agent_id: candidate.agent_id,
            role: l1.role,
          }
        : {
            version: "WorkPlan.v1",
            kind: "terminal",
            reason: `candidate_not_available:${l1.role}`,
          };
    }

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

export class FixtureLearnedWorkPlanner implements LearnedWorkPlanner {
  constructor(
    readonly plannerVersion = "fixture-learned-router-v1",
    readonly buffer: LearnedPlannerDecisionV1["buffer"] = "shadow",
  ) {}

  predict(state: DispatchStateV1): LearnedPlannerDecisionV1 {
    return {
      version: "LearnedPlannerDecision.v1",
      decision_type: "learned_router_prediction",
      planner_version: this.plannerVersion,
      backing: "fixture_planner",
      buffer: this.buffer,
      output: new RuleWorkPlanner().nextStep(state) as WorkPlanV1,
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
  if (plan.action === "implement" || plan.action === "fix") return "implement";
  if (plan.action === "review") return "review";
  return { blocked_reason: `action_executor_not_available:${plan.action}` };
}

export function validateWorkPlanHardConstraints(
  plan: WorkPlanV1,
  state: DispatchStateV1,
): HardConstraintValidationResult {
  const violations: HardConstraintViolation[] = [];

  if (plan.version !== "WorkPlan.v1") {
    violations.push({ code: "invalid_plan_version" });
  }
  if (plan.kind === "terminal") return validationResult(violations);

  if (state.step_index >= state.constraints.max_steps) {
    violations.push({ code: "max_steps_exceeded", detail: { step_index: state.step_index } });
  }

  if (!isWorkAction(plan.action)) {
    violations.push({ code: "action_unsupported", detail: plan.action });
    return validationResult(violations);
  }
  const allowed = state.constraints.allowed_actions ?? WORK_ACTIONS;
  if (!allowed.includes(plan.action)) {
    violations.push({ code: "action_not_allowed", detail: plan.action });
  }

  const expectedRole = roleForAction(plan.action);
  if (plan.role !== expectedRole) {
    violations.push({
      code: "role_mismatch",
      detail: { action: plan.action, expected: expectedRole, actual: plan.role },
    });
  }

  const candidate = state.candidates.find((item) =>
    item.agent_id === plan.agent_id && item.role === plan.role
  );
  if (!candidate) {
    violations.push({
      code: "candidate_not_in_dispatch_state",
      detail: { agent_id: plan.agent_id, role: plan.role },
    });
  }

  const runtimeAction = runtimeActionFromWorkPlan(plan);
  if (typeof runtimeAction === "string" && !candidate?.runtime) {
    violations.push({
      code: "runtime_metadata_missing",
      detail: { agent_id: plan.agent_id, action: plan.action },
    });
  }
  if (typeof runtimeAction === "string" && !state.constraints.executable_actions.includes(runtimeAction)) {
    violations.push({ code: "runtime_action_not_executable", detail: runtimeAction });
  }

  return validationResult(violations);
}

export function validateWorkflowRevisionHardConstraints(
  revision: WorkflowRevisionV1,
  state: DispatchStateV1,
): HardConstraintValidationResult {
  const violations: HardConstraintViolation[] = [];
  if (revision.version !== "WorkflowRevision.v1") {
    violations.push({ code: "invalid_revision_version" });
  }
  if (revision.base_cursor !== state.step_index) {
    violations.push({
      code: "rollback_cursor_mismatch",
      detail: { expected: state.step_index, actual: revision.base_cursor },
    });
  }
  if (revision.pending_graph.version !== "WorkflowGraph.v1") {
    violations.push({ code: "invalid_graph_version" });
  }
  if (revision.pending_graph.cursor !== revision.base_cursor) {
    violations.push({
      code: "pending_graph_cursor_mismatch",
      detail: { cursor: revision.pending_graph.cursor, base_cursor: revision.base_cursor },
    });
  }
  if (state.step_index + revision.pending_graph.steps.length > state.constraints.max_steps) {
    violations.push({
      code: "max_steps_exceeded",
      detail: {
        step_index: state.step_index,
        pending_steps: revision.pending_graph.steps.length,
        max_steps: state.constraints.max_steps,
      },
    });
  }

  for (const [offset, step] of revision.pending_graph.steps.entries()) {
    const plan: WorkPlanV1 = {
      version: "WorkPlan.v1",
      kind: "step",
      action: step.action,
      agent_id: step.agent_id,
      role: step.role,
    };
    const result = validateWorkPlanHardConstraints(plan, {
      ...state,
      step_index: state.step_index + offset,
    });
    if (!result.ok) violations.push(...result.violations);
  }

  return validationResult(violations);
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

export function roleForAction(action: WorkActionV1): string {
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

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function canarySelected(args: {
  readonly runId: string;
  readonly seed: string;
  readonly ratio: number;
  readonly allowlist?: readonly string[];
}): boolean {
  if (args.allowlist?.includes(args.runId)) return true;
  if (args.ratio <= 0) return false;
  if (args.ratio >= 1) return true;
  const hash = sha256Hex(`${args.seed}:${args.runId}`).slice(0, 8);
  const bucket = Number.parseInt(hash, 16) / 0xffffffff;
  return bucket < args.ratio;
}

function boundedDynamicAction(
  state: DispatchStateV1,
): { readonly action: WorkActionV1; readonly role: string } | undefined {
  if (state.step_index >= state.constraints.max_steps) return undefined;
  const last = state.history[state.history.length - 1];
  if (!last || last.action.kind !== "step") return undefined;
  if (
    last.action.action === "review" &&
    last.outcome === "blocked" &&
    last.reason === "consensus_request_changes"
  ) {
    return { action: "fix", role: "coder" };
  }
  if (
    last.action.action === "test" &&
    last.outcome === "failed" &&
    last.reason === "failed_test"
  ) {
    return { action: "fix", role: "coder" };
  }
  if (last.action.action === "fix" && last.outcome === "completed") {
    return { action: "review", role: "reviewer" };
  }
  return undefined;
}

function validationResult(
  violations: readonly HardConstraintViolation[],
): HardConstraintValidationResult {
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

const WORK_ACTIONS: readonly WorkActionV1[] = [
  "plan",
  "implement",
  "test",
  "review",
  "fix",
  "synthesize",
];

function isWorkAction(value: unknown): value is WorkActionV1 {
  return typeof value === "string" && (WORK_ACTIONS as readonly string[]).includes(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
}
