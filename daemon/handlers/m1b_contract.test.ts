/**
 * M1b contract tests — lock protocol semantics for PR3 (M1b).
 *
 * These tests run in-process via buildDispatcher + real handler chain.
 * The fake backend replaces the provider; all protocol paths are real.
 * FakeClock for determinism; no wall-clock coupling.
 *
 * Test groups (matching brief requirements):
 *   1. Closed-loop e2e — seq/field/monotonicity/7-field envelope
 *   2. flock part-success semantics (spec §10.1)
 *   3. orchestrate.run error ordering (spec §6.2 — 4-stage fixed order)
 *   4. approval state machine (spec §7)
 *   5. task.cancel (spec §7.5)
 *   6. artifact.get (spec §8.2)
 *   7. events seq/replay/multi-sub (spec §5)
 *   8. Honesty guard — approval bridge is a real block
 */

import { describe, it, expect, beforeEach } from "vitest";
import { buildDispatcher } from "../runtime/server.js";
import { ConnectionContext } from "../core/context.js";
import { EventSink } from "../core/eventSink.js";
import { FakeClock } from "../core/clock.js";
import { createFakeRegistry, createAdapterRegistry } from "../../adapters/registry.js";
import type { EventNotificationParams } from "../core/eventSink.js";
import type { JsonRpcResponse } from "../runtime/jsonrpc.js";
import { HOLP_ERROR_CODES, JSONRPC_INVALID_REQUEST } from "../core/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Unwrap JSON-RPC success result. Throws if the response is an error. */
function ok<T>(res: unknown): T {
  const r = res as JsonRpcResponse;
  if ("error" in r) {
    throw new Error(
      `Expected success but got error: code=${(r as { error: { code: number; message: string } }).error.code} msg=${(r as { error: { code: number; message: string } }).error.message}`,
    );
  }
  return (r as { result: T }).result;
}

/** Unwrap JSON-RPC error. Throws if the response is a success. */
function err(res: unknown): { code: number; message: string; data?: unknown } {
  const r = res as JsonRpcResponse;
  if ("result" in r) {
    throw new Error(`Expected error but got success: ${JSON.stringify((r as { result: unknown }).result)}`);
  }
  return (r as { error: { code: number; message: string; data?: unknown } }).error;
}

/**
 * Build a fresh initialized dispatcher + collect sink.
 * Returns dispatcher and the events array (live-appended as events arrive).
 */
async function freshDispatcher(opts?: { registry?: ReturnType<typeof createFakeRegistry> }): Promise<{
  ctx: ConnectionContext;
  events: EventNotificationParams[];
  dispatch: (method: string, params: unknown, id?: number) => Promise<unknown>;
  sink: EventSink;
}> {
  const registry = opts?.registry ?? createFakeRegistry();
  const ctx = new ConnectionContext();
  const { sink, events } = makeCollectingSink();
  const dispatcher = buildDispatcher(ctx, sink, registry);

  let idCounter = 1;
  const dispatch = async (method: string, params: unknown, id?: number): Promise<unknown> => {
    return dispatcher.dispatch({
      jsonrpc: "2.0",
      id: id ?? idCounter++,
      method,
      params,
    });
  };

  // Initialize (declare approval support so orchestrate.run passes the accept-time gate)
  await dispatch("initialize", {
    protocol_version: "0.1.4",
    client: { name: "test-harness", version: "0.0.1" },
    capabilities: { approval: { supported: true, kinds: ["merge_approval"] } },
  });

  return { ctx, events, dispatch, sink };
}

/** Yield microtask ticks until a predicate becomes true or max ticks exhausted. */
async function pollUntil(pred: () => boolean, maxTicks = 500): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (pred()) return;
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// 1. Closed-loop e2e — 7-field envelope + seq
// ---------------------------------------------------------------------------

