import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerBackend,
  probeCodexAppServer,
} from "./codex-app-server.js";
import type { AgentMessage, PermissionVerdict } from "./agent-backend.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CodexAppServerBackend", () => {
  it("maps app-server lifecycle, model output, approval, and patch events", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-codex-app-server.cjs");
    writeFileSync(serverPath, fakeAppServerScript(), "utf8");

    let resumeApproval: ((verdict: PermissionVerdict) => void) | undefined;
    const permissionCalls: Array<{ toolName: string; input: unknown }> = [];
    const messages: AgentMessage[] = [];
    const backend = new CodexAppServerBackend(
      {
        cwd: dir,
        permissionHandler: (toolName, input) => {
          permissionCalls.push({ toolName, input });
          return new Promise<PermissionVerdict>((resolve) => {
            resumeApproval = resolve;
          });
        },
      },
      { command: process.execPath, args: [serverPath] },
    );
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    let completed = false;
    const run = backend.sendPrompt(sessionId, "write a tiny patch").then(() => {
      completed = true;
    });

    await pollUntil(() => permissionCalls.length === 1);
    expect(completed).toBe(false);
    expect(permissionCalls[0].toolName).toBe("shell_command");
    expect(messages.some((message) => message.type === "permission-request")).toBe(true);

    resumeApproval?.({ decision: "allow", reason: "test" });
    await run;
    await backend.dispose();

    expect(completed).toBe(true);
    expect(messages).toContainEqual({ type: "status", status: "running", detail: "turn:turn-1" });
    expect(messages).toContainEqual({ type: "model-output", textDelta: "hello from codex" });
    expect(messages.some((message) => message.type === "event" && message.name === "item/commandExecution/outputDelta")).toBe(true);
    expect(messages.filter((message) => message.type === "fs-edit")).toHaveLength(1);
    expect(messages).toContainEqual({
      type: "fs-edit",
      description: "Codex updated src/app.ts",
      path: "src/app.ts",
      diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
    });
  });

  it("bridges app-server permission profile approval requests through permissionHandler", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-permission-app-server.cjs");
    writeFileSync(serverPath, fakePermissionAppServerScript("allow"), "utf8");

    let resumeApproval: ((verdict: PermissionVerdict) => void) | undefined;
    const permissionCalls: Array<{ toolName: string; input: unknown }> = [];
    const messages: AgentMessage[] = [];
    const backend = new CodexAppServerBackend(
      {
        cwd: dir,
        permissionHandler: (toolName, input) => {
          permissionCalls.push({ toolName, input });
          return new Promise<PermissionVerdict>((resolve) => {
            resumeApproval = resolve;
          });
        },
      },
      { command: process.execPath, args: [serverPath] },
    );
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    let completed = false;
    const run = backend.sendPrompt(sessionId, "request network permission").then(() => {
      completed = true;
    });

    await pollUntil(() => permissionCalls.length === 1);
    expect(completed).toBe(false);
    expect(permissionCalls[0].toolName).toBe("request_permissions");
    expect(messages).toContainEqual({
      type: "event",
      name: "item/started",
      payload: { item: { type: "unknownSideEffect", id: "unknown-1", effect: "side-effect-ish" } },
    });

    resumeApproval?.({ decision: "allow", reason: "test" });
    await run;
    await backend.dispose();

    expect(completed).toBe(true);
    expect(messages.some((message) => message.type === "permission-request" && message.toolName === "request_permissions")).toBe(true);
  });

  it("serializes approval requests before later app-server notifications", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-premature-completion-app-server.cjs");
    writeFileSync(serverPath, fakePermissionAppServerScript("allow", { prematureTurnCompleted: true }), "utf8");

    let resumeApproval: ((verdict: PermissionVerdict) => void) | undefined;
    const permissionCalls: Array<{ toolName: string; input: unknown }> = [];
    const backend = new CodexAppServerBackend(
      {
        cwd: dir,
        permissionHandler: (toolName, input) => {
          permissionCalls.push({ toolName, input });
          return new Promise<PermissionVerdict>((resolve) => {
            resumeApproval = resolve;
          });
        },
      },
      { command: process.execPath, args: [serverPath] },
    );

    const { sessionId } = await backend.startSession();
    let completed = false;
    const run = backend.sendPrompt(sessionId, "request network permission").then(() => {
      completed = true;
    });

    await pollUntil(() => permissionCalls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(completed).toBe(false);

    resumeApproval?.({ decision: "allow", reason: "test" });
    await run;
    await backend.dispose();

    expect(completed).toBe(true);
  });

  it("drains queued frames before completing from a turn/start completed response", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-completed-response-approval-app-server.cjs");
    writeFileSync(serverPath, fakeCompletedResponseApprovalServerScript(), "utf8");

    let resumeApproval: ((verdict: PermissionVerdict) => void) | undefined;
    const permissionCalls: Array<{ toolName: string; input: unknown }> = [];
    const backend = new CodexAppServerBackend(
      {
        cwd: dir,
        permissionHandler: (toolName, input) => {
          permissionCalls.push({ toolName, input });
          return new Promise<PermissionVerdict>((resolve) => {
            resumeApproval = resolve;
          });
        },
      },
      { command: process.execPath, args: [serverPath] },
    );

    const { sessionId } = await backend.startSession();
    let completed = false;
    const run = backend.sendPrompt(sessionId, "completed response still requires approval").then(() => {
      completed = true;
    });

    await pollUntil(() => permissionCalls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(completed).toBe(false);

    resumeApproval?.({ decision: "allow", reason: "test" });
    await run;
    await backend.dispose();

    expect(completed).toBe(true);
  });

  it("denies app-server permission profile approval requests with JSON-RPC error", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-permission-deny-app-server.cjs");
    writeFileSync(serverPath, fakePermissionAppServerScript("deny"), "utf8");

    const backend = new CodexAppServerBackend(
      {
        cwd: dir,
        permissionHandler: async () => ({ decision: "deny", reason: "test denied" }),
      },
      { command: process.execPath, args: [serverPath] },
    );

    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, "deny network permission");
    await backend.dispose();
  });

  it("stops the turn when command approval is denied", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-command-deny-app-server.cjs");
    writeFileSync(serverPath, fakeCommandApprovalServerScript(), "utf8");

    const messages: AgentMessage[] = [];
    const backend = new CodexAppServerBackend(
      {
        cwd: dir,
        permissionHandler: async () => ({ decision: "deny", reason: "test denied" }),
      },
      { command: process.execPath, args: [serverPath] },
    );
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, "deny command");
    await backend.dispose();

    expect(messages).toContainEqual({ type: "status", status: "stopped", detail: "shell_command denied" });
  });

  it("reports rejected when the codex binary is unavailable", async () => {
    const dir = makeTempDir();
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command: join(dir, "does-not-exist") },
    );

    expect(result.status).toBe("rejected");
    expect(result.missing).toContain("binary:codex");
    expect(result.reason).toBe("missing_binary_codex");
  });

  it("reports rejected when codex auth is not configured", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "auth-missing");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000 },
    );

    expect(result.status).toBe("rejected");
    expect(result.missing).toContain("auth:codex");
    expect(result.reason).toBe("codex_auth_not_configured");
  });

  it("reports degraded when codex doctor does not prove auth status", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "auth-unknown");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000 },
    );

    expect(result.status).toBe("degraded");
    expect(result.missing).toContain("auth:codex");
    expect(result.reason).toBe("codex_auth_status_unknown");
  });

  it("reports degraded when app-server initialize fails after auth succeeds", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "init-fails");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000 },
    );

    expect(result.status).toBe("degraded");
    expect(result.version).toBe("Codex fake/1.0");
    expect(result.reason).toContain("exited code=42");
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "holp-codex-adapter-"));
  tempDirs.push(dir);
  return dir;
}

