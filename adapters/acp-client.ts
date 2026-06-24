import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type {
  AgentBackend,
  AgentBackendFactory,
  AgentBackendOptions,
  AgentMessageHandler,
} from "./agent-backend.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TERMINAL_TIMEOUT_MS = 120_000;

type RequestId = string | number;
type JsonObject = Record<string, unknown>;
export type AcpSessionNewShape = "cwd_mcp_servers_empty" | "cwd_only";

export interface AcpClientOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly sessionNewShape?: AcpSessionNewShape;
  readonly requestTimeoutMs?: number;
  readonly terminalTimeoutMs?: number;
  readonly onUpdate?: (update: AcpSessionUpdate) => void;
}

export interface AcpBackendDefinition {
  readonly transport: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly sessionNewShape?: AcpSessionNewShape;
  readonly requestTimeoutMs?: number;
  readonly terminalTimeoutMs?: number;
}

export interface AcpSessionUpdate {
  readonly sessionId?: string;
  readonly textDelta?: string;
  readonly finalText?: string;
  readonly terminal: boolean;
  readonly raw: unknown;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class AcpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: ReadlineInterface | undefined;
  private nextId = 0;
  private pending = new Map<RequestId, PendingRequest>();
  private disposed = false;
  private streamReject: ((error: Error) => void) | undefined;
  private activeUpdateHandler: ((update: AcpSessionUpdate) => void) | undefined;
  private promptInFlight = false;

  constructor(private readonly options: AcpClientOptions) {}

  async startSession(): Promise<{ sessionId: string }> {
    this.start();
    await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "holp", title: "HOLP", version: "0.1.6" },
      capabilities: {},
    });
    const session = await this.request("session/new", sessionNewParams(this.options));
    const sessionId = extractSessionId(session);
    if (!sessionId) throw new Error("acp_session_new_missing_session_id");
    return { sessionId };
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<string> {
    this.start();
    if (this.promptInFlight) throw new Error("acp_prompt_in_flight");
    this.promptInFlight = true;
    let output = "";
    let terminal = false;
    let terminalTimer: NodeJS.Timeout | undefined;
    let resolveTerminal: ((value: string) => void) | undefined;
    let rejectTerminal: ((error: Error) => void) | undefined;
    const finishTerminal = (): void => {
      terminal = true;
      if (terminalTimer) clearTimeout(terminalTimer);
      this.streamReject = undefined;
      resolveTerminal?.(output);
    };
    const terminalPromise = new Promise<string>((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
      terminalTimer = setTimeout(() => {
        reject(new Error("acp_terminal_timeout"));
      }, this.options.terminalTimeoutMs ?? DEFAULT_TERMINAL_TIMEOUT_MS);
      terminalTimer.unref?.();
      this.streamReject = reject;
      const previousUpdate = this.options.onUpdate;
      const onUpdate = (update: AcpSessionUpdate): void => {
        previousUpdate?.(update);
        if (update.sessionId && update.sessionId !== sessionId) return;
        if (update.textDelta) output += update.textDelta;
        if (update.finalText !== undefined) output = update.finalText;
        if (update.terminal) {
          finishTerminal();
        }
      };
      this.activeUpdateHandler = onUpdate;
    });

    try {
      const result = await this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      if (isTerminalPromptResult(result)) {
        if (!output.trim()) throw new Error("acp_missing_final_result");
        finishTerminal();
      }
      return await terminalPromise;
    } catch (error) {
      rejectTerminal?.(error instanceof Error ? error : new Error(String(error)));
      await terminalPromise.catch(() => undefined);
      throw error;
    } finally {
      if (terminalTimer) clearTimeout(terminalTimer);
      this.activeUpdateHandler = undefined;
      this.promptInFlight = false;
      if (!terminal) {
        this.streamReject = undefined;
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.child) return;
    await this.request("session/cancel", { sessionId }).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.activeUpdateHandler = undefined;
    this.streamReject?.(new Error("acp_client_disposed"));
    this.streamReject = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("acp_client_disposed"));
    }
    this.pending.clear();
    this.lines?.close();
    this.lines = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin.end();
    child.stdout.destroy();
    child.stderr.destroy();
    const closed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("close", () => resolve());
    });
    child.kill("SIGTERM");
    const closedPolitely = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500).unref?.()),
    ]);
    if (!closedPolitely && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        closed,
        new Promise<void>((resolve) => setTimeout(resolve, 500).unref?.()),
      ]);
    }
  }

  private start(): void {
    if (this.child) return;
    this.child = spawn(this.options.command, [...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      if (this.disposed) return;
      this.failAll(new Error(`acp_process_exit:${code ?? signal ?? "unknown"}`));
    });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    this.start();
    const child = this.child;
    if (!child) return Promise.reject(new Error("acp_process_not_started"));
    const id = `holp-${++this.nextId}`;
    const frame = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`acp_request_timeout:${method}`));
      }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    const rejectPendingWrite = (error: Error): void => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    };
    try {
      if (child.stdin.destroyed || child.stdin.writableEnded) {
        rejectPendingWrite(new Error(`acp_write_failed:${method}`));
      } else {
        child.stdin.write(`${JSON.stringify(frame)}\n`, (error?: Error | null) => {
          if (error) rejectPendingWrite(new Error(`acp_write_failed:${method}`));
        });
      }
    } catch {
      rejectPendingWrite(new Error(`acp_write_failed:${method}`));
    }
    return promise;
  }

  private handleLine(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.failAll(new Error("acp_malformed_json"));
      return;
    }
    if (!isObject(frame)) return;
    if ("id" in frame && (frame.result !== undefined || frame.error !== undefined)) {
      const pending = this.pending.get(frame.id as RequestId);
      if (!pending) return;
      this.pending.delete(frame.id as RequestId);
      clearTimeout(pending.timer);
      if (frame.error !== undefined) {
        pending.reject(new Error(`acp_rpc_error:${JSON.stringify(frame.error)}`));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (frame.method === "session/update") {
      const update = parseSessionUpdate(frame.params);
      this.activeUpdateHandler?.(update);
    }
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.streamReject?.(error);
    this.streamReject = undefined;
  }
}

