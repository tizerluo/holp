import { createDefaultAdapterRegistry } from "../../adapters/registry.js";
import { FIRST_BATCH_TRANSPORTS } from "../../adapters/first-batch-harnesses.js";
import { createFakeBackendFactory } from "../../adapters/fake-backend.js";
import { buildDispatcher } from "../../daemon/runtime/server.js";
import { ConnectionContext } from "../../daemon/core/context.js";
import { EventSink } from "../../daemon/core/eventSink.js";
import { FakeClock } from "../../daemon/core/clock.js";
import type { AgentProbeResult } from "../../adapters/agent-backend.js";
import type { AdapterRegistry } from "../../adapters/registry.js";
import type { JsonRpcResponse } from "../../daemon/runtime/jsonrpc.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SmokeStatus = "PASS" | "SKIP" | "INCONCLUSIVE" | "FAIL";

if (process.env.HOLP_REAL_HARNESS_SMOKE !== "1") {
  console.log("SKIP HOLP_REAL_HARNESS_SMOKE=1 not set");
  process.exit(0);
}

const registry = createDefaultAdapterRegistry();
const results: Array<{ transport: string; status: SmokeStatus; detail: string }> = [];
const probeResults = new Map<string, AgentProbeResult>();
let nonReasonixAcpReadyTransport = "";
let reasonixAcpReason = "";
const smokeCwd = mkdtempSync(join(tmpdir(), "holp-harness-smoke-"));

try {
  for (const transport of FIRST_BATCH_TRANSPORTS) {
    try {
      const probe = await registry.probe({
        id: `${transport}-smoke`,
        transport,
        roles: ["coder", "reviewer", "tester", "architect"],
        cwd: smokeCwd,
        runtimeSurface: "headless",
        isolationProfile: "coder_worktree",
        runIntent: "smoke:harnesses",
        workspaceId: smokeCwd,
        sessionRouteKey: `${transport}-smoke`,
      });
      const acp = probe.runtime_surfaces?.find((surface) => surface.runtime_surface === "acp");
      probeResults.set(transport, probe);
      if (transport === "reasonix") {
        reasonixAcpReason = acp?.isolation_profiles.coder_worktree.reason ?? probe.reason ?? "unknown";
      } else if (acp?.isolation_profiles.coder_worktree.readiness === "ready") {
        nonReasonixAcpReadyTransport ||= transport;
      }
      results.push({
        transport,
        status: probe.status === "ready"
          ? "PASS"
          : probe.status === "degraded"
            ? "INCONCLUSIVE"
            : missingProviderBinary(probe) ? "SKIP" : "FAIL",
        detail: `${probe.status}${probe.reason ? `:${probe.reason}` : ""};acp=${surfaceDetail(acp)}`,
      });
    } catch (error) {
      results.push({
        transport,
        status: "FAIL",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const result of results) {
    console.log(`${result.status} ${result.transport} ${result.detail}`);
  }
  console.log(`INCONCLUSIVE reasonix_acp ${reasonixAcpReason || "not_reported"}`);
  const schedulable = nonReasonixAcpReadyTransport
    ? await acpSelectionSchedulable(nonReasonixAcpReadyTransport, probeResults.get(nonReasonixAcpReadyTransport)!)
    : { status: "FAIL" as const, detail: "no_non_reasonix_acp_ready_surface" };
  console.log(`${schedulable.status} non_reasonix_acp_ready_schedulable ${schedulable.detail}`);

  if (results.some((result) => result.status === "FAIL") || schedulable.status !== "PASS") {
    process.exitCode = 1;
  }
} finally {
  rmSync(smokeCwd, { recursive: true, force: true });
}

async function acpSelectionSchedulable(
  transport: string,
  probe: AgentProbeResult,
): Promise<{ status: SmokeStatus; detail: string }> {
  const selectionRegistry: AdapterRegistry = {
    resolve(candidate, surface = "headless") {
      return candidate === transport && surface === "acp" ? createFakeBackendFactory() : undefined;
    },
    hasTransport(candidate) {
      return candidate === transport;
    },
    async probe(input) {
      return {
        ...probe,
        transport_class: input.transport,
      };
    },
  };
  const ctx = new ConnectionContext();
  const dispatcher = buildDispatcher(ctx, new EventSink(() => {}), selectionRegistry, new FakeClock());
  let id = 1;
  const dispatch = (method: string, params: unknown): Promise<unknown> =>
    dispatcher.dispatch({ jsonrpc: "2.0", id: id++, method, params });
  try {
    return await withTimeout((async () => {
      ok(await dispatch("initialize", {
        protocol_version: "0.1.6",
        client: { name: "holp-harness-smoke", version: "0" },
        capabilities: { approval: { supported: true, kinds: ["merge_approval"] } },
      }));
      ok(await dispatch("flock.declare", {
        agents: [{ id: `${transport}-sched`, transport, roles: ["coder"] }],
      }));
      const run = ok<{ run_id: string }>(await dispatch("orchestrate.run", {
        goal: "HOLP ACP selection smoke",
        roles: {
          coder: {
            agent: `${transport}-sched`,
            preferred_runtime_surface: "acp",
          },
        },
      }));
      const runtime = ctx.runs.get(run.run_id)?.runtime;
      await dispatch("task.cancel", { run_id: run.run_id }).catch(() => undefined);
      return runtime?.runtime_surface === "acp"
        ? { status: "PASS" as const, detail: transport }
        : { status: "INCONCLUSIVE" as const, detail: "runtime_surface_not_acp" };
    })(), 5_000, { status: "INCONCLUSIVE" as const, detail: "orchestrate_selection_timeout" });
  } catch (error) {
    return {
      status: "INCONCLUSIVE",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function ok<T>(res: unknown): T {
  const response = res as JsonRpcResponse;
  if ("error" in response) throw new Error(response.error.message);
  return response.result as T;
}

function missingProviderBinary(probe: AgentProbeResult): boolean {
  return probe.missing?.some((item) =>
    item === "headless:missing_binary" ||
    item === "binary:tmux" ||
    item.startsWith("headless:missing_")
  ) ?? false;
}

function surfaceDetail(
  surface: NonNullable<AgentProbeResult["runtime_surfaces"]>[number] | undefined,
): string {
  if (!surface) return "missing";
  const profile = surface.isolation_profiles.coder_worktree;
  return `${profile.readiness}${profile.reason ? `:${profile.reason}` : ""}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs).unref?.()),
  ]);
}
