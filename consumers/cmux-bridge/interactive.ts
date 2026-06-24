import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createHarnessWorkspaceState,
  deriveOverview,
  recordEvent,
  type HarnessOverviewModel,
} from "../harness-workspace/index.js";
import type { EventFrame } from "../cli/wire.js";
import {
  assertValidCmuxLayoutCommand,
  cmuxCommandArgs,
  cmuxWorkspaceFromEnv,
  formatCmuxCommand,
  isRealCmuxWorkspaceValue,
  resolveCmuxCommand,
  runCmuxBestEffort,
} from "./commands.js";
import type {
  CmuxCallerContext,
  CmuxCommandResult,
  CmuxDegradedReason,
  CmuxExecutionResult,
  CmuxLayoutCommand,
  CmuxLayoutPlan,
  CmuxLayoutTarget,
  CmuxLayoutView,
} from "./types.js";
import type { CmuxCommandRunner } from "./executor.js";

export type InteractiveControllerLabel = "codex" | "kimi-code";

export interface InteractiveHarnessWorkspaceOptions {
  readonly caller: CmuxCallerContext;
  readonly controller?: string;
  readonly viewDir?: string;
  readonly runId?: string;
  readonly events?: readonly EventFrame[];
  readonly predicates?: {
    readonly isOnPath?: (command: string, env: Readonly<Record<string, string | undefined>>) => boolean;
    readonly hasControllerAuth?: (controller: InteractiveControllerLabel, env: Readonly<Record<string, string | undefined>>) => boolean;
  };
}

export interface InteractiveHarnessWorkspacePlan extends CmuxLayoutPlan {
  readonly controller: {
    readonly label: InteractiveControllerLabel | "unsupported";
    readonly startupCommand?: "codex" | "kimi";
    readonly requested: string;
  };
  readonly runFollowState: "waiting_for_run_id" | "live_follow_degraded" | "fixture_projection";
  readonly expectedWorkerSurface: "direct_user_session";
}

export function interactiveHarnessWorkspaceExecutionEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.HOLP_HARNESS_WORKSPACE_INTERACTIVE === "1";
}

export function controllerBinaryForLabel(label: string): "codex" | "kimi" | undefined {
  if (label === "codex") return "codex";
  if (label === "kimi-code") return "kimi";
  return undefined;
}

