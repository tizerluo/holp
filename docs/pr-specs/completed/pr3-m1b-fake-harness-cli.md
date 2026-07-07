> status: completed — PR3 shipped; see pr-specs README landed foundation list.

# PR3 SPEC - M1b Fake Harness and CLI

## 目的

用 fake backend、内存 stores、最小 consumer 跑通 M1 协议闭环。

## 当前代码事实

- PR2 应已提供 `daemon/` substrate。
- `adapters/agent-backend.ts` 定义 `AgentMessage`、`PermissionVerdict`、`AgentBackend`、`AgentBackendFactory`。
- `adapters/registry.ts` 仍是 stub registry,没有真实 agent。
- `docs/roadmap.md` M1 验收要求跑通 `initialize -> flock.declare -> orchestrate.run -> events.subscribe -> approval.resolve -> artifact.get`。

## 范围

新增 fake implementation 和最小 consumer。

预期新增:

- 仅用于 demo/test 的 fake `AgentBackendFactory`。
- 内存 stores:
  - run store
  - subscription store
  - artifact store
  - approval store
  - flock state
- method handlers:
  - `flock.declare`
  - `flock.discover`
  - `orchestrate.run`
  - `approval.resolve`
  - `task.cancel`
  - `artifact.get`
- `consumers/cli/` 下最小 CLI,或 `tests/fixtures/` 下脚本化 consumer。
- deterministic demo scenario,至少发出:
  - run lifecycle event
  - agent event
  - approval request
  - approval resolved
  - artifact envelope 或 inline fallback

## 非目标

- 不接 native Claude / Codex / ACP。
- 不做持久化数据库。
- 不搬 loopwright governance kernel。
- 不做 multi-agent consensus demo;若 M1 wire 需要,只允许 canned fake consensus event。

## 验收

- 单条命令跑通 `initialize -> flock.declare -> orchestrate.run -> events.subscribe -> approval.resolve -> artifact.get`。
- 每条事件都有 `subscription_id`、`seq`、`ts`、`run_id`、`category`、`name`、`payload`。
- `seq` 从 1 开始;`latest_seq:0` 表示尚无事件。
- `flock.declare`/`flock.discover` 对 unsupported transport 返回 per-agent `status=rejected`,不抛 JSON-RPC error。
- `artifact.get` 总返回 `content`,截断显式。
- `task.cancel` 对终态 run 幂等,未知 run 返回 `run_not_found`。
- README/version 不声称真实 adapter 已连接。

## Review 重点

本 PR 完成 M1,但 M2 才拥有完整 contract regression suite。fake 行为要简单、确定、不要假装真实 provider。
