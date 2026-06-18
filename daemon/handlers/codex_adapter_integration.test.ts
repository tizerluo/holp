import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexAppServerBackendFactory } from "../../adapters/codex-app-server.js";
import { createAdapterRegistry } from "../../adapters/registry.js";
import { FakeClock } from "../core/clock.js";
import { ConnectionContext } from "../core/context.js";
import { EventSink, type EventNotificationParams } from "../core/eventSink.js";
import type { JsonRpcResponse } from "../runtime/jsonrpc.js";
import { buildDispatcher } from "../runtime/server.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Codex adapter dispatcher integration", () => {
  it("rejected command approval from mcp-codex emits run_blocked, not run_merged", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-codex-command-approval.cjs");
    writeFileSync(serverPath, fakeCommandApprovalAppServerScript(), "utf8");

    const registry = createAdapterRegistry(
      {
        "mcp-codex": createCodexAppServerBackendFactory({
          command: process.execPath,
          args: [serverPath],
        }),
      },
      {
        "mcp-codex": (input) => ({
          status: "ready",
          version: "fake-codex-app-server",
          logged_in: true,
          resolved_roles: input.roles,
        }),
      },
    );
    const ctx = new ConnectionContext();
    const events: EventNotificationParams[] = [];
    const sink = new EventSink((frame) => {
      const f = frame as { method?: string; params?: unknown };
      if (f.method === "events.event") events.push(f.params as EventNotificationParams);
    });
    const dispatcher = buildDispatcher(ctx, sink, registry, new FakeClock());
    let id = 1;
    const dispatch = async (method: string, params: unknown): Promise<unknown> =>
      dispatcher.dispatch({ jsonrpc: "2.0", id: id++, method, params });

    ok(
      await dispatch("initialize", {
        protocol_version: "0.1.4",
        client: { name: "codex-integration-test", version: "0" },
        capabilities: { approval: { supported: true, kinds: ["merge_approval"] } },
      }),
    );
    ok(await dispatch("flock.declare", { agents: [{ id: "codex-agent", transport: "mcp-codex", roles: ["coder"] }] }));
    const { run_id } = ok<{ run_id: string }>(
      await dispatch("orchestrate.run", { goal: "needs command approval", roles: { coder: { agent: "codex-agent" } } }),
    );
    ok(await dispatch("events.subscribe", { run_id, after_seq: 0 }));

    await pollUntil(() => events.some((event) => event.name === "approval_requested"));
    const approvalId = (events.find((event) => event.name === "approval_requested")?.payload as Record<string, unknown>)
      .approval_id as string;

    ok(await dispatch("approval.resolve", { approval_id: approvalId, decision: "rejected", by: "user:test" }));

    await pollUntil(() =>
      events.some((event) => event.name === "run_blocked" || event.name === "run_merged" || event.name === "run_gave_up"),
    );
    const names = events.map((event) => event.name);
    expect(names).toContain("run_blocked");
    expect(names).not.toContain("run_merged");
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "holp-codex-dispatcher-"));
  tempDirs.push(dir);
  return dir;
}

function ok<T>(res: unknown): T {
  const response = res as JsonRpcResponse;
  if ("error" in response) throw new Error(response.error.message);
  return response.result as T;
}

async function pollUntil(predicate: () => boolean, maxTicks = 400): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}

function fakeCommandApprovalAppServerScript(): string {
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
      params: { itemId: "cmd-1", command: "printf denied", reason: "command needs approval" }
    });
    return;
  }
  if (frame.id === "approval-1") {
    if (!frame.result || frame.result.decision !== "decline") process.exit(2);
  }
});
`;
}
