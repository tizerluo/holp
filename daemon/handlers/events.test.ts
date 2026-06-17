import { describe, it, expect } from "vitest";
import { ConnectionContext } from "../core/context.js";
import { Dispatcher } from "../core/dispatcher.js";
import { EventBus } from "../core/eventBus.js";
import { FakeClock } from "../core/clock.js";
import { handleEventsSubscribe } from "./events_subscribe.js";
import { handleEventsUnsubscribe } from "./events_unsubscribe.js";
import { HOLP_ERROR_CODES, JSONRPC_INVALID_REQUEST } from "../core/errors.js";
import type { JsonRpcErrorResponse, JsonRpcSuccessResponse } from "../runtime/jsonrpc.js";

function newDispatcher() {
  const ctx = new ConnectionContext();
  // events.* are gated behind the initialize handshake (spec §2); these tests
  // exercise the event handlers, so mark the connection initialized up front.
  ctx.initialized = {
    protocolVersion: "0.1.4",
    clientName: "test",
    clientVersion: "0",
    negotiated: {} as never,
  };
  const d = new Dispatcher(ctx)
    .register("events.subscribe", handleEventsSubscribe)
    .register("events.unsubscribe", handleEventsUnsubscribe);
  return { ctx, d };
}

/**
 * Seed a minimal run record into ctx.runs so events.subscribe accepts the run_id.
 * FIX 3: events.subscribe now requires the run_id to exist in ctx.runs.
 */
function seedRun(ctx: ConnectionContext, runId: string): void {
  const clock = new FakeClock();
  const bus = new EventBus(runId, clock);
  ctx.runs.set(runId, {
    run_id: runId,
    goal: "test",
    trigger: "manual",
    status: "active",
    bus,
    pendingApprovals: new Set(),
    approvalSeq: 0,
  });
}

let nextId = 1;
function sub(params: unknown) {
  return { jsonrpc: "2.0" as const, id: nextId++, method: "events.subscribe", params };
}
function unsub(params: unknown) {
  return { jsonrpc: "2.0" as const, id: nextId++, method: "events.unsubscribe", params };
}

