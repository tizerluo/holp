import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessWorkspaceBroker, type HarnessWorkspaceBrokerOptions } from "../../../consumers/harness-workspace/broker.js";
import { runControllerCommand } from "../../../consumers/harness-workspace/client.js";
import { attachJsonLineSocket, writeJsonLine } from "../../../consumers/harness-workspace/socketJson.js";
import { isWorkspaceTuiFrameV1, type WorkspaceTuiFrameV1 } from "../../../consumers/harness-workspace/tuiFrame.js";
import type { EventFrame } from "../../../consumers/cli/wire.js";

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
      selected_agent: "fake-agent",
    });
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
    const broker = new HarnessWorkspaceBroker({
      baseDir: mkdtempSync(path.join(tmpdir(), "holp-broker-unit-")),
      transport: "fake",
      daemonFactory: () => fakeDaemon(),
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

function fakeDaemon(options: { readonly failRun?: boolean } = {}) {
  const listeners: Array<(event: EventFrame) => void> = [];
  return {
    async call(method: string) {
      if (method === "initialize") {
        return { protocol_version: "0.1.4", clientName: "broker-test" };
      }
      if (method === "flock.discover") {
        return {
          agents: [{
            id: "fake-agent",
            status: "ready",
            role: "coder",
            runtime_surfaces: [{
              runtime_surface: "headless",
              runtime_kind: "fake",
              direct_channel: { capability_bitmask: ["cancel", "owner_verified"] },
            }],
          }],
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
