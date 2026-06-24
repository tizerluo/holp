import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { buildFocusShellDemoModel } from "../harness-workspace/demo.js";
import { formatCmuxCommand } from "./commands.js";
import { executeCmuxLayoutPlan } from "./executor.js";
import { planCmuxTeamLayout } from "./planner.js";
import type { CmuxCallerContext } from "./types.js";

interface DemoOptions {
  readonly workspaceId?: string;
  readonly surfaceId?: string;
}

export async function runCmuxTeamLayoutDemo(argv: readonly string[] = process.argv.slice(2)): Promise<string> {
  const options = parseDemoOptions(argv);
  const model = buildFocusShellDemoModel({ locale: "en-US", mode: "overview" });
  if (model.mode !== "overview") {
    throw new Error("cmux Team Layout demo requires an overview render model");
  }
  const caller: CmuxCallerContext = {
    workspaceId: options.workspaceId,
    surfaceId: options.surfaceId,
    cwd: process.cwd(),
    env: process.env,
  };
  const plan = planCmuxTeamLayout({ caller, model });
  const execution = await executeCmuxLayoutPlan(plan, {
    env: process.env,
    cwd: process.cwd(),
  });

  const lines = [
    "HOLP cmux Team Layout",
    plan.summary,
    `mode=${execution.mode}`,
    `workspace=${plan.workspaceId ?? "missing"}`,
    `commands=${plan.commands.length}`,
  ];
  if (execution.degradedReasons.length > 0) {
    lines.push(`degraded=${[...new Set(execution.degradedReasons)].join(",")}`);
  }
  lines.push("");
  lines.push("Command plan:");
  if (plan.commands.length === 0) {
    lines.push("- none");
  } else {
    for (const command of plan.commands) lines.push(`- ${formatCmuxCommand(command)}`);
  }
  if (execution.executed.length > 0) {
    lines.push("");
    lines.push("Execution:");
    for (const result of execution.executed) {
      lines.push(`- ok=${result.ok} ${result.command}${result.error ? ` error=${result.error}` : ""}`);
    }
  }
  return lines.join("\n");
}

function parseDemoOptions(argv: readonly string[]): DemoOptions {
  let workspaceId: string | undefined;
  let surfaceId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--workspace" && next) {
      workspaceId = next;
      index += 1;
    } else if (arg === "--surface" && next) {
      surfaceId = next;
      index += 1;
    }
  }
  return { workspaceId, surfaceId };
}

function isMain(): boolean {
  return process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

if (isMain()) {
  runCmuxTeamLayoutDemo()
    .then((output) => process.stdout.write(`${output}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
