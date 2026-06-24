/**
 * HOLP 朝下 agent 适配契约(transport-agnostic)
 *
 * 这是 daemon 驱动"一家 agent"的统一接口。无论底下是 native-claude / mcp-codex / acp,
 * 朝上都呈现同一形状:startSession / sendPrompt / onMessage(事件流) / cancel。
 *
 * 设计借自 happier 的 AgentBackend 接口(`apps/cli/src/agent/core/AgentBackend.ts`)
 * 与 ExecutionRunBackendFactory(`apps/cli/src/agent/executionRuns/registry/`)。
 * v0.1.x 参考实现已将 mcp-codex 接到 Codex app-server,并将 native-claude
 * 接到 Claude Code headless reviewer partial;acp 仍是桩。
 * 后续 provider 接线可通过 wrapper 或抽取包复用 happier backend 模块。
 *
 * 关键接缝(对应协议能力):
 * - onMessage(事件流) → 协议事件流的料(tool_called/fs_edited/...),经 events.subscribe 订阅后回吐
 * - permissionHandler → 协议 approval + daemon 裁决内核介入"中途拦工具调用"
 */

import type {
  HarnessDeclarationMetadata,
  IsolationProfile,
  RuntimeSurface,
} from "./harness-declaration.js";

/** agent 能担的角色(来源 loopwright triage/reviewer role + harness_registry.role_fitness) */
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
  // text-delta: 0..N incremental/best-effort/raw chunks (Issue #65 L3 live stream); full-text: 0..1 authoritative cleaned terminal snapshot per prompt.
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
 * v0.1.x 主路径:daemon 注入 permissionHandler,它创建 HOLP approval 并返回 pending Promise;
 * approval.resolve 通过 ApprovalRecord.resumeBackend 解析为 allow/deny,adapter 再回写 provider。
 * ask_human 对象形态保留给未来需要显式 request handle 的 provider wrapper。
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
  /** 工具调用前介入;各 adapter 定义缺省策略。PR5 Codex adapter 缺省拒绝以避免无人值守放行。 */
  readonly permissionHandler?: PermissionHandler;
  /** Issue #65 L1: direct-tmux only. Keep session attachable past run terminal (reaper-bounded); dispose() skips kill, cancel() still kills. */
  readonly holdSession?: boolean;
  /** Issue #65 L1: direct-tmux only. Bounded window before the hold reaper kills the held session. */
  readonly holdTimeoutMs?: number;
  /** Issue #65 L2: direct-tmux only. Absolute tmux socket (`tmux -S <path>`) so the worker lands on a user-attachable server, independent of the daemon's inherited $TMUX. */
  readonly tmuxSocketPath?: string;
}

export interface AgentProbeInput {
  readonly id: string;
  readonly transport: TransportClass;
  readonly roles: readonly string[];
  readonly cwd: string;
  readonly runtimeSurface?: RuntimeSurface;
  readonly isolationProfile?: IsolationProfile;
  readonly runIntent?: string;
  readonly workspaceId?: string;
  readonly sessionRouteKey?: string;
}

export interface AgentProbeResult extends HarnessDeclarationMetadata {
  readonly status: "ready" | "degraded" | "rejected";
  readonly version?: string;
  readonly logged_in?: boolean;
  readonly resolved_roles?: readonly string[];
  readonly missing?: readonly string[];
  readonly reason?: string;
}

/**
 * 朝下适配契约:daemon 通过它驱动一家 agent。
 * 形状启发自 happier `AgentBackend`(startSession/sendPrompt/onMessage/cancel 这层),
 * 但**不是直接复用 happier 接口**——happier 的 AgentBackend 更大(多 loadSession/
 * compactContext/respondToPermission/probeTurnLiveness 等),且权限枚举不同(happier 是
 * approved/approved_for_session/approved_execpolicy_amendment/denied/abort 五值,
 * HOLP allow/deny/ask_human 三值)。未来接 happier backends 需要一层
 * wrapper 适配,不是"直接当 adapter"。
 *
 * v0.1.x 约束:**一个 backend 实例只允许一个 session**。
 * 原因:onMessage 是 backend 级全局回调,AgentMessage 不带 sessionId(见上);
 * 多 session 并发时消息无法归属。若未来要多 session,必须让 AgentMessage 带
 * sessionId/run_id/step_id,handler 按 session 订阅——届时同步改本契约。
 */
export interface AgentBackend {
  /** 单 session 约束:同一 backend 实例只有一个活跃 session。 */
  startSession(initialPrompt?: string): Promise<{ sessionId: string }>;
  sendPrompt(sessionId: string, prompt: string): Promise<void>;
  /** 取消当前活跃 session; 单 session backend 可能忽略过期的 sessionId。 */
  cancel(sessionId: string): Promise<void>;
  onMessage(handler: AgentMessageHandler): void;
  offMessage?(handler: AgentMessageHandler): void;
  /** sendPrompt 后等本轮结束(收完所有 chunk)。 */
  waitForResponseComplete?(timeoutMs?: number): Promise<void>;
  /**
   * 兼容/未来扩展:恢复一个 pending 的 permission/ask_human 请求。
   * PR5 的 Codex app-server 主路径不调用此方法;它通过注入的 permissionHandler
   * pending Promise + ApprovalRecord.resumeBackend 完成 resume/deny。
   */
  resolvePermission?(request_id: string, decision: "allow" | "deny"): Promise<void>;
  dispose(): Promise<void>;
}

/** 工厂:按 transport 选 backend。形状启发自 happier `ExecutionRunBackendFactory`(但后者 opts 更大:backendId/modelId/accountSettings/isolation 等,接入需 wrapper)。 */
export type AgentBackendFactory = (opts: AgentBackendOptions) => AgentBackend;

/** Lightweight availability probe used by flock.declare/discover; must not start a long-lived session. */
export type AgentBackendProbe = (input: AgentProbeInput) => AgentProbeResult | Promise<AgentProbeResult>;
