import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});

function fakeCli(mode: "ok" | "nonzero" | "empty" | "auth" | "hang"): string {
  const dir = mkdtempSync(join(tmpdir(), "holp-cli-harness-"));
  tempDirs.push(dir);
  const script = join(dir, `fake-${mode}.mjs`);
  writeFileSync(script, `#!/usr/bin/env node
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (mode === "hang") setTimeout(() => {}, 10_000);
if (mode === "nonzero") {
  console.error("failed");
  process.exit(2);
}
if (mode === "empty") process.exit(0);
if (mode === "auth") {
  console.log("Authentication failed: login required");
  process.exit(0);
}
const prompt = args[args.indexOf("--prompt") + 1] || "";
console.log("model:" + prompt);
`, "utf8");
  chmodSync(script, 0o755);
  return script;
}
