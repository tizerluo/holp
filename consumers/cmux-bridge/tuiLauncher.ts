#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertValidCmuxLayoutCommand,
  cmuxCommandArgs,
  cmuxWorkspaceFromEnv,
  resolveCmuxCommand,
  runCmuxCapturingOutput,
} from "./commands.js";
import {
  addManifestDegradedReason,
  addManifestSurface,
  createCmuxTuiSessionManifest,
  parseCmuxSurface,
  recordManifestCommandResult,
  sessionDirForSession,
  writeCmuxTuiSessionManifest,
  type CmuxTuiSessionManifest,
} from "./tuiManifest.js";
import type { CmuxCommandResult, CmuxDegradedReason, CmuxLayoutCommand } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const DEFAULT_GOAL = "Use HOLP through the broker and report the worker result marker.";
const DEMO_WORKER = "fake-agent";

export interface CmuxTuiLauncherOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly cmuxCommand?: string;
  readonly runner?: CmuxTuiCommandRunner;
  readonly isOnPath?: (command: string) => boolean;
  readonly now?: string;
}

export type CmuxTuiCommandRunner = (
  cmuxCommand: string,
  args: readonly string[],
  cwd: string,
  timeoutMs?: number,
) => Promise<CmuxCommandResult>;

export interface CmuxTuiLauncherResult {
  readonly mode: "degraded" | "planned";
  readonly manifest: CmuxTuiSessionManifest;
  readonly manifest_path: string;
  readonly degraded_reasons: readonly CmuxDegradedReason[];
}

