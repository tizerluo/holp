import { describe, expect, it } from "vitest";
import { buildDispatcher } from "../runtime/server.js";
import { ConnectionContext } from "../core/context.js";
import { EventSink } from "../core/eventSink.js";
import { FakeClock } from "../core/clock.js";
import { createAdapterRegistry } from "../../adapters/registry.js";
import type {
  AgentBackend,
  AgentBackendFactory,
  AgentBackendOptions,
  AgentProbeResult,
} from "../../adapters/agent-backend.js";

function fakeReadyProbe(input: {
  readonly id: string;
  readonly transport: string;
  readonly roles: readonly string[];
}) {
  return {
    status: "ready" as const,
    harness_id: "fake",
    vendor: "HOLP",
    transport_class: input.transport,
    runtime_surfaces: [
      {
        runtime_surface: "headless",
        runtime_kind: "fake",
        actual_fidelity: "streaming_controlled",
        surface_support: "supported",
        isolation_profiles: {
          coder_worktree: { readiness: "ready" },
          read_only_review: { readiness: "ready" },
          real_provider_smoke: { readiness: "rejected", reason: "unsupported" },
          multi_agent_concurrent: { readiness: "rejected", reason: "unsupported" },
          user_global_install: { readiness: "rejected", reason: "unsupported" },
          high_isolation: { readiness: "rejected", reason: "unsupported" },
        },
        state_declaration_ref: "harness-state:fake",
        global_mutation_required: false,
        declared_not_enforced: true,
      },
    ],
    state_declaration_ref: "harness-state:fake",
    version: "0.0.1-fake",
    logged_in: true,
    resolved_roles: input.roles.length > 0 ? input.roles : ["coder"],
  } satisfies AgentProbeResult;
}

describe("orchestrate.run direct_session wiring (Issue #65)", () => {
  it("threads roles.coder.direct_session hold/hold_timeout_ms/tmux_socket_path to the backend factory", async () => {
    const receivedOpts: AgentBackendOptions[] = [];

    const recordingFactory: AgentBackendFactory = (opts) => {
      receivedOpts.push(opts);
      return makeNoopBackend();
    };

    const registry = createAdapterRegistry(
      { fake: recordingFactory },
      {
        fake: async (input) => fakeReadyProbe(input),
      },
    );

    const clock = new FakeClock(1718600000);
    const ctx = new ConnectionContext();
    const sink = new EventSink(() => {});
    const dispatcher = buildDispatcher(ctx, sink, registry, clock);

    function result<T>(res: unknown): T {
      return (res as { result: T }).result;
    }

    await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocol_version: "0.1.4",
        client: { name: "test", version: "0.0.1" },
        capabilities: { approval: { supported: true, kinds: ["merge_approval"] } },
      },
    });

    await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "flock.declare",
      params: {
        agents: [{ id: "agent-1", transport: "fake", roles: ["coder"] }],
      },
    });

    await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "orchestrate.run",
      params: {
        goal: "verify direct_session wiring",
        roles: {
          coder: {
            agent: "agent-1",
            direct_session: {
              hold: true,
              hold_timeout_ms: 42_000,
              tmux_socket_path: "/tmp/holp-test/custom.sock",
            },
          },
        },
      },
    });

    for (let i = 0; i < 200 && receivedOpts.length === 0; i++) {
      await Promise.resolve();
    }

    expect(receivedOpts.length).toBeGreaterThan(0);
    const opts = receivedOpts[0];
    expect(opts.holdSession).toBe(true);
    expect(opts.holdTimeoutMs).toBe(42_000);
    expect(opts.tmuxSocketPath).toBe("/tmp/holp-test/custom.sock");
  });

  it("does not set holdSession when direct_session is absent", async () => {
    const receivedOpts: AgentBackendOptions[] = [];

    const recordingFactory: AgentBackendFactory = (opts) => {
      receivedOpts.push(opts);
      return makeNoopBackend();
    };

    const registry = createAdapterRegistry(
      { fake: recordingFactory },
      {
        fake: async (input) => fakeReadyProbe(input),
      },
    );

    const clock = new FakeClock(1718600000);
    const ctx = new ConnectionContext();
    const sink = new EventSink(() => {});
    const dispatcher = buildDispatcher(ctx, sink, registry, clock);

    await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocol_version: "0.1.4",
        client: { name: "test", version: "0.0.1" },
        capabilities: { approval: { supported: true, kinds: ["merge_approval"] } },
      },
    });

    await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "flock.declare",
      params: {
        agents: [{ id: "agent-1", transport: "fake", roles: ["coder"] }],
      },
    });

    await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "orchestrate.run",
      params: {
        goal: "no direct_session",
        roles: { coder: { agent: "agent-1" } },
      },
    });

    for (let i = 0; i < 200 && receivedOpts.length === 0; i++) {
      await Promise.resolve();
    }

    expect(receivedOpts.length).toBeGreaterThan(0);
    expect(receivedOpts[0].holdSession).toBeFalsy();
    expect(receivedOpts[0].tmuxSocketPath).toBeUndefined();
  });
});

function makeNoopBackend(): AgentBackend {
  const noop = async () => {};
  const noopSync = () => {};
  return {
    startSession: () => Promise.resolve({ sessionId: "noop" }),
    sendPrompt: noop,
    cancel: noop,
    onMessage: noopSync,
    offMessage: noopSync,
    dispose: noop,
  };
}
