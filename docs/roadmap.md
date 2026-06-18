# HOLP Roadmap

> 状态:规划文档,不表示对应实现已经存在。
> 核查依据:`protocol/spec.md` v0.1.5、`protocol/version.md`、`docs/positioning.md`、`adapters/` 当前实现。
> 8 PR 拆解:见 `docs/pr-specs/`。

## 当前事实

当前仓已落地:

- `protocol/spec.md`:v0.1.5 draft,覆盖 stdio JSON-RPC、capability descriptor、flock runtime surface/isolation readiness matrix、orchestrate、events、consensus、approval、task.cancel、artifact、versioning、error model、unattended policy、implementation boundary。
- `protocol/version.md`:版本规则和 v0.1.5 范围。
- `docs/positioning.md`:定位、non-goals、设计来源边界。
- `docs/pr-specs/`:M0-M5 拆解 SPEC。
- `adapters/`:朝下 adapter contract + Codex app-server real adapter(`mcp-codex`) + native-claude/acp stub；`fake` transport 仅用于 demo/test。
- `daemon/`:参考 daemon 协议骨架,支持 stdio JSON-RPC 9 方法 + 事件订阅/replay(M1a+M1b)。
- `consumers/cli/`:参考 consumer CLI,可跑通 M1 fake backend 闭环。
- M1 e2e 闭环:`initialize -> flock.declare -> orchestrate.run -> events.subscribe -> approval.resolve -> artifact.get`。**fake backend,非真实 provider**。
- M2 契约回归网:`daemon/handlers/m2_contract.test.ts` 已锁定当前实现的关键 v0.1.4 语义；approval 超时已由 M4a skeleton 接入正向 contract,显式 reviewer panel 的 consensus kernel 已由 M4b 接入,heartbeat 仍转交 M3+。
- 参考 daemon 代码常量仍按 v0.1.4 contract 运行;v0.1.5 是当前协议基准修订,PR6+ 必须承接 runtime surface / isolation readiness matrix。

当前仓未落地,也不声称已落地:

- native-claude/acp 真接线。
- 12 个 agent 在 `headless` / `acp` / `direct_user_session` 三类运行面的完整 adapter 实现。
- M5 multi-agent consensus demo、真实 reviewer backend 执行、稳定 gate protocol surface。
- Web 传输。
- Remote execution。

## 规划原则

1. 协议先于 provider 接线:先证明 consumer 和 orchestrator 的 wire 能闭环,再接真实 agent。
2. v0.1.x 只做 Local:Remote 不进 wire,不留 opaque 半截字段。
3. fake backend 先于真实 backend:先用可控 fake backend 把事件、approval、artifact、consensus、cancel 的协议语义跑通。
4. 单 provider 先于多 provider:真实 adapter 首个里程碑只接一家,避免把 provider 差异和协议 bug 混在一起。
5. 复用但不绑定:happier backend 是 wrapper/extraction 的素材,不是 HOLP 协议依赖;loopwright 是治理内核素材库,不是直接搬运整个旧仓。
6. 每个里程碑都必须能被测试或脚本演示验证,不能只停在文档声明。
7. harness 能力矩阵先于调度实现:`ready` 只表示某个 runtime surface + isolation profile 可调度,不表示 agent 整体可用。未知或不支持必须显式返回 `unknown` / `unsupported` / `rejected`,不能留空。

## M0:协议冻结前清理

目标:把 v0.1.4 draft 整理到可实现、可测试、可审查的形态。

交付物:

- 方法清单:`initialize`、`flock.declare`、`flock.discover`、`orchestrate.run`、`events.subscribe`、`events.unsubscribe`、`approval.resolve`、`task.cancel`、`artifact.get`。
- 事件清单:覆盖 §5 的五个 category(`run`/`agent`/`consensus`/`approval`/`lifecycle`),其下 name 至少含 step/tool/fs(均属 `agent` category)、approval 状态机四态、`consensus_verdict`。注:artifact 不是事件 category——它是 `artifact.get` 方法 + envelope(在事件里以 ref 出现),不单列事件。
- 错误码清单:与 `protocol/spec.md` §10 保持一一对应。
- 语义边界清单:至少覆盖 `artifact_refs` 只控制 evidence envelope、不控制 provenance `artifact_id`;unknown agent / invalid category / role mismatch 各自错误码;rejected/degraded agent 在 role/panel 中的处理。
- capability 清单:与 `initialize.capabilities` descriptor 语义一致。
- 最小 JSON examples:每个方法至少一组 request/response,每类关键事件至少一条 notification。

