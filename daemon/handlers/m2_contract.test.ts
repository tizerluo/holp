/**
 * M2 contract regression net — PR4 / `docs/pr-specs/pr4-m2-contract-tests.md`.
 *
 * Purpose (spec PR4): turn v0.1.4 protocol semantics into executable contract
 * tests so later provider/governance work cannot silently break the wire.
 *
 * This file COMPLEMENTS, not duplicates, the existing suite. The PR4 checklist
 * maps to coverage as follows — read this as the audit index for M2:
 *
 *   JSON-RPC
 *     request/response id .................. NEW here (§A) + dispatcher.test.ts
 *     notification shape (no response) ..... NEW here (§A) + dispatcher.test.ts
 *     unknown method → -32601 .............. dispatcher.test.ts; re-locked via wired daemon (§A)
 *   Capability negotiation
 *     default = unsupported ................ capabilities.test.ts / initialize.test.ts
 *     required:true is connection-level .... capabilities.test.ts / initialize.test.ts
 *     run-level hard requirement ........... m1b_contract.test.ts "FIX 2" (-32003 at accept-time)
 *     approval kinds intersection .......... capabilities.test.ts / initialize.test.ts
 *   Flock
 *     partial success / rejected status .... m1b_contract.test.ts §2
 *     unknown agent → agent_not_found ...... m1b_contract.test.ts §3
 *     role mismatch → role_unsupported ..... m1b_contract.test.ts §3
 *   Events
 *     omitted/null categories = all ........ events.test.ts
 *     empty/unknown → invalid_event_category events.test.ts
 *     after_seq replay / multi-sub ......... m1b_contract.test.ts §7
 *     heartbeat NOT category-filtered ...... DEFERRED — see §F (no heartbeats emitted yet; M3+)
 *   Approval
 *     requested → resolved ................. m1b_contract.test.ts §4
 *     requested → cancelled (task.cancel) .. m1b_contract.test.ts §5
 *     no approval.cancel method ............ NEW here (§B)
 *     先终态者赢 (resolve wins) race ......... NEW here (§C)
 *     approval_already_resolved ............ m1b_contract.test.ts §4
 *     requested → expired .................. DEFERRED — see §F (no expiry timer yet; M4 run state machine)
 *   Cancel
 *     terminal idempotency / unknown run ... m1b_contract.test.ts §5
 *   Artifact
 *     always content / truncation .......... m1b_contract.test.ts §6
 *     artifact_refs:false inline fallback .. NEW here (§D) — approval details inline form
 *     provenance artifact_id = identity .... NEW here (§E)
 *   Consensus
 *     stage-1 static panel validation ...... m1b_contract.test.ts §3 (agent_not_found /
 *                                            role_unsupported / invalid_quorum incl. rejected-in-panel)
 *     stage-2 + verdict + quorum.met ....... DEFERRED — see §F (consensus execution is M4/M5;
 *                                            roadmap M4 "consensus aggregator", M5 "quorum.met")
 *
 * Honesty discipline (CLAUDE.md Rule 5): the DEFERRED items are NOT skipped to
 * hide a gap — they are future-milestone FEATURES (consensus execution, approval
 * expiry timer, heartbeat emission) that M1/M2 deliberately does not implement
 * (spec PR4: "不扩展 daemon feature"). §F asserts the CURRENT honest behavior
 * (the absence) and cites the milestone that will add the richer semantic, so the
 * boundary is visible and auditable rather than faked.
 *
 * All tests run in-process through the REAL buildDispatcher + handler chain; the
 * fake backend replaces only the provider. FakeClock for determinism.
 */

import { describe, it, expect } from "vitest";
import { buildDispatcher } from "../runtime/server.js";
import { ConnectionContext } from "../core/context.js";
import { EventSink } from "../core/eventSink.js";
import { FakeClock } from "../core/clock.js";
import { createFakeRegistry } from "../../adapters/registry.js";
import type { EventNotificationParams } from "../core/eventSink.js";
import type { JsonRpcResponse } from "../runtime/jsonrpc.js";
import { JSONRPC_METHOD_NOT_FOUND } from "../core/errors.js";
import type { Dispatcher } from "../core/dispatcher.js";

// ---------------------------------------------------------------------------
// Helpers (self-contained; mirror m1b_contract.test.ts so this file reads alone)
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

function ok<T>(res: unknown): T {
  const r = res as JsonRpcResponse;
  if ("error" in r) {
    const e = (r as { error: { code: number; message: string } }).error;
    throw new Error(`Expected success but got error: code=${e.code} msg=${e.message}`);
  }
  return (r as { result: T }).result;
}

