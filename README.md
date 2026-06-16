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
  docs/         定位 / non-goals
```

## 状态

🚧 **v0.1.3 draft**(经三轮 codex 深度 review 迭代),参考实现进行中。

- [x] 定位(`docs/positioning.md`)
- [x] 协议 spec v0.1.3(`protocol/spec.md`)— 经 v0.1→v0.1.1→v0.1.2→v0.1.3 三轮 review 迭代
- [x] 朝下 adapter 契约 + 桩(`adapters/`)— **未接真 agent,不声称已接**
- [ ] 参考实现(治理内核/events-decisions-registry 数据骨架/共识/状态机从 loopwright 搬入 + 协议接入层)
- [ ] 参考 consumer CLI
- [ ] e2e 闭环

> **当前只声称**:protocol draft + adapter contract stub。**不声称**已接 native-claude/mcp-codex(那是真接线后的事,规划通过 wrapper 或抽取包复用 happier backend 模块)。

## 协议速览(v0.1.3)

stdio,两面:JSON-RPC 控制面 + 带 subscription_id 的事件 notification 流。consumer 声明/发现 agent 队伍 → 发编排目标 → 订阅事件 → 需要时人拍板(approval 单通道状态机)。

12 章:握手+能力 / flock(declare+discover) / orchestrate.run / events.subscribe / consensus / approval / artifact / 版本化 / 错误模型 / unattended policy / 实现边界。(lifecycle 不单列章,是事件流的 category + `task.cancel` 命令。)详见 `protocol/spec.md`。

## 设计来源(不凭空发明)

events 流 ← cmux `CmuxEventBus`;flock/orchestrate/Local|Remote ← Oz proto(借思路,不抄依赖);consensus ← loopwright 共识评审;朝下 adapter 契约 ← happier `ExecutionRunBackendFactory`。完整溯源见 `docs/positioning.md`。

## 许可

(待定 MIT / Apache-2.0)
