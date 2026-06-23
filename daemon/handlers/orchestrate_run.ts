/**
 * `orchestrate.run` handler — spec §4 / §4.1 / §4.2 / §6.2.
 *
 * Validation order is FIXED (spec §6.2 / brief):
 *   1. agent_not_found (-32019): any agent id not in this connection's flock.
 *   2. role_unsupported (-32018): known agent but resolved_roles doesn't include the role.
 *   3. invalid_quorum (-32007): reviewer panel shape illegal.
 *   4. quorum_unsatisfiable (-32004): shape legal but reviewer-capable count < quorum.
 *   5. unsupported_execution_mode (-32013): kind != "Local".
 *   6. approval_required_but_unsupported (-32003): client cannot handle approval.
 *   7. isolation_profile_rejected (-32021): selected runtime/profile cannot be scheduled.
 *   8. -32600 invalid_request for malformed params.
 *
 * On success: create run record, return { run_id, accepted:true } immediately,
 * and kick off the selected backend session asynchronously.
 */

import { holpError, invalidRequest } from "../core/errors.js";
import { HolpRpcError } from "../core/dispatcher.js";
import { isObject } from "../core/internal.js";
import type { JsonRpcRequest } from "../runtime/jsonrpc.js";
import type { ConnectionContext } from "../core/context.js";
import type { ApprovalRecord, FlockAgent, RunRecord } from "../core/stores.js";
import { EventBus } from "../core/eventBus.js";
import { evidencePayload } from "../core/evidence.js";
import type { AdapterRegistry } from "../../adapters/registry.js";
import { createClaudeCodeBackendFactory } from "../../adapters/claude-code.js";
import { createCodexAppServerBackendFactory } from "../../adapters/codex-app-server.js";
import {
  firstBatchHeadlessFactoryForTransport,
  isFirstBatchTransport,
} from "../../adapters/first-batch-harnesses.js";
import type { Clock } from "../core/clock.js";
import type { Scheduler } from "../core/scheduler.js";
import { driveRun } from "../core/runEngine.js";
import { expireApproval } from "../core/approvalLifecycle.js";
import { driveWorkflowRun } from "../core/workflowEngine.js";
import {
  canarySelected,
  FixtureLearnedWorkPlanner,
  parseMaxSteps,
  parseWorkflowId,
  RuleWorkPlanner,
  type DispatchCandidateV1,
  type PlannerModeV1,
} from "../core/workPlanner.js";
import type {
  ConsensusPolicy,
  ConsensusReviewerSelection,
  OnConsensusBlocking,
  OnQuorumUnsatisfiable,
  AuthorProvenance,
} from "../core/consensus.js";
import {
  createReviewerExecutor,
  type ReviewerAgentExecutionConfig,
} from "../core/reviewer.js";
import {
  findRuntimeProfile,
  runtimeSelectionFromDeclaration,
  type IsolationProfile,
  type RuntimeSurface,
  type RuntimeSelectionMetadata,
} from "../../adapters/harness-declaration.js";

// M1b single-connection; per-connection run-id scoping deferred (see ConnectionContext.subscriptionCounter for the pattern).
let runCounter = 0;

function nextRunId(): string {
  runCounter += 1;
  return `run_${runCounter}`;
}

