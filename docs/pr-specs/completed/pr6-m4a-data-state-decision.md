> status: completed — PR6 shipped; see pr-specs README landed foundation list and README M4a checkbox.

# PR6 SPEC - M4a Data State Decision Skeleton

## 目的

引入治理内核需要的数据骨架和 run state machine,但不实现完整 consensus/gate/triage kernel。

## 当前代码事实

- 当前仓没有 persistence layer。
- Roadmap M4 要求 events-decisions-registry 数据骨架、decision record 写入、run state machine。
- `protocol/spec.md` §11 说明 gate 字符串在 v0.1.x 仍是 daemon 私约定。
- `protocol/spec.md` §12 说明 loopwright 是参考素材,不是整仓搬运。
- Issue #11 的 [Cross-Agent Harness Isolation](./issue-11-agent-harness-isolation.md) SPEC 已提升为 v0.1.5 协议基准修订来源。PR6 的 registry/run metadata 设计必须承载 runtime surface / isolation readiness matrix,避免只存 transport string 或只按 agent 整体 `ready` 调度。

## 范围

新增 daemon 内部 governance state 模块。

预期产出:

- 内部 event record 类型,区别于 wire notification。
- decision record 类型和 writer。
- registry data model,来源于 flock state 观测到的 agent/harness,但必须把以下字段作为一等治理数据:
  - `harness_id`
  - `vendor`
  - `transport_class`
  - `runtime_surface`(`headless` / `acp` / `direct_user_session`)
  - `runtime_kind`
  - `surface_support`
  - `direct_channel`(仅 direct user session)
  - `isolation_profile`
  - `isolation_status`
  - `state_declaration_ref`
  - `global_mutation_required`
  - `permission_surface`
  - `observability_surface`
- run state machine,至少覆盖:
  - queued
  - running
  - waiting_approval
  - cancelling
  - terminal states
- run metadata 必须记录本次实际选择的 `runtime_surface`、`runtime_kind`、`isolation_profile`、`isolation_status`、`state_declaration_ref`,不能只记录 agent id / transport / role。
- 优先内存实现;如果加持久化,必须保持 PR 可 review。
- 必要的 internal event/decision → wire event 映射。

## 非目标

- 不实现完整 consensus aggregation。
- 不实现 gate/triage policy engine,除非是 state transition 所需 placeholder。
- 不 wholesale import loopwright 文件。
- 不加 Remote、Web、真实 provider 工作。
- 不实现 product session / terminal session adapter;PR6 只建立数据骨架,但骨架必须能表达 Happy/Happier product session 与 Warp/cmux/tmux terminal session。

## 验收

- fake run 能记录 events 和至少一个 `decision_made` 风格 decision。
- registry/run metadata 能表达同一 harness 在不同 runtime surface / isolation profile 下的 `ready` / `degraded` / `rejected`。
- `flock.declare`/`flock.discover` 的内部归档不得把 `runtime_surfaces` 丢弃;缺失矩阵时必须记录 unknown/unsupported/rejected,不能默认为 ready。
- state transition 有测试,非法 transition 会拒绝。
- `task.cancel` 和 approval terminal behavior 接入 state machine。
- M2 contract tests 继续通过。
- README/version 不声称 M4 完成,除非明确标 partial。

## Review 重点

这是 M4 内部纪律性拆分。data/state/decision 必须能独立 review,不要同时审 consensus policy。
