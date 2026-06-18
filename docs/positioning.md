# HOLP 定位

## 一句话

**HOLP（Human On Loop Protocol）= 开源、免费、本地优先的 multi-agent 编排协议,加一个参考 daemon。**

它让任何终端/工具/APP（cmux、Warp、happier、CLI……）都能免费拥有「把自己本机装的异构 agent（Claude Code、Codex、Gemini、Hermes、Cursor……）组织起来」的编排层——能看得见、能插手、能跨厂商共识、能无人值守跑闭环。

## 为什么要存在（市场空洞）

Warp 的 **Oz** 证明了 multi-harness agent 编排是真需求,但它 **闭源 + 付费 + 云绑定**。留下一个明摆着的空洞:**没人提供开源、免费、本地优先、vendor-neutral 的「把你本机装的异构 agent 编织起来」的编排协议。** HOLP 填这个空洞——是 Oz 的开源对位物,不是廉价复刻。

类比:GitLab 之于 GitHub 企业版、Forgejo 之于 Gitea。商业 SaaS 证明需求,开源版本满足不想付费 / 想自托管 / 想自掌控的人。

## HOLP 协议层(朝上) vs agent 接入层(朝下)

HOLP 是一根**朝上的线**:consumer(终端/工具)说「这是我的 agent 队伍 + 这个目标」,orchestrator 流式回吐「派给谁了、干了什么、共识如何、要不要你拍板」。