验收标准:

- 文档不再把未来实现写成当前已实现。
- 每个方法、事件、错误码都能在 spec 中找到对应定义。
- Remote/Web/真实 provider 接线只出现在 future 或 non-goal 语境中。

非目标:

- 不写 daemon。
- 不接真实 agent。

## M1:Protocol Harness

目标:做一个最小可运行参考 daemon 和最小 consumer,证明协议面能跑通。

交付物:

- `daemon/`:stdio newline-delimited JSON-RPC server。
- `consumers/cli/`:最小 CLI consumer 或脚本化 consumer。
- `tests/fixtures/`:fake backend 和固定 run scenario。
- 内存态 run store、subscription store、artifact store。
- fake backend 能模拟 model output、tool call、fs edit、permission request、consensus result、artifact。

必须支持的方法:

- `initialize`
- `flock.declare`
- `flock.discover`
- `orchestrate.run`
- `events.subscribe`
- `events.unsubscribe`
- `approval.resolve`
- `task.cancel`
- `artifact.get`

验收标准:

- 一条脚本能跑通 `initialize -> flock.declare -> orchestrate.run -> events.subscribe -> approval.resolve -> artifact.get`。
- 事件必须带 `subscription_id`、`seq`、`ts`、`run_id`、`category`、`name`、`payload`。
- `flock.declare`/`flock.discover` 对 unsupported transport 返回 per-agent `status=rejected`,不抛 JSON-RPC error。
- `artifact.get` 总返回 `content`,大内容允许 `truncated:true`。
- `task.cancel` 对终态 run 幂等成功,对不存在 run 返回 `run_not_found`。

非目标:

- 不接 native-claude/acp 真 agent;`mcp-codex` 已在 M3 接 Codex app-server。
- 不做持久化数据库。
- 不做 WebSocket。

## M2:Protocol Contract Tests

