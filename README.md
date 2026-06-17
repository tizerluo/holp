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
  daemon/       参考实现(治理内核 + events-decisions-registry 数据骨架 + 共识 + 状态机,从 loopwright 旧仓挑拷)
  adapters/     朝下 agent 适配(先桩接口;后续 wrapper/抽取包复用 happier backend 模块)
  consumers/    朝上 consumer 参考(CLI 先;cmux 适配示例后做)
  tests/        e2e + 协议契约测试
  docs/         定位 / roadmap / PR specs / non-goals
```

## 状态

🚧 **v0.1.4 draft**(经多轮深度 review + 一轮跨仓来源核查迭代),参考实现进行中。

- [x] 定位(`docs/positioning.md`)
- [x] 整体规划(`docs/roadmap.md`)
- [x] 8 PR 拆解 SPEC(`docs/pr-specs/`)
- [x] 协议 spec v0.1.4(`protocol/spec.md`)— 经 v0.1→v0.1.1→v0.1.2→v0.1.3→v0.1.4 迭代(末轮为跨仓来源核查 + 互操作缺口修补)
- [x] 朝下 adapter 契约 + 桩(`adapters/`)— **未接真 agent,不声称已接**
- [x] 参考 daemon 协议骨架(`daemon/`)— stdio JSON-RPC 9 方法 + 事件订阅/replay(M1a+M1b)
- [x] 参考 consumer CLI(`consumers/cli/`)— 跑通 M1 闭环 demo,**仅用 fake backend**
- [x] M1 e2e 闭环(`initialize→flock.declare→orchestrate.run→events.subscribe→approval.resolve→artifact.get`)— **fake backend,非真实 provider**
- [x] M2 契约回归网(`daemon/handlers/m2_contract.test.ts`)— **契约层已锁定;consensus 执行/approval 超时/heartbeat 转交 M3/M4/M5(§F 负向锁定)**
- [ ] 治理内核/events-decisions-registry 数据骨架/共识/状态机从 loopwright 搬入(M4)
- [ ] 真实 adapter 接线(M3)

> **当前只声称**:protocol draft + adapter contract stub + **fake backend 跑通的 M1 协议闭环**(daemon + CLI demo)。**不声称**已接 native-claude/mcp-codex/acp 真 agent——CLI demo 用的是 `fake` transport,真实 transport 仍是会抛「not wired」的桩。

## 协议速览(v0.1.4)

stdio,两面:JSON-RPC 控制面 + 带 subscription_id 的事件 notification 流。consumer 声明/发现 agent 队伍 → 发编排目标 → 订阅事件 → 需要时人拍板(approval 单通道状态机)。

12 章:握手+能力 / flock(declare+discover) / orchestrate.run / events.subscribe / consensus / approval / artifact / 版本化 / 错误模型 / unattended policy / 实现边界。(lifecycle 不单列章,是事件流的 category + `task.cancel` 命令。)详见 `protocol/spec.md`。

## 设计来源(不凭空发明)

events 流 ← cmux `CmuxEventBus`;flock/orchestrate/Local|Remote ← Oz proto(借思路,不抄依赖);consensus ← loopwright 共识评审;朝下 adapter 契约 ← happier `ExecutionRunBackendFactory`。完整溯源见 `docs/positioning.md`。

## 许可

(待定 MIT / Apache-2.0)
