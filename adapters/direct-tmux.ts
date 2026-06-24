import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  AgentBackend,
  AgentBackendFactory,
  AgentBackendOptions,
  AgentMessageHandler,
} from "./agent-backend.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_HOLD_TIMEOUT_MS = 1_800_000;

export interface TmuxAttachTarget {
  readonly sessionId: string;
  readonly socketPath?: string;
}

export function resolveTmuxSocketPath(
  opts: { readonly tmuxSocketPath?: string },
  fallbackKey: string,
): string {
  if (opts.tmuxSocketPath) return opts.tmuxSocketPath;
  const base = process.env.XDG_RUNTIME_DIR ?? "/tmp";
  return path.join(base, "holp", fallbackKey, "tmux.sock");
}

export function tmuxAttachCommand(target: TmuxAttachTarget): string {
  const sockArg = target.socketPath ? `-S ${target.socketPath} ` : "";
  return `tmux ${sockArg}attach -t ${target.sessionId}`;
}

export function tmuxKillCommand(target: TmuxAttachTarget): string {
  const sockArg = target.socketPath ? `-S ${target.socketPath} ` : "";
  return `tmux ${sockArg}kill-session -t ${target.sessionId}`;
}

function socketArgs(socketPath: string | undefined): readonly string[] {
  return socketPath ? ["-S", socketPath] : [];
}

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
  readonly socketPath?: string;
  readonly agentCommand: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly verifyCapabilities?: boolean;
}): Promise<DirectTmuxProbeResult> {
  const tmuxCommand = args.tmuxCommand ?? "tmux";
  const sock = socketArgs(args.socketPath);
  const tmux = await runCommand(tmuxCommand, ["-V"], args.cwd, args.timeoutMs ?? 2_000);
  if (tmux.code !== 0 || tmux.timedOut) {
    return { ready: false, reason: "tmux_unavailable", missing: ["binary:tmux"] };
  }
  const agent = await runCommand(args.agentCommand, ["--version"], args.cwd, args.timeoutMs ?? 2_000);
  if (agent.code !== 0 || agent.timedOut) {
    return {
      ready: false,
      reason: "direct_agent_unavailable",
      missing: [`binary:${args.agentCommand}`],
    };
  }
  if (args.verifyCapabilities === true) {
    const sessionId = `holp-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const marker = `__HOLP_OWNER_VERIFIED_${Date.now()}__`;
    try {
      const created = await runCommand(
        tmuxCommand,
        [...sock, "new-session", "-d", "-s", sessionId],
        args.cwd,
        args.timeoutMs ?? 2_000,
      );
      if (created.code !== 0 || created.timedOut) {
        return { ready: false, reason: "tmux_create_probe_failed", missing: ["tmux:new-session"] };
      }
      const injected = await runCommand(
        tmuxCommand,
        [...sock, "send-keys", "-t", sessionId, `printf '${marker}\\n'`, "C-m"],
        args.cwd,
        args.timeoutMs ?? 2_000,
      );
      if (injected.code !== 0 || injected.timedOut) {
        return { ready: false, reason: "tmux_inject_probe_failed", missing: ["tmux:send-keys"] };
      }
      try {
        await waitForMarker({
          tmuxCommand,
          socketPath: args.socketPath,
          sessionId,
          marker,
          cwd: args.cwd,
          timeoutMs: args.timeoutMs ?? 2_000,
          pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
          shouldStop: () => false,
        });
      } catch {
        return { ready: false, reason: "tmux_read_probe_failed", missing: ["tmux:capture-pane"] };
      }
      await runCommand(tmuxCommand, [...sock, "send-keys", "-t", sessionId, "C-c"], args.cwd, args.timeoutMs ?? 2_000)
        .catch(() => undefined);
    } finally {
      await runCommand(
        tmuxCommand,
        [...sock, "kill-session", "-t", sessionId],
        args.cwd,
        args.timeoutMs ?? 2_000,
      ).catch(() => undefined);
    }
  }
  return { ready: true };
}

class DirectTmuxBackend implements AgentBackend {
  private readonly handlers: AgentMessageHandler[] = [];
  private readonly tmuxCommand: string;
  private readonly socketPath: string;
  private readonly holdSession: boolean;
  private readonly holdTimeoutMs: number;
  private sessionId: string | undefined;
  private cancelled = false;
  private reaper: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly definition: DirectTmuxDefinition,
    private readonly opts: AgentBackendOptions,
  ) {
    this.tmuxCommand = definition.tmuxCommand ?? "tmux";
    this.socketPath = resolveTmuxSocketPath(opts, `${definition.transport}-${process.pid}`);
    this.holdSession = opts.holdSession === true;
    this.holdTimeoutMs = opts.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS;
  }

  private tmux(args: readonly string[], timeoutMs: number) {
    return runCommand(this.tmuxCommand, [...socketArgs(this.socketPath), ...args], this.opts.cwd, timeoutMs);
  }

  async startSession(): Promise<{ sessionId: string }> {
    const sessionId = `holp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (!sessionId.startsWith("holp-")) throw new Error("direct_tmux_session_namespace_invalid");
    mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    const created = await this.tmux(["new-session", "-d", "-s", sessionId], 5_000);
    if (created.code !== 0 || created.timedOut) {
      throw new Error(created.timedOut ? "direct_tmux_create_timeout" : "direct_tmux_create_failed");
    }
    this.sessionId = sessionId;
    this.emit({ type: "status", status: "starting", detail: sessionId });
    this.emit({
      type: "event",
      name: "attach_target",
      payload: {
        session_id: sessionId,
        socket_path: this.socketPath,
        attach_command: tmuxAttachCommand({ sessionId, socketPath: this.socketPath }),
        kill_command: tmuxKillCommand({ sessionId, socketPath: this.socketPath }),
      },
    });
    return { sessionId };
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
    const injected = await this.tmux(["send-keys", "-t", sessionId, command, "C-m"], 5_000);
    if (injected.code !== 0 || injected.timedOut) {
      throw new Error(injected.timedOut ? "direct_tmux_inject_timeout" : "direct_tmux_inject_failed");
    }
    const output = await waitForMarker({
      tmuxCommand: this.tmuxCommand,
      socketPath: this.socketPath,
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
    this.clearReaper();
    await this.tmux(["send-keys", "-t", sessionId, "C-c"], 2_000).catch(() => undefined);
    await this.tmux(["kill-session", "-t", sessionId], 2_000).catch(() => undefined);
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    const index = this.handlers.indexOf(handler);
    if (index >= 0) this.handlers.splice(index, 1);
  }

  async dispose(): Promise<void> {
    if (!this.sessionId) return;
    if (this.holdSession && !this.cancelled) {
      const sessionId = this.sessionId;
      this.emit({ type: "status", status: "idle", detail: sessionId });
      this.emit({
        type: "event",
        name: "session_held",
        payload: {
          session_id: sessionId,
          socket_path: this.socketPath,
          attach_command: tmuxAttachCommand({ sessionId, socketPath: this.socketPath }),
          kill_command: tmuxKillCommand({ sessionId, socketPath: this.socketPath }),
          hold_timeout_ms: this.holdTimeoutMs,
        },
      });
      this.reaper = setTimeout(() => {
        void this.tmux(["kill-session", "-t", sessionId], 2_000).catch(() => undefined);
      }, this.holdTimeoutMs);
      this.reaper.unref?.();
      return;
    }
    await this.tmux(["kill-session", "-t", this.sessionId], 2_000).catch(() => undefined);
  }

  private clearReaper(): void {
    if (this.reaper) {
      clearTimeout(this.reaper);
      this.reaper = undefined;
    }
  }

  private emit(message: Parameters<AgentMessageHandler>[0]): void {
    for (const handler of this.handlers) handler(message);
  }
}

async function waitForMarker(args: {
  readonly tmuxCommand: string;
  readonly socketPath?: string;
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
      [...socketArgs(args.socketPath), "capture-pane", "-pt", args.sessionId],
      args.cwd,
      5_000,
    );
    if (capture.code !== 0 || capture.timedOut) {
      throw new Error(capture.timedOut ? "direct_tmux_capture_timeout" : "direct_tmux_capture_failed");
    }
    const terminal = outputBeforeStandaloneMarker(capture.stdout, args.marker);
    if (terminal !== undefined) return stripEchoedMarkerCommand(terminal, args.marker);
    await new Promise((resolve) => setTimeout(resolve, args.pollIntervalMs));
  }
  throw new Error("direct_tmux_terminal_timeout");
}

function outputBeforeStandaloneMarker(output: string, marker: string): string | undefined {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === marker) return lines.slice(0, index).join("\n");
  }
  return undefined;
}

function stripEchoedMarkerCommand(output: string, marker: string): string {
  const echoedMarkerIndex = output.indexOf(marker);
  if (echoedMarkerIndex < 0) return output.trim();
  const echoedLineEnd = output.indexOf("\n", echoedMarkerIndex);
  if (echoedLineEnd < 0) return "";
  return output.slice(echoedLineEnd + 1).trim();
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
  const { TMUX: _strippedTmux, ...envWithoutTmux } = process.env;
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: envWithoutTmux,
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
