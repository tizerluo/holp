/**
 * 朝下 adapter 注册表。
 *
 * daemon 按 flock.declare 声明的 transport 选 factory。
 * M3: "mcp-codex" 接 Codex app-server over stdio。
 * M6b: "native-claude" 接 Claude Code headless reviewer path。
 * acp 仍为 honest stub,不伪装 ready。
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
import { createClaudeCodeBackendFactory, probeClaudeCode, READ_ONLY_ALLOWED_TOOLS } from "./claude-code.js";
import { createCodexAppServerBackendFactory, probeCodexAppServer } from "./codex-app-server.js";
import { createAcpBackendFactory } from "./acp-client.js";
import { createDirectTmuxBackendFactory, type DirectTmuxPromptOptions } from "./direct-tmux.js";
import { createFakeBackendFactory } from "./fake-backend.js";
import {
  firstBatchAdapterFactories,
  firstBatchAdapterProbes,
} from "./first-batch-harnesses.js";
import {
  rejectedProfiles,
  withProfile,
  type DirectChannelDeclaration,
  type RuntimeSurface,
  type RuntimeSurfaceDeclaration,
} from "./harness-declaration.js";

function unknownDirectChannel(channelType = "terminal_app"): DirectChannelDeclaration {
  return {
    channel_type: channelType,
    attach: "unknown",
    observe: "unknown",
    read: "unknown",
    inject: "unknown",
    interrupt: "unknown",
    cancel: "unknown",
    owner_scope: "unknown",
  };
}

function stubRuntimeSurfaces(reason = "unsupported_transport"): readonly RuntimeSurfaceDeclaration[] {
  const profiles = rejectedProfiles(reason);
  const common = {
    isolation_profiles: profiles,
    global_mutation_required: false,
    declared_not_enforced: true,
  } as const;
  return [
    {
      runtime_surface: "headless",
      runtime_kind: "stub",
      actual_fidelity: "one_shot",
      surface_support: "unsupported",
      state_declaration_ref: "harness-state:stub",
      ...common,
    },
    {
      runtime_surface: "acp",
      runtime_kind: "stub-acp-unwired",
      actual_fidelity: "one_shot",
      surface_support: "unsupported",
      state_declaration_ref: "harness-state:stub:acp",
      ...common,
    },
    {
      runtime_surface: "direct_user_session",
      runtime_kind: "stub-direct-session-unwired",
      actual_fidelity: "one_shot",
      surface_support: "unknown",
      direct_channel: unknownDirectChannel(),
      state_declaration_ref: "harness-state:stub:direct_user_session",
      ...common,
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
      actual_fidelity: "streaming_controlled",
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
      actual_fidelity: "one_shot",
      surface_support: "unsupported",
      isolation_profiles: rejectedProfiles("unsupported_runtime_surface"),
      state_declaration_ref: "harness-state:fake:acp",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
    {
      runtime_surface: "direct_user_session",
      runtime_kind: "fake-direct-session-unwired",
      actual_fidelity: "one_shot",
      surface_support: "unknown",
      isolation_profiles: rejectedProfiles("unknown_runtime_surface"),
      direct_channel: {
        channel_type: "product_session",
        attach: "unknown",
        observe: "unknown",
        read: "unknown",
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

function learnedRouterRuntimeSurfaces(): readonly RuntimeSurfaceDeclaration[] {
  const profiles = rejectedProfiles("planner_only_not_executor");
  return [
    {
      runtime_surface: "headless",
      runtime_kind: "learned_router_fixture",
      actual_fidelity: "one_shot",
      surface_support: "experimental",
      isolation_profiles: withProfile(profiles, "read_only_review", {
        readiness: "degraded",
        reason: "fixture_planner_shadow_replay_only",
        warnings: ["not_active_eligible_without_real_learned_model_attestation"],
      }),
      state_declaration_ref: "harness-state:learned-router",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
    {
      runtime_surface: "acp",
      runtime_kind: "learned_router_acp_unwired",
      actual_fidelity: "one_shot",
      surface_support: "unsupported",
      isolation_profiles: rejectedProfiles("unsupported_runtime_surface"),
      state_declaration_ref: "harness-state:learned-router:acp",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
    {
      runtime_surface: "direct_user_session",
      runtime_kind: "learned_router_direct_unwired",
      actual_fidelity: "one_shot",
      surface_support: "unsupported",
      isolation_profiles: rejectedProfiles("unsupported_runtime_surface"),
      direct_channel: unknownDirectChannel(),
      state_declaration_ref: "harness-state:learned-router:direct_user_session",
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
  resolve(transport: TransportClass, surface?: RuntimeSurface): AgentBackendFactory | undefined;
  hasTransport(transport: TransportClass): boolean;
  probe(input: AgentProbeInput): AgentProbeResult | Promise<AgentProbeResult>;
}

export function codexDirectAgentArgsForPrompt(
  prompt: string,
  options: DirectTmuxPromptOptions = {},
): readonly string[] {
  return [
    "exec",
    "--sandbox",
    "workspace-write",
    ...(options.modelId ? ["-m", options.modelId] : []),
    "-c",
    'approval_policy="never"',
    "--skip-git-repo-check",
    "-c",
    "notify=[]",
    prompt,
  ];
}

export function createAdapterRegistry(
  factories: Partial<Record<TransportClass, AgentBackendFactory | Partial<Record<RuntimeSurface, AgentBackendFactory>>>>,
  probes: Partial<Record<TransportClass, AgentBackendProbe>> = {},
): AdapterRegistry {
  return {
    resolve(transport, surface = "headless") {
      const entry = factories[transport];
      if (!entry) return undefined;
      if (typeof entry === "function") {
        return surface === "headless" ? entry : undefined;
      }
      return entry[surface];
    },
    hasTransport(transport) {
      return factories[transport] !== undefined;
    },
    async probe(input) {
      const probe = probes[input.transport];
      if (probe) return probe(input);
      if (factories[input.transport] === undefined) {
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
        reason: "probe_not_configured",
        missing: input.roles.map((role) => `role:${role}`),
      };
    },
  };
}

/** 默认 live registry:Codex app-server + Claude Code real adapters, with ACP as honest stub. */
export function createDefaultAdapterRegistry(): AdapterRegistry {
  return createAdapterRegistry(
    {
      "native-claude": {
        headless: createClaudeCodeBackendFactory(),
        direct_user_session: createDirectTmuxBackendFactory({
          transport: "native-claude",
          agentCommand: "claude",
          agentArgsForPrompt: (prompt) => [
            "-p",
            prompt,
            "--output-format",
            "json",
            "--allowedTools",
            READ_ONLY_ALLOWED_TOOLS,
          ],
        }),
      },
      "mcp-codex": {
        headless: createCodexAppServerBackendFactory(),
        acp: createAcpBackendFactory({ transport: "mcp-codex", command: "codex-acp" }),
        direct_user_session: createDirectTmuxBackendFactory({
          transport: "mcp-codex",
          agentCommand: "codex",
          agentArgsForPrompt: codexDirectAgentArgsForPrompt,
          supportsModelId: true,
        }),
      },
      acp: createStubFactory("acp"),
      "learned-router": createStubFactory("learned-router"),
      ...firstBatchAdapterFactories(),
    },
    {
      "native-claude": probeClaudeCode,
      "mcp-codex": probeCodexAppServer,
      ...firstBatchAdapterProbes(),
      acp: (input) => ({
        status: "rejected",
        harness_id: "acp",
        transport_class: input.transport,
        runtime_surfaces: stubRuntimeSurfaces("unsupported_transport"),
        resolved_roles: [],
        reason: "unsupported_transport",
        missing: input.roles.map((role) => `role:${role}`),
      }),
      "learned-router": (input) => ({
        status: "degraded",
        harness_id: "learned-router",
        vendor: "HOLP",
        transport_class: input.transport,
        runtime_surfaces: learnedRouterRuntimeSurfaces(),
        state_declaration_ref: "harness-state:learned-router",
        global_mutation_required: false,
        version: "fixture-planner-v1",
        logged_in: true,
        resolved_roles: input.roles.includes("work_planner") ? ["work_planner"] : [],
        reason: "fixture_planner_shadow_replay_only",
        missing: input.roles
          .filter((role) => role !== "work_planner")
          .map((role) => `role:${role}`),
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
      "learned-router": createStubFactory("learned-router"),
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
      "learned-router": (input) => ({
        status: "degraded",
        harness_id: "learned-router",
        vendor: "HOLP",
        transport_class: input.transport,
        runtime_surfaces: learnedRouterRuntimeSurfaces(),
        state_declaration_ref: "harness-state:learned-router",
        global_mutation_required: false,
        version: "fixture-planner-v1",
        logged_in: true,
        resolved_roles: input.roles.includes("work_planner") ? ["work_planner"] : [],
        reason: "fixture_planner_shadow_replay_only",
        missing: input.roles
          .filter((role) => role !== "work_planner")
          .map((role) => `role:${role}`),
      }),
    },
  );
}
