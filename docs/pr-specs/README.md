# HOLP PR SPEC

这些 SPEC 把 HOLP roadmap 拆成可 review 的 PR。PR1-PR12 覆盖 M0-M6c,用于把 consumer 体验、第二真实 provider、runtime/session matrix foundation 补齐。M7 之后的权威路线见 `docs/holp-blueprint.md`。

早期 PR 文件保留对应阶段的冻结上下文;下面的当前代码事实随实现进度更新,避免误读为“尚无 daemon/真实 adapter”。

当前代码事实:

- 已存在:`protocol/spec.md`、`protocol/version.md`、`docs/positioning.md`、`docs/roadmap.md`、`adapters/`、`daemon/`、`consumers/`、contract tests、`package.json`。
- 当前 `adapters/` 包含 contract、demo/test fake backend、Codex app-server real adapter 和 native-claude 已接三 surface;`createDefaultAdapterRegistry()` 把 `"mcp-codex"` 接到三个独立 surface(headless → app-server, acp → AcpBackend, direct_user_session → DirectTmuxBackend)、把 `"native-claude"` 接到 per-surface map(headless → ClaudeCodeBackendFactory, direct_user_session → DirectTmuxBackendFactory, acp → undefined/honest unsupported,explicit acp 不 fallback headless);`codexRuntimeSurfaces()` 对 acp 和 direct 默认 fail-closed(`codex_acp_smoke_not_enabled` / `codex_direct_smoke_not_enabled`),需 `HOLP_REAL_CODEX_SMOKE=1` 才能升 ready。`claudeRuntimeSurfaces()` 对 acp 永久 unsupported(`claude_code_no_acp`),对 direct 默认 degraded(`claude_direct_smoke_not_enabled`),需 `HOLP_REAL_CLAUDE_SMOKE=1` 才能验证。#48、#49 已落地。
- First-batch Cursor Agent、Kimi Code、OpenCode、Pi、Reasonix 的 direct surface 已由 #50 接入;ACP/native-or-bridge surface 由 #51 负责,必须以 matching ACP JSON-RPC terminal evidence 证明,不能用 headless/direct smoke 冒充。Reasonix ACP 在 #51 中保持 degraded/policy-not-certified。
- `npm run smoke:terminal-consumer` 是 #54 的 terminal-consumer smoke 入口;默认无 `HOLP_TERMINAL_CONSUMER_SMOKE=1` 时 SKIP,真实路径通过 `flock.discover` + public event wire 验证一个 #45-ready runtime surface,只可声明 `terminal-consumer-integration-ready`,不声明 `cmux-ready`。
- `createFakeRegistry()` 保留 M1/M2 demo/test fake path;CLI demo 显式用 fake registry。
- 当前 `runEngine` 已有 PR9 reviewer executor hook:`fake` reviewer 与 `mcp-codex` reviewer execution hook 都必须通过 canonical parser/validator;真实 backend 还必须通过 runtime read-only attestation gate 后才会成为 completed vote。
- 当前 consumer CLI 已能从 flock public wire response 渲染 runtime/session matrix;该报告是 descriptive projection,不是调度授权。

## PR 顺序:已落地基础

1. [PR1 - M0 Contract Surface Freeze](./pr1-m0-contract-surface.md)
2. [PR2 - M1a Protocol Substrate](./pr2-m1a-protocol-substrate.md)
3. [PR3 - M1b Fake Harness and CLI](./pr3-m1b-fake-harness-cli.md)
4. [PR4 - M2 Protocol Contract Tests](./pr4-m2-contract-tests.md)
5. [PR5 - M3 First Real Adapter](./pr5-m3-first-real-adapter.md)
6. [PR6 - M4a Data State Decision Skeleton](./pr6-m4a-data-state-decision.md)
7. [PR7 - M4b Consensus Gate Triage Kernel](./pr7-m4b-consensus-gate-triage.md)
8. [PR8 - M5 Multi-Agent Consensus Demo](./pr8-m5-consensus-demo.md)
9. [PR9 - M5b Real Reviewer Execution Pilot](./pr9-m5b-real-reviewer-execution.md)

## PR 顺序:已落地下一阶段

10. [PR10 - M6a Consumer CLI Experience](./pr10-m6a-consumer-cli-experience.md)
11. [PR11 - M6b Second Real Provider Adapter](./pr11-m6b-second-real-provider.md)
12. [PR12 - M6c Runtime Surface and Session Matrix](./pr12-m6c-runtime-session-matrix.md)

## PR 顺序:Blueprint 派生后续 SPEC

