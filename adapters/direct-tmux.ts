import { spawn } from "node:child_process";
import type {
  AgentBackend,
  AgentBackendFactory,
  AgentBackendOptions,
  AgentMessageHandler,
} from "./agent-backend.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

export interface DirectTmuxDefinition {
  readonly transport: string;
  readonly tmuxCommand?: string;
  readonly agentCommand: string;
  readonly agentArgsForPrompt: (prompt: string) => readonly string[];
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface DirectTmuxProbeResult {
  readonly ready: boolean;
  readonly reason?: string;
  readonly missing?: readonly string[];
}

export function createDirectTmuxBackendFactory(
  definition: DirectTmuxDefinition,
): AgentBackendFactory {
  return (opts) => new DirectTmuxBackend(definition, opts);
}

export async function probeDirectTmux(args: {
  readonly tmuxCommand?: string;
  readonly agentCommand: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly verifyCapabilities?: boolean;
}): Promise<DirectTmuxProbeResult> {
  const tmux = await runCommand(args.tmuxCommand ?? "tmux", ["-V"], args.cwd, args.timeoutMs ?? 2_000);
  if (tmux.code !== 0 || tmux.timedOut) {
    return { ready: false, reason: "tmux_unavailable", missing: ["binary:tmux"] };
  }
  const agent = await runCommand(args.agentCommand, ["--version"], args.cwd, args.timeoutMs ?? 2_000);
  if (agent.code !== 0 || agent.timedOut) {
    return { ready: false, reason: "kimi_unavailable", missing: ["binary:kimi"] };
  }
  if (args.verifyCapabilities === true) {
    const tmuxCommand = args.tmuxCommand ?? "tmux";
    const sessionId = `holp-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const marker = `__HOLP_OWNER_VERIFIED_${Date.now()}__`;
    try {
      const created = await runCommand(
        tmuxCommand,
        ["new-session", "-d", "-s", sessionId],
        args.cwd,
        args.timeoutMs ?? 2_000,
      );
      if (created.code !== 0 || created.timedOut) {
        return { ready: false, reason: "tmux_create_probe_failed", missing: ["tmux:new-session"] };
      }
      const injected = await runCommand(
        tmuxCommand,
        ["send-keys", "-t", sessionId, `printf '${marker}\\n'`, "C-m"],
        args.cwd,
        args.timeoutMs ?? 2_000,
      );
      if (injected.code !== 0 || injected.timedOut) {
        return { ready: false, reason: "tmux_inject_probe_failed", missing: ["tmux:send-keys"] };
      }
      const captured = await runCommand(
        tmuxCommand,
        ["capture-pane", "-pt", sessionId],
        args.cwd,
        args.timeoutMs ?? 2_000,
      );
      if (captured.code !== 0 || captured.timedOut || !captured.stdout.includes(marker)) {
        return { ready: false, reason: "tmux_read_probe_failed", missing: ["tmux:capture-pane"] };
      }
      await runCommand(tmuxCommand, ["send-keys", "-t", sessionId, "C-c"], args.cwd, args.timeoutMs ?? 2_000);
    } finally {
      await runCommand(
        args.tmuxCommand ?? "tmux",
        ["kill-session", "-t", sessionId],
        args.cwd,
        args.timeoutMs ?? 2_000,
      );
    }
  }
  return { ready: true };
}

class DirectTmuxBackend implements AgentBackend {
  private readonly handlers: AgentMessageHandler[] = [];
  private readonly tmuxCommand: string;
  private sessionId: string | undefined;
  private cancelled = false;

  constructor(
    private readonly definition: DirectTmuxDefinition,
    private readonly opts: AgentBackendOptions,
  ) {
    this.tmuxCommand = definition.tmuxCommand ?? "tmux";
  }

  async startSession(): Promise<{ sessionId: string }> {
    this.sessionId = `holp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const created = await runCommand(
      this.tmuxCommand,
      ["new-session", "-d", "-s", this.sessionId],
      this.opts.cwd,
      5_000,
    );
    if (created.code !== 0 || created.timedOut) {
      throw new Error(created.timedOut ? "direct_tmux_create_timeout" : "direct_tmux_create_failed");
    }
    this.emit({ type: "status", status: "starting", detail: this.sessionId });
    return { sessionId: this.sessionId };
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    if (sessionId !== this.sessionId) throw new Error(`unknown tmux session '${sessionId}'`);
    const marker = `__HOLP_DONE_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
    const command = [
      shellCommand([
        this.definition.agentCommand,
        ...this.definition.agentArgsForPrompt(prompt),
      ]),
      `printf '\\n${marker}\\n'`,
    ].join("; ");
    this.emit({ type: "status", status: "running", detail: sessionId });
    const injected = await runCommand(
      this.tmuxCommand,
      ["send-keys", "-t", sessionId, command, "C-m"],
      this.opts.cwd,
      5_000,
    );
    if (injected.code !== 0 || injected.timedOut) {
      throw new Error(injected.timedOut ? "direct_tmux_inject_timeout" : "direct_tmux_inject_failed");
    }
    const output = await waitForMarker({
      tmuxCommand: this.tmuxCommand,
      sessionId,
      marker,
      cwd: this.opts.cwd,
      timeoutMs: this.definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      pollIntervalMs: this.definition.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      shouldStop: () => this.cancelled,
    });
    if (this.cancelled) return;
    this.emit({ type: "model-output", fullText: output });
    this.emit({ type: "status", status: "idle" });
  }

  async cancel(sessionId: string): Promise<void> {
    if (sessionId !== this.sessionId) return;
    this.cancelled = true;
    await runCommand(this.tmuxCommand, ["send-keys", "-t", sessionId, "C-c"], this.opts.cwd, 2_000);
    await runCommand(this.tmuxCommand, ["kill-session", "-t", sessionId], this.opts.cwd, 2_000);
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    const index = this.handlers.indexOf(handler);
    if (index >= 0) this.handlers.splice(index, 1);
  }

  async dispose(): Promise<void> {
    if (this.sessionId) {
      await runCommand(this.tmuxCommand, ["kill-session", "-t", this.sessionId], this.opts.cwd, 2_000);
    }
  }

  private emit(message: Parameters<AgentMessageHandler>[0]): void {
    for (const handler of this.handlers) handler(message);
  }
}

async function waitForMarker(args: {
  readonly tmuxCommand: string;
  readonly sessionId: string;
  readonly marker: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly shouldStop: () => boolean;
}): Promise<string> {
  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline) {
    if (args.shouldStop()) return "";
    const capture = await runCommand(
      args.tmuxCommand,
      ["capture-pane", "-pt", args.sessionId],
      args.cwd,
      5_000,
    );
    if (capture.code !== 0 || capture.timedOut) {
      throw new Error(capture.timedOut ? "direct_tmux_capture_timeout" : "direct_tmux_capture_failed");
    }
    const markerIndex = capture.stdout.indexOf(args.marker);
    if (markerIndex >= 0) return capture.stdout.slice(0, markerIndex).trim();
    await new Promise((resolve) => setTimeout(resolve, args.pollIntervalMs));
  }
  throw new Error("direct_tmux_terminal_timeout");
}

function shellCommand(parts: readonly string[]): string {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr || error.message, timedOut });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
