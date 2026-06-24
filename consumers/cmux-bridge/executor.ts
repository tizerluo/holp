import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertValidCmuxLayoutCommand,
  cmuxCommandArgs,
  resolveCmuxCommand,
  runCmuxBestEffort,
} from "./commands.js";
import type {
  CmuxCommandResult,
  CmuxDegradedReason,
  CmuxExecutionResult,
  CmuxLayoutCommand,
  CmuxLayoutPlan,
  CmuxLayoutView,
} from "./types.js";

export type CmuxCommandRunner = (
  cmuxCommand: string,
  args: readonly string[],
  cwd: string,
) => Promise<CmuxCommandResult>;

export interface ExecuteCmuxLayoutOptions {
  readonly execute?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly cmuxCommand?: string;
  readonly runner?: CmuxCommandRunner;
  readonly writeView?: (view: CmuxLayoutView) => void;
}

export function cmuxTeamLayoutExecutionEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.HOLP_CMUX_TEAM_LAYOUT === "1";
}

export async function executeCmuxLayoutPlan(
  plan: CmuxLayoutPlan,
  options: ExecuteCmuxLayoutOptions = {},
): Promise<CmuxExecutionResult> {
  const execute = options.execute ?? cmuxTeamLayoutExecutionEnabled(options.env ?? process.env);
  const degradedReasons: CmuxDegradedReason[] = [...plan.degradedReasons];
  if (!execute) degradedReasons.push("execution_not_enabled");
  if (!execute || !plan.executable) {
    return {
      mode: plan.executable ? "dry-run" : "degraded",
      plan,
      executed: [],
      skipped: plan.commands,
      degradedReasons,
    };
  }

  const invalid = plan.commands.flatMap((command) => {
    const errors = validateForExecution(command);
    return errors.length > 0 ? [command] : [];
  });
  if (invalid.length > 0) {
    return {
      mode: "degraded",
      plan,
      executed: [],
      skipped: plan.commands,
      degradedReasons: [...degradedReasons, "invalid_command"],
    };
  }

  const writeView = options.writeView ?? writeMarkdownView;
  for (const view of plan.views) writeView(view);

  const runner = options.runner ?? runCmuxBestEffort;
  const cwd = options.cwd ?? process.cwd();
  const cmuxCommand = options.cmuxCommand ?? resolveCmuxCommand(options.env ?? process.env);
  const executed: CmuxCommandResult[] = [];
  for (const command of plan.commands) {
    executed.push(await runner(cmuxCommand, cmuxCommandArgs(command), cwd));
  }

  const failed = executed.some((result) => !result.ok);
  return {
    mode: "executed",
    plan,
    executed,
    skipped: [],
    degradedReasons: failed ? [...degradedReasons, "cmux_command_failed"] : degradedReasons,
  };
}

function validateForExecution(command: CmuxLayoutCommand): readonly string[] {
  try {
    assertValidCmuxLayoutCommand(command);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function writeMarkdownView(view: CmuxLayoutView): void {
  mkdirSync(path.dirname(view.path), { recursive: true, mode: 0o700 });
  writeFileSync(view.path, view.markdown, { encoding: "utf8", mode: 0o600 });
}
