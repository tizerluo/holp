#!/usr/bin/env tsx
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import path from "path";
import { DaemonClient, RpcError, formatRawFrame, type EventFrame } from "./wire.js";
import {
  RunRenderer,
  arrayPayload,
  isTerminalEvent,
  objectPayload,
  renderArtifact,
  renderReviewFinding,
  renderRpcError,
  renderRuntimeMatrix,
  stringField,
} from "./renderer.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const serverEntry = path.join(repoRoot, "daemon", "runtime", "server.ts");

type Scenario = "single" | "consensus" | "degraded" | "real-reviewer";
type Decision = "approved" | "rejected";

interface CliOptions {
  readonly scenario: Scenario;
  readonly registry: "fake" | "default";
  readonly transport: string;
  readonly artifactRefs: boolean;
  readonly raw: boolean;
  readonly debug: boolean;
  readonly interactive: boolean;
  readonly decision?: Decision;
  readonly quorum: number;
  readonly cancelAfterApproval: boolean;
  readonly lateResolve: boolean;
  readonly goal: string;
}

interface ApprovalPayload {
  readonly approval_id: string;
  readonly kind?: string;
}

interface RunResult {
  readonly run_id: string;
  readonly accepted: boolean;
}

interface ArtifactResponse {
  readonly artifact_id: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly envelope?: unknown;
}

const TERMINAL_TIMEOUT_MS = 20000;

export function parseArgs(argv: readonly string[]): CliOptions {
  const args = [...argv];
  const command = args[0] === "run" ? args.shift() : "run";
  if (command !== "run") throw new Error(`unknown command '${command}'. Try: holp-cli run`);

  const values = new Map<string, string | boolean>();
  for (const arg of args) {
    if (!arg.startsWith("--")) throw new Error(`unexpected argument '${arg}'`);
    const [rawKey, rawValue] = arg.slice(2).split("=", 2);
    values.set(rawKey, rawValue ?? true);
  }

  const scenario = optionString(values, "scenario", "consensus") as Scenario;
  if (!["single", "consensus", "degraded", "real-reviewer"].includes(scenario)) {
    throw new Error(`invalid --scenario=${scenario}`);
  }
  const registry = optionString(values, "registry", scenario === "real-reviewer" ? "default" : "fake") as "fake" | "default";
  if (registry !== "fake" && registry !== "default") throw new Error("--registry must be fake or default");

  return {
    scenario,
    registry,
    transport: optionString(values, "transport", registry === "fake" ? "fake" : "mcp-codex"),
    artifactRefs: optionBool(values, "artifact-refs", true),
    raw: optionBool(values, "raw", false),
    debug: optionBool(values, "debug", false),
    interactive: optionBool(values, "interactive", false),
    decision: optionDecision(values.get("decision")),
    quorum: optionInt(values, "quorum", scenario === "single" ? 0 : 2),
    cancelAfterApproval: optionBool(values, "cancel-after-approval", false),
    lateResolve: optionBool(values, "late-resolve", false),
    goal: optionString(values, "goal", defaultGoal(scenario)),
  };
}

