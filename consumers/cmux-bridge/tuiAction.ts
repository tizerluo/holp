#!/usr/bin/env tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertValidCmuxLayoutCommand, cmuxCommandArgs, resolveCmuxCommand, runCmuxCapturingOutput } from "./commands.js";
import { buildControllerBootPrompt } from "./tuiLauncher.js";
import {
  addManifestDegradedReason,
  addManifestSurface,
  assertOwnedSendCommand,
  isHolpWorkerSession,
  parseCmuxSurface,
  readCmuxTuiSessionManifest,
  recordManifestCommandResult,
  writeCmuxTuiSessionManifest,
  type CmuxTuiSessionManifest,
} from "./tuiManifest.js";
import type { CmuxCommandResult, CmuxDegradedReason, CmuxLayoutCommand } from "./types.js";
import { sendBrokerCommand } from "../harness-workspace/client.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const RUN_TIMEOUT_MS = 120_000;

export type CmuxTuiActionName =
  | "open_controller_pane"
  | "send_controller_boot_prompt"
  | "start_run_via_broker"
  | "follow_run_id"
  | "open_worker_attach_pane"
  | "copy_run_id"
  | "copy_attach_command"
  | "cancel_run"
  | "interrupt_worker";

export interface CmuxTuiActionOptions {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly cmuxCommand?: string;
  readonly runner?: (
    cmuxCommand: string,
    args: readonly string[],
    cwd: string,
    timeoutMs?: number,
  ) => Promise<CmuxCommandResult>;
  readonly brokerCommandSender?: typeof sendBrokerCommand;
}

export interface CmuxTuiActionResult {
  readonly action: CmuxTuiActionName;
  readonly ok: boolean;
  readonly degraded_reasons: readonly CmuxDegradedReason[];
  readonly manifest?: CmuxTuiSessionManifest;
  readonly output?: string;
}

export async function runCmuxTuiAction(options: CmuxTuiActionOptions = {}): Promise<CmuxTuiActionResult> {
  const env = options.env ?? process.env;
  const parsed = parseActionArgs(options.argv ?? process.argv.slice(2));
  if (!parsed.action) throw new Error("usage: harness workspace tui action <action> --session-id <id>");

  if (env.HOLP_HARNESS_WORKSPACE_TUI !== "1") {
    return degraded(parsed.action, "execution_not_enabled");
  }

  let manifest: CmuxTuiSessionManifest;
  try {
    manifest = readCmuxTuiSessionManifest({
      sessionId: parsed.sessionId,
      brokerSocket: parsed.brokerSocket,
    });
  } catch (error) {
    return degraded(parsed.action, error instanceof Error && error.message === "missing_session_selector"
      ? "missing_session_selector"
      : "invalid_command");
  }

  const cmuxCommand = options.cmuxCommand ?? resolveCmuxCommand(env);
  const runner = options.runner ?? runCmuxCapturingOutput;
  const cwd = options.cwd ?? repoRoot;
  const sender = options.brokerCommandSender ?? sendBrokerCommand;

  switch (parsed.action) {
    case "send_controller_boot_prompt":
      return sendControllerBootPrompt({ manifest, parsed, cmuxCommand, runner, cwd });
    case "open_controller_pane":
      return openControllerPane({ manifest, parsed, cmuxCommand, runner, cwd });
    case "open_worker_attach_pane":
      return openWorkerAttachPane({ manifest, parsed, cmuxCommand, runner, cwd });
    case "start_run_via_broker": {
      const goal = parsed.goal ?? "Use HOLP through the broker and report the worker result marker.";
      const worker = parsed.worker;
      if (!worker) return { action: parsed.action, ok: false, degraded_reasons: ["invalid_command"], manifest, output: "--worker is required" };
      return sendBrokerAction(parsed.action, manifest, () =>
        sender(manifest.broker_socket, { type: "run", goal, worker }, parsed.timeoutMs ?? RUN_TIMEOUT_MS));
    }
    case "follow_run_id": {
      const agent = parsed.agent ?? parsed.worker;
      if (!agent) return { action: parsed.action, ok: false, degraded_reasons: ["invalid_command"], manifest, output: "--agent or --worker is required" };
      return sendBrokerAction(parsed.action, manifest, () =>
        sender(manifest.broker_socket, { type: "follow", agent }, 10_000));
    }
    case "cancel_run": {
      if (!parsed.confirm) return { action: parsed.action, ok: false, degraded_reasons: ["confirmation_required"], manifest };
      return sendBrokerAction(parsed.action, manifest, () =>
        sender(manifest.broker_socket, { type: "cancel", run_id: parsed.runId, reason: "operator action cancel" }, 30_000));
    }
    case "copy_run_id":
      return { action: parsed.action, ok: Boolean(parsed.runId), degraded_reasons: parsed.runId ? [] : ["invalid_command"], manifest, output: parsed.runId };
    case "copy_attach_command": {
      const session = parsed.workerSession;
      if (!isHolpWorkerSession(session)) return { action: parsed.action, ok: false, degraded_reasons: ["missing_worker_session"], manifest };
      return { action: parsed.action, ok: true, degraded_reasons: [], manifest, output: `tmux attach -t ${session}` };
    }
    case "interrupt_worker":
      return { action: parsed.action, ok: false, degraded_reasons: ["unsupported_action"], manifest };
  }
}

