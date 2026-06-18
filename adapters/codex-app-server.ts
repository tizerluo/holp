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
  type IsolationProfileReadiness,
  type RuntimeSurfaceDeclaration,
} from "./harness-declaration.js";

const DEFAULT_PROBE_TIMEOUT_MS = 4_000;
const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 10 * 60_000;
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

export interface CodexAppServerBackendOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly probeTimeoutMs?: number;
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
  const version = await runBounded(command, ["--version"], {
    cwd: input.cwd,
    timeoutMs: Math.min(Math.max(1_000, timeoutMs), 5_000),
  });
  if (version.code !== 0) {
    return {
      status: "rejected",
      harness_id: "codex",
      vendor: "OpenAI",
      transport_class: input.transport,
      runtime_surfaces: codexRuntimeSurfaces("rejected", "missing_binary_codex"),
      state_declaration_ref: "harness-state:codex",
      global_mutation_required: false,
      resolved_roles: [],
      logged_in: false,
      missing: ["binary:codex", ...input.roles.map((role) => `role:${role}`)],
      reason: version.timedOut ? "codex_version_probe_timeout" : "missing_binary_codex",
    };
  }

  const doctor = await runBounded(command, ["doctor"], {
    cwd: input.cwd,
    timeoutMs: Math.max(1_000, timeoutMs - 1_000),
  });
  const doctorText = `${doctor.stdout}\n${doctor.stderr}`;
  const loggedIn = /auth\s+is configured/i.test(doctorText);
  const mentionsAuth = /auth/i.test(doctorText);
  if (!loggedIn) {
    return {
      status: mentionsAuth ? "rejected" : "degraded",
      harness_id: "codex",
      vendor: "OpenAI",
      transport_class: input.transport,
      runtime_surfaces: codexRuntimeSurfaces(
        mentionsAuth ? "rejected" : "degraded",
        mentionsAuth ? "codex_auth_not_configured" : "codex_auth_status_unknown",
      ),
      state_declaration_ref: "harness-state:codex",
      global_mutation_required: false,
      version: cleanVersion(version.stdout, version.stderr),
      logged_in: false,
      resolved_roles: [],
      missing: ["auth:codex", ...input.roles.map((role) => `role:${role}`)],
      reason: mentionsAuth ? "codex_auth_not_configured" : "codex_auth_status_unknown",
    };
  }

  const init = await probeInitialize(input.cwd, 1_500, options);
  if (!init.ok) {
    return {
      status: "degraded",
      harness_id: "codex",
      vendor: "OpenAI",
      transport_class: input.transport,
      runtime_surfaces: codexRuntimeSurfaces("degraded", init.reason),
      state_declaration_ref: "harness-state:codex",
      global_mutation_required: false,
      version: cleanVersion(version.stdout, version.stderr),
      logged_in: loggedIn || undefined,
      resolved_roles: [],
      missing: input.roles.map((role) => `role:${role}`),
      reason: init.reason,
    };
  }

  return {
    status: "ready",
    harness_id: "codex",
    vendor: "OpenAI",
    transport_class: input.transport,
    runtime_surfaces: codexRuntimeSurfaces("ready"),
    state_declaration_ref: "harness-state:codex",
    global_mutation_required: false,
    version: init.userAgent ?? cleanVersion(version.stdout, version.stderr),
    logged_in: loggedIn || undefined,
    resolved_roles: input.roles.length > 0 ? input.roles : ["coder", "reviewer", "tester"],
  };
}

