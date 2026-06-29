#!/usr/bin/env tsx
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachJsonLineSocket, writeJsonLine } from "./socketJson.js";
import type { BrokerCommand, BrokerResponse } from "./broker.js";
import { isWorkspaceTuiFrameV1, type WorkspaceTuiFrameV1 } from "./tuiFrame.js";

const DEFAULT_TIMEOUT_MS = 3000;
const __filename = fileURLToPath(import.meta.url);

export interface ControllerRunOptions {
  readonly goal: string;
  readonly worker: string;
  readonly socketPath?: string;
  readonly timeoutMs?: number;
}

export interface WorkersOptions {
  readonly socketPath?: string;
  readonly timeoutMs?: number;
}

export interface ApproveOptions {
  readonly decision: "approved" | "rejected";
  readonly reason: string;
  readonly socketPath?: string;
  readonly timeoutMs?: number;
}

export async function runControllerCommand(options: ControllerRunOptions): Promise<BrokerResponse> {
  const socketPath = options.socketPath ?? process.env.HOLP_HARNESS_BROKER_SOCKET;
  if (!socketPath) {
    throw new Error("HOLP_HARNESS_BROKER_SOCKET is required");
  }
  const command: BrokerCommand = { type: "run", goal: options.goal, worker: options.worker };
  return sendBrokerCommand(socketPath, command, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export async function approveCommand(options: ApproveOptions): Promise<BrokerResponse> {
  const socketPath = options.socketPath ?? process.env.HOLP_HARNESS_BROKER_SOCKET;
  if (!socketPath) {
    throw new Error("HOLP_HARNESS_BROKER_SOCKET is required");
  }
  const command: BrokerCommand = { type: "approve", decision: options.decision, reason: options.reason };
  return sendBrokerCommand(socketPath, command, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export async function listWorkersCommand(options: WorkersOptions = {}): Promise<WorkspaceTuiFrameV1> {
  const socketPath = options.socketPath ?? process.env.HOLP_HARNESS_BROKER_SOCKET;
  if (!socketPath) {
    throw new Error("HOLP_HARNESS_BROKER_SOCKET is required");
  }
  return readInitialTuiFrame(socketPath, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export function sendBrokerCommand(
  socketPath: string,
  command: BrokerCommand,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (result: BrokerResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      if (result.type === "error") reject(new Error(result.message));
      else resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`broker socket unavailable: ${error.message}`));
    };
    const timer = setTimeout(() => fail(new Error(`no live broker response within ${timeoutMs}ms`)), timeoutMs);
    socket.once("error", fail);
    socket.once("connect", () => writeJsonLine(socket, command));
    attachJsonLineSocket(socket, {
      onMessage: (message) => {
        if (isBrokerResponse(message)) finish(message);
      },
      onMalformed: () => fail(new Error("malformed broker response")),
    });
  });
}

function readInitialTuiFrame(socketPath: string, timeoutMs: number): Promise<WorkspaceTuiFrameV1> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (frame: WorkspaceTuiFrameV1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolve(frame);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`broker socket unavailable: ${error.message}`));
    };
    const timer = setTimeout(() => fail(new Error(`no live broker frame within ${timeoutMs}ms`)), timeoutMs);
    socket.once("error", fail);
    attachJsonLineSocket(socket, {
      onMessage: (message) => {
        if (isWorkspaceTuiFrameV1(message)) finish(message);
        else fail(new Error("malformed broker frame"));
      },
      onMalformed: () => fail(new Error("malformed broker frame")),
    });
  });
}

export async function runClientCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseClientArgs(argv);
  if (parsed.command === "workers") {
    const frame = await listWorkersCommand(parsed);
    process.stdout.write(parsed.json ? `${JSON.stringify(workersJson(frame))}\n` : formatWorkers(frame));
    return 0;
  }
  if (parsed.command === "status") {
    const frame = await listWorkersCommand(parsed);
    process.stdout.write(parsed.json ? `${JSON.stringify(statusJson(frame))}\n` : formatStatus(frame));
    return 0;
  }
  if (parsed.command === "approve") {
    const response = await approveCommand(parsed);
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return 0;
  }
  if (parsed.command === "run") {
    const response = await runControllerCommand(parsed);
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return 0;
  }
  throw new Error("unreachable client command");
}

type ParsedClientArgs =
  | ({ readonly command: "run" } & ControllerRunOptions)
  | ({ readonly command: "approve" } & ApproveOptions)
  | ({ readonly command: "workers" | "status"; readonly json: boolean } & WorkersOptions);

