# HOLP — Human On Loop Protocol

**开源、免费、本地优先的 multi-agent 编排协议,加一个参考 daemon。**

让任何终端 / 工具 / APP(cmux、Warp、happier、CLI……)都能免费拥有「把自己本机装的异构 agent(Claude Code、Codex、Gemini、Hermes、Cursor……)组织起来」的编排层——看得见、能插手、跨厂商共识、无人值守跑闭环,人在回路上只在必要时介入。

> **Human on Loop**:不是人在每个 tick 上,是人在回路上。

## 为什么

Warp 的 Oz 证明了 multi-harness agent 编排是真需求,但闭源 + 付费 + 云绑定。HOLP 是它的**开源对位物**——填「没人提供开源、免费、本地优先、vendor-neutral 的异构 agent 编排协议」这个空洞。

## 仓结构

```
holp/
  protocol/     协议本身(spec / 消息定义 / 版本 / 样例)—— 独立身份,成熟后可独立成仓
  daemon/       参考实现(协议骨架 + M4a/M4b governance skeleton + M5 deterministic consensus demo)
  adapters/     朝下 agent 适配(Codex app-server 已接入;mcp-codex 以外仍是桩)
  consumers/    朝上 consumer 参考(CLI 先;cmux 适配示例后做)
  tests/        e2e + 协议契约测试
  docs/         定位 / roadmap / PR specs / non-goals
```

## 状态

🚧 **v0.1.5 draft**(v0.1.4 之后吸收 Issue #11 harness isolation baseline),参考实现进行中。

- [x] 定位(`docs/positioning.md`)
- [x] 整体规划(`docs/roadmap.md`)
- [x] PR1-PR8 拆解 SPEC + PR9-PR12 下一阶段 planned SPEC(`docs/pr-specs/`)
- [x] 协议 spec v0.1.5(`protocol/spec.md`)— 经 v0.1→v0.1.4 迭代后,在 v0.1.5 把 runtime surface / isolation readiness matrix 提升为协议基准
- [x] 朝下 adapter 契约 + 首个真实 adapter(`adapters/`)— **mcp-codex 接 Codex app-server;native-claude/acp 仍是桩**
- [x] 参考 daemon 协议骨架(`daemon/`)— stdio JSON-RPC 9 方法 + 事件订阅/replay(M1a+M1b)
- [x] 参考 consumer CLI(`consumers/cli/`)— 跑通 M1 闭环 demo,**仅用 fake backend**
- [x] M1 e2e 闭环(`initialize→flock.declare→orchestrate.run→events.subscribe→approval.resolve→artifact.get`)— **fake backend,非真实 provider**
- [x] M2 契约回归网(`daemon/handlers/m2_contract.test.ts`)— **契约层已锁定;approval 超时已由 M4a skeleton 接入,显式 reviewer panel 的 consensus kernel 已由 M4b 接入,heartbeat 仍转交后续(§F 锁定)**
- [x] M4a governance data/state/decision skeleton partial— internal events、decision records、harness registry archive、run lifecycle state machine、approval expiry timer
- [x] M4b consensus gate triage kernel partial— 纯 consensus aggregation、author exclusion、二段式 quorum、显式 reviewer panel 的 `consensus_verdict`/`consensus_degraded`
- [x] M5 deterministic unanimous-approve multi-agent consensus demo— fake+fake reviewer path 跑通 producer artifact、author exclusion、quorum、findings envelope/inline fallback
- [ ] 真实 reviewer backend 执行 / 稳定 gate protocol surface
- [x] 真实 adapter 接线(M3)— **Codex app-server over stdio 注册为 `mcp-codex`;自动覆盖 fake/app-server harness,真实 smoke 依赖本机 Codex auth**

> **当前只声称**:protocol draft + **fake backend 跑通的 M1 协议闭环**(daemon + CLI demo)+ M2 契约层 + **Codex app-server 作为首个真实 adapter** + v0.1.5 runtime surface/isolation baseline + **M4a governance data/state/decision skeleton partial** + **M4b consensus gate triage kernel partial** + **M5 deterministic unanimous-approve fake+fake multi-agent consensus demo**。CLI demos 仍显式使用 `fake` transport;`native-claude`/`acp` 仍是桩,不声称已接,也不声称 12 个 agent 已完整支持 `headless` / `acp` / `direct_user_session`,也不声称真实 reviewer backend 执行、dissent/timeout demo、或稳定 gate protocol surface 已完成。

> 参考 daemon 已把 v0.1.5 runtime surface/isolation matrix 落进 declare/discover、run metadata 和内部 registry archive;这仍是声明/记录层,不表示真实 OS/provider 隔离已经强制执行。
> M4a 内部 registry 已保留 `permission_surface` / `observability_surface` 列,但当前统一记录为 `unknown`;后续 adapter/governance PR 再接真实声明来源。
> M5 demo 仍是 deterministic unanimous-approve fake+fake reviewer verification layer:它真走 HOLP wire、展示 findings artifact envelope / inline fallback,但 reviewer votes 由 fake consensus path 合成,不表示真实 reviewer provider sessions 或 dissent/timeout demo 已接。

## 协议速览(v0.1.5)

stdio,两面:JSON-RPC 控制面 + 带 subscription_id 的事件 notification 流。consumer 声明/发现 agent 队伍 → 发编排目标 → 订阅事件 → 需要时人拍板(approval 单通道状态机)。

12 章:握手+能力 / flock(declare+discover,含 runtime surface + isolation readiness matrix) / orchestrate.run / events.subscribe / consensus / approval / artifact / 版本化 / 错误模型 / unattended policy / 实现边界。(lifecycle 不单列章,是事件流的 category + `task.cancel` 命令。)详见 `protocol/spec.md`。

v0.1.5 基准要求 HOLP 能表达每个 harness 在 `headless`、`acp`、`direct_user_session` 三类运行面和不同 isolation profile 下的 readiness。`ready` 不表示 agent 整体可用,只表示某个 runtime surface + isolation profile 可调度。

## 设计来源(不凭空发明)

events 流 ← cmux `CmuxEventBus`;flock/orchestrate/Local|Remote ← Oz proto(借思路,不抄依赖);consensus ← loopwright 共识评审;朝下 adapter 契约 ← happier `ExecutionRunBackendFactory`。完整溯源见 `docs/positioning.md`。

## 许可

(待定 MIT / Apache-2.0)