export async function runCmuxTuiLauncher(options: CmuxTuiLauncherOptions = {}): Promise<CmuxTuiLauncherResult> {
  const env = options.env ?? process.env;
  const parsed = parseLauncherArgs(options.argv ?? process.argv.slice(2));
  if (env.HOLP_HARNESS_WORKSPACE_TUI !== "1") {
    return {
      mode: "degraded",
      manifest: createCmuxTuiSessionManifest({
        sessionId: parsed.sessionId ?? sessionIdFromExistingBroker(parsed.brokerSocket) ?? "disabled",
        workspaceId: parsed.workspace ?? cmuxWorkspaceFromEnv(env) ?? "missing",
        brokerSocket: parsed.brokerSocket ?? "",
        now: options.now,
      }),
      manifest_path: "",
      degraded_reasons: ["execution_not_enabled"],
    };
  }

  const workspaceId = parsed.workspace ?? cmuxWorkspaceFromEnv(env);
  const sessionId = parsed.sessionId ?? sessionIdFromExistingBroker(parsed.brokerSocket) ?? randomUUID();
  const shouldStartBroker = !parsed.brokerSocket;
  const brokerSocket = parsed.brokerSocket ?? path.join(sessionDirForSession(sessionId), "broker.sock");
  let manifest = createCmuxTuiSessionManifest({
    sessionId,
    workspaceId: workspaceId ?? "missing",
    brokerSocket,
    now: options.now,
  });

  const finish = (mode: CmuxTuiLauncherResult["mode"]): CmuxTuiLauncherResult => {
    const manifestPath = writeCmuxTuiSessionManifest(manifest);
    return { mode, manifest, manifest_path: manifestPath, degraded_reasons: manifest.degraded_reasons };
  };

  if (!workspaceId) {
    manifest = addManifestDegradedReason(manifest, "missing_workspace");
    return finish("degraded");
  }

  const controller = parsed.controller ?? "codex";
  const controllerBinary = controllerBinaryName(controller);
  const isOnPath = options.isOnPath ?? defaultIsOnPath;
  if (!parsed.demo && !isOnPath(controllerBinary)) {
    manifest = addManifestDegradedReason(manifest, "missing_controller_binary");
    return finish("degraded");
  }

  const cmuxCommand = options.cmuxCommand ?? resolveCmuxCommand(env);
  const runner = options.runner ?? runCmuxCapturingOutput;
  const cwd = options.cwd ?? repoRoot;
  const probe = await probeCmuxTuiCapabilities({ cmuxCommand, runner, cwd, workspaceId });
  for (const result of probe.results) manifest = recordManifestCommandResult(manifest, result);
  if (!probe.ok) {
    manifest = addManifestDegradedReason(manifest, "missing_cmux_capability");
    return finish("degraded");
  }

  const tui = await createTerminalSurface({
    cmuxCommand,
    runner,
    cwd,
    workspaceId,
    direction: "right",
    role: "tui",
  });
  manifest = recordManifestCommandResult(manifest, tui.result);
  if (!tui.surfaceId) {
    manifest = addManifestDegradedReason(manifest, "missing_surface_handle");
    return finish("degraded");
  }
  manifest = addManifestSurface(manifest, "tui", {
    surface_id: tui.surfaceId,
    pane_id: tui.paneId,
    last_command: tui.result.command,
  });
  writeCmuxTuiSessionManifest(manifest);

  const tuiCommand = buildTuiStartupCommand({
    brokerSocket,
    sessionId,
    startBroker: shouldStartBroker,
    transport: parsed.demo ? "fake" : parsed.transport,
    locale: parsed.locale,
    env: parsed.demo ? { HOLP_REGISTRY: "fake" } : undefined,
  });
  const tuiSend = sendCommand(workspaceId, tui.surfaceId, tuiCommand, { kind: "mission-control", title: "HOLP TUI" });
  assertValidCmuxLayoutCommand(tuiSend);
  manifest = recordCmuxMutationResult(manifest, await runner(cmuxCommand, cmuxCommandArgs(tuiSend), cwd));

  const controllerSurface = await createTerminalSurface({
    cmuxCommand,
    runner,
    cwd,
    workspaceId,
    direction: "down",
    role: "controller",
  });
  manifest = recordManifestCommandResult(manifest, controllerSurface.result);
  if (!controllerSurface.surfaceId) {
    manifest = addManifestDegradedReason(manifest, "missing_surface_handle");
    return finish("degraded");
  }
  manifest = addManifestSurface(manifest, "controller", {
    surface_id: controllerSurface.surfaceId,
    pane_id: controllerSurface.paneId,
    agent: controller,
    last_command: controllerSurface.result.command,
  });
  writeCmuxTuiSessionManifest(manifest);

  const bootPrompt = buildControllerBootPrompt({
    brokerSocket,
    goal: parsed.goal ?? DEFAULT_GOAL,
    worker: parsed.demo ? DEMO_WORKER : parsed.worker,
    controller,
    controllerAutostart: parsed.controllerAutostart,
  });
  const controllerSend = sendCommand(workspaceId, controllerSurface.surfaceId, bootPrompt, {
    kind: "mission-control",
    title: "HOLP Controller",
  });
  assertValidCmuxLayoutCommand(controllerSend);
  manifest = recordCmuxMutationResult(manifest, await runner(cmuxCommand, cmuxCommandArgs(controllerSend), cwd));
  for (const command of sidebarCommands(workspaceId, sessionId)) {
    assertValidCmuxLayoutCommand(command);
    manifest = recordCmuxMutationResult(manifest, await runner(cmuxCommand, cmuxCommandArgs(command), cwd));
  }

  return finish(manifest.degraded_reasons.length > 0 ? "degraded" : "planned");
}

function recordCmuxMutationResult(
  manifest: CmuxTuiSessionManifest,
  result: CmuxCommandResult,
): CmuxTuiSessionManifest {
  const updated = recordManifestCommandResult(manifest, result);
  return result.ok ? updated : addManifestDegradedReason(updated, "cmux_command_failed");
}

export async function probeCmuxTuiCapabilities(options: {
  readonly cmuxCommand: string;
  readonly runner: CmuxTuiCommandRunner;
  readonly cwd: string;
  readonly workspaceId: string;
}): Promise<{ readonly ok: boolean; readonly results: readonly CmuxCommandResult[] }> {
  const results = [
    await options.runner(options.cmuxCommand, ["new-pane", "--help"], options.cwd, 5_000),
    await options.runner(options.cmuxCommand, ["send", "--help"], options.cwd, 5_000),
  ];
  const output = results.map((result) => `${result.stdout ?? ""}\n${result.stderr ?? ""}`).join("\n");
  const ok = results.every((result) => result.ok)
    && output.includes("--workspace")
    && output.includes("--surface")
    && output.includes("--focus")
    && output.includes("--type <terminal");
  return { ok, results };
}