export function handleOrchestrateRun(
  req: JsonRpcRequest,
  ctx: ConnectionContext,
  registry: AdapterRegistry,
  clock: Clock,
  scheduler: Scheduler,
): unknown {
  const params = isObject(req.params) ? req.params : {};

  // Malformed: no goal or no roles.
  if (typeof params.goal !== "string" || !params.goal) {
    throw new HolpRpcError(invalidRequest("orchestrate.run: params.goal (string) required"));
  }
  if (!isObject(params.roles)) {
    throw new HolpRpcError(invalidRequest("orchestrate.run: params.roles (object) required"));
  }

  const goal = params.goal;
  const trigger = typeof params.trigger === "string" ? params.trigger : "manual";
  const roles = params.roles as Record<string, unknown>;
  const consensusPolicy = parseConsensusPolicy(params.policy);
  const workflowId = parseWorkflowParam(params.workflow);
  const maxSteps = parseMaxStepsParam(params.max_steps);
  const plannerRequest = parsePlannerRequest(params.planner);

  if (roles.work_planner !== undefined) {
    throw new HolpRpcError(
      holpError(
        "role_unsupported",
        "work_planner is planner-only and cannot be used as an executor role",
        { role: "work_planner" },
      ),
    );
  }

  // Collect all agent ids referenced.
  const agentRefs: Array<{
    agentId: string;
    role: string;
    isPanel: boolean;
    runtimeSurfaceValue: unknown;
    runtimeSurfacePath: string;
  }> = [];

  // Collect non-reviewer single-agent roles.
  for (const [roleName, roleSpec] of Object.entries(roles)) {
    if (roleName === "reviewer") continue;
    if (!isObject(roleSpec)) continue;
    if (typeof roleSpec.agent === "string") {
      agentRefs.push({
        agentId: roleSpec.agent,
        role: roleName,
        isPanel: false,
        runtimeSurfaceValue: (roleSpec as Record<string, unknown>).preferred_runtime_surface,
        runtimeSurfacePath: `roles.${roleName}.preferred_runtime_surface`,
      });
    }
  }

  // Collect reviewer panel.
  let reviewerPanel: string[] = [];
  let quorum = 0;
  let reviewerRuntimeSurfaceValue: unknown;
  if (isObject(roles.reviewer)) {
    const rv = roles.reviewer as Record<string, unknown>;
    reviewerRuntimeSurfaceValue = rv.preferred_runtime_surface;
    if (Array.isArray(rv.panel)) {
      reviewerPanel = (rv.panel as unknown[]).filter((x) => typeof x === "string") as string[];
      quorum = typeof rv.quorum === "number" ? rv.quorum : 0;
    }
    for (const agentId of reviewerPanel) {
      agentRefs.push({
        agentId,
        role: "reviewer",
        isPanel: true,
        runtimeSurfaceValue: reviewerRuntimeSurfaceValue,
        runtimeSurfacePath: "roles.reviewer.preferred_runtime_surface",
      });
    }
  }

  // --- Validation step 1: agent_not_found ---
  for (const ref of agentRefs) {
    if (!ctx.flock.has(ref.agentId)) {
      throw new HolpRpcError(
        holpError("agent_not_found", `agent '${ref.agentId}' not in this connection's flock`, {
          agent_id: ref.agentId,
        }),
      );
    }
  }
  if (plannerRequest.agent && !ctx.flock.has(plannerRequest.agent)) {
    throw new HolpRpcError(
      holpError("agent_not_found", `planner agent '${plannerRequest.agent}' not in this connection's flock`, {
        agent_id: plannerRequest.agent,
      }),
    );
  }
  if (plannerRequest.agent) {
    const plannerAgent = ctx.flock.get(plannerRequest.agent) as FlockAgent;
    if (
      plannerAgent.transport !== "learned-router" ||
      !plannerAgent.resolved_roles.includes("work_planner")
    ) {
      throw new HolpRpcError(
        holpError(
          "role_unsupported",
          `agent '${plannerRequest.agent}' does not have planner-only role 'work_planner'`,
          {
            agent_id: plannerRequest.agent,
            role: "work_planner",
            resolved_roles: plannerAgent.resolved_roles,
          },
        ),
      );
    }
  }

  // --- Validation step 2: role_unsupported (+ unsupported_transport for rejected) ---
  // Single-point roles first.
  // Per spec §4.2 / §10.1: a known-but-rejected agent in a single-point role yields
  // unsupported_transport (-32005), NOT role_unsupported. Rejected agents have
  // resolved_roles:[] so we must check status BEFORE the resolved_roles check.
  for (const ref of agentRefs) {
    if (ref.isPanel) continue;
    const agent = ctx.flock.get(ref.agentId) as FlockAgent;
    if (agent.transport === "learned-router" || agent.resolved_roles.includes("work_planner")) {
      throw new HolpRpcError(
        holpError(
          "role_unsupported",
          `agent '${ref.agentId}' is planner-only and cannot be used as '${ref.role}'`,
          { agent_id: ref.agentId, role: ref.role, resolved_roles: agent.resolved_roles },
        ),
      );
    }
    if (agent.status === "rejected") {
      throw new HolpRpcError(
        holpError(
          "unsupported_transport",
          `agent '${ref.agentId}' was rejected (transport unavailable) and cannot be used as '${ref.role}'`,
          { agent_id: ref.agentId, transport: agent.transport, reason: agent.reason },
        ),
      );
    }
    if (!agent.resolved_roles.includes(ref.role)) {
      throw new HolpRpcError(
        holpError(
          "role_unsupported",
          `agent '${ref.agentId}' does not have role '${ref.role}' in resolved_roles`,
          { agent_id: ref.agentId, role: ref.role, resolved_roles: agent.resolved_roles },
        ),
      );
    }
  }

  // --- Validation step 2b / step 3: reviewer panel checks ---
  // Per spec §6.2 and §10.1, the fine-grained order for panel members is:
  //   (a) rejected-in-panel → invalid_quorum (spec §10.1: "reviewer panel 含 rejected agent
  //       不走这里，走 §6.2 的 invalid_quorum"). This check MUST precede role_unsupported
  //       because rejected agents have resolved_roles:[] and would otherwise fire role_unsupported.
  //   (b) role_unsupported: non-rejected agent whose resolved_roles lacks 'reviewer'.
  //   (c) quorum shape (<=0 / >panel size) → invalid_quorum. This comes AFTER role_unsupported
  //       per spec §6.2 ordering (role check = step 2; shape check = step 3).
  if (reviewerPanel.length > 0) {
    // (a) Rejected agents in panel → invalid_quorum before role check.
    for (const agentId of reviewerPanel) {
      const agent = ctx.flock.get(agentId) as FlockAgent;
      if (agent.status === "rejected") {
        throw new HolpRpcError(
          holpError("invalid_quorum", `reviewer panel contains rejected agent '${agentId}'`, {
            agent_id: agentId,
          }),
        );
      }
    }
  }

  // (b) Reviewer panel role check (non-rejected agents — rejected already caught above).
  for (const agentId of reviewerPanel) {
    const agent = ctx.flock.get(agentId) as FlockAgent;
    if (agent.transport === "learned-router" || agent.resolved_roles.includes("work_planner")) {
      throw new HolpRpcError(
        holpError(
          "role_unsupported",
          `agent '${agentId}' is planner-only and cannot be used as 'reviewer'`,
          { agent_id: agentId, role: "reviewer", resolved_roles: agent.resolved_roles },
        ),
      );
    }
    if (!agent.resolved_roles.includes("reviewer")) {
      throw new HolpRpcError(
        holpError(
          "role_unsupported",
          `agent '${agentId}' does not have role 'reviewer' in resolved_roles`,
          { agent_id: agentId, role: "reviewer", resolved_roles: agent.resolved_roles },
        ),
      );
    }
  }

  // (c) Quorum shape checks (after role checks, per §6.2 ordering).
  if (reviewerPanel.length > 0) {
    if (new Set(reviewerPanel).size !== reviewerPanel.length) {
      throw new HolpRpcError(
        holpError("invalid_quorum", "reviewer panel contains duplicate agent ids", {
          panel: reviewerPanel,
        }),
      );
    }
    if (quorum <= 0) {
      throw new HolpRpcError(holpError("invalid_quorum", "quorum must be > 0"));
    }
    if (quorum > reviewerPanel.length) {
      throw new HolpRpcError(holpError("invalid_quorum", "quorum > panel size"));
    }
  }

  // --- Validation step 4: quorum_unsatisfiable ---
  if (reviewerPanel.length > 0) {
    // Count reviewer-capable agents (resolved_roles includes reviewer, not rejected).
    const reviewerCapable = reviewerPanel.filter((id) => {
      const a = ctx.flock.get(id) as FlockAgent;
      return a.status !== "rejected" && a.resolved_roles.includes("reviewer");
    });
    if (reviewerCapable.length < quorum) {
      throw new HolpRpcError(
        holpError(
          "quorum_unsatisfiable",
          `only ${reviewerCapable.length} reviewer-capable agents but quorum=${quorum}`,
          { available: reviewerCapable.length, quorum },
        ),
      );
    }
  }

  // --- Validation step 5: unsupported_execution_mode ---
  const execMode = isObject(params.execution_mode) ? params.execution_mode : {};
  if (
    params.execution_mode !== undefined &&
    (execMode as Record<string, unknown>).kind !== "Local"
  ) {
    throw new HolpRpcError(
      holpError(
        "unsupported_execution_mode",
        `execution_mode.kind must be "Local", got "${String((execMode as Record<string, unknown>).kind)}"`,
        { kind: (execMode as Record<string, unknown>).kind },
      ),
    );
  }

  // --- Validation step 6: approval_required_but_unsupported ---
  // Current run path may trigger provider permission requests; per §7 the daemon must
  // reject at accept-time if the client did not negotiate approval support.
  // Generic gate/policy-driven approval detection is M4.
  // This check is LAST in accept-time order (after agent_not_found, role_unsupported,
  // invalid_quorum, quorum_unsatisfiable, unsupported_execution_mode) so it never
  // masks an earlier-stage error.
  if (ctx.initialized?.negotiated.approval.supported !== true) {
    throw new HolpRpcError(
      holpError(
        "approval_required_but_unsupported",
        "this run requires merge_approval but the client did not negotiate approval.supported:true",
      ),
    );
  }

  // --- Validation step 7: runtime surface + isolation profile readiness ---
  // This is intentionally appended after the existing accept-time gates so it
  // cannot mask the long-standing M1/M2 error ordering. It resolves declaration
  // metadata only; backend runtime isolation enforcement is deferred.
  const runtimeSelections = new Map<string, RuntimeSelectionMetadata>();
  let reviewerRuntimeSelections: ConsensusReviewerSelection[] = [];
  for (const ref of agentRefs) {
    if (ref.isPanel) continue;
    const agent = ctx.flock.get(ref.agentId) as FlockAgent;
    const runtimeSurface = parsePreferredRuntimeSurface(
      ref.runtimeSurfaceValue,
      ref.runtimeSurfacePath,
    );
    const selection = resolveRuntimeSelection(agent, ref.role, runtimeSurface);
    runtimeSelections.set(runtimeKey(ref.agentId, ref.role), selection);
  }
  if (reviewerPanel.length > 0) {
    const reviewerRuntimeSurface = parsePreferredRuntimeSurface(
      reviewerRuntimeSurfaceValue,
      "roles.reviewer.preferred_runtime_surface",
    );
    const reviewerSelections: Array<{
      agentId: string;
      selection: RuntimeSelectionMetadata;
    }> = [];
    const rejectedReviewers: Array<{
      agent_id: string;
      reason: string;
      missing?: readonly string[];
      warnings?: readonly string[];
    }> = [];

    for (const agentId of reviewerPanel) {
      const agent = ctx.flock.get(agentId) as FlockAgent;
      try {
        const selection = resolveRuntimeSelection(agent, "reviewer", reviewerRuntimeSurface);
        if (selection.global_mutation_required) {
          throw isolationError(
            agent,
            "reviewer",
            reviewerRuntimeSurface,
            "read_only_review",
            {
              reason: "global_mutation_required_for_read_only_review",
              missing: ["global_mutation_required:false"],
            },
          );
        }
        reviewerSelections.push({ agentId, selection });
      } catch (error) {
        rejectedReviewers.push(isolationFailureForPanel(agentId, error));
      }
    }

    if (reviewerSelections.length < quorum) {
      throw new HolpRpcError(
        holpError(
          "isolation_profile_rejected",
          `only ${reviewerSelections.length} reviewer agents satisfy read_only_review but quorum=${quorum}`,
          {
            role: "reviewer",
            runtime_surface: reviewerRuntimeSurface,
            isolation_profile: "read_only_review",
            available: reviewerSelections.length,
            quorum,
            rejected_agents: rejectedReviewers,
          },
        ),
      );
    }

    for (const reviewer of reviewerSelections) {
      runtimeSelections.set(runtimeKey(reviewer.agentId, "reviewer"), reviewer.selection);
    }
    reviewerRuntimeSelections = reviewerSelections.map((reviewer) => ({
      agent_id: reviewer.agentId,
      runtime: reviewer.selection,
    }));
  }

  // --- Determine coder agent (required for the current single-backend run) ---
  let coderAgentId: string | undefined;
  const coderRoleSpec = isObject(roles.coder) ? roles.coder as Record<string, unknown> : {};
  const coderRuntimeSurface = parsePreferredRuntimeSurface(
    coderRoleSpec.preferred_runtime_surface,
    "roles.coder.preferred_runtime_surface",
  );
  if (isObject(roles.coder) && typeof (roles.coder as Record<string, unknown>).agent === "string") {
    coderAgentId = (roles.coder as Record<string, unknown>).agent as string;
  }

  // We need a coder agent for the run engine.
  // If none specified, pick the first non-reviewer role agent, or any ready agent.
  if (!coderAgentId) {
    // Fallback: find any ready agent in the flock.
    for (const [id, agent] of ctx.flock) {
      if (
        agent.status === "ready" &&
        agent.resolved_roles.includes("coder") &&
        canSelectRuntime(agent, "coder", coderRuntimeSurface)
      ) {
        coderAgentId = id;
        break;
      }
    }
  }

  if (!coderAgentId) {
    throw new HolpRpcError(
      holpError(
        "unsupported_transport",
        "no ready coder agent available; declare a ready coder transport agent first",
      ),
    );
  }

  const coderAgent = ctx.flock.get(coderAgentId) as FlockAgent;
  const coderRuntime = runtimeSelections.get(runtimeKey(coderAgentId, "coder")) ??
    resolveRuntimeSelection(coderAgent, "coder", coderRuntimeSurface);
  const factory = registry.resolve(coderAgent.transport, coderRuntime.runtime_surface);
  if (!factory) {
    throw new HolpRpcError(
      holpError(
        "unsupported_transport",
        `no adapter for transport '${coderAgent.transport}' runtime surface '${coderRuntime.runtime_surface}'`,
        { transport: coderAgent.transport, runtime_surface: coderRuntime.runtime_surface },
      ),
    );
  }

  // --- Create run record ---
  const runId = nextRunId();
  const bus = new EventBus(runId, clock, (recordRunId, event) => {
    ctx.governance.recordEvent(recordRunId, event);
  });
  ctx.governance.ensureRunState(runId, "queued", clock.now());

  const run: RunRecord = {
    run_id: runId,
    goal,
    trigger,
    status: "active",
    bus,
    runtime: coderRuntime,
    ...(reviewerPanel.length > 0
      ? {
          consensus: {
            panel: reviewerRuntimeSelections,
            quorum,
            policy: consensusPolicy,
            producer_agent_id: coderAgentId,
          },
          reviewerExecutor: createReviewerExecutor(
            reviewerRuntimeSelections.map((reviewer) =>
              reviewerExecutionConfig(ctx.flock.get(reviewer.agent_id) as FlockAgent, reviewer.runtime)
            ),
          ),
        }
      : {}),
    pendingApprovals: new Set(),
    approvalSeq: 0,
  };
  ctx.runs.set(runId, run);
  ctx.governance.transitionRun(runId, "running", clock.now(), "run_accepted");
  ctx.governance.recordDecision({
    decision_type: "run_accepted",
    run_id: runId,
    agent_id: coderAgentId,
    reason: "orchestrate.run accepted",
    ts: clock.now(),
    data: { trigger, goal },
  });
  ctx.governance.recordDecision({
    decision_type: "runtime_selected",
    run_id: runId,
    agent_id: coderAgentId,
    reason: "coder runtime selected",
    ts: clock.now(),
    data: coderRuntime,
  });

  if (maxSteps > 1) {
    const plannerMode = effectivePlannerMode(plannerRequest, runId);
    if (plannerRequest.mode === "canary" && plannerMode === "rule") {
      ctx.governance.recordDecision({
        decision_type: "learned_router_active_fallback",
        run_id: runId,
        reason: "canary_lane_not_selected",
        ts: clock.now(),
        data: { planner: plannerRequest, effective_mode: plannerMode },
      });
    }
    const candidates = buildDispatchCandidates(
      coderAgent,
      coderRuntime,
      reviewerRuntimeSelections,
      ctx,
    );
    void driveWorkflowRun(
      run,
      {
        workflowId,
        maxSteps,
        planner: new RuleWorkPlanner(),
        plannerMode,
        learnedPlanner: plannerMode === "rule"
          ? undefined
          : new FixtureLearnedWorkPlanner("fixture-learned-router-v1", learnedBuffer(plannerMode)),
        plannerEvidenceId: plannerRequest.evidence_id,
        candidates,
        coder: {
          agent_id: coderAgentId,
          transport: coderAgent.transport,
          runtime: coderRuntime,
          factory,
        },
        reviewerPanelPresent: reviewerPanel.length > 0,
        reviewerQuorum: reviewerPanel.length > 0 ? quorum : undefined,
      },
      ctx,
      clock,
      scheduler,
    );

    return { run_id: runId, accepted: true };
  }

  // --- Create backend and wire it ---
  const backend = factory({
    cwd: process.cwd(),
    permissionHandler: async (toolName: string, input: unknown) => {
      // The permissionHandler creates an approval record, emits approval_requested,
      // and returns a PENDING Promise. The backend awaits it (genuinely paused).
      // Resolved by approval.resolve calling resumeBackend(decision).
      return new Promise((resolveVerdict) => {
        run.approvalSeq += 1;
        const approvalId = `ap_${runId}_${clock.now()}_${run.approvalSeq}`;
        const expiresAt = clock.now() + 300;

        const resumeBackend = (decision: "allow" | "deny"): void => {
          resolveVerdict(
            decision === "allow"
              ? { decision: "allow" as const, reason: "user_decision" }
              : { decision: "deny" as const, reason: "user_rejected" },
          );
        };

        const approvalRecord: ApprovalRecord = {
          approval_id: approvalId,
          run_id: runId,
          kind: "merge_approval",
          reason: `${toolName} requires human approval`,
          expires_at: expiresAt,
          state: "pending",
          resumeBackend,
        };
        approvalRecord.expiryTimer = scheduler.schedule(expiresAt - clock.now(), () => {
          expireApproval(ctx, approvalId, clock);
        });
        ctx.approvals.set(approvalId, approvalRecord);
        run.pendingApprovals.add(approvalId);
        ctx.governance.transitionRun(runId, "waiting_approval", clock.now(), "approval_requested");
        ctx.governance.recordDecision({
          decision_type: "approval_requested",
          run_id: runId,
          agent_id: coderAgentId,
          approval_id: approvalId,
          reason: `${toolName} requires human approval`,
          ts: clock.now(),
          data: { kind: "merge_approval", tool: toolName },
        });

        bus.publish("approval", "approval_requested", {
          approval_id: approvalId,
          kind: "merge_approval",
          reason: `${toolName} requires human approval`,
          expires_at: expiresAt,
          provenance: { step_id: "step_coder", artifact_id: null },
          details: evidencePayload({
            ctx,
            clock,
            artifactId: `art_approval_${approvalId}_details`,
            type: "approval_details",
            content: JSON.stringify({ tool: toolName, input }),
            createdBy: "holp-reference-daemon",
          }),
        });
        // Promise is NOT resolved here — the backend awaits until approval.resolve is called.
      });
    },
  });
  run.backend = backend;

  // --- Kick off the run asynchronously ---
  // Fire-and-forget; backend.dispose in driveRun handles spawned adapter processes when the turn ends.
  void driveRun(run, backend, ctx, clock, scheduler);

  return { run_id: runId, accepted: true };
}

