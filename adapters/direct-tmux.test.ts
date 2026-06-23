import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDirectTmuxBackendFactory,
  probeDirectTmux,
  type DirectTmuxDefinition,
} from "./direct-tmux.js";
import type { AgentMessage } from "./agent-backend.js";

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
      const backend = createDirectTmuxBackendFactory(definition)({ cwd: dir });
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

  it("probe requires both tmux and Kimi command availability", async () => {
    const dir = mkdtempSync(join(tmpdir(), "holp-direct-probe-"));
    try {
      const tmux = fakeTmux(dir);
      const kimi = fakeKimi(dir);

      await expect(probeDirectTmux({
        tmuxCommand: tmux,
        agentCommand: kimi,
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
        reason: "kimi_unavailable",
      });
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
      })({ cwd: dir });
      const { sessionId } = await backend.startSession();
      await backend.sendPrompt(sessionId, "hello");
      await expect(backend.dispose()).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fakeTmux(dir: string, opts: { killFails?: boolean } = {}): string {
  const script = join(dir, "fake-tmux.mjs");
  const statePath = join(dir, "tmux-state.json");
  writeFileSync(script, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(statePath)};
const killFails = ${JSON.stringify(opts.killFails === true)};
const args = process.argv.slice(2);
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
  writeState({ session, pane: "" });
  process.exit(0);
}
if (args[0] === "send-keys") {
  const command = args[args.indexOf("-t") + 2];
  const marker = command.match(/__(?:HOLP_DONE|HOLP_OWNER_VERIFIED)_[A-Za-z0-9_]+__/)?.[0] || "__HOLP_DONE_missing__";
  const state = readState();
  state.pane = command + "\\ndirect output\\n" + marker + "\\n";
  writeState(state);
  process.exit(0);
}
if (args[0] === "capture-pane") {
  process.stdout.write(readState().pane || "");
  process.exit(0);
}
if (args[0] === "kill-session") process.exit(killFails ? 9 : 0);
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
