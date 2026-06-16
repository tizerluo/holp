# HOLP 定位

## 一句话

**HOLP（Human On Loop Protocol）= 开源、免费、本地优先的 multi-agent 编排协议,加一个参考 daemon。**

它让任何终端/工具/APP（cmux、Warp、happier、CLI……）都能免费拥有「把自己本机装的异构 agent（Claude Code、Codex、Gemini、Hermes、Cursor……）组织起来」的编排层——能看得见、能插手、能跨厂商共识、能无人值守跑闭环。

## 为什么要存在（市场空洞）

Warp 的 **Oz** 证明了 multi-harness agent 编排是真需求,但它 **闭源 + 付费 + 云绑定**。留下一个明摆着的空洞:**没人提供开源、免费、本地优先、vendor-neutral 的「把你本机装的异构 agent 编织起来」的编排协议。** HOLP 填这个空洞——是 Oz 的开源对位物,不是廉价复刻。

类比:GitLab 之于 GitHub 企业版、Forgejo 之于 Gitea。商业 SaaS 证明需求,开源版本满足不想付费 / 想自托管 / 想自掌控的人。

## HOLP 协议层(朝上) vs agent 接入层(朝下)

HOLP 是一根**朝上的线**:consumer(终端/工具)说「这是我的 agent 队伍 + 这个目标」,orchestrator 流式回吐「派给谁了、干了什么、共识如何、要不要你拍板」。

朝下驱动各家 agent 走它们的**原生协议**（ACP / Claude SDK / Codex MCP）——**agent 零改动**。HOLP 参考实现的朝下方言库,规划走 [happier](https://github.com/happier-dev/happier) 的 backends(开源,接入完整),但协议层本身**不依赖 happier**、不知道 happier 存在——保持 vendor-neutral。

关键不对称:**ACP 需要 agent 去采纳(每家得说 ACP);HOLP 的朝上协议需要 consumer 去采纳,但 agent 一头 HOLP 全包。** 所以 HOLP 的采纳门槛比 ACP 低:consumer 接一根线就有编排能力,agent 零改动。

## HOLP 独有、Oz/happier 都没有的协议级能力

这两条不是实现细节,是**写进协议消息语义**的真差异:

1. **跨厂商共识评审**——协议里能表达「这件事派给 3 家、要 2 家同意、且不能是作者那家」。Oz 多 harness 并行但无共识聚合;happier 的 reviews 是单引擎。HOLP 把共识裁决(`consensus.verdict`)做成一等消息。
2. **Human-on-Loop 无人值守闭环**——协议里能表达「接到触发就自己跑完整条链,只有需要人批准(如合并)时才打断」。名字即立场:人在回路上,不是人在每一个 tick 上。对应 `approval.request/resolve`。

## 版本取舍(v0.1 做什么)

协议从第一天就**内置 Local | Remote** 执行模式(思路借自 Oz proto,**不抄依赖、不实现 Oz 服务端**)。参考实现 **v0.1 只做 Local**,Remote 留口子。理由:个人用户当下就能用(本地免费),团队/云上的路以后自然通;但 wire 格式一开始就留位,避免日后破坏性变更。

Remote 的 `environment_id / worker_host` 维度,未来对位 [spawn](https://github.com/OpenRouterLabs/spawn) 的 agent×cloud 矩阵、[skypilot](https://github.com/skypilot-org/skypilot) 的跨云算力调度——**这些是 V3+,不进 v0.1**。

## 设计来源(可追溯,不凭空发明)

HOLP 不重新发明轮子,各章设计标注来源:

| 协议章 / 部件 | 借自 | 借什么(设计,非代码) |
|---|---|---|
| `events.stream` | **cmux** `CmuxEventBus` / `events.stream` | JSON-line + seq 单调序 + replay + 心跳 + slow_consumer 背压(已验证可用) |
| `flock.declare` | **Oz** `Harness` oneof / **happier** catalog / **spawn** manifest | 「声明我这窝 agent」替代 cmux 的硬编码 switch |
| `orchestrate.run` | **Oz** `RunAgents` + loopwright triage 派单 | 批量派单 + 角色配置 |
| `Local\|Remote` | **Oz** `ExecutionMode` | 朝下执行环境维度 |
| `consensus.verdict` | **loopwright** `aggregateVerdict` + 共识评审 | 多 agent 评审聚合(独有) |
| 朝下 adapter 契约 | **happier** `ExecutionRunBackendFactory` / `AgentBackend` / `permissionHandler` | onMessage 事件流 + 可拦权限的接缝 |
| 裁决内核 / 数据铁三角 / 状态机 | **loopwright**(旧仓)参考实现搬入 | gate/triage/review-consensus + events/decisions/registry |

## 不做（non-goals）

- **不重造 agent 接入层**:不自己写 claude/codex/gemini 的协议适配(那是 happier 的活);HOLP 只接它,不重造。
- **不做付费云 / 闭源服务端**:这是 Oz 的领地,HOLP 是它的开源对位,不进同一赛道。
- **v0.1 不做 Remote 实现**:留 wire 口子,实现待 V3。
- **不绑定任何终端/APP**:协议 vendor-neutral,谁都能接(cmux/Warp/happier/CLI)。
- **不做社交 / pets 等产品功能**:HOLP 是协议 + 参考编排 daemon,不是 SaaS 产品。

## 与旧 loopwright 仓的关系

旧仓 `loopwright`(本工作区)保持现状、**只读、当素材库**,不在这上面继续动。HOLP 参考实现的治理内核 / 数据铁三角 / 共识评审 / 编排状态机 / e2e 测试,**挑着拷**过来。不拷:V1 ChainExecutor、`realSpawnRunner` 黑盒、vendored `src/agent/` 老切片、所有 SUPERSEDED 文档。
