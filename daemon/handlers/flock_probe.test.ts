import { describe, expect, it } from "vitest";
import { buildDispatcher } from "../runtime/server.js";
import { ConnectionContext } from "../core/context.js";
import { EventSink } from "../core/eventSink.js";
import { FakeClock } from "../core/clock.js";
import { createAdapterRegistry, createStubFactory } from "../../adapters/registry.js";
import type { JsonRpcResponse } from "../runtime/jsonrpc.js";

describe("flock probe statuses", () => {
  it("flock.declare stores ready/degraded/rejected results from registry probes", async () => {
    const registry = createAdapterRegistry(
      {
        ready: createStubFactory("ready"),
        degraded: createStubFactory("degraded"),
        rejected: createStubFactory("rejected"),
      },
      {
        ready: (input) => ({
          status: "ready",
          version: "ready-test",
          logged_in: true,
          resolved_roles: input.roles,
        }),
        degraded: () => ({
          status: "degraded",
          resolved_roles: [],
          reason: "auth_not_configured",
          missing: ["auth:codex"],
        }),
        rejected: () => ({
          status: "rejected",
          resolved_roles: [],
          reason: "missing_binary_codex",
          missing: ["binary:codex"],
        }),
      },
    );

    const ctx = new ConnectionContext();
    const dispatcher = buildDispatcher(ctx, new EventSink(() => {}), registry, new FakeClock());
    await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocol_version: "0.1.4", client: { name: "probe-test", version: "0" } },
    });

    const result = ok<{ agents: Array<Record<string, unknown>> }>(
      await dispatcher.dispatch({
        jsonrpc: "2.0",
        id: 2,
        method: "flock.declare",
        params: {
          agents: [
            { id: "r", transport: "ready", roles: ["coder"] },
            { id: "d", transport: "degraded", roles: ["coder"] },
            { id: "x", transport: "rejected", roles: ["coder"] },
          ],
        },
      }),
    );

    expect(result.agents.map((agent) => agent.status)).toEqual(["ready", "degraded", "rejected"]);
    expect(ctx.flock.get("r")?.status).toBe("ready");
    expect(ctx.flock.get("d")?.reason).toBe("auth_not_configured");
    expect(ctx.flock.get("x")?.missing).toContain("binary:codex");
  });
});

function ok<T>(res: unknown): T {
  const response = res as JsonRpcResponse;
  if ("error" in response) throw new Error(response.error.message);
  return response.result as T;
}
