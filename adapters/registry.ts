/**
 * 朝下 adapter 注册表。
 *
 * daemon 按 flock.declare 声明的 transport 选 factory。
 * M3: "mcp-codex" 接 Codex app-server over stdio。
 * native-claude / acp 仍为 honest stubs,不伪装 ready。
 *
 * fake registry 只用于 demo/test,不在默认 live daemon registry 中启用。
 */

import type {
  AgentBackend,
  AgentBackendFactory,
  AgentBackendProbe,
  AgentProbeInput,
  AgentProbeResult,
  TransportClass,
} from "./agent-backend.js";
import { createCodexAppServerBackendFactory, probeCodexAppServer } from "./codex-app-server.js";
import { createFakeBackendFactory } from "./fake-backend.js";
import {
  rejectedProfiles,
  withProfile,
  type RuntimeSurfaceDeclaration,
} from "./harness-declaration.js";

function stubRuntimeSurfaces(reason = "unsupported_transport"): readonly RuntimeSurfaceDeclaration[] {
  return [
    {
      runtime_surface: "headless",
      runtime_kind: "stub",
      surface_support: "unsupported",
      isolation_profiles: rejectedProfiles(reason),
      state_declaration_ref: "harness-state:stub",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
  ];
}

function fakeRuntimeSurfaces(): readonly RuntimeSurfaceDeclaration[] {
  const base = rejectedProfiles("unsupported_isolation_profile");
  // Isolation readiness has no "unsupported" value; when an entire runtime
  // surface is unsupported/unknown, rejected profiles mean "not schedulable
  // through this surface", not that profile-specific enforcement was probed.
  return [
    {
      runtime_surface: "headless",
      runtime_kind: "fake",
      surface_support: "supported",
      isolation_profiles: withProfile(
        withProfile(base, "coder_worktree", { readiness: "ready" }),
        "read_only_review",
        { readiness: "ready" },
      ),
      state_declaration_ref: "harness-state:fake",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
    {
      runtime_surface: "acp",
      runtime_kind: "fake-acp-unwired",
      surface_support: "unsupported",
      isolation_profiles: rejectedProfiles("unsupported_runtime_surface"),
      state_declaration_ref: "harness-state:fake:acp",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
    {
      runtime_surface: "direct_user_session",
      runtime_kind: "fake-direct-session-unwired",
      surface_support: "unknown",
      isolation_profiles: rejectedProfiles("unknown_runtime_surface"),
      direct_channel: {
        channel_type: "product_session",
        attach: "unknown",
        inject: "unknown",
        interrupt: "unknown",
        cancel: "unknown",
        owner_scope: "unknown",
      },
      state_declaration_ref: "harness-state:fake:direct_user_session",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
  ];
}

/** 桩 factory:任何 transport 都返回未接线错误。 */
export function createStubFactory(transport: TransportClass): AgentBackendFactory {
  return () => createStubBackend(transport);
}

function createStubBackend(transport: TransportClass): AgentBackend {
  return {
    async startSession() {
      throw new Error(
        `holp adapter stub: ${transport} not wired in v0.1. ` +
          `Real wiring planned via happier backend wrapper/extraction.`,
      );
    },
    async sendPrompt() {
      throw new Error(`holp adapter stub: ${transport} not wired`);
    },
    async cancel() {},
    onMessage() {},
    async dispose() {},
  };
}

/** transport → factory/probe 映射。daemon 启动时注入。 */
export interface AdapterRegistry {
  resolve(transport: TransportClass): AgentBackendFactory | undefined;
  probe(input: AgentProbeInput): AgentProbeResult | Promise<AgentProbeResult>;
}

export function createAdapterRegistry(
  factories: Partial<Record<TransportClass, AgentBackendFactory>>,
  probes: Partial<Record<TransportClass, AgentBackendProbe>> = {},
): AdapterRegistry {
  return {
    resolve(transport) {
      return factories[transport];
    },
    async probe(input) {
      const probe = probes[input.transport];
      if (probe) return probe(input);
      if (!factories[input.transport]) {
        return {
          status: "rejected",
          harness_id: input.id,
          transport_class: input.transport,
          runtime_surfaces: stubRuntimeSurfaces("unsupported_transport"),
          resolved_roles: [],
          reason: "unsupported_transport",
          missing: input.roles.map((role) => `role:${role}`),
        };
      }
      return {
        status: "rejected",
        harness_id: input.id,
        transport_class: input.transport,
        runtime_surfaces: stubRuntimeSurfaces("probe_not_configured"),
        resolved_roles: [],
        reason: "unsupported_transport",
        missing: input.roles.map((role) => `role:${role}`),
      };
    },
  };
}

/** 默认 live registry:Codex app-server real adapter + remaining honest stubs. */
export function createDefaultAdapterRegistry(): AdapterRegistry {
  return createAdapterRegistry(
    {
      "native-claude": createStubFactory("native-claude"),
      "mcp-codex": createCodexAppServerBackendFactory(),
      acp: createStubFactory("acp"),
    },
    {
      "native-claude": (input) => ({
        status: "rejected",
        harness_id: "claude-code",
        vendor: "Anthropic",
        transport_class: input.transport,
        runtime_surfaces: stubRuntimeSurfaces("unsupported_transport"),
        resolved_roles: [],
        reason: "unsupported_transport",
        missing: input.roles.map((role) => `role:${role}`),
      }),
      "mcp-codex": probeCodexAppServer,
      acp: (input) => ({
        status: "rejected",
        harness_id: "acp",
        transport_class: input.transport,
        runtime_surfaces: stubRuntimeSurfaces("unsupported_transport"),
        resolved_roles: [],
        reason: "unsupported_transport",
        missing: input.roles.map((role) => `role:${role}`),
      }),
    },
  );
}

/**
 * Registry with fake backend for DEMO / TEST.
 * "fake" transport resolves to the deterministic fake backend.
 * The real mcp-codex adapter is intentionally not used here so M1/M2 demos
 * stay deterministic; native-claude/mcp-codex/acp entries resolve to stubs.
 *
 * ⚠️ DEMO/TEST ONLY — "fake" is not a real HOLP transport.
 * The fake backend replaces the provider, not the protocol path.
 */
export function createFakeRegistry(): AdapterRegistry {
  return createAdapterRegistry(
    {
      "native-claude": createStubFactory("native-claude"),
      "mcp-codex": createStubFactory("mcp-codex"),
      acp: createStubFactory("acp"),
      fake: createFakeBackendFactory(),
    },
    {
      fake: (input) => ({
        status: "ready",
        harness_id: "fake",
        vendor: "HOLP",
        transport_class: input.transport,
        runtime_surfaces: fakeRuntimeSurfaces(),
        state_declaration_ref: "harness-state:fake",
        global_mutation_required: false,
        version: "0.0.1-fake",
        logged_in: true,
        resolved_roles: input.roles.length > 0 ? input.roles : ["coder", "reviewer", "tester"],
      }),
    },
  );
}
