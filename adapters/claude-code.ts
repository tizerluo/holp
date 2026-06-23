import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentBackend,
  AgentBackendFactory,
  AgentBackendOptions,
  AgentMessageHandler,
  AgentProbeInput,
  AgentProbeResult,
} from "./agent-backend.js";
import {
  rejectedProfiles,
  withProfile,
  type DirectChannelDeclaration,
  type IsolationProfileReadiness,
  type RuntimeSurfaceDeclaration,
} from "./harness-declaration.js";

const DEFAULT_CLAUDE_COMMAND = "claude";
const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUDGET_USD = "1.00";
export const READ_ONLY_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "LS",
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git log:*)",
  "WebFetch",
  "WebSearch",
].join(",");

interface CommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ClaudeCodeBackendOptions {
  readonly command?: string;
  readonly argsPrefix?: readonly string[];
  readonly model?: string;
  readonly allowedTools?: string;
  readonly settingSources?: "project" | "user" | "local" | "project,user" | (string & {});
  readonly maxBudgetUsd?: string;
  readonly timeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly directSmokeRunner?: () => Promise<"ok" | "fail" | "skip">;
}

interface ClaudeJsonResult {
  readonly result: string;
  readonly session_id?: string;
  readonly total_cost_usd?: number;
  readonly modelUsage?: unknown;
}

type ClaudeJsonParseResult =
  | { readonly ok: true; readonly output: ClaudeJsonResult }
  | { readonly ok: false; readonly reason: string };

export function createClaudeCodeBackendFactory(
  options: ClaudeCodeBackendOptions = {},
): AgentBackendFactory {
  return (opts) => new ClaudeCodeBackend(opts, options);
}

export async function probeClaudeCode(
  input: AgentProbeInput,
  options: ClaudeCodeBackendOptions = {},
): Promise<AgentProbeResult> {
  const command = options.command ?? DEFAULT_CLAUDE_COMMAND;
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const version = await runBounded(command, [...(options.argsPrefix ?? []), "--version"], {
    cwd: input.cwd,
    timeoutMs: Math.min(Math.max(1_000, timeoutMs), 5_000),
  });

  if (version.code !== 0) {
    const reason = version.timedOut ? "claude_version_probe_timeout" : "missing_binary_claude";
    return claudeProbeResult(input, "rejected", reason, {
      version: cleanVersion(version.stdout, version.stderr),
      loggedIn: false,
      missing: ["binary:claude", ...input.roles.map((role) => `role:${role}`)],
      directSmokeResult: "skip",
    });
  }

  const capability = await runClaudePrint({
    cwd: input.cwd,
    prompt: [
      "HOLP native-claude capability probe.",
      "Return exactly this JSON object as your final answer and no prose:",
      "{\"holp_probe\":\"ok\"}",
    ].join("\n"),
    options,
    timeoutMs,
  });
  const capabilityParsed = parseClaudeJsonOutput(capability.stdout);
  if (capability.code !== 0 || !capabilityParsed.ok) {
    return claudeProbeResult(input, "degraded", capabilityReason(capability, capabilityParsed), {
      version: cleanVersion(version.stdout, version.stderr),
      loggedIn: false,
      missing: ["auth_or_quota:claude", "capability_probe"],
      directSmokeResult: "skip",
    });
  }

  // Run direct smoke in parallel with enforcement probe only when opted in.
  const shouldRunDirectSmoke = process.env["HOLP_REAL_CLAUDE_SMOKE"] === "1" || options.directSmokeRunner !== undefined;
  const [enforcement, directSmokeResult] = await Promise.all([
    runEnforcementProbe(input.cwd, options, timeoutMs),
    shouldRunDirectSmoke ? runDirectSmoke(input.cwd, options, timeoutMs) : Promise.resolve<"ok" | "fail" | "skip">("skip"),
  ]);

  const enforcementParsed = parseClaudeJsonOutput(enforcement.result.stdout);
  const enforcementReady = enforcement.result.code === 0 &&
    enforcementParsed.ok &&
    enforcement.writeBlocked &&
    hasWriteDenialEvidence(enforcement.result.stdout);

  if (!enforcementReady) {
    // Direct smoke may still have succeeded; top-level status promotes to ready,
    // but headless surface stays degraded (enforcement not proven).
    return claudeProbeResult(input, directSmokeResult === "ok" ? "ready" : "degraded", "read_only_enforcement_not_proven", {
      version: cleanVersion(version.stdout, version.stderr),
      loggedIn: true,
      globalMutationRequired: usesGlobalSettings(options.settingSources),
      missing: ["read_only_enforcement"],
      warnings: ["inherits:oauth_keychain", "inherits:provider_quota"],
      directSmokeResult,
      headlessStatus: "degraded",
    });
  }

  return claudeProbeResult(input, "ready", undefined, {
    version: cleanVersion(version.stdout, version.stderr),
    loggedIn: true,
    globalMutationRequired: usesGlobalSettings(options.settingSources),
    warnings: ["inherits:oauth_keychain", "inherits:provider_quota"],
    directSmokeResult,
  });
}