function parseWorkflowParam(value: unknown) {
  try {
    return parseWorkflowId(value);
  } catch (error) {
    throw new HolpRpcError(
      invalidRequest(error instanceof Error ? error.message : String(error)),
    );
  }
}

function parseMaxStepsParam(value: unknown): number {
  try {
    return parseMaxSteps(value);
  } catch (error) {
    throw new HolpRpcError(
      invalidRequest(error instanceof Error ? error.message : String(error)),
    );
  }
}

interface PlannerRequest {
  readonly mode: PlannerModeV1;
  readonly agent?: string;
  readonly evidence_id?: string;
  readonly canary?: {
    readonly seed: string;
    readonly ratio: number;
    readonly allowlist?: readonly string[];
  };
}

function parsePlannerRequest(value: unknown): PlannerRequest {
  if (value === undefined) return { mode: "rule" };
  if (!isObject(value)) {
    throw new HolpRpcError(invalidRequest("orchestrate.run.planner must be an object"));
  }
  const mode = value.mode;
  if (!isPlannerMode(mode)) {
    throw new HolpRpcError(
      invalidRequest("orchestrate.run.planner.mode must be rule, learned_shadow, learned_active, or canary"),
    );
  }
  let canary: PlannerRequest["canary"];
  if (value.canary !== undefined) {
    if (!isObject(value.canary)) {
      throw new HolpRpcError(invalidRequest("orchestrate.run.planner.canary must be an object"));
    }
    if (value.canary.seed !== undefined && typeof value.canary.seed !== "string") {
      throw new HolpRpcError(invalidRequest("orchestrate.run.planner.canary.seed must be a string"));
    }
    if (value.canary.ratio !== undefined && typeof value.canary.ratio !== "number") {
      throw new HolpRpcError(invalidRequest("orchestrate.run.planner.canary.ratio must be a number"));
    }
    if (
      value.canary.allowlist !== undefined &&
      (!Array.isArray(value.canary.allowlist) ||
        !value.canary.allowlist.every((item) => typeof item === "string"))
    ) {
      throw new HolpRpcError(invalidRequest("orchestrate.run.planner.canary.allowlist must be string[]"));
    }
    canary = {
      seed: value.canary.seed ?? "holp-canary-v1",
      ratio: value.canary.ratio ?? 0,
      allowlist: value.canary.allowlist,
    };
  }
  if (canary && (canary.ratio < 0 || canary.ratio > 1)) {
    throw new HolpRpcError(invalidRequest("orchestrate.run.planner.canary.ratio must be between 0 and 1"));
  }
  return {
    mode,
    agent: typeof value.agent === "string" ? value.agent : undefined,
    evidence_id: typeof value.evidence_id === "string" ? value.evidence_id : undefined,
    canary,
  };
}

