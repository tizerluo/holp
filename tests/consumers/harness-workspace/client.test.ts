import { readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listWorkersCommand, REFRESH_TIMEOUT_MS, refreshWorkersCommand, runClientCli, runControllerCommand, RUN_TIMEOUT_MS } from "../../../consumers/harness-workspace/client.js";
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

  it("sends refresh_workers over the broker socket with a refresh-safe timeout", async () => {
    expect(REFRESH_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
    expect(RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(40_000);
    const source = readFileSync(path.resolve("consumers/harness-workspace/client.ts"), "utf8");
    expect(source).toContain("options.timeoutMs ?? REFRESH_TIMEOUT_MS");
    expect(source).toContain("options.timeoutMs ?? RUN_TIMEOUT_MS");

    const dir = mkdtempSync(path.join(tmpdir(), "holp-client-refresh-"));
    const socketPath = path.join(dir, "broker.sock");
    const received: unknown[] = [];
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        received.push(JSON.parse(chunk.toString("utf8")));
        writeJsonLine(socket, { type: "ack", command: "refresh_workers" });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    await expect(refreshWorkersCommand({ socketPath })).resolves.toEqual({ type: "ack", command: "refresh_workers" });
    expect(received).toEqual([{ type: "refresh_workers" }]);
  });

  it("prints non-json refresh errors to stderr and exits non-zero", async () => {
    const previous = process.env.HOLP_HARNESS_BROKER_SOCKET;
    const dir = mkdtempSync(path.join(tmpdir(), "holp-client-refresh-error-"));
    const socketPath = path.join(dir, "broker.sock");
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        writeJsonLine(socket, {
          type: "error",
          command: "refresh_workers",
          message: "worker refresh failed: discover timed out",
        });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    process.env.HOLP_HARNESS_BROKER_SOCKET = socketPath;
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdoutWrites.push(chunk.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrWrites.push(chunk.toString());
      return true;
    });

    try {
      await expect(runClientCli(["refresh-workers"])).resolves.toBe(1);
      expect(stdoutWrites).toEqual([]);
      expect(stderrWrites).toEqual(["worker refresh failed: discover timed out\n"]);
    } finally {
      if (previous === undefined) delete process.env.HOLP_HARNESS_BROKER_SOCKET;
      else process.env.HOLP_HARNESS_BROKER_SOCKET = previous;
    }
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

  it("prints status from the broker initial frame without sending a status command", async () => {
    const previous = process.env.HOLP_HARNESS_BROKER_SOCKET;
    const dir = mkdtempSync(path.join(tmpdir(), "holp-client-status-cli-"));
    const socketPath = path.join(dir, "broker.sock");
    const received: unknown[] = [];
    const frame: WorkspaceTuiFrameV1 = {
      ...workerFrame(),
      run_id: "run_status",
      selected_agent: "fake-agent",
      worker_session: "holp-worker",
      attach_command: "tmux attach -t holp-worker",
      approval: { state: "requested", approval_id: "ap_1" },
      terminal: { state: "blocked", reason: "needs approval" },
      failures: ["gate blocked"],
    };
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        received.push(JSON.parse(chunk.toString("utf8")));
      });
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

    await runClientCli(["status"]);
    await runClientCli(["status", "--json"]);

    expect(received).toEqual([]);
    expect(writes[0]).toContain("Run: run_status");
    expect(writes[0]).toContain("Approval: state=requested approval_id=ap_1");
    expect(writes[0]).toContain("Terminal: state=blocked reason=needs approval");
    expect(writes[0]).toContain("Next action: explain pending approval ap_1");
    const json = JSON.parse(writes[1] ?? "") as { run_id: string; next_action: string };
    expect(json.run_id).toBe("run_status");
    expect(json.next_action).toContain("pending approval");
    if (previous === undefined) delete process.env.HOLP_HARNESS_BROKER_SOCKET;
    else process.env.HOLP_HARNESS_BROKER_SOCKET = previous;
  });

  it("CLI parses run --worker auto, refresh-workers, and approve commands", async () => {
    const previous = process.env.HOLP_HARNESS_BROKER_SOCKET;
    const dir = mkdtempSync(path.join(tmpdir(), "holp-client-commands-"));
    const socketPath = path.join(dir, "broker.sock");
    const received: unknown[] = [];
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        const command = JSON.parse(chunk.toString("utf8")) as { type: string };
        received.push(command);
        writeJsonLine(socket, command.type === "approve"
          ? { type: "ack", command: "approve", approval_id: "ap_1" }
          : command.type === "refresh_workers"
            ? { type: "ack", command: "refresh_workers" }
            : { type: "ack", command: "run", run_id: "run_auto", worker: "coder-1" });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    process.env.HOLP_HARNESS_BROKER_SOCKET = socketPath;
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(chunk.toString());
      return true;
    });

    await runClientCli(["run", "--goal", "ship it", "--worker", "auto"]);
    await runClientCli(["refresh-workers", "--json"]);
    await runClientCli(["approve", "--decision", "rejected", "--reason", "needs more evidence"]);

    expect(received).toEqual([
      { type: "run", goal: "ship it", worker: "auto" },
      { type: "refresh_workers" },
      { type: "approve", decision: "rejected", reason: "needs more evidence" },
    ]);
    expect(writes[0]).toContain('"worker":"coder-1"');
    expect(writes[1]).toContain('"command":"refresh_workers"');
    expect(writes[2]).toContain('"approval_id":"ap_1"');
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
