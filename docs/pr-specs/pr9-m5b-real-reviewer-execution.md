# PR9 SPEC - M5b Real Reviewer Execution Pilot

> 状态:planned。目标是在 PR7 consensus kernel 和 PR8 deterministic fake demo 之后,让显式 reviewer panel 至少能启动一个真实 reviewer backend,产出真实 review result,再进入既有 quorum 聚合。该 PR 是 pilot,不是稳定多 provider review 平台。

## 目的

把 HOLP 的核心共识路径从 "fake reviewer votes" 推进到 "真实 reviewer session 可参与投票"。

完成后,一个 run 可以由 producer/coder 产出 artifact,再由非作者 reviewer backend 读取 artifact/diff,返回 verdict、severity、findings,最后由 PR7 的 consensus kernel 聚合。

## 当前代码事实

- PR7 已提供纯 consensus kernel、author exclusion、二段式 quorum、`consensus_verdict` / `consensus_degraded` wire integration。
- PR8 已提供 `npm run demo:m5`,但 reviewer votes 仍由 fake consensus path 合成。
- `adapters/` 已有通用 `AgentBackendFactory` contract 和 Codex app-server real adapter(`mcp-codex`)。
- `runEngine` 已能在 producer 完成后定位 reviewable artifact,并把 fake reviewer findings 写成 artifact envelope 或 inline fallback。
- consensus kernel 已要求 completed vote 必须有明确 verdict/severity;缺字段不能默认为 approve。
- 真实 reviewer backend 执行、dissent/timeout demo、稳定 gate protocol surface 仍未落地。

## 范围

新增真实 reviewer execution pilot,优先复用已有 `mcp-codex` real adapter 作为第一条真实 reviewer path。

预期产出:

- Reviewer execution abstraction:
  - 输入:target artifact/provenance、review policy、eligible reviewer agent、runtime selection、artifact_refs capability。
  - 输出:completed / timeout / error / abstain reviewer result。
  - 只返回已验证的 `verdict`、`max_severity`、`findings`;不合格输出进入 `errors[]`。
- Reviewer prompt contract:
  - 明确要求 reviewer 返回结构化 verdict。
  - 约束 verdict 枚举:`approve | request_changes | reject`。
  - 约束 severity 枚举:`P0 | P1 | P2 | NONE`。
  - 要求 findings 能转成 artifact envelope 或 inline fallback。
- Execution wiring:
  - 只在显式 `roles.reviewer.panel` 存在时执行 reviewer path。
  - author exclusion 后只启动 eligible reviewers。
  - reviewer timeout/error/abstain 不计入 completed quorum。
  - quorum 不足继续 fail-closed,复用 PR7 policy。
- Test fixtures:
  - fake reviewer executor 继续保留,用于 deterministic tests。
  - 新增真实 reviewer smoke 必须显式 opt-in,避免 CI 依赖本机 auth/quota。
- Governance:
  - 记录 reviewer execution decision/event 摘要,但不新增 public governance query API。
  - 不改变 existing run terminal event shape。

## 非目标

- 不新增稳定 gate object/event/outcome。
- 不接多个真实 provider。
- 不实现 12-agent adapter matrix。
- 不实现 direct user session / ACP 真实执行。
- 不改变 backend `startSession` / `sendPrompt` / `cancel` contract。
- 不要求 CI 默认跑真实 provider smoke。
- 不把 reviewer 的自然语言输出当作可信结构;必须有严格解析/校验。

## 验收

- fake path 继续通过 PR7/PR8 既有 tests 和 `npm run demo:m5`。
- 有 reviewer panel 的 run 能选择 real reviewer pilot path,并在 opt-in smoke 中产出真实 findings。
- reviewer completed 但缺 verdict 或 severity 时进入 `errors[]`,不作为 approve 票。
- reviewer timeout/error/abstain 进入 `errors[]`,不混入 completed votes。
- author reviewer 不会被启动,且出现在 `excluded[]`。
- quorum met 时发送合法 `consensus_verdict`。
- quorum 不足或全部 reviewer 不合格时 fail-closed,不发正常 verdict。
- findings 在 `artifact_refs:true` 时可通过 `artifact.get` 取回;`artifact_refs:false` 时内联降级。
- README / roadmap / protocol version 只声称 "real reviewer execution pilot",不声称真实多 provider consensus 完成。

## Review 重点

本 PR 最容易出错的是把 provider 输出解析得太宽。review 时优先检查:

- 缺 verdict / severity 是否绝不默认 approve。
- timeout/error 是否会错误计入 quorum。
- fake demo 的绿是否掩盖真实 path 的失败。
- author exclusion 是否发生在 reviewer backend 启动之前。
- 是否偷偷新增了稳定 gate surface 或改变了已有 wire contract。
