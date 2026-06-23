import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import { createAdapterRegistry, createFakeRegistry, createStubFactory } from "./registry.js";
import {
  firstBatchAdapterFactories,
  firstBatchAdapterProbes,
  type FirstBatchHarnessDefinition,
} from "./first-batch-harnesses.js";
import { buildDispatcher } from "../daemon/runtime/server.js";
import { ConnectionContext } from "../daemon/core/context.js";
import { EventSink, type EventNotificationParams } from "../daemon/core/eventSink.js";
import { FakeClock } from "../daemon/core/clock.js";
import type { JsonRpcResponse } from "../daemon/runtime/jsonrpc.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("adapter registry runtime surface resolution", () => {
  it("defaults resolution to headless and treats flat legacy factories as headless-only", () => {
    const flatFactory = createStubFactory("legacy-flat");
    const registry = createAdapterRegistry({
      "legacy-flat": flatFactory,
    });

    expect(registry.hasTransport("legacy-flat")).toBe(true);
    expect(registry.hasTransport("missing")).toBe(false);
    expect(registry.resolve("legacy-flat")).toBe(flatFactory);
    expect(registry.resolve("legacy-flat", "headless")).toBe(flatFactory);
    expect(registry.resolve("legacy-flat", "acp")).toBeUndefined();
    expect(registry.resolve("legacy-flat", "direct_user_session")).toBeUndefined();
  });

  it("resolves per-surface factories without falling back to headless", () => {
    const headlessFactory = createStubFactory("multi");
    const acpFactory = createStubFactory("multi-acp");
    const registry = createAdapterRegistry({
      multi: {
        headless: headlessFactory,
        acp: acpFactory,
      },
    });

    expect(registry.hasTransport("multi")).toBe(true);
    expect(registry.resolve("multi")).toBe(headlessFactory);
    expect(registry.resolve("multi", "headless")).toBe(headlessFactory);
    expect(registry.resolve("multi", "acp")).toBe(acpFactory);
    expect(registry.resolve("multi", "direct_user_session")).toBeUndefined();
  });

  it("reports probe_not_configured when a factory exists without a probe", async () => {
    const registry = createAdapterRegistry({
      wired: createStubFactory("wired"),
    });

    const result = await registry.probe({
      id: "wired",
      transport: "wired",
      roles: ["coder"],
      cwd: process.cwd(),
    });

    expect(result).toMatchObject({
      status: "rejected",
      reason: "probe_not_configured",
    });
    expect(result.runtime_surfaces?.[0].isolation_profiles.coder_worktree.reason)
      .toBe("probe_not_configured");
  });

  it("keeps fake headless declared as streaming controlled", async () => {
    const result = await createFakeRegistry().probe({
      id: "fake",
      transport: "fake",
      roles: ["coder"],
      cwd: process.cwd(),
    });

    const headless = result.runtime_surfaces?.find((surface) =>
      surface.runtime_surface === "headless"
    );
    expect(headless?.runtime_kind).toBe("fake");
    expect(headless?.actual_fidelity).toBe("streaming_controlled");
  });

  it("declares Reasonix ACP degraded with preserved session/new failure reason", async () => {
    const dir = makeTempDir();
    const definition = reasonixDefinition(dir);
    const registry = createAdapterRegistry(
      firstBatchAdapterFactories([definition]),
      firstBatchAdapterProbes([definition]),
    );

    const result = await registry.probe({
      id: "reasonix",
      transport: "reasonix",
      roles: ["coder"],
      cwd: dir,
    });

    const acp = result.runtime_surfaces?.find((surface) => surface.runtime_surface === "acp");
    expect(result.status).toBe("degraded");
    expect(acp?.actual_fidelity).toBe("streaming_controlled");
    expect(acp?.isolation_profiles.coder_worktree).toMatchObject({
      readiness: "degraded",
      reason: expect.stringContaining("reasonix_acp_session_new_failed:acp_rpc_error"),
    });
  });

  it("keeps Reasonix ACP degraded when full terminal prompt succeeds by policy", async () => {
    const dir = makeTempDir();
    const definition = reasonixDefinition(dir, "ok");
    const registry = createAdapterRegistry(
      firstBatchAdapterFactories([definition]),
      firstBatchAdapterProbes([definition]),
    );

    const result = await registry.probe({
      id: "reasonix",
      transport: "reasonix",
      roles: ["coder"],
      cwd: dir,
    });

    const acp = result.runtime_surfaces?.find((surface) => surface.runtime_surface === "acp");
    expect(acp?.isolation_profiles.coder_worktree).toMatchObject({
      readiness: "degraded",
      reason: "reasonix_acp_prompt_terminal_verified_policy_degraded",
    });
  });

  it("requires HOLP_OK in headless smoke output", async () => {
    const dir = makeTempDir();
    const definition: FirstBatchHarnessDefinition = {
      transport: "opencode",
      harnessId: "opencode",
      vendor: "OpenCode",
      probeHeadlessSmoke: true,
      headless: {
        transport: "opencode",
        command: fakeCli(dir, "opencode-no-token", "model replied without token"),
        versionArgs: ["--version"],
        argsForPrompt: (prompt) => ["run", prompt],
      },
      acp: {
        transport: "opencode",
        command: fakeAcp(dir, "ok"),
        requestTimeoutMs: 5_000,
        terminalTimeoutMs: 5_000,
      },
    };
    const registry = createAdapterRegistry(
      firstBatchAdapterFactories([definition]),
      firstBatchAdapterProbes([definition]),
    );

    const result = await registry.probe({
      id: "opencode",
      transport: "opencode",
      roles: ["coder"],
      cwd: dir,
    });

    const headless = result.runtime_surfaces?.find((surface) =>
      surface.runtime_surface === "headless"
    );
    expect(headless?.isolation_profiles.coder_worktree).toMatchObject({
      readiness: "degraded",
      reason: "headless_smoke_not_enabled_or_failed",
    });
  });

  it("declares Kimi direct tmux ready only with HOLP-owned capability metadata", async () => {
    const dir = makeTempDir();
    const definition = kimiDefinition(dir, { directReady: true });
    const registry = createAdapterRegistry(
      firstBatchAdapterFactories([definition]),
      firstBatchAdapterProbes([definition]),
    );

    const result = await registry.probe({
      id: "kimi",
      transport: "kimi-code",
      roles: ["coder"],
      cwd: dir,
    });

    const direct = result.runtime_surfaces?.find((surface) =>
      surface.runtime_surface === "direct_user_session"
    );
    expect(direct?.isolation_profiles.coder_worktree.readiness).toBe("ready");
    expect(direct?.direct_channel).toMatchObject({
      channel_type: "tmux",
      session_origin: "holp_created",
      session_id_namespace: "holp-*",
      owner_scope: "supported",
      capability_bitmask: ["observe", "read", "inject", "interrupt", "cancel", "owner_verified"],
    });
  });

  it("leaves Kimi direct tmux degraded when owner/capability proof is missing", async () => {
    const dir = makeTempDir();
    const definition = kimiDefinition(dir, { directReady: false });
    const registry = createAdapterRegistry(
      firstBatchAdapterFactories([definition]),
      firstBatchAdapterProbes([definition]),
    );

    const result = await registry.probe({
      id: "kimi",
      transport: "kimi-code",
      roles: ["coder"],
      cwd: dir,
    });

    const direct = result.runtime_surfaces?.find((surface) =>
      surface.runtime_surface === "direct_user_session"
    );
    expect(direct?.isolation_profiles.coder_worktree.readiness).toBe("degraded");
    expect(direct?.direct_channel?.owner_scope).toBe("unknown");
    expect(direct?.direct_channel?.capability_bitmask).toEqual([]);
  });

  it("schedules an explicit non-Reasonix ACP runtime without headless fallback", async () => {
    const dir = makeTempDir();
    const definition = opencodeDefinition(dir);
    const registry = createAdapterRegistry(
      firstBatchAdapterFactories([definition]),
      firstBatchAdapterProbes([definition]),
    );
    const ctx = new ConnectionContext();
    const events: EventNotificationParams[] = [];
    const dispatcher = buildDispatcher(
      ctx,
      new EventSink((frame) => {
        const event = frame as { method?: string; params?: unknown };
        if (event.method === "events.event") events.push(event.params as EventNotificationParams);
      }),
      registry,
      new FakeClock(),
    );
    let id = 1;
    const dispatch = (method: string, params: unknown) =>
      dispatcher.dispatch({ jsonrpc: "2.0", id: id++, method, params });

    ok(await dispatch("initialize", {
      protocol_version: "0.1.6",
      client: { name: "registry-test", version: "0" },
      capabilities: { approval: { supported: true, kinds: ["merge_approval"] } },
    }));
    ok(await dispatch("flock.declare", {
      agents: [{ id: "opencode", transport: "opencode", roles: ["coder"] }],
    }));
    const run = ok<{ run_id: string }>(await dispatch("orchestrate.run", {
      goal: "use acp",
      roles: {
        coder: { agent: "opencode", preferred_runtime_surface: "acp" },
      },
    }));
    ok(await dispatch("events.subscribe", { run_id: run.run_id, after_seq: 0 }));
    await pollUntil(() => events.some((event) => event.name === "run_merged"));

    const started = events.find((event) => event.name === "run_started")!;
    const runtime = (started.payload as { runtime: Record<string, unknown> }).runtime;
    expect(runtime.runtime_surface).toBe("acp");
    expect(runtime.actual_fidelity).toBe("streaming_controlled");
  });
});