function codexRuntimeSurfaces(
  status: "ready" | "degraded" | "rejected",
  reason?: string,
): readonly RuntimeSurfaceDeclaration[] {
  const baseReadiness: IsolationProfileReadiness =
    status === "ready"
      ? { readiness: "ready", warnings: ["declared_not_enforced"] }
      : status === "degraded"
        ? {
            readiness: "degraded",
            reason,
            missing: reason ? [reason] : undefined,
            warnings: ["declared_not_enforced"],
          }
        : {
            readiness: "rejected",
            reason: reason ?? "codex_unavailable",
            missing: reason ? [reason] : undefined,
          };

  let appServerProfiles = rejectedProfiles("unsupported_isolation_profile");
  appServerProfiles = withProfile(appServerProfiles, "coder_worktree", baseReadiness);
  appServerProfiles = withProfile(appServerProfiles, "read_only_review", {
    readiness: status === "rejected" ? "rejected" : "degraded",
    reason: status === "rejected" ? reason : "read_only_not_enforced",
    missing: status === "rejected" && reason ? [reason] : ["read_only_enforcement"],
    warnings: status === "rejected" ? undefined : ["declared_not_enforced"],
  });
  appServerProfiles = withProfile(appServerProfiles, "real_provider_smoke", {
    readiness: status === "rejected" ? "rejected" : "ready",
    reason: status === "rejected" ? reason : undefined,
    missing: status === "rejected" && reason ? [reason] : undefined,
    warnings: status === "rejected"
      ? undefined
      : ["inherits:network", "inherits:provider_quota", "declared_not_enforced"],
  });
  appServerProfiles = withProfile(appServerProfiles, "high_isolation", {
    readiness: status === "rejected" ? "rejected" : "degraded",
    reason: status === "rejected" ? reason : "high_isolation_not_proven",
    missing: status === "rejected" && reason
      ? [reason]
      : ["full_env_filter", "keychain_isolation"],
    warnings: status === "rejected" ? undefined : ["declared_not_enforced"],
  });

  return [
    {
      runtime_surface: "headless",
      runtime_kind: "app_server",
      surface_support: status === "rejected" ? "unsupported" : "supported",
      isolation_profiles: appServerProfiles,
      state_declaration_ref: "harness-state:codex",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
    {
      runtime_surface: "direct_user_session",
      runtime_kind: "unknown",
      surface_support: "unknown",
      isolation_profiles: rejectedProfiles("direct_user_session_not_declared"),
      direct_channel: {
        channel_type: "terminal_app",
        attach: "unknown",
        inject: "unknown",
        interrupt: "unknown",
        cancel: "unknown",
        owner_scope: "unknown",
      },
      state_declaration_ref: "harness-state:codex",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
  ];
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
  private readonly client: AppServerClient;
  private handlers: AgentMessageHandler[] = [];
  private sessionId: string | undefined;
  private pendingTurn: PendingTurn | undefined;
  private readonly emittedFileChanges = new Set<string>();
  private cancelled = false;

  constructor(opts: AgentBackendOptions, options: CodexAppServerBackendOptions = {}) {
    this.opts = opts;
    this.client = new AppServerClient({
      cwd: opts.cwd,
      env: opts.env,
      options,
      timeoutMs: REQUEST_TIMEOUT_MS,
      onFrame: (frame) => this.handleFrame(frame),
    });
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  async startSession(initialPrompt?: string): Promise<{ sessionId: string }> {
    await this.client.startAndInitialize();
    const params: JsonObject = {
      cwd: this.opts.cwd,
      runtimeWorkspaceRoots: [this.opts.cwd],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      ephemeral: true,
      sessionStartSource: "startup",
    };
    if (this.opts.modelId) params.model = this.opts.modelId;

    const result = await this.client.request("thread/start", params);
    const thread = isObject(result) && isObject(result.thread) ? result.thread : undefined;
    const threadId = typeof thread?.id === "string" ? thread.id : undefined;
    if (!threadId) throw new Error("codex app-server thread/start did not return thread.id");
    this.sessionId = threadId;

    if (initialPrompt) await this.sendPrompt(threadId, initialPrompt);
    return { sessionId: threadId };
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    if (this.cancelled) return;
    if (sessionId !== this.sessionId) throw new Error(`unknown codex session '${sessionId}'`);

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
      throw err;
    }
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
    if (sessionId === this.sessionId) {
      await this.client.request("turn/interrupt", { threadId: sessionId }).catch(() => {});
    }
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

  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case "turn/started":
        this.emit({ type: "status", status: "running", detail: extractTurnDetail(params) });
        break;
      case "turn/completed":
        this.handleTurnCompleted(params);
        break;
      case "item/agentMessage/delta":
        this.emit({ type: "model-output", textDelta: stringField(params, "delta") });
        break;
      case "item/started":
        this.handleItemStarted(params);
        break;
      case "item/completed":
        this.handleItemCompleted(params);
        break;
      case "item/fileChange/patchUpdated":
        this.handlePatchUpdated(params);
        break;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "command/exec/outputDelta":
      case "process/outputDelta":
      case "process/exited":
      case "item/commandExecution/terminalInteraction":
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
}

class AppServerClient {
  private readonly cwd: string;
  private readonly env: Readonly<Record<string, string>> | undefined;
  private readonly options: CodexAppServerBackendOptions;
  private readonly timeoutMs: number;
  private readonly onFrame?: (frame: AppFrame) => void | Promise<void>;
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
    onFrame?: (frame: AppFrame) => void | Promise<void>;
  }) {
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.options = opts.options ?? {};
    this.timeoutMs = opts.timeoutMs;
    this.onFrame = opts.onFrame;
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
    child.on("error", (err) => this.rejectAll(err));
    child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`codex app-server exited code=${code ?? "null"} signal=${signal ?? "null"} ${this.stderr}`.trim()));
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
