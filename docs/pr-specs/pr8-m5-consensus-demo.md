# PR8 SPEC - M5 Multi-Agent Consensus Demo

## 目的

用可观察的多 agent consensus run 证明 HOLP 的协议级差异点不是纸面能力。

## 当前代码事实

- PR7 应已提供 consensus/gate/triage kernel 和合法 `consensus_verdict` 产出。
- `docs/roadmap.md` M5 允许 real+fake 或 fake+fake reviewer backend。
- `protocol/spec.md` 默认 findings 用 artifact envelope,`artifact_refs:false` 时走 inline fallback。
- M5 必须独立于 M4,因为 demo 成功不能替代内核测试。

## 范围

新增端到端 demo 和验证入口。

预期产出:

- Demo scenario:
  - 一个 producer artifact
  - `produced_by_agent_id`
  - 至少两个 reviewer backend
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

## 验收

- `consensus_verdict.payload.excluded[]` 明确排除 author。
- `quorum.required`、`quorum.eligible`、`quorum.met` 与实际 panel 一致。
- `errors[]` 不混入 completed votes。
- consensus result 只作为 `events.event` 发送,且 `category=consensus`,`name=consensus_verdict`。
- `artifact_refs:true` path 展示 findings envelope。
- `artifact_refs:false` path 展示 inline findings/details fallback,同时 provenance `artifact_id` 仍可作为身份字段出现。
- 既有 contract tests 继续通过。

## Review 重点

本 PR 完成 M5。它是已测试 kernel 之上的 demo/verification layer,不是 M4 正确性的替代品。
