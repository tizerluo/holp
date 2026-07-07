> status: completed — PR13 M7 foundation loop shipped in `6ac698e` (#30), with PR13b workflow contract hardening in `a288e94` (#32). HEAD contains `daemon/core/workPlanner.ts`, `daemon/core/workflowEngine.ts`, `daemon/core/trainingSamples.ts`, and `daemon/handlers/m7_workflow.test.ts` coverage for the acceptance path.

# PR13 / M7 Foundation Loop

## Summary

实现 Blueprint M7 的完整地基层:把 HOLP 从单步 `orchestrate.run -> driveRun` 扩展为可多步执行、可记录决策、可导出训练样本的 WorkPlanner loop。

这不是 skeleton。`max_steps=1` 必须保持当前行为兼容;`max_steps>1` 必须真的按 L0 workflow 运行多个 step,并为每步写入 governance snapshot、history 和 JSONL sample。

当前代码现实:

- `RunRecord` 只表达单个 coder backend、单个 runtime selection、可选 consensus。
- `handleOrchestrateRun` 在 handler 内直接选 coder/reviewer,并 fire-and-forget 调 `driveRun`。
- `driveRun` 负责一个 backend turn、approval bridge、artifact、consensus gate、terminal event。
- governance 已有 events/decisions/runStates/harnessRegistry,但没有 step/workflow/dispatch sample。

## Key Changes

- 新增 `WorkPlanner` / `RuleWorkPlanner` 并接入 `orchestrate.run`。
  - `WorkPlanner.nextStep(state: DispatchStateV1): WorkPlanV1`。
  - `RuleWorkPlanner` 保持现有默认选择语义:合法 coder 进入 implement,显式 reviewer panel 进入 review,无更多步骤时 terminal。
  - hard constraints 仍在 WorkPlanner 之前过滤:agent existence、role、quorum、execution mode、approval、runtime/isolation。
  - `WorkPlan.v1` 不是可直接执行的 backend action。实现必须有显式 `WorkPlan -> RuntimeAction.v1` mapping;M7 唯一可执行 `RuntimeAction` 是 `implement` 和 `review`。
  - 无法确定映射的 step 必须 blocked 为 `blocked_action_mapping`,不得让 executor 猜。

- 新增真实 step loop。
  - `orchestrate.run.workflow` 可选;缺省 `single-step`。
  - L0 workflow 至少支持 `single-step`、`linear`、`spec-driven`。
  - wire 参数固定为 `orchestrate.run.params.max_steps:number`;缺省 1,必须校验为正整数。
  - `max_steps=1` 走当前单步兼容路径;`max_steps>1` 必须顺序执行多个 step,并能在 approval/cancel/error 时正确终止。
  - M7 只 dispatch 当前已有真实执行器的 action:`implement` 和 `review`。`plan`、`test`、`fix`、`synthesize` 是 `WorkPlan.v1` vocabulary,但没有真实 executor 时不得伪造 step result;模板碰到不可执行 action 必须 terminal/blocked 为 `action_executor_not_available:<action>`。
  - M7 的 `linear` 模板定义为可执行步骤序列:`implement -> review`(仅当声明 reviewer panel 时)。完整 plan/test/fix/synthesize 执行留给 PR14/PR16 的真实 provider/workflow 能力。
  - workflow mode 只能影响 step sequencing,不能改变 action vocabulary 或 executor semantics。

- 扩展内部 run/governance 状态,不破坏 wire 兼容。
  - `RunRecord` 增加 versioned workflow fields:`workflow`、`step_index`、`step_history`、`planner_mode`、`per_step runtime/consensus summary`。
  - source-of-truth 分层:RunRecord 是 in-flight runtime state;governance append-only decisions/events 是 audit/export truth;`DispatchState` 是每步 immutable planning snapshot payload,不是可变持久状态。
  - governance decision 增加 `workflow_selected`、`workflow_step_planned`、`workflow_step_started`、`workflow_step_completed`、`workflow_step_failed`、`dispatch_snapshot_recorded`、`training_sample_recorded`。
  - 对外事件可新增 consumer 可忽略事件:`workflow_selected`、`workflow_step_planned`、`workflow_step_completed`;旧事件名和 terminal 语义不变。
  - 现有 `agent:step_started` 事件保持原意:backend status starting/running。workflow step 事件必须用 `workflow_step_*`,不得复用旧名字。
  - 默认无 `workflow` 参数,或 `workflow=single-step && max_steps=1` 时,wire event stream 必须与 M7 前单步 run 等价:不新增 workflow 事件,seq 顺序不变。
  - event names 必须进入静态 event contract registry/union;single-step 默认路径禁止 `workflow_*`,multi-step step transition 必须有 `workflow_step_*`。

- 定义并持久记录 `DispatchState.v1`。
  - 字段至少包含:`run_id`、`goal`、`trigger`、`decision_kind`、`workflow_id`、`step_index`、`candidates`、`constraints`、`history`。
  - candidates 必须由 accept-time hard constraint 使用的同一套候选构造代码产生,不能另写一套会漂移的过滤逻辑。
  - candidates 是每步冻结 snapshot;执行该 step 时不得重新过滤出另一套候选。
  - reviewer panel presence 属于 `DispatchState.constraints`,不是 WorkPlanner 临时猜测。
  - history 只存 step 级摘要,不复制完整 event log;但必须足够 replay:包含 planner input snapshot id、selected action、candidate ids、approval/consensus decision refs、step outcome。
  - `DispatchState` 必须能 `JSON.stringify`,且不得包含 `bus`、`backend`、`expiryTimer`、`pendingApprovals`、function、Set、process handle。

- 明确 terminal ownership。
  - step backend 只返回 step outcome;run terminal 由 step loop 统一发出。
  - approval expiry、task.cancel、consensus block 只设置一个 run-level terminal intent;loop 在 step boundary 和 in-flight preemption 点检查。
  - terminal precedence 固定为:`task.cancel` > step hard crash > approval rejection/expiry > consensus rejection/block > normal completion。
  - terminal intent 一旦设置,后到的 backend completion / timer / consensus result 必须被 idempotency guard 忽略。
  - 每个 step 完成时必须 clear 本 step pending approval/timer,防止旧 timer 在下一 step 误触发。
  - 任意 run 只能发一个 terminal event。

- 新增 JSONL exporter。
  - exporter 是 governance snapshot 的纯函数,不改变 run 行为。
  - M7 必须提供从真实 run 获取 snapshot 的路径,并用真实 fake-backed run 导出 JSONL;不能只用手写 fixture。
  - 每行包含 sample id、run id、step index、state、action、reward、reward_basis、reward_policy_version、ts。
  - reward 不确定时作废而不是瞎标;原始 governance 保留,允许按新 policy 重算。
  - reward 只能来自 governance decision graph 和版本化 reward policy,不能从 runtime text heuristic 猜。
  - reward table 必须覆盖 terminal_state x step_action。默认规则:merged 只给 accepted path 上的有效 step 正样本;review reject 只把可归因 step 标负样本;人类拒绝、环境/quota、结构配置错误等不可归因失败为 `reward:null`。

## Test Plan

- Unit tests:
  - `RuleWorkPlanner` 对 single-step / linear / spec-driven 给出确定 step 序列。
  - hard constraints 过滤后才进入 `DispatchState.candidates`。
  - `DispatchState.v1` 可 JSON 序列化,不包含完整 `RunRecord` 或 event log。
  - reward attribution 对 merged/rejected/timeout/cancel/human reject 给出正确 reward 或 null。

- Contract / handler tests:
  - 默认 `orchestrate.run` 无 workflow 时行为与当前单步 run 等价。
  - `max_steps=1` 不改变 M1/M2/M4/M5/M6 既有 contract。
  - `max_steps>1 + linear` 在 coder+reviewer flock 中真执行 implement -> review 两个 step,并发出 `workflow_step_*` events。
  - 默认 no-workflow path 的 event name list 保持不变。
  - event contract registry 拒绝 single-step 默认路径发出 `workflow_*` 事件。
  - approval waiting、approval expiry、task.cancel 在 step loop 内只产生一个 terminal event。
  - cancel 在 step1 完成和 step2 开始之间到达时,只产生一个 terminal event。
  - step1 approval timer 在 step2 期间触发时不会污染 step2。
  - backend completion 晚于 terminal intent 时被忽略,不发 step_completed 或第二 terminal。
  - consensus gate 仍只在需要 review 的 step 后触发,单 coder run 仍不发 consensus。
  - JSONL exporter 从真实 governance run 导出 step-level sample。
  - 2-step governance log 覆盖 implement-ok/review-reject 的 reward attribution。
  - multi-step golden trace 固定 event order,至少覆盖 happy path、cancel race、approval expiry race。

- Verification:
  - `npm run typecheck`
  - `npm test`
  - `npm run demo:m5`
  - `git diff --check`
  - `npx gitnexus detect-changes --repo holp`

## Acceptance Criteria

- 一个 consumer 可以发起 `workflow:"linear", max_steps:3` 的 run,在 coder+reviewer flock 中看到真实 implement -> review step 进展和最终 terminal。
- governance 内可重建每一步的 planner 输入、planner 输出、runtime selection、approval/consensus 摘要和 terminal 结果。
- exporter 输出的 JSONL 可以直接用于 offline replay/eval 的输入。
- 旧 consumer 不知道 workflow/step 事件也不会坏。

## Out Of Scope

- 不训练 learned router。
- 不启用 learned active routing。
- 不接 ACP/direct/remote runtime;它们属于 PR14/PR17。
- 不做 L1/L2 动态 workflow;它们属于 PR16。
