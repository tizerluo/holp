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
import { runConsensusGate } from "./runEngine.js";
import {
  runtimeActionFromWorkPlan,
  type DispatchCandidateV1,
  type DispatchHistoryEntryV1,
  type DispatchStateV1,
  type RuntimeActionV1,
  type WorkPlanV1,
  type WorkPlanner,
  type WorkflowIdV1,
} from "./workPlanner.js";

export interface WorkflowRunOptions {
  readonly workflowId: WorkflowIdV1;
  readonly maxSteps: number;
  readonly planner: WorkPlanner;
  readonly candidates: readonly DispatchCandidateV1[];
  readonly coder: {
    readonly agent_id: string;
    readonly transport: string;
    readonly runtime: RuntimeSelectionMetadata;
    readonly factory: AgentBackendFactory;
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
  };
  run.planner_mode = "rule";
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
      ctx.governance.recordDecision({
        decision_type: "dispatch_snapshot_recorded",
        run_id: run.run_id,
        reason: "dispatch snapshot recorded",
        ts: clock.now(),
        data: state,
      });

      const plan = options.planner.nextStep(state);
      if (plan.kind === "terminal") {
        completeRun(run, ctx, clock, latestArtifactId(run), plan.reason);
        return;
      }

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
        if (outcome.outcome !== "cancelled") {
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
    const canContinue = await runConsensusGate(run, ctx, clock, artifactId, scheduler);
    if (!canContinue) {
      return { outcome: "blocked", reason: terminalReason(run, ctx) ?? "consensus_rejected" };
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
  if (run.status !== "active") return;
  clearWorkflowStep(run);
  ctx.governance.transitionRun(run.run_id, "merged", clock.now(), reason);
  run.status = "merged";
  ctx.governance.recordDecision({
    decision_type: "run_terminal",
    run_id: run.run_id,
    reason,
    ts: clock.now(),
    data: { state: "merged", artifact_id: artifactId },
  });
  run.bus.publish("run", "run_merged", {
    ...(artifactId ? { artifact_id: artifactId } : {}),
    reason,
  });
}

function blockRun(
  run: RunRecord,
  ctx: ConnectionContext,
  clock: Clock,
  reason: string,
): void {
  if (run.status !== "active") return;
  clearWorkflowStep(run);
  ctx.governance.transitionRun(run.run_id, "blocked", clock.now(), reason);
  run.status = "blocked";
  ctx.governance.recordDecision({
    decision_type: "run_terminal",
    run_id: run.run_id,
    reason,
    ts: clock.now(),
    data: { state: "blocked" },
  });
  run.bus.publish("run", "run_blocked", { reason });
}

function failRun(run: RunRecord, ctx: ConnectionContext, clock: Clock, reason: string): void {
  if (run.status !== "active") return;
  clearWorkflowStep(run);
  ctx.governance.transitionRun(run.run_id, "gave_up", clock.now(), reason);
  run.status = "gave_up";
  ctx.governance.recordDecision({
    decision_type: "run_terminal",
    run_id: run.run_id,
    reason,
    ts: clock.now(),
    data: { state: "gave_up" },
  });
  run.bus.publish("run", "run_gave_up", { reason });
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

function decisionIds(ctx: ConnectionContext, runId: string, decisionType: string): readonly string[] {
  return ctx.governance.decisions
    .filter((decision) => decision.run_id === runId && decision.decision_type === decisionType)
    .map((decision) => decision.decision_id);
}