朝下驱动各家 agent 走它们的**原生协议**（ACP / Claude SDK / Codex MCP）——**agent 零改动**。HOLP 参考实现的朝下 adapter,规划通过 wrapper 或抽取包复用 [happier](https://github.com/happier-dev/happier) 的 backend 模块;协议层本身**不依赖 happier**、不知道 happier 存在——保持 vendor-neutral。

关键不对称:**ACP 需要 agent 去采纳(每家得说 ACP);HOLP 的朝上协议需要 consumer 去采纳,但 agent 一头 HOLP 全包。** 所以 HOLP 的采纳门槛比 ACP 低:consumer 接一根线就有编排能力,agent 零改动。

## HOLP 独有、Oz/happier 都没有的协议级能力

这两条不是实现细节,是**写进协议消息语义**的真差异:

1. **跨厂商共识评审**——协议里能表达「这件事派给 3 家、要 2 家同意、且不能是作者那家」。Oz 多 harness 并行但无协议级共识聚合;happier 有 review engine 入口,但没有 HOLP/loopwright 式 quorum consensus 聚合。HOLP 把共识裁决做成 `events.event` 的一个 name(`consensus_verdict`),不是独立消息方法。
2. **Human-on-Loop 无人值守闭环**——协议里能表达「接到触发就自己跑完整条链,只有需要人批准(如合并)时才打断」。名字即立场:人在回路上,不是人在每一个 tick 上。对应 `approval` 单通道状态机(`approval_requested`/`approval_resolved` 等事件 + `approval.resolve` 命令)。

## 版本取舍(v0.1.x 做什么)

协议 `execution_mode` 只定义 `Local`;**Remote 不进 v0.1.x wire**(连 opaque 占位都不留,避免边界模糊)。思路仍借自 Oz proto 的 Local|Remote 概念,但 v0.1.x 选择**只在协议里出现 Local**——Remote 整个留给独立扩展 proposal,届时一次性定义 workspace sync / secret scope / artifact transport / network / cost / identity。

参考实现 **v0.1.x 只做 Local**。Remote 未来对位 [spawn](https://github.com/OpenRouterLabs/spawn) 的 agent×cloud 矩阵、[skypilot](https://github.com/skypilot-org/skypilot) 的跨云算力调度——**这些是 V3+,不进 v0.1.x**。

## 设计来源(可追溯,不凭空发明)

HOLP 不重新发明轮子,各章设计标注来源:

| 协议章 / 部件 | 借自 | 借什么(设计,非代码) |
|---|---|---|
| `events.subscribe`/事件流 | **cmux** `CmuxEventBus` / `events.stream` | 概念启发:cmux 有 seq 单调/replay/heartbeat/slow_consumer 背压(其自身功能属实)。HOLP 的 subscribe(拿 subscription_id)+ 带 subscription_id 的独立 notification 是**新协议设计**,非 cmux 形状照搬(cmux 是长连接 JSON-line) |
| `flock.declare`/`flock.discover` | 综合抽象自 **Oz** `Harness` oneof / **happier** catalog / **spawn** manifest / **cmux** 进程扫描 | **非直接对位**:四者分别给 harness enum / backend catalog / agent-cloud manifest / 硬编码 provider,HOLP 的「声明+发现+实测」协议面是综合抽象,不是任何一个的搬运 |
| `orchestrate.run` | **Oz** `RunAgents` + loopwright triage 派单 | 批量派单 + 角色配置 |
| `Local`(执行模式) | **Oz** `ExecutionMode` | v0.1.x 只定义 Local;Remote 留独立 proposal |
| `consensus_verdict`(事件) | **loopwright** `aggregateVerdict`/`aggregateConsensus`(聚合策略)+ `reviewerCandidates`(排除作者原型) | **HOLP 独有的协议级能力**;借鉴 loopwright 的聚合策略与「作者不评审自己」逻辑(loopwright `reviewerCandidates` 从 pool 过滤作者 harness),但 wire 结构(quorum.required/eligible/met、excluded、errors、findings envelope、`produced_by_agent_id` provenance)是 HOLP 新设计——loopwright 没有这套 |
| 朝下 adapter 契约 | **happier** `ExecutionRunBackendFactory` / `AgentBackend` / `permissionHandler`(形状启发) | 借鉴 startSession/sendPrompt/onMessage 形状 + 可拦权限;但 happier backend 仍耦合 CLI runtime/config/isolation/transport probe,权限枚举也不同(happier 五值 approved/approved_for_session/approved_execpolicy_amendment/denied/abort vs HOLP 三值 allow/deny/ask_human),**需 wrapper 或抽取包适配,非直接当 adapter** |
| 裁决内核 / 数据骨架 / 状态机 | **loopwright**(旧仓)参考实现搬入 | gate/triage/review-consensus + events/decisions/registry;`数据铁三角`是架构简称,不是 loopwright 里的单一模块名 |
| Role / transport class 词表 | **loopwright** role_fitness + triage/reviewer role、**happier** AgentTransport | HOLP 的 `architect/reviewer/coder/tester/test_audit/test_strengthen` 是把 loopwright 的 triage role、review role、harness registry role_fitness 合并成协议词表;transport class 对齐 native-claude/mcp-codex/acp |

## 不做（non-goals）

- **不重造完整 agent 运行时**:HOLP 可保留最小 adapter wrapper(如 Codex app-server),但不把 happier 变成运行时依赖,也不复制它的 CLI runtime/config/isolation 整套体系。
- **不做付费云 / 闭源服务端**:这是 Oz 的领地,HOLP 是它的开源对位,不进同一赛道。
- **v0.1.x 不做 Remote**:Remote 不进 v0.1.x wire(不留半截 opaque 占位),实现+协议都待 V3 独立 proposal。
- **不绑定任何终端/APP**:协议 vendor-neutral,谁都能接(cmux/Warp/happier/CLI)。
- **不做社交 / pets 等产品功能**:HOLP 是协议 + 参考编排 daemon,不是 SaaS 产品。

## 与旧 loopwright 仓的关系

旧仓 `loopwright`(本工作区)保持现状、**只读、当素材库**,不在这上面继续动。HOLP 参考实现的治理内核 / events-decisions-registry 数据骨架 / 共识评审 / 编排状态机 / e2e 测试,**挑着拷**过来。不拷:V1 ChainExecutor、`realSpawnRunner` 黑盒、vendored `src/agent/` 老切片、所有 SUPERSEDED 文档。
