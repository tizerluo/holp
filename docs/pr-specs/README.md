# HOLP PR SPEC

这些 SPEC 把 HOLP roadmap 拆成可 review 的 PR。PR1-PR12 覆盖 M0-M6c,用于把 consumer 体验、第二真实 provider、runtime/session matrix foundation 补齐。M7 之后的权威路线见 `docs/holp-blueprint.md`。

早期 PR 文件保留对应阶段的冻结上下文;下面的当前代码事实随实现进度更新,避免误读为“尚无 daemon/真实 adapter”。

当前代码事实:

- 已存在:`protocol/spec.md`、`protocol/version.md`、`docs/positioning.md`、`docs/roadmap.md`、`adapters/`、`daemon/`、`consumers/`、contract tests、`package.json`。
- 当前 `adapters/` 包含 contract、demo/test fake backend、Codex app-server real adapter 和 native-claude headless reviewer partial;`createDefaultAdapterRegistry()` 把 `"mcp-codex"` 接到 Codex app-server、把 `"native-claude"` 接到 Claude Code `-p --output-format json`;`acp` 仍是 stub。
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
- [Issue #45 - Multi-Agent CLI Runtime Surface Completion](./issue-45-multi-agent-cli-runtime-surface-completion.md):#41 learned-model data sufficiency 的前置 runtime-surface parity 阶段。PR14 是 first-batch harness pilot,不是 bounded CLI cohort 的 headless + ACP/native-or-bridge + direct session 完整候选空间证明。

## 拆分原则

每个 PR 必须保留独立 review / 验收边界。可以新增脚手架,但只有满足本 SPEC 的验收项后,才允许声称对应阶段完成。
