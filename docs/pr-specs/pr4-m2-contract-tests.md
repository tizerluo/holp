# PR4 SPEC - M2 Protocol Contract Tests

## 目的

在真实 provider adapter 落地前,把 v0.1.4 协议语义变成可执行 contract tests。

## 当前代码事实

- M1a/M1b 应已提供 runnable fake daemon 和 consumer/demo path。
- `protocol/spec.md` v0.1.4 是契约来源。
- M2 不应依赖真实 provider。

## 范围

围绕 M1 runtime 新增 contract tests。

必须覆盖:

- JSON-RPC:
  - request/response id
  - notification shape
  - unknown method
- Capability negotiation:
  - 缺省 capability = unsupported
  - `required:true` 是连接级
  - approval kinds 交集
- Flock:
  - partial success
  - unsupported transport / missing auth 作为 per-agent rejected status
  - unknown agent in `orchestrate.run` → `agent_not_found`
  - role mismatch → `role_unsupported`
- Events:
  - omitted/null `categories` = all
  - empty/unknown category → `invalid_event_category`
  - heartbeat 不受 category 过滤
  - `after_seq` replay
  - 多 subscription 用 `subscription_id` 区分归属
- Approval:
  - requested → resolved/expired/cancelled
  - 没有 `approval.cancel`
  - `approval_already_resolved` race
- Cancel:
  - terminal run idempotency
  - unknown run → `run_not_found`
- Artifact:
  - `artifact.get` 永远返回 `content`
  - truncation fields
  - `artifact_refs:false` 时 findings/details inline fallback
  - provenance `artifact_id` 仍允许作为 identity
- Consensus validation:
  - unknown / role mismatch / rejected / degraded reviewer 处理
  - two-stage quorum
  - normal verdict 不出现 `quorum.met:false`

## Deferral ledger（M2 实际锁定 vs 转交后续里程碑）

> 起因:上面「范围」按 v0.1.4 协议面**理想全集**列举。但 M1/M2 daemon 只实现了其中一部分;另一部分(consensus 执行、approval 超时定时器、heartbeat 发射)按 roadmap 属于 M3/M4/M5,且本 milestone 非目标明确「不扩展 daemon feature」。本表把「范围」拆成**现在锁定**与**转交后续**两栏,使「M2 完成」有可判定的边界。负向断言(锁住"当前缺席行为")集中在 `daemon/handlers/m2_contract.test.ts` 的 §F。

**M2 现在锁定(已实现 + 已测,合并即生效):**

- JSON-RPC:id 回显 / notification 无响应 / unknown method `-32601`。
- Capability:缺省 unsupported / `required` 连接级 / approval kinds 交集 / run 级 approval 硬要求(`approval_required_but_unsupported` 受理时报)。
- Flock:部分成功 / unsupported transport 或 missing auth → per-agent rejected / unknown agent → `agent_not_found` / role mismatch → `role_unsupported`。
- Events:省略或 null categories = 全订 / 空数组或未知 category → `invalid_event_category` / `after_seq` replay / 多 subscription 归属。
- Approval:`requested → resolved` / `requested → cancelled`(由 `task.cancel` 致) / 没有 `approval.cancel` 方法 / `approval_already_resolved` race(先终态者赢,两个方向)。
- Cancel:终态 run 幂等 / unknown run → `run_not_found`。
- Artifact:永远返回 `content` / 截断字段 / `artifact_refs:false` 时 **approval `details`** 内联降级 / provenance 裸 `artifact_id` 作为身份字段(不受 `artifact_refs` 控制)。
- Consensus:**第 1 段静态 panel 校验**的错误码分流(unknown→`agent_not_found`、role mismatch→`role_unsupported`、rejected-in-panel 与 quorum 形状→`invalid_quorum`),固定顺序。

**转交后续里程碑(v0.1.4 已定义,M1/M2 未实现 → §F 锁定当前边界,owning PR 落地时必须改写/删除对应 §F 断言并补正向 contract test):**

| 协议语义 | owning milestone | §F 负向锁定 | 解锁动作 |
|---|---|---|---|
| consensus 第 2 段(排除作者后精确校验)+ `consensus_verdict` + `quorum.{required,eligible,met}` + `excluded[]` + `errors[]` | PR7/M4b kernel 已解锁;PR8/M5 已补 deterministic findings envelope/inline demo | 无 reviewer panel 的单 coder run 仍不发 `consensus` category 事件 | PR7/M4b 已补显式 reviewer panel 的正向断言;PR8 已补 findings artifact envelope 与 inline fallback |
| `quorum_unsatisfiable`(`-32004`)的第 2 段语义 | PR7/M4b kernel 已解锁;M5 继续扩真实 demo | 无 reviewer panel 时不可达 | PR7/M4b 已通过 `consensus_degraded`/blocked 路径覆盖排除作者后 eligible<quorum |
| approval `requested → expired` + 超时定时器 | M4a(run state machine) | PR6 已解锁:fake scheduler advance 后自发 `approval_expired`;server-timeout 先终态后 `approval.resolve` 返回 `approval_already_resolved` | 后续只需在完整 policy/gate 引入时扩展 timeout policy 覆盖,不得回退到无 timer |
| heartbeat 不受 `categories` 过滤 | M3+(lifecycle heartbeat 发射后) | 当前不发 heartbeat;`include_heartbeats` 参数已解析但 bus 未旁路 | heartbeat 发射落地时,补 bus 旁路 + 「心跳不受 category 过滤」正向断言 |
| `artifact_refs:false` 时 consensus **`reviews[].findings`** 内联降级 | PR8/M5 已解锁 | approval `details` 内联仍在 §D 锁定;真实 provider reviewer findings 仍需 opt-in smoke/后续 demo | PR8 已补 artifact envelope 与内联降级断言 |
| v0.1.5 runtime surface / isolation readiness matrix | Issue #11 / PR6 + PR12/M6c 已解锁 foundation | M2 只锁 v0.1.4 关键语义;完整真实 adapter matrix 仍不属于 M2 | PR6 补 declare/discover 与 registry/run metadata;PR12 补 consumer-visible matrix report |

## 非目标

- 不接真实 provider。
- 不扩展 daemon feature,除非为了断言已有协议语义。
- 不用测试行为替代 spec;发现不一致要显式修 spec 或实现。

## 验收

- 单条测试命令跑完整 contract suite。
- 测试失败能定位协议语义,不只是 snapshot 文案。
- M3 可以在不改 contract expectations 的前提下继续。
- 「M2 完成」按上方 **Deferral ledger 的「现在锁定」栏**判定,不是按「范围」理想全集。「转交后续」栏的项由其 owning milestone 验收,不计入 M2 完成门;但 §F 必须存在并锁住它们的当前缺席行为。
- 只有「现在锁定」栏的测试全部通过、且 §F 负向锁定到位后,`docs/roadmap.md` 才能把 M2 标为「契约层已锁定(consensus 执行/approval 超时/heartbeat 转交 M3/M4/M5)」,不得标成无保留的「M2 全部覆盖完成」。

## Review 重点

这是后续 provider/governance 工作的回归网。不要把测试写死到 fake implementation 私有细节。