export function createAcpBackendFactory(definition: AcpBackendDefinition): AgentBackendFactory {
  return (opts) => new AcpBackend(definition, opts);
}

class AcpBackend implements AgentBackend {
  private readonly handlers: AgentMessageHandler[] = [];
  private readonly client: AcpClient;
  private sessionId: string | undefined;

  constructor(definition: AcpBackendDefinition, opts: AgentBackendOptions) {
    this.client = new AcpClient({
      command: definition.command,
      args: definition.args,
      cwd: opts.cwd,
      env: opts.env,
      sessionNewShape: definition.sessionNewShape,
      requestTimeoutMs: definition.requestTimeoutMs,
      terminalTimeoutMs: definition.terminalTimeoutMs,
      onUpdate: (update) => {
        if (update.textDelta) this.emit({ type: "model-output", textDelta: update.textDelta });
      },
    });
  }

  async startSession(): Promise<{ sessionId: string }> {
    this.emit({ type: "status", status: "starting" });
    const session = await this.client.startSession();
    this.sessionId = session.sessionId;
    return session;
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    if (sessionId !== this.sessionId) throw new Error(`unknown acp session '${sessionId}'`);
    this.emit({ type: "status", status: "running" });
    const fullText = await this.client.sendPrompt(sessionId, prompt);
    if (fullText.trim()) this.emit({ type: "model-output", fullText: fullText.trim() });
    this.emit({ type: "status", status: "idle" });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.client.cancel(sessionId);
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    const index = this.handlers.indexOf(handler);
    if (index >= 0) this.handlers.splice(index, 1);
  }

  async dispose(): Promise<void> {
    await this.client.dispose();
  }

  private emit(message: Parameters<AgentMessageHandler>[0]): void {
    for (const handler of this.handlers) handler(message);
  }
}

function parseSessionUpdate(params: unknown): AcpSessionUpdate {
  const obj = isObject(params) ? params : {};
  const nestedUpdate = isObject(obj.update) ? obj.update : undefined;
  const sessionUpdate = isObject(nestedUpdate?.sessionUpdate) ? nestedUpdate.sessionUpdate : undefined;
  const source = sessionUpdate ?? nestedUpdate ?? obj;
  const nestedKind = firstString(nestedUpdate?.sessionUpdate);
  const kind = firstString(source.kind, source.type, source.status, nestedKind);
  const isThought = kind === "agent_thought_chunk";
  const isMessage = kind === "agent_message_chunk";
  const nestedText = textFromContent(source.content) ??
    firstString(source.textDelta, source.text_delta, source.delta, source.text, source.chunk);
  const topLevelText = firstString(obj.textDelta, obj.text_delta, obj.delta, obj.text);
  const textDelta = isThought ? undefined : isMessage ? nestedText : topLevelText;
  const finalText = firstString(obj.finalText, obj.final_text, obj.result, obj.output);
  return {
    sessionId: firstString(obj.sessionId, obj.session_id),
    textDelta,
    finalText,
    terminal: obj.terminal === true ||
      obj.done === true ||
      kind === "completed" ||
      kind === "complete" ||
      kind === "final" ||
      kind === "terminal",
    raw: params,
  };
}

function isTerminalPromptResult(value: unknown): boolean {
  if (!isObject(value)) return false;
  const stopReason = firstString(value.stopReason, value.stop_reason, value.reason);
  return stopReason === "end_turn" ||
    stopReason === "end-turn" ||
    stopReason === "stop" ||
    stopReason === "complete" ||
    stopReason === "completed" ||
    stopReason === "done";
}

function sessionNewParams(options: Pick<AcpClientOptions, "cwd" | "sessionNewShape">): JsonObject {
  if (options.sessionNewShape === "cwd_only") return { cwd: options.cwd };
  return { cwd: options.cwd, mcpServers: [] };
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value.map((item) => textFromContent(item) ?? "").join("");
    return text || undefined;
  }
  if (!isObject(value)) return undefined;
  return firstString(value.text, value.chunk, value.delta);
}

function extractSessionId(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  return firstString(
    value.sessionId,
    value.session_id,
    value.id,
    isObject(value.session) ? value.session.id : undefined,
  );
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