async function pollUntil(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}

function fakeAppServerScript(): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    send({ id: frame.id, result: { userAgent: "fake-codex-app-server" } });
    return;
  }
  if (frame.method === "initialized") return;
  if (frame.method === "thread/start") {
    send({ id: frame.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (frame.method === "turn/start") {
    send({ id: frame.id, result: { turn: { id: "turn-1", status: "running" } } });
    send({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    send({ method: "item/agentMessage/delta", params: { delta: "hello from codex" } });
    send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { itemId: "cmd-1", command: "printf hi", reason: "command needs approval" }
    });
    return;
  }
  if (frame.id === "approval-1") {
    if (!frame.result || frame.result.decision !== "accept") process.exit(2);
    send({ method: "item/commandExecution/outputDelta", params: { itemId: "cmd-1", stream: "stdout", delta: "hi" } });
    send({
      method: "item/completed",
      params: {
        item: {
          type: "fileChange",
          id: "file-1",
          changes: [{ path: "src/app.ts", diff: "--- a/src/app.ts\\n+++ b/src/app.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n" }]
        }
      }
    });
    send({
      method: "item/fileChange/patchUpdated",
      params: {
        changes: [{ path: "src/app.ts", diff: "--- a/src/app.ts\\n+++ b/src/app.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n" }]
      }
    });
    send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
  }
});
`;
}

function fakePermissionAppServerScript(mode: "allow" | "deny", opts: { prematureTurnCompleted?: boolean } = {}): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    send({ id: frame.id, result: { userAgent: "fake-codex-app-server" } });
    return;
  }
  if (frame.method === "initialized") return;
  if (frame.method === "thread/start") {
    send({ id: frame.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (frame.method === "turn/start") {
    send({ id: frame.id, result: { turn: { id: "turn-1", status: "running" } } });
    send({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    send({ method: "item/started", params: { item: { type: "unknownSideEffect", id: "unknown-1", effect: "side-effect-ish" } } });
    send({
      id: "permission-profile-1",
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-item-1",
        environmentId: null,
        cwd: "/tmp",
        reason: "network requested",
        permissions: { network: { enabled: true }, fileSystem: null }
      }
    });
    ${opts.prematureTurnCompleted ? 'send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });' : ""}
    return;
  }
  if (frame.id === "permission-profile-1") {
    if ("${mode}" === "allow") {
      if (!frame.result || frame.result.scope !== "turn" || !frame.result.permissions || frame.result.permissions.network.enabled !== true) {
        process.exit(2);
      }
    } else if (!frame.error || frame.error.code !== -32000) {
      process.exit(3);
    }
    ${opts.prematureTurnCompleted ? "" : 'send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });'}
  }
});
`;
}

