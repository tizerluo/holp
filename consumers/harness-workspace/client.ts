#!/usr/bin/env tsx
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachJsonLineSocket, writeJsonLine } from "./socketJson.js";
import type { BrokerCommand, BrokerResponse } from "./broker.js";

const DEFAULT_TIMEOUT_MS = 3000;
const __filename = fileURLToPath(import.meta.url);

export interface ControllerRunOptions {
  readonly goal: string;
  readonly worker: string;
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

export async function runClientCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseClientArgs(argv);
  const response = await runControllerCommand(parsed);
  process.stdout.write(`${JSON.stringify(response)}\n`);
  return 0;
}

function parseClientArgs(argv: readonly string[]): ControllerRunOptions {
  const args = [...argv];
  const command = args.shift();
  if (command !== "run") throw new Error("usage: harness workspace client run --goal <goal> --worker <agent>");
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
  return { goal, worker };
}

function isBrokerResponse(value: unknown): value is BrokerResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BrokerResponse>;
  return candidate.type === "ack" || candidate.type === "error";
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
