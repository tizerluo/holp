import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessWorkspaceBroker, runBrokerCli, type HarnessWorkspaceBrokerOptions } from "../../../consumers/harness-workspace/broker.js";
import { runControllerCommand } from "../../../consumers/harness-workspace/client.js";
import { attachJsonLineSocket, writeJsonLine } from "../../../consumers/harness-workspace/socketJson.js";
import { isWorkspaceTuiFrameV1, type WorkspaceTuiFrameV1 } from "../../../consumers/harness-workspace/tuiFrame.js";
import type { EventFrame } from "../../../consumers/cli/wire.js";
import type { DiscoveredAgent } from "../../../consumers/harness-workspace/types.js";

const brokers: HarnessWorkspaceBroker[] = [];

afterEach(async () => {
  await Promise.all(brokers.map((broker) => broker.close()));
  brokers.length = 0;
});

describe("harness workspace broker", () => {
  it("creates a per-session 0700 socket directory and owns one daemon client", async () => {
    let daemonCount = 0;
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-unit-")),
      sessionId: "session-unit",
      transport: "fake",
      daemonFactory: () => {
        daemonCount += 1;
        return fakeDaemon();
      },
    });
    brokers.push(broker);

    await broker.start();

    expect(daemonCount).toBe(1);
    expect(broker.socketPath).toBe(path.join(broker.sessionDir, "broker.sock"));
    expect(statSync(broker.sessionDir).mode & 0o777).toBe(0o700);
    expect(broker.frame()).toMatchObject({
      schema_version: "WorkspaceTuiFrame.v1",
      locale: "en-US",
      selected_agent: "fake-agent",
    });
  });

  it("passes explicit and environment locale into WorkspaceTuiFrame.v1", async () => {
    const explicit = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-locale-")),
      transport: "fake",
      locale: "zh-CN",
      daemonFactory: () => fakeDaemon(),
    });
    brokers.push(explicit);
    await explicit.start();
    expect(explicit.frame().locale).toBe("zh-CN");

    const fromEnv = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-locale-env-")),
      transport: "fake",
      env: { HOLP_HARNESS_LOCALE: "zh-CN" },
      daemonFactory: () => fakeDaemon(),
    });
    brokers.push(fromEnv);
    await fromEnv.start();
    expect(fromEnv.frame().locale).toBe("zh-CN");
  });

  it("fails closed for unsupported environment locale", () => {
    expect(() => new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-bad-locale-")),
      env: { HOLP_HARNESS_LOCALE: "fr-FR" },
      daemonFactory: () => fakeDaemon(),
    })).toThrow(/unsupported HOLP_HARNESS_LOCALE/);
  });

  it("fails closed for unsupported CLI locale before starting a broker", async () => {
    await expect(runBrokerCli(["--locale", "fr-FR"])).rejects.toThrow(/unsupported --locale/);
  });

  it("adopts a pre-existing launcher session directory without an existing socket", async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "holp-broker-adopt-"));
    const sessionDir = path.join(baseDir, "session-adopted");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, "cmux-surfaces.json"), "{}\n", "utf8");
    const broker = new HarnessWorkspaceBroker({
      baseDir,
      sessionId: "session-adopted",
      transport: "fake",
      daemonFactory: () => fakeDaemon(),
    });
    brokers.push(broker);

    await broker.start();

    expect(broker.socketPath).toBe(path.join(sessionDir, "broker.sock"));
    expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
  });

  it("rejects a pre-existing broker socket instead of reusing a stale or live session", async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "holp-broker-stale-"));
    const sessionDir = path.join(baseDir, "session-stale");
    mkdirSync(sessionDir, { recursive: true });
    closeSync(openSync(path.join(sessionDir, "broker.sock"), "w"));
    const broker = new HarnessWorkspaceBroker({
      baseDir,
      sessionId: "session-stale",
      transport: "fake",
      daemonFactory: () => fakeDaemon(),
    });

    await expect(broker.start()).rejects.toThrow(/broker socket already exists/);
    await broker.close();
  });

  it("fails closed on malformed commands and unsupported workers", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-unit-")),
      transport: "fake",
      daemonFactory: () => fakeDaemon({ calls }),
    });
    brokers.push(broker);
    await broker.start();

    await expect(broker.handleCommand({ type: "run", goal: "x", worker: "missing" })).resolves.toMatchObject({
      type: "error",
      message: "unsupported worker 'missing'",
    });
    await expect(broker.handleCommand({ nope: true })).resolves.toMatchObject({
      type: "error",
      message: "malformed broker command",
    });
    const callsBeforeStatus = calls.length;
    await expect(broker.handleCommand({ type: "status" })).resolves.toMatchObject({
      type: "error",
      message: "malformed broker command",
    });
    expect(calls).toHaveLength(callsBeforeStatus);
  });

  it("pushes WorkspaceTuiFrame.v1 frames over newline-delimited JSON", async () => {
    const daemon = fakeDaemon();
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-unit-")),
      transport: "fake",
      daemonFactory: () => daemon,
    });
    brokers.push(broker);
    await broker.start();

    const socket = net.createConnection(broker.socketPath);
    const frames: WorkspaceTuiFrameV1[] = [];
    attachJsonLineSocket(socket, {
      onMessage: (message) => {
        if (isWorkspaceTuiFrameV1(message)) frames.push(message);
      },
    });
    await onceConnect(socket);
    writeJsonLine(socket, { type: "follow", agent: "fake-agent" });
    await waitFor(() => frames.some((frame) => frame.mode === "inspect"));
    socket.destroy();

    expect(frames[0]?.schema_version).toBe("WorkspaceTuiFrame.v1");
    expect(frames.some((frame) => frame.selected_agent === "fake-agent")).toBe(true);
  });

  it("returns a broker error response when daemon run command rejects", async () => {
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-unit-")),
      transport: "fake",
      daemonFactory: () => fakeDaemon({ failRun: true }),
    });
    brokers.push(broker);
    await broker.start();

    await expect(runControllerCommand({
      socketPath: broker.socketPath,
      goal: "x",
      worker: "fake-agent",
      timeoutMs: 1000,
    })).rejects.toThrow(/orchestrate failed/);
  });

  it("selects a deterministic usable worker for --worker auto and records it in broker state", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-auto-")),
      transport: "mcp-codex",
      daemonFactory: () => fakeDaemon({
        calls,
        agents: [
          agent("z-headless", "native-headless"),
          agent("b-worker", "native-direct"),
          agent("a-worker", "native-direct"),
          agent("fake-agent", "fake"),
        ],
      }),
    });
    brokers.push(broker);
    await broker.start();

    await expect(broker.handleCommand({ type: "run", goal: "x", worker: "auto" })).resolves.toMatchObject({
      type: "ack",
      command: "run",
      worker: "a-worker",
    });

    expect(calls.find((call) => call.method === "orchestrate.run")?.params).toMatchObject({
      roles: { coder: { agent: "a-worker", preferred_runtime_surface: "direct_user_session" } },
    });
    expect(broker.frame().selected_agent).toBe("a-worker");
  });

  it("fails closed when auto has no usable real direct worker", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-auto-none-")),
      transport: "mcp-codex",
      daemonFactory: () => fakeDaemon({
        calls,
        agents: [
          agent("fake-agent", "fake"),
          agent("headless-worker", "native-headless"),
          agent("direct-worker", "direct-unsupported"),
          agent("degraded-worker", "direct-degraded"),
          agent("no-owner-worker", "direct-no-owner"),
        ],
      }),
    });
    brokers.push(broker);
    await broker.start();

    await expect(broker.handleCommand({ type: "run", goal: "x", worker: "auto" })).resolves.toMatchObject({
      type: "error",
      command: "run",
      message: expect.stringContaining("no usable direct_user_session worker"),
    });
    expect(calls.some((call) => call.method === "orchestrate.run")).toBe(false);
  });

  it("fails closed for explicit fake, headless, unsupported, degraded, or unverified direct workers in real mode", async () => {
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-real-workers-")),
      transport: "mcp-codex",
      daemonFactory: () => fakeDaemon({
        agents: [
          agent("fake-agent", "fake"),
          agent("headless-worker", "native-headless"),
          agent("direct-worker", "direct-unsupported"),
          agent("degraded-worker", "direct-degraded"),
          agent("no-owner-worker", "direct-no-owner"),
        ],
      }),
    });
    brokers.push(broker);
    await broker.start();

    await expect(broker.handleCommand({ type: "run", goal: "x", worker: "fake-agent" })).resolves.toMatchObject({
      type: "error",
      message: expect.stringContaining("fake/demo-only"),
    });
    await expect(broker.handleCommand({ type: "run", goal: "x", worker: "headless-worker" })).resolves.toMatchObject({
      type: "error",
      message: expect.stringContaining("direct_user_session"),
    });
    await expect(broker.handleCommand({ type: "run", goal: "x", worker: "direct-worker" })).resolves.toMatchObject({
      type: "error",
      message: expect.stringContaining("not usable"),
    });
    await expect(broker.handleCommand({ type: "run", goal: "x", worker: "degraded-worker" })).resolves.toMatchObject({
      type: "error",
      message: expect.stringContaining("direct_user_session surface is not ready"),
    });
    await expect(broker.handleCommand({ type: "run", goal: "x", worker: "no-owner-worker" })).resolves.toMatchObject({
      type: "error",
      message: expect.stringContaining("owner_verified proof is missing"),
    });
  });

  it("sends preferred direct_user_session for an explicit real direct worker", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-explicit-direct-")),
      transport: "mcp-codex",
      daemonFactory: () => fakeDaemon({
        calls,
        agents: [agent("direct-worker", "native-direct")],
      }),
    });
    brokers.push(broker);
    await broker.start();

    await expect(broker.handleCommand({ type: "run", goal: "x", worker: "direct-worker" })).resolves.toMatchObject({
      type: "ack",
      command: "run",
      worker: "direct-worker",
    });
    expect(calls.find((call) => call.method === "orchestrate.run")?.params).toMatchObject({
      roles: { coder: { agent: "direct-worker", preferred_runtime_surface: "direct_user_session" } },
    });
  });

  it("resolves a pending merge approval through approval.resolve", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const daemon = fakeDaemon({ calls });
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-approval-")),
      transport: "fake",
      daemonFactory: () => daemon,
    });
    brokers.push(broker);
    await broker.start();
    daemon.emit(approvalEvent(1, "ap_merge", "merge_approval"));

    await expect(broker.handleCommand({ type: "approve", decision: "approved", reason: "looks safe" })).resolves.toEqual({
      type: "ack",
      command: "approve",
      approval_id: "ap_merge",
    });
    expect(calls.find((call) => call.method === "approval.resolve")?.params).toMatchObject({
      approval_id: "ap_merge",
      decision: "approved",
      by: "user:harness-workspace",
      reason: "looks safe",
    });
  });

  it("resolves semantic approval only when broker state can provide audit fields", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const daemon = fakeDaemon({ calls });
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-semantic-")),
      transport: "fake",
      daemonFactory: () => daemon,
    });
    brokers.push(broker);
    await broker.start();
    daemon.emit({
      run_id: "run_fake",
      seq: 1,
      category: "gate",
      name: "gate_report",
      payload: {
        decision_surface: { review_outcome: "reject", gate_disposition: "waiting_approval" },
        artifact_refs: ["art_gate"],
      },
    });
    daemon.emit(approvalEvent(2, "ap_semantic", "semantic_decision", { provenance: { artifact_id: "art_semantic" } }));

    await expect(broker.handleCommand({ type: "approve", decision: "approved", reason: "accepted risk" })).resolves.toEqual({
      type: "ack",
      command: "approve",
      approval_id: "ap_semantic",
    });
    expect(calls.find((call) => call.method === "approval.resolve")?.params).toMatchObject({
      approval_id: "ap_semantic",
      decision: "approved",
      by: "user:harness-workspace",
      reason: "accepted risk",
      previous_gate_outcome: "reject",
      new_gate_outcome: "approved",
      artifact_refs: ["art_gate", "art_semantic"],
    });
  });

  it("degrades semantic approval readably when audit fields are unavailable", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const daemon = fakeDaemon({ calls });
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-semantic-missing-")),
      transport: "fake",
      daemonFactory: () => daemon,
    });
    brokers.push(broker);
    await broker.start();
    daemon.emit(approvalEvent(1, "ap_semantic", "semantic_decision"));

    await expect(broker.handleCommand({ type: "approve", decision: "rejected", reason: "not enough evidence" })).resolves.toMatchObject({
      type: "error",
      command: "approve",
      message: expect.stringContaining("previous_gate_outcome is unavailable"),
    });
    expect(calls.some((call) => call.method === "approval.resolve")).toBe(false);
  });

  it("fails closed when approve has no current pending approval", async () => {
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-no-approval-")),
      transport: "fake",
      daemonFactory: () => fakeDaemon(),
    });
    brokers.push(broker);
    await broker.start();

    await expect(broker.handleCommand({ type: "approve", decision: "approved", reason: "ok" })).resolves.toMatchObject({
      type: "error",
      command: "approve",
      message: "no current pending approval",
    });
  });

  it("serializes replay writes and leaves a valid replay snapshot after event bursts", async () => {
    const daemon = fakeDaemon();
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-unit-")),
      transport: "fake",
      daemonFactory: () => daemon,
    });
    brokers.push(broker);
    await broker.start();

    for (let seq = 1; seq <= 40; seq += 1) {
      daemon.emit({ run_id: "run_burst", seq, category: "agent", name: "model_output", payload: { text_delta: `x${seq}` } });
    }

    await waitFor(() => {
      const json = readFileSync(broker.replayPath, "utf8");
      const parsed = JSON.parse(json) as { events?: readonly unknown[] };
      const tmpFiles = readdirSync(broker.sessionDir).filter((name) => name.endsWith(".tmp"));
      return parsed.events?.length === 40 && tmpFiles.length === 0;
    });
    expect(readdirSync(broker.sessionDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("drives live broker to real daemon under fake registry and projects public-wire events", async () => {
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-live-")),
      transport: "fake",
      env: { ...process.env, HOLP_REGISTRY: "fake" },
    });
    brokers.push(broker);
    await broker.start();

    const response = await runControllerCommand({
      socketPath: broker.socketPath,
      goal: "PR87 integration: produce a deterministic fake run event stream.",
      worker: "fake-agent",
      timeoutMs: 10_000,
    });

    expect(response).toMatchObject({ type: "ack", command: "run" });
    await waitFor(() => broker.frame().timeline.entries.length > 0);
    const projected = broker.frame();
    expect(projected.schema_version).toBe("WorkspaceTuiFrame.v1");
    expect(projected.run_id).toMatch(/^run_/);
    expect(projected.timeline.entries.map((entry) => entry.label)).toContain("run.run_started#1");
    expect(projected.agents.map((agent) => agent.id)).toContain("fake-agent");
  }, 30_000);
});

