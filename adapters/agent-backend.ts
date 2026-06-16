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
 * - onMessage(事件流) → 协议 events.stream 的料(tool_called/fs_edited/...)
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
 * 这些事件映射到协议 events.stream 的 name:
 *   tool-call → tool_called, tool-result → tool_result, fs-edit → fs_edited,
 *   permission-request → approval Needed, status → lifecycle, model-output → step payload。
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

/** 权限裁决(工具调用前介入)。来源 loopwright PermissionPolicy + happier AcpPermissionHandler。 */
export type PermissionVerdict =
  | { decision: "allow"; reason: string }
  | { decision: "deny"; reason: string }
  | { decision: "ask_human"; reason: string };

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
 */
export interface AgentBackend {
  startSession(initialPrompt?: string): Promise<{ sessionId: string }>;
  sendPrompt(sessionId: string, prompt: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  onMessage(handler: AgentMessageHandler): void;
  offMessage?(handler: AgentMessageHandler): void;
  /** sendPrompt 后等本轮结束(收完所有 chunk)。 */
  waitForResponseComplete?(timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

/** 工厂:按 transport 选 backend。对应 happier ExecutionRunBackendFactory 的签名。 */
export type AgentBackendFactory = (opts: AgentBackendOptions) => AgentBackend;
