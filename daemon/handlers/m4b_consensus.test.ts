import { describe, expect, it } from "vitest";
import { buildDispatcher } from "../runtime/server.js";
import { ConnectionContext } from "../core/context.js";
import { EventSink, type EventNotificationParams } from "../core/eventSink.js";
import { FakeClock } from "../core/clock.js";
import { FakeScheduler } from "../core/scheduler.js";
import { createAdapterRegistry, createFakeRegistry, type AdapterRegistry } from "../../adapters/registry.js";
import { createFakeBackendFactory } from "../../adapters/fake-backend.js";
import { rejectedProfiles, withProfile } from "../../adapters/harness-declaration.js";
import type { JsonRpcResponse } from "../runtime/jsonrpc.js";
import { HOLP_ERROR_CODES } from "../core/errors.js";

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

async function freshHarness(opts?: {
  semanticDecision?: boolean;
  registry?: AdapterRegistry;
}): Promise<{
  ctx: ConnectionContext;
  events: EventNotificationParams[];
  dispatch: (method: string, params: unknown) => Promise<unknown>;
}> {
  const ctx = new ConnectionContext();
  const clock = new FakeClock();
  const scheduler = new FakeScheduler();
  const { sink, events } = makeCollectingSink();
  const dispatcher = buildDispatcher(ctx, sink, opts?.registry ?? createFakeRegistry(), clock, scheduler);
  let id = 1;
  const dispatch = async (method: string, params: unknown): Promise<unknown> =>
    dispatcher.dispatch({ jsonrpc: "2.0", id: id++, method, params });

  ok(await dispatch("initialize", {
    protocol_version: "0.1.4",
    client: { name: "m4b-consensus", version: "0" },
    capabilities: {
      approval: {
        supported: true,
        kinds: opts?.semanticDecision
          ? ["merge_approval", "semantic_decision"]
          : ["merge_approval"],
      },
      consensus: { supported: true },
    },
  }));

  return { ctx, events, dispatch };
}

async function approveFirstMergeApproval(h: Awaited<ReturnType<typeof freshHarness>>): Promise<void> {
  await pollUntil(() => h.events.some((event) => event.name === "approval_requested"), "merge approval");
  const approval = h.events.find((event) => event.name === "approval_requested")!;
  const approvalId = (approval.payload as Record<string, unknown>).approval_id as string;
  ok(await h.dispatch("approval.resolve", {
    approval_id: approvalId,
    decision: "approved",
    by: "user:test",
  }));
}

