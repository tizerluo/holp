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
          resolved_roles: [],
          reason: "unsupported_transport",
          missing: input.roles.map((role) => `role:${role}`),
        };
      }
      return {
        status: "rejected",
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
        resolved_roles: [],
        reason: "unsupported_transport",
        missing: input.roles.map((role) => `role:${role}`),
      }),
      "mcp-codex": probeCodexAppServer,
      acp: (input) => ({
        status: "rejected",
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
        version: "0.0.1-fake",
        logged_in: true,
        resolved_roles: input.roles.length > 0 ? input.roles : ["coder", "reviewer", "tester"],
      }),
    },
  );
}
