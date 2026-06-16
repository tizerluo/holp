# PR5 SPEC - M3 First Real Adapter

## 目的

接通第一家真实 agent backend,并把 provider 细节隔离在 adapter 层。

## 当前代码事实

- `adapters/agent-backend.ts` 定义稳定朝下接口:`startSession`、`sendPrompt`、`cancel`、`onMessage`、可选 `waitForResponseComplete`、可选 `resolvePermission`、`dispose`。
- `adapters/registry.ts` 当前把 `native-claude`、`mcp-codex`、`acp` 都接到 stub factory。
- roadmap 建议 Codex first。
- 现有注释明确 happier backend 需要 wrapper/extraction,不能直接当 HOLP adapter。

## 范围

新增一个真实 adapter。建议目标:Codex,具体走 CLI/MCP/happier wrapper 取决于实现调研。

预期产出:

- 一个真实 `AgentBackendFactory`。
- `flock.discover` 可用的 availability/probe。
- provider message → `AgentMessage` 映射:
  - `model-output`
  - `status`
  - `tool-call`
  - `tool-result`
  - `fs-edit`
  - `permission-request`
  - 必要时 generic event
  - 来源校准(对照 happier ACP 实测):`model-output`/`status`/`tool-call`/`tool-result`/`permission-request` 由 ACP session update 直接产出,可直通;`fs-edit` **不是 ACP 源生消息**(happier 的 fs-edit 是上层从 tool-call 推导),codex path 下应从 tool-call/patch 推导,不可假设 ACP 直接给;codex 专属的 `exec-approval-request`、`patch-apply-begin/end`、`terminal-output`、`token-count` 不在 HOLP 7 类里——映射为 HOLP `event`(generic),或归并进 `permission-request`(exec-approval)/`fs-edit`(patch)。不得静默丢弃 patch/exec 这类有副作用的消息。
- permission bridge(**必做,非 degraded 选项**):
  - provider permission request → HOLP `ask_human`
  - `approval.resolve` → `resolvePermission(request_id, decision)` → resume/deny 原 tool call
  - 实现机制(对照 happier 实测):happier `AcpBackend` 的 `permissionHandler.handleToolCall(...)` 是 **`await` 一个 Promise** 的模型——HOLP adapter 实现该 handler 时,返回一个**挂起的 Promise**,先发 `ask_human`(带 `request_id`/`call_id`),把 resolve 句柄存进 `Map<request_id, resolve>`,**不立即 resolve**;ACP agent 这侧自然阻塞在 await 上,tool call 真被暂停;`approval.resolve` 进来后从 Map 取句柄、用 decision resolve 它 → handler 返回 → agent resume(approved)或按 deny 路径中止。这条 resume 链是 §12.1 `resolvePermission` 的设计目标,happier 的 await-Promise 模型原生支持,**不是"可能做不到"的能力**。
- registry wiring:能选择真实 adapter,但不能把所有 transport 都伪装成 ready。
- auth/binary/login 缺失时返回 `rejected` 或 `degraded`。

## 非目标

- 不接第二家 provider。
- 不做 M4 governance kernel。
- 不做 multi-agent consensus demo。
- 不让 happier 成为协议依赖。
- 不把 stub 静默替换成假 ready。

## 验收

- M2 contract tests 继续通过。
- 有凭证/binary 时,真实 adapter 能跑一个单步 local prompt。
- 缺 binary/login/token 时返回 per-agent `status=rejected` 或 `degraded`。
- 至少一种真实 provider event 能进入 HOLP event flow。
- codex(happier ACP path)**必须**实现完整 permission resume:`ask_human` 能暂停 tool call,`approval.resolve` 能 resume(approved)或 deny 原 tool call。这是必做项——happier 的 await-Promise handler 模型原生支持挂起+回灌(见"范围"的实现机制),**不接受"做不到就标 degraded"**。
- degraded 逃生舱**仅**适用于 provider 协议本身不支持 deferred permission 的 path(codex **不属此类**)。走 degraded 必须举证:指出是哪一层协议机制不支持 deferred permission,不能仅因实现复杂度而降级。

## Review 重点

provider integration 很容易扩 scope。本 PR 只看第一家 provider,不要混入 consensus/gate/triage。
