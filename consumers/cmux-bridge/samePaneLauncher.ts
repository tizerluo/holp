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
  manifestPathForSession,
  parseCmuxSurface,
  recordManifestCommandResult,
  sessionDirForSession,
  writeCmuxTuiSessionManifest,
  type CmuxTuiSessionManifest,
} from "./tuiManifest.js";
import type { CmuxCommandResult, CmuxDegradedReason, CmuxLayoutCommand } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");

export interface SamePaneLauncherOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly goal?: string;
  readonly sessionId?: string;
  readonly workspace?: string;
  readonly cmuxCommand?: string;
  readonly runner?: SamePaneCommandRunner;
  readonly isOnPath?: (command: string) => boolean;
  readonly cwd?: string;
  readonly now?: string;
}

export type SamePaneCommandRunner = (
  cmuxCommand: string,
  args: readonly string[],
  cwd: string,
  timeoutMs?: number,
) => Promise<CmuxCommandResult>;

export interface SamePaneLauncherResult {
  readonly mode: "degraded" | "planned";
  readonly manifest: CmuxTuiSessionManifest;
  readonly manifest_path: string;
  readonly degraded_reasons: readonly CmuxDegradedReason[];
}

export async function runHolpSamePaneLauncher(options: SamePaneLauncherOptions = {}): Promise<SamePaneLauncherResult> {
  const env = options.env ?? process.env;
  const workspaceId = options.workspace ?? cmuxWorkspaceFromEnv(env);
  const sessionId = options.sessionId ?? randomUUID();
  const brokerSocket = path.join(sessionDirForSession(sessionId), "broker.sock");
  let manifest = createCmuxTuiSessionManifest({
    sessionId,
    workspaceId: workspaceId ?? "missing",
    brokerSocket,
    now: options.now,
  });

  const finish = (mode: SamePaneLauncherResult["mode"]): SamePaneLauncherResult => {
    const written = writeCmuxTuiSessionManifest(manifest);
    return { mode, manifest, manifest_path: written, degraded_reasons: manifest.degraded_reasons };
  };

  if (!workspaceId) {
    manifest = addManifestDegradedReason(manifest, "missing_workspace");
    return finish("degraded");
  }

  const isOnPath = options.isOnPath ?? defaultIsOnPath;
  if (!isOnPath("tmux")) {
    manifest = addManifestDegradedReason(manifest, "missing_tmux_binary");
    return finish("degraded");
  }
  if (!isOnPath("codex")) {
    manifest = addManifestDegradedReason(manifest, "missing_controller_binary");
    return finish("degraded");
  }

  const cmuxCommand = options.cmuxCommand ?? resolveCmuxCommand(env);
  const runner = options.runner ?? runCmuxCapturingOutput;
  const cwd = options.cwd ?? repoRoot;
  const newPane = newPaneCommand(workspaceId);
  assertValidCmuxLayoutCommand(newPane);
  const newPaneResult = await runner(cmuxCommand, cmuxCommandArgs(newPane), cwd);
  manifest = recordManifestCommandResult(manifest, newPaneResult);
  const parsed = parseCmuxSurface(`${newPaneResult.stdout ?? ""}\n${newPaneResult.stderr ?? ""}`);
  if (!newPaneResult.ok) {
    manifest = addManifestDegradedReason(manifest, "cmux_command_failed");
    return finish("degraded");
  }
  if (!parsed.surfaceId) {
    manifest = addManifestDegradedReason(manifest, "missing_surface_handle");
    return finish("degraded");
  }
  manifest = addManifestSurface(manifest, "controller", {
    surface_id: parsed.surfaceId,
    pane_id: parsed.paneId,
    agent: "codex",
    last_command: newPaneResult.command,
  });

  const paneCommand = buildPaneCommand({ sessionId, brokerSocket, goal: options.goal });
  const send = sendCommand(workspaceId, parsed.surfaceId, paneCommand, {
    kind: "mission-control",
    title: "HOLP Harness Workspace",
  });
  assertValidCmuxLayoutCommand(send);
  const sendResult = await runner(cmuxCommand, cmuxCommandArgs(send), cwd);
  manifest = recordManifestCommandResult(manifest, sendResult);
  if (!sendResult.ok) {
    manifest = addManifestDegradedReason(manifest, "cmux_command_failed");
  }

  return finish(manifest.degraded_reasons.length > 0 ? "degraded" : "planned");
}

