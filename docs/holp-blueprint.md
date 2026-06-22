# HOLP Blueprint - Full Roadmap

> 版本: draft v0.1
> 目的: 给 HOLP 后续演进一张完整地图: 哪些都要做,按什么依赖顺序做,哪些能力先声明后实现。

## 1. HOLP 是什么

HOLP 是本地优先、vendor-neutral、人在回路上的 multi-agent orchestration protocol,加一个参考 daemon 和参考 consumer。

它的核心价值:

- 用公开 wire 把不同 agent/harness 放进同一套编排协议。
- 让人能在关键点审批,而不是每一步盯着。
- 让共识、artifact、runtime readiness、approval、decision 变得可观察。
- 支撑从规则编排走到 learned router、动态 workflow、真实 runtime session、Remote 执行,但每一步都可回退。

## 2. HOLP 不是何物

- 不是 Fugu 的复刻产品。
- 不是 provider SDK 大杂烩。
- 不是强制 learned routing 的黑盒 orchestrator。
- 不是一开始就绑定 Remote/cloud 的 runner;Remote 是后续 deployment/runtime surface。
- 不是 ACP/direct session 的 UI 私有状态容器;但会接真实 ACP/direct session 路径。
- 不是把所有 agent 都涂成 ready 的能力表。

## 3. 当前现实

已落地:

- v0.1.5 draft 协议。
- daemon JSON-RPC 9 方法。
- fake single/multi-agent demo。
- consensus kernel、author exclusion、quorum。
- governance events/decisions/run state/harness registry。
- Codex app-server adapter partial。
- native-claude headless reviewer partial。
- consumer CLI 和 runtime/session matrix report。

待落地:

- 多轮 step loop。
- WorkPlanner 抽象。
- workflow 模板。
- training sample exporter。
- learned router replay/shadow/active。
- ACP/direct session 真实执行。
- stable gate protocol surface。
- L1 半动态 workflow。
- L2 全动态 workflow。
- Remote / distributed execution surface。

## 4. 分层边界

### Protocol

定义 wire: initialize、flock、orchestrate.run、events、approval、artifact、consensus、runtime matrix。

不放 provider 私有配置、训练细节、UI 控制内部状态。

### Reference daemon

负责协议参考实现、run lifecycle、governance、adapter 调度。

它可以长成生产级实现,但协议不依赖它的内部存储。

### Governance

记录 events、decisions、run state、harness registry。

当前保持 internal。未来如果 public query,必须单独 SPEC,不能顺手暴露。

### WorkPlanner

选择下一步 action/agent/role。

规则版默认;learned 版可选;任何 learned 异常回退规则版。

WorkPlanner 只处理 decision 层选择。JSON-RPC method 分发仍属于 daemon dispatcher;role、runtime、isolation、approval 等 hard constraints 必须在 WorkPlanner 之前过滤。

### Workflow engine

执行 workflow 模板和 step loop。

- L0: 静态模板,如 single-step、linear、spec-driven。
- L1: 半动态 workflow,允许基于结果插入 fix/review/test 等受限步骤。
- L2: 全动态 workflow,由 learned/router/workflow policy 生成或重排步骤。

L2 是目标,不是非目标;但必须等 foundation、数据闭环、router/replay/shadow 可靠后再启用。

### Adapters

执行任务。headless、ACP、direct_user_session 是 runtime surface,不是同一种东西。

adapter 只声明自己能做什么;不能把声明当强制隔离证明。

### Runtime sessions

把 runtime surface 从声明推进到真实路径:

- headless: CLI / stdio / server adapter。
- ACP: agent-client-protocol session。
- direct_user_session: attach / inject / interrupt / cancel 用户会话。
- remote: 远程 runner 或 distributed execution。

这些都是 HOLP 需要覆盖的 surface,只是落地顺序不同。

### Gate surface

当前 consensus/gate 先是内部事件和 demo surface。后续要做 stable gate protocol surface,让 consumer 能稳定渲染 verdict、policy、override 和 audit。

### Consumers

展示和交互。CLI 是 reference consumer;cmux/Warp/happier 可以接 HOLP,但各自 UI 状态不进入 HOLP 核心。

### Learned router