async function runDirectSmoke(
  cwd: string,
  options: ClaudeCodeBackendOptions,
  timeoutMs: number,
): Promise<"ok" | "fail" | "skip"> {
  if (options.directSmokeRunner !== undefined) {
    return options.directSmokeRunner();
  }
  const { probeDirectTmux, createDirectTmuxBackendFactory } = await import("./direct-tmux.js");
  const command = options.command ?? DEFAULT_CLAUDE_COMMAND;
  const probe = await probeDirectTmux({ agentCommand: command, cwd, verifyCapabilities: true, timeoutMs: 5_000 });
  if (!probe.ready) return "fail";

  const factory = createDirectTmuxBackendFactory({
    transport: "direct_tmux",
    agentCommand: command,
    agentArgsForPrompt: (prompt) => [
      "-p", prompt,
      "--output-format", "json",
      "--allowedTools", options.allowedTools ?? READ_ONLY_ALLOWED_TOOLS,
    ],
    timeoutMs,
  });
  const backend = factory({ cwd });
  try {
    const { sessionId } = await backend.startSession();
    let captured = "";
    backend.onMessage((msg) => {
      if (msg.type === "model-output" && msg.fullText != null) captured = msg.fullText;
    });
    await backend.sendPrompt(sessionId, "Print exactly: HOLP_OK");
    return captured.includes("HOLP_OK") ? "ok" : "fail";
  } catch {
    return "fail";
  } finally {
    await backend.dispose().catch(() => undefined);
  }
}

export class ClaudeCodeBackend implements AgentBackend {
  private readonly opts: AgentBackendOptions;
  private readonly options: ClaudeCodeBackendOptions;
  private handlers: AgentMessageHandler[] = [];
  private sessionId: string | undefined;
  private currentProcess: ChildProcess | undefined;
  private cancelled = false;

  constructor(opts: AgentBackendOptions, options: ClaudeCodeBackendOptions = {}) {
    this.opts = opts;
    this.options = options;
  }

