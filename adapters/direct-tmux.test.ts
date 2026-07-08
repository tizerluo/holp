import { spawnSync } from "node:child_process";
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
const REAL_TMUX_SOCKET_AVAILABLE = canRunRealTmuxSocketSmoke();

if (!REAL_TMUX_SOCKET_AVAILABLE) {
  console.warn("[PR18 Slice B] Skipping real tmux env injection test: tmux socket smoke unavailable in this sandbox.");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("direct tmux backend", () => {
  it("injects per-run env at tmux session creation and threads model to supported args", async () => {
    const dir = mkdtempSync(join(tmpdir(), "holp-direct-env-model-"));
    let modelSeen: string | undefined;
    try {
      const tmux = fakeTmux(dir);
      const backend = createDirectTmuxBackendFactory({
        transport: "mcp-codex",
        tmuxCommand: tmux,
        agentCommand: "codex",
        agentArgsForPrompt: (prompt, options) => {
          modelSeen = options?.modelId;
          return ["exec", "-m", options?.modelId ?? "", prompt];
        },
        supportsModelId: true,
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      })({
        cwd: dir,
        tmuxSocketPath: join(dir, "tmux.sock"),
        env: { HOLP_FLAG: "enabled" },
        modelId: "gpt-5-test",
      });

      const { sessionId } = await backend.startSession();
      await backend.sendPrompt(sessionId, "hello");
      await backend.dispose();

      const state = JSON.parse(readFileSync(join(dir, "tmux-state.json"), "utf8")) as {
        envArgs?: readonly string[];
      };
      expect(state.envArgs).toEqual(["HOLP_FLAG=enabled"]);
      expect(modelSeen).toBe("gpt-5-test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for model when the direct tmux definition has no model injection support", () => {
    const factory = createDirectTmuxBackendFactory({
      transport: "kimi-code",
      tmuxCommand: "tmux",
      agentCommand: "kimi",
      agentArgsForPrompt: (prompt) => ["-p", prompt],
    });

    expect(() => factory({ cwd: process.cwd(), modelId: "kimi-k2" })).toThrow(
      "direct_tmux_model_unsupported",
    );
  });

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

  it("streams pipe-pane output as incremental text_delta while still emitting final full_text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "holp-direct-stream-"));
    try {
      const tmux = fakeTmux(dir);
      const backend = createDirectTmuxBackendFactory({
        transport: "kimi-code",
        tmuxCommand: tmux,
        agentCommand: "kimi",
        agentArgsForPrompt: (prompt) => ["-p", prompt],
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      })({ cwd: dir, tmuxSocketPath: join(dir, "tmux.sock") });
      const messages: AgentMessage[] = [];
      backend.onMessage((message) => messages.push(message));

      const { sessionId } = await backend.startSession();
      await backend.sendPrompt(sessionId, "hello");
      await backend.dispose();

      const deltas = messages.filter(
        (m): m is Extract<AgentMessage, { type: "model-output" }> =>
          m.type === "model-output" && typeof m.textDelta === "string",
      );
      const finals = messages.filter(
        (m): m is Extract<AgentMessage, { type: "model-output" }> =>
          m.type === "model-output" && typeof m.fullText === "string",
      );
      expect(deltas.some((m) => m.textDelta!.includes("direct output"))).toBe(true);
      expect(finals).toHaveLength(1);
      expect(finals[0].fullText).toBe("direct output");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to capture-pane diff for text_delta when pipe-pane is unsupported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "holp-direct-capdiff-"));
    try {
      const tmux = fakeTmux(dir, { pipeFails: true });
      const backend = createDirectTmuxBackendFactory({
        transport: "kimi-code",
        tmuxCommand: tmux,
        agentCommand: "kimi",
        agentArgsForPrompt: (prompt) => ["-p", prompt],
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      })({ cwd: dir, tmuxSocketPath: join(dir, "tmux.sock") });
      const messages: AgentMessage[] = [];
      backend.onMessage((message) => messages.push(message));

      const { sessionId } = await backend.startSession();
      await backend.sendPrompt(sessionId, "hello");
      await backend.dispose();

      const deltas = messages.filter(
        (m): m is Extract<AgentMessage, { type: "model-output" }> =>
          m.type === "model-output" && typeof m.textDelta === "string",
      );
      const finals = messages.filter(
        (m): m is Extract<AgentMessage, { type: "model-output" }> =>
          m.type === "model-output" && typeof m.fullText === "string",
      );
      expect(deltas.some((m) => m.textDelta!.includes("direct output"))).toBe(true);
      expect(finals).toHaveLength(1);
      expect(finals[0].fullText).toBe("direct output");
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

  it.skipIf(!REAL_TMUX_SOCKET_AVAILABLE)(
    "injects env into the pane worker when a tmux server is already running",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "holp-real-tmux-env-"));
      const socketPath = join(dir, "tmux.sock");
      const serverSession = `holp-existing-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const envKey = "HOLP_DIRECT_ENV_TEST";
      const globalValue = `global-${Date.now()}`;
      const sessionValue = `session-${Date.now()}`;
      let backend: ReturnType<ReturnType<typeof createDirectTmuxBackendFactory>> | undefined;
      const { TMUX: _strippedTmux, ...envWithoutTmux } = process.env;
      try {
        const created = spawnSync(
          "tmux",
          ["-S", socketPath, "new-session", "-d", "-s", serverSession, "sleep 60"],
          { cwd: dir, encoding: "utf8", env: envWithoutTmux },
        );
        expect(created.status, created.stderr).toBe(0);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const hasSession = spawnSync(
            "tmux",
            ["-S", socketPath, "has-session", "-t", serverSession],
            { cwd: dir, encoding: "utf8", env: envWithoutTmux },
          );
          if (hasSession.status === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const setGlobal = spawnSync(
          "tmux",
          ["-S", socketPath, "set-environment", "-g", envKey, globalValue],
          { cwd: dir, encoding: "utf8", env: envWithoutTmux },
        );
        expect(setGlobal.status, setGlobal.stderr).toBe(0);

        backend = createDirectTmuxBackendFactory({
          transport: "printenv",
          tmuxCommand: "tmux",
          agentCommand: "sh",
          agentArgsForPrompt: () => ["-lc", `printf "%s" "$${envKey}"`],
          timeoutMs: 5_000,
          pollIntervalMs: 20,
        })({
          cwd: dir,
          tmuxSocketPath: socketPath,
          env: { [envKey]: sessionValue },
        });
        const messages: AgentMessage[] = [];
        backend.onMessage((message) => messages.push(message));

        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, "ignored");

        const fullText = messages
          .filter((m): m is Extract<AgentMessage, { type: "model-output" }> =>
            m.type === "model-output" && typeof m.fullText === "string")
          .at(-1)?.fullText ?? "";
        expect(fullText).toContain(sessionValue);
        expect(fullText).not.toContain(globalValue);
      } finally {
        await backend?.dispose().catch(() => undefined);
        spawnSync("tmux", ["-S", socketPath, "kill-server"], { cwd: dir, stdio: "ignore", env: envWithoutTmux });
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PROCESS_HEAVY_TEST_TIMEOUT_MS,
  );
});

function canRunRealTmuxSocketSmoke(): boolean {
  if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) return false;
  const dir = mkdtempSync(join(tmpdir(), "holp-real-tmux-probe-"));
  const socketPath = join(dir, "tmux.sock");
  const sessionId = `holp-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { TMUX: _strippedTmux, ...envWithoutTmux } = process.env;
  try {
    spawnSync(
      "tmux",
      ["-S", socketPath, "new-session", "-d", "-s", sessionId, "sleep 5"],
      { cwd: dir, stdio: "ignore", env: envWithoutTmux },
    );
    return spawnSync(
      "tmux",
      ["-S", socketPath, "has-session", "-t", sessionId],
      { cwd: dir, stdio: "ignore", env: envWithoutTmux },
    ).status === 0;
  } finally {
    spawnSync("tmux", ["-S", socketPath, "kill-server"], { cwd: dir, stdio: "ignore", env: envWithoutTmux });
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeTmux(dir: string, opts: { killFails?: boolean; pipeFails?: boolean } = {}): string {
  const script = join(dir, "fake-tmux.mjs");
  const statePath = join(dir, "tmux-state.json");
  writeFileSync(script, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(statePath)};
const killFails = ${JSON.stringify(opts.killFails === true)};
const pipeFails = ${JSON.stringify(opts.pipeFails === true)};
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
  const envArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-e") envArgs.push(args[index + 1]);
  }
  const state = readState();
  if (state.sessions?.[session]) process.exit(1);
  writeState({ ...state, sessions: { ...(state.sessions || {}), [session]: true }, session, pane: "", envArgs });
  process.exit(0);
}
if (args[0] === "pipe-pane") {
  if (pipeFails) process.exit(1);
  const cmd = args[args.indexOf("-o") + 1] || "";
  const match = cmd.match(/cat >> '([^']+)'/);
  const state = readState();
  state.logFile = match ? match[1] : undefined;
  writeState(state);
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
  if (state.logFile) writeFileSync(state.logFile, "direct output\\n");
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
