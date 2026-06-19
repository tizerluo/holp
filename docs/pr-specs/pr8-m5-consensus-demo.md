# PR8 SPEC - M5 Multi-Agent Consensus Demo

> 状态(PR8):deterministic unanimous-approve fake+fake demo 已落地。`npm run demo:m5` 通过真实 stdio JSON-RPC daemon wire 跑两条场景:`artifact_refs:true` findings artifact envelope 和 `artifact_refs:false` inline fallback。该 demo 不接真实 reviewer backend,不覆盖 dissent/timeout demo,不新增稳定 gate surface。

## 目的

用可观察的多 agent consensus run 证明 HOLP 的协议级差异点不是纸面能力。

## 当前代码事实

- PR7 应已提供 consensus/gate/triage kernel 和合法 `consensus_verdict` 产出。
- PR7 应已消费 PR6 的 runtime surface / isolation readiness matrix。M5 demo 不能退回只展示 transport/role/status。
- `docs/roadmap.md` M5 允许 real+fake 或 fake+fake reviewer backend。
- `protocol/spec.md` 默认 findings 用 artifact envelope,`artifact_refs:false` 时走 inline fallback。
- M5 必须独立于 M4,因为 demo 成功不能替代内核测试。
- 当前 PR8 采用 fake+fake deterministic unanimous-approve reviewer path:producer/reviewer 声明仍走真实 flock/orchestrate/event/artifact wire,但 reviewer votes 由 fake consensus path 合成,不表示真实 reviewer provider sessions 或 dissent/timeout demo 已执行。
- fake fixture 的 `acp` / `direct_user_session` 只用于展示非 headless surface 的显式声明。因 isolation readiness 枚举只有 `ready | degraded | rejected`,unsupported/unknown surface 下的 profiles 使用 `rejected` 表达"该 surface 不可调度",不表示做过 profile 级真实隔离探测。

## 范围

新增端到端 demo 和验证入口。

预期产出:

- Demo scenario:
  - 一个 producer artifact
  - `produced_by_agent_id`
  - 至少两个 reviewer backend
  - producer/reviewer fixture 明确声明 runtime surface、runtime kind、isolation profile readiness
  - reviewer panel 排除 producer
  - 至少一个 completed review
  - 可选 timeout/error/abstain case
- consumer-facing event stream output。
- findings evidence:
  - artifact envelope path
  - `artifact_refs:false` inline fallback path
- deterministic script/test command。

## 非目标

- 不做产品 UI。
- 不加 Remote/cloud execution。
- 不用 demo 成功降低 M4 unit-level tests 要求。
- 不要求多个真实 provider;fake+fake 可接受,只要 wire path 真实。
- 不把 demo 成功解释成 12 个 agent 的 `headless` / `acp` / `direct_user_session` 都已支持。
- 不实现 direct_user_session 产品/终端会话 demo;除非后续 consumer/session PR 已经提供 Happy/Happier 或 Warp/cmux/tmux 接入。

## 验收

- `consensus_verdict.payload.excluded[]` 明确排除 author。
- `quorum.required`、`quorum.eligible`、`quorum.met` 与实际 panel 一致。
- `errors[]` 不混入 completed votes。
- demo 输出能看到被选中的 reviewer 是在某个 runtime surface + isolation profile 下可调度,而不是 agent 整体 ready。
- unsupported/unknown runtime surface 在 demo fixture 中应显式出现为 unsupported/unknown/rejected,证明协议不会把空白当 ready。
- consensus result 只作为 `events.event` 发送,且 `category=consensus`,`name=consensus_verdict`。
- `artifact_refs:true` path 展示 findings envelope。
- `artifact_refs:false` path 展示 inline findings/details fallback,同时 provenance `artifact_id` 仍可作为身份字段出现。
- 既有 contract tests 继续通过。

## Review 重点

本 PR 完成 M5。它是已测试 kernel 之上的 demo/verification layer,不是 M4 正确性的替代品。
