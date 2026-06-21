# PR9 SPEC - M5b Real Reviewer Execution Pilot

> 状态:planned。目标是在 PR7 consensus kernel 和 PR8 deterministic fake demo 之后,让显式 reviewer panel 至少能启动一个真实 reviewer backend,产出真实 review result,再进入既有 quorum 聚合。该 PR 是 pilot,不是稳定多 provider review 平台。

## 目的

把 HOLP 的核心共识路径从 "fake reviewer votes" 推进到 "真实 reviewer session 可参与投票"。

完成后,一个 run 可以由 producer/coder 产出 artifact,再由非作者 reviewer backend 读取 artifact/diff,返回 verdict、severity、findings,最后由 PR7 的 consensus kernel 聚合。

## 当前代码事实

- PR7 已提供纯 consensus kernel、author exclusion、二段式 quorum、`consensus_verdict` / `consensus_degraded` wire integration。
- PR8 已提供 `npm run demo:m5`,但 reviewer votes 仍由 fake consensus path 合成。
- `adapters/` 已有通用 `AgentBackendFactory` contract 和 Codex app-server real adapter(`mcp-codex`)。
- 当前 `mcp-codex` app-server session 仍硬编码 `sandbox:"workspace-write"`;其 `read_only_review` declaration 为 degraded(`read_only_not_enforced`)。PR9 若复用 Codex 当 reviewer,必须先补只读启动路径或 fail-closed,不能把 degraded 写能力当成真实只读 reviewer。
- `runEngine` 已能在 producer 完成后定位 reviewable artifact,并把 fake reviewer findings 写成 artifact envelope 或 inline fallback。
- consensus kernel 已要求 completed vote 必须有明确 verdict/severity;缺字段不能默认为 approve。
- 真实 reviewer backend 执行、dissent/timeout demo、稳定 gate protocol surface 仍未落地。
- declaration readiness 不是 enforcement proof;真实 reviewer 进入 completed vote 前必须有本次执行的 enforcement attestation,证明所选 runtime/profile 确实以只读 reviewer 约束启动。

## 范围

新增真实 reviewer execution pilot。最小真实形态是非作者 producer(fake 或未来 real provider) + 至少一个 real `mcp-codex` reviewer;单一 Codex 同时当 producer/reviewer 会因 author exclusion 被排除,不能作为真实 consensus 证明。

`mcp-codex` reviewer 只有在可用 read-only enforced session 时才可执行。若 provider 只能以 workspace-write 启动,本 PR 必须把 reviewer path 记为 degraded/rejected 或 smoke INCONCLUSIVE,不得声称 `read_only_review` 已满足。`startSession` / `sendPrompt` / `cancel` 方法签名保持不变;通过构造期 `AgentBackendOptions` 或 adapter options 传 isolation/sandbox hint 属于本 PR 范围。

预期产出:

- Reviewer execution abstraction:
  - 输入:target artifact/provenance、review policy、eligible reviewer agent、runtime selection、artifact_refs capability。
  - 输出:completed / timeout / error / abstain reviewer result。
  - 只返回已验证的 `verdict`、`max_severity`、`findings`;不合格输出进入 `errors[]`。
  - completed vote 只能由统一 reviewer parser/validator 产出;fake reviewer、真实 provider、后续 adapter 都必须走同一 canonical validator,不得各自构造可投票 result。
  - `errors[]`、timeout、abstain、parse failure 结果不得传入任何 quorum/aggregate 输入集合。
  - 真实 reviewer result 必须携带内部 enforcement attestation,至少表达 `enforced_read_only`、tool whitelist/deny-write 检查结果、review input source;缺 attestation 或 attestation 失败时不得变成 completed vote。
- Reviewer prompt contract:
  - 明确要求 reviewer 返回机读 JSON envelope,至少包含 `verdict`、`max_severity`、`findings`。
  - 约束 verdict 枚举:`approve | request_changes | reject`。
  - 约束 severity 枚举:`P0 | P1 | P2 | NONE`。
  - 要求 findings 能转成 artifact envelope 或 inline fallback。
  - 解析必须正向验证:空输出、非 JSON、JSON 前后有非空白 prose、缺字段、非枚举 token、解析异常、有 severity 无 verdict、自然语言里提到 verdict 但无机读字段,一律映射为 `status:"error"` 并进入 `errors[]`。不得在任何解析失败路径默认 `approve` 或 `NONE`。
  - 判定 completed 与读取 verdict/severity 必须共用同一个 parser/source-of-truth。
