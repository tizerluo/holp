# PR11 SPEC - M6b Second Real Provider Adapter

> 状态:planned。目标是在 Codex app-server 之外接入第二个真实 provider,优先选择 `native-claude` headless reviewer path。该 PR 证明 adapter contract 不是 Codex-only,但不追求 12-agent 完整矩阵。

## 目的

让 HOLP 至少能编排两类真实 provider:一个 producer/coder 可以来自 Codex,一个 reviewer 可以来自第二 provider。这样 HOLP 的 vendor-neutral 主张开始有真实支撑。

## 当前代码事实

- `mcp-codex` 已是首个真实 adapter。
- `native-claude` / `acp` 仍是 stub。
- PR9 预计提供真实 reviewer execution pilot。
- PR10 预计提供 consumer-facing CLI,能展示 reviewer selection、approval、artifact、consensus report。
- runtime surface / isolation readiness matrix 已是 v0.1.5 基准,新增 provider 不能退回 transport/status-only。

## 范围

实现第二真实 provider adapter 的最小可用 headless path。默认候选为 `native-claude` reviewer adapter;如果实际本地 CLI/auth 不可用,实现必须 honest degraded/rejected,而不是假 ready。

预期产出:

- Adapter factory:
  - provider availability probe。
  - `flock.declare` / `flock.discover` 返回 honest `ready | degraded | rejected`。
  - 支持 reviewer role 的 headless execution。
  - 映射 provider output 到 HOLP reviewer result。
- Runtime declaration:
  - `headless + read_only_review` 是首要目标。
  - `coder_worktree` 只有在真实可安全执行时才声明 ready;否则 degraded/rejected。
  - `acp` / `direct_user_session` 未实现时必须显式 unknown/unsupported/rejected。
  - `global_mutation_required` 必须按 provider 真实需求声明。
- Smoke:
  - fake/app-server tests 默认跑。
  - real provider smoke 用 env flag opt-in。
  - 缺 binary/auth/quota 时返回 skipped/rejected,不失败成假阴性。
- Docs:
  - README / roadmap / version 只声明第二 provider headless reviewer partial。
  - 不声称 Claude/Kimi/Gemini/Cursor 全部完成。

## 非目标

- 不实现所有 Claude Code 功能。
- 不接 Kimi/Gemini/Cursor。
- 不实现 ACP 真实 session。
- 不实现 direct user session。
- 不让第二 provider 当默认 coder。
- 不改变 adapter contract。
- 不把外部验证 CLI 当作 HOLP adapter,除非它通过 adapter contract 接入。

## 验收

- `flock.discover` 可以返回第二 provider 的 honest readiness。
- 有 `mcp-codex` producer + 第二 provider reviewer 的 opt-in smoke 能跑到 consensus verdict,或在本机不可用时给出明确 rejected/degraded reason。
- reviewer result 必须通过 PR9 的严格结构化校验。
- author exclusion、quorum、findings artifact/inline fallback 与单 provider path 一致。
- 缺 provider binary/auth 时不假装 ready。
- runtime matrix 包含 headless/acp/direct_user_session 三类 surface 的显式声明。
- tests 覆盖 availability probe、role support、runtime matrix、provider output parse failure。

## Review 重点

本 PR 最容易失焦成 "接一堆 provider"。review 时优先检查:

- 第二 provider 是否真的通过 HOLP adapter contract,而不是测试脚本旁路。
- runtime/isolation 声明是否 honest。
- provider output parse failure 是否 fail-closed。
- opt-in smoke 是否不污染默认 CI。
- 是否把 provider-specific 字段泄漏进 HOLP stable wire。