async function sendBrokerAction(
  action: CmuxTuiActionName,
  manifest: CmuxTuiSessionManifest,
  send: () => Promise<unknown>,
): Promise<CmuxTuiActionResult> {
  try {
    const response = await send();
    return { action, ok: true, degraded_reasons: [], manifest, output: JSON.stringify(response) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { action, ok: false, degraded_reasons: ["cmux_command_failed"], manifest, output: message };
  }
}

async function sendControllerBootPrompt(options: ActionRuntime): Promise<CmuxTuiActionResult> {
  const surface = options.manifest.surfaces.controller;
  if (!surface) return withManifestReason(options.manifest, "surface_not_owned", "send_controller_boot_prompt");
  const text = buildControllerBootPrompt({
    brokerSocket: options.manifest.broker_socket,
    goal: options.parsed.goal ?? "Use HOLP through the broker and report the worker result marker.",
    worker: options.parsed.worker,
    controller: options.parsed.controller ?? manifestControllerAgent(surface.agent) ?? "codex",
  });
  const command = sendCommand(options.manifest.workspace_id, surface.surface_id, text, "HOLP Controller");
  const ownershipErrors = assertOwnedSendCommand(options.manifest, command);
  if (ownershipErrors.length > 0) return withManifestReason(options.manifest, "surface_not_owned", "send_controller_boot_prompt");
  const result = await options.runner(options.cmuxCommand, cmuxCommandArgs(command), options.cwd);
  const manifest = recordManifestCommandResult(options.manifest, result);
  writeCmuxTuiSessionManifest(manifest);
  return { action: "send_controller_boot_prompt", ok: result.ok, degraded_reasons: result.ok ? [] : ["cmux_command_failed"], manifest };
}

async function openControllerPane(options: ActionRuntime): Promise<CmuxTuiActionResult> {
  const result = await createTerminalSurface(options, "controller", "down");
  let manifest = recordManifestCommandResult(options.manifest, result.result);
  if (!result.surfaceId) return withManifestReason(manifest, "missing_surface_handle", "open_controller_pane");
  manifest = addManifestSurface(manifest, "controller", {
    surface_id: result.surfaceId,
    pane_id: result.paneId,
    agent: options.parsed.controller ?? "codex",
    last_command: result.result.command,
  });
  writeCmuxTuiSessionManifest(manifest);
  return { action: "open_controller_pane", ok: true, degraded_reasons: [], manifest };
}

async function openWorkerAttachPane(options: ActionRuntime): Promise<CmuxTuiActionResult> {
  const workerSession = options.parsed.workerSession;
  if (!workerSession) return withManifestReason(options.manifest, "missing_worker_session", "open_worker_attach_pane");
  if (!isHolpWorkerSession(workerSession)) return withManifestReason(options.manifest, "non_holp_worker_session", "open_worker_attach_pane");
  const result = await createTerminalSurface(options, "worker_attach", "down");
  let manifest = recordManifestCommandResult(options.manifest, result.result);
  if (!result.surfaceId) return withManifestReason(manifest, "missing_surface_handle", "open_worker_attach_pane");
  manifest = addManifestSurface(manifest, "worker_attach", {
    surface_id: result.surfaceId,
    pane_id: result.paneId,
    last_command: result.result.command,
  });
  writeCmuxTuiSessionManifest(manifest);
  const command = sendCommand(manifest.workspace_id, result.surfaceId, `tmux attach -t ${workerSession}\n`, "HOLP Worker Attach");
  const ownershipErrors = assertOwnedSendCommand(manifest, command);
  if (ownershipErrors.length > 0) return withManifestReason(manifest, "surface_not_owned", "open_worker_attach_pane");
  const sendResult = await options.runner(options.cmuxCommand, cmuxCommandArgs(command), options.cwd);
  manifest = recordManifestCommandResult(manifest, sendResult);
  writeCmuxTuiSessionManifest(manifest);
  return { action: "open_worker_attach_pane", ok: sendResult.ok, degraded_reasons: sendResult.ok ? [] : ["cmux_command_failed"], manifest };
}

async function createTerminalSurface(
  options: ActionRuntime,
  role: "controller" | "worker_attach",
  direction: "right" | "down",
): Promise<{ readonly result: CmuxCommandResult; readonly surfaceId?: string; readonly paneId?: string }> {
  const command: CmuxLayoutCommand = {
    name: "new-pane",
    args: ["--workspace", options.manifest.workspace_id, "--type", "terminal", "--direction", direction, "--focus", "false"],
    target: { kind: "mission-control", title: role === "controller" ? "HOLP Controller" : "HOLP Worker Attach" },
  };
  assertValidCmuxLayoutCommand(command);
  const result = await options.runner(options.cmuxCommand, cmuxCommandArgs(command), options.cwd);
  const parsed = parseCmuxSurface(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return { result, surfaceId: result.ok ? parsed.surfaceId : undefined, paneId: result.ok ? parsed.paneId : undefined };
}

function sendCommand(workspaceId: string, surfaceId: string, text: string, title: string): CmuxLayoutCommand {
  return {
    name: "send",
    args: ["--workspace", workspaceId, "--surface", surfaceId, "--", text],
    target: { kind: "mission-control", title },
    contentCommand: text,
  };
}

interface ActionRuntime {
  readonly manifest: CmuxTuiSessionManifest;
  readonly parsed: ParsedActionArgs;
  readonly cmuxCommand: string;
  readonly runner: NonNullable<CmuxTuiActionOptions["runner"]>;
  readonly cwd: string;
}

interface ParsedActionArgs {
  readonly action?: CmuxTuiActionName;
  readonly sessionId?: string;
  readonly brokerSocket?: string;
  readonly controller?: "codex" | "kimi-code";
  readonly goal?: string;
  readonly worker?: string;
  readonly workerSession?: string;
  readonly runId?: string;
  readonly agent?: string;
  readonly confirm: boolean;
  readonly timeoutMs?: number;
}

function parseActionArgs(argv: readonly string[]): ParsedActionArgs {
  const action = argv[0] as CmuxTuiActionName | undefined;
  let sessionId: string | undefined;
  let brokerSocket: string | undefined;
  let controller: "codex" | "kimi-code" | undefined;
  let goal: string | undefined;
  let worker: string | undefined;
  let workerSession: string | undefined;
  let runId: string | undefined;
  let agent: string | undefined;
  let timeoutMs: number | undefined;
  let confirm = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--session-id" && value) {
      sessionId = value;
      index += 1;
    } else if (arg === "--broker-socket" && value) {
      brokerSocket = value;
      index += 1;
    } else if (arg === "--controller" && (value === "codex" || value === "kimi-code")) {
      controller = value;
      index += 1;
    } else if (arg === "--goal" && value) {
      goal = value;
      index += 1;
    } else if (arg === "--worker" && value) {
      worker = value;
      index += 1;
    } else if (arg === "--worker-session" && value) {
      workerSession = value;
      index += 1;
    } else if (arg === "--run-id" && value) {
      runId = value;
      index += 1;
    } else if (arg === "--agent" && value) {
      agent = value;
      index += 1;
    } else if (arg === "--timeout-ms" && value) {
      const parsedTimeout = Number(value);
      timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : undefined;
      index += 1;
    } else if (arg === "--confirm") {
      confirm = true;
    }
  }
  return { action, sessionId, brokerSocket, controller, goal, worker, workerSession, runId, agent, confirm, timeoutMs };
}

function manifestControllerAgent(agent: string | undefined): "codex" | "kimi-code" | undefined {
  return agent === "codex" || agent === "kimi-code" ? agent : undefined;
}

function degraded(action: CmuxTuiActionName, reason: CmuxDegradedReason): CmuxTuiActionResult {
  return { action, ok: false, degraded_reasons: [reason] };
}

function withManifestReason(
  manifest: CmuxTuiSessionManifest,
  reason: CmuxDegradedReason,
  action: CmuxTuiActionName,
): CmuxTuiActionResult {
  const updated = addManifestDegradedReason(manifest, reason);
  writeCmuxTuiSessionManifest(updated);
  return { action, ok: false, degraded_reasons: [reason], manifest: updated };
}

async function runCli(): Promise<number> {
  const result = await runCmuxTuiAction();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
