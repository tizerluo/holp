import { createHash } from "node:crypto";
import type {
  AgentBackend,
  AgentBackendFactory,
  AgentMessage,
} from "../../adapters/agent-backend.js";
import type { RuntimeSelectionMetadata } from "../../adapters/harness-declaration.js";
import type { Clock } from "./clock.js";
import type { ConnectionContext } from "./context.js";
import type { ApprovalRecord, RunRecord } from "./stores.js";
import type { Scheduler } from "./scheduler.js";
import { evidencePayload } from "./evidence.js";
import { expireApproval } from "./approvalLifecycle.js";
import { emitGateReport } from "./gateReport.js";
import { runConsensusGate } from "./runEngine.js";
import { claimTerminal } from "./terminalRun.js";
import {
  runtimeActionFromWorkPlan,
  roleForAction,
  validateWorkPlanHardConstraints,
  validateWorkflowRevisionHardConstraints,
  workflowTemplate,
  type DispatchCandidateV1,
  type DispatchHistoryEntryV1,
  type DispatchStateV1,
  type LearnedWorkPlanner,
  type PlannerModeV1,
  type RuntimeActionV1,
  type WorkPlanV1,
  type WorkPlanner,
  type WorkflowGraphV1,
  type WorkflowIdV1,
  type WorkflowRevisionV1,
} from "./workPlanner.js";

export interface WorkflowRunOptions {
  readonly workflowId: WorkflowIdV1;
  readonly maxSteps: number;
  readonly planner: WorkPlanner;
  readonly plannerMode?: PlannerModeV1;
  readonly learnedPlanner?: LearnedWorkPlanner;
  readonly plannerEvidenceId?: string;
  readonly candidates: readonly DispatchCandidateV1[];
  readonly coder: {
    readonly agent_id: string;
    readonly transport: string;
    readonly runtime: RuntimeSelectionMetadata;
    readonly factory: AgentBackendFactory;
    readonly holdSession?: boolean;
    readonly holdTimeoutMs?: number;
    readonly tmuxSocketPath?: string;
  };
  readonly reviewerPanelPresent: boolean;
  readonly reviewerQuorum?: number;
}

interface StepOutcome {
  readonly outcome: "completed" | "blocked" | "failed" | "cancelled";
  readonly reason?: string;
  readonly artifact_id?: string;
  readonly path?: string;
}

