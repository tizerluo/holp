import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import type { CmuxCommandResult, CmuxLayoutCommand, CmuxLayoutCommandName } from "./types.js";

export const CMUX_COMMAND_ALLOWLIST: readonly CmuxLayoutCommandName[] = [
  "new-pane",
  "new-surface",
  "new-split",
  "markdown open",
  "send",
  "set-status",
  "set-progress",
  "log",
  "notify",
];

const MUTATING_COMMANDS = new Set<CmuxLayoutCommandName>(CMUX_COMMAND_ALLOWLIST);
const CREATE_COMMANDS = new Set<CmuxLayoutCommandName>([
  "new-pane",
  "new-surface",
  "new-split",
  "markdown open",
]);

const FORBIDDEN_TOKENS = new Set([
  "focus-window",
  "focus-pane",
  "focus-panel",
  "select-workspace",
  "close-window",
  "close-workspace",
  "close-pane",
  "close-surface",
  "move-workspace-to-window",
  "move-surface",
  "reorder-workspace",
  "reorder-workspaces",
  "swap-pane",
  "break-pane",
  "join-pane",
  "respawn-pane",
  "find-window",
  "send-key",
  "clear-history",
  "set-hook",
]);

export function cmuxWorkspaceFromEnv(env: Record<string, string | undefined>): string | undefined {
  const workspaceId = env.CMUX_WORKSPACE_ID;
  return isRealCmuxWorkspaceValue(workspaceId) ? workspaceId : undefined;
}

export function isRealCmuxWorkspaceValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "" && !value.trim().startsWith("-");
}

function isExecutableFileSync(filePath: string): boolean {
  try {
    const stats = statSync(filePath);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function defaultIsOnPath(command: string, env: Record<string, string | undefined>): boolean {
  const pathEnv = env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => isExecutableFileSync(path.join(dir, command)));
}

export function resolveCmuxCommand(
  env: Record<string, string | undefined>,
  predicates: {
    readonly isOnPath?: (command: string, env: Record<string, string | undefined>) => boolean;
    readonly isExecutableFile?: (filePath: string) => boolean;
  } = {},
): string {
  const isOnPath = predicates.isOnPath ?? defaultIsOnPath;
  const isExecutableFile = predicates.isExecutableFile ?? isExecutableFileSync;

  const override = env.HOLP_VISIBLE_AGENT_CHAIN_CMUX_BIN;
  if (override) return override;

  if (isOnPath("cmux", env)) return "cmux";

  const appBin = "/Applications/cmux.app/Contents/Resources/bin/cmux";
  if (isExecutableFile(appBin)) return appBin;

  return "cmux";
}

export function runCmuxBestEffort(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CmuxCommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, [...args], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env },
    });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, 10_000);
    proc.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !killed) {
        resolve({ command: `${command} ${args.join(" ")}`, ok: true });
      } else {
        resolve({
          command: `${command} ${args.join(" ")}`,
          ok: false,
          error: killed ? "timed out" : `exit_code=${code ?? "unknown"}`,
        });
      }
    });
    proc.once("error", (error) => {
      clearTimeout(timer);
      resolve({
        command: `${command} ${args.join(" ")}`,
        ok: false,
        error: error.message,
      });
    });
  });
}

export function runCmuxCapturingOutput(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 10_000,
): Promise<CmuxCommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, timeoutMs);
    proc.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !killed) {
        resolve({ command: `${command} ${args.join(" ")}`, ok: true, stdout, stderr });
      } else {
        resolve({
          command: `${command} ${args.join(" ")}`,
          ok: false,
          error: killed ? "timed out" : `exit_code=${code ?? "unknown"}`,
          stdout,
          stderr,
        });
      }
    });
    proc.once("error", (error) => {
      clearTimeout(timer);
      resolve({
        command: `${command} ${args.join(" ")}`,
        ok: false,
        error: error.message,
        stdout,
        stderr,
      });
    });
  });
}

export function cmuxCommandArgs(command: CmuxLayoutCommand): readonly string[] {
  return command.name === "markdown open"
    ? ["markdown", "open", ...command.args]
    : [command.name, ...command.args];
}

export function formatCmuxCommand(command: CmuxLayoutCommand, cmuxBin = "cmux"): string {
  return [cmuxBin, ...cmuxCommandArgs(command)].map(shellQuote).join(" ");
}

export function validateCmuxLayoutCommand(command: CmuxLayoutCommand): readonly string[] {
  const errors: string[] = [];
  if (!CMUX_COMMAND_ALLOWLIST.includes(command.name)) {
    errors.push(`command_not_allowlisted:${command.name}`);
  }

  if (command.name === "send") return validateCmuxSendCommand(command, errors);

  const args = cmuxCommandArgs(command);
  for (const token of args) {
    if (FORBIDDEN_TOKENS.has(token)) errors.push(`forbidden_token:${token}`);
  }

  const joined = args.join(" ");
  if (/\btmux\s+attach\b/.test(joined)) errors.push("forbidden_tmux_attach");
  if (command.name === "new-surface" && args.includes("--provider")) {
    errors.push("forbidden_provider_surface");
  }

  if (MUTATING_COMMANDS.has(command.name) && !hasOptionValue(command.args, "--workspace")) {
    errors.push("missing_workspace");
  }
  if (CREATE_COMMANDS.has(command.name) && optionValue(command.args, "--focus") !== "false") {
    errors.push("missing_focus_false");
  }

  return errors;
}

function validateCmuxSendCommand(command: CmuxLayoutCommand, errors: string[]): readonly string[] {
  const delimiter = command.args.indexOf("--");
  if (delimiter === -1) errors.push("missing_send_payload_delimiter");
  const structuralArgs = delimiter === -1 ? command.args : command.args.slice(0, delimiter);
  for (const token of structuralArgs) {
    if (FORBIDDEN_TOKENS.has(token)) errors.push(`forbidden_token:${token}`);
  }
  if (!hasOptionValue(structuralArgs, "--workspace")) errors.push("missing_workspace");
  if (!hasOptionValue(structuralArgs, "--surface")) errors.push("missing_surface");
  return errors;
}

export function assertValidCmuxLayoutCommand(command: CmuxLayoutCommand): void {
  const errors = validateCmuxLayoutCommand(command);
  if (errors.length > 0) {
    throw new Error(`invalid cmux layout command ${command.name}: ${errors.join(",")}`);
  }
}

function hasOptionValue(args: readonly string[], option: string): boolean {
  return isRealCmuxWorkspaceValue(optionValue(args, option));
}

function optionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : JSON.stringify(value);
}