describe("M4b consensus integration", () => {
  it("emits consensus_verdict for an explicit reviewer panel", async () => {
    const h = await freshHarness();
    ok(await h.dispatch("flock.declare", {
      agents: [
        { id: "coder", transport: "fake", roles: ["coder"] },
        { id: "r1", transport: "fake", roles: ["reviewer"] },
        { id: "r2", transport: "fake", roles: ["reviewer"] },
      ],
    }));
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "consensus happy path",
      roles: {
        coder: { agent: "coder" },
        reviewer: { panel: ["r1", "r2"], quorum: 2 },
      },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await approveFirstMergeApproval(h);
    await pollUntil(() => h.events.some((event) => event.name === "consensus_verdict"), "verdict");
    await pollUntil(() => h.events.some((event) => event.name === "run_merged"), "merged");

    const verdict = h.events.find((event) => event.name === "consensus_verdict")!;
    expect(verdict.category).toBe("consensus");
    expect(verdict.payload).toMatchObject({
      target: { produced_by_agent_id: "coder" },
      outcome: "approve",
      max_severity: "NONE",
      quorum: { required: 2, eligible: 2, met: true },
      rule: "majority-non-author",
      excluded: [],
      errors: [],
    });
    const reviews = (verdict.payload as Record<string, unknown>).reviews as Array<Record<string, unknown>>;
    expect(reviews.map((review) => review.agent)).toEqual(["r1", "r2"]);
    expect(reviews.every((review) => (review.findings as Record<string, unknown>).inline === true)).toBe(true);
    expect(h.ctx.governance.decisions.some((decision) => decision.decision_type === "consensus_verdict")).toBe(true);
  });

  it("excludes the produced_by_agent_id author before quorum math", async () => {
    const h = await freshHarness();
    ok(await h.dispatch("flock.declare", {
      agents: [
        { id: "codex", transport: "fake", roles: ["coder", "reviewer"] },
        { id: "r1", transport: "fake", roles: ["reviewer"] },
      ],
    }));
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "author exclusion",
      roles: {
        coder: { agent: "codex" },
        reviewer: { panel: ["codex", "r1"], quorum: 1 },
      },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await approveFirstMergeApproval(h);
    await pollUntil(() => h.events.some((event) => event.name === "consensus_verdict"), "verdict");

    const verdict = h.events.find((event) => event.name === "consensus_verdict")!;
    expect(verdict.payload).toMatchObject({
      quorum: { required: 1, eligible: 1, met: true },
      excluded: [{ agent: "codex", reason: "produced_by_agent_id (author)" }],
    });
    const reviews = (verdict.payload as Record<string, unknown>).reviews as Array<Record<string, unknown>>;
    expect(reviews.map((review) => review.agent)).toEqual(["r1"]);
  });

  it("fails closed with consensus_degraded when author exclusion makes quorum unsatisfiable", async () => {
    const h = await freshHarness();
    ok(await h.dispatch("flock.declare", {
      agents: [
        { id: "author", transport: "fake", roles: ["coder", "reviewer"] },
        { id: "r1", transport: "fake", roles: ["reviewer"] },
      ],
    }));
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "quorum reject",
      roles: {
        coder: { agent: "author" },
        reviewer: { panel: ["author", "r1"], quorum: 2 },
      },
      policy: { on_quorum_unsatisfiable: "reject" },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await approveFirstMergeApproval(h);
    await pollUntil(() => h.events.some((event) => event.name === "consensus_degraded"), "degraded");
    await pollUntil(() => h.events.some((event) => event.name === "run_blocked"), "blocked");

    expect(h.events.some((event) => event.name === "consensus_verdict")).toBe(false);
    const degraded = h.events.find((event) => event.name === "consensus_degraded")!;
    expect(degraded.payload).toMatchObject({
      outcome: "reject",
      quorum: { required: 2, eligible: 1, met: false },
      reason: "quorum_unsatisfiable_after_author_exclusion",
    });
  });

  it("can degrade quorum explicitly and still emit a normal met:true verdict", async () => {
    const h = await freshHarness();
    ok(await h.dispatch("flock.declare", {
      agents: [
        { id: "author", transport: "fake", roles: ["coder", "reviewer"] },
        { id: "r1", transport: "fake", roles: ["reviewer"] },
      ],
    }));
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "quorum degrade",
      roles: {
        coder: { agent: "author" },
        reviewer: { panel: ["author", "r1"], quorum: 2 },
      },
      policy: { on_quorum_unsatisfiable: "degrade_quorum" },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await approveFirstMergeApproval(h);
    await pollUntil(() => h.events.some((event) => event.name === "consensus_degraded"), "degraded");
    await pollUntil(() => h.events.some((event) => event.name === "consensus_verdict"), "verdict");

    const degraded = h.events.find((event) => event.name === "consensus_degraded")!;
    expect(degraded.payload).toMatchObject({
      outcome: "degrade_quorum",
      policy_action: "degrade_quorum",
      quorum: { required: 2, eligible: 1, met: false },
    });
    const verdict = h.events.find((event) => event.name === "consensus_verdict")!;
    expect(verdict.payload).toMatchObject({
      quorum: { required: 1, eligible: 1, met: true },
      outcome: "approve",
    });
  });

  it("does not silently pass degrade_quorum when author exclusion leaves zero reviewers", async () => {
    const h = await freshHarness();
    ok(await h.dispatch("flock.declare", {
      agents: [
        { id: "author", transport: "fake", roles: ["coder", "reviewer"] },
      ],
    }));
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "zero eligible degrade",
      roles: {
        coder: { agent: "author" },
        reviewer: { panel: ["author"], quorum: 1 },
      },
      policy: { on_quorum_unsatisfiable: "degrade_quorum" },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await approveFirstMergeApproval(h);
    await pollUntil(() => h.events.some((event) => event.name === "consensus_degraded"), "degraded");
    await pollUntil(() => h.events.some((event) => event.name === "run_blocked"), "blocked");

    const degraded = h.events.find((event) => event.name === "consensus_degraded")!;
    expect(degraded.payload).toMatchObject({
      outcome: "degrade_quorum",
      policy_action: "degrade_quorum",
      quorum: { required: 1, eligible: 0, met: false },
    });
    expect(h.events.some((event) => event.name === "consensus_verdict")).toBe(false);
  });

  it("routes ask_human through the approval state machine before continuing", async () => {
    const h = await freshHarness({ semanticDecision: true });
    ok(await h.dispatch("flock.declare", {
      agents: [
        { id: "author", transport: "fake", roles: ["coder", "reviewer"] },
        { id: "r1", transport: "fake", roles: ["reviewer"] },
      ],
    }));
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "ask human",
      roles: {
        coder: { agent: "author" },
        reviewer: { panel: ["author", "r1"], quorum: 2 },
      },
      policy: { on_quorum_unsatisfiable: "ask_human" },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await approveFirstMergeApproval(h);
    await pollUntil(
      () => h.events.some((event) =>
        event.name === "approval_requested" &&
        (event.payload as Record<string, unknown>).kind === "semantic_decision"
      ),
      "semantic approval",
    );
    const semanticApproval = h.events.find((event) =>
      event.name === "approval_requested" &&
      (event.payload as Record<string, unknown>).kind === "semantic_decision"
    )!;
    ok(await h.dispatch("approval.resolve", {
      approval_id: (semanticApproval.payload as Record<string, unknown>).approval_id,
      decision: "approved",
      by: "user:test",
    }));
    await pollUntil(() => h.events.some((event) => event.name === "consensus_verdict"), "verdict");
    await pollUntil(() => h.events.some((event) => event.name === "run_merged"), "merged");

    expect(h.events.filter((event) => event.name === "approval_requested")).toHaveLength(2);
    expect(h.events.some((event) => event.name === "consensus_degraded")).toBe(true);
  });

  it("rejects read-only reviewers that require global mutation", async () => {
    const baseProfiles = rejectedProfiles("unsupported_isolation_profile");
    const registry = createAdapterRegistry(
      {
        fake: createFakeBackendFactory(),
        mutating: createFakeBackendFactory(),
      },
      {
        fake: createFakeRegistry().probe,
        mutating: (input) => ({
          status: "ready",
          harness_id: "mutating-reviewer",
          transport_class: input.transport,
          runtime_surfaces: [
            {
              runtime_surface: "headless",
              runtime_kind: "mutating-headless",
            actual_fidelity: "one_shot",
              surface_support: "supported",
              isolation_profiles: withProfile(baseProfiles, "read_only_review", {
                readiness: "ready",
              }),
              state_declaration_ref: "harness-state:mutating",
              global_mutation_required: true,
              declared_not_enforced: true,
            },
          ],
          resolved_roles: input.roles,
        }),
      },
    );
    const h = await freshHarness({ registry });
    ok(await h.dispatch("flock.declare", {
      agents: [
        { id: "coder", transport: "fake", roles: ["coder"] },
        { id: "mutating", transport: "mutating", roles: ["reviewer"] },
      ],
    }));

    const e = err(await h.dispatch("orchestrate.run", {
      goal: "global mutation reviewer",
      roles: {
        coder: { agent: "coder" },
        reviewer: { panel: ["mutating"], quorum: 1 },
      },
    }));

    expect(e.code).toBe(HOLP_ERROR_CODES.isolation_profile_rejected);
    expect(h.ctx.runs.size).toBe(0);
  });
});