function isPlannerMode(value: unknown): value is PlannerModeV1 {
  return value === "rule" ||
    value === "learned_shadow" ||
    value === "learned_active" ||
    value === "canary";
}

function effectivePlannerMode(request: PlannerRequest, runId: string): PlannerModeV1 {
  if (request.mode !== "canary") return request.mode;
  const canary = request.canary ?? { seed: "holp-canary-v1", ratio: 0 };
  return canarySelected({
    runId,
    seed: canary.seed,
    ratio: canary.ratio,
    allowlist: canary.allowlist,
  })
    ? "canary"
    : "rule";
}

function learnedBuffer(mode: PlannerModeV1): "shadow" | "active" | "canary" {
  if (mode === "canary") return "canary";
  return mode === "learned_active" ? "active" : "shadow";
}

function parsePreferredRuntimeSurface(value: unknown, path: string): RuntimeSurface {
  if (value === undefined) return "headless";
  if (isRuntimeSurface(value)) return value;
  throw new HolpRpcError(
    invalidRequest(`${path} must be one of: headless, acp, direct_user_session`, {
      field: path,
      value,
    }),
  );
}

function isRuntimeSurface(value: unknown): value is RuntimeSurface {
  return value === "headless" || value === "acp" || value === "direct_user_session";
}