M7+ 的总路线以 [HOLP Blueprint](../holp-blueprint.md) 为准;以下 SPEC 是从 Blueprint 拆出的完整功能 PR,不是 skeleton:

13. [PR13 - M7 Foundation Loop](./pr13-m7-foundation-loop.md)
14. [PR14 - M8 Real Runtime Surface Harness Pilot](./pr14-m8-real-runtime-surface-harness-pilot.md)
15. [PR15 - M9 Consumer Stable Gate Surface](./pr15-m9-consumer-stable-gate-surface.md)
16. [PR16 - M10+M11 Learned Router and Dynamic Workflow](./pr16-m10-m11-learned-router-dynamic-workflow.md)
17. [PR17 - M12 Remote and Distributed HOLP](./pr17-m12-remote-distributed-holp.md)

## Related issue SPEC

- [Issue #11 - Cross-Agent Harness Isolation](./issue-11-agent-harness-isolation.md):v0.1.5 协议基准修订来源,定义真实 provider / 多 agent harness 隔离模型。PR6 及后续治理、adapter、consumer/session 工作必须先读取这份 SPEC,避免把 Codex smoke 的局部方案误扩成通用机制,也避免把 HOLP 做窄成 `transport + ready`。
- [Issue #45 - Multi-Agent CLI Runtime Surface Completion](./issue-45-multi-agent-cli-runtime-surface-completion.md):#41 learned-model data sufficiency 的前置 runtime-surface parity + terminal-consumer smoke 阶段。PR14 是 first-batch harness pilot,不是 bounded CLI cohort 的 headless + ACP/native-or-bridge + direct session 完整候选空间证明,也不是 cmux-ready 证明。剩余子 PR 必须按 #46 -> #47 -> #48 -> #49 -> #50 -> #51 -> #54 -> #52 串行推进;#52 通过后才允许 #41 声明 training data sufficiency。
- [Issue #47 - Generalize Direct Tmux For The Bounded CLI Cohort](./issue-47-generalize-direct-tmux-cohort.md):#45 的 direct-session foundation PR。目标是把 Kimi-only tmux direct path 泛化成 bounded cohort 可审计的 per-agent direct-session 配置/拒绝模型;#50 才负责 first-batch direct parity 全量验收。
- [Issue #48 - Codex Headless / ACP / Direct Runtime Surface Parity](./issue-48-codex-runtime-surface-parity.md):#45 的 Codex-specific runtime-surface PR。目标是让 `mcp-codex` 的 headless app-server、official `codex-acp` bridge、HOLP-owned direct tmux 三类 surface 都有独立 readiness/evidence;不得用 headless 成功冒充 ACP/direct ready。
- [Issue #49 - Claude Code Headless / ACP-Bridge / Direct Runtime Surface Parity](./issue-49-claude-code-runtime-surface-parity.md):#45 的 Claude Code-specific runtime-surface PR。目标是保留 Claude Code headless/read-only 证据,明确 Claude Code 没有 native ACP,ACP-like surface 在 #49 中保持 honest unsupported(`claude_code_no_acp`),不实现 stream-json bridge;direct 只能走 HOLP-owned throwaway tmux。
- [Issue #50 - First-Batch Direct Session Parity](./issue-50-first-batch-direct-session-parity.md):#45 的 first-batch direct-session PR。目标是让 Cursor Agent、Kimi Code、OpenCode、Pi、Reasonix 都有明确 direct state 和 direct-only smoke/evidence;不得用 headless/ACP 结果冒充 direct ready。
- [Issue #51 - First-Batch ACP Readiness Hardening](./issue-51-first-batch-acp-readiness-hardening.md):#45 的 first-batch ACP/native-or-bridge PR。目标是让 Cursor Agent、Kimi Code、OpenCode、Pi、Reasonix 都有真实 ACP 协议证据、fail-closed 行为和调度证明;不得用 headless/direct 结果冒充 ACP ready。
- [Issue #54 - Terminal Consumer Integration Smoke](./issue-54-terminal-consumer-integration-smoke.md):#45 的 terminal-consumer smoke PR。目标是证明终端类 consumer 只靠 HOLP public wire(`initialize`/`flock.discover`/`orchestrate.run`/`events.subscribe`/artifact/gate/control)即可集成测试真实 #45-ready runtime surface;只能声明 `terminal-consumer-integration-ready`,不得在无真实 cmux 自动化或用户验收时声明 `cmux-ready`。

## 拆分原则

每个 PR 必须保留独立 review / 验收边界。可以新增脚手架,但只有满足本 SPEC 的验收项后,才允许声称对应阶段完成。