function parseClientArgs(argv: readonly string[]): ParsedClientArgs {
  const args = [...argv];
  const command = args.shift();
  if (command !== "run" && command !== "workers" && command !== "status" && command !== "approve") {
    throw new Error("usage: harness workspace client run --goal <goal> --worker auto|<agent> | workers [--json] | status [--json] | approve --decision approved|rejected --reason <reason>");
  }
  if (command === "workers" || command === "status") {
    let json = false;
    for (const arg of args) {
      if (arg === "--json") json = true;
    }
    return { command, json };
  }
  if (command === "approve") {
    let decision: "approved" | "rejected" | undefined;
    let reason: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const value = args[index + 1];
      if (arg === "--decision" && (value === "approved" || value === "rejected")) {
        decision = value;
        index += 1;
      } else if (arg === "--reason" && value) {
        reason = value;
        index += 1;
      }
    }
    if (!decision) throw new Error('--decision must be "approved" or "rejected"');
    if (!reason) throw new Error("--reason is required");
    return { command, decision, reason };
  }
  let goal: string | undefined;
  let worker: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--goal" && args[index + 1]) {
      goal = args[index + 1];
      index += 1;
    } else if (arg === "--worker" && args[index + 1]) {
      worker = args[index + 1];
      index += 1;
    }
  }
  if (!goal) throw new Error("--goal is required");
  if (!worker) throw new Error("--worker is required");
  return { command, goal, worker };
}

function isBrokerResponse(value: unknown): value is BrokerResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BrokerResponse>;
  return candidate.type === "ack" || candidate.type === "error";
}

function workersJson(frame: WorkspaceTuiFrameV1): {
  readonly selected_agent?: string;
  readonly degraded_reasons: readonly string[];
  readonly agents: WorkspaceTuiFrameV1["agents"];
  readonly readiness: WorkspaceTuiFrameV1["continuity"];
  readonly continuity: WorkspaceTuiFrameV1["continuity"];
} {
  return {
    selected_agent: frame.selected_agent,
    degraded_reasons: frame.degraded_reasons,
    agents: frame.agents,
    readiness: frame.continuity,
    continuity: frame.continuity,
  };
}

function statusJson(frame: WorkspaceTuiFrameV1): {
  readonly run_id?: string;
  readonly selected_worker?: string;
  readonly approval?: WorkspaceTuiFrameV1["approval"];
  readonly terminal?: WorkspaceTuiFrameV1["terminal"];
  readonly failure_reason?: string;
  readonly worker_session?: string;
  readonly attach_command?: string;
  readonly next_action: string;
} {
  return {
    run_id: frame.run_id,
    selected_worker: frame.selected_agent,
    approval: frame.approval,
    terminal: frame.terminal,
    failure_reason: frame.failures[0],
    worker_session: frame.worker_session,
    attach_command: frame.attach_command,
    next_action: nextSuggestedAction(frame),
  };
}

function formatWorkers(frame: WorkspaceTuiFrameV1): string {
  const readinessReasons = frame.continuity.reasons.length > 0 ? frame.continuity.reasons.join(", ") : "none";
  const lines = [
    `Selected: ${frame.selected_agent ?? "none"}`,
    frame.degraded_reasons.length > 0 ? `Degraded: ${frame.degraded_reasons.join(", ")}` : "Degraded: none",
    `Readiness: owner=${frame.continuity.owner_verified} continue=${frame.continuity.can_continue} rerun=${frame.continuity.can_rerun} inspect=${frame.continuity.can_inspect} replay_only=${frame.continuity.replay_only} reasons=${readinessReasons}`,
    "Workers:",
  ];
  for (const agent of frame.agents) {
    const runtime = agent.runtime_surfaces?.map((surface) => surface.runtime_kind ?? surface.runtime_surface ?? "unknown").join(", ") || "unknown";
    const selected = agent.id === frame.selected_agent ? " selected" : "";
    lines.push(`- ${agent.id}${selected} status=${agent.status ?? "unknown"} role=${agent.role ?? "unknown"} runtime=${runtime}`);
  }
  if (frame.agents.length === 0) lines.push("- none");
  return `${lines.join("\n")}\n`;
}

function formatStatus(frame: WorkspaceTuiFrameV1): string {
  const lines = [
    `Run: ${frame.run_id ?? "none"}`,
    `Selected worker: ${frame.selected_agent ?? "none"}`,
    `Approval: ${frame.approval ? formatObject(frame.approval) : "none"}`,
    `Terminal: ${frame.terminal ? formatObject(frame.terminal) : "pending"}`,
    `Failure reason: ${frame.failures[0] ?? "none"}`,
    `Worker session: ${frame.worker_session ?? "none"}`,
    `Attach command: ${frame.attach_command ?? "none"}`,
    `Next action: ${nextSuggestedAction(frame)}`,
  ];
  return `${lines.join("\n")}\n`;
}

function nextSuggestedAction(frame: WorkspaceTuiFrameV1): string {
  if (frame.approval?.state === "requested") {
    const id = frame.approval.approval_id ? ` ${frame.approval.approval_id}` : "";
    return `explain pending approval${id}, then run approve --decision approved|rejected --reason "<reason>"`;
  }
  if (frame.terminal) return "review terminal result and replay evidence";
  if (frame.failures.length > 0) return "inspect failure reason and decide whether to rerun";
  if (!frame.run_id) return 'inspect workers, then run --goal "<human goal>" --worker auto';
  if (frame.worker_session && frame.attach_command) return "worker session is attachable";
  return "wait for broker events or check status again";
}

function formatObject(value: Readonly<Record<string, unknown>>): string {
  return Object.entries(value)
    .map(([key, item]) => `${key}=${String(item)}`)
    .join(" ");
}

function isMain(): boolean {
  return process.argv[1] ? path.resolve(process.argv[1]) === __filename : false;
}

if (isMain()) {
  runClientCli().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
