import { describe, expect, it } from "vitest";
import { buildDispatcher } from "../runtime/server.js";
import { ConnectionContext } from "../core/context.js";
import { EventSink, type EventNotificationParams } from "../core/eventSink.js";
import { FakeClock } from "../core/clock.js";
import { FakeScheduler } from "../core/scheduler.js";
import { createFakeRegistry } from "../../adapters/registry.js";
import type { JsonRpcResponse } from "../runtime/jsonrpc.js";
import { exportTrainingSamplesJsonl } from "../core/trainingSamples.js";
import type { ReviewerExecutor } from "../core/reviewer.js";

function makeCollectingSink(): { sink: EventSink; events: EventNotificationParams[] } {
  const events: EventNotificationParams[] = [];
  const sink = new EventSink((frame) => {
    const f = frame as { method?: string; params?: unknown };
    if (f.method === "events.event" && f.params) {
      events.push(f.params as EventNotificationParams);
    }
  });
  return { sink, events };
}

function ok<T>(res: unknown): T {
  const response = res as JsonRpcResponse;
  if ("error" in response) throw new Error(response.error.message);
  return response.result as T;
}

function err(res: unknown): { code: number; message: string; data?: unknown } {
  const response = res as JsonRpcResponse;
  if ("result" in response) throw new Error(`Expected error: ${JSON.stringify(response.result)}`);
  return response.error;
}

async function pollUntil(pred: () => boolean, label = "pollUntil", maxTicks = 700): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (pred()) return;
    await Promise.resolve();
  }
  throw new Error(`${label}: predicate not satisfied`);
}

async function freshHarness(): Promise<{
  ctx: ConnectionContext;
  clock: FakeClock;
  scheduler: FakeScheduler;
  events: EventNotificationParams[];
  dispatch: (method: string, params: unknown) => Promise<unknown>;
}> {
  const ctx = new ConnectionContext();
  const clock = new FakeClock();
  const scheduler = new FakeScheduler();
  const { sink, events } = makeCollectingSink();
  const dispatcher = buildDispatcher(ctx, sink, createFakeRegistry(), clock, scheduler);
  let id = 1;
  const dispatch = async (method: string, params: unknown): Promise<unknown> =>
    dispatcher.dispatch({ jsonrpc: "2.0", id: id++, method, params });

  ok(await dispatch("initialize", {
    protocol_version: "0.1.4",
    client: { name: "m7-workflow", version: "0" },
    capabilities: {
      approval: { supported: true, kinds: ["merge_approval"] },
      consensus: { supported: true },
    },
  }));

  return { ctx, clock, scheduler, events, dispatch };
}

async function declareCoderAndReviewers(h: Awaited<ReturnType<typeof freshHarness>>): Promise<void> {
  ok(await h.dispatch("flock.declare", {
    agents: [
      { id: "coder", transport: "fake", roles: ["coder"] },
      { id: "r1", transport: "fake", roles: ["reviewer"] },
      { id: "r2", transport: "fake", roles: ["reviewer"] },
    ],
  }));
}

async function approveFirstMergeApproval(h: Awaited<ReturnType<typeof freshHarness>>): Promise<void> {
  await pollUntil(() => h.events.some((event) => event.name === "approval_requested"), "approval");
  const approval = h.events.find((event) => event.name === "approval_requested")!;
  const approvalId = (approval.payload as Record<string, unknown>).approval_id as string;
  ok(await h.dispatch("approval.resolve", {
    approval_id: approvalId,
    decision: "approved",
    by: "user:test",
  }));
}

async function rejectFirstMergeApproval(h: Awaited<ReturnType<typeof freshHarness>>): Promise<void> {
  await pollUntil(() => h.events.some((event) => event.name === "approval_requested"), "approval");
  const approval = h.events.find((event) => event.name === "approval_requested")!;
  const approvalId = (approval.payload as Record<string, unknown>).approval_id as string;
  ok(await h.dispatch("approval.resolve", {
    approval_id: approvalId,
    decision: "rejected",
    by: "user:test",
  }));
}

function terminalEvents(events: readonly EventNotificationParams[]): readonly EventNotificationParams[] {
  return events.filter((event) =>
    event.name === "run_merged" || event.name === "run_blocked" || event.name === "run_gave_up"
  );
}