function buildDispatchCandidates(
  coderAgent: FlockAgent,
  coderRuntime: RuntimeSelectionMetadata,
  reviewerRuntimeSelections: readonly ConsensusReviewerSelection[],
  ctx: ConnectionContext,
): readonly DispatchCandidateV1[] {
  const candidates: DispatchCandidateV1[] = [
    {
      agent_id: coderAgent.id,
      role: "coder",
      transport: coderAgent.transport,
      status: coderAgent.status,
      runtime: coderRuntime,
    },
  ];

  for (const reviewer of reviewerRuntimeSelections) {
    const agent = ctx.flock.get(reviewer.agent_id);
    if (!agent) continue;
    candidates.push({
      agent_id: agent.id,
      role: "reviewer",
      transport: agent.transport,
      status: agent.status,
      runtime: reviewer.runtime,
    });
  }

  return candidates;
}

function reviewerExecutionConfig(
  agent: FlockAgent,
  runtime: RuntimeSelectionMetadata | undefined,
): ReviewerAgentExecutionConfig {
  if (agent.transport === "fake") {
    return {
      agent_id: agent.id,
      transport: agent.transport,
      mode: "fake",
      runtime,
    };
  }

  if (agent.transport === "mcp-codex") {
    return {
      agent_id: agent.id,
      transport: agent.transport,
      mode: "backend",
      runtime,
      backendFactory: createCodexAppServerBackendFactory({ sandbox: "read-only" }),
      sandbox: "read-only",
    };
  }

  if (agent.transport === "native-claude") {
    return {
      agent_id: agent.id,
      transport: agent.transport,
      mode: "backend",
      runtime,
      backendFactory: createClaudeCodeBackendFactory(),
      sandbox: "read-only",
    };
  }

  if (isFirstBatchTransport(agent.transport) && runtime?.runtime_surface === "headless") {
    const backendFactory = firstBatchHeadlessFactoryForTransport(agent.transport);
    if (backendFactory) {
      return {
        agent_id: agent.id,
        transport: agent.transport,
        mode: "backend",
        runtime,
        backendFactory,
        sandbox: "read-only",
      };
    }
  }

  if (
    runtime?.isolation_profile === "read_only_review" &&
    runtime.isolation_status === "ready"
  ) {
    throw new HolpRpcError(
      holpError(
        "unsupported_transport",
        `reviewer transport '${agent.transport}' declares read_only_review ready but has no reviewer executor`,
        {
          agent_id: agent.id,
          transport: agent.transport,
          runtime_surface: runtime.runtime_surface,
          reason: "reviewer_execution_config_missing",
        },
      ),
    );
  }

  return {
    agent_id: agent.id,
    transport: agent.transport,
    mode: "unsupported",
    runtime,
    reason: `real_reviewer_transport_not_wired:${agent.transport}`,
  };
}

