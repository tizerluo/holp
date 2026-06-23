import { describe, expect, it } from "vitest";
import type {
  AgentBackend,
  AgentBackendFactory,
  AgentMessageHandler,
} from "../../adapters/agent-backend.js";
import type { RuntimeSelectionMetadata } from "../../adapters/harness-declaration.js";
import { FakeClock } from "./clock.js";
import { ConnectionContext } from "./context.js";
import { EventBus } from "./eventBus.js";
import { FakeScheduler } from "./scheduler.js";
import type { RunRecord } from "./stores.js";
import { driveWorkflowRun } from "./workflowEngine.js";
import {
  RuleWorkPlanner,
  type DispatchCandidateV1,
  type DispatchStateV1,
  type LearnedPlannerDecisionV1,
  type LearnedWorkPlanner,
  type WorkPlanV1,
} from "./workPlanner.js";

describe("driveWorkflowRun learned router revisions", () => {
  it("gates workflow revision events on dynamic_workflow capability", async () => {
    const disabled = await driveWithPlanner({
      dynamicWorkflow: false,
      learnedPlanner: invalidRevisionPlanner("rev_no_event"),
    });
    expect(disabled.run.bus.allEvents().some((event) =>
      event.name === "workflow_revision_rejected"
    )).toBe(false);
    expect(disabled.ctx.governance.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        decision_type: "workflow_revision_rejected",
        reason: "hard_constraint_violation",
      }),
    ]));

    const enabled = await driveWithPlanner({
      dynamicWorkflow: true,
      learnedPlanner: invalidRevisionPlanner("rev_event"),
    });
    expect(enabled.run.bus.allEvents().some((event) =>
      event.name === "workflow_revision_rejected"
    )).toBe(true);
  });

  it("does not republish duplicate revision rejections already recorded in governance", async () => {
    const result = await driveWithPlanner({
      dynamicWorkflow: true,
      learnedPlanner: invalidRevisionPlanner("rev_duplicate"),
      seedDuplicateRejection: "rev_duplicate",
    });

    expect(result.ctx.governance.decisions.filter((decision) =>
      decision.decision_type === "workflow_revision_rejected"
    )).toHaveLength(1);
    expect(result.run.bus.allEvents().some((event) =>
      event.name === "workflow_revision_rejected"
    )).toBe(false);
  });

  it("falls back from active learned plans that violate hard constraints", async () => {
    const result = await driveWithPlanner({
      dynamicWorkflow: true,
      learnedPlanner: invalidActivePlanPlanner(),
    });

    expect(result.run.planner_backing).toBe("real_learned_model");
    expect(result.ctx.governance.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        decision_type: "learned_router_active_fallback",
        reason: "hard_constraint_violation",
      }),
    ]));
    expect(result.ctx.governance.decisions.some((decision) =>
      decision.decision_type === "learned_router_active_selected"
    )).toBe(false);
    expect(result.run.step_history?.[0]?.action).toMatchObject({
      kind: "step",
      action: "implement",
      agent_id: "coder",
    });
  });
});

