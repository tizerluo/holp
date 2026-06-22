# PR12 SPEC - M6c Runtime Surface and Session Matrix

> 状态:partial landed。目标是在已有真实 provider 和 consumer CLI 之后,把 HOLP 的 runtime surface / session vocabulary 做成可检查的矩阵,并给 cmux/direct session/ACP 后续接入留出诚实边界。该 PR 不是 12-agent 全实现。

## 目的

让用户和 consumer 能清楚看到:每个 harness 在 `headless`、`acp`、`direct_user_session` 下到底能不能调度,需要什么 direct channel 能力,隔离 readiness 是 ready/degraded/rejected,以及哪些只是保留声明。

完成后,HOLP 的体验不再只是 "发现几个 transport",而是能用一张矩阵解释为什么某个 agent 能做 coder/reviewer,为什么另一个只能被拒绝或需要人工接入。

## 当前代码事实

- Issue #11 已把 runtime surface / isolation readiness matrix 提升为 v0.1.5 基准。
- PR8 fake registry 已展示 `headless` ready,`acp` unsupported,`direct_user_session` unknown 的声明方式。
- M4a governance store 已能 archive harness registry snapshot。
- `permission_surface` / `observability_surface` 目前只存在于 internal governance registry,并统一记录为 `unknown`;它们不在 `flock.declare` / `flock.discover` public wire response 中。
- PR12 已把 direct channel 词表补成 attach/observe/read 与 inject/interrupt/cancel 分离;consumer CLI report 已按 observation/control 两组展示。
- M6 roadmap 提到 cmux adapter、direct user session 示例和 capability negotiation。
- 真实 ACP/direct session 执行仍未落地。

## 已落地范围

- `DirectChannelDeclaration` 增加 `observe` / `read`,用于表达 output stream / transcript 是否可见。
- fake、stub、mcp-codex、native-claude 的 declarations 均显式覆盖 `headless`、`acp`、`direct_user_session`;unsupported/unknown surface 下的 profiles 使用 rejected,表示不可调度,不表示做过 profile 级真实隔离探测。
- `flock.discover probe:false` 返回三 surface 的 not_probed matrix,不再只返回 headless 占位。
- consumer CLI 的 `renderRuntimeMatrix` 只从 flock public wire response 渲染 matrix,显示 runtime kind、surface support、direct channel observation/control、isolation profile readiness、reason/missing/warnings、global mutation、declared_not_enforced、state_declaration_ref,并明确 `descriptive_only=true`。
- `docs/runtime-session-matrix.md` 记录 product session / terminal session direct channel 示例,并明确 cmux/Warp/tmux 真实 event model mapping 需要后续引用具体版本/commit。

## 仍未落地

- 真实 ACP runtime。
- cmux/Warp/tmux/direct user session UI 控制或真实 event model mapping。
- public governance query API。
- 稳定 scheduling/gate protocol surface。
- `state_declaration_ref` 可解引用能力;当前仍是声明引用/占位字符串。

## 范围

做 runtime/session matrix 的 consumer-visible foundation,不强行把所有 surface 都实现成 ready。

预期产出:

- Matrix report:
  - CLI 能打印每个 agent 的 runtime surface、runtime kind、direct channel capabilities、isolation profiles、readiness、global mutation risk。
  - matrix report 是 descriptive projection,不是 scheduling authority;调度仍由 orchestrate.run 的 eligibility resolver / isolation gating 决定。
  - 能解释 unsupported/unknown/rejected 的原因,并区分 surface-level unsupported/unknown 派生的 rejected 与 profile-level probe/enforcement failure。
  - 能显示 declared_not_enforced / state_declaration_ref。
  - 数据源只使用 `flock.declare` / `flock.discover` public wire response 中的 `runtime_surfaces` 等字段;不得读取 governance internal store。
- Adapter declaration hardening:
  - fake、mcp-codex、第二 provider adapter 的 matrix 字段保持一致。
  - stub adapters 不能留空 matrix。
  - direct_user_session 的 direct channel 词表需要加入 `observe` 或 `read` 能力,用于表达 output stream / transcript 是否可见。
  - direct channel report 必须分成 observation surface 与 control surface:attach/observe/read 只证明可看见或连接,inject/interrupt/cancel 才是控制能力;两者不得合并成一个 ready 标记。
  - direct_user_session 必须区分 observe-only 与 injectable/controllable session:attach+observe 可声明只读观察能力;inject/interrupt/cancel/owner_scope 不可信时不得声明可注入调度 ready。
