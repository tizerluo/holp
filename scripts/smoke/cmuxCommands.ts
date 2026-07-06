// Minimal cmux command helpers for the visible-agent-chain smoke.
// Extracted from consumers/cmux-bridge/commands.ts when the Harness Workspace
// consumer moved to the holp-cmux repo (issue #105); the full validated
// layout-command surface lives there.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

export interface CmuxCommandResult {
  readonly command: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly stdout?: string;
  readonly stderr?: string;
}

export function cmuxWorkspaceFromEnv(env: Record<string, string | undefined>): string | undefined {
  const workspaceId = env.CMUX_WORKSPACE_ID;
  return isRealCmuxWorkspaceValue(workspaceId) ? workspaceId : undefined;
}

function isRealCmuxWorkspaceValue(value: string | undefined): value is string {
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
