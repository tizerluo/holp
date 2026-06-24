#!/usr/bin/env tsx
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DaemonClient,
  RpcError,
  type EventFrame,
} from "../../consumers/cli/wire.js";
import {
  RunRenderer,
  isTerminalEvent,
  objectPayload,
  renderArtifact,
  renderRuntimeMatrix,
  stringField,
} from "../../consumers/cli/renderer.js";
import {
  renderSummaryReport,
  waitForPostTerminalGateReport,
} from "../../consumers/cli/index.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const serverEntry = path.join(repoRoot, "daemon", "runtime", "server.ts");

const DEFAULT_TRANSPORT = "kimi-code";
const DEFAULT_SURFACE = "acp";
const DISCOVER_TIMEOUT_MS = 180_000;
const RUN_STARTED_TIMEOUT_MS = 60_000;
const TERMINAL_TIMEOUT_MS = 180_000;

type RuntimeSurface = "headless" | "acp" | "direct_user_session";
type SmokeStatus = "PASS" | "FAIL" | "SKIP";

interface RuntimeSurfaceRow {
  readonly runtime_surface?: string;
  readonly isolation_profiles?: Record<string, { readonly readiness?: string; readonly reason?: string }>;
  readonly state_declaration_ref?: string;
  readonly [key: string]: unknown;
}

interface DiscoveredAgent {
  readonly id: string;
  readonly status?: string;
  readonly transport?: string;
  readonly version?: string;
  readonly reason?: string;
  readonly runtime_surfaces?: readonly RuntimeSurfaceRow[];
}

interface DiscoverResult {
  readonly agents: readonly DiscoveredAgent[];
}

interface RunResult {
  readonly run_id: string;
  readonly accepted: boolean;
}

interface ArtifactResponse {
  readonly artifact_id: string;
  readonly content?: string;
  readonly truncated?: boolean;
  readonly envelope?: unknown;
}

interface SmokeEnv {
  readonly HOLP_TERMINAL_CONSUMER_SMOKE?: string;
  readonly HOLP_TERMINAL_CONSUMER_TRANSPORT?: string;
  readonly HOLP_TERMINAL_CONSUMER_SURFACE?: string;
  readonly HOLP_TERMINAL_CONSUMER_FAILURE_TRANSPORT?: string;
  readonly HOLP_TERMINAL_CONSUMER_CMUX_READY?: string;
}

interface ReadySelection {
  readonly agent: DiscoveredAgent;
  readonly surface: RuntimeSurfaceRow;
  readonly readiness: string;
  readonly reason?: string;
}

export function terminalConsumerSmokeEnabled(env: SmokeEnv): boolean {
  return env.HOLP_TERMINAL_CONSUMER_SMOKE === "1";
}

export function normalizeRuntimeSurface(value: string | undefined): RuntimeSurface {
  const surface = value ?? DEFAULT_SURFACE;
  if (surface === "headless" || surface === "acp" || surface === "direct_user_session") {
    return surface;
  }
  throw new Error(`invalid HOLP_TERMINAL_CONSUMER_SURFACE=${surface}`);
}

export function selectReadyAgent(
  agents: readonly DiscoveredAgent[],
  requestedSurface: RuntimeSurface,
): ReadySelection {
  for (const agent of agents) {
    const surface = agent.runtime_surfaces?.find((row) => row.runtime_surface === requestedSurface);
    const profile = surface?.isolation_profiles?.coder_worktree;
    if (surface && profile?.readiness === "ready") {
      return {
        agent,
        surface,
        readiness: profile.readiness,
        reason: profile.reason,
      };
    }
  }
  const summary = agents.map((agent) =>
    `${agent.id}:${agent.status ?? "unknown"}:${agent.reason ?? "no_reason"}`
  ).join(",");
  throw new Error(`no ready ${requestedSurface} surface found in flock.discover result (${summary || "none"})`);
}

export function runtimeSurfaceFromRunStarted(event: EventFrame): string | undefined {
  const payload = objectPayload(event.payload);
  const runtime = objectPayload(payload.runtime);
  return stringField(runtime, "runtime_surface");
}

export function successMarkers(cmuxReady: boolean): readonly string[] {
  return [
    "PASS terminal-consumer-integration-ready",
    cmuxReady ? "INFO cmux_status=cmux-ready" : "INFO cmux_status=cmux-pending-user-validation",
  ];
}