- Execution wiring:
  - 只在显式 `roles.reviewer.panel` 存在时执行 reviewer path。
  - author exclusion 后只启动 eligible reviewers。
  - `runConsensusGate` 需要接入 registry/factory 解析和 reviewer backend options;每个 reviewer 使用独立 backend 实例,遵守当前 adapter contract 的单 session 约束。
  - pilot 阶段 reviewer input 只能来自显式 `artifact_snapshot` / diff / artifact refs 注入,不依赖 reviewer 共享 producer workspace。除非后续 SPEC 明确选择并隔离 `coder_worktree`,read-only reviewer 不得通过隐式 workspace 读取 producer state。
  - 明确选择并发模型:默认并发启动 eligible reviewers;每个 reviewer 有独立 timeout,同时保留总 review budget。timeout 结果进入 `errors[]`,不计 completed quorum。
  - 总 review budget 耗尽时发 `consensus_degraded` 并按 PR7 policy fail-closed/ask_human,不得用部分未验证输出补 quorum。
  - reviewer timeout/error/abstain 不计入 completed quorum。
  - quorum 不足继续 fail-closed,复用 PR7 policy。
- Test fixtures:
  - fake reviewer executor 继续保留,用于 deterministic tests。
  - 新增真实 reviewer smoke 必须显式 opt-in,避免 CI 依赖本机 binary/auth/quota。
  - smoke 未启用时 no-op exit 0;缺 binary/auth/quota、provider 未产出可解析 JSON verdict、无法 enforce read-only 时必须 honest skipped/degraded/INCONCLUSIVE,不能 PASS。
  - 只有真实 reviewer 在 read-only enforced path 产出可解析 verdict/findings 时,才可声称 real reviewer smoke 跑过。
- Governance:
  - 记录 reviewer execution decision/event 摘要,但不新增 public governance query API。
  - cost/session_id/provider raw metadata 如需保存,只进内部 decision data;不新增或扩展 public wire event payload。
  - 不改变 existing run terminal event shape。

## 非目标

- 不新增稳定 gate object/event/outcome。
- 不接多个真实 provider。
- 不实现 12-agent adapter matrix。
- 不实现 direct user session / ACP 真实执行。
- 不改变 backend `startSession` / `sendPrompt` / `cancel` contract。
- 不允许真实 reviewer 以可写 workspace 冒充 `read_only_review`。
- 不要求 CI 默认跑真实 provider smoke。
- 不把 reviewer 的自然语言输出当作可信结构;必须有严格解析/校验。

## 验收

- fake path 继续通过 PR7/PR8 既有 tests 和 `npm run demo:m5`。
- 有 reviewer panel 的 run 能选择 real reviewer pilot path,并在 opt-in smoke 中通过 read-only enforced reviewer session 产出真实 findings。
- 如果 read-only enforcement 不可用,该 reviewer 不得进入 real completed vote;run 按 policy degraded/rejected/INCONCLUSIVE。
- reviewer completed 但缺 verdict 或 severity 时进入 `errors[]`,不作为 approve 票。
- reviewer JSON 缺字段、字段非枚举、空输出、非 JSON、解析异常、有 severity 无 verdict 均进入 `errors[]`,不作为 approve 票。
- reviewer timeout/error/abstain 进入 `errors[]`,不混入 completed votes。
- fake reviewer executor 也必须经过同一 canonical parser/validator;测试要证明 fake 与 real parser 对缺字段/非法枚举/非 JSON 的处理一致。
- reviewer 缺 enforcement attestation 或 attestation 显示 read-only 未强制时,即使输出合法 JSON,也不得计入 completed quorum。
- author reviewer 不会被启动,且出现在 `excluded[]`。
- 每个真实 reviewer 使用独立 backend session;并发/timeout/总 budget 有测试或 smoke 日志证明。
- quorum met 时发送合法 `consensus_verdict`。
- quorum 不足或全部 reviewer 不合格时 fail-closed,不发正常 verdict。
- findings 在 `artifact_refs:true` 时可通过 `artifact.get` 取回;`artifact_refs:false` 时内联降级。
- README / roadmap / protocol version 只声称 "real reviewer execution pilot",不声称真实多 provider consensus 完成。

## Review 重点

本 PR 最容易出错的是把 provider 输出解析得太宽。review 时优先检查:

- 缺 verdict / severity 是否绝不默认 approve。
- timeout/error 是否会错误计入 quorum。
- read-only reviewer 是否真的以只读 session 启动,而不是 workspace-write。
- reviewer artifact/diff 是否经 prompt 注入,避免误以为共享 workspace 上有 producer diff。
- opt-in smoke 是否把缺 provider/缺 verdict/不可只读误报为 PASS。
- fake demo 的绿是否掩盖真实 path 的失败。
- author exclusion 是否发生在 reviewer backend 启动之前。
- 是否偷偷新增了稳定 gate surface 或改变了已有 wire contract。
