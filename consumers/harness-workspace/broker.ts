#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient, type EventFrame } from "../cli/wire.js";
import {
  createHarnessWorkspaceState,
  recordDiscovery,
  recordEvent,
  recordInitialize,
  recordRunAccepted,
  objectPayload,
  stringField,
  arrayPayload,
} from "./state.js";
import { createReplaySnapshot, exportReplaySnapshotJson } from "./replay.js";
import { attachJsonLineSocket, writeJsonLine } from "./socketJson.js";
import { createWorkspaceTuiFrame, type WorkspaceTuiFrameV1, type WorkspaceTuiMode } from "./tuiFrame.js";
import type { DiscoveredAgent, HarnessWorkspaceLocale, HarnessWorkspaceState } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const serverEntry = path.join(repoRoot, "daemon", "runtime", "server.ts");
const BASE_DIR = "/tmp/holp-harness-workspace";
const DISCOVER_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 20_000;
const DIRECT_USER_SESSION = "direct_user_session";

export type BrokerCommand =
  | { readonly type: "run"; readonly goal: string; readonly worker: string }
  | { readonly type: "refresh_workers" }
  | { readonly type: "approve"; readonly decision: ApprovalDecision; readonly reason: string }
  | { readonly type: "cancel"; readonly run_id?: string; readonly reason?: string }
  | { readonly type: "follow"; readonly agent: string }
  | { readonly type: "snapshot" };

export type BrokerResponse =
  | { readonly type: "ack"; readonly command: BrokerCommand["type"]; readonly run_id?: string; readonly worker?: string; readonly approval_id?: string; readonly socket_path?: string; readonly replay_path?: string }
  | { readonly type: "error"; readonly command?: string; readonly message: string };

export interface HarnessWorkspaceBrokerOptions {
  readonly transport?: string;
  readonly probe?: boolean;
  readonly locale?: HarnessWorkspaceLocale;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly daemonFactory?: () => Pick<DaemonClient, "call" | "onEvent" | "close">;
  readonly sessionId?: string;
  readonly baseDir?: string;
  readonly log?: (line: string) => void;
}

type BrokerDaemonClient = Pick<DaemonClient, "call" | "onEvent" | "close">;
type ApprovalDecision = "approved" | "rejected";

export class HarnessWorkspaceBroker {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly socketPath: string;
  readonly replayPath: string;

  private readonly transport: string;
  private readonly probe: boolean;
  private readonly locale: HarnessWorkspaceLocale;
  private readonly log?: (line: string) => void;
  private readonly daemon: BrokerDaemonClient;
  private readonly sockets = new Set<net.Socket>();
  private server?: net.Server;
  private state: HarnessWorkspaceState;
  private selectedAgentId: string | undefined;
  private mode: WorkspaceTuiMode = "overview";
  private replayWrittenAt: string | undefined;
  private closed = false;
  private replayWriteChain: Promise<void> = Promise.resolve();

  constructor(options: HarnessWorkspaceBrokerOptions = {}) {
    const env = options.env ?? process.env;
    this.transport = options.transport ?? defaultTransport(env);
    this.probe = options.probe ?? true;
    this.locale = options.locale ?? localeFromEnv(env) ?? "en-US";
    this.log = options.log;
    this.state = createHarnessWorkspaceState({ locale: this.locale, provenance: "unknown" });
    this.sessionId = options.sessionId ?? randomUUID();
    const baseDir = options.baseDir ?? BASE_DIR;
    this.sessionDir = path.join(baseDir, this.sessionId);
    this.socketPath = path.join(this.sessionDir, "broker.sock");
    this.replayPath = path.join(this.sessionDir, "replay.json");
    this.daemon = options.daemonFactory?.() ?? new DaemonClient({
      command: "tsx",
      args: [serverEntry],
      cwd: repoRoot,
      env: cleanEnv(env),
    });
    this.daemon.onEvent((event) => {
      this.state = recordEvent(this.state, event);
      void this.persistReplaySerialized();
      this.broadcastFrame();
    });
  }

