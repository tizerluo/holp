import { readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listWorkersCommand, runClientCli, runControllerCommand } from "../../../consumers/harness-workspace/client.js";
import { writeJsonLine } from "../../../consumers/harness-workspace/socketJson.js";
import type { WorkspaceTuiFrameV1 } from "../../../consumers/harness-workspace/tuiFrame.js";

const servers: net.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

describe("harness workspace controller helper", () => {
  it("requires HOLP_HARNESS_BROKER_SOCKET", async () => {
    const previous = process.env.HOLP_HARNESS_BROKER_SOCKET;
    delete process.env.HOLP_HARNESS_BROKER_SOCKET;
    await expect(runControllerCommand({ goal: "x", worker: "fake-agent" })).rejects.toThrow(/HOLP_HARNESS_BROKER_SOCKET/);
    if (previous !== undefined) process.env.HOLP_HARNESS_BROKER_SOCKET = previous;
  });

  it("uses the broker socket protocol and does not instantiate DaemonClient", async () => {
    const source = readFileSync(path.resolve("consumers/harness-workspace/client.ts"), "utf8");
    expect(source).not.toContain("DaemonClient");

    const dir = mkdtempSync(path.join(tmpdir(), "holp-client-test-"));
    const socketPath = path.join(dir, "broker.sock");
    const received: unknown[] = [];
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        received.push(JSON.parse(chunk.toString("utf8")));
        writeJsonLine(socket, { type: "ack", command: "run", run_id: "run_socket" });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const response = await runControllerCommand({
      socketPath,
      goal: "socket goal",
      worker: "fake-agent",
    });

    expect(response).toEqual({ type: "ack", command: "run", run_id: "run_socket" });
    expect(received[0]).toEqual({ type: "run", goal: "socket goal", worker: "fake-agent" });
  });

  it("fails closed for stale or missing broker sockets", async () => {
    const socketPath = path.join(tmpdir(), `missing-holp-broker-${Date.now()}.sock`);
    await expect(runControllerCommand({
      socketPath,
      goal: "x",
      worker: "fake-agent",
      timeoutMs: 100,
    })).rejects.toThrow(/broker socket unavailable|no live broker response/);
  });

  it("fails closed when a socket path exists but has no live listener", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "holp-client-stale-"));
    const socketPath = path.join(dir, "broker.sock");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(runControllerCommand({
      socketPath,
      goal: "x",
      worker: "fake-agent",
      timeoutMs: 100,
    })).rejects.toThrow(/broker socket unavailable|no live broker response/);

    rmSync(socketPath, { force: true });
  });

  it("lists workers from the broker initial WorkspaceTuiFrame.v1 frame", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "holp-client-workers-"));
    const socketPath = path.join(dir, "broker.sock");
    const frame = workerFrame();
    const server = net.createServer((socket) => {
      writeJsonLine(socket, frame);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const response = await listWorkersCommand({ socketPath });

    expect(response.agents.map((agent) => agent.id)).toEqual(["fake-agent"]);
    expect(response.degraded_reasons).toEqual(["worker_session_missing"]);
    expect(response.continuity.owner_verified).toBe("verified");
  });

  it("fails closed when workers initial frame times out", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "holp-client-workers-timeout-"));
    const socketPath = path.join(dir, "broker.sock");
    const server = net.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    await expect(listWorkersCommand({ socketPath, timeoutMs: 50 })).rejects.toThrow(
      /broker socket unavailable: no live broker frame within 50ms/,
    );
  });

  it("fails closed when workers initial frame is malformed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "holp-client-workers-malformed-"));
    const socketPath = path.join(dir, "broker.sock");
    const server = net.createServer((socket) => {
      writeJsonLine(socket, { schema_version: "WorkspaceTuiFrame.v1", agents: "not-an-array" });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    await expect(listWorkersCommand({ socketPath, timeoutMs: 100 })).rejects.toThrow(
      /broker socket unavailable: malformed broker frame/,
    );
  });

  it("prints workers in readable and JSON CLI modes", async () => {
    const previous = process.env.HOLP_HARNESS_BROKER_SOCKET;
    const dir = mkdtempSync(path.join(tmpdir(), "holp-client-workers-cli-"));
    const socketPath = path.join(dir, "broker.sock");
    const frame = workerFrame();
    const server = net.createServer((socket) => {
      writeJsonLine(socket, frame);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    process.env.HOLP_HARNESS_BROKER_SOCKET = socketPath;
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(chunk.toString());
      return true;
    });

    await runClientCli(["workers"]);
    await runClientCli(["workers", "--json"]);

    expect(writes[0]).toContain("- fake-agent selected status=ready role=coder runtime=fake");
    expect(writes[0]).toContain("Degraded: worker_session_missing");
    expect(writes[0]).toContain("Readiness: owner=verified continue=false rerun=true inspect=true replay_only=false reasons=worker_session_missing");
    const json = JSON.parse(writes[1] ?? "") as { agents: Array<{ id: string }>; degraded_reasons: string[] };
    expect(json.agents[0]?.id).toBe("fake-agent");
    expect(json.degraded_reasons).toEqual(["worker_session_missing"]);
    if (previous === undefined) delete process.env.HOLP_HARNESS_BROKER_SOCKET;
    else process.env.HOLP_HARNESS_BROKER_SOCKET = previous;
  });
});

function workerFrame(): WorkspaceTuiFrameV1 {
  return {
    schema_version: "WorkspaceTuiFrame.v1",
    locale: "en-US",
    mode: "overview",
    selected_agent: "fake-agent",
    agents: [{
      id: "fake-agent",
      status: "ready",
      role: "coder",
      role_skin: "CODE",
      runtime_surfaces: [{ runtime_surface: "headless", runtime_kind: "fake" }],
    }],
    timeline: { entries: [] },
    failures: [],
    affordances: [],
    degraded_reasons: ["worker_session_missing"],
    overview: {
      title: "HOLP Harness Workspace",
      chain: [],
      worker_preview: {
        fullText: "",
        renderedText: "",
        truncated: false,
        authoritativeSnapshot: false,
        producer_attribution: "none",
      },
      evidence: {},
    },
    continuity: {
      observed_agent_ids: ["fake-agent"],
      selected_agent_id: "fake-agent",
      owner_verified: "verified",
      can_continue: false,
      can_rerun: true,
      can_inspect: true,
      can_copy: false,
      replay_only: false,
      reasons: ["worker_session_missing"],
    },
  };
}