function fakeDaemon(options: {
  readonly failRun?: boolean;
  readonly agents?: readonly DiscoveredAgent[];
  readonly calls?: Array<{ method: string; params: unknown }>;
} = {}) {
  const listeners: Array<(event: EventFrame) => void> = [];
  return {
    async call(method: string, params?: unknown) {
      options.calls?.push({ method, params });
      if (method === "initialize") {
        return { protocol_version: "0.1.4", clientName: "broker-test" };
      }
      if (method === "flock.discover") {
        return {
          agents: options.agents ?? [agent("fake-agent", "fake")],
        };
      }
      if (method === "orchestrate.run") {
        if (options.failRun) throw new Error("orchestrate failed");
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({ run_id: "run_fake", seq: 1, category: "run", name: "run_started", payload: {} });
          }
        });
        return { run_id: "run_fake", accepted: true };
      }
      if (method === "approval.resolve") {
        return { approval_id: "ap_fake", accepted: true };
      }
      return {};
    },
    onEvent(listener: (event: EventFrame) => void) {
      listeners.push(listener);
      return () => undefined;
    },
    emit(event: EventFrame) {
      for (const listener of listeners) listener(event);
    },
    async close() {
      return undefined;
    },
  } satisfies NonNullable<HarnessWorkspaceBrokerOptions["daemonFactory"]> extends () => infer T ? T : never;
}