  async start(): Promise<void> {
    await prepareSessionDirectory(this.sessionDir);
    const initialized = await this.daemon.call("initialize", {
      protocol_version: "0.1.8",
      client: { name: "holp-harness-workspace-broker", version: "0.1.0" },
      capabilities: {
        approval: { supported: true, kinds: ["merge_approval", "semantic_decision"] },
        consensus: { supported: true },
        gate_report: { supported: true },
        artifact_refs: { supported: true },
      },
    });
    this.state = recordInitialize(this.state, initialized);

    const discovery = await this.daemon.call<{ agents: readonly DiscoveredAgent[] }>(
      "flock.discover",
      { transports: [this.transport], probe: this.probe },
      DISCOVER_TIMEOUT_MS,
    );
    this.state = recordDiscovery(this.state, discovery);
    this.selectedAgentId = Object.keys(this.state.agents).sort()[0];

    await this.persistReplaySerialized();
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.handleSocket(socket));
      this.server = server;
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.log?.(`HOLP_HARNESS_BROKER_SOCKET=${this.socketPath}`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    await this.daemon.close();
    await this.replayWriteChain.catch(() => undefined);
    await rm(this.sessionDir, { recursive: true, force: true });
  }

  frame(): WorkspaceTuiFrameV1 {
    return createWorkspaceTuiFrame(this.state, {
      mode: this.mode,
      selectedAgentId: this.selectedAgentId,
      replayPath: this.replayPath,
      replayWrittenAt: this.replayWrittenAt,
    });
  }

  async handleCommand(command: unknown): Promise<BrokerResponse> {
    if (!isCommand(command)) {
      return { type: "error", message: "malformed broker command" };
    }

    switch (command.type) {
      case "run":
        return this.run(command);
      case "refresh_workers":
        return this.refreshWorkers();
      case "approve":
        return this.approve(command);
      case "cancel":
        return this.cancel(command);
      case "follow":
        this.selectedAgentId = command.agent;
        this.mode = "inspect";
        this.broadcastFrame();
        return { type: "ack", command: "follow" };
      case "snapshot":
        await this.persistReplaySerialized();
        this.broadcastFrame();
        return { type: "ack", command: "snapshot", socket_path: this.socketPath, replay_path: this.replayPath };
    }
  }

  private handleSocket(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
    writeJsonLine(socket, this.frame());
    attachJsonLineSocket(socket, {
      onMessage: (message) => {
        void this.dispatchSocketCommand(message).then((response) => {
          writeJsonLine(socket, response);
          if (response.type === "error") {
            writeJsonLine(socket, this.frame());
            this.broadcastFrame();
          }
        });
      },
      onMalformed: () => writeJsonLine(socket, { type: "error", message: "malformed JSON command" } satisfies BrokerResponse),
    });
  }

  private async run(command: Extract<BrokerCommand, { type: "run" }>): Promise<BrokerResponse> {
    let resolved = this.resolveWorker(command.worker);
    if (command.worker === "auto" && resolved.type === "error") {
      const refresh = await this.refreshWorkers();
      if (refresh.type === "error") {
        return { type: "error", command: "run", message: refresh.message };
      }
      resolved = this.resolveWorker(command.worker);
    }
    if (resolved.type === "error") {
      return { type: "error", command: "run", message: resolved.message };
    }
    this.selectedAgentId = resolved.agent.id;
    const coderRole = {
      agent: resolved.agent.id,
      ...(resolved.preferredRuntimeSurface ? { preferred_runtime_surface: resolved.preferredRuntimeSurface } : {}),
    };
    const run = await this.daemon.call<{ run_id: string; accepted: boolean }>("orchestrate.run", {
      goal: command.goal,
      roles: {
        coder: coderRole,
      },
    }, RUN_TIMEOUT_MS);
    this.state = recordRunAccepted(this.state, { ...run, agent_id: resolved.agent.id, goal: command.goal });
    await this.daemon.call("events.subscribe", { run_id: run.run_id, after_seq: 0 });
    await this.persistReplaySerialized();
    this.broadcastFrame();
    return { type: "ack", command: "run", run_id: run.run_id, worker: resolved.agent.id };
  }