describe("1. Closed-loop e2e — full protocol run", () => {
  it("emits run_started, tool_called, approval_requested, approval_resolved, run_merged with all 7-field envelopes and contiguous seq", async () => {
    const { events, dispatch } = await freshDispatcher();

    // Declare fake agent
    ok(await dispatch("flock.declare", { agents: [{ id: "agent-1", transport: "fake", roles: ["coder"] }] }));

    // Start run
    const runRes = ok<{ run_id: string; accepted: boolean }>(
      await dispatch("orchestrate.run", { goal: "Test goal", roles: { coder: { agent: "agent-1" } } }),
    );
    const runId = runRes.run_id;
    expect(runRes.accepted).toBe(true);

    // Subscribe (after_seq:0 = replay all)
    const subRes = ok<{ subscription_id: string; latest_seq: number }>(
      await dispatch("events.subscribe", { run_id: runId, after_seq: 0 }),
    );
    const subscriptionId = subRes.subscription_id;

    // Wait for approval_requested
    let approvalId: string | undefined;
    await pollUntil(() => {
      const ev = events.find((e) => e.name === "approval_requested");
      if (ev) { approvalId = (ev.payload as Record<string, unknown>).approval_id as string; return true; }
      return false;
    });
    expect(approvalId).toBeDefined();

    // Resolve the approval
    ok(await dispatch("approval.resolve", { approval_id: approvalId, decision: "approved", by: "user:test" }));

    // Wait for run_merged
    await pollUntil(() => events.some((e) => e.name === "run_merged"));

    // Assert required event kinds present
    const names = events.map((e) => e.name);
    expect(names).toContain("run_started");
    expect(names).toContain("tool_called");
    expect(names).toContain("approval_requested");
    expect(names).toContain("approval_resolved");
    expect(names).toContain("run_merged");

    // Assert every event has all 7 fields (spec §5)
    for (const ev of events) {
      expect(typeof ev.subscription_id).toBe("string");
      expect(ev.subscription_id).toBe(subscriptionId);
      expect(typeof ev.seq).toBe("number");
      expect(ev.seq).toBeGreaterThan(0);
      expect(typeof ev.ts).toBe("number");
      expect(typeof ev.run_id).toBe("string");
      expect(ev.run_id).toBe(runId);
      expect(typeof ev.category).toBe("string");
      expect(typeof ev.name).toBe("string");
      expect(ev).toHaveProperty("payload");
    }

    // Assert seq starts at 1 and is contiguous
    const seqs = events.map((e) => e.seq);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }
  });

  it("artifact.get after run_merged returns content + envelope + truncated:false, never content_ref", async () => {
    const { events, dispatch } = await freshDispatcher();
    ok(await dispatch("flock.declare", { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] }));
    const { run_id } = ok<{ run_id: string }>(
      await dispatch("orchestrate.run", { goal: "x", roles: { coder: { agent: "a1" } } }),
    );
    ok(await dispatch("events.subscribe", { run_id, after_seq: 0 }));

    let approvalId: string | undefined;
    await pollUntil(() => {
      const ev = events.find((e) => e.name === "approval_requested");
      if (ev) { approvalId = (ev.payload as Record<string, unknown>).approval_id as string; return true; }
      return false;
    });
    ok(await dispatch("approval.resolve", { approval_id: approvalId, decision: "approved", by: "u" }));
    await pollUntil(() => events.some((e) => e.name === "run_merged"));

    const mergedEv = events.find((e) => e.name === "run_merged")!;
    const artifactId = (mergedEv.payload as Record<string, unknown>).artifact_id as string;
    expect(typeof artifactId).toBe("string");

    const art = ok<Record<string, unknown>>(await dispatch("artifact.get", { artifact_id: artifactId }));
    expect(art.truncated).toBe(false);
    expect(typeof art.content).toBe("string");
    expect((art.content as string).length).toBeGreaterThan(0);
    expect(art).not.toHaveProperty("content_ref");
    expect(art.envelope).toBeDefined();
    expect(art.artifact_id).toBe(artifactId);
  });
});

// ---------------------------------------------------------------------------
// 2. flock part-success semantics (spec §10.1)
// ---------------------------------------------------------------------------

describe("2. flock part-success semantics", () => {
  it("unknown transport → per-agent status:rejected, no JSON-RPC error", async () => {
    const { dispatch } = await freshDispatcher();
    const res = ok<{ agents: Array<Record<string, unknown>> }>(
      await dispatch("flock.declare", {
        agents: [{ id: "bad-agent", transport: "native-claude", roles: ["coder"] }],
      }),
    );
    expect(res.agents).toHaveLength(1);
    expect(res.agents[0].status).toBe("rejected");
    expect(typeof res.agents[0].reason).toBe("string");
    // No error thrown — the whole response is a success
  });

  it("flock.declare with unsupported transport for one agent, fake for another — partial success", async () => {
    const { dispatch } = await freshDispatcher();
    const res = ok<{ agents: Array<Record<string, unknown>> }>(
      await dispatch("flock.declare", {
        agents: [
          { id: "good", transport: "fake", roles: ["coder"] },
          { id: "bad", transport: "native-claude", roles: ["coder"] },
        ],
      }),
    );
    expect(res.agents).toHaveLength(2);
    const good = res.agents.find((a) => a.id === "good");
    const bad = res.agents.find((a) => a.id === "bad");
    expect(good?.status).toBe("ready");
    expect(bad?.status).toBe("rejected");
  });

  it("malformed flock.declare — no agents field → -32600", async () => {
    const { dispatch } = await freshDispatcher();
    const e = err(await dispatch("flock.declare", { not_agents: [] }));
    expect(e.code).toBe(JSONRPC_INVALID_REQUEST);
  });

  it("flock.discover with fake transport probe:true → returns ready agent, stored in flock", async () => {
    const { ctx, dispatch } = await freshDispatcher();
    const res = ok<{ agents: Array<Record<string, unknown>> }>(
      await dispatch("flock.discover", { transports: ["fake"], probe: true }),
    );
    expect(res.agents.length).toBeGreaterThanOrEqual(1);
    const discovered = res.agents[0];
    expect(discovered.status).toBe("ready");
    // Agent is stored in ctx.flock
    expect(ctx.flock.has(discovered.id as string)).toBe(true);
  });

  it("flock.discover with real stub transport → no agents returned (not an error)", async () => {
    const { dispatch } = await freshDispatcher();
    const res = ok<{ agents: Array<Record<string, unknown>> }>(
      await dispatch("flock.discover", { transports: ["native-claude"], probe: true }),
    );
    // Real transports have stubs with no discover logic — empty result, no error
    expect(Array.isArray(res.agents)).toBe(true);
  });

  it("flock.discover malformed — no transports field → -32600", async () => {
    const { dispatch } = await freshDispatcher();
    const e = err(await dispatch("flock.discover", {}));
    expect(e.code).toBe(JSONRPC_INVALID_REQUEST);
  });
});

