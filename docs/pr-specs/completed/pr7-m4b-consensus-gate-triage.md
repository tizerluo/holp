> status: completed — PR7 shipped; see pr-specs README landed foundation list and README M4b checkbox.

# PR7 SPEC - M4b Consensus Gate Triage Kernel

## 目的

完成 M4 的纯治理内核:consensus aggregation、author exclusion、quorum computation、最小 gate/triage 逻辑。

## 当前代码事实

- PR6 应已提供 internal event/decision/state foundation。
- PR6 应已提供 harness runtime surface / isolation readiness registry foundation。PR7 不能退回只按 transport/role/status 选择 agent。
- `protocol/spec.md` §6 定义 `consensus_verdict`、quorum、errors、excluded、provenance。
- `protocol/spec.md` §7 定义 approval 是唯一人工介入通道。
- `docs/positioning.md` 说明 loopwright 提供 `aggregateVerdict`/`aggregateConsensus` 和 `reviewerCandidates` 思路,但 HOLP wire 是新设计。

## 范围

新增纯逻辑模块和 wire integration。

预期产出:

- Consensus aggregator(**搬一半 + 新建一半,别低估**):
  - 接收 reviewer results
  - 计算 `outcome`
  - 计算 `max_severity`
  - 区分 completed / timeout / error / abstain
  - 工作量校准(对照 loopwright):`aggregateVerdict`(取最严 verdict)/`aggregateMaxSeverity` 是纯函数,可直接复用——这是"搬"的部分。但 loopwright 的输出只有 `{verdict, maxSeverity, engines, allFailed}` **4 字段**,HOLP wire 的 `consensus_verdict` 要 `outcome`/`max_severity`/`quorum{required,eligible,met}`/`excluded[]`/`reviews[]`/`errors[]` **10+ 字段**。`quorum`/`excluded`/`reviews`/`errors` 这套 loopwright **完全没有**,需新写一个 `buildConsensusVerdict(aggregated, panel, authorId, results)` wire 适配层——这是"新建"的部分,且是 PR7 体量主体。
- Author exclusion:
  - 使用 `target.produced_by_agent_id`
  - 填充 `excluded[]`
- Quorum computation:
  - `required`
  - `eligible`
  - `met`
  - 正常 verdict 不允许 `met:false`
- Reviewer panel validation:
  - unknown agent
  - role mismatch
  - rejected agent
  - degraded agent 缺 reviewer role
- Runtime/isolation eligibility validation:
  - reviewer/coder/tester 的 required runtime surface 是否 declared
  - required isolation profile 是否 ready 或 policy 明确接受 degraded
  - `direct_user_session` 是否声明 attach/observe/read 观察能力与 inject/interrupt/cancel 控制能力
  - global mutation risk 是否与 gate policy 兼容
- 最小 triage/gate hooks:
  - 足够展示 decision 和 approval interaction
  - 不暴露 v0.2 gate protocol surface
- 产出 HOLP `consensus_verdict` event。

## 非目标

- 不把 M5 demo 当成唯一正确性证明。
- 不新增第二家真实 provider,除非 M3 已经落地。
- 不把 gate object/event/outcome 暴露成稳定 wire。
- 不 wholesale copy loopwright。
- 不实现 12 个 agent 的三类运行面 adapter;本 PR 只消费 PR6 的声明矩阵做选择和拒绝。

## 验收

- aggregation 有独立单元测试。
- author exclusion 和 quorum math 有独立测试。
- rejected/degraded/role mismatch 处理符合 `protocol/spec.md`。
- runtime surface / isolation profile 不满足时 fail-closed,不得把 agent 整体 `ready` 当成可调度。
- read-only reviewer 不能被分配到会写 workspace 或需要 user_global_install 的 profile,除非 policy 明确升级给人。
- gate/approval interaction 不绕过 §7 approval state machine。
- fake backend run 能发出合法 `consensus_verdict`。
- M2 contract tests 继续通过。

## Review 重点

本 PR 完成 M4。M5 仍应单独做,因为端到端 demo 不能替代内核单元正确性。
