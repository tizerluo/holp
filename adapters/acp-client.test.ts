import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpClient, createAcpBackendFactory } from "./acp-client.js";
import type { AgentMessage } from "./agent-backend.js";

const tempDirs: string[] = [];
const PROCESS_HEAVY_TEST_TIMEOUT_MS = 20_000;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ACP stdio client", () => {
  it("initializes, creates a session, streams updates, and resolves on terminal", async () => {
    const client = new AcpClient({
      command: fakeAcpServer("ok"),
      cwd: process.cwd(),
      requestTimeoutMs: 5_000,
      terminalTimeoutMs: 5_000,
    });

    const { sessionId } = await client.startSession();
    const output = await client.sendPrompt(sessionId, "hello");
    await client.dispose();

    expect(sessionId).toBe("session-1");
    expect(output).toBe("final:hello");
  });

  it("resolves Kimi-style nested message chunks on prompt stopReason", async () => {
    const client = new AcpClient({
      command: fakeAcpServer("kimi-stop"),
      cwd: process.cwd(),
      requestTimeoutMs: 5_000,
      terminalTimeoutMs: 5_000,
    });

    const { sessionId } = await client.startSession();
    const output = await client.sendPrompt(sessionId, "hello");
    await client.dispose();

    expect(output).toBe("kimi:hello");
  });

  it("preserves default session/new params with empty mcpServers", async () => {
    const client = new AcpClient({
      command: fakeAcpServer("default-session-shape"),
      cwd: process.cwd(),
      requestTimeoutMs: 5_000,
      terminalTimeoutMs: 5_000,
    });

    const { sessionId } = await client.startSession();
    await client.dispose();

    expect(sessionId).toBe("session-1");
  });

  it("can opt into Reasonix-style cwd-only session/new params", async () => {
    const client = new AcpClient({
      command: fakeAcpServer("cwd-only-session-shape"),
      cwd: process.cwd(),
      sessionNewShape: "cwd_only",
      requestTimeoutMs: 5_000,
      terminalTimeoutMs: 5_000,
    });

    const { sessionId } = await client.startSession();
    await client.dispose();

    expect(sessionId).toBe("session-1");
  });

  it("backend emits streamed and final model output", async () => {
    const messages: AgentMessage[] = [];
    const backend = createAcpBackendFactory({
      transport: "fake-acp",
      command: fakeAcpServer("ok"),
      requestTimeoutMs: 5_000,
      terminalTimeoutMs: 5_000,
    })({ cwd: process.cwd() });
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, "world");
    await backend.dispose();

    expect(messages).toContainEqual({ type: "model-output", textDelta: "delta:world" });
    expect(messages).toContainEqual({ type: "model-output", fullText: "final:world" });
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("rejects concurrent prompts on one ACP client", async () => {
    const client = new AcpClient({
      command: fakeAcpServer("slow-prompt"),
      cwd: process.cwd(),
      requestTimeoutMs: 5_000,
      terminalTimeoutMs: 5_000,
    });

    const { sessionId } = await client.startSession();
    const first = client.sendPrompt(sessionId, "first");
    await expect(client.sendPrompt(sessionId, "second")).rejects.toThrow("acp_prompt_in_flight");
    await expect(first).resolves.toBe("final:first");
    await client.dispose();
  });

  it("sends cancel without turning a pending prompt into success", async () => {
    const client = new AcpClient({
      command: fakeAcpServer("cancel-hangs-prompt"),
      cwd: process.cwd(),
      requestTimeoutMs: 5_000,
      terminalTimeoutMs: 50,
    });

    const { sessionId } = await client.startSession();
    const prompt = client.sendPrompt(sessionId, "cancel me");
    await client.cancel(sessionId);

    await expect(prompt).rejects.toThrow("acp_terminal_timeout");
    await client.dispose().catch(() => undefined);
  });

  it("ignores late updates after a prompt already failed closed", async () => {
    const client = new AcpClient({
      command: fakeAcpServer("late-update-after-error"),
      cwd: process.cwd(),
      requestTimeoutMs: 5_000,
      terminalTimeoutMs: 5_000,
    });

    const { sessionId } = await client.startSession();
    await expect(client.sendPrompt(sessionId, "late")).rejects.toThrow("acp_rpc_error");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(client.sendPrompt(sessionId, "next")).resolves.toBe("final:next");
    await client.dispose();
  });

  it.each([
    ["missing-terminal", "acp_terminal_timeout"],
    ["malformed", "acp_malformed_json"],
    ["exit", "acp_process_exit"],
    ["prompt-error", "acp_rpc_error"],
    ["stop-without-output", "acp_missing_final_result"],
    ["request-timeout", "acp_request_timeout:initialize"],
  ] as const)("fails closed for %s", async (mode, expected) => {
    const client = new AcpClient({
      command: fakeAcpServer(mode),
      cwd: process.cwd(),
      requestTimeoutMs: mode === "request-timeout" ? 30 : 5_000,
      terminalTimeoutMs: 30,
    });

    await expect((async () => {
      const { sessionId } = await client.startSession();
      await client.sendPrompt(sessionId, "hello");
    })()).rejects.toThrow(expected);
    await client.dispose().catch(() => undefined);
  });
});

