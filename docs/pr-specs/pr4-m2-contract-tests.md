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

## 非目标

- 不接真实 provider。
- 不扩展 daemon feature,除非为了断言已有协议语义。
- 不用测试行为替代 spec;发现不一致要显式修 spec 或实现。

## 验收

- 单条测试命令跑完整 contract suite。
- 测试失败能定位协议语义,不只是 snapshot 文案。
- M3 可以在不改 contract expectations 的前提下继续。
- 只有这些测试通过后,`docs/roadmap.md` 才能标 M2 完成。

## Review 重点

这是后续 provider/governance 工作的回归网。不要把测试写死到 fake implementation 私有细节。