export async function driveWorkflowRun(
  run: RunRecord,
  options: WorkflowRunOptions,
  ctx: ConnectionContext,
  clock: Clock,
  scheduler: Scheduler,
): Promise<void> {
  ctx.governance.ensureRunState(run.run_id, "queued", clock.now());
  ctx.governance.transitionRun(run.run_id, "running", clock.now(), "workflow_starting");

  run.workflow = {
    version: "WorkflowRun.v1",
    workflow_id: options.workflowId,
    max_steps: options.maxSteps,
    committed_graph: committedGraph(options),
    pending_graph: {
      version: "WorkflowGraph.v1",
      cursor: 0,
      steps: [],
    },
  };
  run.planner_mode = options.plannerMode ?? "rule";
  run.planner_evidence_id = options.plannerEvidenceId;
  run.step_history = [];

  try {
    run.bus.publish("run", "run_started", {
      goal: run.goal,
      trigger: run.trigger,
      runtime: options.coder.runtime,
      workflow: options.workflowId,
    });
    ctx.governance.recordDecision({
      decision_type: "workflow_selected",
      run_id: run.run_id,
      reason: "workflow selected",
      ts: clock.now(),
      data: run.workflow,
    });
    run.bus.publish("lifecycle", "workflow_selected", {
      workflow_id: options.workflowId,
      max_steps: options.maxSteps,
      planner_mode: run.planner_mode,
    });

    while (run.status === "active") {
      const history: readonly DispatchHistoryEntryV1[] = run.step_history ?? [];
      const state = dispatchState(run, options, history.length);
      const plan = await selectPlannerStep(run, options, state, ctx, clock);
      if (plan.kind === "terminal") {
        completeRun(run, ctx, clock, latestArtifactId(run), plan.reason);
        return;
      }

      ctx.governance.recordDecision({
        decision_type: "dispatch_snapshot_recorded",
        run_id: run.run_id,
        reason: "dispatch snapshot recorded",
        ts: clock.now(),
        data: state,
      });

      ctx.governance.recordDecision({
        decision_type: "workflow_step_planned",
        run_id: run.run_id,
        reason: plan.action,
        ts: clock.now(),
        data: { step_index: state.step_index, plan },
      });
      run.bus.publish("lifecycle", "workflow_step_planned", {
        step_index: state.step_index,
        action: plan.action,
        agent_id: plan.agent_id,
        role: plan.role,
      });

      const runtimeAction = runtimeActionFromWorkPlan(plan);
      if (typeof runtimeAction !== "string") {
        blockRun(run, ctx, clock, runtimeAction.blocked_reason);
        return;
      }

      const token = `${run.run_id}:${state.step_index}:${runtimeAction}:${clock.now()}`;
      run.step_index = state.step_index;
      run.active_step_token = token;
      ctx.governance.recordDecision({
        decision_type: "workflow_step_started",
        run_id: run.run_id,
        reason: runtimeAction,
        ts: clock.now(),
        data: { step_index: state.step_index, action: runtimeAction },
      });

      const outcome = await executeRuntimeAction(
        runtimeAction,
        state.step_index,
        token,
        run,
        options,
        ctx,
        clock,
        scheduler,
      );
      if (run.active_step_token === token) run.active_step_token = undefined;

      if (outcome.outcome !== "completed") {
        recordStepOutcome({
          run,
          ctx,
          clock,
          state,
          plan,
          runtimeAction,
          outcome,
          history,
        });
        if (shouldContinueAfterBoundedL1(outcome)) {
          continue;
        }
        if (run.status === "active") {
          blockRun(run, ctx, clock, outcome.reason ?? "workflow_step_failed");
        } else {
          clearWorkflowStep(run);
        }
        return;
      }

      if (run.status !== "active") {
        clearWorkflowStep(run);
        return;
      }

      const entry = {
        step_index: state.step_index,
        snapshot_id: state.snapshot_id,
        action: plan,
        selected_agent_id: plan.agent_id,
        candidate_ids: candidateIdsForPlan(plan, state),
        runtime: runtimeForPlan(plan, state),
        artifact_id: outcome.artifact_id,
        approval_decision_refs: decisionIds(ctx, run.run_id, "approval_resolved"),
        consensus_decision_refs: decisionIds(ctx, run.run_id, "consensus_verdict"),
        outcome: "completed" as const,
      };
      run.step_history = [...history, entry];
      run.per_step = [
        ...(run.per_step ?? []),
        {
          step_index: state.step_index,
          action: runtimeAction,
          runtime: entry.runtime,
          artifact_id: outcome.artifact_id,
          outcome: "completed",
        },
      ];
      ctx.governance.recordDecision({
        decision_type: "workflow_step_completed",
        run_id: run.run_id,
        reason: "step completed",
        ts: clock.now(),
        data: {
          step_index: state.step_index,
          action: runtimeAction,
          artifact_id: outcome.artifact_id,
        },
      });
      ctx.governance.recordDecision({
        decision_type: "training_sample_recorded",
        run_id: run.run_id,
        reason: "step sample recorded",
        ts: clock.now(),
        data: {
          sample_id: `${run.run_id}:step:${state.step_index}`,
          run_id: run.run_id,
          step_index: state.step_index,
          state,
          action: plan,
        },
      });
      run.bus.publish("lifecycle", "workflow_step_completed", {
        step_index: state.step_index,
        action: runtimeAction,
        outcome: "completed",
        ...(outcome.artifact_id ? { artifact_id: outcome.artifact_id } : {}),
        ...(outcome.path ? { path: outcome.path } : {}),
      });
    }
  } catch (error) {
    if (run.status === "active") {
      failRun(run, ctx, clock, error instanceof Error ? error.message : String(error));
    }
  }
}