function runtimeKey(agentId: string, role: string): string {
  return `${agentId}:${role}`;
}

function parseConsensusPolicy(value: unknown): ConsensusPolicy {
  const policy = isObject(value) ? value : {};
  const authorProvenance = policy.author_provenance;
  const onQuorumUnsatisfiable = policy.on_quorum_unsatisfiable;
  const onConsensusBlocking = policy.on_consensus_blocking;

  return {
    exclude_author: policy.exclude_author !== false,
    author_provenance: isAuthorProvenance(authorProvenance)
      ? authorProvenance
      : "produced_by_agent_id",
    on_quorum_unsatisfiable: isOnQuorumUnsatisfiable(onQuorumUnsatisfiable)
      ? onQuorumUnsatisfiable
      : "reject",
    on_consensus_blocking: isOnConsensusBlocking(onConsensusBlocking)
      ? onConsensusBlocking
      : "reject",
  };
}

function isAuthorProvenance(value: unknown): value is AuthorProvenance {
  return value === "produced_by_agent_id" || value === "commit_author" || value === "run_initiator";
}

function isOnQuorumUnsatisfiable(value: unknown): value is OnQuorumUnsatisfiable {
  return value === "ask_human" || value === "reject" || value === "degrade_quorum";
}

function isOnConsensusBlocking(value: unknown): value is OnConsensusBlocking {
  return value === "ask_human" || value === "reject";
}

