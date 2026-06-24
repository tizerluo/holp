#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient, RpcError, type EventFrame } from "../../consumers/cli/wire.js";
import { isTerminalEvent, objectPayload, stringField } from "../../consumers/cli/renderer.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const serverEntry = path.join(repoRoot, "daemon", "runtime", "server.ts");

const RESULT_BEGIN = "HOLP_CHAIN_RESULT_BEGIN";
const RESULT_END = "HOLP_CHAIN_RESULT_END";
const DISCOVER_TIMEOUT_MS = 180_000;
const RUN_STARTED_TIMEOUT_MS = 60_000;
const STEP_STARTED_TIMEOUT_MS = 120_000;
const TERMINAL_TIMEOUT_MS = 180_000;
const CONTROLLER_TIMEOUT_MS = 360_000;

// ── types ──────────────────────────────────────────────────────────────────

export type ControllerTransport = "codex" | "kimi-code" | "claude-code";

export interface ControllerSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly ignoreStdin: boolean;
}

interface RuntimeSurfaceRow {
  readonly runtime_surface?: string;
  readonly isolation_profiles?: Record<string, { readonly readiness?: string } | undefined>;
}

interface DiscoveredAgent {
  readonly id: string;
  readonly runtime_surfaces?: readonly RuntimeSurfaceRow[];
}

// ── public registry constants ──────────────────────────────────────────────

export const ENABLED_CONTROLLERS: readonly ControllerTransport[] = ["codex", "kimi-code", "claude-code"];

export const DISABLED_CONTROLLER_REASON = "controller_driver_not_enabled_in_issue_63";

export const DISABLED_CONTROLLERS: Readonly<Record<string, string>> = {
  "cursor-agent": DISABLED_CONTROLLER_REASON,
  opencode: DISABLED_CONTROLLER_REASON,
  pi: DISABLED_CONTROLLER_REASON,
  reasonix: DISABLED_CONTROLLER_REASON,
};

const DEFAULT_WORKER_FOR_CONTROLLER: Readonly<Record<ControllerTransport, string>> = {
  codex: "kimi-code",
  "kimi-code": "opencode",
  "claude-code": "kimi-code",
};

// ── exported pure helpers ──────────────────────────────────────────────────

export function visibleAgentChainSmokeEnabled(env: Record<string, string | undefined>): boolean {
  return env.HOLP_VISIBLE_AGENT_CHAIN_SMOKE === "1";
}

export function isEnabledController(transport: string): transport is ControllerTransport {
  return ENABLED_CONTROLLERS.includes(transport as ControllerTransport);
}

export function workerForController(controller: ControllerTransport): string {
  return DEFAULT_WORKER_FOR_CONTROLLER[controller];
}

export function generateMarker(): string {
  return `HOLP_CHAIN_MARKER_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function extractWorkerSessionFromStepStarted(event: EventFrame): string | undefined {
  const payload = objectPayload(event.payload);
  const detail = stringField(payload, "detail");
  if (!detail) return undefined;
  const trimmed = detail.trim();
  return /^holp-/.test(trimmed) ? trimmed : undefined;
}

export function attachCommandForSession(session: string): string {
  return `tmux attach -t ${session}`;
}

export function buildResultBlock(fields: Readonly<Record<string, string>>): string {
  const lines = [RESULT_BEGIN];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}=${v}`);
  lines.push(RESULT_END);
  return lines.join("\n");
}