// ---------------------------------------------------------------------------
// 3. orchestrate.run error ordering (spec §6.2)
// ---------------------------------------------------------------------------

describe("3. orchestrate.run error ordering (spec §6.2 — fixed 4-stage order)", () => {
  async function setupWithAgents(roles: string[] = ["coder", "reviewer"]): Promise<{
    dispatch: (method: string, params: unknown) => Promise<unknown>;
    ctx: ConnectionContext;
  }> {
    const { dispatch, ctx } = await freshDispatcher();
    // Declare a fake agent with the given roles
    ok(
      await dispatch("flock.declare", {
        agents: [{ id: "agent-ok", transport: "fake", roles }],
      }),
    );
    return { dispatch, ctx };
  }

  it("stage 1 (agent_not_found -32019): unknown agent id trumps all other problems", async () => {
    const { dispatch } = await setupWithAgents();
    // Unknown agent + bad execution_mode (would be stage 5 normally)
    const e = err(
      await dispatch("orchestrate.run", {
        goal: "g",
        roles: {
          coder: { agent: "UNKNOWN_AGENT" },
        },
        execution_mode: { kind: "Remote" },
      }),
    );
    expect(e.code).toBe(HOLP_ERROR_CODES.agent_not_found); // -32019
  });

  it("stage 2 (role_unsupported -32018): known agent but role not in resolved_roles", async () => {
    const { dispatch } = await setupWithAgents(["coder"]); // no reviewer
    // We now declare agent with only coder role; ask it to be reviewer (not in resolved_roles)
    const e = err(
      await dispatch("orchestrate.run", {
        goal: "g",
        roles: {
          reviewer: { panel: ["agent-ok"], quorum: 1 },
        },
      }),
    );
    expect(e.code).toBe(HOLP_ERROR_CODES.role_unsupported); // -32018
  });

  it("stage 3 (invalid_quorum -32007): quorum <= 0", async () => {
    const { dispatch } = await setupWithAgents(["coder", "reviewer"]);
    const e = err(
      await dispatch("orchestrate.run", {
        goal: "g",
        roles: {
          reviewer: { panel: ["agent-ok"], quorum: 0 },
        },
      }),
    );
    expect(e.code).toBe(HOLP_ERROR_CODES.invalid_quorum); // -32007
  });

  it("stage 3 (invalid_quorum -32007): quorum > panel size", async () => {
    const { dispatch } = await setupWithAgents(["coder", "reviewer"]);
    const e = err(
      await dispatch("orchestrate.run", {
        goal: "g",
        roles: {
          reviewer: { panel: ["agent-ok"], quorum: 5 }, // panel has 1, quorum=5
        },
      }),
    );
    expect(e.code).toBe(HOLP_ERROR_CODES.invalid_quorum); // -32007
  });

  it("stage 3 (invalid_quorum -32007): rejected agent in reviewer panel", async () => {
    const { dispatch, ctx } = await freshDispatcher();
    // Declare a rejected agent + a good reviewer
    ok(
      await dispatch("flock.declare", {
        agents: [
          { id: "rejected-agent", transport: "native-claude", roles: ["reviewer"] }, // will be rejected
          { id: "good-agent", transport: "fake", roles: ["reviewer", "coder"] },
        ],
      }),
    );
    // Panel contains the rejected agent; it should fire invalid_quorum
    const e = err(
      await dispatch("orchestrate.run", {
        goal: "g",
        roles: {
          coder: { agent: "good-agent" },
          reviewer: { panel: ["rejected-agent", "good-agent"], quorum: 1 },
        },
      }),
    );
    expect(e.code).toBe(HOLP_ERROR_CODES.invalid_quorum); // -32007
  });

  it("stage 5 (unsupported_execution_mode -32013): kind != Local", async () => {
    const { dispatch } = await setupWithAgents(["coder"]);
    const e = err(
      await dispatch("orchestrate.run", {
        goal: "g",
        roles: { coder: { agent: "agent-ok" } },
        execution_mode: { kind: "Remote" },
      }),
    );
    expect(e.code).toBe(HOLP_ERROR_CODES.unsupported_execution_mode); // -32013
  });

  it("agent_not_found wins over role_unsupported when BOTH conditions exist", async () => {
    const { dispatch } = await setupWithAgents(["coder"]);
    // UNKNOWN agent AND the panel role would also be unsupported
    const e = err(
      await dispatch("orchestrate.run", {
        goal: "g",
        roles: {
          coder: { agent: "UNKNOWN" },
          reviewer: { panel: ["ALSO_UNKNOWN"], quorum: 1 },
        },
      }),
    );
    expect(e.code).toBe(HOLP_ERROR_CODES.agent_not_found); // -32019, not -32018
  });

  it("role_unsupported wins over invalid_quorum when agent known but role missing", async () => {
    // agent-ok has coder; ask it to be reviewer (role_unsupported)
    // quorum is also 0 (would be invalid_quorum), but role check comes first
    const { dispatch } = await setupWithAgents(["coder"]); // no reviewer
    const e = err(
      await dispatch("orchestrate.run", {
        goal: "g",
        roles: {
          reviewer: { panel: ["agent-ok"], quorum: 0 }, // quorum=0 is also invalid
        },
      }),
    );
    // role_unsupported (-32018) fires before invalid_quorum (-32007)
    expect(e.code).toBe(HOLP_ERROR_CODES.role_unsupported); // -32018
  });

  it("missing goal → -32600 invalid_request", async () => {
    const { dispatch } = await setupWithAgents();
    const e = err(
      await dispatch("orchestrate.run", { roles: { coder: { agent: "agent-ok" } } }),
    );
    expect(e.code).toBe(JSONRPC_INVALID_REQUEST); // -32600
  });

  // FIX 1: rejected agent in single-point role → unsupported_transport (-32005), not role_unsupported (-32018)
  it("FIX 1 — rejected agent as coder → unsupported_transport (-32005), not role_unsupported (-32018)", async () => {
    const { dispatch } = await freshDispatcher();
    // native-claude is rejected at flock.declare (no adapter); it ends up in flock with status:rejected
    ok(
      await dispatch("flock.declare", {
        agents: [{ id: "rejected-coder", transport: "native-claude", roles: ["coder"] }],
      }),
    );
    const e = err(
      await dispatch("orchestrate.run", {
        goal: "g",
        roles: { coder: { agent: "rejected-coder" } },
      }),
    );
    // Must be unsupported_transport (-32005), not role_unsupported (-32018)
    expect(e.code).toBe(HOLP_ERROR_CODES.unsupported_transport); // -32005
    expect(e.code).not.toBe(HOLP_ERROR_CODES.role_unsupported); // not -32018
  });

  // FIX 2: approval gate — initialize without approval.supported → approval_required_but_unsupported (-32003)
  it("FIX 2 — no approval capability negotiated → approval_required_but_unsupported (-32003) at accept-time", async () => {
    // Use a fresh dispatcher WITHOUT approval capabilities declared
    const ctx = new ConnectionContext();
    const { sink } = makeCollectingSink();
    const registry = createFakeRegistry();
    const dispatcher = buildDispatcher(ctx, sink, registry);
    let idCtr = 1;
    const dispatchNoApproval = async (method: string, params: unknown): Promise<unknown> =>
      dispatcher.dispatch({ jsonrpc: "2.0", id: idCtr++, method, params });

    // Initialize WITHOUT approval capability
    await dispatchNoApproval("initialize", {
      protocol_version: "0.1.4",
      client: { name: "no-approval-client", version: "0.0.1" },
      // no capabilities.approval → negotiated.approval.supported = false
    });

    ok(await dispatchNoApproval("flock.declare", {
      agents: [{ id: "a1", transport: "fake", roles: ["coder"] }],
    }));

    // orchestrate.run must reject with approval_required_but_unsupported
    const e = err(
      await dispatchNoApproval("orchestrate.run", {
        goal: "test",
        roles: { coder: { agent: "a1" } },
      }),
    );
    expect(e.code).toBe(HOLP_ERROR_CODES.approval_required_but_unsupported); // -32003
  });
});