async function driveWithPlanner(args: {
  readonly dynamicWorkflow: boolean;
  readonly learnedPlanner: LearnedWorkPlanner;
  readonly seedDuplicateRejection?: string;
}): Promise<{ readonly ctx: ConnectionContext; readonly run: RunRecord }> {
  const ctx = new ConnectionContext();
  const clock = new FakeClock();
  const scheduler = new FakeScheduler();
  const runId = `run_${args.dynamicWorkflow ? "dynamic" : "static"}_${args.seedDuplicateRejection ?? "new"}`;
  ctx.initialized = {
    protocolVersion: "0.1.8",
    clientName: "workflow-engine-test",
    clientVersion: "0",
    negotiated: {
      consensus: { supported: true },
      approval: { supported: true, kinds: ["merge_approval"] },
      unattended_loop: { supported: false },
      artifact_refs: { supported: false },
      gate_report: { supported: false },
      dynamic_workflow: { supported: args.dynamicWorkflow },
    },
  };
  if (args.seedDuplicateRejection) {
    ctx.governance.recordDecision({
      decision_type: "workflow_revision_rejected",
      run_id: runId,
      reason: "hard_constraint_violation",
      ts: clock.now(),
      data: { revision: { revision_id: args.seedDuplicateRejection } },
    });
  }

  const run: RunRecord = {
    run_id: runId,
    goal: "ship it",
    trigger: "manual",
    status: "active",
    bus: new EventBus(runId, clock, (id, event) => ctx.governance.recordEvent(id, event)),
    pendingApprovals: new Set(),
    approvalSeq: 0,
  };
  await driveWorkflowRun(run, {
    workflowId: "linear",
    maxSteps: 1,
    planner: new RuleWorkPlanner(),
    plannerMode: "learned_active",
    learnedPlanner: args.learnedPlanner,
    candidates: [candidate("coder", "coder", "coder_worktree")],
    coder: {
      agent_id: "coder",
      transport: "fake",
      runtime: runtime("coder", "coder_worktree"),
      factory: noApprovalBackendFactory(),
    },
    reviewerPanelPresent: false,
  }, ctx, clock, scheduler);
  return { ctx, run };
}

function invalidRevisionPlanner(revisionId: string): LearnedWorkPlanner {
  return {
    predict(state: DispatchStateV1): LearnedPlannerDecisionV1 {
      return {
        version: "LearnedPlannerDecision.v1",
        decision_type: "learned_router_prediction",
        planner_version: "test-learned-router",
        backing: "real_learned_model",
        buffer: "active",
        output: {
          version: "WorkflowRevision.v1",
          revision_id: revisionId,
          base_cursor: state.step_index,
          pending_graph: {
            version: "WorkflowGraph.v1",
            cursor: state.step_index + 1,
            steps: [],
          },
        },
      };
    },
  };
}

function invalidActivePlanPlanner(): LearnedWorkPlanner {
  return {
    predict(): LearnedPlannerDecisionV1 {
      return {
        version: "LearnedPlannerDecision.v1",
        decision_type: "learned_router_prediction",
        planner_version: "test-learned-router",
        backing: "real_learned_model",
        buffer: "active",
        output: {
          version: "WorkPlan.v1",
          kind: "step",
          action: "review",
          agent_id: "coder",
          role: "coder",
        } satisfies WorkPlanV1,
      };
    },
  };
}

function candidate(
  agent_id: string,
  role: string,
  isolation_profile: "coder_worktree" | "read_only_review",
): DispatchCandidateV1 {
  return {
    agent_id,
    role,
    transport: "fake",
    status: "ready",
    runtime: runtime(agent_id, isolation_profile),
  };
}

function runtime(
  agent_id: string,
  isolation_profile: "coder_worktree" | "read_only_review",
): RuntimeSelectionMetadata {
  return {
    agent_id,
    transport: "fake",
    runtime_surface: "headless",
    runtime_kind: "fake",
    actual_fidelity: "streaming_controlled",
    isolation_profile,
    isolation_status: "ready",
    global_mutation_required: false,
    declared_not_enforced: true,
  };
}

function noApprovalBackendFactory(): AgentBackendFactory {
  return () => {
    let handlers: AgentMessageHandler[] = [];
    const backend: AgentBackend = {
      onMessage(handler): void {
        handlers.push(handler);
      },
      offMessage(handler): void {
        handlers = handlers.filter((item) => item !== handler);
      },
      async startSession(): Promise<{ sessionId: string }> {
        return { sessionId: "no-approval-session" };
      },
      async sendPrompt(): Promise<void> {
        for (const handler of handlers) handler({ type: "status", status: "running" });
        for (const handler of handlers) {
          handler({
            type: "fs-edit",
            description: "test edit",
            diff: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n",
            path: "file.ts",
          });
        }
        for (const handler of handlers) handler({ type: "status", status: "idle" });
      },
      async resolvePermission(): Promise<void> {},
      async cancel(): Promise<void> {},
      async dispose(): Promise<void> {
        handlers = [];
      },
    };
    return backend;
  };
}
