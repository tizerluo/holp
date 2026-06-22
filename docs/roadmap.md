# HOLP Roadmap

> 状态:规划文档,不表示对应实现已经存在。
> 核查依据:`protocol/spec.md` v0.1.5、`protocol/version.md`、`docs/positioning.md`、`adapters/` 当前实现。
> PR 拆解:PR1-PR12 覆盖 M0-M6c。M7-M12 后续权威路线见 `docs/holp-blueprint.md`。

## 当前事实

当前仓已落地:

- `protocol/spec.md`:v0.1.5 draft,覆盖 stdio JSON-RPC、capability descriptor、flock runtime surface/isolation readiness matrix、orchestrate、events、consensus、approval、task.cancel、artifact、versioning、error model、unattended policy、implementation boundary。
- `protocol/version.md`:版本规则和 v0.1.5 范围。
- `docs/positioning.md`:定位、non-goals、设计来源边界。
- `docs/pr-specs/`:PR1-PR12 已覆盖 M0-M6c 拆解;M7+ 不继续沿旧 PR 编号硬拆,以 `docs/holp-blueprint.md` 为准。
- `adapters/`:朝下 adapter contract + Codex app-server real adapter(`mcp-codex`,含基础 stdio/turn recovery) + native-claude headless reviewer partial；`acp` 仍是 stub,`fake` transport 仅用于 demo/test。
- `daemon/`:参考 daemon 协议骨架,支持 stdio JSON-RPC 9 方法 + 事件订阅/replay(M1a+M1b)。
- `consumers/cli/`:参考 consumer CLI,可跑通 M1 fake backend 闭环,并提供 M6a fake consumer CLI partial:human-readable run/approval/consensus/artifact report + raw/debug wire view。
- M1 e2e 闭环:`initialize -> flock.declare -> orchestrate.run -> events.subscribe -> approval.resolve -> artifact.get`。**fake backend,非真实 provider**。
- M2 契约回归网:`daemon/handlers/m2_contract.test.ts` 已锁定当前实现的关键 v0.1.4 语义；approval 超时已由 M4a skeleton 接入正向 contract,显式 reviewer panel 的 consensus kernel 已由 M4b 接入,M5 deterministic demo 已覆盖 findings envelope / inline fallback,heartbeat 仍转交后续。
- M5 deterministic unanimous-approve fake+fake multi-agent consensus demo:`npm run demo:m5` 通过 stdio daemon wire 跑通 producer artifact、author exclusion、quorum、`consensus_verdict`、findings artifact envelope 和 `artifact_refs:false` inline fallback。
- M5b real reviewer execution pilot:显式 reviewer panel 可把非作者 `mcp-codex` reviewer execution hook 接入 consensus gate。completed vote 必须经过严格 JSON parser/validator,且本次 runtime selection 必须证明 `read_only_review` ready/enforced;fake reviewer path 也走同一个 validator。当前 Codex declaration 仍 degraded/read_only_not_enforced,真实 Codex reviewer smoke 默认 SKIP,显式开启后若无法证明只读则 INCONCLUSIVE。
- M6a fake consumer CLI partial:`npm run demo:cli` / `demo:cli:inline` / `demo:cli:degraded` 通过 stdio daemon wire 跑通 fake single/consensus/degraded paths,展示 runtime/isolation metadata、approval、terminal event、consensus report、artifact refs/inline fallback 和 raw/debug frames。real reviewer CLI 入口指向 PR9 opt-in smoke。
- M6b second real provider adapter partial:`native-claude` 通过 Claude Code headless `-p --output-format json` 接入 reviewer path;outer Claude CLI JSON 与 inner reviewer JSON 双层 fail-closed,read-only reviewer ready 取决于 whitelist/deny-write evidence probe。
- M6c runtime/session matrix foundation:consumer CLI 从 flock public wire response 渲染 runtime surface / session matrix,展示 `headless`/`acp`/`direct_user_session`、direct channel observation/control 能力、isolation readiness、global mutation risk、`declared_not_enforced` 和 `state_declaration_ref`。
- 参考 daemon 代码常量仍按 v0.1.4 contract 运行;v0.1.5 是当前协议基准修订,PR6+ 必须承接 runtime surface / isolation readiness matrix。

当前仓未落地,也不声称已落地:

- M7 WorkPlanner / multiround step loop / L0 workflow / JSONL exporter。
- M8 真实 ACP path 和 direct user session path。
- M9 stable gate protocol surface 和完整 consumer-facing gate/report 体验。
- M10 learned router replay / shadow / active/canary。
- M11 L1/L2 dynamic workflow。
- M12 Remote / distributed HOLP。
- 完整 ACP/direct/session matrix、真实 provider dissent/timeout、stable gate 等散项分别归入 M8/M9。
- 12 个 agent 在 `headless` / `acp` / `direct_user_session` 三类运行面的完整 adapter 实现。
- Web 传输。
- cmux/Warp/tmux/direct user session 真实 UI 控制与稳定 event model mapping。

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

- 不接 ACP/direct session 真 agent;`mcp-codex` 已在 M3 接 Codex app-server,`native-claude` 已在 M6b 接 headless reviewer partial。
- 不做持久化数据库。
- 不做 WebSocket。

## M2:Protocol Contract Tests

> 状态(PR #9 + PR6/M4a + PR7/M4b + PR8/M5):**契约层已锁定**——approval 超时已由 M4a 接入正向 contract;显式 reviewer panel 的 consensus kernel 已由 M4b 接入正向 contract;M5 demo 已正向覆盖 findings artifact envelope / inline fallback;heartbeat 仍转交后续(由 `daemon/handlers/m2_contract.test.ts` §F 锁定边界)。**非**无保留的「全覆盖完成」。

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

> **覆盖边界(M1/M2 实现 vs 转交后续)**:上面是按 v0.1.4 协议面的**理想全集**列举。其中 approval `approval_expired` 超时已由 M4a run state machine/timer 接入正向 contract。显式 reviewer panel 的 consensus 第 2 段 / `consensus_verdict` / `quorum.met` / `excluded[]` / `errors[]` 已由 M4b kernel 接入;无 reviewer panel 的单 coder run 仍不发 consensus。consensus findings artifact envelope / `artifact_refs:false` inline fallback 已由 M5 deterministic demo 正向覆盖。heartbeat 不受 category 过滤仍转交后续,由 `daemon/handlers/m2_contract.test.ts` 的 §F 锁定当前边界。逐项拆分见 `docs/pr-specs/pr4-m2-contract-tests.md` 的 **Deferral ledger**。

验收标准:

- 本地测试命令一次跑过。
- 测试失败能定位到具体协议语义,不是只看 stdout 文案。
- 「现在锁定」栏全过 + §F 负向锁定到位 → M2 可标「契约层已锁定(consensus 执行 / approval 超时 / M5 findings envelope/inline demo / heartbeat 转交后续)」,不得标无保留的「全覆盖完成」。

非目标:

- 不要求真实 provider。
- 不要求性能压测。

## M3:First Real Adapter

目标:先接通真实 agent,验证 adapter contract 和 permission/reviewer 语义。当前实现选择 **Codex app-server over stdio**,注册为 HOLP transport `"mcp-codex"`;并补了 **native-claude headless reviewer partial**。`acp` 仍是桩。

建议顺序:

1. Codex 优先:更适合作为 CLI/MCP 形状的首个协议测试对象。
2. Claude 第二:已补 native-claude headless reviewer partial;SDK/ACP/direct session 仍不做。
3. ACP 第三:等前两者证明 adapter contract 稳定后再接。

交付物:

- [x] 一个真实 `AgentBackendFactory` wrapper(Codex app-server)。
- [x] provider message 到 `AgentMessage` 的映射。
- [x] permission request 到 `approval_requested` 的映射,复用现有 injected `permissionHandler` / `ApprovalRecord.resumeBackend` await-Promise path。
- [x] provider availability probe,用于 `flock.declare`/`flock.discover` 返回 `ready/degraded/rejected`。
- [x] Codex app-server 基础 runtime recovery:无 turn activity 的 transient stdio/app-server failure 或 usage-limit failure 会重启 app-server、退避并重放原 prompt;已有 activity 后 fail-closed,避免重复执行副作用。该层不做 happier connected-service 多账号切换。
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

> 状态(PR6/M4a + PR7/M4b + PR8/M5 + PR9/M5b + PR11/M6b):data/state/decision skeleton partial 已落地:内部 event archive、`decision_made`、harness registry archive、run lifecycle state machine、approval expiry timer。M4b 已接入纯 consensus kernel、author exclusion、二段式 quorum 和显式 reviewer panel 的 `consensus_verdict`/`consensus_degraded`。M5 已补 deterministic fake+fake demo,展示 findings artifact envelope / inline fallback。M5b 已补 `mcp-codex` reviewer execution hook,但只在 runtime read-only attestation + strict JSON validator 通过时计入 completed vote;当前 Codex profile degraded 时会 fail-closed/INCONCLUSIVE。M6b 已补 `native-claude` headless reviewer partial,但 read-only ready 取决于 enforcement probe evidence。`permission_surface` / `observability_surface` 仍作为保留列记录为 `unknown`;稳定 gate protocol surface 仍未落地。

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

> 状态(PR8):**deterministic unanimous-approve demo 已落地**。`npm run demo:m5` 使用 fake+fake reviewer path 真走 stdio JSON-RPC daemon wire,覆盖 producer artifact、author exclusion、quorum、findings artifact envelope 和 `artifact_refs:false` inline fallback。它不表示真实 reviewer provider sessions 或 dissent/timeout demo 已执行。

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
- failed/timeout/abstain reviewer 进入 `errors[]`,不混进 completed vote(由 M4b kernel tests 覆盖;M5 demo 本身只演示 deterministic unanimous-approve path,不声称已覆盖 dissent/timeout demo)。
- consensus result 只作为 `events.event` 的 `category=consensus,name=consensus_verdict` 发送。

非目标:

- 不追求复杂 UI。
- 不做 cloud/remote。

## M6:Consumer Adapters

目标:让协议能被真实 consumer 试用,但仍保持 vendor-neutral。

建议拆成 4 个后续 PR:

1. PR9/M5b:真实 reviewer execution pilot 已落地为 `mcp-codex` reviewer execution hook + strict parser/attestation gate;只有 read-only attestation ready 时才会把真实 backend 输出计为 completed vote。
2. PR10/M6a:consumer CLI experience 已落地 fake partial,让开发者能发起 fake run、处理 approval、查看 artifact 和 consensus report;real reviewer path 指向 PR9 opt-in smoke。
3. PR11/M6b:第二真实 provider adapter 已补 `native-claude` headless reviewer partial,证明 HOLP 不只是 Codex-only。
4. PR12/M6c:runtime surface/session matrix 已落地为 consumer-visible foundation,把 headless/acp/direct_user_session 的 readiness、direct channel observation/control 能力和隔离声明从 flock wire 渲染出来。

执行顺序上,PR10 已先基于 fake/M5 consensus path 落地,PR9 随后补真实 reviewer abstraction / parser / enforcement attestation 和 opt-in Codex reviewer smoke。PR11 依赖 PR9 的真实 reviewer abstraction / parser / enforcement attestation,PR12 的完整展示价值依赖 PR10 的 CLI 容器和 PR11 的第二 provider matrix。

交付物:

- CLI consumer:开发者本地最小入口。
- cmux adapter 示例:展示已有终端/工具如何接入 HOLP。
- direct user session 示例:已补 `docs/runtime-session-matrix.md`,覆盖 product session 与 terminal session 词表;Warp/cmux/tmux 这类 terminal session 必须声明 attach/observe/read 与 inject/interrupt/cancel 能力和 route/owner_scope 隔离边界。
- consumer capability negotiation 示例。
- consumer 侧 event rendering 最小格式。

验收标准:

- CLI fake partial 能演示 M1 single-coder、M5 consensus、consensus_degraded/degraded report;真实 Codex reviewer path 通过 PR9 opt-in smoke 验证,不是默认 CLI/CI 路径。
- cmux 示例不要求改 cmux 主线,但要清楚展示 `events.subscribe` 与 cmux 事件模型的差异。
- consumer 不依赖 provider 私有细节。

非目标:

- 不做产品化 Web app。
- 不做 SaaS。

## M7-M12:Blueprint 路线

后续主线已移到 `docs/holp-blueprint.md`,这里保留压缩索引:

- M7 foundation loop: `WorkPlanner` / `RuleWorkPlanner`, `max_steps=1` 兼容, `max_steps>1` L0 workflow, step-level governance snapshot, JSONL exporter, reward attribution versioning。
- M8 real runtime surfaces:第一条真实 ACP path 和 direct_user_session path,继续保持 unsupported/unknown/rejected 诚实矩阵。
- M9 consumer and gate surface:stable gate protocol surface,CLI/TUI/external UI 一致渲染,approval/override/audit 单通道。
- M10 learned router safe lane:learned-router transport / work_planner role,offline replay/eval,shadow,opt-in active/canary。
- M11 dynamic workflow:L1 半动态 workflow 和有证据支撑的 L2 全动态 workflow。
- M12 Remote and distributed HOLP:remote runner、harness health/readiness、artifact/event/approval relay,保留 local-first safety。

## Future:Web/Stable

Remote execution 属 Blueprint M12。它不进入 v0.1.x wire;落地时必须作为独立协议扩展定义 workspace sync、secret scope、artifact transport、network policy、identity、cost/accounting、remote cancellation。

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
