# Issue #105 - Extract Harness Workspace Consumer Into holp-cmux Repo

## 背景与动机

自 #66 起,本仓 40+ 个 PR 几乎全是 Harness Workspace UI/入口工作,仓库身份从"协议 + 参考 daemon"漂移成"TUI 产品仓"。每个 UI PR 都必须携带"不声明 `cmux-ready`、#41 sufficiency、#36 readiness"的免责边界——护栏文本在补偿缺失的结构边界。

拆分前耦合审计结论(拆分安全的证据):

- `consumers/harness-workspace/`、`consumers/cmux-bridge/` 与 `daemon/`、`adapters/`、`protocol/` 之间**零 TypeScript import**;唯一连接是 spawn daemon 子进程走 public stdio JSON-RPC wire——这正是 #70 架构基线声明的 public-wire-only 边界,拆仓用仓库边界证明该声明为真。
- #87 → #102 约 15 个 workspace PR 无一改动 daemon/core/protocol。
- Go TUI 只靠 `HOLP_HARNESS_BROKER_SOCKET` / `HOLP_HARNESS_CMUX_MANIFEST_PATH` 两个 env var 通信,零仓内代码依赖。

## 变更内容

### 移出(至 [holp-cmux](https://github.com/tizerluo/holp-cmux),目录布局原样保留)

- `bin/holp` 及 package.json `bin` 字段
- `consumers/harness-workspace/`(含 Go TUI)
- `consumers/cmux-bridge/`
- `tests/consumers/harness-workspace/`、`tests/consumers/cmux-bridge/`
- package.json 9 条 `harness:workspace:*` scripts
- UI 链 spec:issue-66/69/70/71/72/73/74/75/76/87/89/91/97/99/101(编号仍指向本仓历史 issue/PR)
- `docs/harness-workspace-user-validation.md`、`docs/assets/holp-harness-workspace/`
- `consumers/cli/wire.ts` 在 holp-cmux 保留一份复制件(自包含 stdio client);本仓原件不动

### 本仓内聚

- `scripts/smoke/visible-agent-chain.ts`(协议侧 #63/#65 资产,保留)原从 `consumers/cmux-bridge/index.js` import 的 3 个 helper(`cmuxWorkspaceFromEnv` / `resolveCmuxCommand` / `runCmuxBestEffort` + `CmuxCommandResult`)抽取为 `scripts/smoke/cmuxCommands.ts`;smoke 脚本保留 re-export,`tests/smoke/visible-agent-chain.test.ts` 零改动。

### holp-cmux 侧唯一代码改动(记录于其 bootstrap commit)

- broker daemon entry 解析:`HOLP_DAEMON_ENTRY` env 覆盖 + 默认同级 `../holp/daemon/runtime/server.ts`,找不到时 fail-closed 报可读错误。

## 边界

- 不改 daemon/core/protocol 任何行为;不改 `consumers/cli/`。
- gate 定义(#41/#44/#36)留在本仓;真实使用验收记录(#76 gate record)随 holp-cmux。
- 不声明 `cmux-ready`、#41 sufficiency、#36 readiness;拆仓不改变任何 gate 状态。
- PR #96/#104 已 close:#96 被 #97/#98 supersede 且基线过期;#104 内容移植为 holp-cmux 首个 PR,在新仓按标准重新过 review/验收。

## 验收

- `npm run typecheck` passed
- `npm test` passed(移除 workspace 测试后其余全部通过)
- `HOLP_VISIBLE_AGENT_CHAIN_SMOKE` 未设置时 `npm run smoke:visible-agent-chain` 正常 SKIP
- `git diff --check` passed
- `npx gitnexus detect-changes` 只显示 consumer 摘除面,无 daemon/core flow 影响
- holp-cmux 侧:typecheck + vitest(174)+ go test(21)+ broker 真实 spawn 同级 daemon 的 `holp workers` e2e 均通过