function parseJsonl(jsonl: string): Array<Record<string, unknown>> {
  return jsonl.trim().length === 0
    ? []
    : jsonl.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("M7 workflow foundation loop", () => {
  it("rejects invalid max_steps values", async () => {
    const h = await freshHarness();
    ok(await h.dispatch("flock.declare", {
      agents: [{ id: "coder", transport: "fake", roles: ["coder"] }],
    }));

    for (const max_steps of [0, -1, 1.5, "2"]) {
      const error = err(await h.dispatch("orchestrate.run", {
        goal: "invalid max steps",
        max_steps,
        roles: { coder: { agent: "coder" } },
      }));
      expect(error.code).toBe(-32600);
      expect(error.message).toContain("max_steps");
    }
  });

  it("rejects invalid workflow values", async () => {
    const h = await freshHarness();

    for (const workflow of ["unknown", "plan-test-review", 2, null]) {
      const error = err(await h.dispatch("orchestrate.run", {
        goal: "invalid workflow",
        workflow,
        roles: {},
      }));
      expect(error.code).toBe(-32600);
      expect(error.message).toContain("workflow");
    }
  });

  it("keeps default orchestrate.run on the pre-M7 event path without workflow events", async () => {
    const h = await freshHarness();
    ok(await h.dispatch("flock.declare", {
      agents: [{ id: "coder", transport: "fake", roles: ["coder"] }],
    }));
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "legacy path",
      roles: { coder: { agent: "coder" } },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await approveFirstMergeApproval(h);
    await pollUntil(() => h.events.some((event) => event.name === "run_merged"), "merged");

    const names = h.events.map((event) => event.name);
    expect(names).toContain("run_started");
    expect(names).toContain("step_started");
    expect(names).toContain("run_merged");
    expect(names.some((name) => name.startsWith("workflow_"))).toBe(false);
  });

  it("routes max_steps=1 through the legacy driveRun path even with workflow set", async () => {
    const h = await freshHarness();
    await declareCoderAndReviewers(h);
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "max steps one",
      workflow: "linear",
      max_steps: 1,
      roles: {
        coder: { agent: "coder" },
        reviewer: { panel: ["r1", "r2"], quorum: 1 },
      },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await approveFirstMergeApproval(h);
    await pollUntil(() => h.events.some((event) => event.name === "run_merged"), "merged");

    expect(h.events.map((event) => event.name).some((name) => name.startsWith("workflow_"))).toBe(false);
    expect(h.ctx.runs.get(run_id)?.workflow).toBeUndefined();
  });

  it("runs max_steps>1 linear as implement then review with workflow events and one consensus gate", async () => {
    const h = await freshHarness();
    await declareCoderAndReviewers(h);
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "linear workflow",
      workflow: "linear",
      max_steps: 3,
      roles: {
        coder: { agent: "coder" },
        reviewer: { panel: ["r1", "r2"], quorum: 1 },
      },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await approveFirstMergeApproval(h);
    await pollUntil(() => h.events.some((event) => event.name === "consensus_verdict"), "verdict");
    await pollUntil(() => h.events.some((event) => event.name === "run_merged"), "merged");

    const workflowEvents = h.events.filter((event) => event.name.startsWith("workflow_"));
    expect(workflowEvents.map((event) => event.name)).toEqual([
      "workflow_selected",
      "workflow_step_planned",
      "workflow_step_completed",
      "workflow_step_planned",
      "workflow_step_completed",
    ]);
    expect(h.events.filter((event) => event.name === "consensus_verdict")).toHaveLength(1);
    const run = h.ctx.runs.get(run_id);
    expect(run?.step_history?.map((entry) =>
      entry.action.kind === "step" ? entry.action.action : entry.action.kind
    )).toEqual(["implement", "review"]);
    expect(run?.per_step?.map((step) => ({
      action: step.action,
      outcome: step.outcome,
    }))).toEqual([
      { action: "implement", outcome: "completed" },
      { action: "review", outcome: "completed" },
    ]);
    expect(run?.active_step_token).toBeUndefined();
    expect(run?.step_index).toBeUndefined();

    const samples = parseJsonl(exportTrainingSamplesJsonl(h.ctx.governance.decisions));
    const implement = samples.find((sample) => sample.step_index === 0)!;
    expect(implement).toMatchObject({
      sample_id: `${run_id}:step:0`,
      run_id,
      step_index: 0,
      reward: 1,
      reward_basis: "merged",
      reward_policy_version: "m7-foundation-loop-v1",
    });
    expect(implement.state).toMatchObject({
      version: "DispatchState.v1",
      run_id,
      workflow_id: "linear",
      step_index: 0,
      decision_kind: "next_step",
    });
    expect(implement.action).toMatchObject({
      version: "WorkPlan.v1",
      kind: "step",
      action: "implement",
      agent_id: "coder",
      role: "coder",
    });
    expect(JSON.parse(JSON.stringify(implement.state))).toEqual(implement.state);
  });

  it("blocks once and exports negative reward when consensus rejects the review step", async () => {
    const h = await freshHarness();
    await declareCoderAndReviewers(h);
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "linear workflow consensus reject",
      workflow: "linear",
      max_steps: 3,
      roles: {
        coder: { agent: "coder" },
        reviewer: { panel: ["r1", "r2"], quorum: 1 },
      },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

    const run = h.ctx.runs.get(run_id)!;
    const rejectingReviewer: ReviewerExecutor = async ({ agents }) =>
      agents.map((agent) => ({
        agent,
        status: "completed" as const,
        verdict: "reject" as const,
        max_severity: "P1" as const,
      }));
    (run as { reviewerExecutor?: ReviewerExecutor }).reviewerExecutor = rejectingReviewer;

    await approveFirstMergeApproval(h);
    await pollUntil(() => h.events.some((event) => event.name === "consensus_verdict"), "verdict");
    await pollUntil(() => h.events.some((event) => event.name === "run_blocked"), "blocked");

    expect(terminalEvents(h.events)).toHaveLength(1);
    expect(h.events.find((event) => event.name === "run_blocked")?.payload).toMatchObject({
      reason: "consensus_reject",
    });
    expect(run.step_history?.map((entry) => ({
      action: entry.action.kind === "step" ? entry.action.action : entry.action.kind,
      outcome: entry.outcome,
      reason: entry.reason,
    }))).toEqual([
      { action: "implement", outcome: "completed", reason: undefined },
      { action: "review", outcome: "blocked", reason: "consensus_reject" },
    ]);
    expect(run.per_step?.map((step) => ({
      action: step.action,
      outcome: step.outcome,
      reason: step.reason,
    }))).toEqual([
      { action: "implement", outcome: "completed", reason: undefined },
      { action: "review", outcome: "blocked", reason: "consensus_reject" },
    ]);

    const samples = parseJsonl(exportTrainingSamplesJsonl(h.ctx.governance.decisions));
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      run_id,
      step_index: 0,
      reward: -1,
      reward_basis: "consensus_reject",
    });
  });

  it("runs linear without reviewer panel as implement only and no consensus", async () => {
    const h = await freshHarness();
    ok(await h.dispatch("flock.declare", {
      agents: [{ id: "coder", transport: "fake", roles: ["coder"] }],
    }));
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "linear no review",
      workflow: "linear",
      max_steps: 3,
      roles: { coder: { agent: "coder" } },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await approveFirstMergeApproval(h);
    await pollUntil(() => h.events.some((event) => event.name === "run_merged"), "merged");

    expect(h.events.some((event) => event.category === "consensus")).toBe(false);
    expect(h.ctx.runs.get(run_id)?.step_history).toHaveLength(1);
  });

  it("blocks spec-driven workflow on non-executable plan action", async () => {
    const h = await freshHarness();
    ok(await h.dispatch("flock.declare", {
      agents: [{ id: "coder", transport: "fake", roles: ["coder"] }],
    }));
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "spec-driven plan",
      workflow: "spec-driven",
      max_steps: 3,
      roles: { coder: { agent: "coder" } },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await pollUntil(() => h.events.some((event) => event.name === "run_blocked"), "blocked");

    const blocked = h.events.find((event) => event.name === "run_blocked")!;
    expect(blocked.payload).toMatchObject({ reason: "action_executor_not_available:plan" });
    expect(h.events.some((event) => event.name === "approval_requested")).toBe(false);
  });

  it("emits exactly one terminal event on approval expiry in a workflow step", async () => {
    const h = await freshHarness();
    ok(await h.dispatch("flock.declare", {
      agents: [{ id: "coder", transport: "fake", roles: ["coder"] }],
    }));
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "expiry",
      workflow: "linear",
      max_steps: 2,
      roles: { coder: { agent: "coder" } },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));
    await pollUntil(() => h.events.some((event) => event.name === "approval_requested"), "approval");

    h.clock.advance(300);
    h.scheduler.advance(300);
    await pollUntil(() => h.events.some((event) => event.name === "run_blocked"), "blocked");

    expect(terminalEvents(h.events)).toHaveLength(1);
  });

  it("blocks once with human-reject reward basis when workflow approval is rejected", async () => {
    const h = await freshHarness();
    ok(await h.dispatch("flock.declare", {
      agents: [{ id: "coder", transport: "fake", roles: ["coder"] }],
    }));
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "approval reject",
      workflow: "linear",
      max_steps: 2,
      roles: { coder: { agent: "coder" } },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await rejectFirstMergeApproval(h);
    await pollUntil(() => h.events.some((event) => event.name === "run_blocked"), "blocked");

    expect(terminalEvents(h.events)).toHaveLength(1);
    expect(h.events.find((event) => event.name === "run_blocked")?.payload).toMatchObject({
      reason: "write_file denied",
    });
    const run = h.ctx.runs.get(run_id)!;
    expect(run.step_history?.map((entry) => ({
      action: entry.action.kind === "step" ? entry.action.action : entry.action.kind,
      outcome: entry.outcome,
      reason: entry.reason,
    }))).toEqual([
      { action: "implement", outcome: "blocked", reason: "write_file denied" },
    ]);

    const samples = parseJsonl(exportTrainingSamplesJsonl(h.ctx.governance.decisions));
    if (samples.length > 0) {
      expect(samples.map((sample) => sample.reward_basis)).toEqual(["human_reject"]);
    }
  });

  it("emits exactly one terminal event on task.cancel while a workflow step is waiting", async () => {
    const h = await freshHarness();
    ok(await h.dispatch("flock.declare", {
      agents: [{ id: "coder", transport: "fake", roles: ["coder"] }],
    }));
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "cancel",
      workflow: "linear",
      max_steps: 2,
      roles: { coder: { agent: "coder" } },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));
    await pollUntil(() => h.events.some((event) => event.name === "approval_requested"), "approval");

    ok(await h.dispatch("task.cancel", { run_id }));
    await pollUntil(() => h.events.some((event) => event.name === "run_gave_up"), "cancelled");

    expect(terminalEvents(h.events)).toHaveLength(1);
  });
});