function fakeAcpServer(
  mode: "ok" | "kimi-stop" | "default-session-shape" | "cwd-only-session-shape" | "slow-prompt" | "cancel-hangs-prompt" | "late-update-after-error" | "missing-terminal" | "malformed" | "exit" | "prompt-error" | "stop-without-output" | "request-timeout",
): string {
  const dir = mkdtempSync(join(tmpdir(), "holp-acp-client-"));
  tempDirs.push(dir);
  const script = join(dir, `fake-acp-${mode}.mjs`);
  writeFileSync(script, `#!/usr/bin/env node
import readline from "node:readline";
const mode = ${JSON.stringify(mode)};
const rl = readline.createInterface({ input: process.stdin });
function send(frame) {
  process.stdout.write(JSON.stringify(frame) + "\\n");
}
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (mode === "request-timeout") return;
  if (frame.method === "initialize") {
    if (frame.params.protocolVersion !== 1) {
      send({ id: frame.id, error: { code: -32602, message: "missing protocolVersion" } });
      return;
    }
    send({ id: frame.id, result: { ok: true } });
    return;
  }
  if (frame.method === "session/new") {
    if (mode === "cwd-only-session-shape") {
      if (typeof frame.params.cwd !== "string" || "mcpServers" in frame.params) {
        send({ id: frame.id, error: { code: -32602, message: "expected cwd-only session/new params" } });
        return;
      }
      send({ id: frame.id, result: { sessionId: "session-1" } });
      return;
    }
    if (typeof frame.params.cwd !== "string" || !Array.isArray(frame.params.mcpServers)) {
      send({ id: frame.id, error: { code: -32602, message: "invalid session/new params" } });
      return;
    }
    send({ id: frame.id, result: { sessionId: "session-1" } });
    return;
  }
  if (frame.method === "session/prompt") {
    const prompt = Array.isArray(frame.params.prompt)
      ? frame.params.prompt.map((block) => block.text || "").join("")
      : frame.params.prompt;
    if (mode === "prompt-error") {
      send({ id: frame.id, error: { code: -32001, message: "prompt rejected" } });
      return;
    }
    if (mode === "late-update-after-error" && prompt === "late") {
      send({ id: frame.id, error: { code: -32001, message: "prompt rejected" } });
      setTimeout(() => {
        send({ method: "session/update", params: { sessionId: "session-1", finalText: "SHOULD_NOT_LEAK", type: "completed" } });
      }, 10);
      return;
    }
    if (mode === "stop-without-output") {
      send({ id: frame.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (mode === "cancel-hangs-prompt") {
      send({ id: frame.id, result: { accepted: true } });
      return;
    }
    if (mode === "kimi-stop") {
      send({ method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_thought_chunk", content: { text: "thinking" } } } });
      send({ method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { text: "kimi:" } } } });
      send({ method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { chunk: prompt } } } });
      send({ id: frame.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (mode === "slow-prompt") {
      setTimeout(() => {
        send({ id: frame.id, result: { accepted: true } });
        send({ method: "session/update", params: { sessionId: "session-1", finalText: "final:" + prompt, type: "completed" } });
      }, 50);
      return;
    }
    send({ id: frame.id, result: { accepted: true } });
    if (mode === "exit") process.exit(7);
    if (mode === "malformed") {
      process.stdout.write("not json\\n");
      return;
    }
    send({ method: "session/update", params: { sessionId: "session-1", textDelta: "delta:" + prompt } });
    if (mode !== "missing-terminal") {
      send({ method: "session/update", params: { sessionId: "session-1", finalText: "final:" + prompt, type: "completed" } });
    }
    return;
  }
  if (frame.method === "session/cancel") {
    send({ id: frame.id, result: { cancelled: true } });
  }
});
`, "utf8");
  chmodSync(script, 0o755);
  return script;
}
