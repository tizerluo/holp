> status: completed — PR5 shipped; see pr-specs README landed foundation list and README adapter status.

# PR5 SPEC - M3 First Real Adapter

## 目的

接通第一家真实 agent backend,并把 provider 细节隔离在 adapter 层。

## PR5 前代码事实

- `adapters/agent-backend.ts` 定义稳定朝下接口:`startSession`、`sendPrompt`、`cancel`、`onMessage`、可选 `waitForResponseComplete`、可选 `resolvePermission`、`dispose`。
- `adapters/registry.ts` 在 PR5 前把 `native-claude`、`mcp-codex`、`acp` 都接到 stub factory。
- `orchestrate.run` 当前通过注入 `permissionHandler` 创建 approval record,并把 `resumeBackend(decision)` closure 存进 `ApprovalRecord`;`approval.resolve` / `task.cancel` 调该 closure 恢复 backend。这个 closure path 已经是 await-Promise 模型,受 M1/M2 契约测试保护。
- roadmap 建议 Codex first。
- 现有注释明确 happier backend 需要 wrapper/extraction,不能直接当 HOLP adapter。

## 当前实施状态

- `"mcp-codex"` 已接 Codex app-server over stdio 真实 adapter。
- 该实现只证明 Codex app-server 这一种 runtime kind 可作为首个真实 adapter;不代表 Codex 的 headless / ACP / MCP / direct_user_session 全部支持,也不代表 12 个 agent 的三类运行面已支持。
- `native-claude`、`acp` 仍是 honest stubs,不会伪装 ready。
- `createFakeRegistry()` 继续保留 M1/M2 demo/test fake path;CLI demo 显式设置 `HOLP_REGISTRY=fake`。
- 本机已登录 Codex 时,manual smoke 已验证 `flock.discover` ready + safe prompt `HOLP_SMOKE_OK` 进入 `model_output` 并以无 artifact 的 `run_merged` 收束。
- 已新增显式 opt-in 的真实 Codex approval/patch smoke:`HOLP_REAL_CODEX_SMOKE=1 npm run smoke:codex:adapter` 覆盖 adapter-direct patch path;`HOLP_REAL_CODEX_SMOKE=1 npm run smoke:codex` 覆盖 daemon e2e patch + approval approve/reject。R2 修复后只有 patch、approve -> `run_merged`、reject -> `run_blocked` 全部跑通才 exit 0;实跑记录为 PASS。隔离边界见 `scripts/smoke/README.md`。

## 范围

新增一个真实 adapter。目标:Codex。PR5 选定接入面为 **Codex app-server over stdio**,注册到 HOLP 既有 transport 名 `"mcp-codex"`。这里的 transport 名沿用协议词表,但实现面是 Codex app-server,不是 `codex mcp-server`,也不是 happier ACP wrapper。

按 v0.1.5 baseline 解释,PR5 只覆盖 `runtime_surface=headless`、`runtime_kind=app_server` 下的 Codex adapter 与 `real_provider_smoke` 第一例;其他 runtime surface 必须在后续 declaration/isolation matrix 中显式返回 unknown/unsupported/rejected,不能从 PR5 成功自动推导。

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
  - Codex app-server 映射以本地 `codex app-server generate-ts --experimental` 的 schema 为准: `turn/started|completed` → `status`;`item/agentMessage/delta` → `model-output`;`item/commandExecution/requestApproval` / `item/fileChange/requestApproval` / legacy `execCommandApproval` / `applyPatchApproval` → `permission-request`;`item/fileChange/patchUpdated` → `fs-edit`;command/process output/tool-like updates → `tool-result` 或 generic `event`。app-server 未覆盖或无法归并的 side-effect 消息必须进入 generic `event`,不得静默丢弃 patch/exec 这类有副作用的消息。
- permission bridge(**必做,非 degraded 选项**):
  - provider permission request → HOLP `ask_human`
  - PR5 **复用现有 daemon bridge**:`orchestrate.run` 注入的 `permissionHandler` 创建 HOLP approval 并返回 pending Promise;Codex adapter 在 app-server approval request 到达时调用并 `await` 该 injected handler;`approval.resolve` / `task.cancel` 仍通过 `ApprovalRecord.resumeBackend(decision)` 解析 Promise;adapter 随后把 verdict 回写给 app-server(approved → accept/approved,rejected → decline/denied)。本 PR 不把 daemon 迁移到 `backend.resolvePermission`;该可选接口继续保留给未来无法用 injected handler 表达的 provider。
- registry wiring:能选择真实 adapter,但不能把所有 transport 都伪装成 ready。
- auth/binary/login 缺失时返回 `rejected` 或 `degraded`。
  - 建议 probe 规则:缺 `codex` binary → `rejected` + `missing:["binary:codex"]`;binary 存在但 `codex doctor` 显示 auth 未配置或 app-server 启动失败 → `degraded`/`rejected`(带 reason,不得 ready);已登录且 app-server initialize 成功 → `ready`。
  - probe 必须有超时,不得因本地 Codex 卡住而阻塞 daemon。
  - real backend 的 `cancel()` / `dispose()` 必须终止 app-server 子进程并清理 pending request;daemon 退出/任务取消不能留下 orphan child。
  - real backend 的 `sendPrompt()` 只在 app-server turn 完成后 resolve;不能在仅发送 `turn/start` 后提前返回。
  - `daemon/core/runEngine.ts` / `driveRun` 在 PR5 scope 内:当前 fake hardcoded diff + `run_merged` artifact 只允许用于 fake backend。real Codex run 不得 emit 带 fake hardcoded diff 的 `run_merged`;真实 artifact 只能来自 provider 消息或 adapter 明确产物;若没有真实 artifact,可 emit 不带 artifact 的 terminal event 或按 blocked/gave_up 收束,但不得把 fake diff 当真实 provider 产物。
  - `driveRun` 必须转发 `model-output` 和 generic `event`,不能让 adapter 已映射的 side-effect 消息在 engine 层落入 `default: break`。
  - live daemon registry 必须能选择 real Codex adapter。`main()` 不能永远只使用 `createFakeRegistry()`;可用环境变量或显式 factory 选择 demo fake vs default real registry,但真实接线验收必须能跑到 `"mcp-codex"` factory。

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
- codex(app-server path)**必须**实现完整 permission resume:`ask_human` 能暂停 tool call,`approval.resolve` 能 resume(approved)或 deny 原 tool call。这是必做项——现有 daemon injected `permissionHandler` 的 await-Promise 模型原生支持挂起+回灌,**不接受"做不到就标 degraded"**。
- degraded 逃生舱**仅**适用于 provider 协议本身不支持 deferred permission 的 path(codex **不属此类**)。走 degraded 必须举证:指出是哪一层协议机制不支持 deferred permission,不能仅因实现复杂度而降级。
- existing M1/M2 fake path 和 M2 contract tests 必须继续通过;不得为真实 adapter 改破 approval race / cancel race / `artifact_refs:false` 语义。

## Review 重点

provider integration 很容易扩 scope。本 PR 只看第一家 provider,不要混入 consensus/gate/triage。