function fakeCommandApprovalServerScript(): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    send({ id: frame.id, result: { userAgent: "fake-codex-app-server" } });
    return;
  }
  if (frame.method === "initialized") return;
  if (frame.method === "thread/start") {
    send({ id: frame.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (frame.method === "turn/start") {
    send({ id: frame.id, result: { turn: { id: "turn-1", status: "running" } } });
    send({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { itemId: "cmd-1", command: "printf hi", reason: "command needs approval" }
    });
    return;
  }
  if (frame.id === "approval-1") {
    if (!frame.result || frame.result.decision !== "decline") process.exit(2);
  }
});
`;
}

function fakeCompletedResponseApprovalServerScript(): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    send({ id: frame.id, result: { userAgent: "fake-codex-app-server" } });
    return;
  }
  if (frame.method === "initialized") return;
  if (frame.method === "thread/start") {
    send({ id: frame.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (frame.method === "turn/start") {
    send({ id: frame.id, result: { turn: { id: "turn-1", status: "completed" } } });
    send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { itemId: "cmd-1", command: "printf hi", reason: "command needs approval" }
    });
    return;
  }
  if (frame.id === "approval-1") {
    if (!frame.result || frame.result.decision !== "accept") process.exit(2);
  }
});
`;
}

function fakeCodexCommand(dir: string, mode: "auth-missing" | "auth-unknown" | "init-fails"): string {
  const command = join(dir, `fake-codex-${mode}.mjs`);
  const doctor = mode === "auth-missing" ? "auth is not configured" : mode === "auth-unknown" ? "doctor passed" : "auth is configured";
  const appServerExit = mode === "auth-missing" ? 0 : 42;
  writeFileSync(
    command,
    `#!/usr/bin/env node
const arg = process.argv[2];
if (arg === "--version") {
  console.log("Codex fake/1.0");
  process.exit(0);
}
if (arg === "doctor") {
  console.log("${doctor}");
  process.exit(0);
}
if (arg === "app-server") {
  process.exit(${appServerExit});
}
process.exit(64);
`,
    "utf8",
  );
  chmodSync(command, 0o755);
  return command;
}
