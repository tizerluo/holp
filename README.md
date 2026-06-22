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
- [x] 朝下 adapter 契约 + 首个真实 adapter(`adapters/`)— **mcp-codex 接 Codex app-server,含基础 turn recovery;native-claude/acp 仍是桩**
- [x] 参考 daemon 协议骨架(`daemon/`)— stdio JSON-RPC 9 方法 + 事件订阅/replay(M1a+M1b)
- [x] 参考 consumer CLI(`consumers/cli/`)— 跑通 M1 闭环 demo + M6a fake consumer CLI partial,**仅用 fake backend**
- [x] M1 e2e 闭环(`initialize→flock.declare→orchestrate.run→events.subscribe→approval.resolve→artifact.get`)— **fake backend,非真实 provider**
- [x] M2 契约回归网(`daemon/handlers/m2_contract.test.ts`)— **契约层已锁定;approval 超时已由 M4a skeleton 接入,显式 reviewer panel 的 consensus kernel 已由 M4b 接入,heartbeat 仍转交后续(§F 锁定)**
- [x] M4a governance data/state/decision skeleton partial— internal events、decision records、harness registry archive、run lifecycle state machine、approval expiry timer
- [x] M4b consensus gate triage kernel partial— 纯 consensus aggregation、author exclusion、二段式 quorum、显式 reviewer panel 的 `consensus_verdict`/`consensus_degraded`
- [x] M5 deterministic unanimous-approve multi-agent consensus demo— fake+fake reviewer path 跑通 producer artifact、author exclusion、quorum、findings envelope/inline fallback
- [x] M6a fake consumer CLI partial— `run` 命令可发起 fake single/consensus/degraded run、处理 approval、渲染 consensus/artifact report、raw/debug wire frames
- [x] M5b real reviewer execution pilot— 显式 reviewer panel 可通过 canonical parser/validator 接入真实 `mcp-codex` read-only reviewer path;真实 smoke 需显式 opt-in
- [ ] 稳定 gate protocol surface / 第二真实 provider / 真实 dissent-timeout 多 provider demo
- [x] 真实 adapter 接线(M3)— **Codex app-server over stdio 注册为 `mcp-codex`;自动覆盖 fake/app-server harness,已补基础 stdio/turn recovery;真实 smoke 依赖本机 Codex auth**

> **当前只声称**:protocol draft + **fake backend 跑通的 M1 协议闭环**(daemon + CLI demo)+ M2 契约层 + **Codex app-server 作为首个真实 adapter**(含基础 stdio/turn recovery,不含多账号 quota 切换)+ v0.1.5 runtime surface/isolation baseline + **M4a governance data/state/decision skeleton partial** + **M4b consensus gate triage kernel partial** + **M5 deterministic unanimous-approve fake+fake multi-agent consensus demo** + **M5b real reviewer execution pilot** + **M6a fake consumer CLI partial**。CLI demos 仍显式使用 `fake` transport;真实 Codex reviewer path 通过 opt-in smoke 验证;`native-claude`/`acp` 仍是桩,不声称已接,也不声称 12 个 agent 已完整支持 `headless` / `acp` / `direct_user_session`,也不声称真实多 provider consensus、真实 dissent/timeout reviewer demo、或稳定 gate protocol surface 已完成。

> 参考 daemon 已把 v0.1.5 runtime surface/isolation matrix 落进 declare/discover、run metadata 和内部 registry archive;这仍是声明/记录层,不表示真实 OS/provider 隔离已经强制执行。
> M4a 内部 registry 已保留 `permission_surface` / `observability_surface` 列,但当前统一记录为 `unknown`;后续 adapter/governance PR 再接真实声明来源。
> M5 demo 仍是 deterministic unanimous-approve fake+fake reviewer verification layer:它真走 HOLP wire、展示 findings artifact envelope / inline fallback,但 reviewer votes 来自 fake reviewer fixture 并经 PR9 canonical validator 校验,不表示真实 reviewer provider dissent/timeout demo 已接。
> M5b real reviewer pilot 只接入 `mcp-codex` reviewer 的 read-only app-server path:completed vote 必须经过严格 JSON parser/validator 和本次执行的 read-only attestation。缺 binary/auth/quota、不可只读、非 JSON、缺 verdict/severity 等都只会变成 error/INCONCLUSIVE,不会被当成 approve。

## CLI 快速体验

```bash
npm run demo              # fake single-coder path
npm run demo:cli          # fake consensus report + findings artifacts
npm run demo:cli:inline   # fake consensus report + inline findings fallback
npm run demo:cli:degraded # deterministic consensus_degraded / run_blocked report
npm run smoke:reviewer:codex # opt-in real Codex reviewer smoke;默认 SKIP,需 HOLP_REAL_CODEX_REVIEWER_SMOKE=1
```

通用入口:

```bash
npm run cli -- run --scenario=consensus --decision=approved --artifact-refs=true
npm run cli -- run --scenario=real-reviewer
```

`real-reviewer` CLI scenario 仍保持 consumer 体验入口;真实 Codex reviewer execution 的可验证入口是 `npm run smoke:reviewer:codex`,默认 SKIP,只有显式 opt-in 且本机 Codex binary/auth/quota/read-only path 都满足时才会 PASS。CLI 默认输出是 human-readable rendered view;`--raw` / `--debug` 会打印 daemon stdio JSON-RPC wire frames。

## 协议速览(v0.1.5)

stdio,两面:JSON-RPC 控制面 + 带 subscription_id 的事件 notification 流。consumer 声明/发现 agent 队伍 → 发编排目标 → 订阅事件 → 需要时人拍板(approval 单通道状态机)。

12 章:握手+能力 / flock(declare+discover,含 runtime surface + isolation readiness matrix) / orchestrate.run / events.subscribe / consensus / approval / artifact / 版本化 / 错误模型 / unattended policy / 实现边界。(lifecycle 不单列章,是事件流的 category + `task.cancel` 命令。)详见 `protocol/spec.md`。

v0.1.5 基准要求 HOLP 能表达每个 harness 在 `headless`、`acp`、`direct_user_session` 三类运行面和不同 isolation profile 下的 readiness。`ready` 不表示 agent 整体可用,只表示某个 runtime surface + isolation profile 可调度。

## 设计来源(不凭空发明)

events 流 ← cmux `CmuxEventBus`;flock/orchestrate/Local|Remote ← Oz proto(借思路,不抄依赖);consensus ← loopwright 共识评审;朝下 adapter 契约 ← happier `ExecutionRunBackendFactory`。完整溯源见 `docs/positioning.md`。

## 许可

(待定 MIT / Apache-2.0)
