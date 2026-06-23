import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type {
  AgentBackend,
  AgentBackendFactory,
  AgentBackendOptions,
  AgentMessage,
  AgentMessageHandler,
  AgentProbeInput,
  AgentProbeResult,
  PermissionVerdict,
} from "./agent-backend.js";
import {
  rejectedProfiles,
  withProfile,
  type DirectChannelDeclaration,
  type IsolationProfileReadiness,
  type RuntimeSurfaceDeclaration,
} from "./harness-declaration.js";
import { AcpClient } from "./acp-client.js";
import { probeDirectTmux, createDirectTmuxBackendFactory } from "./direct-tmux.js";

const DEFAULT_PROBE_TIMEOUT_MS = 4_000;
const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TURN_RECOVERY_MAX_RETRIES = 1;
const DEFAULT_TURN_RECOVERY_BACKOFF_MS = 1_000;
const DEFAULT_USAGE_LIMIT_BACKOFF_MS = 60_000;
const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_APP_SERVER_ARGS = ["app-server", "--stdio"] as const;

type RequestId = string | number;
type JsonObject = Record<string, unknown>;

interface AppFrame {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingTurn {
  turnId?: string;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type CodexTurnFailureKind = "transient" | "usage_limit" | "fatal" | "cancelled";

interface CodexTurnFailureClassification {
  readonly kind: CodexTurnFailureKind;
  readonly reason: string;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;
}

export type SmokeRunnerResult = "ok" | "fail" | "skip";

export interface CodexAppServerBackendOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly probeTimeoutMs?: number;
  readonly sandbox?: "workspace-write" | "read-only" | (string & {});
  readonly maxTurnRecoveryRetries?: number;
  readonly turnRecoveryBackoffMs?: number;
  readonly usageLimitBackoffMs?: number;
  readonly recoverySleep?: (ms: number) => Promise<void>;
  /** Injectable ACP smoke runner for testing opt-in path. Real runner runs only when HOLP_REAL_CODEX_SMOKE=1. */
  readonly acpSmokeRunner?: () => Promise<SmokeRunnerResult>;
  /** Injectable direct smoke runner for testing opt-in path. Real runner runs only when HOLP_REAL_CODEX_SMOKE=1. */
  readonly directSmokeRunner?: () => Promise<SmokeRunnerResult>;
}

export function createCodexAppServerBackendFactory(
  options: CodexAppServerBackendOptions = {},
): AgentBackendFactory {
  return (opts) => new CodexAppServerBackend(opts, options);
}

export async function probeCodexAppServer(
  input: AgentProbeInput,
  options: CodexAppServerBackendOptions = {},
): Promise<AgentProbeResult> {
  const command = options.command ?? DEFAULT_CODEX_COMMAND;
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const realSmokeEnabled = process.env["HOLP_REAL_CODEX_SMOKE"] === "1";
  const hasSmokeRunners = !!(options.acpSmokeRunner ?? options.directSmokeRunner) || realSmokeEnabled;

  // Capture headless status into variables so smoke can still run when runners are present.
  let headlessStatus: "ready" | "degraded" | "rejected" = "rejected";
  let headlessReason: string | undefined;
  let headlessVersion: string | undefined;
  let headlessLoggedIn: boolean | undefined;
  let headlessResolvedRoles: readonly string[] = [];
  let headlessMissing: string[] = [];
  let headlessUserAgent: string | undefined;
  let earlyExitResult: AgentProbeResult | undefined;

  const version = await runBounded(command, ["--version"], {
    cwd: input.cwd,
    timeoutMs: Math.min(Math.max(1_000, timeoutMs), 5_000),
  });
  if (version.code !== 0) {
    headlessStatus = "rejected";
    headlessReason = version.timedOut ? "codex_version_probe_timeout" : "missing_binary_codex";
    headlessMissing = ["binary:codex", ...input.roles.map((role) => `role:${role}`)];
    earlyExitResult = {
      status: "rejected",
      harness_id: "codex",
      vendor: "OpenAI",
      transport_class: input.transport,
      runtime_surfaces: codexRuntimeSurfaces("rejected", headlessReason),
      state_declaration_ref: "harness-state:codex",
      global_mutation_required: false,
      resolved_roles: [],
      logged_in: false,
      missing: headlessMissing,
      reason: headlessReason,
    };
  } else {
    headlessVersion = cleanVersion(version.stdout, version.stderr);

    const doctor = await runBounded(command, ["doctor"], {
      cwd: input.cwd,
      timeoutMs: Math.max(1_000, timeoutMs - 1_000),
    });
    const doctorText = `${doctor.stdout}\n${doctor.stderr}`;
    const loggedIn = /auth\s+is configured/i.test(doctorText);
    const mentionsAuth = /auth/i.test(doctorText);
    if (!loggedIn) {
      headlessStatus = mentionsAuth ? "rejected" : "degraded";
      headlessReason = mentionsAuth ? "codex_auth_not_configured" : "codex_auth_status_unknown";
      headlessMissing = ["auth:codex", ...input.roles.map((role) => `role:${role}`)];
      earlyExitResult = {
        status: headlessStatus,
        harness_id: "codex",
        vendor: "OpenAI",
        transport_class: input.transport,
        runtime_surfaces: codexRuntimeSurfaces(headlessStatus, headlessReason),
        state_declaration_ref: "harness-state:codex",
        global_mutation_required: false,
        version: headlessVersion,
        logged_in: false,
        resolved_roles: [],
        missing: headlessMissing,
        reason: headlessReason,
      };
    } else {
      headlessLoggedIn = true;
      const init = await probeInitialize(input.cwd, 1_500, options);
      if (!init.ok) {
        headlessStatus = "degraded";
        headlessReason = init.reason;
        headlessMissing = input.roles.map((role) => `role:${role}`);
        earlyExitResult = {
          status: "degraded",
          harness_id: "codex",
          vendor: "OpenAI",
          transport_class: input.transport,
          runtime_surfaces: codexRuntimeSurfaces("degraded", headlessReason),
          state_declaration_ref: "harness-state:codex",
          global_mutation_required: false,
          version: headlessVersion,
          logged_in: headlessLoggedIn || undefined,
          resolved_roles: [],
          missing: headlessMissing,
          reason: headlessReason,
        };
      } else {
        headlessStatus = "ready";
        headlessUserAgent = init.userAgent;
        headlessResolvedRoles = input.roles.length > 0 ? input.roles : ["coder", "reviewer", "tester"];
      }
    }
  }

  // If headless failed and no smoke runners are present, return the early exit result immediately.
  if (headlessStatus !== "ready" && !hasSmokeRunners) {
    return earlyExitResult!;
  }

  // Run opt-in smoke if runners are provided or HOLP_REAL_CODEX_SMOKE=1 env is set.
  // Default: no runners, no env → smoke skipped → ACP/direct stay degraded.
  let smokeResults: { acp: SmokeRunnerResult; direct: SmokeRunnerResult } | undefined;
  if (hasSmokeRunners) {
    // injected runners override real ones (tests); real runners only when env opt-in
    const acpResult = options.acpSmokeRunner
      ? await options.acpSmokeRunner()
      : realSmokeEnabled
        ? await runRealAcpSmoke(input.cwd)
        : ("skip" as SmokeRunnerResult);
    const directResult = options.directSmokeRunner
      ? await options.directSmokeRunner()
      : realSmokeEnabled
        ? await runRealDirectSmoke(input.cwd)
        : ("skip" as SmokeRunnerResult);
    smokeResults = { acp: acpResult, direct: directResult };
  }

  // Top-level status is ready if headless passed OR any ACP/direct coder_worktree surface is ready.
  const acpReady = smokeResults?.acp === "ok";
  const directReady = smokeResults?.direct === "ok";
  const anyReady = headlessStatus === "ready" || acpReady || directReady;

  if (!anyReady) {
    // Headless failed and no smoke surface proved ready — return original headless failure.
    return earlyExitResult!;
  }

  const resolvedVersion = headlessUserAgent ?? headlessVersion;
  return {
    status: "ready",
    harness_id: "codex",
    vendor: "OpenAI",
    transport_class: input.transport,
    runtime_surfaces: codexRuntimeSurfaces(headlessStatus, headlessReason, smokeResults),
    state_declaration_ref: "harness-state:codex",
    global_mutation_required: false,
    version: resolvedVersion,
    logged_in: headlessLoggedIn || undefined,
    resolved_roles: headlessStatus === "ready"
      ? headlessResolvedRoles
      : input.roles.length > 0 ? input.roles : ["coder", "reviewer", "tester"],
  };
}

async function runRealAcpSmoke(cwd: string): Promise<SmokeRunnerResult> {
  const client = new AcpClient({ command: "codex-acp", cwd, requestTimeoutMs: 10_000, terminalTimeoutMs: 30_000 });
  try {
    const { sessionId } = await client.startSession();
    const output = await client.sendPrompt(sessionId, "Reply with exactly the token HOLP_OK and nothing else.");
    return output.includes("HOLP_OK") ? "ok" : "fail";
  } catch {
    return "fail";
  } finally {
    await client.dispose();
  }
}

async function runRealDirectSmoke(cwd: string): Promise<SmokeRunnerResult> {
  const probe = await probeDirectTmux({ agentCommand: "codex", cwd, verifyCapabilities: true });
  if (!probe.ready) return "fail";
  const factory = createDirectTmuxBackendFactory({
    transport: "direct_tmux",
    agentCommand: "codex",
    agentArgsForPrompt: (prompt) => [
      "exec", "--sandbox", "workspace-write",
      "-c", 'approval_policy="never"',
      "--skip-git-repo-check",
      "-c", "notify=[]",
      prompt,
    ],
    timeoutMs: 30_000,
  });
  const backend = factory({ cwd });
  try {
    const { sessionId } = await backend.startSession();
    let fullText = "";
    backend.onMessage((msg) => { if (msg.type === "model-output" && msg.fullText) fullText = msg.fullText; });
    await backend.sendPrompt(sessionId, "Reply with exactly the token HOLP_OK and nothing else.");
    return fullText.includes("HOLP_OK") ? "ok" : "fail";
  } catch {
    return "fail";
  } finally {
    await backend.dispose();
  }
}

function codexRuntimeSurfaces(
  headlessStatus: "ready" | "degraded" | "rejected",
  headlessReason?: string,
  smokeResults?: { acp: SmokeRunnerResult; direct: SmokeRunnerResult },
): readonly RuntimeSurfaceDeclaration[] {
  const baseReadiness: IsolationProfileReadiness =
    headlessStatus === "ready"
      ? { readiness: "ready", warnings: ["declared_not_enforced"] }
      : headlessStatus === "degraded"
        ? {
            readiness: "degraded",
            reason: headlessReason,
            missing: headlessReason ? [headlessReason] : undefined,
            warnings: ["declared_not_enforced"],
          }
        : {
            readiness: "rejected",
            reason: headlessReason ?? "codex_unavailable",
            missing: headlessReason ? [headlessReason] : undefined,
          };

  let appServerProfiles = rejectedProfiles("unsupported_isolation_profile");
  appServerProfiles = withProfile(appServerProfiles, "coder_worktree", baseReadiness);
  appServerProfiles = withProfile(appServerProfiles, "read_only_review", {
    readiness: headlessStatus === "rejected" ? "rejected" : "degraded",
    reason: headlessStatus === "rejected" ? headlessReason : "read_only_not_enforced",
    missing: headlessStatus === "rejected" && headlessReason ? [headlessReason] : ["read_only_enforcement"],
    warnings: headlessStatus === "rejected" ? undefined : ["declared_not_enforced"],
  });
  appServerProfiles = withProfile(appServerProfiles, "real_provider_smoke", {
    readiness: headlessStatus === "rejected" ? "rejected" : "ready",
    reason: headlessStatus === "rejected" ? headlessReason : undefined,
    missing: headlessStatus === "rejected" && headlessReason ? [headlessReason] : undefined,
    warnings: headlessStatus === "rejected"
      ? undefined
      : ["inherits:network", "inherits:provider_quota", "declared_not_enforced"],
  });
  appServerProfiles = withProfile(appServerProfiles, "high_isolation", {
    readiness: headlessStatus === "rejected" ? "rejected" : "degraded",
    reason: headlessStatus === "rejected" ? headlessReason : "high_isolation_not_proven",
    missing: headlessStatus === "rejected" && headlessReason
      ? [headlessReason]
      : ["full_env_filter", "keychain_isolation"],
    warnings: headlessStatus === "rejected" ? undefined : ["declared_not_enforced"],
  });

  // ACP/direct default to degraded without opt-in smoke; opt-in via HOLP_REAL_CODEX_SMOKE=1 or injected runner.
  const acpSmokeOk = smokeResults?.acp === "ok";
  const acpSmokeFailed = smokeResults?.acp === "fail";
  let acpProfiles = rejectedProfiles("unsupported_isolation_profile");
  acpProfiles = withProfile(acpProfiles, "coder_worktree", acpSmokeOk
    ? { readiness: "ready", warnings: ["declared_not_enforced"] }
    : {
        readiness: "degraded",
        reason: acpSmokeFailed ? "codex_acp_smoke_failed" : "codex_acp_smoke_not_enabled",
        missing: acpSmokeFailed ? ["acp:smoke_ok"] : ["env:HOLP_REAL_CODEX_SMOKE"],
        warnings: ["declared_not_enforced"],
      });
  acpProfiles = withProfile(acpProfiles, "read_only_review", {
    readiness: "degraded",
    reason: "codex_acp_reviewer_not_wired",
    missing: ["read_only_enforcement", "reviewer_execution_config"],
    warnings: ["declared_not_enforced"],
  });

  const directSmokeOk = smokeResults?.direct === "ok";
  const directSmokeFailed = smokeResults?.direct === "fail";
  let directProfiles = rejectedProfiles("unsupported_isolation_profile");
  directProfiles = withProfile(directProfiles, "coder_worktree", directSmokeOk
    ? { readiness: "ready", warnings: ["declared_not_enforced"] }
    : {
        readiness: "degraded",
        reason: directSmokeFailed ? "codex_direct_smoke_failed" : "codex_direct_smoke_not_enabled",
        missing: directSmokeFailed ? ["direct:smoke_ok"] : ["env:HOLP_REAL_CODEX_SMOKE"],
        warnings: ["declared_not_enforced"],
      });
  directProfiles = withProfile(directProfiles, "read_only_review", {
    readiness: "degraded",
    reason: "codex_direct_reviewer_not_wired",
    missing: ["read_only_enforcement", "reviewer_execution_config"],
    warnings: ["declared_not_enforced"],
  });

  return [
    {
      runtime_surface: "headless",
      runtime_kind: "app_server",
      actual_fidelity: "streaming_controlled",
      surface_support: headlessStatus === "rejected" ? "unsupported" : "supported",
      isolation_profiles: appServerProfiles,
      state_declaration_ref: "harness-state:codex",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
    {
      runtime_surface: "acp",
      runtime_kind: "codex_acp",
      actual_fidelity: "streaming_controlled",
      surface_support: "supported",
      isolation_profiles: acpProfiles,
      state_declaration_ref: "harness-state:codex:acp",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
    {
      runtime_surface: "direct_user_session",
      runtime_kind: "codex_direct_tmux",
      actual_fidelity: "streaming_controlled",
      surface_support: "supported",
      isolation_profiles: directProfiles,
      direct_channel: codexDirectChannel(directSmokeOk),
      state_declaration_ref: "harness-state:codex:direct",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
  ];
}

function codexDirectChannel(smokeProven = false): DirectChannelDeclaration {
  return {
    channel_type: "terminal_app",
    attach: "supported",
    observe: "supported",
    read: "supported",
    inject: "supported",
    interrupt: "supported",
    cancel: "supported",
    owner_scope: "supported",
    session_origin: "holp_created",
    session_id_namespace: "holp-*",
    capability_bitmask: smokeProven ? ["exec", "observe", "read", "inject", "interrupt", "cancel", "owner_verified"] : [],
  };
}

async function probeInitialize(
  cwd: string,
  timeoutMs: number,
  options: CodexAppServerBackendOptions,
): Promise<{ ok: true; userAgent?: string } | { ok: false; reason: string }> {
  const client = new AppServerClient({ cwd, timeoutMs, options });
  try {
    const result = await client.startAndInitialize();
    return {
      ok: true,
      userAgent: isObject(result) && typeof result.userAgent === "string" ? result.userAgent : undefined,
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.dispose();
  }
}

export class CodexAppServerBackend implements AgentBackend {
  private readonly opts: AgentBackendOptions;
  private readonly options: CodexAppServerBackendOptions;
  private readonly client: AppServerClient;
  private handlers: AgentMessageHandler[] = [];
  private sessionId: string | undefined;
  private pendingTurn: PendingTurn | undefined;
  private currentTurnHadActivity = false;
  private readonly emittedFileChanges = new Set<string>();
  private cancelled = false;

  constructor(opts: AgentBackendOptions, options: CodexAppServerBackendOptions = {}) {
    this.opts = opts;
    this.options = options;
    this.client = new AppServerClient({
      cwd: opts.cwd,
      env: opts.env,
      options,
      timeoutMs: REQUEST_TIMEOUT_MS,
      onFrameReceived: (frame) => this.handleClientFrameReceived(frame),
      onFrame: (frame) => this.handleFrame(frame),
      onProcessFailure: (err) => this.handleClientFailure(err),
    });
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  async startSession(initialPrompt?: string): Promise<{ sessionId: string }> {
    const threadId = await this.startCodexThread("startup");
    if (initialPrompt) await this.sendPrompt(threadId, initialPrompt);
    if (!this.sessionId) throw new Error("codex app-server session was not started");
    return { sessionId: this.sessionId };
  }

  private async startCodexThread(sessionStartSource: "startup" | "recovery"): Promise<string> {
    if (this.cancelled) throw new Error("codex run cancelled");
    await this.client.startAndInitialize();
    if (this.cancelled) {
      await this.client.dispose();
      throw new Error("codex run cancelled");
    }
    const params: JsonObject = {
      cwd: this.opts.cwd,
      runtimeWorkspaceRoots: [this.opts.cwd],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: this.options.sandbox ?? "workspace-write",
      ephemeral: true,
      sessionStartSource,
    };
    if (this.opts.modelId) params.model = this.opts.modelId;

    const result = await this.client.request("thread/start", params);
    if (this.cancelled) {
      await this.client.dispose();
      throw new Error("codex run cancelled");
    }
    const thread = isObject(result) && isObject(result.thread) ? result.thread : undefined;
    const threadId = typeof thread?.id === "string" ? thread.id : undefined;
    if (!threadId) throw new Error("codex app-server thread/start did not return thread.id");
    this.sessionId = threadId;
    return threadId;
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    if (this.cancelled) return;
    if (sessionId !== this.sessionId) throw new Error(`unknown codex session '${sessionId}'`);

    const maxRetries = normalizeRetryCount(this.options.maxTurnRecoveryRetries, DEFAULT_TURN_RECOVERY_MAX_RETRIES);
    let attempts = 0;
    let firstRecoverableFailure: Error | undefined;

    while (true) {
      if (this.cancelled) return;
      try {
        await this.sendPromptAttempt(this.sessionId, prompt);
        return;
      } catch (err) {
        const failure = err instanceof Error ? err : new Error(String(err));
        const classification = classifyCodexTurnFailure(failure, {
          cancelled: this.cancelled,
          hadActivity: this.currentTurnHadActivity,
          recoveryBackoffMs: this.options.turnRecoveryBackoffMs ?? DEFAULT_TURN_RECOVERY_BACKOFF_MS,
          usageLimitBackoffMs: this.options.usageLimitBackoffMs ?? DEFAULT_USAGE_LIMIT_BACKOFF_MS,
        });

        if (!classification.retryable || attempts >= maxRetries) {
          if (classification.kind === "cancelled") return;
          this.emit({
            type: "event",
            name: "codex_recovery_exhausted",
            payload: {
              kind: classification.kind,
              reason: classification.reason,
              attempts,
              max_retries: maxRetries,
            },
          });
          throw firstRecoverableFailure ?? failure;
        }

        firstRecoverableFailure ??= failure;
        attempts += 1;
        this.emit({
          type: "event",
          name: "codex_recovery_waiting",
          payload: {
            kind: classification.kind,
            reason: classification.reason,
            attempt: attempts,
            max_retries: maxRetries,
            retry_after_ms: classification.retryAfterMs,
          },
        });
        await this.sleepBeforeRecovery(classification.retryAfterMs);
        if (this.cancelled) return;
        await this.client.dispose();
        if (this.cancelled) return;
        try {
          await this.startCodexThread("recovery");
        } catch (err) {
          if (this.cancelled) return;
          throw err;
        }
        if (this.cancelled) {
          await this.client.dispose();
          return;
        }
        this.emit({
          type: "event",
          name: "codex_recovery_restarted",
          payload: { attempt: attempts, max_retries: maxRetries },
        });
      }
    }
  }

  private async sendPromptAttempt(sessionId: string, prompt: string): Promise<void> {
    this.currentTurnHadActivity = false;
    const turnPromise = new Promise<void>((resolve, reject) => {
      this.pendingTurn = {
        resolve,
        reject,
        timer: setTimeout(() => reject(new Error("codex turn timed out")), TURN_TIMEOUT_MS),
      };
    });

    try {
      const result = await this.client.request("turn/start", {
        threadId: sessionId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        cwd: this.opts.cwd,
        runtimeWorkspaceRoots: [this.opts.cwd],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: this.options.sandbox ?? "workspace-write",
        model: this.opts.modelId ?? null,
      });
      const turn = isObject(result) && isObject(result.turn) ? result.turn : undefined;
      const turnId = typeof turn?.id === "string" ? turn.id : undefined;
      if (this.pendingTurn && turnId) this.pendingTurn.turnId = turnId;
      if (turn?.status === "completed") {
        await this.client.drainFrames();
        this.completeTurn();
      } else if (turn?.status === "failed") {
        this.failTurn(new Error("codex turn failed"));
      }
      await turnPromise;
    } catch (err) {
      this.failTurn(err instanceof Error ? err : new Error(String(err)));
      await turnPromise.catch(() => {});
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private async sleepBeforeRecovery(ms: number | null): Promise<void> {
    const delayMs = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : 0;
    if (delayMs <= 0) return;
    if (this.options.recoverySleep) {
      await this.options.recoverySleep(delayMs);
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  async waitForResponseComplete(timeoutMs = TURN_TIMEOUT_MS): Promise<void> {
    const current = this.pendingTurn;
    if (!current) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("codex turn wait timed out")), timeoutMs);
      const originalResolve = current.resolve;
      const originalReject = current.reject;
      current.resolve = () => {
        clearTimeout(timer);
        originalResolve();
        resolve();
      };
      current.reject = (err) => {
        clearTimeout(timer);
        originalReject(err);
        reject(err);
      };
    });
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelled = true;
    const activeSessionId = this.sessionId;
    // Recovery can replace the original returned thread id; this backend is
    // single-session, so cancellation targets the one active Codex thread.
    if (activeSessionId && this.client.isRunning()) {
      await this.client.request("turn/interrupt", { threadId: activeSessionId }).catch(() => {});
    }
    void sessionId;
    this.failTurn(new Error("codex run cancelled"));
    await this.client.dispose();
  }

  async dispose(): Promise<void> {
    this.cancelled = true;
    this.failTurn(new Error("codex backend disposed"));
    this.handlers = [];
    await this.client.dispose();
  }

  private emit(msg: AgentMessage): void {
    for (const handler of this.handlers) handler(msg);
  }

  private async handleFrame(frame: AppFrame): Promise<void> {
    if (typeof frame.method !== "string") return;
    if (frame.id !== undefined) {
      await this.handleServerRequest(frame);
      return;
    }
    this.handleNotification(frame.method, frame.params);
  }

  private handleClientFrameReceived(frame: AppFrame): void {
    if (this.pendingTurn && isMeaningfulTurnActivityFrame(frame)) this.currentTurnHadActivity = true;
  }

  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case "turn/started":
        this.emit({ type: "status", status: "running", detail: extractTurnDetail(params) });
        break;
      case "turn/completed":
        this.handleTurnCompleted(params);
        break;
      case "item/agentMessage/delta":
        this.markTurnActivity();
        this.emit({ type: "model-output", textDelta: stringField(params, "delta") });
        break;
      case "item/started":
        this.markTurnActivity();
        this.handleItemStarted(params);
        break;
      case "item/completed":
        this.markTurnActivity();
        this.handleItemCompleted(params);
        break;
      case "item/fileChange/patchUpdated":
        this.markTurnActivity();
        this.handlePatchUpdated(params);
        break;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "command/exec/outputDelta":
      case "process/outputDelta":
      case "process/exited":
      case "item/commandExecution/terminalInteraction":
        this.markTurnActivity();
        this.emit({ type: "event", name: method, payload: params });
        break;
      case "error":
        this.emit({ type: "status", status: "error", detail: JSON.stringify(params) });
        this.emit({ type: "event", name: method, payload: params });
        break;
      default:
        this.emit({ type: "event", name: method, payload: params });
        break;
    }
  }

  private async handleServerRequest(frame: AppFrame): Promise<void> {
    const method = frame.method as string;
    this.markTurnActivity();
    try {
      switch (method) {
        case "item/commandExecution/requestApproval":
          await this.answerApproval(frame, "shell_command", commandApprovalInput(frame.params), commandApprovalReason(frame.params), {
            allow: { decision: "accept" },
            deny: { decision: "decline" },
          });
          break;
        case "item/fileChange/requestApproval":
          await this.answerApproval(frame, "file_change", frame.params, stringField(frame.params, "reason") ?? "file change requires approval", {
            allow: { decision: "accept" },
            deny: { decision: "decline" },
          });
          break;
        case "item/permissions/requestApproval":
          await this.answerPermissionProfileApproval(frame);
          break;
        case "execCommandApproval":
          await this.answerApproval(frame, "shell_command", legacyExecInput(frame.params), legacyReason(frame.params), {
            allow: { decision: "approved" },
            deny: { decision: "denied" },
          });
          break;
        case "applyPatchApproval":
          await this.answerApproval(frame, "apply_patch", frame.params, legacyReason(frame.params), {
            allow: { decision: "approved" },
            deny: { decision: "denied" },
          });
          break;
        default:
          this.emit({ type: "event", name: method, payload: frame.params });
          this.client.respondError(frame.id as RequestId, `unsupported app-server request '${method}'`);
          break;
      }
    } catch (err) {
      this.client.respondError(frame.id as RequestId, err instanceof Error ? err.message : String(err));
    }
  }

  private async answerApproval(
    frame: AppFrame,
    toolName: string,
    input: unknown,
    reason: string,
    decisions: { allow: JsonObject; deny: JsonObject },
  ): Promise<void> {
    const requestId = String(frame.id);
    this.emit({ type: "permission-request", id: requestId, toolName, input, reason });

    let verdict: PermissionVerdict;
    if (this.opts.permissionHandler) {
      verdict = await this.opts.permissionHandler(toolName, input);
    } else {
      verdict = { decision: "deny", reason: "no permission handler" };
    }

    if (verdict.decision !== "allow") {
      this.client.respond(frame.id as RequestId, decisions.deny);
      this.emit({ type: "status", status: "stopped", detail: `${toolName} denied` });
      this.completeTurn();
      return;
    }

    this.client.respond(frame.id as RequestId, decisions.allow);
  }

  private async answerPermissionProfileApproval(frame: AppFrame): Promise<void> {
    const reason = stringField(frame.params, "reason") ?? "additional permissions require approval";
    const input = permissionsApprovalInput(frame.params);
    this.emit({ type: "permission-request", id: String(frame.id), toolName: "request_permissions", input, reason });

    let verdict: PermissionVerdict;
    if (this.opts.permissionHandler) {
      verdict = await this.opts.permissionHandler("request_permissions", input);
    } else {
      verdict = { decision: "deny", reason: "no permission handler" };
    }

    if (verdict.decision !== "allow") {
      this.client.respondError(frame.id as RequestId, "permission request denied", -32000);
      this.emit({ type: "status", status: "stopped", detail: "request_permissions denied" });
      this.completeTurn();
      return;
    }

    this.client.respond(frame.id as RequestId, {
      permissions: grantedPermissionsFromRequest(frame.params),
      scope: "turn",
    });
  }

  private handleTurnCompleted(params: unknown): void {
    const status = isObject(params) && isObject(params.turn) ? params.turn.status : undefined;
    if (status === "failed") {
      const detail = JSON.stringify(isObject(params) && isObject(params.turn) ? params.turn.error : params);
      this.emit({ type: "status", status: "error", detail });
      this.failTurn(new Error(detail));
    } else if (status === "interrupted") {
      this.emit({ type: "status", status: "stopped", detail: "interrupted" });
      this.failTurn(new Error("codex turn interrupted"));
    } else {
      this.emit({ type: "status", status: "idle" });
      this.completeTurn();
    }
  }

  private handleItemStarted(params: unknown): void {
    const item = itemFromParams(params);
    if (!item) return;
    if (item.type === "commandExecution") {
      this.emit({
        type: "tool-call",
        toolName: "shell_command",
        callId: String(item.id),
        args: pickKnown(item, ["command", "cwd", "source", "commandActions"]),
      });
    } else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
      this.emit({
        type: "tool-call",
        toolName: toolNameForItem(item),
        callId: String(item.id),
        args: pickKnown(item, ["server", "tool", "namespace", "arguments"]),
      });
    } else if (item.type === "fileChange") {
      this.handleFileChangeItem(item);
    } else {
      this.emit({ type: "event", name: "item/started", payload: params });
    }
  }

  private handleItemCompleted(params: unknown): void {
    const item = itemFromParams(params);
    if (!item) return;
    if (item.type === "commandExecution") {
      this.emit({
        type: "tool-result",
        toolName: "shell_command",
        callId: String(item.id),
        result: pickKnown(item, ["status", "aggregatedOutput", "exitCode", "durationMs"]),
      });
    } else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
      this.emit({
        type: "tool-result",
        toolName: toolNameForItem(item),
        callId: String(item.id),
        result: item,
      });
    } else if (item.type === "fileChange") {
      this.handleFileChangeItem(item);
    } else {
      this.emit({ type: "event", name: "item/completed", payload: params });
    }
  }

  private handleFileChangeItem(item: JsonObject): void {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    for (const change of changes) this.emitFileChange(change);
  }

  private handlePatchUpdated(params: unknown): void {
    const changes = isObject(params) && Array.isArray(params.changes) ? params.changes : [];
    for (const change of changes) this.emitFileChange(change);
    this.emit({ type: "event", name: "item/fileChange/patchUpdated", payload: params });
  }

  private emitFileChange(change: unknown): void {
    if (!isObject(change)) return;
    const path = typeof change.path === "string" ? change.path : undefined;
    const diff = typeof change.diff === "string" ? change.diff : undefined;
    const key = `${path ?? ""}\0${diff ?? JSON.stringify(change)}`;
    if (this.emittedFileChanges.has(key)) return;
    this.emittedFileChanges.add(key);
    this.emit({
      type: "fs-edit",
      description: path ? `Codex updated ${path}` : "Codex file change",
      path,
      diff,
    });
  }

  private completeTurn(): void {
    const pending = this.pendingTurn;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingTurn = undefined;
    pending.resolve();
  }

  private failTurn(err: Error): void {
    const pending = this.pendingTurn;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingTurn = undefined;
    pending.reject(err);
  }

  private handleClientFailure(err: Error): void {
    this.failTurn(err);
  }

  private markTurnActivity(): void {
    if (this.pendingTurn) this.currentTurnHadActivity = true;
  }
}

class AppServerClient {
  private readonly cwd: string;
  private readonly env: Readonly<Record<string, string>> | undefined;
  private readonly options: CodexAppServerBackendOptions;
  private readonly timeoutMs: number;
  private readonly onFrameReceived?: (frame: AppFrame) => void;
  private readonly onFrame?: (frame: AppFrame) => void | Promise<void>;
  private readonly onProcessFailure?: (err: Error) => void;
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: ReadlineInterface | undefined;
  private pending = new Map<RequestId, PendingRequest>();
  private seq = 0;
  private stderr = "";
  private frameChain: Promise<void> = Promise.resolve();

  constructor(opts: {
    cwd: string;
    env?: Readonly<Record<string, string>>;
    options?: CodexAppServerBackendOptions;
    timeoutMs: number;
    onFrameReceived?: (frame: AppFrame) => void;
    onFrame?: (frame: AppFrame) => void | Promise<void>;
    onProcessFailure?: (err: Error) => void;
  }) {
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.options = opts.options ?? {};
    this.timeoutMs = opts.timeoutMs;
    this.onFrameReceived = opts.onFrameReceived;
    this.onFrame = opts.onFrame;
    this.onProcessFailure = opts.onProcessFailure;
  }

  async startAndInitialize(): Promise<unknown> {
    this.start();
    const result = await this.request("initialize", {
      clientInfo: { name: "holp", title: "HOLP", version: "0.1.4" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
    return result;
  }

  request(method: string, params: unknown): Promise<unknown> {
    this.start();
    const id = `holp-${++this.seq}`;
    const frame = { id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request '${method}' timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write(frame);
    return promise;
  }

  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RequestId, message: string, code = -32601): void {
    this.write({ id, error: { code, message } });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  isRunning(): boolean {
    return this.child !== undefined && !this.child.killed;
  }

  async drainFrames(graceMs = 25): Promise<void> {
    const deadline = Date.now() + graceMs;
    let observed: Promise<void>;
    do {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      observed = this.frameChain;
      await observed;
    } while (Date.now() < deadline || this.frameChain !== observed);
  }

  async dispose(): Promise<void> {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("codex app-server disposed"));
      this.pending.delete(id);
    }
    this.lines?.close();
    const child = this.child;
    this.child = undefined;
    if (!child || child.killed) return;
    await terminateChild(child);
  }

  private start(): void {
    if (this.child) return;
    const command = this.options.command ?? DEFAULT_CODEX_COMMAND;
    const args = this.options.args ?? DEFAULT_APP_SERVER_ARGS;
    const child = spawn(command, [...args], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
      if (this.stderr.length > 8_000) this.stderr = this.stderr.slice(-8_000);
    });
    child.on("error", (err) => this.handleProcessFailure(child, err));
    child.on("close", (code, signal) => {
      this.handleProcessFailure(
        child,
        new Error(`codex app-server exited code=${code ?? "null"} signal=${signal ?? "null"} ${this.stderr}`.trim()),
      );
    });
  }

  private handleLine(line: string): void {
    let frame: AppFrame;
    try {
      frame = JSON.parse(line) as AppFrame;
    } catch {
      return;
    }
    if (frame.id !== undefined && frame.method === undefined) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error !== undefined) {
        pending.reject(new Error(errorMessage(frame.error)));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    this.onFrameReceived?.(frame);
    this.enqueueFrame(frame);
  }

  private enqueueFrame(frame: AppFrame): void {
    this.frameChain = this.frameChain
      .then(async () => {
        await this.onFrame?.(frame);
      })
      .catch((err) => {
        this.rejectAll(err instanceof Error ? err : new Error(String(err)));
      });
  }

  private write(frame: unknown): void {
    if (!this.child) throw new Error("codex app-server process not started");
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private rejectAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  private handleProcessFailure(child: ChildProcessWithoutNullStreams, err: Error): void {
    if (this.child === child) {
      this.child = undefined;
      this.lines?.close();
      this.lines = undefined;
    }
    this.rejectAll(err);
    this.onProcessFailure?.(err);
  }
}

function classifyCodexTurnFailure(
  err: Error,
  input: {
    cancelled: boolean;
    hadActivity: boolean;
    recoveryBackoffMs: number;
    usageLimitBackoffMs: number;
  },
): CodexTurnFailureClassification {
  const message = err.message;
  const lower = message.toLowerCase();
  if (input.cancelled || lower.includes("cancelled") || lower.includes("disposed")) {
    return { kind: "cancelled", reason: "codex_turn_cancelled", retryAfterMs: null, retryable: false };
  }
  if (isUsageLimitError(lower)) {
    return {
      kind: "usage_limit",
      reason: "codex_usage_limit",
      retryAfterMs: normalizeBackoffMs(input.usageLimitBackoffMs),
      retryable: !input.hadActivity,
    };
  }
  if (input.hadActivity) {
    return {
      kind: "fatal",
      reason: "codex_turn_failed_after_activity",
      retryAfterMs: null,
      retryable: false,
    };
  }
  if (isTransientTurnError(lower)) {
    return {
      kind: "transient",
      reason: "codex_transient_runtime_failure",
      retryAfterMs: normalizeBackoffMs(input.recoveryBackoffMs),
      retryable: true,
    };
  }
  return { kind: "fatal", reason: "codex_turn_failure", retryAfterMs: null, retryable: false };
}

function isUsageLimitError(message: string): boolean {
  return /usage limit|rate limit|too many requests|\b429\b|quota|exhausted/.test(message);
}

function isTransientTurnError(message: string): boolean {
  return /app-server exited|sigkill|sigterm|econnreset|epipe|app-server request '[^']+' timed out|bad gateway|service unavailable|overloaded|temporar/.test(message);
}

function isMeaningfulTurnActivityFrame(frame: AppFrame): boolean {
  if (typeof frame.method !== "string") return false;
  if (frame.id !== undefined) return true;
  return frame.method !== "turn/started" && frame.method !== "turn/completed";
}

function normalizeRetryCount(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function normalizeBackoffMs(value: number): number {
  return Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
}

async function runBounded(command: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result: Omit<CommandResult, "stdout" | "stderr">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!done) child.kill("SIGKILL");
      }, 250).unref();
      finish({ code: null, signal: "SIGTERM", timedOut: true });
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      stderr += err.message;
      finish({ code: 127, signal: null, timedOut: false });
    });
    child.on("exit", (code, signal) => finish({ code, signal, timedOut: false }));
  });
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function cleanVersion(stdout: string, stderr: string): string | undefined {
  const text = `${stdout}\n${stderr}`.trim();
  return text.length > 0 ? text.split(/\r?\n/)[0] : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string | undefined {
  return isObject(value) && typeof value[field] === "string" ? value[field] : undefined;
}

function extractTurnDetail(params: unknown): string | undefined {
  if (!isObject(params) || !isObject(params.turn) || typeof params.turn.id !== "string") return undefined;
  return `turn:${params.turn.id}`;
}

function itemFromParams(params: unknown): JsonObject | undefined {
  return isObject(params) && isObject(params.item) ? params.item : undefined;
}

function pickKnown(source: JsonObject, keys: string[]): JsonObject {
  const out: JsonObject = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function toolNameForItem(item: JsonObject): string {
  if (typeof item.tool === "string") return item.tool;
  if (typeof item.type === "string") return item.type;
  return "tool";
}

function commandApprovalInput(params: unknown): JsonObject {
  return isObject(params) ? pickKnown(params, ["command", "cwd", "reason", "commandActions", "additionalPermissions"]) : {};
}

function legacyExecInput(params: unknown): JsonObject {
  return isObject(params) ? pickKnown(params, ["command", "cwd", "reason", "parsedCmd", "approvalId", "callId"]) : {};
}

function permissionsApprovalInput(params: unknown): JsonObject {
  return isObject(params) ? pickKnown(params, ["threadId", "turnId", "itemId", "environmentId", "cwd", "reason", "permissions"]) : {};
}

function grantedPermissionsFromRequest(params: unknown): JsonObject {
  const request = isObject(params) && isObject(params.permissions) ? params.permissions : {};
  const granted: JsonObject = {};
  if (isObject(request.network)) granted.network = request.network;
  if (isObject(request.fileSystem)) granted.fileSystem = request.fileSystem;
  return granted;
}

function commandApprovalReason(params: unknown): string {
  return stringField(params, "reason") ?? "command execution requires approval";
}

function legacyReason(params: unknown): string {
  return stringField(params, "reason") ?? "Codex requested approval";
}

function errorMessage(error: unknown): string {
  if (isObject(error) && typeof error.message === "string") return error.message;
  return JSON.stringify(error);
}
