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
} from "./state.js";
import { createReplaySnapshot, exportReplaySnapshotJson } from "./replay.js";
import { attachJsonLineSocket, writeJsonLine } from "./socketJson.js";
import { createWorkspaceTuiFrame, type WorkspaceTuiFrameV1, type WorkspaceTuiMode } from "./tuiFrame.js";
import type { DiscoveredAgent, HarnessWorkspaceState } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const serverEntry = path.join(repoRoot, "daemon", "runtime", "server.ts");
const BASE_DIR = "/tmp/holp-harness-workspace";
const DISCOVER_TIMEOUT_MS = 20_000;
const RUN_TIMEOUT_MS = 20_000;

export type BrokerCommand =
  | { readonly type: "run"; readonly goal: string; readonly worker: string }
  | { readonly type: "cancel"; readonly run_id?: string; readonly reason?: string }
  | { readonly type: "follow"; readonly agent: string }
  | { readonly type: "snapshot" };

export type BrokerResponse =
  | { readonly type: "ack"; readonly command: BrokerCommand["type"]; readonly run_id?: string; readonly socket_path?: string; readonly replay_path?: string }
  | { readonly type: "error"; readonly command?: string; readonly message: string };

export interface HarnessWorkspaceBrokerOptions {
  readonly transport?: string;
  readonly probe?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly daemonFactory?: () => Pick<DaemonClient, "call" | "onEvent" | "close">;
  readonly sessionId?: string;
  readonly baseDir?: string;
  readonly log?: (line: string) => void;
}

type BrokerDaemonClient = Pick<DaemonClient, "call" | "onEvent" | "close">;

export class HarnessWorkspaceBroker {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly socketPath: string;
  readonly replayPath: string;

  private readonly transport: string;
  private readonly probe: boolean;
  private readonly log?: (line: string) => void;
  private readonly daemon: BrokerDaemonClient;
  private readonly sockets = new Set<net.Socket>();
  private server?: net.Server;
  private state: HarnessWorkspaceState = createHarnessWorkspaceState({ provenance: "unknown" });
  private selectedAgentId: string | undefined;
  private mode: WorkspaceTuiMode = "overview";
  private replayWrittenAt: string | undefined;
  private closed = false;
  private replayWriteChain: Promise<void> = Promise.resolve();

  constructor(options: HarnessWorkspaceBrokerOptions = {}) {
    this.transport = options.transport ?? defaultTransport(options.env ?? process.env);
    this.probe = options.probe ?? true;
    this.log = options.log;
    this.sessionId = options.sessionId ?? randomUUID();
    const baseDir = options.baseDir ?? BASE_DIR;
    this.sessionDir = path.join(baseDir, this.sessionId);
    this.socketPath = path.join(this.sessionDir, "broker.sock");
    this.replayPath = path.join(this.sessionDir, "replay.json");
    this.daemon = options.daemonFactory?.() ?? new DaemonClient({
      command: "tsx",
      args: [serverEntry],
      cwd: repoRoot,
      env: cleanEnv(options.env ?? process.env),
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
    this.selectedAgentId = discovery.agents[0]?.id;

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
    if (!this.state.agents[command.worker]) {
      return { type: "error", command: "run", message: `unsupported worker '${command.worker}'` };
    }
    this.selectedAgentId = command.worker;
    const run = await this.daemon.call<{ run_id: string; accepted: boolean }>("orchestrate.run", {
      goal: command.goal,
      roles: {
        coder: {
          agent: command.worker,
        },
      },
    }, RUN_TIMEOUT_MS);
    this.state = recordRunAccepted(this.state, { ...run, agent_id: command.worker });
    await this.daemon.call("events.subscribe", { run_id: run.run_id, after_seq: 0 });
    await this.persistReplaySerialized();
    this.broadcastFrame();
    return { type: "ack", command: "run", run_id: run.run_id };
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
  if (command.type === "cancel") return command.run_id === undefined || typeof command.run_id === "string";
  if (command.type === "follow") return typeof command.agent === "string";
  return command.type === "snapshot";
}

function commandType(value: unknown): BrokerCommand["type"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  return type === "run" || type === "cancel" || type === "follow" || type === "snapshot" ? type : undefined;
}

function parseBrokerArgs(argv: readonly string[]): { readonly transport?: string; readonly probe: boolean; readonly sessionId?: string } {
  let transport: string | undefined;
  let sessionId: string | undefined;
  let probe = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--transport" && argv[index + 1]) {
      transport = argv[index + 1];
      index += 1;
    } else if (arg === "--session-id" && argv[index + 1]) {
      sessionId = argv[index + 1];
      index += 1;
    } else if (arg === "--probe=false") {
      probe = false;
    }
  }
  return { transport, probe, sessionId };
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
