# PR1 SPEC - M0 Contract Surface Freeze

## 目的

在写 runtime 前,把 v0.1.4 协议面整理成可 review、可实现、可测试的契约材料。本 PR 是文档冻结门,不写 daemon。

## 当前代码事实

- `protocol/spec.md` 是唯一协议定义。
- `protocol/version.md` 描述 v0.1.4 范围和 changelog。
- `docs/roadmap.md` 的 M0 要求方法、事件、错误码、语义边界、capability、JSON example 清单。
- 当前没有 `daemon/`、`consumers/`、`tests/`、runtime package。
- `adapters/agent-backend.ts` 和 `adapters/registry.ts` 只有 contract/stub。

## 范围

只更新或新增 `protocol/`、`docs/` 下的契约文档。

必须产出:

- 方法清单:`initialize`、`flock.declare`、`flock.discover`、`orchestrate.run`、`events.subscribe`、`events.unsubscribe`、`approval.resolve`、`task.cancel`、`artifact.get`。
- 事件清单:五个 category(`run`/`agent`/`consensus`/`approval`/`lifecycle`)和关键 name;明确 artifact 不是事件 category。
- 错误码清单:`protocol/spec.md` §10 的所有 HOLP `-320xx` code,以及 HOLP 使用的 JSON-RPC 标准错误。
- capability 清单:`consensus`、`approval`、`unattended_loop`、`artifact_refs`。
- 语义边界清单:
  - `artifact_refs` 只控制 evidence envelope,不控制 provenance `artifact_id`。
  - unknown agent / invalid category / role mismatch 分别走独立错误码。
  - rejected/degraded agent 在 role/panel 中的处理要明确。
  - Remote 不进入 v0.1.x wire。
- 每个方法至少一组 request/response example;关键 notification 各至少一条 example。

## 非目标

- 不新增 daemon/runtime。
- 不新增 fake backend。
- 不新增真实 provider adapter。
- 不新增 test runner。
- 除非发现阻塞实现的契约矛盾,否则不改 `AgentBackend` contract。

## 验收

- 每个方法、事件 category/name、错误码都能回链到 `protocol/spec.md`。
- `protocol/version.md` 和 `README.md` 不声称 daemon、consumer、tests、真实 adapter 已存在。
- `docs/roadmap.md` 仍明确实现项未落地。
- 范围回归检查按意图拆分,避免把合法 changelog/否定说明当误报:
  - 当前版本声明必须仍是 v0.1.4 draft:`rg -n "v0\\.1\\.4 \\(draft\\)" protocol/spec.md protocol/version.md README.md`。
  - v0.1.x wire/example 不得出现 `content_ref` 字段:`! rg -n '"content_ref"\\s*:' protocol docs README.md`。允许在"不返回 content_ref"这类否定说明中出现该词。
  - v0.1.x wire/example 不得出现 Remote execution shape:`! rg -n '"execution_mode"\\s*:\\s*\\{\\s*"kind"\\s*:\\s*"Remote"' protocol docs README.md`。允许 Remote 出现在 future/non-goal/changelog 语境中。
- 除文档/协议注释外,不改 runtime 源码。

## Review 重点

这是冻结门。如果 PR 开始写 daemon 或测试框架,就不再是 M0,应拆分。
