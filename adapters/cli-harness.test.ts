import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyCliResult,
  createCliHarnessBackendFactory,
  runCliCommand,
  type CliHarnessDefinition,
} from "./cli-harness.js";
import type { AgentMessage } from "./agent-backend.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI harness wrapper", () => {
  it("runs a one-shot CLI and emits model output", async () => {
    const command = fakeCli("ok");
    const definition: CliHarnessDefinition = {
      transport: "test-cli",
      command,
      argsForPrompt: (prompt) => ["--prompt", prompt],
    };
    const backend = createCliHarnessBackendFactory(definition)({ cwd: process.cwd() });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, "hello");
    await backend.dispose();

    expect(messages).toContainEqual({ type: "model-output", fullText: "model:hello" });
    expect(messages).toContainEqual({ type: "status", status: "idle" });
  });

  it.each([
    ["nonzero", "cli_exit_2"],
    ["empty", "cli_empty_output"],
    ["auth", "cli_known_failure_prompt"],
  ] as const)("fails closed for %s output", async (mode, reason) => {
    const result = await runCliCommand({
      command: fakeCli(mode),
      args: ["--prompt", "hello"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });

    expect(classifyCliResult(result)).toEqual({ ok: false, reason });
  });

  it("fails closed on timeout", async () => {
    const result = await runCliCommand({
      command: fakeCli("hang"),
      args: ["--prompt", "hello"],
      cwd: process.cwd(),
      timeoutMs: 20,
    });

    expect(classifyCliResult(result)).toEqual({ ok: false, reason: "cli_timeout" });
  });

  it("caps buffered stdout and reports truncation", async () => {
    const result = await runCliCommand({
      command: fakeCli("verbose"),
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 10,
    });

    expect(result.stdout).toBe("xxxxxxxxxx");
    expect(result.stdoutTruncated).toBe(true);
    expect(classifyCliResult(result)).toEqual({ ok: true });
  });

  it("does not treat benign inline error text as a known failure prompt", async () => {
    const result = await runCliCommand({
      command: fakeCli("benign-error"),
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });

    expect(result.stdout.trim()).toBe("No error: all good");
    expect(classifyCliResult(result)).toEqual({ ok: true });
  });

  it("kills the active one-shot CLI process on cancel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "holp-cli-cancel-"));
    tempDirs.push(dir);
    const startedPath = join(dir, "started");
    const killedPath = join(dir, "killed");
    const definition: CliHarnessDefinition = {
      transport: "test-cli",
      command: fakeCli("cancellable"),
      argsForPrompt: () => ["--started", startedPath, "--killed", killedPath],
      timeoutMs: 5_000,
    };
    const backend = createCliHarnessBackendFactory(definition)({ cwd: dir });

    const { sessionId } = await backend.startSession();
    const prompt = backend.sendPrompt(sessionId, "hello");
    await waitUntil(() => existsSync(startedPath));
    await backend.cancel(sessionId);
    await prompt;
    await waitUntil(() => existsSync(killedPath));
    await backend.dispose();

    expect(existsSync(killedPath)).toBe(true);
  });
});

function fakeCli(
  mode: "ok" | "nonzero" | "empty" | "auth" | "hang" | "cancellable" | "verbose" | "benign-error",
): string {
  const dir = mkdtempSync(join(tmpdir(), "holp-cli-harness-"));
  tempDirs.push(dir);
  const script = join(dir, `fake-${mode}.mjs`);
  writeFileSync(script, `#!/usr/bin/env node
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (mode === "hang") setTimeout(() => {}, 10_000);
if (mode === "cancellable") {
  const started = args[args.indexOf("--started") + 1];
  const killed = args[args.indexOf("--killed") + 1];
  await import("node:fs").then(({ writeFileSync }) => writeFileSync(started, "1"));
  process.on("SIGTERM", async () => {
    await import("node:fs").then(({ writeFileSync }) => writeFileSync(killed, "1"));
    process.exit(0);
  });
  setInterval(() => {}, 10_000);
}
if (mode === "nonzero") {
  console.error("failed");
  process.exit(2);
}
if (mode === "empty") process.exit(0);
if (mode === "auth") {
  console.log("Authentication failed: login required");
  process.exit(0);
}
if (mode === "verbose") {
  console.log("x".repeat(64));
  process.exit(0);
}
if (mode === "benign-error") {
  console.log("No error: all good");
  process.exit(0);
}
const prompt = args[args.indexOf("--prompt") + 1] || "";
console.log("model:" + prompt);
`, "utf8");
  chmodSync(script, 0o755);
  return script;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