  private async refreshWorkers(): Promise<BrokerResponse> {
    let discovery: { agents: readonly DiscoveredAgent[] };
    try {
      discovery = await this.daemon.call<{ agents: readonly DiscoveredAgent[] }>(
        "flock.discover",
        { transports: [this.transport], probe: this.probe },
        DISCOVER_TIMEOUT_MS,
      );
    } catch (error) {
      return { type: "error", command: "refresh_workers", message: `worker refresh failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    this.state = recordDiscovery(this.state, discovery, { replace: true });
    const ids = Object.keys(this.state.agents).sort();
    this.selectedAgentId = this.selectedAgentId && this.state.agents[this.selectedAgentId] ? this.selectedAgentId : ids[0];
    await this.persistReplaySerialized();
    this.broadcastFrame();
    return { type: "ack", command: "refresh_workers" };
  }

  private async approve(command: Extract<BrokerCommand, { type: "approve" }>): Promise<BrokerResponse> {
    const pending = pendingApproval(this.state);
    if (!pending) {
      return { type: "error", command: "approve", message: "no current pending approval" };
    }

    const baseParams = {
      approval_id: pending.approvalId,
      decision: command.decision,
      by: "user:harness-workspace",
      reason: command.reason,
    };
    if (pending.kind === "merge_approval") {
      await this.daemon.call("approval.resolve", baseParams);
      return { type: "ack", command: "approve", approval_id: pending.approvalId };
    }
    if (pending.kind !== "semantic_decision") {
      return { type: "error", command: "approve", message: `unsupported pending approval kind '${pending.kind}'` };
    }

    const audit = semanticApprovalAudit(this.state, command);
    if (audit.type === "error") {
      return { type: "error", command: "approve", message: audit.message };
    }
    await this.daemon.call("approval.resolve", { ...baseParams, ...audit.params });
    return { type: "ack", command: "approve", approval_id: pending.approvalId };
  }

  private resolveWorker(worker: string): { readonly type: "ok"; readonly agent: DiscoveredAgent; readonly preferredRuntimeSurface?: typeof DIRECT_USER_SESSION } | { readonly type: "error"; readonly message: string } {
    const realMode = this.transport !== "fake";
    if (worker === "auto") {
      const candidates = this.frame().agents
        .filter((agent) => isUsableWorker(agent, realMode))
        .sort((left, right) => left.id.localeCompare(right.id));
      const agent = candidates[0];
      return agent
        ? { type: "ok", agent, ...(realMode ? { preferredRuntimeSurface: DIRECT_USER_SESSION } : {}) }
        : { type: "error", message: "no usable direct_user_session worker found for --worker auto; run `holp refresh-workers`, inspect `workers`, or pass an explicit discovered non-fake direct worker" };
    }

    const agent = this.state.agents[worker];
    if (!agent) {
      return { type: "error", message: `unsupported worker '${worker}'; run \`holp refresh-workers\` and inspect \`workers\`` };
    }
    if (realMode && isFakeWorker(agent)) {
      return { type: "error", message: `worker '${worker}' is fake/demo-only and cannot be used in real mode; run \`holp refresh-workers\` and inspect \`workers\`` };
    }
    if (!isUsableWorker(agent, realMode)) {
      return {
        type: "error",
        message: realMode
          ? `worker '${worker}' is not usable: direct_user_session surface is not ready or owner_verified proof is missing; run \`holp refresh-workers\` and inspect \`workers\``
          : `worker '${worker}' is not usable: no supported runtime surface is advertised by the broker frame`,
      };
    }
    return { type: "ok", agent, ...(realMode ? { preferredRuntimeSurface: DIRECT_USER_SESSION } : {}) };
  }

  private async cancel(command: Extract<BrokerCommand, { type: "cancel" }>): Promise<BrokerResponse> {
    const runId = command.run_id ?? this.state.run.run_id;
    if (!runId) return { type: "error", command: "cancel", message: "no run_id available to cancel" };
    await this.daemon.call("task.cancel", { run_id: runId, reason: command.reason ?? "harness workspace broker cancel" });
    return { type: "ack", command: "cancel", run_id: runId };
  }

  private broadcastFrame(): void {
    const frame = this.frame();
    for (const socket of this.sockets) writeJsonLine(socket, frame);
  }