export function buildSamePaneControllerPrompt(options: { readonly goal?: string }): string {
  const exampleGoal = cleanPromptText(options.goal ?? "<human goal>");
  return [
    "You are the HOLP Harness Workspace Controller Agent.",
    `Repo is ${repoRoot}.`,
    "The human will talk naturally in this pane.",
    "Use the shared broker already exported in HOLP_HARNESS_BROKER_SOCKET; do not ask the human to copy socket paths or start another daemon.",
    "Inspect workers with `holp workers` and status with `holp status`.",
    `Dispatch real work with holp run ${shellQuote(exampleGoal)} --worker auto.`,
    "Resolve approvals with `holp approve \"<reason>\"` or `holp reject \"<reason>\"`.",
  ].join(" ");
}

export function buildPaneCommand(options: {
  readonly sessionId: string;
  readonly brokerSocket: string;
  readonly goal?: string;
}): string {
  const tmuxSession = `holp-harness-${options.sessionId}`;
  const brokerLog = path.join(sessionDirForSession(options.sessionId), "broker.log");
  const env = [
    `export PATH=${shellQuote(path.join(repoRoot, "bin"))}:$PATH`,
    `export HOLP_HARNESS_BROKER_SOCKET=${shellQuote(options.brokerSocket)}`,
  ].join("; ");
  const waitForBroker = `for i in $(seq 1 80); do [ -S ${shellQuote(options.brokerSocket)} ] && break; sleep 0.25; done`;
  const controller = [
    `cd ${shellQuote(repoRoot)} || exit 1`,
    env,
    `npm run harness:workspace:broker -- --session-id ${shellQuote(options.sessionId)} > ${shellQuote(brokerLog)} 2>&1 &`,
    waitForBroker,
    `codex -C ${shellQuote(repoRoot)} ${shellQuote(buildSamePaneControllerPrompt({ goal: options.goal }))}`,
  ].join("; ");
  const manifestPath = manifestPathForSession(options.sessionId);
  const sidecar = [
    `cd ${shellQuote(repoRoot)} || exit 1`,
    env,
    `export HOLP_HARNESS_CMUX_MANIFEST_PATH=${shellQuote(manifestPath)}`,
    waitForBroker,
    "npm run harness:workspace:tui",
  ].join("; ");
  return [
    `cd ${shellQuote(repoRoot)} || exit 1`,
    `export PATH=${shellQuote(path.join(repoRoot, "bin"))}:$PATH`,
    `cleanup() { tmux kill-session -t ${shellQuote(tmuxSession)} 2>/dev/null || true; }`,
    "trap cleanup EXIT INT TERM",
    `tmux new-session -s ${shellQuote(tmuxSession)} -n HOLP ${shellQuote(controller)} \\; split-window -h -t ${shellQuote(`${tmuxSession}:0`)} ${shellQuote(sidecar)} \\; select-pane -L`,
  ].join("\n") + "\n";
}

function newPaneCommand(workspaceId: string): CmuxLayoutCommand {
  return {
    name: "new-pane",
    args: ["--workspace", workspaceId, "--type", "terminal", "--focus", "false"],
    target: { kind: "mission-control", title: "HOLP Harness Workspace" },
  };
}

function sendCommand(workspaceId: string, surfaceId: string, text: string, target: CmuxLayoutCommand["target"]): CmuxLayoutCommand {
  return {
    name: "send",
    args: ["--workspace", workspaceId, "--surface", surfaceId, "--", text],
    target,
    contentCommand: text,
  };
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

function cleanPromptText(value: string): string {
  return value.replaceAll(/[\n\r\t]+/g, " ");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
