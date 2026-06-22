# HOLP 多轮基座 Spec - 从单步 run 到 step loop

> 版本: draft v0.2
> 定位: 在训练 learned router 之前,先把 HOLP 扩成能产生 per-step 决策数据的基座。
> 原则: 单步 run 必须仍是 `max_steps=1` 的特例;不破坏当前 216+ 测试语义。

## 0. 为什么多轮基座先于 router

当前 HOLP 是单步 run:

```text
startSession -> sendPrompt -> optional consensus -> terminal
```

这只能产生“这类任务一次派给谁”的数据。TRINITY/Fugu/Conductor 给 HOLP 的启发是: 多 agent orchestration 的收益可能来自多轮中对 worker、role 或 workflow 的选择;没有 step history,HOLP 学不到这类决策。

所以顺序是硬依赖:

```text
WorkPlanner 抽象 -> 多轮 step loop -> step history / samples -> learned router
```

## 1. 命名

- `Dispatcher`: 保留给现有 JSON-RPC 方法分发器,不动。
- `WorkPlanner`: 新的派单决策器,输入 `DispatchState`,输出下一步计划。
- `RuleWorkPlanner`: 规则实现,默认可用。
- `LearnedWorkPlanner`: 未来 learned 实现,默认不开。

命名边界: `Dispatcher` 是 wire/method 分发;`WorkPlanner` 是 decision 层派单。二者不能互相替代职责。

## 2. Step loop

不要重写 `driveRun` 的所有行为。第一阶段只在外层引入 step loop 骨架:

```text
state = initial DispatchState
while run active and step < max_steps:
  next = WorkPlanner.nextStep(state)
  if next.kind == terminal: break
  result = execute next through existing backend/approval/consensus paths
  state.history += { next, result }
terminal
```

兼容要求:

- `max_steps=1` 时行为等价当前单步 run。
- 现有 approval、consensus、artifact、task.cancel 语义不变。
- `unattended_policy.max_unattended_steps` 作为 max step 的语义来源;不新造并行概念。

## 3. WorkPlanner 输出

多轮阶段的最小输出:

```ts
type WorkPlan =
  | { kind: "step"; action: "plan" | "implement" | "test" | "review" | "fix" | "synthesize"; agent_id: string; role: string }
  | { kind: "terminal"; reason: string };
```

规则版默认映射:

- coder -> implement
- reviewer -> review
- tester -> test
- architect -> plan

所有 hard constraints 必须在 WorkPlanner 调用前过滤: flock `resolved_roles`、runtime/isolation gate、approval precondition 都不下放给 WorkPlanner。WorkPlanner 只在合法候选中排序/选择。

## 4. Workflow L0

第一版只做 L0 静态工作流:

- `single-step`: 当前行为,默认。
- `linear`: plan -> implement -> test -> review。
- `spec-driven`: plan/spec -> implement -> test -> review -> fix/review loop,但第一版可只声明模板,不实现动态插步。

`orchestrate.run` 未来可选加 `workflow`;缺省走 `single-step`。

不做:

- L1 半动态增删/重排步骤。
- L2 Conductor 式全动态 workflow 生成。

## 5. DispatchState.history

多轮后 `history` 必须记录每步:

- step index
- action / role / agent
- selected runtime/isolation summary
- emitted terminal or intermediate result
- approval/consensus outcome 摘要
- failure reason,如有

`history` 只保存决策和训练需要的摘要,不塞完整 event log。

## 6. 数据导出

样本粒度从 run 级扩展到 step 级。`DispatchState.v1` 的 canonical schema 在 `docs/holp-blueprint.md` 的 M7 completion contract 维护;本节只说明多轮 history 需要额外填充 step 视图。

```json
{
  "sample_id": "...",
  "run_id": "...",
  "step_index": 0,
  "state": {},
  "action": { "kind": "step", "agent_id": "coder", "role": "coder" },
  "reward": 1,
  "reward_basis": "merged",
  "reward_policy_version": "v1"
}
```

导出器:

- 只读 governance。
- 输出 JSONL。
- 支持本地脱敏钩子;默认透传。
- 原始 governance 保留,所以 reward 可重算。
- exporter 必须是 governance log 的纯函数;CLI 参数只能选择输出视图,不能改变 reward 语义。

## 7. Reward 归因

第一版采用保守策略:

- terminal reward 可广播到本 run 的有效 step。
- 与派单无关的 step 作废,`reward=null`。
- `reward_basis` 必填。
- `reward_policy_version` 必填。

后续可替换成更细的 step credit assignment,但不需要重跑真实任务。

## 8. 协议影响

尽量小:

- 可新增旧 consumer 忽略安全的事件名:
  - `workflow_selected`
  - `step_planned`
  - `workflow_revised` 仅为未来 L1 预留
- `orchestrate.run.workflow` 是可选字段;缺省等价当前行为。
- 不改 approval/consensus/artifact/error model。

## 9. 落地顺序

1. `WorkPlanner` / `RuleWorkPlanner`,单步行为零变化。
2. step loop skeleton,默认 `max_steps=1`。
3. `DispatchState.history` 摘要结构。
4. L0 workflow 模板。
5. governance decision snapshot。
6. step 级 JSONL exporter。
7. reward attribution versioning。
8. offline replay / eval harness。
9. `LearnedWorkPlanner` shadow 接入。

## 10. 非目标

- 不训练 learned router。
- 不启用 active learned routing。
- 不做 L2 全动态 workflow。
- 不接 ACP/direct session。
- 不做 Remote。
- 不破坏单步 run。

一句话: 多轮基座的价值不是“现在就聪明”,而是让 HOLP 开始产生 learned router 真正需要的 per-step 活数据。