  async startSession(): Promise<{ sessionId: string }> {
    this.sessionId = `claude-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.emit({ type: "status", status: "starting" });
    return { sessionId: this.sessionId };
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    if (sessionId !== this.sessionId) throw new Error(`unknown claude session '${sessionId}'`);
    if (this.cancelled) return;
    this.emit({ type: "status", status: "running" });
    const result = await runClaudePrint({
      cwd: this.opts.cwd,
      env: this.opts.env,
      prompt,
      options: {
        ...this.options,
        model: this.opts.modelId ?? this.options.model,
      },
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onProcess: (child) => {
        this.currentProcess = child;
      },
    });
    this.currentProcess = undefined;
    if (this.cancelled) return;
    const parsed = parseClaudeJsonOutput(result.stdout);
    if (result.code !== 0 || !parsed.ok) {
      throw new Error(capabilityReason(result, parsed));
    }
    this.emit({ type: "model-output", fullText: parsed.output.result });
    this.emit({ type: "status", status: "idle" });
  }

  async cancel(sessionId: string): Promise<void> {
    if (sessionId !== this.sessionId) return;
    this.cancelled = true;
    this.currentProcess?.kill("SIGTERM");
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers = this.handlers.filter((candidate) => candidate !== handler);
  }

  async dispose(): Promise<void> {
    this.currentProcess?.kill("SIGTERM");
    this.currentProcess = undefined;
  }

  private emit(message: Parameters<AgentMessageHandler>[0]): void {
    for (const handler of this.handlers) handler(message);
  }
}

function claudeProbeResult(
  input: AgentProbeInput,
  status: "ready" | "degraded" | "rejected",
  reason: string | undefined,
  details: {
    readonly version?: string;
    readonly loggedIn?: boolean;
    readonly globalMutationRequired?: boolean;
    readonly missing?: readonly string[];
    readonly warnings?: readonly string[];
    readonly directSmokeResult?: "ok" | "fail" | "skip";
    readonly headlessStatus?: "ready" | "degraded" | "rejected";
  } = {},
): AgentProbeResult {
  const headlessStatus = details.headlessStatus ?? status;
  return {
    status,
    harness_id: "claude-code",
    vendor: "Anthropic",
    transport_class: input.transport,
    runtime_surfaces: claudeRuntimeSurfaces(headlessStatus, reason, details),
    state_declaration_ref: "harness-state:claude-code",
    global_mutation_required: details.globalMutationRequired ?? false,
    version: details.version,
    logged_in: details.loggedIn,
    resolved_roles: status === "rejected" ? [] : supportedRoles(input.roles),
    missing: details.missing,
    reason,
  };
}

function supportedRoles(roles: readonly string[]): readonly string[] {
  const supported = roles.filter((role) => role === "reviewer" || role === "tester" || role === "architect");
  return supported.length > 0 ? supported : ["reviewer"];
}

function claudeRuntimeSurfaces(
  status: "ready" | "degraded" | "rejected",
  reason: string | undefined,
  details: {
    readonly globalMutationRequired?: boolean;
    readonly missing?: readonly string[];
    readonly warnings?: readonly string[];
    readonly directSmokeResult?: "ok" | "fail" | "skip";
  },
): readonly RuntimeSurfaceDeclaration[] {
  const readOnly: IsolationProfileReadiness = status === "ready"
    ? { readiness: "ready", warnings: details.warnings }
    : status === "degraded"
      ? {
          readiness: "degraded",
          reason: reason ?? "claude_read_only_review_degraded",
          missing: details.missing ?? ["read_only_enforcement"],
          warnings: details.warnings,
        }
      : {
          readiness: "rejected",
          reason: reason ?? "claude_unavailable",
          missing: details.missing,
        };
  let profiles = rejectedProfiles(
    status === "rejected" ? (reason ?? "claude_unavailable") : "unsupported_isolation_profile",
    status === "rejected" ? (details.missing ?? []) : [],
  );
  profiles = withProfile(profiles, "read_only_review", readOnly);
  profiles = withProfile(profiles, "real_provider_smoke", status === "rejected"
    ? { readiness: "rejected", reason: reason ?? "claude_unavailable", missing: details.missing }
    : { readiness: "ready", warnings: details.warnings });

  const directSmoke = details.directSmokeResult ?? "skip";
  const coderWorktreeProfile: IsolationProfileReadiness = directSmoke === "ok"
    ? { readiness: "ready", warnings: details.warnings }
    : directSmoke === "fail"
      ? { readiness: "degraded", reason: "claude_direct_smoke_failed", missing: ["direct_smoke:HOLP_OK"] }
      : { readiness: "degraded", reason: "claude_direct_smoke_not_enabled", missing: ["env:HOLP_REAL_CLAUDE_SMOKE"] };

  const directChannel: DirectChannelDeclaration = {
    channel_type: "tmux",
    attach: "supported",
    observe: "supported",
    read: "supported",
    inject: "supported",
    interrupt: "supported",
    cancel: "supported",
    owner_scope: "supported",
    session_origin: "holp_created",
    session_id_namespace: "holp-*",
    ...(directSmoke === "ok" ? { capability_bitmask: ["one_shot", "read_only", "holp_ok_verified"] } : {}),
  };

  return [
    {
      runtime_surface: "headless",
      runtime_kind: "claude_code_print_json",
      actual_fidelity: "one_shot",
      surface_support: status === "rejected" ? "unsupported" : "supported",
      isolation_profiles: profiles,
      state_declaration_ref: "harness-state:claude-code:headless",
      global_mutation_required: details.globalMutationRequired ?? false,
      declared_not_enforced: status !== "ready",
    },
    {
      runtime_surface: "acp",
      runtime_kind: "claude_code_no_acp",
      actual_fidelity: "one_shot",
      surface_support: "unsupported",
      isolation_profiles: rejectedProfiles("claude_no_native_acp"),
      state_declaration_ref: "harness-state:claude-code:acp",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
    {
      runtime_surface: "direct_user_session",
      runtime_kind: "claude_code_direct_tmux",
      actual_fidelity: "one_shot",
      surface_support: "supported",
      isolation_profiles: withProfile(
        withProfile(
          rejectedProfiles("unsupported_isolation_profile"),
          "coder_worktree",
          coderWorktreeProfile,
        ),
        "read_only_review",
        {
          readiness: "degraded",
          reason: "claude_direct_read_only_review_not_wired",
          missing: ["direct_reviewer_execution_config"],
        },
      ),
      direct_channel: directChannel,
      state_declaration_ref: "harness-state:claude-code:direct_user_session",
      global_mutation_required: false,
      declared_not_enforced: directSmoke !== "ok",
    },
  ];
}


function parseClaudeJsonOutput(stdout: string): ClaudeJsonParseResult {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { ok: false, reason: "claude_empty_output" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "claude_outer_json_parse_failed" };
  }
  if (!isObject(parsed) || Array.isArray(parsed)) {
    return { ok: false, reason: "claude_outer_json_not_object" };
  }
  if (parsed.is_error === true) {
    return { ok: false, reason: classifyClaudeOuterError(parsed) };
  }
  if (parsed.subtype !== undefined && parsed.subtype !== "success") {
    return { ok: false, reason: `claude_outer_subtype_${String(parsed.subtype)}` };
  }
  if (typeof parsed.result !== "string") {
    return { ok: false, reason: "claude_outer_result_missing" };
  }
  return {
    ok: true,
    output: {
      result: parsed.result,
      session_id: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
      total_cost_usd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined,
      modelUsage: parsed.modelUsage,
    },
  };
}

function capabilityReason(result: CommandResult, parsed: ClaudeJsonParseResult): string {
  if (result.timedOut) return "claude_cli_timeout";
  if (parsed.ok) return result.code === 0 ? "claude_ok" : `claude_cli_exit_${result.code ?? "signal"}`;
  return parsed.reason;
}

function classifyClaudeOuterError(parsed: Record<string, unknown>): string {
  const text = [
    typeof parsed.result === "string" ? parsed.result : "",
    typeof parsed.subtype === "string" ? parsed.subtype : "",
    typeof parsed.api_error_status === "number" ? String(parsed.api_error_status) : "",
  ].join(" ");
  if (parsed.api_error_status === 429 || /rate limit|session limit|too many requests/i.test(text)) {
    return "claude_cli_rate_limited";
  }
  if (/auth|login|oauth|api key/i.test(text)) return "claude_cli_auth_unavailable";
  if (/quota|budget|billing|usage/i.test(text)) return "claude_cli_quota_unavailable";
  if (/model/i.test(text)) return "claude_cli_model_unavailable";
  return "claude_outer_is_error";
}

function hasWriteDenialEvidence(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout.trim());
    return hasDenialSignal(parsed);
  } catch {
    return false;
  }
}

function hasDenialSignal(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDenialSignal);
  if (typeof value === "string") {
    return /permission[_\s-]?denied|denied by tool policy|tool not allowed|not allowed/i.test(value);
  }
  if (!isObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (/permission.*denial|denied|tool.*denial/i.test(key) && Array.isArray(child) && child.length > 0) {
      return true;
    }
    if (hasDenialSignal(child)) return true;
  }
  return false;
}

function runEnforcementProbe(
  cwd: string,
  options: ClaudeCodeBackendOptions,
  timeoutMs: number,
): Promise<{ readonly result: CommandResult; readonly writeBlocked: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "holp-claude-readonly-probe-"));
  const target = join(dir, "should-not-exist.txt");
  return runClaudePrint({
    cwd,
    prompt: [
      "HOLP native-claude read-only enforcement probe.",
      `Attempt exactly one prohibited file-write operation to create ${target}.`,
      "The session tool whitelist should deny that write. Do not try any workaround.",
      "After the denial, return exactly this JSON object as your final answer:",
      "{\"holp_read_only_probe\":\"done\"}",
    ].join("\n"),
    options,
    timeoutMs,
  }).then((result) => {
    const writeBlocked = !existsSync(target);
    rmSync(dir, { recursive: true, force: true });
    return { result, writeBlocked };
  }, (err) => {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  });
}

function runClaudePrint(args: {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly prompt: string;
  readonly options: ClaudeCodeBackendOptions;
  readonly timeoutMs: number;
  readonly onProcess?: (child: ChildProcess) => void;
}): Promise<CommandResult> {
  const options = args.options;
  const cliArgs = [
    ...(options.argsPrefix ?? []),
    "-p",
    args.prompt,
    "--output-format",
    "json",
    "--setting-sources",
    options.settingSources ?? "project",
    "--allowedTools",
    options.allowedTools ?? READ_ONLY_ALLOWED_TOOLS,
    "--model",
    options.model ?? DEFAULT_MODEL,
    "--max-budget-usd",
    options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
  ];
  return runBounded(options.command ?? DEFAULT_CLAUDE_COMMAND, cliArgs, {
    cwd: args.cwd,
    env: args.env,
    timeoutMs: args.timeoutMs,
    onProcess: args.onProcess,
  });
}

function usesGlobalSettings(settingSources: ClaudeCodeBackendOptions["settingSources"]): boolean {
  const sources = settingSources ?? "project";
  return sources.split(",").some((source) => {
    const trimmed = source.trim();
    return trimmed === "user" || trimmed === "local";
  });
}

function runBounded(
  command: string,
  args: readonly string[],
  opts: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly onProcess?: (child: ChildProcess) => void;
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    opts.onProcess?.(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, signal: null, stdout, stderr, timedOut: true });
    }, opts.timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      finish({ code: 127, signal: null, stdout, stderr: stderr || err.message, timedOut: false });
    });
    child.on("close", (code, signal) => {
      finish({ code, signal, stdout, stderr, timedOut: false });
    });
  });
}

function cleanVersion(stdout: string, stderr: string): string | undefined {
  return (stdout || stderr).trim().split(/\r?\n/)[0]?.trim() || undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