export function buildControllerBootPrompt(options: {
  readonly brokerSocket: string;
  readonly goal: string;
  readonly worker?: string;
  readonly controller: "codex" | "kimi-code";
  readonly controllerAutostart?: boolean;
}): string {
  const instructionRepoRoot = cmuxSafeText(repoRoot);
  const brokerSocket = cmuxSafeText(options.brokerSocket);
  const goal = cmuxSafeText(options.goal);
  const worker = options.worker ? cmuxSafeText(options.worker) : undefined;
  const workersCommand = `HOLP_HARNESS_BROKER_SOCKET=${shellQuote(brokerSocket)} npm run harness:workspace:client -- workers`;
  const runCommand = worker
    ? `HOLP_HARNESS_BROKER_SOCKET=${shellQuote(brokerSocket)} npm run harness:workspace:client -- run --goal ${shellQuote(goal)} --worker ${shellQuote(worker)}`
    : undefined;
  const controllerCommand = options.controller === "codex" ? "codex" : "kimi";
  const instructions = [
    "HOLP Harness Workspace Controller",
    `Repo: ${instructionRepoRoot}`,
    `Broker: ${brokerSocket}`,
    "Use HOLP public wire through the broker; do not start a second daemon.",
    `List workers first: ${workersCommand}`,
    runCommand ? `Run command: ${runCommand}` : "No worker is selected yet. Run the workers command first, then choose a listed worker id.",
    `Controller CLI: ${controllerCommand}`,
  ];
  const printInstructions = `node -e ${shellQuote(`console.log(${JSON.stringify(instructions)}.join(String.fromCharCode(10)))`)}`;
  const autostart = options.controllerAutostart ? ` && ${controllerCommand}` : "";
  return `cd ${shellQuote(repoRoot)} && ${printInstructions}${autostart}\n`;
}