function dispatchState(
  run: RunRecord,
  options: WorkflowRunOptions,
  stepIndex: number,
): DispatchStateV1 {
  return {
    version: "DispatchState.v1",
    snapshot_id: `${run.run_id}:dispatch:${stepIndex}`,
    run_id: run.run_id,
    goal: run.goal,
    trigger: run.trigger,
    decision_kind: "next_step",
    workflow_id: options.workflowId,
    step_index: stepIndex,
    candidates: options.candidates,
    constraints: {
      max_steps: options.maxSteps,
      reviewer_panel_present: options.reviewerPanelPresent,
      reviewer_quorum: options.reviewerQuorum,
      allowed_actions: ["plan", "implement", "test", "review", "fix", "synthesize"],
      executable_actions: ["implement", "review"],
    },
    history: run.step_history ?? [],
  };
}

async function executeRuntimeAction(
  action: RuntimeActionV1,
  stepIndex: number,
  token: string,
  run: RunRecord,
  options: WorkflowRunOptions,
  ctx: ConnectionContext,
  clock: Clock,
  scheduler: Scheduler,
): Promise<StepOutcome> {
  if (action === "review") {
    const artifactId = latestArtifactId(run);
    const canContinue = await runConsensusGate(run, ctx, clock, artifactId, scheduler, {
      terminalOnBlocking: false,
    });
    if (!canContinue) {
      const reason = terminalReason(run, ctx) ?? "consensus_rejected";
      if (run.status !== "active" && isExternalTerminalInterruption(reason)) {
        return { outcome: "cancelled", reason };
      }
      return { outcome: "blocked", reason: consensusBlockingReason(run, ctx) ?? reason };
    }
    return { outcome: "completed", artifact_id: artifactId };
  }

  const backend = createBackend(run, options, ctx, clock, scheduler);
  run.backend = backend;
  return driveBackendStep(run, backend, ctx, clock, stepIndex, token);
}

function createBackend(
  run: RunRecord,
  options: WorkflowRunOptions,
  ctx: ConnectionContext,
  clock: Clock,
  scheduler: Scheduler,
): AgentBackend {
  return options.coder.factory({
    cwd: process.cwd(),
    holdSession: options.coder.holdSession,
    holdTimeoutMs: options.coder.holdTimeoutMs,
    tmuxSocketPath: options.coder.tmuxSocketPath,
    permissionHandler: async (toolName: string, input: unknown) => {
      return new Promise((resolveVerdict) => {
        run.approvalSeq += 1;
        const approvalId = `ap_${run.run_id}_${clock.now()}_${run.approvalSeq}`;
        const expiresAt = clock.now() + 300;
        const stepToken = run.active_step_token;

        const resumeBackend = (decision: "allow" | "deny"): void => {
          resolveVerdict(
            decision === "allow"
              ? { decision: "allow" as const, reason: "user_decision" }
              : { decision: "deny" as const, reason: "user_rejected" },
          );
        };

        const approvalRecord: ApprovalRecord = {
          approval_id: approvalId,
          run_id: run.run_id,
          kind: "merge_approval",
          reason: `${toolName} requires human approval`,
          expires_at: expiresAt,
          state: "pending",
          resumeBackend,
        };
        approvalRecord.expiryTimer = scheduler.schedule(expiresAt - clock.now(), () => {
          if (stepToken && run.active_step_token !== stepToken) return;
          expireApproval(ctx, approvalId, clock);
        });
        ctx.approvals.set(approvalId, approvalRecord);
        run.pendingApprovals.add(approvalId);
        ctx.governance.transitionRun(run.run_id, "waiting_approval", clock.now(), "approval_requested");
        ctx.governance.recordDecision({
          decision_type: "approval_requested",
          run_id: run.run_id,
          agent_id: options.coder.agent_id,
          approval_id: approvalId,
          reason: `${toolName} requires human approval`,
          ts: clock.now(),
          data: { kind: "merge_approval", tool: toolName, step_index: run.step_index },
        });
        run.bus.publish("approval", "approval_requested", {
          approval_id: approvalId,
          kind: "merge_approval",
          reason: `${toolName} requires human approval`,
          expires_at: expiresAt,
          provenance: { step_id: `workflow_step_${run.step_index ?? 0}`, artifact_id: null },
          details: evidencePayload({
            ctx,
            clock,
            artifactId: `art_approval_${approvalId}_details`,
            type: "approval_details",
            content: JSON.stringify({ tool: toolName, input }),
            createdBy: "holp-reference-daemon",
          }),
        });
      });
    },
  });
}

