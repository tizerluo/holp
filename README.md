# HOLP — Human On Loop Protocol

**开源、免费、本地优先的 multi-agent 编排协议,加一个参考 daemon。**

让任何终端 / 工具 / APP(cmux、Warp、happier、CLI……)都能免费拥有「把自己本机装的异构 agent(Claude Code、Codex、Gemini、Hermes、Cursor……)组织起来」的编排层——看得见、能插手、跨厂商共识、无人值守跑闭环,人在回路上只在必要时介入。

> **Human on Loop**:不是人在每个 tick 上,是人在回路上。

## What is Human On the Loop

HOLP = **Human On the Loop Protocol**,不是 Human In the Loop。

Human In the Loop 通常意味着每个内容或动作都需要人逐项审批。HOLP 不把逐项审批当主线:前沿模型 + 多模型多 harness 对抗 + 对用户的问询机制,应该尽量在 Spec/Plan 阶段把需求定准。HOLP 要的是整个过程可回溯、可审查;结果出了问题时,能定位问题发生在哪个 agent、哪个 runtime surface、哪条事件或哪个决策点,并知道该怎么修改。

因此 HOLP 的核心价值是把多家 Agent Harness 的行为抽象统一。approval/gate 只是环上的可选闸,用于合并、低置信度、预算或语义 override 等需要人介入的节点;它不是协议的本质,也不是每一步都要人批准的 Human-In-the-Loop 工作流。

## 为什么

Warp 的 Oz 证明了 multi-harness agent 编排是真需求,但闭源 + 付费 + 云绑定。HOLP 是它的**开源对位物**——填「没人提供开源、免费、本地优先、vendor-neutral 的异构 agent 编排协议」这个空洞。

## 仓结构

```
holp/
  protocol/     协议本身(spec / 消息定义 / 版本 / 样例)—— 独立身份,成熟后可独立成仓
  daemon/       参考实现(协议骨架 + M4a/M4b governance skeleton + M5 deterministic consensus demo)
  adapters/     朝下 agent 适配(Codex app-server + native-claude headless reviewer partial + PR14 first-batch ACP/direct pilot;generic `acp` transport 仍是桩)
  consumers/    朝上 consumer 参考(最小 CLI demo;cmux Harness Workspace 产品已拆至独立仓 holp-cmux)
  tests/        e2e + 协议契约测试
  docs/         定位 / roadmap / PR specs / non-goals
```

## 当前主线

项目按五个阶段推进(SPEC 精度见 `protocol/spec.md`,PLAN 精度见 `docs/roadmap.md` + `docs/holp-blueprint.md`,PR 精度见 `docs/pr-specs/`):

