import { describe, expect, it } from "vitest";
import { buildDispatcher } from "../runtime/server.js";
import { ConnectionContext } from "../core/context.js";
import { EventSink } from "../core/eventSink.js";
import { FakeClock } from "../core/clock.js";
import { createAdapterRegistry, createStubFactory } from "../../adapters/registry.js";
import type { JsonRpcResponse } from "../runtime/jsonrpc.js";
import { rejectedProfiles, withProfile } from "../../adapters/harness-declaration.js";
import type { AgentProbeInput } from "../../adapters/agent-backend.js";

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
          runtime_surfaces: [
            {
              runtime_surface: "headless",
              runtime_kind: "test-ready",
              surface_support: "supported",
              isolation_profiles: withProfile(
                rejectedProfiles("unsupported_isolation_profile"),
                "coder_worktree",
                { readiness: "ready" },
              ),
              state_declaration_ref: "harness-state:test-ready",
              global_mutation_required: false,
              declared_not_enforced: true,
            },
          ],
        }),
        degraded: () => ({
          status: "degraded",
          resolved_roles: [],
          reason: "auth_not_configured",
          missing: ["auth:codex"],
          runtime_surfaces: [
            {
              runtime_surface: "headless",
              runtime_kind: "test-degraded",
              surface_support: "supported",
              isolation_profiles: withProfile(
                rejectedProfiles("unsupported_isolation_profile"),
                "coder_worktree",
                {
                  readiness: "degraded",
                  reason: "auth_not_configured",
                  missing: ["auth:codex"],
                  warnings: ["declared_not_enforced"],
                },
              ),
              state_declaration_ref: "harness-state:test-degraded",
              global_mutation_required: false,
              declared_not_enforced: true,
            },
          ],
        }),
        rejected: () => ({
          status: "rejected",
          resolved_roles: [],
          reason: "missing_binary_codex",
          missing: ["binary:codex"],
          runtime_surfaces: [
            {
              runtime_surface: "headless",
              runtime_kind: "test-rejected",
              surface_support: "unsupported",
              isolation_profiles: rejectedProfiles("missing_binary_codex", ["binary:codex"]),
              state_declaration_ref: "harness-state:test-rejected",
              global_mutation_required: false,
              declared_not_enforced: true,
            },
          ],
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
    for (const agent of result.agents) {
      expect(Array.isArray(agent.runtime_surfaces)).toBe(true);
      expect((agent.runtime_surfaces as unknown[]).length).toBeGreaterThan(0);
    }
    expect(ctx.flock.get("r")?.status).toBe("ready");
    expect(ctx.flock.get("r")?.runtime_surfaces?.[0].isolation_profiles.coder_worktree.readiness).toBe("ready");
    expect(ctx.flock.get("d")?.reason).toBe("auth_not_configured");
    expect(ctx.flock.get("x")?.missing).toContain("binary:codex");
  });

  it("flock.discover probe:false returns an explicit not_probed runtime matrix", async () => {
    const registry = createAdapterRegistry({
      fake: createStubFactory("fake"),
    });
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
        method: "flock.discover",
        params: { transports: ["fake"], probe: false },
      }),
    );

    expect(result.agents).toHaveLength(1);
    const surfaces = result.agents[0].runtime_surfaces as Array<Record<string, unknown>>;
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0].runtime_kind).toBe("not_probed");
    expect(ctx.flock.get("fake-agent")?.runtime_surfaces?.[0].isolation_profiles.coder_worktree.reason).toBe("not_probed");
  });

  it("passes runtime and isolation routing hints into declare/discover probes", async () => {
    const seen: AgentProbeInput[] = [];
    const registry = createAdapterRegistry(
      {
        route: createStubFactory("route"),
      },
      {
        route: (input) => {
          seen.push(input);
          return {
            status: "ready",
            resolved_roles: input.roles,
            runtime_surfaces: [
              {
                runtime_surface: "headless",
                runtime_kind: "route-test",
                surface_support: "supported",
                isolation_profiles: withProfile(
                  rejectedProfiles("unsupported_isolation_profile"),
                  input.isolationProfile ?? "coder_worktree",
                  { readiness: "ready" },
                ),
                state_declaration_ref: `harness-state:${input.id}`,
                global_mutation_required: false,
                declared_not_enforced: true,
              },
            ],
          };
        },
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

    ok(await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "flock.declare",
      params: { agents: [{ id: "declared", transport: "route", roles: ["reviewer"] }] },
    }));
    ok(await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "flock.discover",
      params: { transports: ["route"], probe: true },
    }));

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      id: "declared",
      transport: "route",
      runtimeSurface: "headless",
      isolationProfile: "read_only_review",
      runIntent: "flock.declare",
      workspaceId: process.cwd(),
      sessionRouteKey: "declared",
    });
    expect(seen[1]).toMatchObject({
      id: "route-agent",
      transport: "route",
      runtimeSurface: "headless",
      isolationProfile: "coder_worktree",
      runIntent: "flock.discover",
      workspaceId: process.cwd(),
      sessionRouteKey: "route-agent",
    });
  });
});

function ok<T>(res: unknown): T {
  const response = res as JsonRpcResponse;
  if ("error" in response) throw new Error(response.error.message);
  return response.result as T;
}