async function driveBackendStep(
  run: RunRecord,
  backend: AgentBackend,
  ctx: ConnectionContext,
  clock: Clock,
  stepIndex: number,
  token: string,
): Promise<StepOutcome> {
  let aborted = false;
  let abortReason: string | undefined;
  let diffArtifactContent: string | undefined;
  let diffArtifactPath: string | undefined;

  const onMessage = (msg: AgentMessage): void => {
    if (run.status !== "active") return;
    if (run.active_step_token !== token) return;

    switch (msg.type) {
      case "status":
        if (msg.status === "starting" || msg.status === "running") {
          run.bus.publish("agent", "step_started", { status: msg.status, detail: msg.detail });
        } else if (msg.status === "stopped" || msg.status === "error") {
          aborted = true;
          abortReason = msg.detail;
        }
        break;
      case "tool-call":
        run.bus.publish("agent", "tool_called", {
          tool_name: msg.toolName,
          args: msg.args,
          call_id: msg.callId,
        });
        break;
      case "tool-result":
        run.bus.publish("agent", "tool_result", {
          tool_name: msg.toolName,
          result: msg.result,
          call_id: msg.callId,
        });
        break;
      case "fs-edit":
        if (msg.diff) {
          diffArtifactContent = msg.diff;
          diffArtifactPath = msg.path;
        }
        run.bus.publish("agent", "fs_edited", {
          description: msg.description,
          path: msg.path,
        });
        break;
      case "model-output":
        run.bus.publish("agent", "model_output", {
          text_delta: msg.textDelta,
          full_text: msg.fullText,
        });
        break;
      case "event":
        run.bus.publish("agent", "agent_event", {
          name: msg.name,
          payload: msg.payload,
        });
        break;
      case "permission-request":
        break;
      default:
        break;
    }
  };

  backend.onMessage(onMessage);
  try {
    const { sessionId } = await backend.startSession();
    run.sessionId = sessionId;
    await backend.sendPrompt(sessionId, run.goal);
    if (run.status !== "active") return { outcome: "cancelled", reason: terminalReason(run, ctx) };
    if (aborted) return { outcome: "blocked", reason: abortReason ?? "approval_rejected" };

    const artifactId = diffArtifactContent ? `art_diff_${run.run_id}_${stepIndex}` : undefined;
    if (artifactId && diffArtifactContent) {
      const now = clock.now();
      ctx.artifacts.set(artifactId, {
        envelope: {
          artifact_id: artifactId,
          type: "diff",
          mime: "text/x-diff",
          size: diffArtifactContent.length,
          sha256: createHash("sha256").update(diffArtifactContent).digest("hex"),
          created_by: "agent-backend",
          created_at: now,
        },
        content: diffArtifactContent,
      });
    }
    return { outcome: "completed", artifact_id: artifactId, path: diffArtifactPath };
  } finally {
    backend.offMessage?.(onMessage);
    await backend.dispose().catch(() => {});
  }
}