export function buildTuiStartupCommand(options: {
  readonly brokerSocket: string;
  readonly sessionId: string;
  readonly startBroker?: boolean;
  readonly transport?: string;
  readonly locale?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): string {
  const brokerLog = path.join(sessionDirForSession(options.sessionId), "broker.log");
  const envPrefix = shellEnvPrefix({
    ...options.env,
    ...(options.locale ? { HOLP_HARNESS_LOCALE: options.locale } : {}),
  });
  const brokerArgs = [
    "--session-id",
    shellQuote(options.sessionId),
    ...(options.transport ? ["--transport", shellQuote(options.transport)] : []),
    ...(options.locale ? ["--locale", shellQuote(options.locale)] : []),
  ].join(" ");
  const lines = [
    `cd ${shellQuote(repoRoot)} || exit 1`,
    `for i in $(seq 1 80); do [ -S ${shellQuote(options.brokerSocket)} ] && break; sleep 0.25; done`,
    `${shellEnvPrefix({ HOLP_HARNESS_BROKER_SOCKET: options.brokerSocket, ...(options.locale ? { HOLP_HARNESS_LOCALE: options.locale } : {}) })}npm run harness:workspace:tui`,
    "\n",
  ];
  if (options.startBroker !== false) {
    lines.splice(1, 0, `${envPrefix}npm run harness:workspace:broker -- ${brokerArgs} > ${shellQuote(brokerLog)} 2>&1 &`);
  }
  return lines.join("\n");
}

function sendCommand(workspaceId: string, surfaceId: string, text: string, target: CmuxLayoutCommand["target"]): CmuxLayoutCommand {
  return {
    name: "send",
    args: ["--workspace", workspaceId, "--surface", surfaceId, "--", text],
    target,
    contentCommand: text,
  };
}

async function createTerminalSurface(options: {
  readonly cmuxCommand: string;
  readonly runner: CmuxTuiCommandRunner;
  readonly cwd: string;
  readonly workspaceId: string;
  readonly direction: "right" | "down";
  readonly role: "tui" | "controller";
}): Promise<{ readonly result: CmuxCommandResult; readonly surfaceId?: string; readonly paneId?: string }> {
  const command: CmuxLayoutCommand = {
    name: "new-pane",
    args: ["--workspace", options.workspaceId, "--type", "terminal", "--direction", options.direction, "--focus", "false"],
    target: {
      kind: "mission-control",
      title: options.role === "tui" ? "HOLP Harness Workspace TUI" : "HOLP Controller CLI",
    },
  };
  assertValidCmuxLayoutCommand(command);
  const result = await options.runner(options.cmuxCommand, cmuxCommandArgs(command), options.cwd);
  const parsed = parseCmuxSurface(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return { result, surfaceId: result.ok ? parsed.surfaceId : undefined, paneId: result.ok ? parsed.paneId : undefined };
}

function sidebarCommands(workspaceId: string, sessionId: string): readonly CmuxLayoutCommand[] {
  return [
    {
      name: "set-status",
      args: ["holp-harness-workspace", "tui-ready", "--workspace", workspaceId, "--color", "#34c759"],
      target: { kind: "mission-control", title: "HOLP Harness Workspace" },
    },
    {
      name: "set-progress",
      args: ["0.5", "--label", "HOLP Harness Workspace active", "--workspace", workspaceId],
      target: { kind: "mission-control", title: "HOLP Harness Workspace" },
    },
    {
      name: "log",
      args: ["--workspace", workspaceId, "--level", "info", "--", `HOLP Harness Workspace TUI session=${sessionId}`],
      target: { kind: "mission-control", title: "HOLP Harness Workspace" },
    },
  ];
}

function parseLauncherArgs(argv: readonly string[]): {
  readonly workspace?: string;
  readonly sessionId?: string;
  readonly brokerSocket?: string;
  readonly controller?: "codex" | "kimi-code";
  readonly worker?: string;
  readonly goal?: string;
  readonly demo: boolean;
  readonly controllerAutostart: boolean;
  readonly transport?: string;
  readonly locale?: string;
} {
  let workspace: string | undefined;
  let sessionId: string | undefined;
  let brokerSocket: string | undefined;
  let controller: "codex" | "kimi-code" | undefined;
  let worker: string | undefined;
  let goal: string | undefined;
  let demo = false;
  let controllerAutostart = false;
  let transport: string | undefined;
  let locale: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--workspace" && value) {
      workspace = value;
      index += 1;
    } else if (arg === "--session-id" && value) {
      sessionId = value;
      index += 1;
    } else if (arg === "--broker-socket" && value) {
      brokerSocket = value;
      index += 1;
    } else if (arg === "--controller" && (value === "codex" || value === "kimi-code")) {
      controller = value;
      index += 1;
    } else if (arg === "--worker" && value) {
      worker = value;
      index += 1;
    } else if (arg === "--goal" && value) {
      goal = value;
      index += 1;
    } else if (arg === "--demo") {
      demo = true;
    } else if (arg === "--controller-autostart") {
      controllerAutostart = true;
    } else if (arg === "--transport" && value) {
      transport = value;
      index += 1;
    } else if (arg === "--locale" && value) {
      locale = value;
      index += 1;
    }
  }
  return { workspace, sessionId, brokerSocket, controller, worker, goal, demo, controllerAutostart, transport, locale };
}

function controllerBinaryName(controller: "codex" | "kimi-code"): string {
  return controller === "codex" ? "codex" : "kimi";
}

function defaultIsOnPath(command: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    try {
      accessSync(path.join(dir, command), constants.X_OK);
      return true;
    } catch {
      // Keep searching.
    }
  }
  return false;
}

function sessionIdFromExistingBroker(brokerSocket: string | undefined): string | undefined {
  if (!brokerSocket) return undefined;
  const match = brokerSocket.match(/\/tmp\/holp-harness-workspace\/([^/]+)\/broker\.sock$/);
  return match?.[1];
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function shellEnvPrefix(env: Readonly<Record<string, string | undefined>>): string {
  const assignments = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  return assignments.length > 0 ? `${assignments.join(" ")} ` : "";
}

function cmuxSafeText(value: string): string {
  return value.replaceAll(/[\n\r\t]+/g, " ");
}

async function runCli(): Promise<number> {
  const result = await runCmuxTuiLauncher();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.mode === "planned" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
