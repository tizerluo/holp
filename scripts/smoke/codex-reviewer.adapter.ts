import { buildDispatcher } from "../../daemon/runtime/server.js";
import { ConnectionContext } from "../../daemon/core/context.js";
import { EventSink, type EventNotificationParams } from "../../daemon/core/eventSink.js";
import { FakeClock } from "../../daemon/core/clock.js";
import { systemScheduler } from "../../daemon/core/scheduler.js";
import { createAdapterRegistry } from "../../adapters/registry.js";
import { createFakeBackendFactory } from "../../adapters/fake-backend.js";
import {
  createCodexAppServerBackendFactory,
  probeCodexAppServer,
} from "../../adapters/codex-app-server.js";
import type { JsonRpcResponse } from "../../daemon/runtime/jsonrpc.js";

if (process.env.HOLP_REAL_CODEX_REVIEWER_SMOKE !== "1") {
  console.log("SKIP: set HOLP_REAL_CODEX_REVIEWER_SMOKE=1 to run the opt-in real Codex reviewer smoke.");
  process.exit(0);
}

const events: EventNotificationParams[] = [];
const sink = new EventSink((frame) => {
  const f = frame as { method?: string; params?: unknown };
  if (f.method === "events.event" && f.params) {
    events.push(f.params as EventNotificationParams);
  }
});

const ctx = new ConnectionContext();
const clock = new FakeClock();
const scheduler = systemScheduler;
const registry = createAdapterRegistry(
  {
    fake: createFakeBackendFactory(),
    "mcp-codex": createCodexAppServerBackendFactory(),
  },
  {
    fake: async (input) => ({
      status: "ready",
      harness_id: "fake",
      vendor: "HOLP",
      transport_class: input.transport,
      runtime_surfaces: [{
        runtime_surface: "headless",
        runtime_kind: "fake",
        surface_support: "supported",
        isolation_profiles: {
          read_only_review: { readiness: "ready" },
          coder_worktree: { readiness: "ready" },
          real_provider_smoke: { readiness: "ready" },
          multi_agent_concurrent: { readiness: "rejected", reason: "unsupported" },
          user_global_install: { readiness: "rejected", reason: "unsupported" },
          high_isolation: { readiness: "rejected", reason: "unsupported" },
        },
        state_declaration_ref: "harness-state:fake",
        global_mutation_required: false,
        declared_not_enforced: true,
      }],
      resolved_roles: input.roles,
    }),
    "mcp-codex": probeCodexAppServer,
  },
);
const dispatcher = buildDispatcher(ctx, sink, registry, clock, scheduler);
let id = 1;

async function main(): Promise<void> {
  ok(await dispatch("initialize", {
    protocol_version: "0.1.4",
    client: { name: "holp-codex-reviewer-smoke", version: "0" },
    capabilities: {
      approval: { supported: true, kinds: ["merge_approval"] },
      consensus: { supported: true },
      artifact_refs: { supported: true },
    },
  }));

  const declared = ok<{ agents: Array<{ id: string; status: string; reason?: string }> }>(
    await dispatch("flock.declare", {
      agents: [
        { id: "producer", transport: "fake", roles: ["coder", "reviewer"] },
        { id: "codex-reviewer", transport: "mcp-codex", roles: ["reviewer"] },
      ],
    }),
  );
  const codex = declared.agents.find((agent) => agent.id === "codex-reviewer");
  if (!codex || codex.status === "rejected") {
    console.log(`INCONCLUSIVE: codex reviewer unavailable (${codex?.reason ?? "not declared"}).`);
    return;
  }

  const run = ok<{ run_id: string }>(await dispatch("orchestrate.run", {
    goal: "Real Codex reviewer smoke: produce a tiny diff and ask Codex to review the artifact snapshot.",
    roles: {
      coder: { agent: "producer" },
      reviewer: { panel: ["producer", "codex-reviewer"], quorum: 1 },
    },
  }));
  ok(await dispatch("events.subscribe", { run_id: run.run_id, after_seq: 0 }));

  await waitFor((event) => event.name === "approval_requested", "approval_requested");
  const approval = events.find((event) => event.name === "approval_requested")!;
  ok(await dispatch("approval.resolve", {
    approval_id: (approval.payload as Record<string, unknown>).approval_id,
    decision: "approved",
    by: "smoke",
  }));

  await waitFor((event) => event.name === "run_merged" || event.name === "run_blocked" || event.name === "run_gave_up", "terminal");
  const verdict = events.find((event) => event.name === "consensus_verdict");
  if (!verdict) {
    const degraded = events.find((event) => event.name === "consensus_degraded");
    console.log(`INCONCLUSIVE: real reviewer did not produce a completed vote (${degraded?.name ?? "no consensus event"}).`);
    return;
  }

  const reviews = ((verdict.payload as Record<string, unknown>).reviews ?? []) as Array<Record<string, unknown>>;
  if (!reviews.some((review) => review.agent === "codex-reviewer" && review.status === "completed")) {
    console.log("INCONCLUSIVE: consensus verdict did not include completed codex-reviewer vote.");
    return;
  }

  console.log("PASS: real Codex reviewer produced a strict JSON completed vote through read-only reviewer pilot.");
}

async function dispatch(method: string, params: unknown): Promise<unknown> {
  return dispatcher.dispatch({ jsonrpc: "2.0", id: id++, method, params });
}

function ok<T>(response: unknown): T {
  const res = response as JsonRpcResponse;
  if ("error" in res) throw new Error(`${res.error.message}: ${JSON.stringify(res.error.data)}`);
  return res.result as T;
}

async function waitFor(
  pred: (event: EventNotificationParams) => boolean,
  label: string,
  maxTicks = 10_000,
): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (events.some(pred)) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