function agent(id: string, kind: "fake" | "native-headless" | "native-direct" | "direct-unsupported" | "direct-degraded" | "direct-no-owner" | "stub"): DiscoveredAgent {
  if (kind === "native-direct") {
    return {
      id,
      status: "ready",
      role: "coder",
      runtime_surfaces: [{
        runtime_surface: "direct_user_session",
        runtime_kind: "native-direct",
        surface_support: "supported",
        isolation_profiles: { coder_worktree: { readiness: "ready" } },
        direct_channel: { capability_bitmask: ["cancel", "owner_verified"] },
      }],
    };
  }
  if (kind === "direct-degraded") {
    return {
      id,
      status: "ready",
      role: "coder",
      runtime_surfaces: [{
        runtime_surface: "direct_user_session",
        runtime_kind: "native-direct",
        surface_support: "supported",
        isolation_profiles: { coder_worktree: { readiness: "degraded" } },
        direct_channel: { capability_bitmask: ["cancel", "owner_verified"] },
      }],
    };
  }
  if (kind === "direct-no-owner") {
    return {
      id,
      status: "ready",
      role: "coder",
      runtime_surfaces: [{
        runtime_surface: "direct_user_session",
        runtime_kind: "native-direct",
        surface_support: "supported",
        isolation_profiles: { coder_worktree: { readiness: "ready" } },
        direct_channel: { capability_bitmask: ["cancel"] },
      }],
    };
  }
  if (kind === "direct-unsupported") {
    return {
      id,
      status: "ready",
      role: "coder",
      runtime_surfaces: [{
        runtime_surface: "direct_user_session",
        runtime_kind: "native-direct",
        surface_support: "unsupported",
      }],
    };
  }
  if (kind === "native-headless") {
    return {
      id,
      status: "ready",
      role: "coder",
      runtime_surfaces: [{
        runtime_surface: "headless",
        runtime_kind: "native",
        surface_support: "supported",
        direct_channel: { capability_bitmask: ["cancel", "owner_verified"] },
      }],
    };
  }
  if (kind === "stub") {
    return {
      id,
      status: "ready",
      role: "coder",
      runtime_surfaces: [{
        runtime_surface: "headless",
        runtime_kind: "stub",
        surface_support: "unsupported",
      }],
    };
  }
  return {
    id,
    status: "ready",
    role: "coder",
    runtime_surfaces: [{
      runtime_surface: "headless",
      runtime_kind: "fake",
      surface_support: "supported",
      state_declaration_ref: "harness-state:fake",
      direct_channel: { capability_bitmask: ["cancel", "owner_verified"] },
    }],
  };
}

function approvalEvent(seq: number, approvalId: string, kind: string, extra: Record<string, unknown> = {}): EventFrame {
  return {
    run_id: "run_fake",
    seq,
    category: "approval",
    name: "approval_requested",
    payload: { approval_id: approvalId, kind, ...extra },
  };
}

function onceConnect(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