function opencodeDefinition(dir: string): FirstBatchHarnessDefinition {
  return {
    transport: "opencode",
    harnessId: "opencode",
    vendor: "OpenCode",
    probeAcpSmoke: true,
    headless: {
      transport: "opencode",
      command: fakeCli(dir, "opencode"),
      versionArgs: ["--version"],
      argsForPrompt: (prompt) => ["run", prompt],
    },
    acp: {
      transport: "opencode",
      command: fakeAcp(dir, "ok"),
      requestTimeoutMs: 5_000,
      terminalTimeoutMs: 5_000,
    },
  };
}

function reasonixDefinition(
  dir: string,
  acpMode: "ok" | "session-new-error" = "session-new-error",
): FirstBatchHarnessDefinition {
  return {
    transport: "reasonix",
    harnessId: "reasonix",
    vendor: "Reasonix",
    probeAcpSmoke: true,
    headless: {
      transport: "reasonix",
      command: fakeCli(dir, "reasonix"),
      versionArgs: ["--version"],
      argsForPrompt: (prompt) => ["run", prompt],
    },
    acp: {
      transport: "reasonix",
      command: fakeAcp(dir, acpMode),
      requestTimeoutMs: 5_000,
      terminalTimeoutMs: 5_000,
    },
  };
}

