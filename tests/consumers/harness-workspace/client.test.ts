import { readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runControllerCommand } from "../../../consumers/harness-workspace/client.js";
import { writeJsonLine } from "../../../consumers/harness-workspace/socketJson.js";

const servers: net.Server[] = [];

afterEach(async () => {
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
});
