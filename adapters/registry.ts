/**
 * 朝下 adapter 注册表 + v0.1.x 桩
 *
 * daemon 按 flock.declare 声明的 transport 选 factory。
 * v0.1.x:native-claude + mcp-codex + acp 全用桩(返回"未接线"错误);真实接线后续做。
 * 规划:acp / native-claude / mcp-codex 的真实实现,走 happier backends 作为方言库
 * (happier 的 executionRunBackendFactory 已对三家都做了真实现,见旧仓研究笔记)。
 *
 * ⚠️ 这是桩接口占位,不是真接 agent。真接之前的纪律(守第 5 条):
 *   - 不用桩的绿冒充"接通了";
 *   - 桩只让协议 daemon 的骨架能编译+跑协议握手,不假装真能 spawn claude/codex。
 */

import type { AgentBackend, AgentBackendFactory, TransportClass } from "./agent-backend";

/** 桩 factory:任何 transport 都返回未接线错误。 */
export function createStubFactory(transport: TransportClass): AgentBackendFactory {
  return () => createStubBackend(transport);
}

function createStubBackend(transport: TransportClass): AgentBackend {
  return {
    async startSession() {
      throw new Error(
        `holp adapter stub: ${transport} not wired in v0.1. ` +
          `Real wiring planned via happier backends (方言库).`,
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

/**
 * transport → factory 映射。daemon 启动时注入。
 * v0.1.x:全是桩。真实实现替换进来时,这里换成 happier executionRunBackendFactory 的适配。
 */
export interface AdapterRegistry {
  resolve(transport: TransportClass): AgentBackendFactory | undefined;
}

export function createAdapterRegistry(
  factories: Partial<Record<TransportClass, AgentBackendFactory>>,
): AdapterRegistry {
  return {
    resolve(transport) {
      return factories[transport];
    },
  };
}

/** v0.1.x 默认 registry:三 transport 全桩。 */
export function createDefaultAdapterRegistry(): AdapterRegistry {
  return createAdapterRegistry({
    "native-claude": createStubFactory("native-claude"),
    "mcp-codex": createStubFactory("mcp-codex"),
    acp: createStubFactory("acp"),
  });
}
