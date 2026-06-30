#!/usr/bin/env tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHolpSamePaneLauncher, type SamePaneLauncherOptions, type SamePaneLauncherResult } from "../cmux-bridge/samePaneLauncher.js";
import { runClientCli } from "./client.js";

const __filename = fileURLToPath(import.meta.url);

export interface HolpCliDeps {
  readonly launchSamePane?: (options: SamePaneLauncherOptions) => Promise<SamePaneLauncherResult>;
  readonly runClient?: (argv: readonly string[]) => Promise<number>;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
}

export async function runHolpCli(argv: readonly string[] = process.argv.slice(2), deps: HolpCliDeps = {}): Promise<number> {
  const parsed = parseHolpArgs(argv);
  const runClient = deps.runClient ?? runClientCli;
  if (parsed.type === "client") return runClient(parsed.argv);

  const launchSamePane = deps.launchSamePane ?? runHolpSamePaneLauncher;
  const result = await launchSamePane({ goal: parsed.goal });
  (deps.stdout ?? process.stdout).write(`${JSON.stringify(result, null, 2)}\n`);
  return result.mode === "planned" ? 0 : 1;
}

type ParsedHolpArgs =
  | { readonly type: "launch"; readonly goal?: string }
  | { readonly type: "client"; readonly argv: readonly string[] };

export function parseHolpArgs(argv: readonly string[]): ParsedHolpArgs {
  const [command, ...rest] = argv;
  if (!command) return { type: "launch" };
  if (command === "demo") throw new Error("holp demo is not available; use real workers through holp run");
  if (command === "codex") return { type: "launch", goal: rest.join(" ") || undefined };
  if (command === "workers" || command === "status") return { type: "client", argv };
  if (command === "run") return { type: "client", argv: parseRunArgs(rest) };
  if (command === "approve") return { type: "client", argv: ["approve", "--decision", "approved", "--reason", reasonArg(rest)] };
  if (command === "reject") return { type: "client", argv: ["approve", "--decision", "rejected", "--reason", reasonArg(rest)] };
  return { type: "launch", goal: argv.join(" ") };
}

function parseRunArgs(args: readonly string[]): readonly string[] {
  if (args.includes("--goal")) return ["run", ...args];
  const workerIndex = args.indexOf("--worker");
  const goalParts = workerIndex === -1 ? args : args.slice(0, workerIndex);
  const worker = workerIndex === -1 ? undefined : args[workerIndex + 1];
  const goal = goalParts.join(" ");
  if (!goal) throw new Error('usage: holp run "<goal>" --worker auto|<agent>');
  return ["run", "--goal", goal, "--worker", worker ?? "auto"];
}

function reasonArg(args: readonly string[]): string {
  if (args[0] === "--reason" && args[1]) return args[1];
  const reason = args.join(" ");
  if (!reason) throw new Error('reason is required, for example: holp approve "looks safe"');
  return reason;
}

function isMain(): boolean {
  return process.argv[1] ? path.resolve(process.argv[1]) === __filename : false;
}

if (isMain()) {
  runHolpCli().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