1. **P1 协议基座**(M0-M2)— 协议 spec、参考 daemon、契约测试。已完成。
2. **P2 真实接线 + 治理内核**(M3-M5b)— mcp-codex/native-claude adapter、共识内核、真实 reviewer pilot。已完成。
3. **P3 runtime surface 对齐**(#45 链)— 7 个 CLI agent 三类运行面 readiness、validation matrix。已完成,声明止于 `terminal-consumer-integration-ready`。
4. **P4 可用 UI 先于数据**(#66-#103)— Harness Workspace consumer。**已整体拆至 [holp-cmux](https://github.com/tizerluo/holp-cmux) 仓**(#105),在那边继续;真实使用验收 gate 记录也随之迁移。
5. **P5 数据/learned**(#41→#44→#36,M7/M10-M12)— M7 foundation loop、M10/M11 safe-lane foundation 已落地;真实 learned-model active/canary、L2 learned-active readiness 和 M12 Remote 仍未完成。

## 状态

🚧 **v0.1.8 draft**(v0.1.5 吸收 Issue #11 harness isolation baseline,v0.1.7/v0.1.8 增加 gate report 与 learned/dynamic workflow safe-lane),参考实现进行中。

- [x] 定位(`docs/positioning.md`)
- [x] 整体规划(`docs/roadmap.md`) + 完整蓝图(`docs/holp-blueprint.md`)
- [x] PR1-PR16 已落地 SPEC(`docs/pr-specs/`)
- [x] 协议 spec v0.1.8(`protocol/spec.md`)— 经 v0.1→v0.1.4 迭代后,在 v0.1.5 把 runtime surface / isolation readiness matrix 提升为协议基准,并在 v0.1.7/v0.1.8 增加 gate report 与 learned/dynamic workflow safe-lane
- [x] 朝下 adapter 契约 + 真实 adapter(`adapters/`)— **mcp-codex 接 Codex app-server,含基础 turn recovery;native-claude 接 Claude Code headless reviewer partial;PR14 已接 first-batch harness ACP/direct pilot;generic `acp` transport 仍是桩**
- [x] 参考 daemon 协议骨架(`daemon/`)— stdio JSON-RPC 9 方法 + 事件订阅/replay(M1a+M1b)
- [x] 参考 consumer CLI(`consumers/cli/`)— 跑通 M1 闭环 demo + M6a fake consumer CLI partial,**仅用 fake backend**
- [x] M1 e2e 闭环(`initialize→flock.declare→orchestrate.run→events.subscribe→approval.resolve→artifact.get`)— **fake backend,非真实 provider**
- [x] M2 契约回归网(`daemon/handlers/m2_contract.test.ts`)— **契约层已锁定;approval 超时已由 M4a skeleton 接入,显式 reviewer panel 的 consensus kernel 已由 M4b 接入,heartbeat 仍转交后续(§F 锁定)**
- [x] M4a governance data/state/decision skeleton partial— internal events、decision records、harness registry archive、run lifecycle state machine、approval expiry timer
- [x] M4b consensus gate triage kernel partial— 纯 consensus aggregation、author exclusion、二段式 quorum、显式 reviewer panel 的 `consensus_verdict`/`consensus_degraded`
- [x] M5 deterministic unanimous-approve multi-agent consensus demo— fake+fake reviewer path 跑通 producer artifact、author exclusion、quorum、findings envelope/inline fallback
- [x] M6a fake consumer CLI partial— `run` 命令可发起 fake single/consensus/degraded run、处理 approval、渲染 consensus/artifact report、raw/debug wire frames
- [x] M5b real reviewer execution pilot— 显式 reviewer panel 已接入 `mcp-codex` reviewer execution hook;completed vote 仍需 runtime read-only attestation 为 ready,真实 smoke 需显式 opt-in
- [x] M6b second real provider adapter partial— `native-claude` 通过 Claude Code `-p --output-format json` 接入 headless reviewer path;ready 取决于 read-only tool whitelist enforcement probe
- [x] M6c runtime/session matrix foundation— CLI 从 flock wire 渲染 `headless`/`acp`/`direct_user_session` 矩阵、direct channel observation/control 能力、isolation readiness 和声明风险
- [x] 真实 adapter 接线(M3)— **Codex app-server over stdio 注册为 `mcp-codex`;自动覆盖 fake/app-server harness,已补基础 stdio/turn recovery;真实 smoke 依赖本机 Codex auth**

Blueprint M7-M12 当前状态:

- [x] M7 foundation loop— `WorkPlanner` / multiround step loop / L0 workflow / step-level JSONL export。实现依据:`6ac698e` (#30) + PR13b hardening `a288e94` (#32)。
- [x] M8 real runtime surfaces pilot— 第一批 harness registry/probe、ACP thin client、direct tmux path、runtime-surface selection 和 opt-in smoke。实现依据:`c72cc07` (#34)。这不是 bounded CLI cohort 完整候选空间证明。
- [x] M9 consumer and stable gate surface— `GateReport.v1`、capability-gated `gate_report`、approval/override/audit 和 CLI report。实现依据:`958784f` (#35)。
- [x] M10 learned router safe lane foundation— replay/eval、shadow、fixture active/canary fail-closed、promotion evidence shape。实现依据:`2caab2b` (#37);不声称 `real_learned_model` active/canary readiness。
- [x] M11 dynamic workflow foundation— L1 bounded workflow 和 L2 `WorkflowRevision.v1` validator/reject/audit。实现依据:`2caab2b` (#37);不声称 L2 learned-active readiness。
- [ ] M12 Remote and distributed HOLP— remote runner、declaration health、artifact/event/approval relay。未发现 HEAD 祖先实现 commit。

当前 learned-model data readiness 之前新增 #45 runtime-surface parity + terminal-consumer smoke 前置阶段。PR14 是 first-batch harness pilot,不是 bounded CLI cohort 的完整候选空间证明,也不是 cmux-ready 证明。

> **当前只声称**:protocol draft + **fake backend 跑通的 M1 协议闭环**(daemon + CLI demo)+ M2 契约层 + **Codex app-server 作为首个真实 adapter**(含基础 stdio/turn recovery,不含多账号 quota 切换)+ v0.1.5 runtime surface/isolation baseline + **M4a governance data/state/decision skeleton partial** + **M4b consensus gate triage kernel partial** + **M5 deterministic unanimous-approve fake+fake multi-agent consensus demo** + **M5b real reviewer execution pilot** + **M6a fake consumer CLI partial** + **M6b native-claude headless reviewer partial** + **M6c runtime/session matrix foundation** + **M7 WorkPlanner/step-loop/JSONL exporter foundation** + **M8 first real runtime surface harness pilot** + **M9 stable gate report surface** + **M10/M11 safe-lane learned-router/dynamic-workflow foundation**。CLI demos 仍显式使用 `fake` transport;真实 Codex/Claude reviewer paths 通过 opt-in smoke 验证,且 read-only enforcement 不可证明时只会 INCONCLUSIVE/degraded;matrix report 只是 `flock.declare`/`flock.discover` wire 的 descriptive projection,不替代 `orchestrate.run` eligibility gate;first-batch ACP/direct readiness 依赖 opt-in smoke 和本机 binary/auth/quota;不声称 12 个 agent 已完整支持 `headless` / `acp` / `direct_user_session`,也不声称真实多 provider dissent/timeout reviewer demo、`real_learned_model` active/canary readiness、L2 learned-active readiness 或 Remote 已完成。

> 参考 daemon 已把 v0.1.5 runtime surface/isolation matrix 落进 declare/discover、run metadata 和内部 registry archive;这仍是声明/记录层,不表示真实 OS/provider 隔离已经强制执行。
> M4a 内部 registry 已保留 `permission_surface` / `observability_surface` 列,但当前统一记录为 `unknown`;后续 adapter/governance PR 再接真实声明来源。
> M5 demo 仍是 deterministic unanimous-approve fake+fake reviewer verification layer:它真走 HOLP wire、展示 findings artifact envelope / inline fallback,但 reviewer votes 来自 fake reviewer fixture 并经 PR9 canonical validator 校验,不表示真实 reviewer provider dissent/timeout demo 已接。
> M5b real reviewer pilot 只接入 `mcp-codex` reviewer execution hook:completed vote 必须经过严格 JSON parser/validator,且本次 runtime selection 必须证明 `read_only_review` 已 ready/enforced。当前 Codex declaration 仍是 degraded/read_only_not_enforced,因此真实 smoke 会诚实给出 INCONCLUSIVE,不会被当成 approve。
> M6b native-claude partial 只接 Claude Code headless `-p --output-format json` reviewer path;外层 Claude CLI JSON 先 fail-closed,内层 reviewer result 复用 PR9 parser/attestation gate。`acp` surface 仍明确 unsupported,`direct_user_session` 仍 unknown/rejected。
> M6c matrix report 只从 flock public wire response 读取 `runtime_surfaces`;`state_declaration_ref` 仍是声明引用/占位字符串,本 PR 不保证可解引用。direct channel 的 attach/observe/read 是 observation surface,inject/interrupt/cancel 是 control surface,两者不能合并解读为可注入调度能力。词表示例见 `docs/runtime-session-matrix.md`。
> M8 first real runtime surface harness pilot 已接第一批 Cursor Agent、Kimi Code、OpenCode、Pi、Reasonix 的 registry/probe/factory、ACP thin client 与 direct tmux path;Reasonix ACP 仍按 degraded/未认证处理,真实 smoke 默认 opt-in。
> M10/M11 safe-lane foundation 只声明 replay/eval、shadow、fixture fail-closed fallback、L1 bounded workflow 和 L2 revision validator/reject/audit。真实 learned-model active/canary、L2 learned-active workflow、kill switch/automatic demotion 仍是后续工作。

## CLI 快速体验

```bash
npm run demo              # fake single-coder path
npm run demo:cli          # fake consensus report + findings artifacts
npm run demo:cli:inline   # fake consensus report + inline findings fallback
npm run demo:cli:degraded # deterministic consensus_degraded / run_blocked report
npm run smoke:reviewer:codex # opt-in real Codex reviewer smoke;默认 SKIP,需 HOLP_REAL_CODEX_REVIEWER_SMOKE=1
npm run smoke:reviewer:claude # opt-in real Claude reviewer smoke;默认 SKIP,需 HOLP_REAL_CLAUDE_REVIEWER_SMOKE=1
```

通用入口:

```bash
npm run cli -- run --scenario=consensus --decision=approved --artifact-refs=true
npm run cli -- run --scenario=real-reviewer
```

`real-reviewer` CLI scenario 仍保持 consumer 体验入口;真实 Codex/Claude reviewer execution 的可验证入口是 opt-in smoke,默认 SKIP,只有显式 opt-in 且本机 binary/auth/quota/read-only enforcement 都满足时才会 PASS。CLI 默认输出是 human-readable rendered view;`--raw` / `--debug` 会打印 daemon stdio JSON-RPC wire frames。

## 协议速览(v0.1.5)

stdio,两面:JSON-RPC 控制面 + 带 subscription_id 的事件 notification 流。consumer 声明/发现 agent 队伍 → 发编排目标 → 订阅事件 → 需要时人拍板(approval 单通道状态机)。

12 章:握手+能力 / flock(declare+discover,含 runtime surface + isolation readiness matrix) / orchestrate.run / events.subscribe / consensus / approval / artifact / 版本化 / 错误模型 / unattended policy / 实现边界。(lifecycle 不单列章,是事件流的 category + `task.cancel` 命令。)详见 `protocol/spec.md`。

v0.1.5 基准要求 HOLP 能表达每个 harness 在 `headless`、`acp`、`direct_user_session` 三类运行面和不同 isolation profile 下的 readiness。`ready` 不表示 agent 整体可用,只表示某个 runtime surface + isolation profile 可调度。

当前 `adapters/direct-tmux.ts` 的 `direct_user_session` 是一次性可见模式:HOLP 创建并拥有 tmux pane,注入一次性 agent 命令(`claude -p` / `codex exec` 等同类 one-shot 命令),轮询结构化完成标记,并可把 pane 保留一段时间供用户 attach 观察。它不是交互式 Agent 界面;用户不能在运行中直接输入纠偏。真正的交互式驱动是未来独立能力。

## 设计来源(不凭空发明)

events 流 ← cmux `CmuxEventBus`;flock/orchestrate/Local|Remote ← Oz proto(借思路,不抄依赖);consensus ← loopwright 共识评审;朝下 adapter 契约 ← happier `ExecutionRunBackendFactory`。完整溯源见 `docs/positioning.md`。

## 许可

(待定 MIT / Apache-2.0)