function defaultIsolationProfileForRole(role: string): IsolationProfile {
  return role === "coder" ? "coder_worktree" : "read_only_review";
}

function canSelectRuntime(
  agent: FlockAgent,
  role: string,
  runtimeSurface: RuntimeSurface = "headless",
): boolean {
  try {
    resolveRuntimeSelection(agent, role, runtimeSurface);
    return true;
  } catch {
    return false;
  }
}

function resolveRuntimeSelection(
  agent: FlockAgent,
  role: string,
  runtimeSurface: RuntimeSurface,
): RuntimeSelectionMetadata {
  const isolationProfile = defaultIsolationProfileForRole(role);
  const resolved = findRuntimeProfile(agent.runtime_surfaces, runtimeSurface, isolationProfile);

  if (!resolved) {
    throw isolationError(agent, role, runtimeSurface, isolationProfile, {
      reason: "isolation_declaration_missing",
      missing: [`runtime_surface:${runtimeSurface}`, `isolation_profile:${isolationProfile}`],
    });
  }

  if (resolved.profile.readiness !== "ready") {
    throw isolationError(agent, role, runtimeSurface, isolationProfile, {
      reason: resolved.profile.reason ?? "isolation_profile_rejected",
      missing: resolved.profile.missing,
      warnings: resolved.profile.warnings,
    });
  }

  return runtimeSelectionFromDeclaration({
    agentId: agent.id,
    transport: agent.transport,
    runtimeSurface,
    isolationProfile,
    declaration: resolved.surface,
    profile: resolved.profile,
  });
}