  private async dispatchSocketCommand(command: unknown): Promise<BrokerResponse> {
    try {
      return await this.handleCommand(command);
    } catch (error) {
      const parsed = commandType(command);
      return {
        type: "error",
        ...(parsed ? { command: parsed } : {}),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private persistReplaySerialized(): Promise<void> {
    const write = this.replayWriteChain
      .catch(() => undefined)
      .then(() => this.persistReplay());
    this.replayWriteChain = write;
    return write;
  }

  private async persistReplay(): Promise<void> {
    const snapshot = createReplaySnapshot(this.state, {
      inspectAgentId: this.selectedAgentId,
      eventLimit: 200,
      evidenceLimit: 50,
      logLimit: 100,
      previewLimit: 512,
    });
    const json = exportReplaySnapshotJson(snapshot);
    const tempPath = `${this.replayPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tempPath, json, "utf8");
    await rename(tempPath, this.replayPath);
    this.replayWrittenAt = snapshot.created_at;
  }
}

export async function runBrokerCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseBrokerArgs(argv);
  const broker = new HarnessWorkspaceBroker({
    transport: options.transport,
    probe: options.probe,
    sessionId: options.sessionId,
    locale: options.locale,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  const shutdown = async () => {
    await broker.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await broker.start();
  return new Promise<number>(() => undefined);
}

function defaultTransport(env: Readonly<Record<string, string | undefined>>): string {
  return env.HOLP_HARNESS_WORKSPACE_TRANSPORT ?? (env.HOLP_REGISTRY === "fake" ? "fake" : "mcp-codex");
}

function localeFromEnv(env: Readonly<Record<string, string | undefined>>): HarnessWorkspaceLocale | undefined {
  const locale = env.HOLP_HARNESS_LOCALE;
  if (locale === undefined || locale === "") return undefined;
  if (isHarnessWorkspaceLocale(locale)) return locale;
  throw new Error(`unsupported HOLP_HARNESS_LOCALE '${locale}'`);
}

async function prepareSessionDirectory(sessionDir: string): Promise<void> {
  const baseDir = path.dirname(sessionDir);
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  await chmod(baseDir, 0o700).catch(() => undefined);
  if (existsSync(path.join(sessionDir, "broker.sock"))) {
    throw new Error(`broker socket already exists: ${path.join(sessionDir, "broker.sock")}`);
  }
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await chmod(sessionDir, 0o700);
}

function cleanEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function isCommand(value: unknown): value is BrokerCommand {
  if (typeof value !== "object" || value === null) return false;
  const command = value as Partial<BrokerCommand>;
  if (command.type === "run") return typeof command.goal === "string" && typeof command.worker === "string";
  if (command.type === "refresh_workers") return true;
  if (command.type === "approve") {
    return (command.decision === "approved" || command.decision === "rejected")
      && typeof command.reason === "string"
      && command.reason.length > 0;
  }
  if (command.type === "cancel") return command.run_id === undefined || typeof command.run_id === "string";
  if (command.type === "follow") return typeof command.agent === "string";
  return command.type === "snapshot";
}

function commandType(value: unknown): BrokerCommand["type"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  return type === "run" || type === "refresh_workers" || type === "approve" || type === "cancel" || type === "follow" || type === "snapshot" ? type : undefined;
}

function isUsableWorker(agent: DiscoveredAgent, realMode: boolean): boolean {
  if (realMode && isFakeWorker(agent)) return false;
  if (agent.status !== undefined && agent.status !== "ready" && agent.status !== "active") return false;
  return agent.runtime_surfaces?.some((surface) => usableRuntimeSurface(surface, realMode)) ?? false;
}

function usableRuntimeSurface(surface: Record<string, unknown>, realMode: boolean): boolean {
  const support = stringField(surface, "surface_support");
  if (support !== "supported") return false;
  const runtimeSurface = stringField(surface, "runtime_surface");
  const runtimeKind = stringField(surface, "runtime_kind") ?? stringField(surface, "runtime_surface");
  if (!runtimeKind || runtimeKind.includes("stub")) return false;
  if (realMode && runtimeSurface !== DIRECT_USER_SESSION) return false;
  if (realMode && runtimeKind.includes("fake")) return false;
  return !realMode || directSurfaceReady(surface);
}

function directSurfaceReady(surface: Record<string, unknown>): boolean {
  const isolationProfiles = objectPayload(surface.isolation_profiles);
  const coderWorktree = objectPayload(isolationProfiles.coder_worktree);
  const directChannel = objectPayload(surface.direct_channel);
  return stringField(coderWorktree, "readiness") === "ready"
    && arrayPayload(directChannel.capability_bitmask).includes("owner_verified");
}

function isFakeWorker(agent: DiscoveredAgent): boolean {
  if (agent.id === "fake-agent" || agent.id.startsWith("fake-")) return true;
  return agent.runtime_surfaces?.some((surface) => {
    const runtimeKind = stringField(surface, "runtime_kind") ?? "";
    const declaration = stringField(surface, "state_declaration_ref") ?? "";
    return runtimeKind.includes("fake") || declaration.includes("fake");
  }) ?? false;
}

function pendingApproval(state: HarnessWorkspaceState): { readonly approvalId: string; readonly kind: string } | undefined {
  const approval = state.approval;
  if (approval?.state !== "requested" || !approval.approval_id) return undefined;
  const payload = objectPayload(approval.event.payload);
  const kind = stringField(payload, "kind");
  if (!kind) return undefined;
  return { approvalId: approval.approval_id, kind };
}

function semanticApprovalAudit(
  state: HarnessWorkspaceState,
  command: Extract<BrokerCommand, { type: "approve" }>,
): { readonly type: "ok"; readonly params: { readonly previous_gate_outcome: string; readonly new_gate_outcome: string; readonly artifact_refs: readonly string[] } } | { readonly type: "error"; readonly message: string } {
  const previous = state.gate?.reviewOutcome;
  if (!previous || previous === "none") {
    return {
      type: "error",
      message: "semantic_decision approval cannot be resolved: previous_gate_outcome is unavailable from broker state",
    };
  }
  return {
    type: "ok",
    params: {
      previous_gate_outcome: previous,
      new_gate_outcome: command.decision === "approved" ? "approved" : "rejected",
      artifact_refs: approvalArtifactRefs(state),
    },
  };
}

function approvalArtifactRefs(state: HarnessWorkspaceState): readonly string[] {
  const approvalPayload = objectPayload(state.approval?.event.payload);
  const provenance = objectPayload(approvalPayload.provenance);
  const refs = [
    ...state.artifactRefs,
    ...arrayPayload(approvalPayload.artifact_refs).filter((item): item is string => typeof item === "string"),
    stringField(approvalPayload, "artifact_id"),
    stringField(provenance, "artifact_id"),
  ].filter((item): item is string => typeof item === "string" && item.length > 0);
  return [...new Set(refs)].sort();
}

function parseBrokerArgs(argv: readonly string[]): {
  readonly transport?: string;
  readonly probe: boolean;
  readonly sessionId?: string;
  readonly locale?: HarnessWorkspaceLocale;
} {
  let transport: string | undefined;
  let sessionId: string | undefined;
  let locale: HarnessWorkspaceLocale | undefined;
  let probe = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--transport" && argv[index + 1]) {
      transport = argv[index + 1];
      index += 1;
    } else if (arg === "--session-id" && argv[index + 1]) {
      sessionId = argv[index + 1];
      index += 1;
    } else if (arg === "--locale" && argv[index + 1]) {
      const candidate = argv[index + 1];
      if (!isHarnessWorkspaceLocale(candidate)) {
        throw new Error(`unsupported --locale '${candidate}'`);
      }
      locale = candidate;
      index += 1;
    } else if (arg === "--probe=false") {
      probe = false;
    }
  }
  return { transport, probe, sessionId, locale };
}

function isHarnessWorkspaceLocale(value: string): value is HarnessWorkspaceLocale {
  return value === "en-US" || value === "zh-CN";
}

function isMain(): boolean {
  return process.argv[1] ? path.resolve(process.argv[1]) === __filename : false;
}

if (isMain()) {
  runBrokerCli().then((code) => {
    if (code !== 0) process.exit(code);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
