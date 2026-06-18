import { describe, expect, it } from "vitest";
import { buildDispatcher } from "../runtime/server.js";
import { ConnectionContext } from "../core/context.js";
import { EventSink, type EventNotificationParams } from "../core/eventSink.js";
import { FakeClock } from "../core/clock.js";
import { FakeScheduler } from "../core/scheduler.js";
import { createFakeRegistry } from "../../adapters/registry.js";
import type { JsonRpcResponse } from "../runtime/jsonrpc.js";
import { HOLP_ERROR_CODES } from "../core/errors.js";
import { expireApproval } from "../core/approvalLifecycle.js";

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

async function pollUntil(pred: () => boolean, label = "pollUntil", maxTicks = 500): Promise<void> {
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
    client: { name: "m4a-governance", version: "0" },
    capabilities: { approval: { supported: true, kinds: ["merge_approval"] } },
  }));

  return { ctx, clock, scheduler, events, dispatch };
}

async function runToApproval(h: Awaited<ReturnType<typeof freshHarness>>): Promise<{
  runId: string;
  approvalId: string;
}> {
  ok(await h.dispatch("flock.declare", {
    agents: [{ id: "agent-1", transport: "fake", roles: ["coder", "reviewer"] }],
  }));
  const { run_id } = ok<{ run_id: string }>(
    await h.dispatch("orchestrate.run", {
      goal: "m4a governance",
      roles: { coder: { agent: "agent-1" } },
    }),
  );
  ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));
  await pollUntil(() => h.events.some((event) => event.name === "approval_requested"), "approval");
  const approvalId = (h.events.find((event) => event.name === "approval_requested")!
    .payload as Record<string, unknown>).approval_id as string;
  return { runId: run_id, approvalId };
}

describe("M4a governance integration", () => {
  it("archives flock runtime metadata and mirrors run events/decisions", async () => {
    const h = await freshHarness();
    const { runId, approvalId } = await runToApproval(h);

    expect(h.ctx.governance.harnessRegistry.length).toBeGreaterThan(0);
    expect(
      h.ctx.governance.harnessRegistry.some((record) =>
        record.agent_id === "agent-1" &&
        record.runtime_surface === "headless" &&
        record.isolation_profile === "coder_worktree" &&
        record.isolation_status === "ready"
      ),
    ).toBe(true);
    expect(h.ctx.governance.events.map((event) => event.name)).toContain("run_started");
    expect(h.ctx.governance.decisions.map((decision) => decision.decision_type)).toEqual(
      expect.arrayContaining(["run_accepted", "runtime_selected", "approval_requested"]),
    );
    expect(h.ctx.governance.runStates.get(runId)?.state).toBe("waiting_approval");

    ok(await h.dispatch("approval.resolve", {
      approval_id: approvalId,
      decision: "approved",
      by: "user:test",
    }));
    await pollUntil(() => h.events.some((event) => event.name === "run_merged"), "merged");

    expect(h.ctx.governance.runStates.get(runId)?.state).toBe("merged");
    expect(h.ctx.governance.decisions.map((decision) => decision.decision_type)).toEqual(
      expect.arrayContaining(["approval_resolved", "run_terminal"]),
    );
    const started = h.ctx.governance.events.find((event) => event.name === "run_started")!;
    expect((started.payload as Record<string, unknown>).runtime).toMatchObject({
      runtime_surface: "headless",
      isolation_profile: "coder_worktree",
    });
  });

  it("task.cancel clears pending approval timers and records cancelling -> cancelled", async () => {
    const h = await freshHarness();
    const { runId } = await runToApproval(h);
    expect(h.scheduler.pendingCount()).toBe(1);

    ok(await h.dispatch("task.cancel", { run_id: runId }));
    await pollUntil(() => h.events.some((event) => event.name === "approval_cancelled"), "cancelled");

    expect(h.scheduler.pendingCount()).toBe(0);
    expect(h.ctx.governance.runStates.get(runId)?.state).toBe("cancelled");
    expect(h.ctx.governance.runStates.get(runId)?.history.map((entry) => entry.to)).toEqual([
      "queued",
      "running",
      "waiting_approval",
      "cancelling",
      "cancelled",
    ]);
    expect(h.ctx.governance.decisions.map((decision) => decision.decision_type)).toEqual(
      expect.arrayContaining(["approval_cancelled", "run_terminal"]),
    );
  });

  it("approval expiry timer emits approval_expired and later resolve is rejected", async () => {
    const h = await freshHarness();
    const { runId, approvalId } = await runToApproval(h);

    h.clock.advance(300);
    h.scheduler.advance(300);
    await pollUntil(() => h.events.some((event) => event.name === "approval_expired"), "expired");
    await pollUntil(() => h.events.some((event) => event.name === "run_blocked"), "blocked");

    const expired = h.events.find((event) => event.name === "approval_expired")!;
    expect(expired.payload).toMatchObject({
      approval_id: approvalId,
      state: "expired",
      reason: "timeout",
    });
    expect(h.events.filter((event) => event.name === "run_blocked")).toHaveLength(1);
    expect(h.ctx.governance.runStates.get(runId)?.state).toBe("blocked");
    expect(h.ctx.governance.runStates.get(runId)?.history.map((entry) => entry.to)).toEqual([
      "queued",
      "running",
      "waiting_approval",
      "blocked",
    ]);
    expect(
      h.ctx.governance.decisions.filter((decision) => decision.decision_type === "run_terminal"),
    ).toHaveLength(1);
    expect(h.ctx.governance.decisions.map((decision) => decision.decision_type)).toEqual(
      expect.arrayContaining(["approval_expired", "run_terminal"]),
    );

    const e = err(await h.dispatch("approval.resolve", {
      approval_id: approvalId,
      decision: "approved",
      by: "user:test",
    }));
    expect(e.code).toBe(HOLP_ERROR_CODES.approval_already_resolved);
  });

  it("multiple expired approvals only emit one run terminal", async () => {
    const h = await freshHarness();
    const { runId } = await runToApproval(h);
    const run = h.ctx.runs.get(runId)!;
    const secondApprovalId = "ap_second_timeout";
    h.ctx.approvals.set(secondApprovalId, {
      approval_id: secondApprovalId,
      run_id: runId,
      kind: "merge_approval",
      reason: "second approval",
      expires_at: h.clock.now() + 300,
      state: "pending",
      resumeBackend: () => {},
    });
    run.pendingApprovals.add(secondApprovalId);

    h.clock.advance(300);
    h.scheduler.advance(300);
    expireApproval(h.ctx, secondApprovalId, h.clock);
    await pollUntil(() => h.events.some((event) => event.name === "run_blocked"), "blocked");

    expect(h.events.filter((event) => event.name === "approval_expired")).toHaveLength(2);
    expect(h.events.filter((event) => event.name === "run_blocked")).toHaveLength(1);
    expect(
      h.ctx.governance.decisions.filter((decision) => decision.decision_type === "run_terminal"),
    ).toHaveLength(1);
  });
});