function isolationError(
  agent: FlockAgent,
  role: string,
  runtimeSurface: RuntimeSurface,
  isolationProfile: IsolationProfile,
  detail: {
    reason: string;
    missing?: readonly string[];
    warnings?: readonly string[];
  },
): HolpRpcError {
  return new HolpRpcError(
    holpError(
      "isolation_profile_rejected",
      `agent '${agent.id}' cannot satisfy ${isolationProfile} for role '${role}'`,
      {
        agent_id: agent.id,
        role,
        transport: agent.transport,
        runtime_surface: runtimeSurface,
        isolation_profile: isolationProfile,
        reason: detail.reason,
        missing: detail.missing,
        warnings: detail.warnings,
      },
    ),
  );
}

function isolationFailureForPanel(
  agentId: string,
  error: unknown,
): {
  agent_id: string;
  reason: string;
  missing?: readonly string[];
  warnings?: readonly string[];
} {
  if (error instanceof HolpRpcError) {
    const data = error.rpc.data;
    if (isObject(data)) {
      return {
        agent_id: agentId,
        reason: typeof data.reason === "string" ? data.reason : error.rpc.message,
        missing: Array.isArray(data.missing) ? data.missing.map(String) : undefined,
        warnings: Array.isArray(data.warnings) ? data.warnings.map(String) : undefined,
      };
    }
    return { agent_id: agentId, reason: error.rpc.message };
  }
  return {
    agent_id: agentId,
    reason: error instanceof Error ? error.message : "isolation_profile_rejected",
  };
}