function kimiDefinition(
  dir: string,
  opts: { directReady: boolean },
): FirstBatchHarnessDefinition {
  return {
    transport: "kimi-code",
    harnessId: "kimi-code",
    vendor: "Moonshot AI",
    probeDirectReady: opts.directReady,
    headless: {
      transport: "kimi-code",
      command: fakeCli(dir, "kimi"),
      versionArgs: ["--version"],
      argsForPrompt: (prompt) => ["-p", prompt],
    },
    acp: {
      transport: "kimi-code",
      command: fakeAcp(dir, "ok"),
      requestTimeoutMs: 5_000,
      terminalTimeoutMs: 5_000,
    },
    direct: {
      transport: "kimi-code",
      tmuxCommand: fakeTmux(dir),
      agentCommand: opts.directReady ? fakeCli(dir, "kimi-direct") : join(dir, "missing-kimi"),
      agentArgsForPrompt: (prompt) => ["-p", prompt],
    },
  };
}

function fakeCli(dir: string, name: string, output = "HOLP_OK"): string {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(script, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log(${JSON.stringify(`${name}/fake`)});
  process.exit(0);
}
console.log(${JSON.stringify(output)});
`, "utf8");
  chmodSync(script, 0o755);
  return script;
}

function fakeAcp(dir: string, mode: "ok" | "session-new-error"): string {
  const script = join(dir, `fake-acp-${mode}.mjs`);
  writeFileSync(script, `#!/usr/bin/env node
import readline from "node:readline";
const mode = ${JSON.stringify(mode)};
const rl = readline.createInterface({ input: process.stdin });
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") return send({ id: frame.id, result: { ok: true } });
  if (frame.method === "session/new") {
    if (mode === "session-new-error") {
      send({ id: frame.id, error: { code: -32000, message: "session/new failed" } });
      process.exit(0);
    }
    return send({ id: frame.id, result: { sessionId: "s1" } });
  }
  if (frame.method === "session/prompt") {
    const prompt = Array.isArray(frame.params.prompt)
      ? frame.params.prompt.map((block) => block.text || "").join("")
      : frame.params.prompt;
    send({ id: frame.id, result: { accepted: true } });
    send({ method: "session/update", params: { sessionId: "s1", finalText: "done:" + prompt, type: "completed" } });
  }
});
`, "utf8");
  chmodSync(script, 0o755);
  return script;
}

function fakeTmux(dir: string): string {
  const script = join(dir, "fake-tmux.mjs");
  const statePath = join(dir, "fake-tmux-state.json");
  writeFileSync(script, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(statePath)};
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
  writeState({ session, pane: "" });
  process.exit(0);
}
if (args[0] === "send-keys") {
  const command = args[args.indexOf("-t") + 2];
  const marker = command.match(/__HOLP_OWNER_VERIFIED_[A-Za-z0-9_]+__/)?.[0] || "";
  const state = readState();
  state.pane = marker;
  writeState(state);
  process.exit(0);
}
if (args[0] === "capture-pane") {
  process.stdout.write(readState().pane || "");
  process.exit(0);
}
if (args[0] === "kill-session") process.exit(0);
process.exit(0);
`, "utf8");
  chmodSync(script, 0o755);
  return script;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "holp-registry-test-"));
  tempDirs.push(dir);
  return dir;
}

function ok<T>(res: unknown): T {
  const response = res as JsonRpcResponse;
  if ("error" in response) throw new Error(response.error.message);
  return response.result as T;
}

async function pollUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("predicate not satisfied");
}
