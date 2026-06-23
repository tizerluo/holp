import { spawn, type ChildProcess } from "node:child_process";
import type {
  AgentBackend,
  AgentBackendFactory,
  AgentBackendOptions,
  AgentMessageHandler,
} from "./agent-backend.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const KNOWN_FAILURE_PATTERNS = [
  /auth(?:entication|orization)?\s+(?:failed|required|not configured|missing)/i,
  /not\s+(?:logged|signed)\s+in/i,
  /login\s+required/i,
  /permission\s+(?:denied|required)/i,
  /unauthorized|forbidden/i,
  /quota|rate\s*limit/i,
  /api\s*key\s+(?:missing|required|invalid)/i,
  /^(?:fatal|error):\s+/im,
];

export interface CliCommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
}

export interface CliClassification {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface CliHarnessDefinition {
  readonly transport: string;
  readonly command: string;
  readonly argsForPrompt: (prompt: string) => readonly string[];
  readonly versionArgs?: readonly string[];
  readonly timeoutMs?: number;
  readonly classify?: (result: CliCommandResult) => CliClassification;
}

export async function runCliCommand(args: {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly onProcess?: (child: ChildProcess) => void;
  readonly maxOutputBytes?: number;
}): Promise<CliCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(args.command, [...(args.args ?? [])], {
      cwd: args.cwd,
      env: args.env ? { ...process.env, ...args.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    args.onProcess?.(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const maxOutputBytes = args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const next = appendLimited(stdout, chunk, maxOutputBytes);
      stdout = next.text;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const next = appendLimited(stderr, chunk, maxOutputBytes);
      stderr = next.text;
      stderrTruncated ||= next.truncated;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: 127,
        signal: null,
        stdout,
        stderr: stderr || error.message,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, stdoutTruncated, stderrTruncated });
    });
  });
}

function appendLimited(
  current: string,
  chunk: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: true };
  const remaining = maxBytes - Buffer.byteLength(current);
  if (remaining <= 0) return { text: current, truncated: true };
  if (Buffer.byteLength(chunk) <= remaining) return { text: current + chunk, truncated: false };
  return {
    text: current + Buffer.from(chunk).subarray(0, remaining).toString("utf8"),
    truncated: true,
  };
}

export function classifyCliResult(
  result: CliCommandResult,
  classify?: (result: CliCommandResult) => CliClassification,
): CliClassification {
  if (result.timedOut) return { ok: false, reason: "cli_timeout" };
  if (result.code !== 0) return { ok: false, reason: `cli_exit_${result.code ?? "signal"}` };
  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (!result.stdout.trim()) return { ok: false, reason: "cli_empty_output" };
  for (const pattern of KNOWN_FAILURE_PATTERNS) {
    if (pattern.test(text)) return { ok: false, reason: "cli_known_failure_prompt" };
  }
  return classify?.(result) ?? { ok: true };
}

export function createCliHarnessBackendFactory(
  definition: CliHarnessDefinition,
): AgentBackendFactory {
  return (opts) => new CliHarnessBackend(definition, opts);
}

export async function probeCliBinary(args: {
  readonly command: string;
  readonly versionArgs?: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
}): Promise<CliClassification & { readonly output?: string }> {
  const result = await runCliCommand({
    command: args.command,
    args: args.versionArgs ?? ["--version"],
    cwd: args.cwd,
    timeoutMs: args.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  });
  if (result.timedOut) return { ok: false, reason: "version_probe_timeout" };
  if (result.code !== 0) return { ok: false, reason: "missing_binary" };
  return { ok: true, output: `${result.stdout}\n${result.stderr}`.trim() };
}

class CliHarnessBackend implements AgentBackend {
  private readonly handlers: AgentMessageHandler[] = [];
  private currentProcess: ChildProcess | undefined;
  private sessionId: string | undefined;
  private cancelled = false;

  constructor(
    private readonly definition: CliHarnessDefinition,
    private readonly opts: AgentBackendOptions,
  ) {}

  async startSession(): Promise<{ sessionId: string }> {
    this.sessionId = `${this.definition.transport}-cli-${Date.now()}`;
    this.emit({ type: "status", status: "starting" });
    return { sessionId: this.sessionId };
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    if (sessionId !== this.sessionId) throw new Error(`unknown cli session '${sessionId}'`);
    if (this.cancelled) return;
    this.emit({ type: "status", status: "running" });
    const result = await runCliCommand({
      command: this.definition.command,
      args: this.definition.argsForPrompt(prompt),
      cwd: this.opts.cwd,
      env: this.opts.env,
      timeoutMs: this.definition.timeoutMs,
      onProcess: (child) => {
        this.currentProcess = child;
      },
    }).finally(() => {
      this.currentProcess = undefined;
    });
    if (this.cancelled) return;
    const classified = classifyCliResult(result, this.definition.classify);
    if (!classified.ok) {
      throw new Error(classified.reason ?? "cli_harness_failed");
    }
    this.emit({ type: "model-output", fullText: result.stdout.trim() });
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
    const index = this.handlers.indexOf(handler);
    if (index >= 0) this.handlers.splice(index, 1);
  }

  async dispose(): Promise<void> {
    this.cancelled = true;
    this.currentProcess?.kill("SIGTERM");
  }

  private emit(message: Parameters<AgentMessageHandler>[0]): void {
    for (const handler of this.handlers) handler(message);
  }
}