export function parseResultBlock(output: string): Readonly<Record<string, string>> | undefined {
  const begin = output.indexOf(RESULT_BEGIN);
  const end = output.indexOf(RESULT_END, begin);
  if (begin === -1 || end === -1) return undefined;
  const body = output.slice(begin + RESULT_BEGIN.length, end);
  const result: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function assertSuccessGate(block: Readonly<Record<string, string>>): void {
  if (block.terminal !== "run_merged") {
    throw new Error(
      `success gate: terminal=${block.terminal ?? "missing"} (required run_merged)`,
    );
  }
  if (block.surface !== "direct_user_session") {
    throw new Error(
      `success gate: surface=${block.surface ?? "missing"} (required direct_user_session)`,
    );
  }
  const session = block.worker_session ?? "";
  if (!/^holp-/.test(session)) {
    throw new Error(`success gate: worker_session=${session} does not match /^holp-/`);
  }
  if (block.model_output_marker !== "found") {
    throw new Error(`success gate: model_output_marker=not_found (marker not in model output)`);
  }
}

export function markerInControllerOutput(output: string, marker: string): boolean {
  return output.includes(marker);
}

export function evaluateMarkerGate(
  resultBlock: Readonly<Record<string, string>> | undefined,
  controllerOutput: string,
  marker: string,
): boolean {
  return Boolean(resultBlock && !markerInControllerOutput(controllerOutput, marker));
}

export function cmuxStatusLine(): string {
  return "INFO cmux_status=cmux-pending-user-validation";
}

export const PASS_MARKER = "PASS visible-agent-chain";

export function cmuxVisibleAgentChainEnabled(env: Record<string, string | undefined>): boolean {
  return env.HOLP_VISIBLE_AGENT_CHAIN_CMUX === "1" || Boolean(env.CMUX_WORKSPACE_ID);
}

export function cmuxWorkspaceFromEnv(env: Record<string, string | undefined>): string | undefined {
  return env.CMUX_WORKSPACE_ID;
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

export function dashboardDirForMarker(marker: string): string {
  return path.join("/tmp", "holp-visible-agent-chain", marker);
}

export function dashboardPathForMarker(marker: string): string {
  return path.join(dashboardDirForMarker(marker), "dashboard.md");
}

export interface DashboardData {
  readonly controller: string;
  readonly worker: string;
  readonly marker: string;
  readonly runId?: string;
  readonly workerSession?: string;
  readonly attachCommand?: string;
  readonly timeline: readonly string[];
  readonly finalResult: "pass" | "fail" | "error";
  readonly cmuxStatus: string;
  readonly cmuxCommandSummary?: string;
  readonly updatedAt: string;
}

export function buildDashboardMarkdown(data: DashboardData): string {
  const lines: string[] = [];
  lines.push(`# HOLP Visible Agent Chain — ${data.marker}`);
  lines.push("");
  lines.push(`- **Controller:** ${data.controller}`);
  lines.push(`- **Worker:** ${data.worker}`);
  lines.push(`- **Marker:** ${data.marker}`);
  if (data.runId) lines.push(`- **Run ID:** ${data.runId}`);
  if (data.workerSession) lines.push(`- **Worker Session:** ${data.workerSession}`);
  if (data.attachCommand) lines.push(`- **Attach Command:** \`${data.attachCommand}\``);
  lines.push(`- **Final Result:** ${data.finalResult}`);
  lines.push(`- **cmux Status:** ${data.cmuxStatus}`);
  if (data.cmuxCommandSummary) lines.push(`- **cmux Commands:** ${data.cmuxCommandSummary}`);
  lines.push(`- **Updated At:** ${data.updatedAt}`);
  lines.push("");
  lines.push("## Event Timeline");
  lines.push("");
  if (data.timeline.length === 0) {
    lines.push("*No events recorded.*");
  } else {
    for (const entry of data.timeline) lines.push(`- ${entry}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function writeDashboardSync(dashboardPath: string, content: string): void {
  mkdirSync(path.dirname(dashboardPath), { recursive: true });
  writeFileSync(dashboardPath, content, "utf-8");
}

export function updateDashboardForMarker(
  marker: string,
  data: Omit<DashboardData, "updatedAt">,
): string {
  const dashboardPath = dashboardPathForMarker(marker);
  const fullData: DashboardData = { ...data, updatedAt: new Date().toISOString() };
  writeDashboardSync(dashboardPath, buildDashboardMarkdown(fullData));
  return dashboardPath;
}

export interface CmuxCommandResult {
  readonly command: string;
  readonly ok: boolean;
  readonly error?: string;
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

export async function runCmuxDashboardCommands(opts: {
  readonly dashboardPath: string;
  readonly workspace: string;
  readonly finalResult: "pass" | "fail" | "error";
  readonly marker: string;
  readonly cwd: string;
}): Promise<readonly CmuxCommandResult[]> {
  const { dashboardPath, workspace, finalResult, marker, cwd } = opts;
  const cmuxCommand = resolveCmuxCommand(process.env);
  const results: CmuxCommandResult[] = [];
  const statusColor = finalResult === "pass" ? "#34c759" : "#ff3b30";

  results.push(
    await runCmuxBestEffort(
      cmuxCommand,
      ["markdown", "open", dashboardPath, "--workspace", workspace, "--focus", "false"],
      cwd,
    ),
  );
  results.push(
    await runCmuxBestEffort(
      cmuxCommand,
      ["set-status", "visible-agent-chain", finalResult, "--workspace", workspace, "--color", statusColor],
      cwd,
    ),
  );
  results.push(
    await runCmuxBestEffort(
      cmuxCommand,
      ["set-progress", finalResult === "pass" ? "1.0" : "0.0", "--label", `visible-agent-chain ${finalResult}`, "--workspace", workspace],
      cwd,
    ),
  );
  results.push(
    await runCmuxBestEffort(
      cmuxCommand,
      ["log", "--workspace", workspace, "--level", "info", "--", `visible-agent-chain ${finalResult} marker=${marker}`],
      cwd,
    ),
  );

  return results;
}

export function selectDirectReadyAgent(agents: readonly DiscoveredAgent[]): { agent: DiscoveredAgent } {
  for (const agent of agents) {
    const surface = agent.runtime_surfaces?.find(
      (s) => s.runtime_surface === "direct_user_session",
    );
    const profile = surface?.isolation_profiles?.coder_worktree;
    if (profile?.readiness === "ready") return { agent };
  }
  const summary = agents.map((a) => a.id).join(",");
  throw new Error(`no ready direct_user_session surface found (${summary || "none"})`);
}

export function buildControllerSpec(
  controller: ControllerTransport,
  prompt: string,
  repo: string,
): ControllerSpec {
  if (controller === "codex") {
    return {
      command: "codex",
      args: [
        "--disable",
        "code_mode",
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-c", "notify=[]",
        "-C", repo,
        prompt,
      ],
      cwd: repo,
      ignoreStdin: true,
    };
  }
  if (controller === "claude-code") {
    return {
      command: "claude",
      args: ["-p", prompt, "--output-format", "text"],
      cwd: repo,
      ignoreStdin: true,
    };
  }
  // kimi-code
  return {
    command: "kimi",
    args: ["-p", prompt, "--output-format", "text"],
    cwd: repo,
    ignoreStdin: true,
  };
}

export interface ClientCommandOpts {
  readonly workerTransport: string;
  readonly marker: string;
  readonly controller: string;
  readonly scriptPath?: string;
}

export function buildClientCommand(opts: ClientCommandOpts): string {
  const scriptPath = opts.scriptPath ?? "scripts/smoke/visible-agent-chain.ts";
  return [
    "node", "--import", "tsx", scriptPath,
    "--client",
    "--worker", opts.workerTransport,
    "--marker", opts.marker,
    "--controller", opts.controller,
  ].join(" ");
}

export function tsxLoaderPathForRepo(repo: string): string {
  return path.join(repo, "node_modules", "tsx", "dist", "loader.mjs");
}

export function buildDaemonCommand(repoRoot: string, serverEntry: string): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return {
    command: "node",
    args: ["--import", tsxLoaderPathForRepo(repoRoot), serverEntry],
  };
}

// ── client mode ────────────────────────────────────────────────────────────

async function runClientMode(args: {
  workerTransport: string;
  marker: string;
  controller: string;
}): Promise<number> {
  const smokeCwd = mkdtempSync(path.join(tmpdir(), "holp-chain-client-"));
  const events: EventFrame[] = [];
  let subscriptionId: string | undefined;
  let workerSession: string | undefined;
  let runId: string | undefined;
  const modelOutputTexts: string[] = [];

  const daemonCommand = buildDaemonCommand(repoRoot, serverEntry);

  const client = new DaemonClient({
    command: daemonCommand.command,
    args: [...daemonCommand.args],
    cwd: smokeCwd,
    env: {
      HOLP_REGISTRY: "",
      HOLP_REAL_HARNESS_DIRECT_SMOKE: "1",
    },
  });

  client.onEvent((event) => {
    events.push(event);
    if (event.name === "step_started" && !workerSession) {
      const session = extractWorkerSessionFromStepStarted(event);
      if (session) {
        workerSession = session;
        console.log(`attach_command=${attachCommandForSession(session)}`);
      }
    }
    if (event.name === "model_output") {
      const payload = objectPayload(event.payload);
      const fullText = stringField(payload, "full_text");
      if (fullText) modelOutputTexts.push(fullText);
    }
  });

  try {
    const initialized = await client.call<{ protocol_version: string }>("initialize", {
      protocol_version: "0.1.8",
      client: { name: "holp-chain-client", version: "0.1.0" },
      capabilities: {
        approval: { supported: true, kinds: ["merge_approval"] },
      },
    });
    console.log(`client_init: protocol=${initialized.protocol_version}`);

    const discovered = await client.call<{ agents: readonly DiscoveredAgent[] }>(
      "flock.discover",
      { transports: [args.workerTransport], probe: true },
      DISCOVER_TIMEOUT_MS,
    );
    if (discovered.agents.length === 0) {
      throw new Error(`flock.discover: no agents for transport=${args.workerTransport}`);
    }

    const { agent } = selectDirectReadyAgent(discovered.agents);
    console.log(`worker_agent: id=${agent.id} surface=direct_user_session`);

    const run = await client.call<{ run_id: string; accepted: boolean }>("orchestrate.run", {
      goal: `HOLP visible chain smoke. Reply with this exact marker: ${args.marker}`,
      roles: {
        coder: {
          agent: agent.id,
          preferred_runtime_surface: "direct_user_session",
        },
      },
    });
    runId = run.run_id;
    console.log(`orchestrate.run: accepted=${run.accepted} run_id=${run.run_id}`);

    const subscribed = await client.call<{ subscription_id: string; latest_seq: number }>(
      "events.subscribe",
      { run_id: run.run_id, after_seq: 0 },
    );
    subscriptionId = subscribed.subscription_id;
    console.log(`events.subscribe: id=${subscribed.subscription_id}`);

    const started = await waitForEventFromEvents(
      client, events,
      (e) => e.run_id === run.run_id && e.name === "run_started",
      "run_started", RUN_STARTED_TIMEOUT_MS,
    );
    const observedSurface = surfaceFromRunStarted(started);
    console.log(`surface: requested=direct_user_session observed=${observedSurface ?? "missing"}`);
    if (observedSurface !== "direct_user_session") {
      throw new Error(`surface mismatch: observed=${observedSurface ?? "missing"}`);
    }

    // Wait for step_started if session not yet captured by onEvent
    if (!workerSession) {
      const stepEv = await waitForEventFromEvents(
        client, events,
        (e) => e.run_id === run.run_id && e.name === "step_started",
        "step_started", STEP_STARTED_TIMEOUT_MS,
      );
      const session = extractWorkerSessionFromStepStarted(stepEv);
      if (session && !workerSession) {
        workerSession = session;
        console.log(`attach_command=${attachCommandForSession(session)}`);
      }
    }

    const terminal = await waitForEventFromEvents(
      client, events,
      (e) => e.run_id === run.run_id && isTerminalEvent(e.name),
      "terminal", TERMINAL_TIMEOUT_MS,
    );
    console.log(`terminal: ${terminal.name}`);

    const modelOutputMarker = modelOutputTexts.some((t) => t.includes(args.marker))
      ? "found"
      : "not_found";

    const timeline = runId
      ? events.filter((e) => e.run_id === runId).map((e) => `${e.name} (seq=${e.seq})`)
      : [];

    const resultBlock = buildResultBlock({
      marker: args.marker,
      surface: observedSurface ?? "missing",
      worker_session: workerSession ?? "missing",
      terminal: terminal.name,
      model_output_marker: modelOutputMarker,
      controller: args.controller,
      run_id: runId ?? "missing",
      attach_command: workerSession ? attachCommandForSession(workerSession) : "missing",
      timeline: timeline.join("; "),
      result: "pass",
    });
    console.log(resultBlock);
    return 0;
  } catch (error) {
    const msg = describeError(error);
    console.error(`FAIL chain-client ${msg}`);
    const timeline = runId
      ? events.filter((e) => e.run_id === runId).map((e) => `${e.name} (seq=${e.seq})`)
      : [];
    const resultBlock = buildResultBlock({
      marker: args.marker,
      surface: "error",
      worker_session: workerSession ?? "missing",
      terminal: "error",
      model_output_marker: "not_found",
      controller: args.controller,
      run_id: runId ?? "missing",
      attach_command: workerSession ? attachCommandForSession(workerSession) : "missing",
      timeline: timeline.join("; "),
      result: "error",
    });
    console.log(resultBlock);
    return 1;
  } finally {
    if (subscriptionId) {
      await client
        .call("events.unsubscribe", { subscription_id: subscriptionId }, 5_000)
        .catch(() => undefined);
    }
    await client.close();
    rmSync(smokeCwd, { recursive: true, force: true });
  }
}

// ── runner mode ────────────────────────────────────────────────────────────

async function runRunnerMode(): Promise<number> {
  if (!visibleAgentChainSmokeEnabled(process.env)) {
    console.log("SKIP HOLP_VISIBLE_AGENT_CHAIN_SMOKE=1 not set");
    return 0;
  }

  const controllerEnv = process.env.HOLP_VISIBLE_AGENT_CHAIN_CONTROLLER ?? "codex";
  if (!isEnabledController(controllerEnv)) {
    const reason = DISABLED_CONTROLLERS[controllerEnv] ?? "unknown_controller";
    console.error(`FAIL controller=${controllerEnv} reason=${reason}`);
    console.log(cmuxStatusLine());
    return 1;
  }
  const controller = controllerEnv as ControllerTransport;
  const workerTransport =
    process.env.HOLP_VISIBLE_AGENT_CHAIN_WORKER ?? workerForController(controller);
  const marker = generateMarker();
  const cmuxEnabled = cmuxVisibleAgentChainEnabled(process.env);
  const cmuxWorkspace = cmuxWorkspaceFromEnv(process.env);

  console.log("HOLP visible agent chain smoke");
  console.log(`controller=${controller} worker=${workerTransport} marker=${marker}`);
  console.log(
    `cmux_claim=${cmuxEnabled ? (cmuxWorkspace ? "enabled" : "enabled_no_workspace") : "not_requested"}`,
  );

  const clientCommand = buildClientCommand({
    workerTransport,
    marker,
    controller,
  });

  const prompt = [
    `You are the HOLP visible chain smoke controller (${controller}).`,
    `Run the following command in the repo directory and echo its EXACT output block verbatim (including boundary lines, no modification):`,
    ``,
    `  ${clientCommand}`,
    ``,
    `The command must run in: ${repoRoot}`,
    `The output will contain a block starting with ${RESULT_BEGIN} and ending with ${RESULT_END}.`,
    `Echo that entire block in your response. The block contains the marker: ${marker}`,
  ].join("\n");

  const spec = buildControllerSpec(controller, prompt, repoRoot);
  console.log(`spawning: controller=${controller} command=${spec.command}`);

  let controllerOutput = "";
  let controllerFailed = false;
  let spawnError: string | undefined;

  try {
    controllerOutput = await spawnController(spec, CONTROLLER_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof ControllerNonZeroError) {
      controllerOutput = error.stdout;
      controllerFailed = true;
      console.log(`controller: exit_code=${error.code}`);
    } else {
      spawnError = describeError(error);
      console.error(`FAIL controller_spawn ${spawnError}`);
    }
  }

  if (controllerOutput) {
    const printLines = controllerOutput.split("\n").slice(0, 60);
    console.log(`controller stdout (first ${printLines.length} lines):`);
    for (const line of printLines) console.log(`  ctrl: ${line}`);
  }

  const resultBlock = parseResultBlock(controllerOutput);
  if (!resultBlock && !spawnError) {
    console.error(
      `FAIL result_block_not_found controller output missing ${RESULT_BEGIN}...${RESULT_END}`,
    );
  }

  const markerGateFailed = evaluateMarkerGate(resultBlock, controllerOutput, marker);
  if (markerGateFailed) {
    console.error(`FAIL marker_triangulation_failed marker=${marker} not in controller stdout`);
  }

  let gateError: string | undefined;
  if (resultBlock) {
    try {
      assertSuccessGate(resultBlock);
    } catch (error) {
      gateError = describeError(error);
      console.error(`FAIL ${gateError}`);
    }
  }

  let finalResult: "pass" | "fail" | "error";
  if (spawnError) {
    finalResult = "error";
  } else if (!resultBlock || gateError || markerGateFailed || controllerFailed) {
    finalResult = "fail";
  } else {
    finalResult = "pass";
  }

  if (cmuxEnabled) {
    const timelineString = resultBlock?.timeline ?? "";
    const dashboardPath = updateDashboardForMarker(marker, {
      controller,
      worker: workerTransport,
      marker,
      runId: resultBlock?.run_id,
      workerSession: resultBlock?.worker_session,
      attachCommand: resultBlock?.attach_command,
      timeline: timelineString ? timelineString.split("; ") : [],
      finalResult,
      cmuxStatus: cmuxStatusLine(),
    });
    console.log(`dashboard_path=${dashboardPath}`);

    if (cmuxWorkspace) {
      const cmuxResults = await runCmuxDashboardCommands({
        dashboardPath,
        workspace: cmuxWorkspace,
        finalResult,
        marker,
        cwd: repoRoot,
      });
      const summary = cmuxResults
        .map((r) => `${r.command}: ${r.ok ? "ok" : `fail(${r.error})`}`)
        .join("; ");
      for (const r of cmuxResults) {
        console.log(`cmux_cmd ok=${r.ok} command=${r.command}${r.error ? ` error=${r.error}` : ""}`);
      }
      const degraded = !cmuxResults.every((r) => r.ok);
      updateDashboardForMarker(marker, {
        controller,
        worker: workerTransport,
        marker,
        runId: resultBlock?.run_id,
        workerSession: resultBlock?.worker_session,
        attachCommand: resultBlock?.attach_command,
        timeline: timelineString ? timelineString.split("; ") : [],
        finalResult,
        cmuxStatus: degraded ? `${cmuxStatusLine()} (degraded: cmux command failure)` : cmuxStatusLine(),
        cmuxCommandSummary: summary,
      });
    }
  }

  if (finalResult === "pass") {
    console.log(`${PASS_MARKER} cmux-validation`);
    console.log(cmuxStatusLine());
    return 0;
  }

  if (controllerFailed) {
    console.error("FAIL controller_non_zero");
  }
  console.log(cmuxStatusLine());
  return 1;
}

// ── spawn helper ───────────────────────────────────────────────────────────

class ControllerNonZeroError extends Error {
  constructor(
    readonly stdout: string,
    readonly code: number,
  ) {
    super(`controller exited ${code}`);
  }
}

function spawnController(spec: ControllerSpec, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      stdio: [spec.ignoreStdin ? "ignore" : "pipe", "pipe", "inherit"],
      env: { ...process.env },
    });
    const chunks: string[] = [];
    proc.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`controller timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.once("close", (code) => {
      clearTimeout(timer);
      const stdout = chunks.join("");
      if (code === 0) resolve(stdout);
      else reject(new ControllerNonZeroError(stdout, code ?? 1));
    });
    proc.once("error", reject);
  });
}

// ── internal helpers ───────────────────────────────────────────────────────

function waitForEventFromEvents(
  client: DaemonClient,
  events: readonly EventFrame[],
  predicate: (event: EventFrame) => boolean,
  label: string,
  timeoutMs: number,
): Promise<EventFrame> {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return client.waitForEvent(predicate, label, timeoutMs);
}

function surfaceFromRunStarted(event: EventFrame): string | undefined {
  const payload = objectPayload(event.payload);
  const runtime = objectPayload(payload.runtime);
  return stringField(runtime, "runtime_surface");
}

function describeError(error: unknown): string {
  if (error instanceof RpcError)
    return `rpc code=${error.payload.code} message=${error.payload.message}`;
  return error instanceof Error ? error.message : String(error);
}

// ── CLI entry ──────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (argv.includes("--client")) {
    const get = (flag: string): string | undefined => {
      const i = argv.indexOf(flag);
      return i !== -1 ? argv[i + 1] : undefined;
    };
    const workerTransport = get("--worker");
    const marker = get("--marker");
    const controller = get("--controller");
    if (!workerTransport || !marker || !controller) {
      console.error("FAIL client mode requires --worker, --marker, --controller");
      process.exitCode = 1;
    } else {
      process.exitCode = await runClientMode({ workerTransport, marker, controller });
    }
  } else {
    process.exitCode = await runRunnerMode();
  }
}