function candidateIdsForPlan(plan: WorkPlanV1, state: DispatchStateV1): readonly string[] {
  if (plan.kind !== "step") return [];
  return state.candidates
    .filter((candidate) => candidate.role === plan.role)
    .map((candidate) => candidate.agent_id);
}

function recordStepOutcome(args: {
  readonly run: RunRecord;
  readonly ctx: ConnectionContext;
  readonly clock: Clock;
  readonly state: DispatchStateV1;
  readonly plan: WorkPlanV1;
  readonly runtimeAction: RuntimeActionV1;
  readonly outcome: StepOutcome;
  readonly history: readonly DispatchHistoryEntryV1[];
}): void {
  const reason = args.outcome.reason ?? "workflow_step_failed";
  const entry = {
    step_index: args.state.step_index,
    snapshot_id: args.state.snapshot_id,
    action: args.plan,
    selected_agent_id: args.plan.kind === "step" ? args.plan.agent_id : undefined,
    candidate_ids: candidateIdsForPlan(args.plan, args.state),
    runtime: runtimeForPlan(args.plan, args.state),
    artifact_id: args.outcome.artifact_id,
    approval_decision_refs: decisionIds(args.ctx, args.run.run_id, "approval_resolved"),
    consensus_decision_refs: decisionIds(args.ctx, args.run.run_id, "consensus_verdict"),
    outcome: args.outcome.outcome,
    reason,
  };
  args.run.step_history = [...args.history, entry];
  args.run.per_step = [
    ...(args.run.per_step ?? []),
    {
      step_index: args.state.step_index,
      action: args.runtimeAction,
      runtime: entry.runtime,
      artifact_id: args.outcome.artifact_id,
      outcome: args.outcome.outcome,
      reason,
    },
  ];
  if (args.outcome.outcome === "cancelled") return;

  args.ctx.governance.recordDecision({
    decision_type: "workflow_step_failed",
    run_id: args.run.run_id,
    reason,
    ts: args.clock.now(),
    data: {
      step_index: args.state.step_index,
      action: args.runtimeAction,
      outcome: args.outcome.outcome,
    },
  });
}

function runtimeForPlan(
  plan: WorkPlanV1,
  state: DispatchStateV1,
): RuntimeSelectionMetadata | undefined {
  if (plan.kind !== "step") return undefined;
  return state.candidates.find((candidate) => candidate.agent_id === plan.agent_id)?.runtime;
}

function latestArtifactId(run: RunRecord): string | undefined {
  return [...(run.step_history ?? [])].reverse().find((entry) => entry.artifact_id)?.artifact_id;
}

function completeRun(
  run: RunRecord,
  ctx: ConnectionContext,
  clock: Clock,
  artifactId: string | undefined,
  reason: string,
): void {
  clearWorkflowStep(run);
  if (claimTerminal(run, ctx, clock, {
    state: "merged",
    reason,
    eventName: "run_merged",
    ...(artifactId ? { data: { artifact_id: artifactId } } : {}),
    payload: {
      ...(artifactId ? { artifact_id: artifactId } : {}),
      reason,
    },
  })) {
    emitGateReport(run, ctx, clock);
  }
}

function blockRun(
  run: RunRecord,
  ctx: ConnectionContext,
  clock: Clock,
  reason: string,
): void {
  clearWorkflowStep(run);
  if (claimTerminal(run, ctx, clock, {
    state: "blocked",
    reason,
    eventName: "run_blocked",
    payload: { reason },
  })) {
    emitGateReport(run, ctx, clock);
  }
}

function failRun(run: RunRecord, ctx: ConnectionContext, clock: Clock, reason: string): void {
  clearWorkflowStep(run);
  if (claimTerminal(run, ctx, clock, {
    state: "gave_up",
    reason,
    eventName: "run_gave_up",
    payload: { reason },
  })) {
    emitGateReport(run, ctx, clock);
  }
}