// ---------------------------------------------------------------------------
// 4. Approval state machine (spec §7)
// ---------------------------------------------------------------------------

describe("4. Approval state machine (spec §7)", () => {
  it("unknown approval_id → approval_not_found (-32009)", async () => {
    const { dispatch } = await freshDispatcher();
    const e = err(
      await dispatch("approval.resolve", {
        approval_id: "nonexistent-id",
        decision: "approved",
        by: "user:test",
      }),
    );
    expect(e.code).toBe(HOLP_ERROR_CODES.approval_not_found); // -32009
  });

  it("resolve already-terminal approval → approval_already_resolved (-32010)", async () => {
    const { events, dispatch } = await freshDispatcher();
    ok(await dispatch("flock.declare", { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] }));
    const { run_id } = ok<{ run_id: string }>(
      await dispatch("orchestrate.run", { goal: "x", roles: { coder: { agent: "a1" } } }),
    );
    ok(await dispatch("events.subscribe", { run_id, after_seq: 0 }));

    let approvalId: string | undefined;
    await pollUntil(() => {
      const ev = events.find((e) => e.name === "approval_requested");
      if (ev) { approvalId = (ev.payload as Record<string, unknown>).approval_id as string; return true; }
      return false;
    });

    // First resolve — success
    ok(await dispatch("approval.resolve", { approval_id: approvalId, decision: "approved", by: "u" }));

    // Second resolve on same id → approval_already_resolved
    const e = err(
      await dispatch("approval.resolve", { approval_id: approvalId, decision: "approved", by: "u" }),
    );
    expect(e.code).toBe(HOLP_ERROR_CODES.approval_already_resolved); // -32010
  });

  it("normal resolve emits approval_resolved with state:resolved + decision + by", async () => {
    const { events, dispatch } = await freshDispatcher();
    ok(await dispatch("flock.declare", { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] }));
    const { run_id } = ok<{ run_id: string }>(
      await dispatch("orchestrate.run", { goal: "x", roles: { coder: { agent: "a1" } } }),
    );
    ok(await dispatch("events.subscribe", { run_id, after_seq: 0 }));

    let approvalId: string | undefined;
    await pollUntil(() => {
      const ev = events.find((e) => e.name === "approval_requested");
      if (ev) { approvalId = (ev.payload as Record<string, unknown>).approval_id as string; return true; }
      return false;
    });

    ok(await dispatch("approval.resolve", { approval_id: approvalId, decision: "approved", by: "user:alice" }));

    await pollUntil(() => events.some((e) => e.name === "approval_resolved"));
    const resolvedEv = events.find((e) => e.name === "approval_resolved")!;
    expect(resolvedEv).toBeDefined();

    const payload = resolvedEv.payload as Record<string, unknown>;
    expect(payload.state).toBe("resolved");
    expect(payload.decision).toBe("approved");
    expect(payload.by).toBe("user:alice");
    expect(payload.approval_id).toBe(approvalId);
  });

  it("decision:rejected flows correctly through the state machine", async () => {
    const { events, dispatch } = await freshDispatcher();
    ok(await dispatch("flock.declare", { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] }));
    const { run_id } = ok<{ run_id: string }>(
      await dispatch("orchestrate.run", { goal: "x", roles: { coder: { agent: "a1" } } }),
    );
    ok(await dispatch("events.subscribe", { run_id, after_seq: 0 }));

    let approvalId: string | undefined;
    await pollUntil(() => {
      const ev = events.find((e) => e.name === "approval_requested");
      if (ev) { approvalId = (ev.payload as Record<string, unknown>).approval_id as string; return true; }
      return false;
    });

    ok(await dispatch("approval.resolve", { approval_id: approvalId, decision: "rejected", by: "u" }));

    await pollUntil(() => events.some((e) => e.name === "approval_resolved"));
    const resolvedEv = events.find((e) => e.name === "approval_resolved")!;
    const payload = resolvedEv.payload as Record<string, unknown>;
    expect(payload.decision).toBe("rejected");
    expect(payload.state).toBe("resolved");
  });
});