export async function runCli(options: CliOptions): Promise<number> {
  if (options.scenario === "real-reviewer") {
    console.log("real reviewer path: available as an opt-in smoke, not a default interactive CLI scenario");
    console.log("run: HOLP_REAL_CODEX_REVIEWER_SMOKE=1 npm run smoke:reviewer:codex");
    console.log("reason: PR9 keeps real provider execution behind explicit opt-in binary/auth/quota/read-only checks");
    return 0;
  }

  const renderer = new RunRenderer();
  const events: EventFrame[] = [];
  let subscriptionId: string | undefined;
  const client = new DaemonClient({
    command: "tsx",
    args: [serverEntry],
    cwd: repoRoot,
    env: { HOLP_REGISTRY: options.registry },
    raw: options.raw || options.debug,
    onRawFrame: (direction, frame) => {
      console.log(formatRawFrame(direction, frame));
    },
  });

  client.onEvent((event) => {
    events.push(event);
    for (const line of renderer.recordEvent(event)) console.log(line);
  });

  try {
    console.log("HOLP consumer CLI");
    console.log(`scenario=${options.scenario} registry=${options.registry} transport=${options.transport}`);
    console.log("source=daemon stdio JSON-RPC wire");

    const initialized = await client.call<{
      protocol_version: string;
      capabilities: Record<string, { supported?: boolean } | undefined>;
    }>("initialize", {
      protocol_version: "0.1.4",
      client: { name: "holp-consumer-cli", version: "0.1.0" },
      capabilities: {
        approval: { supported: true, kinds: ["merge_approval", "semantic_decision"] },
        consensus: { supported: true },
        ...(options.artifactRefs ? { artifact_refs: { supported: true } } : {}),
      },
    });
    console.log(
      `initialized protocol=${initialized.protocol_version} artifact_refs=${initialized.capabilities.artifact_refs?.supported ?? false}`,
    );

    const declared = await client.call<{
      agents: Array<{ id: string; status: string; runtime_surfaces?: readonly Record<string, unknown>[] }>;
    }>("flock.declare", { agents: declareAgents(options) });
    for (const agent of declared.agents) {
      for (const line of renderRuntimeMatrix(agent)) console.log(line);
    }

    const run = await client.call<RunResult>("orchestrate.run", orchestrateParams(options));
    console.log(`run accepted=${run.accepted} run_id=${run.run_id}`);

    const subscribed = await client.call<{ subscription_id: string; latest_seq: number }>("events.subscribe", {
      run_id: run.run_id,
      after_seq: 0,
    });
    subscriptionId = subscribed.subscription_id;
    console.log(`subscription=${subscribed.subscription_id} latest_seq=${subscribed.latest_seq}`);

    const approvalEvent = await findOrWait(events, client, (event) => event.name === "approval_requested", "approval_requested");
    const approval = objectPayload(approvalEvent.payload) as unknown as ApprovalPayload;
    if (options.cancelAfterApproval) {
      await client.call("task.cancel", { run_id: run.run_id, reason: "cli requested cancellation" });
      console.log("task.cancel sent");
    } else {
      const decision = await chooseDecision(options, approval);
      try {
        const resolved = await client.call<{ approval_id: string; accepted: boolean }>("approval.resolve", {
          approval_id: approval.approval_id,
          decision,
          by: options.interactive ? "user:cli" : "user:cli-auto",
        });
        console.log(`approval.resolve accepted=${resolved.accepted} decision=${decision}`);
      } catch (error) {
        reportRpcError("approval.resolve", error);
      }
    }

    const terminal = await findOrWait(events, client, (event) => isTerminalEvent(event.name), "terminal event", TERMINAL_TIMEOUT_MS);
    try {
      await renderConsensusArtifacts(client, events, options);
    } catch (error) {
      reportRpcError("consensus artifact.get", error);
    }
    try {
      await renderTerminalArtifact(client, terminal);
    } catch (error) {
      reportRpcError("terminal artifact.get", error);
    }

    if (options.lateResolve && approval.approval_id) {
      try {
        await client.call("approval.resolve", {
          approval_id: approval.approval_id,
          decision: "approved",
          by: "user:cli-late",
        });
      } catch (error) {
        reportRpcError("late approval.resolve", error);
      }
    }

    const summary = renderer.summary(run.run_id);
    console.log("summary:");
    console.log(`  terminal=${summary.terminal?.name ?? "none"}`);
    console.log(`  consensus=${summary.consensus?.name ?? summary.degraded?.name ?? "none"}`);
    console.log(`  events=${summary.seen_events}`);
    console.log(`  seq=${summary.seq_ok ? "contiguous" : "BROKEN"}`);
    for (const diagnostic of renderer.diagnostics()) console.log(`  seq diagnostic: ${diagnostic}`);
    return summary.terminal ? 0 : 1;
  } finally {
    if (subscriptionId) {
      try {
        await client.call("events.unsubscribe", { subscription_id: subscriptionId });
        console.log("events.unsubscribe sent");
      } catch (error) {
        reportRpcError("events.unsubscribe", error);
      }
    }
    await client.close();
  }
}

export async function chooseDecision(
  options: Pick<CliOptions, "interactive" | "decision">,
  approval: Pick<ApprovalPayload, "approval_id" | "kind">,
  ask = promptApproval,
): Promise<Decision> {
  if (options.decision) return options.decision;
  if (!options.interactive) return "approved";
  return ask(approval);
}

async function promptApproval(approval: Pick<ApprovalPayload, "approval_id" | "kind">): Promise<Decision> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`Approve ${approval.kind ?? "approval"} ${approval.approval_id}? [y/N] `, resolve);
  });
  rl.close();
  return /^y(es)?$/i.test(answer.trim()) ? "approved" : "rejected";
}