export function planInteractiveHarnessWorkspace(
  options: InteractiveHarnessWorkspaceOptions,
): InteractiveHarnessWorkspacePlan {
  const env = options.caller.env ?? {};
  const requestedController = options.controller ?? "codex";
  const controllerCommand = controllerBinaryForLabel(requestedController);
  const controllerLabel = controllerCommand ? requestedController as InteractiveControllerLabel : "unsupported";
  const explicitWorkspaceId = options.caller.workspaceId;
  const workspaceId = explicitWorkspaceId !== undefined
    ? isRealCmuxWorkspaceValue(explicitWorkspaceId) ? explicitWorkspaceId : undefined
    : cmuxWorkspaceFromEnv(env);
  const callerSurfaceId = options.caller.surfaceId ?? env.CMUX_SURFACE_ID;
  const cwd = options.caller.cwd ?? process.cwd();
  const model = deriveInteractiveOverview(options.runId, options.events);
  const degradedReasons = degradedForPlan({
    env,
    workspaceId,
    controllerLabel,
    controllerCommand,
    model,
    events: options.events,
    predicates: options.predicates,
  });

  if (!workspaceId) {
    return {
      workspaceId,
      callerSurfaceId,
      executable: false,
      degradedReasons,
      commands: [],
      views: [],
      summary: "HOLP interactive Harness Workspace degraded: missing cmux workspace",
      controller: {
        label: controllerLabel,
        startupCommand: controllerCommand,
        requested: requestedController,
      },
      runFollowState: runFollowState(model, options.events),
      expectedWorkerSurface: "direct_user_session",
    };
  }

  const viewDir = options.viewDir ?? defaultInteractiveViewDir(workspaceId);
  const commands: CmuxLayoutCommand[] = [];
  const views: CmuxLayoutView[] = [];
  const sidecarTarget: CmuxLayoutTarget = { kind: "sidecar", title: "HOLP Interactive Sidecar" };
  const evidenceTarget: CmuxLayoutTarget = { kind: "evidence", title: "HOLP Interactive Evidence" };
  const replayTarget: CmuxLayoutTarget = { kind: "replay", title: "HOLP Interactive Replay" };

  addMarkdownView(commands, views, {
    workspaceId,
    viewDir,
    target: sidecarTarget,
    fileName: "sidecar.md",
    markdown: sidecarMarkdown(model, {
      controller: controllerLabel,
      controllerCommand,
      cwd,
      degradedReasons,
      runFollowState: runFollowState(model, options.events),
    }),
    direction: "right",
  });
  addMarkdownView(commands, views, {
    workspaceId,
    viewDir,
    target: evidenceTarget,
    fileName: "evidence.md",
    markdown: evidenceMarkdown(model, degradedReasons),
    direction: "down",
  });
  addMarkdownView(commands, views, {
    workspaceId,
    viewDir,
    target: replayTarget,
    fileName: "replay.md",
    markdown: replayMarkdown(model, options.events),
    direction: "down",
  });

  if (controllerCommand) {
    commands.unshift(controllerPaneCommand({
      workspaceId,
      cwd,
      command: controllerCommand,
      label: controllerLabel as InteractiveControllerLabel,
    }));
  }

  commands.push({
    name: "set-status",
    args: ["holp-interactive-harness", degradedReasons.length > 0 ? "degraded" : "ready", "--workspace", workspaceId, "--color", degradedReasons.length > 0 ? "#ffcc00" : "#34c759"],
    target: sidecarTarget,
  });
  commands.push({
    name: "log",
    args: ["--workspace", workspaceId, "--level", "info", "--", `HOLP interactive Harness Workspace planned controller=${requestedController} follow=${runFollowState(model, options.events)}`],
    target: sidecarTarget,
  });

  for (const command of commands) assertValidInteractiveHarnessCommand(command);

  return {
    workspaceId,
    callerSurfaceId,
    executable: true,
    degradedReasons,
    commands,
    views,
    summary: `HOLP interactive Harness Workspace plan: controller=${requestedController} follow=${runFollowState(model, options.events)}`,
    controller: {
      label: controllerLabel,
      startupCommand: controllerCommand,
      requested: requestedController,
    },
    runFollowState: runFollowState(model, options.events),
    expectedWorkerSurface: "direct_user_session",
  };
}

export async function executeInteractiveHarnessWorkspacePlan(
  plan: InteractiveHarnessWorkspacePlan,
  options: {
    readonly execute?: boolean;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly cwd?: string;
    readonly cmuxCommand?: string;
    readonly runner?: CmuxCommandRunner;
    readonly writeView?: (view: CmuxLayoutView) => void;
  } = {},
): Promise<CmuxExecutionResult> {
  const execute = options.execute ?? interactiveHarnessWorkspaceExecutionEnabled(options.env ?? process.env);
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

  const invalid = plan.commands.filter((command) => validateInteractiveHarnessCommand(command).length > 0);
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
    const result = await runner(cmuxCommand, cmuxCommandArgs(command), cwd);
    executed.push(result);
  }

  const failed = executed.some((result) => !result.ok);
  const controllerPaneFailed = executed.some((result, index) => {
    return !result.ok && plan.commands[index]?.target.kind === "controller";
  });
  return {
    mode: "executed",
    plan,
    executed,
    skipped: [],
    degradedReasons: failed
      ? [
          ...degradedReasons,
          "cmux_command_failed",
          ...(controllerPaneFailed ? ["controller_pane_failed" as const] : []),
        ]
      : degradedReasons,
  };
}

