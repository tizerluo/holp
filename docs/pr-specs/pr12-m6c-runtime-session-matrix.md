# PR12 SPEC - M6c Runtime Surface and Session Matrix

> 状态:planned。目标是在已有真实 provider 和 consumer CLI 之后,把 HOLP 的 runtime surface / session vocabulary 做成可检查的矩阵,并给 cmux/direct session/ACP 后续接入留出诚实边界。该 PR 不是 12-agent 全实现。

## 目的

让用户和 consumer 能清楚看到:每个 harness 在 `headless`、`acp`、`direct_user_session` 下到底能不能调度,需要什么 direct channel 能力,隔离 readiness 是 ready/degraded/rejected,以及哪些只是保留声明。

完成后,HOLP 的体验不再只是 "发现几个 transport",而是能用一张矩阵解释为什么某个 agent 能做 coder/reviewer,为什么另一个只能被拒绝或需要人工接入。

## 当前代码事实

- Issue #11 已把 runtime surface / isolation readiness matrix 提升为 v0.1.5 基准。
- PR8 fake registry 已展示 `headless` ready,`acp` unsupported,`direct_user_session` unknown 的声明方式。
- M4a governance store 已能 archive harness registry snapshot。
- M6 roadmap 提到 cmux adapter、direct user session 示例和 capability negotiation。
- 真实 ACP/direct session 执行仍未落地。

## 范围

做 runtime/session matrix 的 consumer-visible foundation,不强行把所有 surface 都实现成 ready。

预期产出:

- Matrix report:
  - CLI 能打印每个 agent 的 runtime surface、runtime kind、direct channel capabilities、isolation profiles、readiness、global mutation risk。
  - 能解释 unsupported/unknown/rejected 的原因。
  - 能显示 declared_not_enforced / state_declaration_ref。
- Adapter declaration hardening:
  - fake、mcp-codex、第二 provider adapter 的 matrix 字段保持一致。
  - stub adapters 不能留空 matrix。
  - direct_user_session 只有 attach/inject/interrupt/cancel 能力清楚时才可进入 ready/degraded。
- Consumer/session examples:
  - cmux adapter 示例文档或 fixture,说明 `events.subscribe` 与 cmux event model 的映射差异。
  - direct user session 词表示例,区分 product session 与 terminal session。
  - terminal session(Warp/cmux/tmux)必须声明 route boundary 和 attach/inject/interrupt/cancel 能力。
- Governance:
  - registry archive 能保存并展示矩阵 snapshot。
  - 不新增 public governance query API,除非另有 SPEC。
- Tests:
  - matrix report 不把 missing declaration 当 ready。
  - unsupported surface 的 profiles 不可被调度。
  - direct session 缺能力时 fail-closed。

## 非目标

- 不实现完整 ACP runtime。
- 不控制 Warp/cmux/tmux 真实 UI。
- 不做 Web transport。
- 不做 Remote execution。
- 不声称 12 个 agent 都 ready。
- 不把 declared readiness 当作 OS/provider 隔离强制执行证明。

## 验收

- CLI/consumer 能展示 runtime/session matrix。
- 每个注册 agent 至少覆盖 `headless`、`acp`、`direct_user_session` 三类 surface 的显式声明。
- 缺 matrix 或 rejected profile 的 agent 不能被调度。
- direct_user_session 缺 attach/inject/interrupt/cancel 任一必需能力时 fail-closed。
- matrix report 能显示 global mutation risk 和 declared_not_enforced。
- docs 解释 unsupported/unknown surface 下 profile readiness 用 rejected 的含义。
- README / roadmap 只声称 runtime/session matrix foundation,不声称完整 adapter matrix。

## Review 重点

本 PR 的价值是诚实可见,不是把格子全涂成绿色。review 时优先检查:

- 是否有空 matrix 被默认 ready。
- unsupported/unknown 是否被误解释为 degraded 可调度。
- direct session 能力是否足够具体。
- consumer report 是否暴露了选择原因。
- 文档是否继续明确 "声明不等于强制隔离"。