async function renderConsensusArtifacts(client: DaemonClient, events: readonly EventFrame[], options: CliOptions): Promise<void> {
  const verdict = events.find((event) => event.name === "consensus_verdict");
  if (!verdict) return;
  const payload = objectPayload(verdict.payload);
  const reviews = arrayPayload(payload.reviews) as Array<Record<string, unknown>>;
  for (const review of reviews) {
    const findings = objectPayload(review.findings);
    if (findings.inline === true) {
      for (const line of renderReviewFinding(review)) console.log(line);
      continue;
    }
    const artifactId = stringField(findings, "artifact_id");
    if (!artifactId) {
      for (const line of renderReviewFinding(review)) console.log(line);
      continue;
    }
    const artifact = await client.call<ArtifactResponse>("artifact.get", { artifact_id: artifactId });
    for (const line of renderReviewFinding(review, artifact)) console.log(line);
    if (options.debug) console.log(`  findings content=${artifact.content}`);
  }
}

async function renderTerminalArtifact(client: DaemonClient, terminal: EventFrame): Promise<void> {
  const payload = objectPayload(terminal.payload);
  const artifactId = stringField(payload, "artifact_id");
  if (!artifactId) return;
  const artifact = await client.call<ArtifactResponse>("artifact.get", { artifact_id: artifactId });
  console.log(renderArtifact(artifact));
}

function reportRpcError(prefix: string, error: unknown): void {
  if (error instanceof RpcError) {
    console.log(renderRpcError(prefix, error.payload));
  } else {
    console.log(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function findOrWait(
  events: readonly EventFrame[],
  client: DaemonClient,
  predicate: (event: EventFrame) => boolean,
  label: string,
  timeoutMs = 15000,
): Promise<EventFrame> {
  const existing = events.find(predicate);
  if (existing) return existing;
  return client.waitForEvent(predicate, label, timeoutMs);
}

function declareAgents(options: CliOptions): Array<Record<string, unknown>> {
  if (options.scenario === "single") {
    return [{ id: "coder", transport: options.transport, roles: ["coder"] }];
  }
  if (options.scenario === "degraded") {
    return [
      { id: "producer", transport: options.transport, roles: ["coder", "reviewer"] },
      { id: "r1", transport: options.transport, roles: ["reviewer"] },
    ];
  }
  return [
    { id: "producer", transport: options.transport, roles: ["coder", "reviewer"] },
    { id: "r1", transport: options.transport, roles: ["reviewer"] },
    { id: "r2", transport: options.transport, roles: ["reviewer"] },
  ];
}

function orchestrateParams(options: CliOptions): Record<string, unknown> {
  if (options.scenario === "single") {
    return {
      goal: options.goal,
      roles: { coder: { agent: "coder" } },
    };
  }
  if (options.scenario === "degraded") {
    return {
      goal: options.goal,
      roles: {
        coder: { agent: "producer" },
        reviewer: { panel: ["producer", "r1"], quorum: options.quorum || 2 },
      },
      policy: { on_quorum_unsatisfiable: "reject" },
    };
  }
  return {
    goal: options.goal,
    roles: {
      coder: { agent: "producer" },
      reviewer: { panel: ["producer", "r1", "r2"], quorum: options.quorum || 2 },
    },
  };
}

function optionString(values: Map<string, string | boolean>, key: string, fallback: string): string {
  const value = values.get(key);
  if (value === undefined) return fallback;
  if (typeof value !== "string") return "true";
  return value;
}

function optionBool(values: Map<string, string | boolean>, key: string, fallback: boolean): boolean {
  const value = values.get(key);
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(`--${key} must be true or false`);
}

function optionInt(values: Map<string, string | boolean>, key: string, fallback: number): number {
  const value = values.get(key);
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`--${key} requires a value`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${key} must be a non-negative integer`);
  return parsed;
}

function optionDecision(value: string | boolean | undefined): Decision | undefined {
  if (value === undefined) return undefined;
  if (value !== "approved" && value !== "rejected") {
    throw new Error("--decision must be approved or rejected");
  }
  return value;
}

function defaultGoal(scenario: Scenario): string {
  switch (scenario) {
    case "single":
      return "Fix the flaky test";
    case "degraded":
      return "Render a deterministic consensus degraded report";
    case "real-reviewer":
      return "Opt-in real reviewer pilot";
    case "consensus":
    default:
      return "Render a deterministic M5 consensus report";
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(parseArgs(process.argv.slice(2))).then((code) => {
    process.exit(code);
  }).catch((error) => {
    console.error("holp cli error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