function clearWorkflowStep(run: RunRecord): void {
  run.active_step_token = undefined;
  run.step_index = undefined;
}

function terminalReason(run: RunRecord, ctx: ConnectionContext): string | undefined {
  return [...ctx.governance.decisions]
    .reverse()
    .find((decision) => decision.run_id === run.run_id && decision.decision_type === "run_terminal")
    ?.reason;
}

function isExternalTerminalInterruption(reason: string): boolean {
  return reason === "cancelled" || reason === "approval_timeout_auto_reject";
}

function decisionIds(ctx: ConnectionContext, runId: string, decisionType: string): readonly string[] {
  return ctx.governance.decisions
    .filter((decision) => decision.run_id === runId && decision.decision_type === decisionType)
    .map((decision) => decision.decision_id);
}

async function selectPlannerStep(
  run: RunRecord,
  options: WorkflowRunOptions,
  state: DispatchStateV1,
  ctx: ConnectionContext,
  clock: Clock,
): Promise<WorkPlanV1> {
  const rulePlan = async (): Promise<WorkPlanV1> => options.planner.nextStep(state);
  const mode = options.plannerMode ?? "rule";
  if (mode === "rule" || !options.learnedPlanner) return rulePlan();

  try {
    const prediction = await options.learnedPlanner.predict(state);
    run.planner_backing = prediction.backing;
    const data = {
      ...prediction,
      state_snapshot_id: state.snapshot_id,
      evidence_id: options.plannerEvidenceId,
    };

    if (mode === "learned_shadow") {
      ctx.governance.recordDecision({
        decision_type: "learned_router_shadow_prediction",
        run_id: run.run_id,
        reason: "shadow_only",
        ts: clock.now(),
        data: { ...data, buffer: "shadow" },
      });
      return rulePlan();
    }

    if (prediction.backing !== "real_learned_model") {
      ctx.governance.recordDecision({
        decision_type: "learned_router_active_fallback",
        run_id: run.run_id,
        reason: "fixture_backing_not_active_eligible",
        ts: clock.now(),
        data: { ...data, requested_mode: mode },
      });
      return rulePlan();
    }

    if (prediction.output.version === "WorkflowRevision.v1") {
      const accepted = applyWorkflowRevision(run, prediction.output, state, ctx, clock);
      if (!accepted) return rulePlan();
      return planFromPendingGraph(run, state) ?? rulePlan();
    }

    const validation = validateWorkPlanHardConstraints(prediction.output, state);
    if (!validation.ok) {
      ctx.governance.recordDecision({
        decision_type: "learned_router_active_fallback",
        run_id: run.run_id,
        reason: "hard_constraint_violation",
        ts: clock.now(),
        data: { ...data, violations: validation.violations },
      });
      return rulePlan();
    }

    ctx.governance.recordDecision({
      decision_type: "learned_router_active_selected",
      run_id: run.run_id,
      reason: mode,
      ts: clock.now(),
      data,
    });
    return prediction.output;
  } catch (error) {
    ctx.governance.recordDecision({
      decision_type:
        mode === "learned_shadow"
          ? "learned_router_shadow_fallback"
          : "learned_router_active_fallback",
      run_id: run.run_id,
      reason: "planner_error",
      ts: clock.now(),
      data: { message: error instanceof Error ? error.message : String(error), requested_mode: mode },
    });
    return rulePlan();
  }
}

