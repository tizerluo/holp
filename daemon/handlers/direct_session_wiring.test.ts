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
  readonly directReady?: boolean;
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
      ...(input.directReady
        ? [{
            runtime_surface: "direct_user_session" as const,
            runtime_kind: "fake-direct-tmux-test",
            actual_fidelity: "streaming_controlled" as const,
            surface_support: "supported" as const,
            isolation_profiles: {
              coder_worktree: { readiness: "ready" as const },
              read_only_review: { readiness: "rejected" as const, reason: "unsupported" },
              real_provider_smoke: { readiness: "rejected" as const, reason: "unsupported" },
              multi_agent_concurrent: { readiness: "rejected" as const, reason: "unsupported" },
              user_global_install: { readiness: "rejected" as const, reason: "unsupported" },
              high_isolation: { readiness: "rejected" as const, reason: "unsupported" },
            },
            direct_channel: {
              channel_type: "tmux" as const,
              attach: "supported" as const,
              observe: "supported" as const,
              read: "supported" as const,
              inject: "supported" as const,
              interrupt: "supported" as const,
              cancel: "supported" as const,
              owner_scope: "supported" as const,
            },
            state_declaration_ref: "harness-state:fake-direct-tmux-test",
            global_mutation_required: false,
            declared_not_enforced: true,
          }]
        : []),
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

  it("threads roles.coder.env/model into fake backend opts and stores them on the run record", async () => {
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
        protocol_version: "0.1.9",
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

    const response = await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "orchestrate.run",
      params: {
        goal: "env model passthrough",
        roles: {
          coder: {
            agent: "agent-1",
            model: "fake-model-pr18",
            env: { CODEX_HOME: "/tmp/holp-codex-home", HOLP_FLAG: "enabled" },
          },
        },
      },
    });

    for (let i = 0; i < 200 && receivedOpts.length === 0; i++) {
      await Promise.resolve();
    }

    const { run_id } = result<{ run_id: string }>(response);
    expect(receivedOpts[0].modelId).toBe("fake-model-pr18");
    expect(receivedOpts[0].env).toEqual({ CODEX_HOME: "/tmp/holp-codex-home", HOLP_FLAG: "enabled" });
    expect(ctx.runs.get(run_id)?.roleOptions?.coder).toEqual({
      model: "fake-model-pr18",
      env: { CODEX_HOME: "/tmp/holp-codex-home", HOLP_FLAG: "enabled" },
    });
  });

  it("keeps fake backend opts unchanged when env/model are omitted", async () => {
    const receivedOpts: AgentBackendOptions[] = [];
    const registry = createAdapterRegistry(
      {
        fake: (opts) => {
          receivedOpts.push(opts);
          return makeNoopBackend();
        },
      },
      { fake: async (input) => fakeReadyProbe(input) },
    );
    const ctx = new ConnectionContext();
    const dispatcher = buildDispatcher(ctx, new EventSink(() => {}), registry, new FakeClock(1718600000));

    await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocol_version: "0.1.9",
        client: { name: "test", version: "0.0.1" },
        capabilities: { approval: { supported: true, kinds: ["merge_approval"] } },
      },
    });
    await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "flock.declare",
      params: { agents: [{ id: "agent-1", transport: "fake", roles: ["coder"] }] },
    });
    const response = await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "orchestrate.run",
      params: { goal: "default compatibility", roles: { coder: { agent: "agent-1" } } },
    });

    for (let i = 0; i < 200 && receivedOpts.length === 0; i++) {
      await Promise.resolve();
    }

    const { run_id } = result<{ run_id: string }>(response);
    expect(receivedOpts[0].env).toBeUndefined();
    expect(receivedOpts[0].modelId).toBeUndefined();
    expect(ctx.runs.get(run_id)?.roleOptions).toBeUndefined();
  });

  it("rejects illegal env/model types and credential-like env keys before accepting the fake run", async () => {
    const registry = createAdapterRegistry(
      { fake: () => makeNoopBackend() },
      { fake: async (input) => fakeReadyProbe(input) },
    );
    const dispatcher = buildDispatcher(new ConnectionContext(), new EventSink(() => {}), registry, new FakeClock(1718600000));

    await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocol_version: "0.1.9",
        client: { name: "test", version: "0.0.1" },
        capabilities: { approval: { supported: true, kinds: ["merge_approval"] } },
      },
    });
    await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "flock.declare",
      params: { agents: [{ id: "agent-1", transport: "fake", roles: ["coder"] }] },
    });

    const modelError = error(await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "orchestrate.run",
      params: { goal: "bad model", roles: { coder: { agent: "agent-1", model: 42 } } },
    }));
    expect(modelError.code).toBe(-32600);
    expect(modelError.message).toContain("roles.coder.model");

    const envTypeError = error(await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "orchestrate.run",
      params: { goal: "bad env", roles: { coder: { agent: "agent-1", env: { HOLP_FLAG: true } } } },
    }));
    expect(envTypeError.code).toBe(-32600);
    expect(envTypeError.message).toContain("roles.coder.env.HOLP_FLAG");

    const envKeyShapeError = error(await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 5,
      method: "orchestrate.run",
      params: { goal: "bad env key", roles: { coder: { agent: "agent-1", env: { "HOLP-FLAG": "enabled" } } } },
    }));
    expect(envKeyShapeError.code).toBe(-32600);
    expect(envKeyShapeError.message).toContain("must match /^[A-Za-z_][A-Za-z0-9_]*$/");

    const envControlValueError = error(await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 6,
      method: "orchestrate.run",
      params: { goal: "bad env value", roles: { coder: { agent: "agent-1", env: { HOLP_FLAG: "enabled\nnext" } } } },
    }));
    expect(envControlValueError.code).toBe(-32600);
    expect(envControlValueError.message).toContain("must not contain control characters");

    const secretKeyError = error(await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 7,
      method: "orchestrate.run",
      params: { goal: "secret env", roles: { coder: { agent: "agent-1", env: { API_TOKEN: "nope" } } } },
    }));
    expect(secretKeyError.code).toBe(-32600);
    expect(secretKeyError.message).toContain("auth_ref");
  });

  it("threads direct runtime env/model to the selected direct backend factory", async () => {
    const receivedOpts: AgentBackendOptions[] = [];
    const registry = createAdapterRegistry(
      {
        fake: {
          direct_user_session: (opts) => {
            receivedOpts.push(opts);
            return makeNoopBackend();
          },
        },
      },
      { fake: async (input) => fakeReadyProbe({ ...input, directReady: true }) },
    );
    const dispatcher = buildDispatcher(new ConnectionContext(), new EventSink(() => {}), registry, new FakeClock(1718600000));

    await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocol_version: "0.1.9",
        client: { name: "test", version: "0.0.1" },
        capabilities: { approval: { supported: true, kinds: ["merge_approval"] } },
      },
    });
    await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "flock.declare",
      params: { agents: [{ id: "agent-1", transport: "fake", roles: ["coder"] }] },
    });

    const response = await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "orchestrate.run",
      params: {
        goal: "direct unsupported",
        roles: {
          coder: {
            agent: "agent-1",
            preferred_runtime_surface: "direct_user_session",
            model: "fake-model-pr18",
            env: { CODEX_HOME: "/tmp/holp-codex-home", HOLP_FLAG: "enabled" },
          },
        },
      },
    });

    for (let i = 0; i < 200 && receivedOpts.length === 0; i++) {
      await Promise.resolve();
    }

    expect(result<{ accepted: boolean }>(response).accepted).toBe(true);
    expect(receivedOpts[0].modelId).toBe("fake-model-pr18");
    expect(receivedOpts[0].env).toEqual({ CODEX_HOME: "/tmp/holp-codex-home", HOLP_FLAG: "enabled" });
  });
});

function result<T>(res: unknown): T {
  return (res as { result: T }).result;
}

function error(res: unknown): { code: number; message: string; data?: unknown } {
  return (res as { error: { code: number; message: string; data?: unknown } }).error;
}

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
