> status: completed — PR16 M10/M11 safe-lane foundation shipped in `2caab2b` (#37). HEAD contains learned-router planner-only role support, replay/eval sample helpers, shadow/fail-closed active/canary audit, L1 bounded workflow, L2 `WorkflowRevision.v1` validator/reject/audit, and dynamic workflow tests. It does not claim real learned-model active/canary or L2 learned-active readiness, per this SPEC.

# PR16 / M10+M11 Learned Router And Dynamic Workflow

## Summary

实现 Blueprint M10 + M11 的安全基础 lane:把 M7 产生的 `DispatchState.v1` / JSONL samples 接进 learned router replay/eval/shadow 路径,并落地 fixture fail-closed、promotion evidence 形状、L1 bounded workflow 和 L2 revision validator/reject/audit 基础。

这不是“先放一个 learned-router transport”,但 PR16 也不声称 real learned router 已生产可用。验收必须包含 offline replay/eval、shadow 记录、fixture active/canary fail-closed、L1 bounded workflow 和 L2 revision 整体验证/拒绝/审计。Merge Gate **不要求** `real_learned_model` backing、active/canary smoke/readiness,也不要求 L2 learned-active readiness;这些必须作为后续 PR/issue 跟进。

当前代码现实:

- M7 之后应已有 WorkPlanner、step loop、DispatchState、sample exporter。
- consensus/gate 和 approval 已有稳定 surface。
- learned 训练细节不属于 HOLP protocol;HOLP 负责合法候选、状态、样本、replay/shadow/active 接口。
- PR16 必须以 PR13/PR14/PR15 已合并且验收全绿为硬前置;缺任一 contract 时先修前置 PR,不能在 PR16 内 stub。

## Phase Gate

PR16 保持一个 PR,但按 safe-lane foundation 验收:

- Phase A / M10:replay/eval、shadow、fixture active/canary fail-closed fallback、promotion evidence shape。
- Phase B / M11:L1 bounded workflow + L2 `WorkflowRevision.v1` validator/reject/audit。L2 learned-active 启用必须留给后续 PR,并在后续消费真实 replay/shadow/canary evidence。

这不是拆掉 Blueprint,而是把高风险能力拆成可审计的前置 foundation。PR16 只交付安全基础;真实 active/canary 和 L2 learned-active 是显式后续项。

## Key Changes

- 新增 learned-router transport 和 `work_planner` role。
  - learned-router 只做 WorkPlanner 决策,不能作为 coder/reviewer/tester 执行任务。
  - probe 检查本地 router 服务/模型/fixture 是否可用;不可用 rejected。
  - router 输出必须是 `WorkPlan.v1` 或 workflow revision,并通过 schema + hard constraints 校验。
  - learned-router decision interface 固定:HOLP 发送 `DispatchState.v1`,返回 `WorkPlan.v1` 或 `WorkflowRevision.v1`。
  - 每次决策必须标注 backing:`fixture_planner` 或 `real_learned_model`。PR16 只要求 fixture replay/shadow/fail-closed 基础;不得把 fixture 结果声明为 real learned active/canary readiness。
  - active/canary mode 在 PR16 仅要求 safe fail-closed:fixture backing 或 hard constraint violation 必须回退规则版并写入 governance audit。`real_learned_model` attestation、active/canary smoke/readiness 留后续 PR。
  - learned-router 必须能力隔离:它不能进入 executor role resolution graph;任何把 `work_planner` 映射到 coder/reviewer/tester 的尝试必须在 role/capability negotiation 阶段 hard fail。

- offline replay / eval harness。
  - 读取 M7 JSONL samples 和 governance logs。
  - 对 RuleWorkPlanner、LearnedWorkPlanner、候选策略进行离线对比。
  - 指标至少包括 invalid action rate、constraint violation rate、reward delta、fallback rate、coverage。
  - 指标必须定义 numerator/denominator;reward delta 只在 reward-bearing samples 上计算,并报告 null reward count。
  - eval 必须 pin `reward_policy_version`;同一次比较不得混用 reward policy version。
  - replay 不改变真实 run。
  - replay/eval 是本地/offline 工具,读取 exported JSONL 和 local governance snapshot,不新增 public governance query API。

- shadow mode。
  - 规则版真实执行;learned 同步预测并记录 shadow action。
  - shadow action 若越界,记录 violation;不能影响真实 run。
  - shadow 结果进入 governance/report,供 canary 前验收。
  - shadow planner crash/timeout 必须被隔离,真实 run 的 terminal、approval、candidate snapshot 不受影响。

- opt-in active/canary safe lane。
  - active/canary 参数和 deterministic canary assignment 可以进入 wire/API,但 PR16 只要求 fixture fail-closed 和 audit 记录,不要求真实 learned decision 执行。
  - active 下 learned action 仍必须通过 hard constraints;失败立即 fallback RuleWorkPlanner 并记录。
  - canary 支持比例/allowlist,assignment 必须 deterministic,由 recorded seed/run id 派生;allowlist 优先于 ratio。
  - promotion evidence schema 必须版本化并写入 governance,至少包含 run ids、planner_version、router backing、reward_policy_version、DispatchState stream hash、replay fingerprint、sample counts、threshold version、created_at。
  - 后续 real active/canary PR 必须校验 `real_learned_model` attestation、evidence freshness、planner/deployment version、hash continuity、fallback/violation/reward thresholds。
  - canary kill switch、自动 demotion 和 active 扩大门禁是后续 readiness 工作;PR16 不以这些作为 merge gate。

- Dynamic workflow。
  - L1:规则/learned 均可触发受限插步,如 failed test -> fix -> review,request_changes -> fix -> review。
  - L1 只能插入/重试受限步骤,不得重排已 committed step graph;只有 L2 API 具备 graph mutation 能力。
  - L2 foundation:PR16 只要求 `WorkflowRevision.v1` pending graph 通过 max_steps、allowed actions、role/runtime/isolation、approval/gate constraints 的 accept-time hard constraint 校验,不要求 learned-active 生成真实可执行 revision。
  - 每个 L2-generated/reordered step 必须在生成后用 accept-time hard constraint 同源代码重新校验;任一 step 越界则整份 revision rejected,记录 `workflow_revision_rejected`,并 fallback L1/L0/RuleWorkPlanner。
  - L2 revision commit 只发生在 step boundary。rejection mid-run 时 execution cursor 保持在 last committed step;未 committed 的 L2 steps 全部丢弃,事件带 `rollback_cursor`。
  - `workflow_revision_rejected` 对 `(run_id, revision_id)` 必须幂等。
  - workflow revision 必须可审计、可回放、可禁用。
  - L2 learned-active enable/disable、真实生成/重排 readiness 和 kill switch 是后续 PR/issue;PR16 只交付 validator/reject/audit 基础。

- Wire surface。
  - `learned-router` transport、`work_planner` role、lane assignment、`workflow_revised`、`workflow_revision_rejected` 必须写入 `protocol/spec.md` 并通过 capability negotiation 启用。
  - active planner selection 使用显式 run param/capability,不得通过 executor `roles` map 假装成 coder/reviewer/tester。
  - `work_planner` 被引用为 executor role 时必须 `role_unsupported`。

## Test Plan

- Unit tests:
  - router output schema validation。
  - learned-router 不能进入 executor roles。
  - invalid learned action fallback RuleWorkPlanner。
  - fixture planner 不能满足 real active/canary readiness claim。
  - replay metrics 对 known fixture 输出确定结果。
  - reward_policy_version 混用被拒绝;coverage/null reward count 被报告。
  - L1/L2 workflow revision 被 constraints 正确接受/拒绝。
  - L2 revision 含越界 role/runtime/agent 时整份 rejected,不执行局部步骤。

- Integration tests:
  - shadow mode run:真实执行规则 step,同时记录 learned prediction。
  - shadow planner crash/timeout 不影响真实 run。
  - shadow 使用隔离内存/log buffer;只有 finalized shadow events 可 flush 到 governance,partial shadow state 不持久化。
  - active/canary opt-in with fixture backing:fail-closed 回退规则版,并不产生 real learned readiness claim。
  - active invalid run:fallback 规则版且 run 不失败。
  - active planner crash/timeout 只产生 fallback record,不产生 double terminal。
  - canary assignment 可用 run id/seed 离线重建。
  - L1 fix-review loop 真执行多步。
  - L2 revision validator 整体接受/整体拒绝 pending graph。
  - L2 revision rejected mid-run 时从 last committed cursor fallback,无半执行 step。
  - `workflow_revision_rejected` 对 `(run_id, revision_id)` 幂等,并同时受 in-memory run state 与 governance decision 去重。

- Verification:
  - `npm run typecheck`
  - `npm test`
  - replay fixture command
  - `git diff --check`
  - `npx gitnexus detect-changes --repo holp`

## Acceptance Criteria

- learned router safe lane 可以在 replay/eval、shadow 和 fixture fail-closed active/canary 路径中审计。
- PR16 不声称 `real_learned_model` backing、active/canary smoke/readiness 或 L2 learned-active readiness。
- L1 bounded workflow 能产生真实多步 run;L2 foundation 能校验/拒绝/audit `WorkflowRevision.v1`,但不要求 learned-active 真实生成/重排可执行 run。
- hard constraints 永远在 learned 外执行,不能被 learned 绕过。

## Out Of Scope

- 不把训练算法或模型权重放进 HOLP wire。
- 不要求云端训练服务。
- 不接 Remote runner;Remote 属 PR17。
- 不声明 `real_learned_model` backing 已接入或 ready。
- 不要求 active/canary smoke/readiness。
- 不要求 L2 learned-active readiness、kill switch、automatic demotion 或真实 pending graph 生成/重排执行。