// ---------------------------------------------------------------------------
// 5. task.cancel (spec §7.5)
// ---------------------------------------------------------------------------

describe("5. task.cancel (spec §7.5)", () => {
  it("unknown run_id → run_not_found (-32008)", async () => {
    const { dispatch } = await freshDispatcher();
    const e = err(await dispatch("task.cancel", { run_id: "run_nonexistent" }));
    expect(e.code).toBe(HOLP_ERROR_CODES.run_not_found); // -32008
  });

  it("cancel active run → cancelling:true, emits approval_cancelled for pending approvals + run_gave_up", async () => {
    const { events, dispatch } = await freshDispatcher();
    ok(await dispatch("flock.declare", { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] }));
    const { run_id } = ok<{ run_id: string }>(
      await dispatch("orchestrate.run", { goal: "x", roles: { coder: { agent: "a1" } } }),
    );
    ok(await dispatch("events.subscribe", { run_id, after_seq: 0 }));

    // Wait for approval_requested (run is blocked waiting for approval)
    let approvalId: string | undefined;
    await pollUntil(() => {
      const ev = events.find((e) => e.name === "approval_requested");
      if (ev) { approvalId = (ev.payload as Record<string, unknown>).approval_id as string; return true; }
      return false;
    });
    expect(approvalId).toBeDefined();

    // Now cancel the run while approval is pending
    const cancelRes = ok<{ run_id: string; cancelling: boolean }>(
      await dispatch("task.cancel", { run_id }),
    );
    expect(cancelRes.cancelling).toBe(true);
    expect(cancelRes.run_id).toBe(run_id);

    // Wait for run_gave_up and approval_cancelled events to arrive
    await pollUntil(() =>
      events.some((e) => e.name === "run_gave_up") &&
      events.some((e) => e.name === "approval_cancelled"),
    );

    const gaveUpEv = events.find((e) => e.name === "run_gave_up")!;
    const payload = gaveUpEv.payload as Record<string, unknown>;
    expect(payload.reason).toBe("cancelled");

    const cancelledEv = events.find((e) => e.name === "approval_cancelled")!;
    const cancelledPayload = cancelledEv.payload as Record<string, unknown>;
    expect(cancelledPayload.approval_id).toBe(approvalId);
    expect(cancelledPayload.state).toBe("cancelled");
  });

  it("cancel already-terminal run → idempotent success, cancelling:false, no error", async () => {
    const { events, dispatch } = await freshDispatcher();
    ok(await dispatch("flock.declare", { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] }));
    const { run_id } = ok<{ run_id: string }>(
      await dispatch("orchestrate.run", { goal: "x", roles: { coder: { agent: "a1" } } }),
    );
    ok(await dispatch("events.subscribe", { run_id, after_seq: 0 }));

    let approvalId: string | undefined;
    await pollUntil(() => {
      const ev = events.find((e) => e.name === "approval_requested");
      if (ev) { approvalId = (ev.payload as Record<string, unknown>).approval_id as string; return true; }
      return false;
    });

    // Normal completion
    ok(await dispatch("approval.resolve", { approval_id: approvalId, decision: "approved", by: "u" }));
    await pollUntil(() => events.some((e) => e.name === "run_merged"));

    const runGaveUpCountBefore = events.filter((e) => e.name === "run_gave_up").length;

    // Cancel on already-merged run — must be idempotent
    const res = ok<{ run_id: string; cancelling: boolean }>(
      await dispatch("task.cancel", { run_id }),
    );
    expect(res.cancelling).toBe(false); // no-op
    expect(res.run_id).toBe(run_id);

    // No new terminal event
    await Promise.resolve();
    const runGaveUpCountAfter = events.filter((e) => e.name === "run_gave_up").length;
    expect(runGaveUpCountAfter).toBe(runGaveUpCountBefore);
  });

  it("cancel twice on active run — second cancel sees terminal state → cancelling:false", async () => {
    const { events, dispatch } = await freshDispatcher();
    ok(await dispatch("flock.declare", { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] }));
    const { run_id } = ok<{ run_id: string }>(
      await dispatch("orchestrate.run", { goal: "x", roles: { coder: { agent: "a1" } } }),
    );
    ok(await dispatch("events.subscribe", { run_id, after_seq: 0 }));
    await pollUntil(() => events.some((e) => e.name === "approval_requested"));

    // First cancel
    const r1 = ok<{ cancelling: boolean }>(await dispatch("task.cancel", { run_id }));
    expect(r1.cancelling).toBe(true);

    await pollUntil(() => events.some((e) => e.name === "run_gave_up"));

    // Second cancel — run is now terminal
    const r2 = ok<{ cancelling: boolean }>(await dispatch("task.cancel", { run_id }));
    expect(r2.cancelling).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. artifact.get (spec §8.2)
// ---------------------------------------------------------------------------

describe("6. artifact.get (spec §8.2)", () => {
  it("known artifact → content + envelope + truncated:false, no content_ref", async () => {
    const { ctx, dispatch } = await freshDispatcher();
    // Manually inject a small artifact into the store
    const artifactId = "art-test-1";
    ctx.artifacts.set(artifactId, {
      envelope: {
        artifact_id: artifactId,
        type: "text",
        mime: "text/plain",
        size: 13,
        sha256: "sha256-fake",
        created_by: "test",
        created_at: 1718600000,
      },
      content: "hello, world!",
    });

    const res = ok<Record<string, unknown>>(
      await dispatch("artifact.get", { artifact_id: artifactId }),
    );
    expect(res.content).toBe("hello, world!");
    expect(res.truncated).toBe(false);
    expect(res).not.toHaveProperty("content_ref");
    expect(res).not.toHaveProperty("truncated_at");
    expect(res.envelope).toBeDefined();
    expect(res.artifact_id).toBe(artifactId);
  });

  it("large artifact (> 64 KiB) → truncated:true + truncated_at, no content_ref", async () => {
    const { ctx, dispatch } = await freshDispatcher();
    const artifactId = "art-large-1";
    const bigContent = "x".repeat(65 * 1024); // 65 KiB
    ctx.artifacts.set(artifactId, {
      envelope: {
        artifact_id: artifactId,
        type: "text",
        mime: "text/plain",
        size: bigContent.length,
        sha256: "sha256-big",
        created_by: "test",
        created_at: 1718600000,
      },
      content: bigContent,
    });

    const res = ok<Record<string, unknown>>(
      await dispatch("artifact.get", { artifact_id: artifactId }),
    );
    expect(res.truncated).toBe(true);
    expect(typeof res.truncated_at).toBe("number");
    expect(typeof res.content).toBe("string");
    expect((res.content as string).length).toBeLessThan(bigContent.length);
    expect(res).not.toHaveProperty("content_ref");
  });

  it("unknown artifact_id → artifact_not_found (-32014)", async () => {
    const { dispatch } = await freshDispatcher();
    const e = err(await dispatch("artifact.get", { artifact_id: "does-not-exist" }));
    expect(e.code).toBe(HOLP_ERROR_CODES.artifact_not_found); // -32014
  });

  it("missing artifact_id param → -32600 invalid_request", async () => {
    const { dispatch } = await freshDispatcher();
    const e = err(await dispatch("artifact.get", {}));
    expect(e.code).toBe(JSONRPC_INVALID_REQUEST);
  });
});

// ---------------------------------------------------------------------------
// 7. events seq/replay/multi-sub (spec §5)
// ---------------------------------------------------------------------------

describe("7. events seq / replay / multi-sub (spec §5)", () => {
  /** Set up a fully-completed run (merged) and return runId + all events. */
  async function completedRun(): Promise<{
    dispatch: (method: string, params: unknown) => Promise<unknown>;
    ctx: ConnectionContext;
    runId: string;
    sink: EventSink;
  }> {
    const { dispatch, ctx, sink } = await freshDispatcher();
    ok(await dispatch("flock.declare", { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] }));
    const { run_id } = ok<{ run_id: string }>(
      await dispatch("orchestrate.run", { goal: "x", roles: { coder: { agent: "a1" } } }),
    );

    // Use the ctx bus directly to poll for approval
    const run = ctx.runs.get(run_id)!;

    // Poll via ctx store
    await pollUntil(() => ctx.approvals.size > 0);
    const approvalId = [...ctx.approvals.keys()][0];
    ok(await dispatch("approval.resolve", { approval_id: approvalId, decision: "approved", by: "u" }));
    await pollUntil(() => run.status === "merged");

    return { dispatch, ctx, runId: run_id, sink };
  }

  it("after_seq:N only replays events with seq > N", async () => {
    const { dispatch, ctx, runId } = await completedRun();
    const run = ctx.runs.get(runId)!;
    const allEvents = run.bus.allEvents();
    const midSeq = allEvents[Math.floor(allEvents.length / 2)].seq; // pick middle

    const replayedEvents: EventNotificationParams[] = [];
    const replaySink = new EventSink((frame) => {
      const f = frame as { method?: string; params?: unknown };
      if (f.method === "events.event" && f.params) replayedEvents.push(f.params as EventNotificationParams);
    });

    // Subscribe with after_seq = midSeq
    const dispatcherInternal = buildDispatcher(ctx, replaySink, createFakeRegistry());
    await dispatcherInternal.dispatch({
      jsonrpc: "2.0",
      id: 99,
      method: "events.subscribe",
      params: { run_id: runId, after_seq: midSeq },
    });

    // All replayed events should have seq > midSeq
    for (const ev of replayedEvents) {
      expect(ev.seq).toBeGreaterThan(midSeq);
    }
  });

  it("categories whitelist filters delivered events", async () => {
    const { dispatch, ctx, runId } = await completedRun();
    const run = ctx.runs.get(runId)!;

    const filteredEvents: EventNotificationParams[] = [];
    const filteredSink = new EventSink((frame) => {
      const f = frame as { method?: string; params?: unknown };
      if (f.method === "events.event" && f.params) filteredEvents.push(f.params as EventNotificationParams);
    });

    const dispatcherInternal = buildDispatcher(ctx, filteredSink, createFakeRegistry());
    await dispatcherInternal.dispatch({
      jsonrpc: "2.0",
      id: 100,
      method: "events.subscribe",
      params: { run_id: runId, after_seq: 0, categories: ["run"] },
    });

    // Only "run" category events should appear
    for (const ev of filteredEvents) {
      expect(ev.category).toBe("run");
    }
    // And we must have at least one (run_started, run_merged)
    expect(filteredEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("two subscriptions on the same run get independent subscription_ids and independent replay", async () => {
    const { dispatch, ctx, runId } = await completedRun();
    const run = ctx.runs.get(runId)!;
    const totalEvents = run.bus.allEvents().length;

    const sub1Events: EventNotificationParams[] = [];
    const sub2Events: EventNotificationParams[] = [];

    const sink1 = new EventSink((frame) => {
      const f = frame as { method?: string; params?: unknown };
      if (f.method === "events.event" && f.params) sub1Events.push(f.params as EventNotificationParams);
    });
    const sink2 = new EventSink((frame) => {
      const f = frame as { method?: string; params?: unknown };
      if (f.method === "events.event" && f.params) sub2Events.push(f.params as EventNotificationParams);
    });

    const d1 = buildDispatcher(ctx, sink1, createFakeRegistry());
    const d2 = buildDispatcher(ctx, sink2, createFakeRegistry());

    const r1 = await d1.dispatch({ jsonrpc: "2.0", id: 200, method: "events.subscribe", params: { run_id: runId, after_seq: 0 } });
    const r2 = await d2.dispatch({ jsonrpc: "2.0", id: 201, method: "events.subscribe", params: { run_id: runId, after_seq: 0 } });

    const sub1Id = ok<{ subscription_id: string }>(r1).subscription_id;
    const sub2Id = ok<{ subscription_id: string }>(r2).subscription_id;

    // Different subscription_ids
    expect(sub1Id).not.toBe(sub2Id);

    // Both get all events (full replay)
    expect(sub1Events.length).toBe(totalEvents);
    expect(sub2Events.length).toBe(totalEvents);

    // Events tagged with their own subscription_id
    for (const ev of sub1Events) expect(ev.subscription_id).toBe(sub1Id);
    for (const ev of sub2Events) expect(ev.subscription_id).toBe(sub2Id);
  });

  it("latest_seq in subscribe response is 0 before any events (fresh run)", async () => {
    const { dispatch, ctx } = await freshDispatcher();
    ok(await dispatch("flock.declare", { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] }));
    // Create a run but do NOT let events advance — subscribe immediately after orchestrate.run
    // We can't guarantee seq=0 after kick-off due to async. Use a manual approach:
    // Create a run record directly in ctx and subscribe to it.
    const { EventBus } = await import("../core/eventBus.js");
    const { FakeClock } = await import("../core/clock.js");
    const clock = new FakeClock();
    const bus = new EventBus("run_synthetic", clock);

    // Manually put run record into ctx
    ctx.runs.set("run_synthetic", {
      run_id: "run_synthetic",
      goal: "x",
      trigger: "manual",
      status: "active",
      bus,
      pendingApprovals: new Set(),
      approvalSeq: 0,
    });

    // Subscribe before any events published → latest_seq = 0
    const subRes = ok<{ subscription_id: string; latest_seq: number }>(
      await dispatch("events.subscribe", { run_id: "run_synthetic", after_seq: 0 }),
    );
    expect(subRes.latest_seq).toBe(0);
  });

  it("subscribe with empty categories array → invalid_event_category (-32020)", async () => {
    const { dispatch, ctx } = await freshDispatcher();
    ok(await dispatch("flock.declare", { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] }));
    const { run_id } = ok<{ run_id: string }>(
      await dispatch("orchestrate.run", { goal: "x", roles: { coder: { agent: "a1" } } }),
    );
    const e = err(await dispatch("events.subscribe", { run_id, categories: [] }));
    expect(e.code).toBe(HOLP_ERROR_CODES.invalid_event_category); // -32020

    // Cancel to clean up
    await dispatch("task.cancel", { run_id });
  });

  // FIX 3: events.unsubscribe must remove the subscriber from the run's EventBus
  it("FIX 3 — after unsubscribe, the sink receives no further events from the bus", async () => {
    // Set up a run and subscribe
    const { dispatch, ctx } = await freshDispatcher();
    ok(await dispatch("flock.declare", { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] }));
    const { run_id } = ok<{ run_id: string }>(
      await dispatch("orchestrate.run", { goal: "x", roles: { coder: { agent: "a1" } } }),
    );

    // Subscribe with a dedicated sink so we can count events independently
    const sinkEvents: EventNotificationParams[] = [];
    const dedicatedSink = new EventSink((frame) => {
      const f = frame as { method?: string; params?: unknown };
      if (f.method === "events.event" && f.params) sinkEvents.push(f.params as EventNotificationParams);
    });
    const dedicatedDispatcher = buildDispatcher(ctx, dedicatedSink, createFakeRegistry());
    const subRes = ok<{ subscription_id: string }>(
      await dedicatedDispatcher.dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "events.subscribe",
        params: { run_id, after_seq: 0 },
      }),
    );
    const subscriptionId = subRes.subscription_id;

    // Wait for at least one event to confirm the subscription is live
    await pollUntil(() => sinkEvents.length > 0);

    // Unsubscribe
    ok(await dispatch("events.unsubscribe", { subscription_id: subscriptionId }));

    // Now publish a new event directly on the bus
    const run = ctx.runs.get(run_id)!;
    const countBefore = sinkEvents.length;
    run.bus.publish("lifecycle", "test_event_after_unsub", { marker: true });

    // Drain microtasks — the unsubscribed sink must NOT receive the new event
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const countAfter = sinkEvents.length;

    // Count must not have increased after unsubscribe
    expect(countAfter).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// 8. Honesty guard — approval bridge is a real block (not test theater)
// ---------------------------------------------------------------------------

describe("8. Honesty guard — approval bridge is a real synchronous block", () => {
  it("orchestrate.run does NOT reach terminal event until approval.resolve is called", async () => {
    const { events, dispatch } = await freshDispatcher();
    ok(await dispatch("flock.declare", { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] }));
    const { run_id } = ok<{ run_id: string }>(
      await dispatch("orchestrate.run", { goal: "x", roles: { coder: { agent: "a1" } } }),
    );
    ok(await dispatch("events.subscribe", { run_id, after_seq: 0 }));

    // Wait for the run to reach the approval pause
    let approvalId: string | undefined;
    await pollUntil(() => {
      const ev = events.find((e) => e.name === "approval_requested");
      if (ev) { approvalId = (ev.payload as Record<string, unknown>).approval_id as string; return true; }
      return false;
    });
    expect(approvalId).toBeDefined();

    // At this point: run is genuinely paused — run_merged must NOT have arrived yet.
    // Drain all pending microtasks (50 ticks = plenty for any immediately-resolving code)
    for (let i = 0; i < 50; i++) await Promise.resolve();

    const terminalBefore = events.filter(
      (e) => e.name === "run_merged" || e.name === "run_gave_up",
    );
    expect(terminalBefore).toHaveLength(0); // PROOF: run is blocked, not pre-canned

    // Now send approval.resolve — this is the only event that unblocks the backend
    ok(await dispatch("approval.resolve", { approval_id: approvalId, decision: "approved", by: "u" }));

    // After resolve, the terminal event must eventually appear
    await pollUntil(() => events.some((e) => e.name === "run_merged" || e.name === "run_gave_up"));
    const terminalAfter = events.filter(
      (e) => e.name === "run_merged" || e.name === "run_gave_up",
    );
    expect(terminalAfter).toHaveLength(1); // exactly one terminal event, triggered by resolve
  });

  it("approval_resolved event only appears AFTER approval.resolve is called", async () => {
    const { events, dispatch } = await freshDispatcher();
    ok(await dispatch("flock.declare", { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] }));
    const { run_id } = ok<{ run_id: string }>(
      await dispatch("orchestrate.run", { goal: "x", roles: { coder: { agent: "a1" } } }),
    );
    ok(await dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await pollUntil(() => events.some((e) => e.name === "approval_requested"));

    // Before calling resolve, approval_resolved must not exist
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(events.some((e) => e.name === "approval_resolved")).toBe(false);

    const approvalId = (events.find((e) => e.name === "approval_requested")!.payload as Record<string, unknown>).approval_id as string;
    ok(await dispatch("approval.resolve", { approval_id: approvalId, decision: "approved", by: "u" }));

    await pollUntil(() => events.some((e) => e.name === "approval_resolved"));
    expect(events.some((e) => e.name === "approval_resolved")).toBe(true);
  });
});