- Consumer/session examples:
  - cmux adapter 示例文档或 fixture,说明 `events.subscribe` 与 cmux event model 的映射差异;映射字段必须标注来源(公开文档、具体版本、或引用 commit)。无可信来源的 cmux 字段不得编造。
  - direct user session 词表示例,区分 product session 与 terminal session。
  - terminal session(Warp/cmux/tmux)必须声明 route boundary、owner_scope、attach/observe/inject/interrupt/cancel 能力。
- Governance:
  - registry archive 继续保存 internal matrix snapshot,但 PR12 不新增 public governance query API。
  - `permission_surface` / `observability_surface` 本 PR 不展示到 CLI report,保持 internal reserved unknown;后续若要展示,必须先有单独 governance/wire SPEC。
- Tests:
  - matrix report 不把 missing declaration 当 ready。
  - matrix `ready` 显示不绕过 orchestrate.run eligibility gating;renderer test 不得把 report 行直接当调度许可。
  - unsupported surface 的 profiles 不可被调度。
  - `unknown` 与 `unsupported` 都不可调度;只有 readiness `ready` 且 eligibility resolver 通过时才可执行。
  - surface-level unsupported/unknown 派生 rejected 不得被渲染成 profile probe failure。
  - direct session 缺 attach/observe/owner_scope 时整条 fail-closed;缺 inject/interrupt/cancel 时不得进入可注入调度 readiness,但可保留 observe-only readiness。
  - `global_mutation_required:true` 的 agent 不得满足 `read_only_review`,与现有 `orchestrate.run` isolation fail-closed 语义一致。

## 非目标

- 不实现完整 ACP runtime。
- 不控制 Warp/cmux/tmux 真实 UI。
- 不做 Web transport。
- 不做 Remote execution。
- 不声称 12 个 agent 都 ready。
- 不把 declared readiness 当作 OS/provider 隔离强制执行证明。
- 不把 matrix report 当作 public scheduling API 或可执行许可。
- 不展示 governance internal-only 的 `permission_surface` / `observability_surface` 为 public CLI matrix 字段。
- 不声称 cmux/Warp/tmux 真实 UI 已接;没有可信 event model 来源时只保留词表/fixture 边界说明。

## 验收

- CLI/consumer 能展示 runtime/session matrix。
- 每个注册 agent 至少覆盖 `headless`、`acp`、`direct_user_session` 三类 surface 的显式声明。
- 缺 matrix 或 rejected profile 的 agent 不能被调度。
- direct_user_session 缺 attach/observe/owner_scope 时 fail-closed;缺 inject/interrupt/cancel 时不得进入可注入调度 readiness,但可声明 observe-only readiness。
- matrix report 能显示 global mutation risk、declared_not_enforced、state_declaration_ref 和 direct channel owner_scope。
- `global_mutation_required:true` 的 agent 在 `read_only_review` 下 fail-closed,并显示 reason。
- `global_mutation_required:true` 必须继续传播到 orchestrate.run isolation/eligibility gate;CLI report 只能展示原因,不能替 gate 做决定。
- matrix report 仅从 flock wire response 构造;renderer tests 至少包含一条 JSON round-trip 的 `runtime_surfaces` fixture,不得 import governance internal store。
- docs 解释 unsupported/unknown surface 下 profile readiness 用 rejected 的含义。
- report 对 rejected 必须显示 reason,并区分 surface-level unsupported/unknown 与 profile-level probe/enforcement failure。
- `state_declaration_ref` 如仍是占位字符串,docs 必须说明本 PR 不保证可解引用。
- 如果 PR11 native-claude 在本机 probe 为 degraded/rejected,PR12 只能展示 honest second-provider degraded/rejected matrix,不能声称第二 provider runtime matrix ready。
- README / roadmap 只声称 runtime/session matrix foundation,不声称完整 adapter matrix。

## Review 重点

本 PR 的价值是诚实可见,不是把格子全涂成绿色。review 时优先检查:

- 是否有空 matrix 被默认 ready。
- unsupported/unknown 是否被误解释为 degraded 可调度。
- direct session 能力是否足够具体。
- consumer report 是否暴露了选择原因。
- consumer report 是否偷读 governance internal store。
- observe/read 与 inject/interrupt/cancel 是否被混为一种 ready。
- matrix descriptive view 是否被误用成 scheduling authority。
- owner_scope、global_mutation_required、declared_not_enforced 是否足够醒目。
- 文档是否继续明确 "声明不等于强制隔离"。
