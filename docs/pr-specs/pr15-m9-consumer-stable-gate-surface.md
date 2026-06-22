# PR15 / M9 Consumer Stable Gate Surface

## Summary

实现 Blueprint M9:把 consensus/gate/verdict/policy/override/audit 从 demo/internal event 提升为稳定 consumer-facing surface。目标是让 CLI/TUI/external UI 能一致展示“谁审了、怎么判、为什么卡住、谁 override、artifact 在哪、runtime 是否可信”。

这不是 UI polish。验收必须包含稳定 wire shape、reference CLI 展示、artifact/approval/override audit 和 contract tests。

当前代码现实:

- consensus 事件已经有 `consensus_verdict` / `consensus_degraded`。
- approval 仍是单通道,支持 `merge_approval` 和 `semantic_decision`。
- consumer CLI 能渲染 runtime matrix、consensus verdict、artifact findings,但仍偏 demo scenario。
- governance 内部记录 decision,没有 public query API。

## Key Changes

- 定义 stable gate surface。
  - 新增 `GateReport.v1` public event payload,覆盖 target、policy、quorum、reviews、findings、runtime readiness、consensus/degraded outcome、gate_disposition、blocking reason、override state、audit refs。
  - `GateReport.v1` 是 append-only snapshot projection event。consumer 对同一 run 使用 latest `gate_report` 作为当前视图;历史 report 保留为 audit timeline。
  - `GateReport.v1.decision_surface` 是 UI/CLI summary 的唯一 truth;`consensus_snapshot` 只作为 evidence,不得反向驱动 UI 状态机。
  - `consensus_verdict` / `consensus_degraded` 保持兼容,但 consumer 不再需要猜字段。
  - gate outcome 是派生层,不能混同 consensus outcome。必须映射 `approve`、`request_changes`、`reject`、`ask_human`、`degrade_quorum`、`blocked`、`overridden`。
  - `GateReport.v1` 必须写入 `protocol/spec.md`,并通过 `initialize.capabilities.gate_report` 或协议版本协商启用;未协商的旧 consumer 仍只收旧事件。
  - 未协商 `gate_report` 时不得半发 `GateReport.v1`;只能回退旧 `consensus_*` / `run_*` events。

- approval / override / audit 单通道。
  - override 只能走 `approval.resolve` 支持的 approval kind,不得新增第二套人类决策通道。
  - gate state machine 固定:当 quorum-met verdict 为 `request_changes`/`reject`,且 policy 要求 human gate/override 时,daemon 必须 mint `semantic_decision` approval,run 进入 `waiting_approval`,不得先 terminal `blocked`。
  - unattended auto-reject、approval rejection/expiry、或 policy 不允许 override 时,才进入 terminal `blocked`。
  - gate finalization invariant:pending approval 优先于 blocked;`waiting_approval` 不是 terminal;`blocked` 必须意味着没有 pending gate approval。
  - terminal `blocked` 且没有 pending approval 的 run 不可 override;调用 `approval.resolve` 必须 fail-closed。
  - `approval.resolve` 增加可选 audit params:`reason`、`previous_gate_outcome`、`new_gate_outcome`、`artifact_refs`;这些仍属于同一 approval channel。
  - `approval.resolve` 不直接 mutate GateReport fields;它只发出 approval/override 事件,随后由 gate report builder 从事件流生成新的 `GateReport.v1` snapshot。
  - public audit 通过事件发出,例如 `gate_report` / `gate_overridden` 或带 override fields 的 `approval_resolved`;不能要求 consumer 读取 internal governance。
  - `task.cancel` 是 run abort,不是 gate override;它永不产生 `overridden` outcome。
  - `task.cancel` 必须作为独立 `runtime_control_event`/run abort timeline 渲染,不得并入 override。

- reference CLI 从 demo 变成 consumer 工具。
  - 保留 raw/debug,但默认输出必须是人可读 report。
  - 支持 single/multistep/gated run 的统一 summary。
  - 能展示 runtime/session matrix、step history、approval pending/resolved/expired、gate verdict、artifact findings、override audit。
  - 对 artifact refs true/false 都能显示同等信息。

- consumer contract。
  - CLI/TUI/external UI 都以同一 stable report shape 渲染。
  - 不暴露 provider 私有字段;provider 原始输出只作为 artifact/debug。
  - public protocol 文档更新,明确哪些是 stable,哪些仍是 daemon internal。
  - `artifact_refs:true/false` 必须保证 verdict/quorum/outcome/blocking/override 字段等价;findings/evidence bytes 可因 inline/envelope 截断不同,但必须显示 `truncated`。
  - `GateReport.v1` canonical serialization 必须稳定:reviews/findings/audit refs 排序固定,截断必须带 `truncated:true` 和 reason。
  - CLI 输出分三层:默认 human summary、可选 structured report、显式 raw/debug provider frames。
  - approval kind 是 sealed enum;未知 kind fail-closed,不得让 gate surface 被任意 approval kind 扩张。

## Test Plan

- Unit tests:
  - gate report builder 对 approve/reject/request_changes/degraded/override 生成稳定 shape。
  - `decision_surface` 是唯一 summary truth;`consensus_snapshot` 字段变化不会改变 UI disposition。
  - `degrade_quorum`、`consensus_degraded` only、single run no consensus 都能生成合法 `GateReport.v1`。
  - artifact envelope 与 inline fallback 渲染等价。
  - override audit 必填字段缺失时 fail-closed。
  - `GateReport.v1` serialization 顺序和 truncation marker 稳定。

- Contract / CLI tests:
  - single coder run 没有 gate 时仍有 summary。
  - reviewer panel approve/reject/request_changes 分别产生稳定 gate report。
  - quorum-met reject/request_changes 在 human gate policy 下 mint pending approval,resolve 后产生 override audit。
  - `ask_human` degradation 分支也通过 approval 单通道完成 override。
  - terminal blocked 且无 pending approval 时,late override fail-closed。
  - expired/cancelled approval 不会产生 override。
  - `approval.resolve` 只发 event;latest `GateReport.v1` 由事件派生,不存在 direct mutation。
  - `task.cancel` 不发 `gate_overridden`,并在 CLI 中独立显示为 abort。
  - CLI raw/debug 与 human output 边界清楚,默认不打印未脱敏 provider blob。
  - M5 demo 场景继续通过。
  - `gate_report` capability 未协商时,旧 consensus/run events 仍兼容。

- Verification:
  - `npm run typecheck`
  - `npm test`
  - CLI scenario smoke suite
  - `git diff --check`
  - `npx gitnexus detect-changes --repo holp`

## Acceptance Criteria

- consumer 可以只依赖 stable gate/report surface 渲染完整 run 审核结果。
- 人类 override 可审计、可回放、可关联 artifact。
- 多步 run、runtime matrix、gate verdict 和 approval 状态在 CLI 中形成一份完整 report。

## Out Of Scope

- 不新增 public governance query API,除非 gate report 必须最小查询;若需要,必须只暴露 gate/report,不暴露内部 store。
- 不实现 learned router。
- 不接 Remote。
