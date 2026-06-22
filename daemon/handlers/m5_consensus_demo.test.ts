import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildDispatcher } from "../runtime/server.js";
import { ConnectionContext } from "../core/context.js";
import { EventSink, type EventNotificationParams } from "../core/eventSink.js";
import { FakeClock } from "../core/clock.js";
import { FakeScheduler } from "../core/scheduler.js";
import { createFakeRegistry } from "../../adapters/registry.js";
import type { RuntimeSurfaceDeclaration } from "../../adapters/harness-declaration.js";
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

async function freshHarness(opts: { artifactRefs: boolean }): Promise<{
  ctx: ConnectionContext;
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
    client: { name: "m5-consensus-demo-test", version: "0" },
    capabilities: {
      approval: { supported: true, kinds: ["merge_approval"] },
      consensus: { supported: true },
      ...(opts.artifactRefs ? { artifact_refs: { supported: true } } : {}),
    },
  }));

  return { ctx, events, dispatch };
}

async function runM5Scenario(opts: { artifactRefs: boolean }): Promise<{
  h: Awaited<ReturnType<typeof freshHarness>>;
  runId: string;
  verdict: EventNotificationParams;
  merged: EventNotificationParams;
}> {
  const h = await freshHarness(opts);
  const declared = ok<{
    agents: Array<{
      id: string;
      runtime_surfaces: readonly RuntimeSurfaceDeclaration[];
    }>;
  }>(await h.dispatch("flock.declare", {
    agents: [
      { id: "producer", transport: "fake", roles: ["coder", "reviewer"] },
      { id: "r1", transport: "fake", roles: ["reviewer"] },
      { id: "r2", transport: "fake", roles: ["reviewer"] },
    ],
  }));
  assertFakeRuntimeMatrix(declared.agents[0].runtime_surfaces);

  const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
    goal: `M5 consensus demo artifact_refs=${String(opts.artifactRefs)}`,
    roles: {
      coder: { agent: "producer" },
      reviewer: { panel: ["producer", "r1", "r2"], quorum: 2 },
    },
  }));
  ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

  await pollUntil(() => h.events.some((event) => event.name === "approval_requested"), "approval_requested");
  const mergeApproval = h.events.find((event) => event.name === "approval_requested")!;
  ok(await h.dispatch("approval.resolve", {
    approval_id: (mergeApproval.payload as Record<string, unknown>).approval_id,
    decision: "approved",
    by: "user:test",
  }));

  await pollUntil(() => h.events.some((event) => event.name === "consensus_verdict"), "consensus_verdict");
  await pollUntil(() => h.events.some((event) => event.name === "run_merged"), "run_merged");

  return {
    h,
    runId: run_id,
    verdict: h.events.find((event) => event.name === "consensus_verdict")!,
    merged: h.events.find((event) => event.name === "run_merged")!,
  };
}

function assertFakeRuntimeMatrix(surfaces: readonly RuntimeSurfaceDeclaration[]): void {
  const bySurface = new Map(surfaces.map((surface) => [surface.runtime_surface, surface]));
  expect(bySurface.get("headless")).toMatchObject({
    runtime_kind: "fake",
    surface_support: "supported",
    global_mutation_required: false,
    declared_not_enforced: true,
  });
  expect(bySurface.get("headless")?.isolation_profiles.coder_worktree.readiness).toBe("ready");
  expect(bySurface.get("headless")?.isolation_profiles.read_only_review.readiness).toBe("ready");

  expect(bySurface.get("acp")).toMatchObject({
    runtime_kind: "fake-acp-unwired",
    surface_support: "unsupported",
  });
  expect(bySurface.get("acp")?.isolation_profiles.coder_worktree.readiness).toBe("rejected");

  expect(bySurface.get("direct_user_session")).toMatchObject({
    runtime_kind: "fake-direct-session-unwired",
    surface_support: "unknown",
    direct_channel: {
      attach: "unknown",
      observe: "unknown",
      read: "unknown",
      inject: "unknown",
      interrupt: "unknown",
      cancel: "unknown",
      owner_scope: "unknown",
    },
  });
  expect(bySurface.get("direct_user_session")?.isolation_profiles.read_only_review.readiness)
    .toBe("rejected");
}