function applyWorkflowRevision(
  run: RunRecord,
  revision: WorkflowRevisionV1,
  state: DispatchStateV1,
  ctx: ConnectionContext,
  clock: Clock,
): boolean {
  const key = `${run.run_id}:${revision.revision_id}`;
  run.rejected_workflow_revisions ??= new Set();
  const validation = validateWorkflowRevisionHardConstraints(revision, state);
  if (!validation.ok) {
    if (
      !run.rejected_workflow_revisions.has(key) &&
      !revisionRejectedInGovernance(ctx, run.run_id, revision.revision_id)
    ) {
      run.rejected_workflow_revisions.add(key);
      ctx.governance.recordDecision({
        decision_type: "workflow_revision_rejected",
        run_id: run.run_id,
        reason: "hard_constraint_violation",
        ts: clock.now(),
        data: {
          revision,
          rollback_cursor: state.step_index,
          violations: validation.violations,
        },
      });
      publishDynamicWorkflowEvent(run, ctx, "workflow_revision_rejected", {
        revision_id: revision.revision_id,
        rollback_cursor: state.step_index,
        reason: "hard_constraint_violation",
      });
    }
    return false;
  }

  run.workflow = {
    ...(run.workflow ?? {
      version: "WorkflowRun.v1" as const,
      workflow_id: state.workflow_id,
      max_steps: state.constraints.max_steps,
    }),
    pending_graph: revision.pending_graph,
  };
  ctx.governance.recordDecision({
    decision_type: "workflow_revised",
    run_id: run.run_id,
    reason: revision.reason ?? "workflow_revision_accepted",
    ts: clock.now(),
    data: revision,
  });
  publishDynamicWorkflowEvent(run, ctx, "workflow_revised", {
    revision_id: revision.revision_id,
    cursor: revision.pending_graph.cursor,
  });
  return true;
}

function publishDynamicWorkflowEvent(
  run: RunRecord,
  ctx: ConnectionContext,
  name: "workflow_revised" | "workflow_revision_rejected",
  payload: unknown,
): void {
  if (ctx.initialized?.negotiated.dynamic_workflow.supported !== true) return;
  run.bus.publish("lifecycle", name, payload);
}

function planFromPendingGraph(
  run: RunRecord,
  state: DispatchStateV1,
): WorkPlanV1 | undefined {
  const graph = run.workflow?.pending_graph;
  const step = graph?.steps[state.step_index - (graph.cursor ?? 0)];
  if (!step) return undefined;
  return {
    version: "WorkPlan.v1",
    kind: "step",
    action: step.action,
    agent_id: step.agent_id,
    role: step.role,
  };
}

function revisionRejectedInGovernance(
  ctx: ConnectionContext,
  runId: string,
  revisionId: string,
): boolean {
  return ctx.governance.decisions.some((decision) =>
    decision.run_id === runId &&
    decision.decision_type === "workflow_revision_rejected" &&
    revisionIdFromDecisionData(decision.data) === revisionId
  );
}

function revisionIdFromDecisionData(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const revision = (data as { revision?: unknown }).revision;
  if (!revision || typeof revision !== "object") return undefined;
  const revisionId = (revision as { revision_id?: unknown }).revision_id;
  return typeof revisionId === "string" ? revisionId : undefined;
}

function committedGraph(options: WorkflowRunOptions): WorkflowGraphV1 {
  return {
    version: "WorkflowGraph.v1",
    cursor: 0,
    steps: workflowTemplate(options.workflowId, options.reviewerPanelPresent).map((action, index) => {
      const role = roleForAction(action);
      const candidate = options.candidates.find((item) => item.role === role);
      return {
        id: `l0_${index}_${action}`,
        action,
        role,
        agent_id: candidate?.agent_id ?? "unassigned",
      };
    }),
  };
}

function shouldContinueAfterBoundedL1(outcome: StepOutcome): boolean {
  return outcome.outcome === "blocked" && outcome.reason === "consensus_request_changes";
}

function consensusBlockingReason(run: RunRecord, ctx: ConnectionContext): string | undefined {
  const verdict = [...ctx.governance.decisions]
    .reverse()
    .find((decision) =>
      decision.run_id === run.run_id && decision.decision_type === "consensus_verdict"
    );
  const outcome = verdict?.data && typeof verdict.data === "object"
    ? (verdict.data as { outcome?: unknown }).outcome
    : undefined;
  return outcome === "request_changes" || outcome === "reject"
    ? `consensus_${outcome}`
    : undefined;
}
