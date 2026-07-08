import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDirectTmuxBackendFactory } from "./direct-tmux.js";
import {
  createZcodeHeadlessBackendFactory,
  createZcodeProbe,
  parseZcodeJsonOutput,
  zcodeArgsForPrompt,
  zcodeDirectAgentArgsForPrompt,
} from "./zcode.js";
import type { AgentMessage } from "./agent-backend.js";

const tempDirs: string[] = [];
const PROCESS_HEAVY_TEST_TIMEOUT_MS = 150_000;
const REAL_ZCODE_SMOKE_OPTED_IN = process.env.HOLP_REAL_ZCODE_SMOKE === "1";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.HOLP_REAL_ZCODE_SMOKE;
});

describe("ZCode adapter", () => {
  it("parses the last legal JSON block with a response after warning prefixes and usage trailers", () => {
    const parsed = parseZcodeJsonOutput([
      "AI SDK Warning: cacheControl breakpoint ignored",
      "not json",
      "{\"response\":\"old\"}",
      "{",
      "  \"sessionId\": \"s1\",",
      "  \"response\": \"final\",",
      "  \"usage\": { \"totalTokens\": 1 }",
      "}",
      "{\"usage\":{\"totalTokens\":2}}",
    ].join("\n"));

    expect(parsed.response).toBe("final");
  });

  it("builds headless args with explicit cwd and read-only plan mode", () => {
    expect(zcodeArgsForPrompt("PROMPT", "/repo")).toEqual([
      "--prompt",
      "PROMPT",
      "--mode",
      "build",
      "--json",
      "--cwd",
      "/repo",
    ]);
    expect(zcodeArgsForPrompt("PROMPT", "/repo", "read_only_review")).toContain("plan");
  });

  it("builds direct args without --cwd so the tmux pane provides cwd", () => {
    expect(zcodeDirectAgentArgsForPrompt("PROMPT")).toEqual([
      "--prompt",
      "PROMPT",
      "--mode",
      "build",
      "--json",
    ]);
  });

  it("runs fake zcode headless, tolerates warning-prefixed JSON, and injects config credentials", async () => {
    const dir = makeTempDir();
    const statePath = join(dir, "state.json");
    const configPath = writeZcodeConfig(dir, {
      apiKey: "fake-secret-key",
      baseURL: "https://fake-base-url.test",
      models: { "GLM-5.2": {} },
    });
    const backend = createZcodeHeadlessBackendFactory({
      command: fakeZcode(dir, statePath, "ok"),
      configPath,
      timeoutMs: 5_000,
    })({
      cwd: dir,
      env: {
        ZCODE_MODEL: "GLM-5-Air",
        ZCODE_BASE_URL: "https://override-base-url.test",
      },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, "hello");
    await backend.dispose();

    expect(messages).toContainEqual({ type: "model-output", fullText: "fake response" });
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      args: readonly string[];
      env: Record<string, string>;
    };
    expect(state.args).toEqual([
      "--prompt",
      "hello",
      "--mode",
      "build",
      "--json",
      "--cwd",
      dir,
    ]);
    expect(state.env.ANTHROPIC_API_KEY).toBe("fake-secret-key");
    expect(state.env.ZCODE_BASE_URL).toBe("https://override-base-url.test");
    expect(state.env.ZCODE_MODEL).toBe("GLM-5-Air");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("keeps config credential values when per-run env provides empty strings", async () => {
    const dir = makeTempDir();
    const statePath = join(dir, "state.json");
    const configPath = writeZcodeConfig(dir, {
      baseURL: "https://config-base-url.test",
      models: { "GLM-5.2": {} },
    });
    const backend = createZcodeHeadlessBackendFactory({
      command: fakeZcode(dir, statePath, "ok"),
      configPath,
      timeoutMs: 5_000,
    })({
      cwd: dir,
      env: {
        ZCODE_MODEL: "",
        ZCODE_BASE_URL: "",
      },
    });

    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, "hello");

    const state = JSON.parse(readFileSync(statePath, "utf8")) as { env: Record<string, string> };
    expect(state.env.ZCODE_BASE_URL).toBe("https://config-base-url.test");
    expect(state.env.ZCODE_MODEL).toBe("GLM-5.2");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("fails closed when the credential config is missing", async () => {
    const dir = makeTempDir();
    const backend = createZcodeHeadlessBackendFactory({
      command: fakeZcode(dir, join(dir, "state.json"), "ok"),
      configPath: join(dir, "missing-config.json"),
    })({ cwd: dir });
    const { sessionId } = await backend.startSession();

    await expect(backend.sendPrompt(sessionId, "hello")).rejects.toThrow(
      "zcode_missing_credential_config",
    );
  });

  it("fails closed when the enabled credential provider has an empty api key", async () => {
    const dir = makeTempDir();
    const backend = createZcodeHeadlessBackendFactory({
      command: fakeZcode(dir, join(dir, "state.json"), "ok"),
      configPath: writeZcodeConfig(dir, { apiKey: "" }),
    })({ cwd: dir });
    const { sessionId } = await backend.startSession();

    await expect(backend.sendPrompt(sessionId, "hello")).rejects.toThrow(
      "zcode_missing_credential_config",
    );
  });

  it("fails closed when no provider is enabled", async () => {
    const dir = makeTempDir();
    const backend = createZcodeHeadlessBackendFactory({
      command: fakeZcode(dir, join(dir, "state.json"), "ok"),
      configPath: writeZcodeConfig(dir, { enabled: false }),
    })({ cwd: dir });
    const { sessionId } = await backend.startSession();

    await expect(backend.sendPrompt(sessionId, "hello")).rejects.toThrow(
      "zcode_missing_credential_config",
    );
  });

  it("fails closed when credential config JSON cannot be parsed", async () => {
    const dir = makeTempDir();
    const configDir = join(dir, ".zcode", "v2");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    writeFileSync(configPath, "{", "utf8");
    const backend = createZcodeHeadlessBackendFactory({
      command: fakeZcode(dir, join(dir, "state.json"), "ok"),
      configPath,
    })({ cwd: dir });
    const { sessionId } = await backend.startSession();

    await expect(backend.sendPrompt(sessionId, "hello")).rejects.toThrow(
      "zcode_missing_credential_config",
    );
  });

  it("fails closed on nonzero zcode exit", async () => {
    const dir = makeTempDir();
    const configPath = writeZcodeConfig(dir);
    const backend = createZcodeHeadlessBackendFactory({
      command: fakeZcode(dir, join(dir, "state.json"), "nonzero"),
      configPath,
      timeoutMs: 5_000,
    })({ cwd: dir });
    const { sessionId } = await backend.startSession();

    await expect(backend.sendPrompt(sessionId, "hello")).rejects.toThrow("zcode_cli_exit_7");
  });

  it("does not leak fixture credentials through messages or error payloads", async () => {
    const secret = "fixture-fake-key-do-not-leak";
    const dir = makeTempDir();
    const configPath = writeZcodeConfig(dir, { apiKey: secret });
    const messages: AgentMessage[] = [];
    const backend = createZcodeHeadlessBackendFactory({
      command: fakeZcode(dir, join(dir, "state.json"), "nonzero"),
      configPath,
      timeoutMs: 5_000,
    })({ cwd: dir });
    backend.onMessage((message) => messages.push(message));
    const { sessionId } = await backend.startSession();

    let error: unknown;
    try {
      await backend.sendPrompt(sessionId, "hello");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const payload = JSON.stringify({
      messages,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
    });
    expect(payload).not.toContain(secret);
  });

  it("probes binary version plus credential config and keeps headless degraded until real smoke opt-in", async () => {
    const dir = makeTempDir();
    const statePath = join(dir, "state.json");
    const result = await createZcodeProbe({
      command: fakeZcode(dir, statePath, "ok"),
      configPath: writeZcodeConfig(dir),
    })({
      id: "zcode",
      transport: "zcode",
      roles: ["coder"],
      cwd: dir,
    });

    const headless = result.runtime_surfaces?.find((surface) => surface.runtime_surface === "headless");
    const acp = result.runtime_surfaces?.find((surface) => surface.runtime_surface === "acp");
    const direct = result.runtime_surfaces?.find((surface) => surface.runtime_surface === "direct_user_session");
    expect(result.status).toBe("degraded");
    expect(result.version).toBe("zcode fake 0.15.0");
    expect(headless?.actual_fidelity).toBe("one_shot");
    expect(headless?.surface_support).toBe("supported");
    expect(headless?.isolation_profiles.coder_worktree).toMatchObject({
      readiness: "degraded",
      reason: "zcode_headless_smoke_not_enabled",
      missing: ["env:HOLP_REAL_ZCODE_SMOKE", "zcode_headless_smoke"],
    });
    expect(acp?.surface_support).toBe("unsupported");
    expect(acp?.isolation_profiles.coder_worktree.reason).toBe("zcode_acp_bridge_not_certified");
    expect(direct?.runtime_kind).toBe("tmux");
    expect(direct?.isolation_profiles.coder_worktree).toMatchObject({
      readiness: "degraded",
      reason: "zcode_direct_smoke_not_enabled",
      missing: ["env:HOLP_REAL_ZCODE_SMOKE"],
    });
  });

  it("promotes direct coder_worktree readiness only when HOLP_REAL_ZCODE_SMOKE is enabled and tmux probes", async () => {
    process.env.HOLP_REAL_ZCODE_SMOKE = "1";
    const dir = makeTempDir();
    const statePath = join(dir, "state.json");
    const result = await createZcodeProbe({
      command: fakeZcode(dir, statePath, "ok"),
      configPath: writeZcodeConfig(dir),
      tmuxCommand: fakeTmux(dir, join(dir, "tmux-state.json")),
    })({
      id: "zcode",
      transport: "zcode",
      roles: ["coder"],
      cwd: dir,
    });

    const headless = result.runtime_surfaces?.find((surface) => surface.runtime_surface === "headless");
    const direct = result.runtime_surfaces?.find((surface) => surface.runtime_surface === "direct_user_session");
    expect(result.status).toBe("ready");
    expect(headless?.isolation_profiles.coder_worktree.reason).toBe("zcode_smoke_missing_holp_ok");
    expect(direct?.isolation_profiles.coder_worktree.readiness).toBe("ready");
    expect(direct?.direct_channel?.capability_bitmask).toContain("owner_verified");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("does not add zcode to the reviewer roster in this PR", async () => {
    const dir = makeTempDir();
    const result = await createZcodeProbe({
      command: fakeZcode(dir, join(dir, "state.json"), "ok"),
      configPath: writeZcodeConfig(dir),
    })({
      id: "zcode",
      transport: "zcode",
      roles: ["reviewer", "coder"],
      cwd: dir,
    });

    expect(result.resolved_roles).toEqual(["coder"]);
  });

  it("promotes the headless probe only when HOLP_REAL_ZCODE_SMOKE is enabled", async () => {
    process.env.HOLP_REAL_ZCODE_SMOKE = "1";
    const dir = makeTempDir();
    const result = await createZcodeProbe({
      command: fakeZcode(dir, join(dir, "state.json"), "smoke"),
      configPath: writeZcodeConfig(dir),
    })({
      id: "zcode",
      transport: "zcode",
      roles: ["coder"],
      cwd: dir,
    });

    const headless = result.runtime_surfaces?.find((surface) => surface.runtime_surface === "headless");
    expect(result.status).toBe("ready");
    expect(headless?.isolation_profiles.coder_worktree.readiness).toBe("ready");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("drives zcode through fake tmux with prompt/mode/json args and no --cwd", async () => {
    const dir = makeTempDir();
    const statePath = join(dir, "tmux-state.json");
    const backend = createDirectTmuxBackendFactory({
      transport: "zcode",
      tmuxCommand: fakeTmux(dir, statePath),
      agentCommand: "zcode",
      agentArgsForPrompt: zcodeDirectAgentArgsForPrompt,
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    })({ cwd: dir, tmuxSocketPath: join(dir, "tmux.sock") });

    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, "hello");
    await backend.dispose();

    const state = JSON.parse(readFileSync(statePath, "utf8")) as { echo: string };
    expect(state.echo).toContain("'zcode' '--prompt' 'hello' '--mode' 'build' '--json'");
    expect(state.echo).not.toContain("--cwd");
  });

  it("fails closed when direct zcode is given a model id", () => {
    const factory = createDirectTmuxBackendFactory({
      transport: "zcode",
      agentCommand: "zcode",
      agentArgsForPrompt: zcodeDirectAgentArgsForPrompt,
    });

    expect(() => factory({ cwd: process.cwd(), modelId: "GLM-5.2" })).toThrow(
      "direct_tmux_model_unsupported",
    );
  });

  it.skipIf(!REAL_ZCODE_SMOKE_OPTED_IN)(
    "real zcode smoke is opt-in only; set HOLP_REAL_ZCODE_SMOKE=1 to run it",
    async () => {
      process.env.HOLP_REAL_ZCODE_SMOKE = "1";
      const result = await createZcodeProbe()({
        id: "zcode",
        transport: "zcode",
        roles: ["coder"],
        cwd: process.cwd(),
      });
      expect(result.status).toBe("ready");
    },
    PROCESS_HEAVY_TEST_TIMEOUT_MS,
  );
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "holp-zcode-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeZcodeConfig(
  dir: string,
  options: { apiKey?: string; baseURL?: string; enabled?: boolean; models?: Record<string, unknown> } = {},
): string {
  const configDir = join(dir, ".zcode", "v2");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    provider: {
      zai: {
        enabled: options.enabled ?? true,
        options: {
          apiKey: options.apiKey ?? "fake-api-key",
          baseURL: options.baseURL ?? "https://fake-zcode.test",
        },
        models: options.models ?? { "GLM-5.2": {}, "GLM-5-Air": {} },
      },
    },
  }), "utf8");
  return configPath;
}

function fakeZcode(
  dir: string,
  statePath: string,
  mode: "ok" | "smoke" | "nonzero",
): string {
  const script = join(dir, `fake-zcode-${mode}.mjs`);
  writeFileSync(script, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("zcode fake 0.15.0");
  process.exit(0);
}
writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({
  args: process.argv.slice(2),
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
    ZCODE_BASE_URL: process.env.ZCODE_BASE_URL || "",
    ZCODE_MODEL: process.env.ZCODE_MODEL || ""
  }
}));
if (${JSON.stringify(mode)} === "nonzero") {
  console.error("failed");
  process.exit(7);
}
console.log("AI SDK Warning: ignored cacheControl");
console.log(JSON.stringify({
  sessionId: "s1",
  response: ${JSON.stringify(mode === "smoke" ? "HOLP_OK" : "fake response")},
  usage: { totalTokens: 1 }
}));
`, "utf8");
  chmodSync(script, 0o755);
  return script;
}

function fakeTmux(dir: string, statePath: string): string {
  const script = join(dir, "fake-tmux.mjs");
  writeFileSync(script, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
let args = process.argv.slice(2);
if (args[0] === "-S") args = args.slice(2);
function readState() {
  return existsSync(${JSON.stringify(statePath)}) ? JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8")) : {};
}
function writeState(state) {
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
}
if (args[0] === "-V") {
  console.log("tmux fake");
  process.exit(0);
}
if (args[0] === "new-session") {
  const session = args[args.indexOf("-s") + 1];
  writeState({ session, pane: "" });
  process.exit(0);
}
if (args[0] === "pipe-pane") process.exit(0);
if (args[0] === "send-keys") {
  const command = args[args.indexOf("-t") + 2];
  const marker = command.match(/__(?:HOLP_DONE|HOLP_OWNER_VERIFIED)_[A-Za-z0-9_]+__/)?.[0] || "";
  const state = readState();
  state.echo = command;
  state.pane = command + "\\nzcode direct output\\n" + marker + "\\n";
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
if (args[0] === "kill-session") process.exit(0);
process.exit(64);
`, "utf8");
  chmodSync(script, 0o755);
  return script;
}