训练/评估/权重在协议外。HOLP 只提供 state、合法候选、样本、offline replay、shadow/active 接口。

## 5. 外部启发

Sakana Fugu / TRINITY / Conductor 说明 orchestration 可以被学习:

- Fugu: 单 API 背后协调多个模型/agent。
- TRINITY: learned coordinator 在多轮过程中选择 LLM 并分配角色。
- Conductor: 学习自然语言 workflow / orchestration 的方向。

这些只作为方向启发,不是 HOLP 的实现配方。HOLP 采用的不是“闭源单模型 API”形态,而是“开源协议 + 可观察治理 + 可回退 learned WorkPlanner”形态。

## 6. Roadmap

### M7: Foundation loop

目标不是半成品 shell,而是一个完整可用的地基层:

- `WorkPlanner` / `RuleWorkPlanner` 真实接入 `orchestrate.run`。
- `max_steps=1` 完全兼容当前单步 run。
- `max_steps>1` 能按 L0 workflow 跑多轮 step loop。
- 每步记录 `DispatchState.v1`、`WorkPlan`、runtime/isolation、approval/consensus 摘要。
- JSONL exporter 能导出 step-level samples。
- reward attribution 有版本号,并可从 governance log 重算。

完成后可以声称 “WorkPlanner/multiround/data-export foundation landed”。

M7 completion contract:

- `WorkPlan` 支持 `plan | implement | test | review | fix | synthesize` step,以及 terminal decision。
- `DispatchState.v1` 至少包含 `run_id`、`goal`、`trigger`、`decision_kind`、`workflow_id`、`step_index`、`candidates`、`constraints`、`history`。
- L0 workflow 至少包含 `single-step`、`linear`、`spec-driven`。
- hard constraints 在 WorkPlanner 前过滤;WorkPlanner 只在合法候选内排序/选择。
- JSONL exporter 是 governance log 的纯函数;reward 带 `reward_policy_version`,不确定归因宁可作废。

### M8: Real runtime surfaces

把 runtime/session matrix 从声明推进到第一批真实执行路径:

- ACP 第一条真实路径。
- direct_user_session 第一条真实路径。
- reviewer/tester/architect 的真实 headless provider path。
- runtime selection 必须继续写入 governance。
- unsupported/unknown surface 仍然显式标明,不假装 ready。

完成后可以声称 “first real ACP/direct session path landed”,但不能声称 12-agent/runtime adapter 全覆盖。

### M9: Consumer and gate surface

把用户能看到、能审核、能批准/拒绝的体验补完整:

- stable gate protocol surface。
- consumer CLI / TUI / external UI 的一致事件渲染。
- consensus report、artifact report、runtime readiness report。
- approval / override / audit 单通道。

完成后 HOLP 应该可以作为真实 consumer-facing orchestration layer 使用,而不是只靠 demo 证明。

### M10: Learned router safe lane

- learned-router transport / work_planner role。
- offline replay / eval harness。
- `LearnedWorkPlanner` shadow mode。
- active mode 先 opt-in,再通过 canary / rollout 逐步扩大。

默认启用 learned routing 是目标态,但必须建立在 replay、shadow、canary 和回退证据之上。hard constraints 永远在 learned 之外执行,不能被 learned 绕过。

### M11: Dynamic workflow

- L1 半动态 workflow: 规则版可先做,只允许受限插步/重试/fix-review loop。
- L2 全动态 workflow: 必须等 learned router/replay/shadow 有证据后启用。
- workflow revision 必须可审计、可回放、可禁用。

L2 是明确目标,不是“以后再说”的垃圾桶;只是它依赖 M7-M10。

### M12: Remote and distributed HOLP

- remote runner / distributed execution surface。
- remote harness declaration 和 health/readiness。
- remote artifact/event/approval relay。
- local-first safety model 仍保留;Remote 不应变成绕过 approval 或 isolation 声明的后门。

## 7. 设计纪律

- 规则版永远可跑。
- learned 永远可关。
- 人类 approval 单通道不被绕过。
- runtime declaration 不等于真实隔离。
- 不把未来能力写成已完成事实。
- 数据宁少勿脏;不确定 reward 一律作废。

一句话: HOLP 先做协议和可观测基座,再让 learned router 在安全围栏里优化派单。