describe("M5 multi-agent consensus demo contract", () => {
  it("uses artifact envelopes for reviewer findings when artifact_refs is negotiated", async () => {
    const { h, verdict, merged } = await runM5Scenario({ artifactRefs: true });

    expect(verdict.category).toBe("consensus");
    expect(verdict.payload).toMatchObject({
      target: { produced_by_agent_id: "producer" },
      outcome: "approve",
      max_severity: "NONE",
      quorum: { required: 2, eligible: 2, met: true },
      excluded: [{ agent: "producer", reason: "produced_by_agent_id (author)" }],
      errors: [],
    });

    const reviews = (verdict.payload as Record<string, unknown>).reviews as Array<Record<string, unknown>>;
    expect(reviews.map((review) => review.agent)).toEqual(["r1", "r2"]);

    const mergeApproval = h.events.find((event) => event.name === "approval_requested")!;
    const details = (mergeApproval.payload as Record<string, unknown>).details as Record<string, unknown>;
    expect(details.inline).toBeUndefined();
    expect(details).toMatchObject({
      type: "approval_details",
      mime: "application/json",
    });
    const approvalDetails = ok<Record<string, unknown>>(await h.dispatch("artifact.get", {
      artifact_id: details.artifact_id,
    }));
    expect((approvalDetails.envelope as Record<string, unknown>).sha256)
      .toBe(createHash("sha256").update(approvalDetails.content as string).digest("hex"));
    expect(JSON.parse(approvalDetails.content as string)).toMatchObject({
      tool: "write_file",
    });

    for (const review of reviews) {
      const findings = review.findings as Record<string, unknown>;
      expect(findings.inline).toBeUndefined();
      expect(findings.type).toBe("findings");
      expect(findings.mime).toBe("application/json");
      expect(typeof findings.artifact_id).toBe("string");

      const artifact = ok<Record<string, unknown>>(await h.dispatch("artifact.get", {
        artifact_id: findings.artifact_id,
      }));
      expect(artifact.envelope).toMatchObject(findings);
      expect((artifact.envelope as Record<string, unknown>).sha256)
        .toBe(createHash("sha256").update(artifact.content as string).digest("hex"));
      expect(JSON.parse(artifact.content as string)).toMatchObject({
        agent: review.agent,
        verdict: "approve",
        generated_by: "holp-fake-consensus-kernel",
      });
    }

    expect((merged.payload as Record<string, unknown>).artifact_id).toMatch(/^art_diff_/);
  });

  it("falls back to inline reviewer findings when artifact_refs is not negotiated", async () => {
    const { h, verdict } = await runM5Scenario({ artifactRefs: false });

    expect(h.ctx.initialized?.negotiated.artifact_refs.supported).toBe(false);
    const mergeApproval = h.events.find((event) => event.name === "approval_requested")!;
    const details = (mergeApproval.payload as Record<string, unknown>).details as Record<string, unknown>;
    expect(details).toMatchObject({
      inline: true,
      type: "approval_details",
      mime: "application/json",
      truncated: false,
    });

    const reviews = (verdict.payload as Record<string, unknown>).reviews as Array<Record<string, unknown>>;
    expect(reviews.map((review) => review.agent)).toEqual(["r1", "r2"]);
    for (const review of reviews) {
      const findings = review.findings as Record<string, unknown>;
      expect(findings).toMatchObject({
        inline: true,
        type: "findings",
        mime: "application/json",
        truncated: false,
      });
      expect(findings).not.toHaveProperty("artifact_id");
      expect(JSON.parse(findings.content as string)).toMatchObject({
        agent: review.agent,
        verdict: "approve",
      });
    }
  });

  it("keeps single-coder runs out of the consensus event stream", async () => {
    const h = await freshHarness({ artifactRefs: true });
    ok(await h.dispatch("flock.declare", {
      agents: [{ id: "producer", transport: "fake", roles: ["coder"] }],
    }));
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "single coder no consensus",
      roles: { coder: { agent: "producer" } },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));
    await pollUntil(() => h.events.some((event) => event.name === "approval_requested"), "approval_requested");
    const approval = h.events.find((event) => event.name === "approval_requested")!;
    ok(await h.dispatch("approval.resolve", {
      approval_id: (approval.payload as Record<string, unknown>).approval_id,
      decision: "approved",
      by: "user:test",
    }));
    await pollUntil(() => h.events.some((event) => event.name === "run_merged"), "run_merged");

    expect(h.events.some((event) => event.category === "consensus")).toBe(false);
    expect(h.events.some((event) => event.name === "consensus_verdict")).toBe(false);
  });

  it("rejects duplicate reviewer ids before they can satisfy quorum twice", async () => {
    const h = await freshHarness({ artifactRefs: true });
    ok(await h.dispatch("flock.declare", {
      agents: [
        { id: "producer", transport: "fake", roles: ["coder"] },
        { id: "r1", transport: "fake", roles: ["reviewer"] },
      ],
    }));

    const e = err(await h.dispatch("orchestrate.run", {
      goal: "duplicate reviewer quorum",
      roles: {
        coder: { agent: "producer" },
        reviewer: { panel: ["r1", "r1"], quorum: 2 },
      },
    }));

    expect(e.code).toBe(HOLP_ERROR_CODES.invalid_quorum);
    expect(h.ctx.runs.size).toBe(0);
  });

  it("keeps findings artifacts distinct when reviewer ids sanitize to the same string", async () => {
    const h = await freshHarness({ artifactRefs: true });
    ok(await h.dispatch("flock.declare", {
      agents: [
        { id: "producer", transport: "fake", roles: ["coder"] },
        { id: "r/1", transport: "fake", roles: ["reviewer"] },
        { id: "r_1", transport: "fake", roles: ["reviewer"] },
      ],
    }));
    const { run_id } = ok<{ run_id: string }>(await h.dispatch("orchestrate.run", {
      goal: "sanitize collision findings",
      roles: {
        coder: { agent: "producer" },
        reviewer: { panel: ["r/1", "r_1"], quorum: 2 },
      },
    }));
    ok(await h.dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await pollUntil(() => h.events.some((event) => event.name === "approval_requested"), "approval_requested");
    const approval = h.events.find((event) => event.name === "approval_requested")!;
    ok(await h.dispatch("approval.resolve", {
      approval_id: (approval.payload as Record<string, unknown>).approval_id,
      decision: "approved",
      by: "user:test",
    }));
    await pollUntil(() => h.events.some((event) => event.name === "consensus_verdict"), "consensus_verdict");

    const verdict = h.events.find((event) => event.name === "consensus_verdict")!;
    const reviews = (verdict.payload as Record<string, unknown>).reviews as Array<Record<string, unknown>>;
    const artifactIds = reviews.map((review) =>
      ((review.findings as Record<string, unknown>).artifact_id as string)
    );
    expect(new Set(artifactIds).size).toBe(2);
    expect(artifactIds.every((id) => id.includes("r_1"))).toBe(true);

    for (const review of reviews) {
      const findings = review.findings as Record<string, unknown>;
      const artifact = ok<Record<string, unknown>>(await h.dispatch("artifact.get", {
        artifact_id: findings.artifact_id,
      }));
      expect(JSON.parse(artifact.content as string)).toMatchObject({
        agent: review.agent,
        verdict: "approve",
      });
    }
  });
});
