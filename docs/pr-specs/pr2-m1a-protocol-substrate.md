# PR2 SPEC - M1a Protocol Substrate

## 目的

创建 HOLP stdio JSON-RPC daemon 的最小 runtime 地板,但不声称完整 M1 fake harness 闭环已经完成。

## 当前代码事实

- git **未跟踪任何 `daemon/` 源码**(工作树里可能有人 `mkdir` 了空骨架目录如 `daemon/{core,runtime,...}`,但无 .ts 文件、未入版本控制)。本 PR 决定这些目录是保留为模块边界还是删除,并落实第一批源码。
- holp 是**独立 git 仓**(有自己的 `.git`),不继承 workspace 上层工具链;当前**没有 `package.json`、`tsconfig.json`、test runner、runtime entrypoint**。`adapters/*.ts` 现在是裸 TS 文件,没有任何东西在编译它们。
- `adapters/registry.ts` 已有 `createDefaultAdapterRegistry()`,但三种 transport 都是 stub。
- `adapters/agent-backend.ts` 定义朝下 contract,没有编排 runtime。

## 范围

新增项目/runtime 脚手架和协议底座。

预期新增:

- **工具链 bootstrap(本 PR 的真前置,从零建)**:`package.json`(`npm init`/`pnpm init`,选定包管理器)、`tsconfig.json`(target/module/路径解析,使 `daemon/` 能 import `adapters/`)、test runner(如 vitest/tsx,选一个并配脚本)。无此层,"本地命令可运行 substrate 级测试"这条验收无法成立。
- `daemon/` source tree(落实第一批源码,处置既存空目录)。
- stdio 风格 newline-delimited JSON reader/writer。
- JSON-RPC request/response/notification 类型。
- dispatcher / method registry。
- HOLP error helper,对齐 `protocol/spec.md` §10。
- 内存 connection context,至少保存:
  - initialized capability 状态
  - flock 状态占位
  - subscriptions
  - run records 占位
  - artifact records 占位
- 初始 method handlers:
  - `initialize`
  - `events.subscribe`
  - `events.unsubscribe`
- event sink abstraction:
  - `events.event`
  - `events.heartbeat`
  - `events.error`

## 非目标

- 不实现完整 `orchestrate.run` 行为;最多返回清晰的未实现或 `run_not_found`。
- 不新增 fake backend scenario。
- 不新增 CLI consumer。
- 不接真实 provider。
- 不声称 M1 完成。

## 验收

- 本地命令可运行 substrate 级测试。
- unknown method 返回 JSON-RPC error。
- `initialize` 按 spec 做 capability negotiation。
- `events.subscribe`:
  - 省略/null `categories` = 全订阅。
  - 空数组/未知 category 返回 `invalid_event_category`。
  - 返回 `subscription_id` 和 `latest_seq`。
- `events.unsubscribe` 对未知 subscription 返回 `invalid_subscription`。
- heartbeat 不受 category 过滤。
- 不提交生成物。

## Review 重点

这是 M1 的半步。只有标清 M1a 且不声称 M1 闭环完成,这个半成品 PR 才可以接受。