describe("events.subscribe (spec §5)", () => {
  it("omitted categories = subscribe all (stored as null), returns subscription_id + latest_seq:0", async () => {
    const { ctx, d } = newDispatcher();
    seedRun(ctx, "run_abc");
    const res = (await d.dispatch(sub({ run_id: "run_abc" }))) as JsonRpcSuccessResponse;
    const result = res.result as { subscription_id: string; latest_seq: number };
    expect(result.subscription_id).toBe("sub_1");
    expect(result.latest_seq).toBe(0); // empty-run sentinel
    expect(ctx.subscriptions.get("sub_1")?.categories).toBeNull();
  });

  it("explicit null categories = subscribe all", async () => {
    const { ctx, d } = newDispatcher();
    seedRun(ctx, "run_abc");
    await d.dispatch(sub({ run_id: "run_abc", categories: null }));
    expect(ctx.subscriptions.get("sub_1")?.categories).toBeNull();
  });

  it("missing run_id → invalid_request (-32600)", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(sub({}))) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(JSONRPC_INVALID_REQUEST);
  });

  it("empty-string run_id → invalid_request (-32600)", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(sub({ run_id: "" }))) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(JSONRPC_INVALID_REQUEST);
  });

  it("empty array [] → invalid_event_category", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(sub({ run_id: "run_abc", categories: [] }))) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(HOLP_ERROR_CODES.invalid_event_category);
  });

  it("unknown category string → invalid_event_category", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(
      sub({ run_id: "run_abc", categories: ["run", "bogus"] }),
    )) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(HOLP_ERROR_CODES.invalid_event_category);
  });

  it("valid categories → returns subscription_id + latest_seq:0 and records them", async () => {
    const { ctx, d } = newDispatcher();
    seedRun(ctx, "run_abc");
    const res = (await d.dispatch(
      sub({
        run_id: "run_abc",
        categories: ["run", "agent", "consensus", "approval", "lifecycle"],
        include_heartbeats: true,
        after_seq: 5,
      }),
    )) as JsonRpcSuccessResponse;
    const result = res.result as { subscription_id: string; latest_seq: number };
    expect(result.latest_seq).toBe(0);
    const stored = ctx.subscriptions.get(result.subscription_id);
    expect(stored?.categories).toEqual(["run", "agent", "consensus", "approval", "lifecycle"]);
    expect(stored?.includeHeartbeats).toBe(true);
    expect(stored?.afterSeq).toBe(5);
    expect(stored?.runId).toBe("run_abc");
  });

  it("omitted/null after_seq defaults to 0", async () => {
    const { ctx, d } = newDispatcher();
    seedRun(ctx, "run_abc");
    seedRun(ctx, "run_def");
    await d.dispatch(sub({ run_id: "run_abc" }));
    await d.dispatch(sub({ run_id: "run_def", after_seq: null }));

    expect(ctx.subscriptions.get("sub_1")?.afterSeq).toBe(0);
    expect(ctx.subscriptions.get("sub_2")?.afterSeq).toBe(0);
  });

  it("negative, fractional, or non-number after_seq → invalid_request (-32600)", async () => {
    const { d } = newDispatcher();

    for (const after_seq of [-1, 1.5, "2"]) {
      const res = (await d.dispatch(sub({ run_id: "run_abc", after_seq }))) as JsonRpcErrorResponse;
      expect(res.error.code).toBe(JSONRPC_INVALID_REQUEST);
      expect(res.error.message).toContain("after_seq");
    }
  });

  it("subscription ids are monotonic per connection", async () => {
    const { ctx, d } = newDispatcher();
    seedRun(ctx, "r");
    const a = (await d.dispatch(sub({ run_id: "r" }))) as JsonRpcSuccessResponse;
    const b = (await d.dispatch(sub({ run_id: "r" }))) as JsonRpcSuccessResponse;
    expect((a.result as { subscription_id: string }).subscription_id).toBe("sub_1");
    expect((b.result as { subscription_id: string }).subscription_id).toBe("sub_2");
  });

  // FIX 3 (P2): unknown run_id → run_not_found (-32008), no ghost subscription recorded.
  it("FIX 3 — unknown run_id → run_not_found (-32008), ctx.subscriptions NOT mutated", async () => {
    const { ctx, d } = newDispatcher();
    // ctx.runs is empty — do NOT seed "ghost_run"
    const sizeBefore = ctx.subscriptions.size;
    const res = (await d.dispatch(sub({ run_id: "ghost_run" }))) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(HOLP_ERROR_CODES.run_not_found); // -32008
    // No ghost subscription must have been recorded
    expect(ctx.subscriptions.size).toBe(sizeBefore);
  });
});

describe("events.unsubscribe (spec §5)", () => {
  it("known subscription_id → unsubscribed:true and removes it", async () => {
    const { ctx, d } = newDispatcher();
    seedRun(ctx, "run_abc");
    await d.dispatch(sub({ run_id: "run_abc" }));
    expect(ctx.subscriptions.has("sub_1")).toBe(true);
    const res = (await d.dispatch(unsub({ subscription_id: "sub_1" }))) as JsonRpcSuccessResponse;
    expect(res.result).toEqual({ subscription_id: "sub_1", unsubscribed: true });
    expect(ctx.subscriptions.has("sub_1")).toBe(false);
  });

  it("unknown subscription_id → invalid_subscription", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(unsub({ subscription_id: "sub_999" }))) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(HOLP_ERROR_CODES.invalid_subscription);
  });

  it("double unsubscribe → second one is invalid_subscription", async () => {
    const { ctx, d } = newDispatcher();
    seedRun(ctx, "r");
    await d.dispatch(sub({ run_id: "r" }));
    await d.dispatch(unsub({ subscription_id: "sub_1" }));
    const res = (await d.dispatch(unsub({ subscription_id: "sub_1" }))) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(HOLP_ERROR_CODES.invalid_subscription);
  });
});
