# HOLP 8 PR SPEC

这些 SPEC 把 M0-M5 roadmap 拆成 8 个可 review 的 PR。拆法严格按当前仓库事实写,不假装已有实现已经存在。

当前代码事实:

- 已存在:`protocol/spec.md`、`protocol/version.md`、`docs/positioning.md`、`docs/roadmap.md`、`adapters/agent-backend.ts`、`adapters/registry.ts`。
- 不存在:`daemon/`、`consumers/`、`tests/`、`package.json`、runtime server、contract test harness、真实 provider adapter。
- 当前 `adapters/` 只有 contract + stub;`createDefaultAdapterRegistry()` 把 `native-claude`、`mcp-codex`、`acp` 都接到 stub factory。

## PR 顺序

1. [PR1 - M0 Contract Surface Freeze](./pr1-m0-contract-surface.md)
2. [PR2 - M1a Protocol Substrate](./pr2-m1a-protocol-substrate.md)
3. [PR3 - M1b Fake Harness and CLI](./pr3-m1b-fake-harness-cli.md)
4. [PR4 - M2 Protocol Contract Tests](./pr4-m2-contract-tests.md)
5. [PR5 - M3 First Real Adapter](./pr5-m3-first-real-adapter.md)
6. [PR6 - M4a Data State Decision Skeleton](./pr6-m4a-data-state-decision.md)
7. [PR7 - M4b Consensus Gate Triage Kernel](./pr7-m4b-consensus-gate-triage.md)
8. [PR8 - M5 Multi-Agent Consensus Demo](./pr8-m5-consensus-demo.md)

## 拆分原则

每个 PR 必须保留独立 review / 验收边界。可以新增脚手架,但只有满足本 SPEC 的验收项后,才允许声称对应阶段完成。