export function failureTransportFor(selectedTransport: string, requested?: string): string {
  if (requested && requested !== selectedTransport) return requested;
  return selectedTransport === "cursor-agent" ? "reasonix" : "cursor-agent";
}

export async function waitForEventFromEvents(
  client: DaemonClient,
  events: readonly EventFrame[],
  predicate: (event: EventFrame) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<EventFrame> {
  const existing = events.find(predicate);
  if (existing) return existing;
  return client.waitForEvent(predicate, label, timeoutMs);
}

async function main(): Promise<number> {
  if (!terminalConsumerSmokeEnabled(process.env)) {
    console.log("SKIP HOLP_TERMINAL_CONSUMER_SMOKE=1 not set");
    return 0;
  }

  const transport = process.env.HOLP_TERMINAL_CONSUMER_TRANSPORT ?? DEFAULT_TRANSPORT;
  const surface = normalizeRuntimeSurface(process.env.HOLP_TERMINAL_CONSUMER_SURFACE);
  const failureTransport = failureTransportFor(
    transport,
    process.env.HOLP_TERMINAL_CONSUMER_FAILURE_TRANSPORT,
  );
  const cmuxReady = process.env.HOLP_TERMINAL_CONSUMER_CMUX_READY === "1";
  const smokeCwd = mkdtempSync(path.join(tmpdir(), "holp-terminal-consumer-"));
  const renderer = new RunRenderer();
  const events: EventFrame[] = [];
  let subscriptionId: string | undefined;

  const client = new DaemonClient({
    command: "tsx",
    args: [serverEntry],
    cwd: smokeCwd,
    env: {
      HOLP_REGISTRY: "",
      HOLP_REAL_HARNESS_SMOKE: process.env.HOLP_REAL_HARNESS_SMOKE ?? "",
      HOLP_REAL_HARNESS_DIRECT_SMOKE: process.env.HOLP_REAL_HARNESS_DIRECT_SMOKE ?? "",
    },
  });

  client.onEvent((event) => {
    events.push(event);
    for (const line of renderer.recordEvent(event)) console.log(`event: ${line}`);
  });

  try {
    console.log("HOLP terminal consumer smoke");
    console.log(`source=daemon stdio JSON-RPC wire cwd=${smokeCwd}`);
    console.log(`target transport=${transport} surface=${surface}`);
    console.log("cmux_claim=not_requested");

    const initialized = await client.call<{
      protocol_version: string;
      capabilities: Record<string, { supported?: boolean } | undefined>;
    }>("initialize", {
      protocol_version: "0.1.8",
      client: { name: "holp-terminal-consumer-smoke", version: "0.1.0" },
      capabilities: {
        approval: { supported: true, kinds: ["merge_approval", "semantic_decision"] },
        artifact_refs: { supported: true },
        gate_report: { supported: true },
      },
    });
    console.log(
      `initialize: protocol=${initialized.protocol_version} gate_report=${initialized.capabilities.gate_report?.supported ?? false}`,
    );

    const discovered = await client.call<DiscoverResult>(
      "flock.discover",
      { transports: [transport], probe: true },
      DISCOVER_TIMEOUT_MS,
    );
    if (discovered.agents.length === 0) {
      throw new Error(`flock.discover returned no agents for transport=${transport}`);
    }
    for (const agent of discovered.agents) {
      for (const line of renderRuntimeMatrix(agent)) console.log(line);
    }

    const selection = selectReadyAgent(discovered.agents, surface);
    const stateRef = selection.surface.state_declaration_ref ?? "none";
    console.log(
      `selected: agent=${selection.agent.id} transport=${selection.agent.transport ?? transport} ` +
        `surface=${surface} readiness=${selection.readiness} version=${selection.agent.version ?? "unknown"} ` +
        `state=${stateRef}`,
    );

    const failureDiscovery = await client.call<DiscoverResult>(
      "flock.discover",
      { transports: [failureTransport], probe: false },
      15_000,
    );
    const failureAgent = failureDiscovery.agents[0];
    if (failureAgent) {
      for (const line of renderRuntimeMatrix(failureAgent)) console.log(line);
      console.log(
        `failure_evidence: transport=${failureTransport} status=${failureAgent.status ?? "unknown"} ` +
          `reason=${failureAgent.reason ?? "not_reported"}`,
      );
    } else {
      console.log(`failure_evidence: transport=${failureTransport} status=omitted reason=unknown_transport`);
    }

    const run = await client.call<RunResult>("orchestrate.run", {
      goal: "HOLP terminal consumer smoke: reply with HOLP_TERMINAL_CONSUMER_OK and do not edit files.",
      roles: {
        coder: {
          agent: selection.agent.id,
          preferred_runtime_surface: surface,
        },
      },
    });
    console.log(`orchestrate.run: accepted=${run.accepted} run_id=${run.run_id}`);

    const subscribed = await client.call<{ subscription_id: string; latest_seq: number }>("events.subscribe", {
      run_id: run.run_id,
      after_seq: 0,
    });
    subscriptionId = subscribed.subscription_id;
    console.log(`events.subscribe: id=${subscribed.subscription_id} latest_seq=${subscribed.latest_seq}`);

    const started = await waitForEventFromEvents(
      client,
      events,
      (event) => event.run_id === run.run_id && event.name === "run_started",
      "run_started",
      RUN_STARTED_TIMEOUT_MS,
    );
    const observedSurface = runtimeSurfaceFromRunStarted(started);
    console.log(`surface_match: requested=${surface} observed=${observedSurface ?? "missing"}`);
    if (observedSurface !== surface) {
      throw new Error(`runtime surface mismatch: requested=${surface} observed=${observedSurface ?? "missing"}`);
    }

    try {
      const cancelled = await client.call("task.cancel", {
        run_id: run.run_id,
        reason: "terminal consumer smoke control evidence",
      });
      console.log(`control_evidence: task.cancel accepted ${JSON.stringify(cancelled)}`);
    } catch (error) {
      console.log(`control_evidence: task.cancel rejected ${describeError(error)}`);
    }

    const terminal = await waitForEventFromEvents(
      client,
      events,
      (event) => event.run_id === run.run_id && isTerminalEvent(event.name),
      "terminal event",
      TERMINAL_TIMEOUT_MS,
    );
    console.log(`terminal: ${terminal.name}`);

    await waitForPostTerminalGateReport(events, client, run.run_id, terminal, {
      enabled: initialized.capabilities.gate_report?.supported === true,
      timeoutMs: 1_000,
    });

    await renderTerminalArtifactIfPresent(client, terminal);

    const summary = renderer.summary(run.run_id);
    console.log("summary:");
    for (const line of renderSummaryReport(summary, "human")) console.log(line);
    for (const diagnostic of renderer.diagnostics()) console.log(`  seq diagnostic: ${diagnostic}`);
    if (!summary.terminal) throw new Error("missing terminal event in rendered summary");

    console.log(
      `consumer_state: run_id=${run.run_id} events=${summary.seen_events} ` +
        `terminal=${summary.terminal.name} gate=${summary.gate_report ? "present" : "none"}`,
    );
    for (const marker of successMarkers(cmuxReady)) console.log(marker);
    if (cmuxReady) {
      console.log("WARN cmux_status was supplied by env; ensure a real cmux automation/user validation record exists.");
    }
    return 0;
  } catch (error) {
    console.error(`FAIL terminal-consumer-integration-ready ${describeError(error)}`);
    return 1;
  } finally {
    if (subscriptionId) {
      try {
        await client.call("events.unsubscribe", { subscription_id: subscriptionId }, 5_000);
      } catch {
        // Best-effort cleanup after the smoke outcome has already been decided.
      }
    }
    await client.close();
    rmSync(smokeCwd, { recursive: true, force: true });
  }
}

async function renderTerminalArtifactIfPresent(client: DaemonClient, terminal: EventFrame): Promise<void> {
  const payload = objectPayload(terminal.payload);
  const artifactId = stringField(payload, "artifact_id");
  if (!artifactId) {
    console.log("artifact_summary: none");
    return;
  }
  const artifact = await client.call<ArtifactResponse>("artifact.get", { artifact_id: artifactId }, 15_000);
  console.log(renderArtifact({
    artifact_id: artifact.artifact_id,
    content: artifact.content,
    truncated: artifact.truncated,
    envelope: artifact.envelope,
  }));
}

function describeError(error: unknown): string {
  if (error instanceof RpcError) {
    return `rpc code=${error.payload.code} message=${error.payload.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