function err(res: unknown): { code: number; message: string; data?: unknown } {
  const r = res as JsonRpcResponse;
  if ("result" in r) {
    throw new Error(`Expected error but got success: ${JSON.stringify((r as { result: unknown }).result)}`);
  }
  return (r as { error: { code: number; message: string; data?: unknown } }).error;
}

interface Harness {
  ctx: ConnectionContext;
  events: EventNotificationParams[];
  dispatcher: Dispatcher;
  /** Auto-incrementing-id dispatch; returns the full JSON-RPC response. */
  dispatch: (method: string, params: unknown, id?: number | string) => Promise<unknown>;
}

/** Build a fresh dispatcher; unless `initialize:false` is passed, negotiate approval support. */
async function freshDispatcher(opts?: { initialize?: boolean }): Promise<Harness> {
  const registry = createFakeRegistry();
  const clock = new FakeClock();
  const ctx = new ConnectionContext();
  const { sink, events } = makeCollectingSink();
  const dispatcher = buildDispatcher(ctx, sink, registry, clock);

  let idCounter = 1;
  const dispatch = async (method: string, params: unknown, id?: number | string): Promise<unknown> =>
    dispatcher.dispatch({ jsonrpc: "2.0", id: id ?? idCounter++, method, params });

  if (opts?.initialize !== false) {
    await dispatch("initialize", {
      protocol_version: "0.1.4",
      client: { name: "m2-contract", version: "0.0.1" },
      capabilities: { approval: { supported: true, kinds: ["merge_approval"] } },
    });
  }

  return { ctx, events, dispatcher, dispatch };
}

/**
 * Yield microtask ticks until `pred` is true. THROWS if it never becomes true
 * within `maxTicks` — a missing/misnamed event must surface as a loud failure
 * here, not as a confusing downstream assertion on stale state.
 */
async function pollUntil(pred: () => boolean, label = "pollUntil", maxTicks = 500): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (pred()) return;
    await Promise.resolve();
  }
  throw new Error(`${label}: predicate not satisfied after ${maxTicks} ticks`);
}

/** Drive a fresh run up to the approval_requested pause; returns ids + handle. */
async function runToApproval(h: Harness): Promise<{ runId: string; approvalId: string }> {
  ok(await h.dispatch("flock.declare", { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] }));
  const { run_id } = ok<{ run_id: string }>(
    await h.dispatch("orchestrate.run", { goal: "x", roles: { coder: { agent: "a1" } } }),
  );
  ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));
  await pollUntil(() => h.events.some((e) => e.name === "approval_requested"), "approval_requested");
  const approvalId = (h.events.find((e) => e.name === "approval_requested")!.payload as Record<string, unknown>)
    .approval_id as string;
  return { runId: run_id, approvalId };
}

// ---------------------------------------------------------------------------
// A. JSON-RPC envelope: id correlation + notification shape (spec §1 / §10.1)
// ---------------------------------------------------------------------------

describe("A. JSON-RPC envelope (spec §1)", () => {
  it("response echoes the request id verbatim — numeric id", async () => {
    const { dispatcher } = await freshDispatcher();
    const res = (await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 4242,
      method: "artifact.get",
      params: {}, // missing artifact_id → error response, but id must still echo
    })) as JsonRpcResponse;
    expect(res!.id).toBe(4242);
    expect("error" in res!).toBe(true);
  });

  it("response echoes the request id verbatim — string id", async () => {
    const { dispatcher } = await freshDispatcher();
    const res = (await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: "req-abc-001",
      method: "flock.declare",
      params: { agents: [{ id: "a1", transport: "fake", roles: ["coder"] }] },
    })) as JsonRpcResponse;
    expect(res!.id).toBe("req-abc-001");
    expect("result" in res!).toBe(true);
  });

  it("a client→server notification (no id) produces NO response frame", async () => {
    const { dispatcher } = await freshDispatcher();
    const res = await dispatcher.dispatch({
      jsonrpc: "2.0",
      method: "artifact.get", // valid method name, but framed as a notification
      params: { artifact_id: "whatever" },
    });
    expect(res).toBeUndefined();
  });

  it("unknown method → -32601 method_not_found (re-locked through the wired daemon)", async () => {
    const { dispatch } = await freshDispatcher();
    const e = err(await dispatch("orchestrate.frobnicate", {}));
    expect(e.code).toBe(JSONRPC_METHOD_NOT_FOUND); // -32601
  });
});

// ---------------------------------------------------------------------------
// B. No `approval.cancel` method — cancel is a `task.cancel` side effect (§7)
// ---------------------------------------------------------------------------

