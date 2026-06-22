# PR16 / M10+M11 Learned Router And Dynamic Workflow

## Summary

实现 Blueprint M10 + M11:把 M7 产生的 `DispatchState.v1` / JSONL samples 接进 learned router safe lane,并在有 replay/shadow/canary 证据后启用 L1/L2 dynamic workflow。

这不是“先放一个 learned-router transport”。验收必须包含 offline replay/eval、shadow 记录、opt-in active/canary、L1 半动态 workflow 和 L2 全动态 workflow 的真实执行路径。

当前代码现实:

- M7 之后应已有 WorkPlanner、step loop、DispatchState、sample exporter。
- consensus/gate 和 approval 已有稳定 surface。
- learned 训练细节不属于 HOLP protocol;HOLP 负责合法候选、状态、样本、replay/shadow/active 接口。
- PR16 必须以 PR13/PR14/PR15 已合并且验收全绿为硬前置;缺任一 contract 时先修前置 PR,不能在 PR16 内 stub。

## Phase Gate

PR16 保持一个 PR,但必须按两个可验证阶段实现:

- Phase A / M10:replay/eval、shadow、opt-in active、canary、fallback、promotion evidence。
- Phase B / M11:L1/L2 dynamic workflow。L2 启用必须消费 Phase A 记录下来的 replay/shadow/canary evidence;没有 evidence 时 L2 active 禁用。

这不是拆范围,而是在同一 PR 内保留 Blueprint 要求的 evidence gate。

## Key Changes

- 新增 learned-router transport 和 `work_planner` role。
  - learned-router 只做 WorkPlanner 决策,不能作为 coder/reviewer/tester 执行任务。
  - probe 检查本地 router 服务/模型/fixture 是否可用;不可用 rejected。
  - router 输出必须是 `WorkPlan.v1` 或 workflow revision,并通过 schema + hard constraints 校验。
  - learned-router decision interface 固定:HOLP 发送 `DispatchState.v1`,返回 `WorkPlan.v1` 或 `WorkflowRevision.v1`。
  - 每次决策必须标注 backing:`fixture_planner` 或 `real_learned_model`。fixture 可用于 replay/shadow,不得用于 active/canary 完成声明。
  - active mode 必须校验 runtime probe 的 backing attestation;fixture backing 在 active/canary 中必须 fail promotion logging,并回退规则版。
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

- opt-in active/canary。
  - active 必须显式开启,并可按 workflow/role/transport 限定。
  - active 下 learned action 仍必须通过 hard constraints;失败立即 fallback RuleWorkPlanner 并记录。
  - canary 支持比例/allowlist,并能一键关闭。
  - promotion gate 必须版本化并写入 governance:canary 需要 shadow evidence 满足 configured thresholds;active 扩大需要 canary fallback/violation/reward metrics 满足 thresholds。
  - Phase A evidence schema 至少包含 run ids、planner_version、router backing、reward_policy_version、DispatchState stream hash、replay fingerprint、sample counts、threshold version、created_at。
  - Phase B 必须校验 evidence freshness、planner/deployment version、hash continuity;过期或不匹配 evidence 不可启用 L2 active。
  - canary lane assignment 必须 deterministic,由 recorded seed/run id 派生;allowlist 优先于 ratio。
  - 一键关闭机制必须命名并审计;关闭后新 step 回落 RuleWorkPlanner。
  - canary regression 超过阈值时必须自动 demote 到 RuleWorkPlanner,冻结 evidence 供 audit,并立即禁用 L2 active。

- Dynamic workflow。
  - L1:规则/learned 均可触发受限插步,如 failed test -> fix -> review,request_changes -> fix -> review。
  - L1 只能插入/重试受限步骤,不得重排已 committed step graph;只有 L2 API 具备 graph mutation 能力。
  - L2:learned/workflow policy 可生成或重排 step plan,但必须通过 max_steps、allowed actions、role/runtime/isolation、approval/gate constraints。
  - 每个 L2-generated/reordered step 必须在生成后用 accept-time hard constraint 同源代码重新校验;任一 step 越界则整份 revision rejected,记录 `workflow_revision_rejected`,并 fallback L1/L0/RuleWorkPlanner。
  - L2 revision commit 只发生在 step boundary。rejection mid-run 时 execution cursor 保持在 last committed step;未 committed 的 L2 steps 全部丢弃,事件带 `rollback_cursor`。
  - `workflow_revision_rejected` 对 `(run_id, revision_id)` 必须幂等。
  - workflow revision 必须可审计、可回放、可禁用。
  - 禁用 L2 mid-run 时,后续 step 停止生成/重排,并按 L1(或 L0)完成已验证步骤;禁用动作写入 governance。

- Wire surface。
  - `learned-router` transport、`work_planner` role、lane assignment、`workflow_revised`、`workflow_revision_rejected` 必须写入 `protocol/spec.md` 并通过 capability negotiation 启用。
  - active planner selection 使用显式 run param/capability,不得通过 executor `roles` map 假装成 coder/reviewer/tester。
  - `work_planner` 被引用为 executor role 时必须 `role_unsupported`。

## Test Plan

- Unit tests:
  - router output schema validation。
  - learned-router 不能进入 executor roles。
  - invalid learned action fallback RuleWorkPlanner。
  - fixture planner 不能满足 active/canary completion claim。
  - replay metrics 对 known fixture 输出确定结果。
  - reward_policy_version 混用被拒绝;coverage/null reward count 被报告。
  - L1/L2 workflow revision 被 constraints 正确接受/拒绝。
  - L2 revision 含越界 role/runtime/agent 时整份 rejected,不执行局部步骤。

- Integration tests:
  - shadow mode run:真实执行规则 step,同时记录 learned prediction。
  - shadow planner crash/timeout 不影响真实 run。
  - shadow 使用隔离内存/log buffer;只有 finalized shadow events 可 flush 到 governance,partial shadow state 不持久化。
  - active opt-in run:learned 选择合法 next step 并真实执行。
  - active fixture backing 被拒绝为 completion claim,并回退规则版。
  - active invalid run:fallback 规则版且 run 不失败。
  - active planner crash/timeout 只产生 fallback record,不产生 double terminal。
  - canary allowlist/ratio 生效,关闭后回规则版。
  - canary regression 触发自动 demotion。
  - canary assignment 可用 run id/seed 离线重建。
  - L1 fix-review loop 真执行多步。
  - L2 dynamic workflow 消费 Phase A evidence 后真生成或重排步骤,并完整通过 approval/gate/report。
  - L2 revision rejected mid-run 时从 last committed cursor fallback,无半执行 step。
  - L2 kill switch mid-run 后按 L1/L0 安全完成。

- Verification:
  - `npm run typecheck`
  - `npm test`
  - replay fixture command
  - shadow/active smoke command
  - `git diff --check`
  - `npx gitnexus detect-changes --repo holp`

## Acceptance Criteria

- learned router 可以在 replay、shadow、active 三档中运行。
- active 默认仍需显式 opt-in,但一旦开启必须是真实决策路径,不是只记录预测。
- L1/L2 workflow 都能产生真实多步 run,并可在 consumer report 中审计。
- hard constraints 永远在 learned 外执行,不能被 learned 绕过。

## Out Of Scope

- 不把训练算法或模型权重放进 HOLP wire。
- 不要求云端训练服务。
- 不接 Remote runner;Remote 属 PR17。