> 状态(PR #9 + PR6/M4a + PR7/M4b):**契约层已锁定**——approval 超时已由 M4a 接入正向 contract;显式 reviewer panel 的 consensus kernel 已由 M4b 接入正向 contract;heartbeat 仍转交 M3+(由 `daemon/handlers/m2_contract.test.ts` §F 锁定边界)。**非**无保留的「全覆盖完成」。

目标:把 spec 关键语义变成测试,让后续 provider 接线不会破坏协议层。

交付物:

- JSON-RPC request/response contract tests。
- Event stream contract tests。
- Approval state machine tests。
- Consensus quorum tests。
- Artifact tests。
- Cancel/race/idempotency tests。

必须覆盖:

- capability `required` 是连接级,run 级硬要求走 `orchestrate.run` params。
- `approval_requested -> approval_resolved | approval_expired | approval_cancelled` 先终态者赢。
- 没有 `approval.cancel`;approval 取消只由 `task.cancel` 导致。
- consensus 两段式校验:受理时静态 panel 校验,执行前排除 author 后精确校验。
- reviewer panel 中 unknown / role mismatch / rejected / degraded agent 的错误码分流。
- 正常 verdict 不产出 `quorum.met:false`;降级或 escalate 才允许 `met:false` 语义。
- `artifact_refs:false` 时 findings/details 内联降级,但 `target.artifact_id` / `provenance.artifact_id` 仍可作为身份字段出现。
- `events.subscribe` 支持 seq replay 和多 subscription 归属。

> **覆盖边界(M1/M2 实现 vs 转交后续)**:上面是按 v0.1.4 协议面的**理想全集**列举。其中 approval `approval_expired` 超时已由 M4a run state machine/timer 接入正向 contract。显式 reviewer panel 的 consensus 第 2 段 / `consensus_verdict` / `quorum.met` / `excluded[]` / `errors[]` 已由 M4b kernel 接入;无 reviewer panel 的单 coder run 仍不发 consensus。heartbeat 不受 category 过滤(转 M3+)和 consensus findings artifact envelope / M5 demo(转 M5)仍未实现,由 `daemon/handlers/m2_contract.test.ts` 的 §F 锁定当前边界。逐项拆分见 `docs/pr-specs/pr4-m2-contract-tests.md` 的 **Deferral ledger**。

验收标准:

- 本地测试命令一次跑过。
- 测试失败能定位到具体协议语义,不是只看 stdout 文案。
- 「现在锁定」栏全过 + §F 负向锁定到位 → M2 可标「契约层已锁定(consensus 执行 / approval 超时 / heartbeat 转交 M3/M4/M5)」,不得标无保留的「全覆盖完成」。

非目标:

- 不要求真实 provider。
- 不要求性能压测。

## M3:First Real Adapter

目标:只接通一家真实 agent,验证 adapter contract 和 permission resume 语义。当前实现选择 **Codex app-server over stdio**,注册为 HOLP transport `"mcp-codex"`;`native-claude`/`acp` 仍是桩。

建议顺序:

1. Codex 优先:更适合作为 CLI/MCP 形状的首个协议测试对象。
2. Claude 第二:补 native-claude/SDK 形状。
3. ACP 第三:等前两者证明 adapter contract 稳定后再接。

交付物:

- [x] 一个真实 `AgentBackendFactory` wrapper(Codex app-server)。
- [x] provider message 到 `AgentMessage` 的映射。
- [x] permission request 到 `approval_requested` 的映射,复用现有 injected `permissionHandler` / `ApprovalRecord.resumeBackend` await-Promise path。
- [x] provider availability probe,用于 `flock.declare`/`flock.discover` 返回 `ready/degraded/rejected`。
- [x] 本机已登录 Codex 的 safe prompt manual smoke:`flock.discover` ready + `model_output` + 无 artifact `run_merged`。
- [x] 本机真实 Codex approval/patched-workspace smoke:隔离 temp `CODEX_HOME` + temp git workspace;real-Codex patch、approve -> `run_merged`、reject -> `run_blocked` 均已实跑 PASS。该 smoke 仍需 `HOLP_REAL_CODEX_SMOKE=1` 显式开启,取决于 local auth/quota。

验收标准:

- 真实 agent 能跑一个单步 local run。
- 至少能产生 lifecycle/model-output/tool/fs 或其中可用子集的协议事件。
- permission `ask_human` 能暂停并在 `approval.resolve` 后 resume 或 deny 原 tool call。
- 未登录、缺 binary、缺 token 时返回 `status=rejected` 或 `degraded`,不假装 ready。

非目标:

- 不同时接多家 provider。
- 不做跨 provider consensus demo。
- 不把 happier 变成协议依赖。

## M4:Governance Kernel Import

> 状态(PR6/M4a + PR7/M4b):data/state/decision skeleton partial 已落地:内部 event archive、`decision_made`、harness registry archive、run lifecycle state machine、approval expiry timer。M4b 已接入纯 consensus kernel、author exclusion、二段式 quorum 和显式 reviewer panel 的 `consensus_verdict`/`consensus_degraded`。`permission_surface` / `observability_surface` 仍作为保留列记录为 `unknown`;真实 reviewer backend demo 和稳定 gate protocol surface 仍未落地。

目标:从 loopwright 挑拷纯逻辑治理内核,不要搬整个旧仓。

交付物:

- events-decisions-registry 数据骨架。
- harness registry 数据骨架,必须承载 `harness_id`、`runtime_surface`、`runtime_kind`、`direct_channel`、`isolation_profile`、`isolation_status`、`state_declaration_ref`、`global_mutation_required`。
- decision record 写入路径,至少覆盖 `decision_made`。
- triage/gate/review-consensus 的纯逻辑模块。
- consensus aggregator,对齐 loopwright `aggregateVerdict`/`aggregateConsensus` 的保守聚合精神,但输出 HOLP wire。
- run state machine,覆盖 queued/running/waiting_approval/cancelling/terminal 等参考 daemon 内部状态。

验收标准:

- fake backend run 能记录事件和 decision。
- registry/run metadata 能表达同一 harness 在不同 runtime surface / isolation profile 下的 ready/degraded/rejected。
- consensus step 能排除 author,计算 eligible/quorum,并输出 `consensus_verdict`。
- gate/approval 交互不会绕过 §7 单通道状态机。

非目标:

- 不搬 V1 ChainExecutor。
- 不搬 `realSpawnRunner` 黑盒。
- 不搬 vendored `src/agent/` 老切片。
- 不搬 SUPERSEDED 文档。

## M5:Multi-Agent Consensus Demo

目标:证明 HOLP 的核心卖点不是纸面能力:非作者多 agent quorum consensus 能跑出可观察事件。

交付物:

- 至少两个 reviewer backend。可以是 real+fake 或 fake+fake,但 wire 必须真实走 HOLP。
- 一个 producer artifact,带 `produced_by_agent_id`。
- 一个 consensus panel,执行时排除 producer。
- demo fixture 必须声明 reviewer/producer 的 runtime surface 和 isolation profile readiness,不得只靠 transport/role/status 调度。
- findings 默认通过 artifact envelope 引用;当 consumer 不支持 `artifact_refs` 时,通过内联降级对象承载。

验收标准:

- `consensus_verdict.payload.excluded[]` 明确排除 author。
- `quorum.required`、`quorum.eligible`、`quorum.met` 与实际 panel 一致。
- failed/timeout/abstain reviewer 进入 `errors[]`,不混进 completed vote。
- consensus result 只作为 `events.event` 的 `category=consensus,name=consensus_verdict` 发送。

非目标:

- 不追求复杂 UI。
- 不做 cloud/remote。

## M6:Consumer Adapters

目标:让协议能被真实 consumer 试用,但仍保持 vendor-neutral。

交付物:

- CLI consumer:开发者本地最小入口。
- cmux adapter 示例:展示已有终端/工具如何接入 HOLP。
- direct user session 示例:至少覆盖 product session 与 terminal session 词表;Warp/cmux/tmux 这类 terminal session 必须声明 attach/inject/interrupt/cancel 能力和 route 隔离边界。
- consumer capability negotiation 示例。
- consumer 侧 event rendering 最小格式。

验收标准:

- CLI 能完整演示 M1/M5 的 run。
- cmux 示例不要求改 cmux 主线,但要清楚展示 `events.subscribe` 与 cmux 事件模型的差异。
- consumer 不依赖 provider 私有细节。

非目标:

- 不做产品化 Web app。
- 不做 SaaS。

## Future:Remote/Web/Stable

Remote execution:

- 不进入 v0.1.x wire。
- 独立 proposal 一次性定义 workspace sync、secret scope、artifact transport、network policy、identity、cost/accounting、remote cancellation。
- 参考 spawn 的 agent x cloud matrix 和 skypilot 的 AI compute/job control plane,但 HOLP 不复制它们。

Web transport:

- 可在 v0.2 以后加入 WebSocket 或其他传输。
- 必须保持控制面和事件面的语义不变。

1.0 稳定条件:

- 至少一个真实 provider adapter 稳定。
- 协议 contract tests 覆盖核心语义。
- fake daemon、CLI consumer、multi-agent consensus demo 都能本地复现。
- versioning 从 draft 三段号收敛到稳定 `MAJOR.MINOR`。

## 阶段检查清单

每开始一个里程碑前,先核查:

- README 的“当前只声称”是否仍准确。
- `protocol/version.md` 的范围是否同步。
- `docs/positioning.md` 的 non-goals 是否被突破。
- `protocol/spec.md` 是否已经定义该里程碑要实现的 wire。
- adapter 注释是否仍准确描述 stub/real wiring 状态。

每完成一个里程碑后,更新:

- README 状态列表。
- `protocol/version.md` 范围或 changelog。
- 本 roadmap 对应 milestone 的验收状态。
- 必要时补 contract tests,再声称支持。
