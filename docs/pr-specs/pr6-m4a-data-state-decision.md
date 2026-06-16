# PR6 SPEC - M4a Data State Decision Skeleton

## 目的

引入治理内核需要的数据骨架和 run state machine,但不实现完整 consensus/gate/triage kernel。

## 当前代码事实

- 当前仓没有 persistence layer。
- Roadmap M4 要求 events-decisions-registry 数据骨架、decision record 写入、run state machine。
- `protocol/spec.md` §11 说明 gate 字符串在 v0.1.x 仍是 daemon 私约定。
- `protocol/spec.md` §12 说明 loopwright 是参考素材,不是整仓搬运。

## 范围

新增 daemon 内部 governance state 模块。

预期产出:

- 内部 event record 类型,区别于 wire notification。
- decision record 类型和 writer。
- registry data model,来源于 flock state 观测到的 agent/harness。
- run state machine,至少覆盖:
  - queued
  - running
  - waiting_approval
  - cancelling
  - terminal states
- 优先内存实现;如果加持久化,必须保持 PR 可 review。
- 必要的 internal event/decision → wire event 映射。

## 非目标

- 不实现完整 consensus aggregation。
- 不实现 gate/triage policy engine,除非是 state transition 所需 placeholder。
- 不 wholesale import loopwright 文件。
- 不加 Remote、Web、真实 provider 工作。

## 验收

- fake run 能记录 events 和至少一个 `decision_made` 风格 decision。
- state transition 有测试,非法 transition 会拒绝。
- `task.cancel` 和 approval terminal behavior 接入 state machine。
- M2 contract tests 继续通过。
- README/version 不声称 M4 完成,除非明确标 partial。

## Review 重点

这是 M4 内部纪律性拆分。data/state/decision 必须能独立 review,不要同时审 consensus policy。