describe("B. approval has no cancel method (spec §7 single-channel state machine)", () => {
  it("approval.cancel is not a registered method → -32601 method_not_found", async () => {
    const { dispatch } = await freshDispatcher();
    const e = err(await dispatch("approval.cancel", { approval_id: "ap_anything" }));
    expect(e.code).toBe(JSONRPC_METHOD_NOT_FOUND); // -32601
  });

  it("approval.request is likewise not a method (no out-of-band approval request channel)", async () => {
    const { dispatch } = await freshDispatcher();
    const e = err(await dispatch("approval.request", {}));
    expect(e.code).toBe(JSONRPC_METHOD_NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// C. Approval race — 先终态者赢: client resolve wins, no double terminal (§7)
// ---------------------------------------------------------------------------

describe("C. Approval terminal race (spec §7: first terminal wins)", () => {
  it("resolve-first → approval_resolved emitted; subsequent task.cancel is idempotent no-op (cancelling:false), no approval_cancelled retro-fired", async () => {
    const h = await freshDispatcher();
    const { runId, approvalId } = await runToApproval(h);

    // Client resolves first.
    ok(await h.dispatch("approval.resolve", { approval_id: approvalId, decision: "approved", by: "u" }));
    await pollUntil(() => h.events.some((e) => e.name === "run_merged"), "run_merged");

    // task.cancel on the (now terminal) run must be an idempotent no-op and must
    // NOT retroactively cancel the already-resolved approval.
    const cancel = ok<{ cancelling: boolean }>(await h.dispatch("task.cancel", { run_id: runId }));
    expect(cancel.cancelling).toBe(false);

    const namesForApproval = h.events
      .filter((e) => (e.payload as Record<string, unknown>).approval_id === approvalId)
      .map((e) => e.name);
    expect(namesForApproval).toContain("approval_resolved");
    expect(namesForApproval).not.toContain("approval_cancelled");
    expect(namesForApproval).not.toContain("approval_expired");
  });

  it("cancel-first → approval_cancelled present, a later resolve is rejected approval_already_resolved (-32010)", async () => {
    const h = await freshDispatcher();
    const { runId, approvalId } = await runToApproval(h);

    // Server-side terminal first (task.cancel cancels the pending approval).
    ok(await h.dispatch("task.cancel", { run_id: runId }));
    await pollUntil(() => h.events.some((e) => e.name === "approval_cancelled"), "approval_cancelled");

    // A racing client resolve now loses — the approval is already terminal.
    const e = err(await h.dispatch("approval.resolve", { approval_id: approvalId, decision: "approved", by: "u" }));
    expect(e.code).toBe(-32010); // approval_already_resolved

    const namesForApproval = h.events
      .filter((ev) => (ev.payload as Record<string, unknown>).approval_id === approvalId)
      .map((ev) => ev.name);
    expect(namesForApproval).toContain("approval_cancelled");
    expect(namesForApproval).not.toContain("approval_resolved");
  });
});

// ---------------------------------------------------------------------------
// D. artifact_refs:false — evidence carried as inline degraded object (§2 / §7)
// ---------------------------------------------------------------------------

describe("D. artifact_refs degraded inline form (spec §2 / §7)", () => {
  it("approval_requested.details is the inline degraded object, not an envelope/ref", async () => {
    // Note: this connection negotiated approval but NOT artifact_refs, i.e.
    // artifact_refs is unsupported → evidence MUST degrade to inline (§2).
    const h = await freshDispatcher();
    await runToApproval(h);

    const reqEv = h.events.find((e) => e.name === "approval_requested")!;
    const details = (reqEv.payload as Record<string, unknown>).details as Record<string, unknown>;

    // Inline degraded shape per §7: { inline:true, type, mime, content, truncated }.
    expect(details.inline).toBe(true);
    expect(details.type).toBe("approval_details");
    expect(details.mime).toBe("application/json");
    expect(typeof details.content).toBe("string");
    expect(details.truncated).toBe(false);

    // Must NOT carry an envelope / content_ref / artifact_id (those are the
    // artifact_refs:true form, which §2 forbids when the cap is unavailable).
    expect(details).not.toHaveProperty("envelope");
    expect(details).not.toHaveProperty("content_ref");
    expect(details).not.toHaveProperty("artifact_id");

    // content is the encoded evidence payload, decodable as JSON with exactly the
    // documented shape { tool, input } — full-shape assertion catches a silent
    // serialization regression, not just presence of `tool`.
    const decoded = JSON.parse(details.content as string) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(["input", "tool"]);
  });
});

// ---------------------------------------------------------------------------
// E. provenance bare artifact_id is identity, NOT gated by artifact_refs (§2 / §8.1)
// ---------------------------------------------------------------------------

describe("E. provenance artifact_id as identity (spec §2 / §8.1)", () => {
  it("approval_requested.provenance carries step_id + an artifact_id slot (identity field, not evidence)", async () => {
    const h = await freshDispatcher();
    await runToApproval(h);

    const reqEv = h.events.find((e) => e.name === "approval_requested")!;
    const provenance = (reqEv.payload as Record<string, unknown>).provenance as Record<string, unknown>;

    expect(typeof provenance.step_id).toBe("string");
    // artifact_id is a bare identity slot — present as a key even when there is no
    // artifact yet (null in M1b). §2: this field is NOT controlled by artifact_refs.
    expect(provenance).toHaveProperty("artifact_id");
    // It is a bare scalar — null (no artifact yet, M1b) or a string id — never a
    // fetchable envelope object. Assert null-or-string explicitly (typeof null is
    // "object", so a loose typeof check would pass vacuously and mislead).
    expect(provenance.artifact_id === null || typeof provenance.artifact_id === "string").toBe(true);
  });

  it("run_merged.artifact_id is a bare id usable as identity in artifact.get (no artifact_refs needed)", async () => {
    const h = await freshDispatcher();
    const { approvalId } = await runToApproval(h);
    ok(await h.dispatch("approval.resolve", { approval_id: approvalId, decision: "approved", by: "u" }));
    await pollUntil(() => h.events.some((e) => e.name === "run_merged"), "run_merged");

    const mergedEv = h.events.find((e) => e.name === "run_merged")!;
    const artifactId = (mergedEv.payload as Record<string, unknown>).artifact_id;
    // Bare string identity, not an inline object.
    expect(typeof artifactId).toBe("string");

    // The bare id resolves through artifact.get even though this connection never
    // negotiated artifact_refs — identity ids are not gated by the capability.
    expect(h.ctx.initialized?.negotiated.artifact_refs.supported).toBe(false);
    const art = ok<Record<string, unknown>>(await h.dispatch("artifact.get", { artifact_id: artifactId }));
    expect(typeof art.content).toBe("string");
    expect((art.content as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// F. Honest deferral boundary — semantics that land in M3/M4/M5 (NOT faked)
// ---------------------------------------------------------------------------
//
// These tests lock the CURRENT honest behavior (the absence of a not-yet-built
// feature) and name the milestone that will implement it. They are the
// regression guard that M3 "可以在不改 contract expectations 的前提下继续"
// (spec PR4 acceptance): when consensus/expiry/heartbeats land, the team updates
// THESE expectations together with the feature, in the owning milestone.

describe("F. Deferred-semantics boundary (M3/M4/M5) — current behavior locked honestly", () => {
  it("a single-coder run emits NO consensus-category event (consensus_verdict is M4/M5)", async () => {
    // Roadmap: consensus aggregator = M4; quorum.met/excluded[] = M5. M1/M2 runs
    // drive only the coder; there is no consensus execution to assert yet.
    const h = await freshDispatcher();
    const { approvalId } = await runToApproval(h);
    ok(await h.dispatch("approval.resolve", { approval_id: approvalId, decision: "approved", by: "u" }));
    await pollUntil(() => h.events.some((e) => e.name === "run_merged"), "run_merged");

    expect(h.events.some((e) => e.category === "consensus")).toBe(false);
    expect(h.events.some((e) => e.name === "consensus_verdict")).toBe(false);
  });

  it("no approval_expired self-fires while a request sits pending (expiry timer is M4)", async () => {
    // §7 defines approval_expired, but the run state machine / expiry timer that
    // would emit it is M4. expires_at is set NOW (future timer input); assert that,
    // and assert nothing auto-expires under the FakeClock without a timer.
    const h = await freshDispatcher();
    const { runId } = await runToApproval(h);

    const reqEv = h.events.find((e) => e.name === "approval_requested")!;
    expect(typeof (reqEv.payload as Record<string, unknown>).expires_at).toBe("number");

    // Drain microtasks generously — without a timer, no expiry transition occurs.
    const FAKE_DRAIN_TICKS = 200; // generous microtask drain; M2 has no real expiry timer
    for (let i = 0; i < FAKE_DRAIN_TICKS; i++) await Promise.resolve();
    expect(h.events.some((e) => e.name === "approval_expired")).toBe(false);

    // Clean up the genuinely-paused run.
    ok(await h.dispatch("task.cancel", { run_id: runId }));
  });
});
