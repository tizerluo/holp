# HOLP 调整 Spec - 为 learned router 预留接入点

> 版本: draft v0.2
> 范围: 只定义 HOLP 为 learned router 做准备的协议/治理/数据调整。**不训练 router,不启用 learned 决策。**
> 纪律: 规则版永远默认可用;learned 只能作为可拔插组件;人始终在回路上。

## 0. 当前代码事实

- HOLP 当前是单步 run: 一个 coder backend 跑一轮,之后可选 consensus gate。
- 真实决策点很少: 选 coder 在 `orchestrate_run.ts`;显式 reviewer panel 的执行集/author exclusion 在 `runEngine.runConsensusGate`。
- `daemon/core/dispatcher.ts` 已经有 JSON-RPC `Dispatcher` 类。该名字只表示 wire/method 分发;派谁决策器统一命名为 **WorkPlanner**,只表示 decision 层计划。
- governance 已有 `events / decisions / runStates / harnessRegistry`,能记录 runtime selection、reviewer execution、consensus verdict、terminal 等训练原料。

## 1. 调整目标

把 HOLP 从“决策写死在 handler/runEngine 里”,调整为:

- 决策点通过 `WorkPlanner` 接口调用。
- 默认实现 `RuleWorkPlanner` 保持现有行为。
- 决策时记录可序列化 `DispatchState` 快照。
- run 终态后可以从 governance 导出 JSONL 训练样本。
- learned router 未来只在合法候选集内选择,异常时回退规则版。

## 2. WorkPlanner 最小契约

第一阶段就使用未来多轮会继续沿用的 `nextStep` 契约。当前 coder/reviewer 选择只是规则实现里的特例。这里的 `WorkPlan` 是 `WorkPlan.v1` 的单步子集:

```ts
interface WorkPlanner {
  nextStep(state: DispatchState): WorkPlan;
}

type WorkPlan =
  | { kind: "step"; action: "implement" | "review"; agent_id: string; role: string }
  | { kind: "terminal"; reason: string };
```

`RuleWorkPlanner` 行为:

- implement step 保持当前“第一个通过 runtime/isolation gate 的 coder”语义。
- review step 保持当前 explicit panel、author exclusion、quorum 语义。
- 不改变 approval、consensus、artifact、task.cancel 的 wire 行为。

## 3. DispatchState

`DispatchState` 是纯数据、可 JSON 序列化,既给 WorkPlanner,也写入训练样本。canonical schema 由 `docs/holp-blueprint.md` 的 M7 completion contract 维护;本节只是单步阶段的最小视图。

最小字段:

- `run_id`
- `goal`
- `trigger`
- `decision_kind`: `next_step`
- `candidates`: 来自 flock 的合法候选,包含 agent id、transport、roles、status、runtime/isolation readiness 摘要。
- `constraints`: quorum、exclude_author、producer_agent_id、required isolation profile。
- `history`: 当前单步阶段为空;多轮基座落地后填入 step history。

纪律:

- `DispatchState` 不塞整个 `RunRecord`。
- 被选中的 `action` 属于 `WorkPlan` 输出,不反塞进 `DispatchState` 输入。
- hard constraint filtering 仍在候选集构造阶段完成;WorkPlanner 只在合法候选内排序/选择,不能绕过 role、runtime、isolation、approval precondition。
- state 快照随 governance decision 记录,供离线 replay 重建。

## 4. learned-router transport 与 work_planner role

未来新增:

- transport: `learned-router`
- role/capability: `work_planner`

语义:

- learned-router 不执行任务,只提供 WorkPlanner 决策。
- probe 只检查本地 router 服务/模型是否可用;不可用则 `rejected`。
- learned-router 不能出现在 coder/reviewer/tester 等执行候选里;误用走 `role_unsupported`。
- worker pool 必须是当前 flock 已知 agent 的子集;未知 agent 走 `agent_not_found`。

## 5. 数据导出与 reward 归因

导出器只读 governance,不改变 run 行为。

JSONL 样本概念:

```json
{
  "sample_id": "...",
  "run_id": "...",
  "decision_kind": "next_step",
  "state": {},
  "action": { "kind": "step", "action": "implement", "agent_id": "agent-id", "role": "coder" },
  "reward": 1,
  "reward_basis": "merged",
  "reward_policy_version": "v1",
  "ts": 0
}
```

归因规则:

- 宁可作废,不可错归。
- 与派谁无关的失败不进训练集,例如人拒绝 approval、环境/quota 错误、工具不可用。
- coder 产出被 consensus reject,可以给 implement step 负样本。
- reviewer timeout/error 导致 quorum 不达,可以给 review step 负样本。
- author exclusion 后 eligible 不足属于结构配置问题,样本作废。

## 6. learned 接入模式

未来 `LearnedWorkPlanner` 只允许三档:

- `off`: 默认,只用 `RuleWorkPlanner`。
- `shadow`: 规则版真实执行,learned 只预测并记录。
- `active`: learned 接管,但任何异常或越界选择立即回退规则版。

本节只保留 mode vocabulary 和 fail-closed 约束,不实现 shadow/active 行为。

## 7. 与多轮基座的关系

本文件定义单步阶段的最小可插拔点。真正值得训练 learned router 前,还需要 `docs/holp-multiround-base-spec.md` 的多轮基座:

1. `WorkPlanner` 最小接口与规则基线。
2. 多轮 step loop / workflow / history。
3. step 级样本导出与 reward。
4. offline replay / eval harness。
5. learned router shadow。
6. active learned routing,必须有 replay + shadow 证据后才允许。

一句话: 先把决策点和数据管道铺好,再训练 router。
