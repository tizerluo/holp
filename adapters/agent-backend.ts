/**
 * HOLP 朝下 agent 适配契约(transport-agnostic)
 *
 * 这是 daemon 驱动"一家 agent"的统一接口。无论底下是 native-claude / mcp-codex / acp,
 * 朝上都呈现同一形状:startSession / sendPrompt / onMessage(事件流) / cancel。
 *
 * 设计借自 happier 的 AgentBackend 接口(`apps/cli/src/agent/core/AgentBackend.ts`)
 * 与 ExecutionRunBackendFactory(`apps/cli/src/agent/executionRuns/registry/`)。
 * v0.1 参考实现先提供 native-claude + mcp-codex 的桩;acp 方言库规划接 happier backends。
 *
 * 关键接缝(对应协议能力):
 * - onMessage(事件流) → 协议事件流的料(tool_called/fs_edited/...),经 events.subscribe 订阅后回吐
 * - permissionHandler → 协议 approval + daemon 裁决内核介入"中途拦工具调用"
 */

/** agent 能担的角色(来源 loopwright Role) */
export type Role =
  | "architect"
  | "reviewer"
  | "coder"
  | "tester"
  | "test_audit"
  | "test_strengthen";

/** 传输类型(来源 loopwright harness_registry.transport_class + happier backend modes) */
export type TransportClass = "native-claude" | "mcp-codex" | "acp" | (string & {});

/**
 * 统一事件流:无论底下哪家 agent,朝上都吐同一种 AgentMessage。
 * 设计借自 happier `AgentMessage`(`apps/cli/src/agent/core/AgentMessage.ts`)。
 * 这些事件映射到协议事件流的 name:
 *   tool-call → tool_called, tool-result → tool_result, fs-edit → fs_edited,
 *   permission-request → approval_requested, status → lifecycle 事件, model-output → step payload。
 */
export type AgentMessage =
  | { type: "model-output"; textDelta?: string; fullText?: string }
  | { type: "status"; status: "starting" | "running" | "idle" | "stopped" | "error"; detail?: string }
  | { type: "tool-call"; toolName: string; args: Record<string, unknown>; callId: string }
  | { type: "tool-result"; toolName: string; result: unknown; callId: string }
  | { type: "fs-edit"; description: string; diff?: string; path?: string }
  | { type: "permission-request"; id: string; toolName: string; input: unknown; reason: string }
  | { type: "event"; name: string; payload: unknown };

export type AgentMessageHandler = (msg: AgentMessage) => void;

/**
 * 权限裁决(工具调用前介入)。来源 loopwright PermissionPolicy + happier AcpPermissionHandler。
 *
 * v0.1.1 修复(codex P1-4):ask_human 必须是**可恢复对象**——带 request_id/call_id,
 * resolve 后 adapter 能 resume/deny 原始 tool call。v0.1 只有 allow/deny/ask_human 裸返回,
 * 缺 pending tool call handle,resolve 后无法回灌 agent。
 */
export type PermissionVerdict =
  | { decision: "allow"; reason: string }
  | { decision: "deny"; reason: string }
  | {
      decision: "ask_human";
      reason: string;
      /** 可恢复对象:approval.resolve 后 adapter 据此 resume/deny 原始 tool call。对应协议 §7 approval + §12.1。 */
      request_id: string;
      call_id: string;
      toolName: string;
      input: unknown;
    };

export type PermissionHandler = (
  toolName: string,
  input: unknown,
) => Promise<PermissionVerdict>;

/** 起一个 agent 会话的选项 */
export interface AgentBackendOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly modelId?: string;
  /** 工具调用前介入;缺省 → 放行(degraded)。注入 daemon 裁决内核即"中途拦"。 */
  readonly permissionHandler?: PermissionHandler;
}

/**
 * 朝下适配契约:daemon 通过它驱动一家 agent。
 * 对应 happier AgentBackend(同一个形状,故未来 happier backends 可直接当 adapter 实现)。
 *
 * v0.1.1 约束(codex P1-3):**一个 backend 实例只允许一个 session**。
 * 原因:onMessage 是 backend 级全局回调,AgentMessage 不带 sessionId(见上);
 * 多 session 并发时消息无法归属。若未来要多 session,必须让 AgentMessage 带
 * sessionId/run_id/step_id,handler 按 session 订阅——届时同步改本契约。
 */
export interface AgentBackend {
  /** 单 session 约束:同一 backend 实例只有一个活跃 session。 */
  startSession(initialPrompt?: string): Promise<{ sessionId: string }>;
  sendPrompt(sessionId: string, prompt: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  onMessage(handler: AgentMessageHandler): void;
  offMessage?(handler: AgentMessageHandler): void;
  /** sendPrompt 后等本轮结束(收完所有 chunk)。 */
  waitForResponseComplete?(timeoutMs?: number): Promise<void>;
  /**
   * 恢复一个 pending 的 permission/ask_human 请求(codex P1-4)。
   * approval.resolve 后,daemon 调此方法把决定回灌 agent(resume/deny 原 tool call)。
   */
  resolvePermission?(request_id: string, decision: "allow" | "deny"): Promise<void>;
  dispose(): Promise<void>;
}

/** 工厂:按 transport 选 backend。对应 happier ExecutionRunBackendFactory 的签名。 */
export type AgentBackendFactory = (opts: AgentBackendOptions) => AgentBackend;