export function validateInteractiveHarnessCommand(command: CmuxLayoutCommand): readonly string[] {
  const errors: string[] = [];
  try {
    assertValidCmuxLayoutCommand(command);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (command.target.kind !== "controller") return errors;
  if (command.name !== "new-pane") errors.push("controller_requires_new_pane");
  const value = optionValue(command.args, "--command");
  if (value !== undefined) errors.push("unsupported_controller_command");
  if (optionValue(command.args, "--type") !== "terminal") errors.push("controller_requires_terminal_type");
  if (command.args.some(hasHeadlessControllerToken)) {
    errors.push("headless_controller_command");
  }
  return errors;
}

export function assertValidInteractiveHarnessCommand(command: CmuxLayoutCommand): void {
  const errors = validateInteractiveHarnessCommand(command);
  if (errors.length > 0) {
    throw new Error(`invalid interactive cmux command ${command.name}: ${errors.join(",")}`);
  }
}

export async function runInteractiveHarnessWorkspaceDemo(
  argv: readonly string[] = process.argv.slice(2),
): Promise<string> {
  const options = parseDemoOptions(argv);
  const plan = planInteractiveHarnessWorkspace({
    caller: {
      workspaceId: options.workspaceId,
      surfaceId: options.surfaceId,
      cwd: process.cwd(),
      env: process.env,
    },
    controller: options.controller,
    runId: options.runId ?? process.env.HOLP_HARNESS_WORKSPACE_RUN_ID,
    viewDir: options.viewDir,
  });
  const execution = await executeInteractiveHarnessWorkspacePlan(plan, {
    env: process.env,
    cwd: process.cwd(),
  });

  const lines = [
    "HOLP Interactive Harness Workspace",
    plan.summary,
    `mode=${execution.mode}`,
    `workspace=${plan.workspaceId ?? "missing"}`,
    `controller=${plan.controller.requested}`,
    `controller_startup_command=${plan.controller.startupCommand ?? "unsupported"}`,
    `expected_worker_surface=${plan.expectedWorkerSurface}`,
    `run_follow=${plan.runFollowState}`,
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
  lines.push("");
  lines.push("Sidecar preview:");
  const sidecar = plan.views.find((view) => view.target.kind === "sidecar");
  lines.push(...(sidecar?.markdown.split("\n").slice(0, 18) ?? ["missing sidecar"]));
  return lines.join("\n");
}

function deriveInteractiveOverview(runId: string | undefined, events: readonly EventFrame[] | undefined): HarnessOverviewModel {
  let state = createHarnessWorkspaceState({ provenance: "unknown" });
  for (const event of events ?? []) state = recordEvent(state, event);
  if (runId && !state.run.run_id) {
    state = recordEvent(state, {
      run_id: runId,
      seq: 0,
      category: "run",
      name: "run_started",
      payload: { runtime: { runtime_surface: "direct_user_session" } },
    });
  }
  return deriveOverview(state);
}

function degradedForPlan(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workspaceId: string | undefined;
  readonly controllerLabel: InteractiveControllerLabel | "unsupported";
  readonly controllerCommand: "codex" | "kimi" | undefined;
  readonly model: HarnessOverviewModel;
  readonly events: readonly EventFrame[] | undefined;
  readonly predicates?: InteractiveHarnessWorkspaceOptions["predicates"];
}): CmuxDegradedReason[] {
  const reasons: CmuxDegradedReason[] = [];
  if (!options.workspaceId) reasons.push("missing_workspace");
  if (!options.controllerCommand || options.controllerLabel === "unsupported") {
    reasons.push("unsupported_controller");
  } else {
    reasons.push("controller_manual_start_required");
    if (!isControllerBinaryAvailable(options.controllerCommand, options.env, options.predicates?.isOnPath)) {
      reasons.push("missing_controller_binary");
    }
    if (options.predicates?.hasControllerAuth && !options.predicates.hasControllerAuth(options.controllerLabel, options.env)) {
      reasons.push("missing_controller_auth");
    }
  }
  if (options.model.evidence.runtime_surface !== "direct_user_session" || !options.model.evidence.worker_session) {
    reasons.push("missing_direct_worker_readiness");
  }
  if (!options.events || options.events.length === 0) reasons.push("missing_live_run_attach");
  return [...new Set(reasons)];
}

function controllerPaneCommand(options: {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly command: "codex" | "kimi";
  readonly label: InteractiveControllerLabel;
}): CmuxLayoutCommand {
  return {
    name: "new-pane",
    args: [
      "--workspace",
      options.workspaceId,
      "--direction",
      "right",
      "--focus",
      "false",
      "--type",
      "terminal",
    ],
    target: { kind: "controller", title: `HOLP Controller ${options.label}` },
    contentCommand: options.command,
  };
}

function addMarkdownView(
  commands: CmuxLayoutCommand[],
  views: CmuxLayoutView[],
  options: {
    readonly workspaceId: string;
    readonly viewDir: string;
    readonly target: CmuxLayoutTarget;
    readonly fileName: string;
    readonly markdown: string;
    readonly direction: "right" | "down";
  },
): void {
  const viewPath = path.join(options.viewDir, options.fileName);
  views.push({ path: viewPath, target: options.target, markdown: options.markdown });
  commands.push({
    name: "markdown open",
    args: [viewPath, "--workspace", options.workspaceId, "--direction", options.direction, "--focus", "false"],
    target: options.target,
  });
}

function sidecarMarkdown(
  model: HarnessOverviewModel,
  options: {
    readonly controller: InteractiveControllerLabel | "unsupported";
    readonly controllerCommand: "codex" | "kimi" | undefined;
    readonly cwd: string;
    readonly degradedReasons: readonly CmuxDegradedReason[];
    readonly runFollowState: InteractiveHarnessWorkspacePlan["runFollowState"];
  },
): string {
  return [
    "# HOLP Interactive Sidecar",
    "",
    "- Entry: human-operated native Controller CLI pane",
    `- Controller: ${options.controller}`,
    `- Controller startup command: ${options.controllerCommand ? `\`cd ${shellQuote(options.cwd)} && ${options.controllerCommand}\`` : "unsupported"}`,
    `- Manual start required: ${options.controllerCommand ? `type \`cd ${shellQuote(options.cwd)} && ${options.controllerCommand}\` in the Controller terminal pane` : "unsupported controller"}`,
    `- HOLP repo: ${options.cwd}`,
    "- Controller prompt: ask the native CLI to start a HOLP public-wire run from this repository",
    "- Public-wire client: `npm run cli -- run --scenario=single --decision=approved` for a bounded local check",
    "- Worker expectation: direct_user_session only",
    `- Run follow: ${options.runFollowState}`,
    `- Run ID: ${model.evidence.run_id ?? "waiting_for_run_id"}`,
    `- Worker session: ${model.evidence.worker_session ?? "unknown"}`,
    `- Attach command: ${model.evidence.attach_command ?? "unknown"}`,
    `- Latest event: ${model.evidence.latest_event ?? "unknown"}`,
    `- Gate: ${gateLine(model)}`,
    `- Terminal: ${terminalLine(model)}`,
    `- Failure: ${model.failures.length > 0 ? model.failures.join(" | ") : "none"}`,
    `- Degraded: ${options.degradedReasons.length > 0 ? options.degradedReasons.join(",") : "none"}`,
    "",
    "Live follow is degraded until a public run id or run-attach surface is provided. This launcher does not start a run on the operator's behalf.",
    "",
  ].join("\n");
}

function evidenceMarkdown(model: HarnessOverviewModel, degradedReasons: readonly CmuxDegradedReason[]): string {
  return [
    "# HOLP Interactive Evidence",
    "",
    "- Evidence mode: honest live/degraded projection",
    `- Run ID: ${model.evidence.run_id ?? "waiting_for_run_id"}`,
    `- Runtime surface: ${model.evidence.runtime_surface ?? "unknown"}`,
    `- Expected worker surface: direct_user_session`,
    `- Worker session: ${model.evidence.worker_session ?? "unknown"}`,
    `- Attach command: ${model.evidence.attach_command ?? "unknown"}`,
    `- Latest event: ${model.evidence.latest_event ?? "unknown"}`,
    `- Gate: ${gateLine(model)}`,
    `- Terminal: ${terminalLine(model)}`,
    `- Artifact refs: ${model.evidence.artifact_refs.length > 0 ? model.evidence.artifact_refs.join(",") : "none"}`,
    `- Failure: ${model.failures.length > 0 ? model.failures.join(" | ") : "none"}`,
    `- Degraded reasons: ${degradedReasons.length > 0 ? degradedReasons.join(",") : "none"}`,
    `- Provenance: ${model.evidence.provenance} - ${model.evidence.provenance_caveat}`,
    "",
  ].join("\n");
}

function replayMarkdown(model: HarnessOverviewModel, events: readonly EventFrame[] | undefined): string {
  const mode = events && events.length > 0 ? "fixture_projection" : "live_follow_degraded";
  const lines = [
    "# HOLP Interactive Replay",
    "",
    `- Replay state: ${model.evidence.run_id ? mode : "waiting_for_run_id"}`,
    `- Run ID: ${model.evidence.run_id ?? "waiting_for_run_id"}`,
    "- Live human-run replay requires public run discovery / attach support.",
    "- Synthetic event projection is test-only and is not human-run evidence.",
    "",
    "## Latest Events",
    "",
  ];
  if (!events || events.length === 0) {
    lines.push("- none");
  } else {
    for (const event of events.slice(-8)) {
      lines.push(`- ${event.category}.${event.name}#${event.seq} run_id=${event.run_id}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function gateLine(model: HarnessOverviewModel): string {
  const gate = model.evidence.gate;
  return [
    gate?.gate_disposition ?? "pending",
    gate?.review_outcome,
    gate?.blocking_reason ? `blocking_reason=${gate.blocking_reason}` : undefined,
  ].filter(Boolean).join(" ");
}

function terminalLine(model: HarnessOverviewModel): string {
  const terminal = model.evidence.terminal;
  if (!terminal) return "pending";
  return terminal.reason ? `${terminal.state} reason=${terminal.reason}` : terminal.state;
}

function runFollowState(
  model: HarnessOverviewModel,
  events: readonly EventFrame[] | undefined,
): InteractiveHarnessWorkspacePlan["runFollowState"] {
  if (events && events.length > 0) return "fixture_projection";
  return model.evidence.run_id ? "live_follow_degraded" : "waiting_for_run_id";
}

function isControllerBinaryAvailable(
  command: "codex" | "kimi",
  env: Readonly<Record<string, string | undefined>>,
  predicate: InteractiveHarnessWorkspaceOptions["predicates"] extends infer P
    ? P extends { readonly isOnPath?: infer F } ? F extends (...args: never[]) => boolean ? F : undefined : undefined
    : undefined,
): boolean {
  if (predicate) return predicate(command, env);
  const pathEnv = env.PATH ?? process.env.PATH ?? "";
  return pathEnv.split(path.delimiter).filter(Boolean).some((dir) => {
    try {
      accessSync(path.join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function writeMarkdownView(view: CmuxLayoutView): void {
  mkdirSync(path.dirname(view.path), { recursive: true, mode: 0o700 });
  writeFileSync(view.path, view.markdown, { encoding: "utf8", mode: 0o600 });
}

function defaultInteractiveViewDir(workspaceId: string): string {
  return path.join("/tmp", "holp-interactive-harness", sanitizePathPart(workspaceId));
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "unknown";
}

function optionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

function hasHeadlessControllerToken(arg: string): boolean {
  const tokens = arg.split(/\s+/).filter(Boolean);
  return tokens.some((token) => {
    return token === "exec"
      || token === "-p"
      || token === "--output-format"
      || token.startsWith("--output-format=")
      || token === "claude-code";
  });
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : JSON.stringify(value);
}

function parseDemoOptions(argv: readonly string[]): {
  readonly workspaceId?: string;
  readonly surfaceId?: string;
  readonly controller?: string;
  readonly runId?: string;
  readonly viewDir?: string;
} {
  let workspaceId: string | undefined;
  let surfaceId: string | undefined;
  let controller: string | undefined;
  let runId: string | undefined;
  let viewDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--workspace" && next) {
      workspaceId = next;
      index += 1;
    } else if (arg === "--surface" && next) {
      surfaceId = next;
      index += 1;
    } else if (arg === "--controller" && next) {
      controller = next;
      index += 1;
    } else if (arg === "--run-id" && next) {
      runId = next;
      index += 1;
    } else if (arg === "--view-dir" && next) {
      viewDir = next;
      index += 1;
    }
  }
  return { workspaceId, surfaceId, controller, runId, viewDir };
}

function isMain(): boolean {
  return process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

if (isMain()) {
  runInteractiveHarnessWorkspaceDemo()
    .then((output) => process.stdout.write(`${output}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
