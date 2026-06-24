import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDirectTmuxBackendFactory,
  probeDirectTmux,
  type DirectTmuxDefinition,
} from "./direct-tmux.js";
import type { AgentMessage } from "./agent-backend.js";

const PROCESS_HEAVY_TEST_TIMEOUT_MS = 20_000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("direct tmux backend", () => {
  it("creates only holp-owned sessions and resolves on sentinel output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "holp-direct-tmux-"));
    try {
      const tmux = fakeTmux(dir);
      const definition: DirectTmuxDefinition = {
        transport: "kimi-code",
        tmuxCommand: tmux,
        agentCommand: "kimi",
        agentArgsForPrompt: (prompt) => ["-p", prompt],
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      };
      const backend = createDirectTmuxBackendFactory(definition)({ cwd: dir, tmuxSocketPath: join(dir, "tmux.sock") });
      const messages: AgentMessage[] = [];
      backend.onMessage((message) => messages.push(message));

      const { sessionId } = await backend.startSession();
      expect(sessionId.startsWith("holp-")).toBe(true);
      await backend.sendPrompt(sessionId, "hello");
      await backend.dispose();

      expect(messages).toContainEqual({ type: "model-output", fullText: "direct output" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probe requires both tmux and direct agent command availability", async () => {
    const dir = mkdtempSync(join(tmpdir(), "holp-direct-probe-"));
    try {
      const tmux = fakeTmux(dir);
      const kimi = fakeKimi(dir);

      await expect(probeDirectTmux({
        tmuxCommand: tmux,
        agentCommand: kimi,
        socketPath: join(dir, "tmux.sock"),
        cwd: dir,
        timeoutMs: 10_000,
        verifyCapabilities: true,
      })).resolves.toEqual({ ready: true });

      await expect(probeDirectTmux({
        tmuxCommand: tmux,
        agentCommand: join(dir, "missing-kimi"),
        cwd: dir,
        timeoutMs: 10_000,
      })).resolves.toMatchObject({
        ready: false,
        reason: "direct_agent_unavailable",
        missing: [`binary:${join(dir, "missing-kimi")}`],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("fails closed instead of attaching when a generated HOLP session name collides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "holp-direct-collision-"));
    try {
      const tmux = fakeTmux(dir);
      const definition: DirectTmuxDefinition = {
        transport: "kimi-code",
        tmuxCommand: tmux,
        agentCommand: "kimi",
        agentArgsForPrompt: (prompt) => ["-p", prompt],
      };
      const first = createDirectTmuxBackendFactory(definition)({ cwd: dir, tmuxSocketPath: join(dir, "tmux.sock") });
      const second = createDirectTmuxBackendFactory(definition)({ cwd: dir, tmuxSocketPath: join(dir, "tmux.sock") });
      const messages: AgentMessage[] = [];
      first.onMessage((message) => messages.push(message));
      vi.spyOn(Date, "now").mockReturnValue(123);
      vi.spyOn(Math, "random").mockReturnValue(0.5);

      await expect(first.startSession()).resolves.toEqual({ sessionId: "holp-123-8" });
      await expect(second.startSession()).rejects.toThrow("direct_tmux_create_failed");
      await expect(second.dispose()).resolves.toBeUndefined();
      await expect(first.sendPrompt("holp-123-8", "still alive")).resolves.toBeUndefined();
      expect(messages).toContainEqual({ type: "model-output", fullText: "direct output" });
      await first.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits an attach_target event carrying the caller socket and attach command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "holp-direct-attach-"));
    try {
      const tmux = fakeTmux(dir);
      const socketPath = join(dir, "tmux.sock");
      const backend = createDirectTmuxBackendFactory({
        transport: "kimi-code",
        tmuxCommand: tmux,
        agentCommand: "kimi",
        agentArgsForPrompt: (prompt) => ["-p", prompt],
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      })({ cwd: dir, tmuxSocketPath: socketPath });
      const messages: AgentMessage[] = [];
      backend.onMessage((message) => messages.push(message));

      const { sessionId } = await backend.startSession();
      await backend.dispose();

      const attach = messages.find(
        (m): m is Extract<AgentMessage, { type: "event" }> =>
          m.type === "event" && m.name === "attach_target",
      );
      expect(attach).toBeDefined();
      const payload = attach!.payload as Record<string, unknown>;
      expect(payload.session_id).toBe(sessionId);
      expect(payload.socket_path).toBe(socketPath);
      expect(payload.attach_command).toBe(`tmux -S ${socketPath} attach -t ${sessionId}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips inherited TMUX from spawned tmux commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "holp-direct-tmuxenv-"));
    const priorTmux = process.env.TMUX;
    process.env.TMUX = "/tmp/some-server,1234,0";
    try {
      const tmux = fakeTmuxEnvProbe(dir);
      const backend = createDirectTmuxBackendFactory({
        transport: "kimi-code",
        tmuxCommand: tmux,
        agentCommand: "kimi",
        agentArgsForPrompt: (prompt) => ["-p", prompt],
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      })({ cwd: dir, tmuxSocketPath: join(dir, "tmux.sock") });
      await backend.startSession();
      await backend.dispose();

      const recorded = JSON.parse(readFileSync(join(dir, "env-state.json"), "utf8")) as { tmux?: string | null };
      expect(recorded.tmux ?? "ABSENT").toBe("ABSENT");
    } finally {
      if (priorTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = priorTmux;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holdSession keeps the session past dispose, then the reaper kills it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "holp-direct-hold-"));
    try {
      const tmux = fakeTmux(dir);
      const statePath = join(dir, "tmux-state.json");
      const backend = createDirectTmuxBackendFactory({
        transport: "kimi-code",
        tmuxCommand: tmux,
        agentCommand: "kimi",
        agentArgsForPrompt: (prompt) => ["-p", prompt],
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      })({ cwd: dir, tmuxSocketPath: join(dir, "tmux.sock"), holdSession: true, holdTimeoutMs: 80 });
      const messages: AgentMessage[] = [];
      backend.onMessage((message) => messages.push(message));

      const { sessionId } = await backend.startSession();
      await backend.dispose();

      const afterDispose = JSON.parse(readFileSync(statePath, "utf8")) as { sessions?: Record<string, boolean> };
      expect(afterDispose.sessions?.[sessionId]).toBe(true);
      expect(messages).toContainEqual(
        expect.objectContaining({ type: "event", name: "session_held" }),
      );

      await expect.poll(() => {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as { sessions?: Record<string, boolean> };
        return state.sessions?.[sessionId];
      }, { timeout: 5_000, interval: 20 }).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores tmux kill-session cleanup failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "holp-direct-cleanup-"));
    try {
      const tmux = fakeTmux(dir, { killFails: true });
      const kimi = fakeKimi(dir);

      await expect(probeDirectTmux({
        tmuxCommand: tmux,
        agentCommand: kimi,
        socketPath: join(dir, "tmux.sock"),
        cwd: dir,
        timeoutMs: 10_000,
        verifyCapabilities: true,
      })).resolves.toEqual({ ready: true });

      const backend = createDirectTmuxBackendFactory({
        transport: "kimi-code",
        tmuxCommand: tmux,
        agentCommand: kimi,
        agentArgsForPrompt: (prompt) => ["-p", prompt],
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      })({ cwd: dir, tmuxSocketPath: join(dir, "tmux.sock") });
      const { sessionId } = await backend.startSession();
      await backend.sendPrompt(sessionId, "hello");
      await expect(backend.dispose()).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);
});

function fakeTmux(dir: string, opts: { killFails?: boolean } = {}): string {
  const script = join(dir, "fake-tmux.mjs");
  const statePath = join(dir, "tmux-state.json");
  writeFileSync(script, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(statePath)};
const killFails = ${JSON.stringify(opts.killFails === true)};
let args = process.argv.slice(2);
if (args[0] === "-S") args = args.slice(2);
function readState() {
  return existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
}
function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state));
}
if (args[0] === "-V") {
  console.log("tmux fake");
  process.exit(0);
}
if (args[0] === "new-session") {
  const session = args[args.indexOf("-s") + 1];
  if (!session.startsWith("holp-")) process.exit(9);
  const state = readState();
  if (state.sessions?.[session]) process.exit(1);
  writeState({ ...state, sessions: { ...(state.sessions || {}), [session]: true }, session, pane: "" });
  process.exit(0);
}
if (args[0] === "send-keys") {
  const command = args[args.indexOf("-t") + 2];
  const marker = command.match(/__(?:HOLP_DONE|HOLP_OWNER_VERIFIED)_[A-Za-z0-9_]+__/)?.[0] || "__HOLP_DONE_missing__";
  const state = readState();
  state.echo = command;
  state.pane = command + "\\ndirect output\\n" + marker + "\\n";
  state.captureCount = 0;
  writeState(state);
  process.exit(0);
}
if (args[0] === "capture-pane") {
  const state = readState();
  const pane = state.captureCount === 0 ? state.echo : state.pane;
  state.captureCount = (state.captureCount || 0) + 1;
  writeState(state);
  process.stdout.write(pane || "");
  process.exit(0);
}
if (args[0] === "kill-session") {
  const session = args[args.indexOf("-t") + 1];
  const state = readState();
  if (state.sessions) delete state.sessions[session];
  writeState(state);
  process.exit(killFails ? 9 : 0);
}
process.exit(64);
`, "utf8");
  chmodSync(script, 0o755);
  return script;
}

function fakeTmuxEnvProbe(dir: string): string {
  const script = join(dir, "fake-tmux-env.mjs");
  const statePath = join(dir, "env-state.json");
  writeFileSync(script, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(statePath)};
let args = process.argv.slice(2);
if (args[0] === "-S") args = args.slice(2);
if (args[0] === "-V") { console.log("tmux fake"); process.exit(0); }
if (args[0] === "new-session") {
  writeFileSync(statePath, JSON.stringify({ tmux: process.env.TMUX ?? null }));
  process.exit(0);
}
if (args[0] === "send-keys" || args[0] === "kill-session") process.exit(0);
if (args[0] === "capture-pane") { process.stdout.write(""); process.exit(0); }
process.exit(64);
`, "utf8");
  chmodSync(script, 0o755);
  return script;
}

function fakeKimi(dir: string): string {
  const script = join(dir, "fake-kimi.mjs");
  writeFileSync(script, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("kimi fake");
  process.exit(0);
}
console.log("kimi output");
`, "utf8");
  chmodSync(script, 0o755);
  return script;
}
