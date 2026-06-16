# HOLP — Human On Loop Protocol

> **版本**:v0.1.1 (draft)
> **状态**:草稿,参考实现进行中
> **变更**:v0.1.1 按深度 review 返工(传输模型钉死 / 共识数学与分层 / approval 单通道 / 版本能力细分 / flock 发现 / 错误模型 / artifact 协议 / v0.1 范围声明统一)。变更明细见文末。
> **定位**:见 `docs/positioning.md`。开源、免费、本地优先的 multi-agent 编排协议。

HOLP 是 **consumer**(终端 / 工具 / APP——cmux、Warp、happier、CLI)与 **orchestrator**(编排器——HOLP 参考 daemon 或任何实现)之间的那根线。consumer 声明「我有一窝异构 agent」,发起编排目标,orchestrator 派单并流式回吐事件;需要人拍板时,人在回路上介入——**Human on Loop**。

---

## 1. 传输与编码

> v0.1.1 钉死:v0.1 同时声称「JSON-RPC request/response」「notification」「连续 response chunk」,自相矛盾(JSON-RPC 2.0 无连续 chunk 语义)。v0.1.1 拆成**两个面**。

**两个传输面**:

- **控制面**:stdio 上的 **JSON-RPC 2.0**。client→server 的方法调用(`initialize` / `flock.*` / `orchestrate.run` / `events.subscribe` / `events.unsubscribe` / `approval.resolve` / `task.cancel`)走标准 request/response(带 `id`)。能力协商、错误码、取消都在这里。
- **事件面**:server→client 的**事件流**,用 JSON-RPC **notification**(无 `id`),但**每条都带 `subscription_id`** 绑定到订阅(见 §5)。事件面不是「JSON-RPC 连续 chunk」,是「带订阅归属的 notification 流」。

**编码**:newline-delimited JSON,每行一个对象(与 cmux `events.stream` 的 JSON-line 实践一致,来源 cmux `CmuxEventStream.swift`)。

> 未来可选 WebSocket 传输(给 Web/远程 APP),v0.1.1 只 stdio。

**明确不是**:事件不是「某个 long-running request 的连续 response」。`events.subscribe` 是普通 request(立即返回 `subscription_id`),事件是独立的、带 `subscription_id` 的 notification。这让多订阅、取消、错误归属都有干净语义。

---

## 2. 握手:`initialize` + 能力协商

client 连上后第一条。双方报身份与**细粒度能力**(v0.1.1:能力必须按 feature 细分且标 required/optional,否则旧 consumer 忽略新事件可能致 run 卡死或危险操作无人处理——见 §9)。

**Request**(client→server):
```jsonc
{
  "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {
    "client": { "name": "cmux", "version": "0.64.16" },
    "capabilities": {
      "consensus": true,
      "approval": { "supported": true, "kinds": ["merge_approval"] },
      "unattended_loop": true,
      "artifact_refs": true
    },
    "protocol_version": "0.1.1"
  }
}
```

**Response**(server→client):
```jsonc
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "server": { "name": "holp-reference-daemon", "version": "0.1.1" },
    "capabilities": {
      "consensus": true,
      "approval": { "supported": true, "kinds": ["merge_approval","force_push_approval","budget_exceeded"] },
      "unattended_loop": true,
      "remote_runner": false,
      "artifact_refs": true
    },
    "protocol_version": "0.1.1"
  }
}
```

**能力语义**(v0.1.1 钉死):
- `consensus:false`(client)→ server 不发 `consensus_verdict` 事件,该 run 退化为单 agent(或 client 显式接受无共识)。
- `approval.supported:false` → server **不得**发起需要 approval 的 run;`orchestrate.run` 若会触发 approval,须在受理前 reject(错误 `approval_required_but_unsupported`,见 §10)。
- `approval.kinds`:client 只实现能交互的 kind 子集;server 发 client 不支持的 kind → run 降级或 escalate(见 §7、§11)。
- `artifact_refs:false` → server 不得发 artifact ref(大 payload 只能内联截断,consumer 自行决定能否展示)。

---

## 3. agent 队伍:声明 + 发现 + 探测

> v0.1.1:flock 从「仅 push 声明」扩成**三段**。codex 指出 consumer 声明(声明是 intent)不够,orchestrator 必须返回可执行能力、版本、缺失凭证;cmux 是扫进程发现(pull)。

### 3.1 `flock.declare`(push:声明 intent)

> 替代 cmux 的硬编码 switch(`AgentSessionProvider.swift` codex/claude/opencode 三家各一个 case)。把「哪几家、什么传输」从 consumer 源码挪成数据。
> 设计借自 Oz `Harness` oneof + happier catalog + spawn manifest。

```jsonc
{ "jsonrpc": "2.0", "id": 2, "method": "flock.declare",
  "params": { "agents": [
    { "id": "claude", "transport": "native-claude", "roles": ["architect","reviewer","coder","tester"],
      "auth_ref": "env:ANTHROPIC_API_KEY", "enabled": true },
    { "id": "codex", "transport": "mcp-codex", "roles": ["coder","reviewer","tester"],
      "auth_ref": "login:codex", "enabled": true }
  ] } }
```

字段:`id`(开放字符串,运行时校验)/ `transport`(`native-claude`|`mcp-codex`|`acp`|自定义)/ `roles`(architect/reviewer/coder/tester/test_audit/test_strengthen)/ `auth_ref`(凭证引用,**不传明文**:`env:XXX`|`login:agent`|`secret:name`)/ `enabled`。

### 3.2 `flock.discover`(pull:让 orchestrator 主动发现本地 agent)

> 对位 cmux `VaultAgentProcessScanner` 扫进程发现 agent。consumer 不知道每家的真实安装路径/登录/版本时,可让 orchestrator 自己探。

```jsonc
{ "jsonrpc": "2.0", "id": 3, "method": "flock.discover",
  "params": { "transports": ["native-claude","mcp-codex"], "probe": true } }
```

### 3.3 Response(声明/发现的统一回执):返回**可执行能力**,不是照单全收

> v0.1.1 关键:orchestrator 必须对每个声明/发现的 agent 返回实测能力——版本、登录状态、缺失凭证、权限模型。声明只是 intent,实测才是可调度依据。

```jsonc
{ "jsonrpc": "2.0", "id": 2, "result": {
  "agents": [
    { "id": "claude", "transport": "native-claude", "status": "ready",
      "version": "1.0.0", "logged_in": true, "resolved_roles": ["architect","reviewer","coder","tester"] },
    { "id": "gemini", "transport": "acp", "status": "rejected",
      "reason": "acp adapter not wired in v0.1.1", "missing": ["adapter:acp"] }
  ]
} }
```

`status`:`ready` | `degraded`(部分能力可用)| `rejected`(不可调度,带 `reason`+`missing`)。

> v0.1.1 参考实现:`native-claude`/`mcp-codex` adapter **目前是桩**(见 §12),故 declare/discover 的实测 status 在真接线前多为 `rejected`。**不冒充已接通**(守规:stub 不假装能 spawn)。

---

## 4. 发起编排:`orchestrate.run`

> 设计借自 Oz `RunAgents` + loopwright triage 派单。**共识参数统一到一处**(v0.1.1:删掉 v0.1 里 `roles.reviewer` 和顶层 `consensus` 字段重复且冲突的设计)。

**Request**:
```jsonc
{ "jsonrpc": "2.0", "id": 4, "method": "orchestrate.run",
  "params": {
    "goal": "Fix the flaky test in tests/foo.test.ts",
    "trigger": "issue:42",
    "roles": {
      "coder":    { "agent": "codex" },
      "reviewer": { "panel": ["claude", "gemini"], "quorum": 2 }
    },
    "execution_mode": { "kind": "Local" },
    "policy": {
      "exclude_author": true,
      "author_provenance": "produced_by_agent_id",
      "on_quorum_unsatisfiable": "ask_human"
    },
    "plan": { "required": true }
  } }
```

**字段**:
- `goal` / `trigger`(`issue:N`|`manual`|`webhook:...`):同 v0.1。
- `roles`:角色派单;reviewer 带 `panel`+`quorum`。**共识配置只在 `roles.reviewer` 一处**(v0.1.1 修复 P0-4 重复)。
- `execution_mode`:见 §4.1。
- `policy`(v0.1.1 新增,修复 P0-5):治理策略,**不是 wire 层业务概念**。
  - `exclude_author`:是否排除作者(作为 orchestrator policy)。
  - `author_provenance`:作者身份来源——`produced_by_agent_id`(产出该 artifact 的 agent)| `commit_author` | `run_initiator`(来源 loopwright PRD §9「角色不等式」,但**降到 policy 层**,wire 层只见 provenance 不见裸「author」语义)。
  - `on_quorum_unsatisfiable`:`ask_human` | `reject` | `degrade_quorum`(见 §6 可满足性校验)。
- `plan.required`:是否要求先出骨架计划。

### 4.1 `execution_mode`

> v0.1.1:Remote 从 `{environment_id, worker_host}` 两个薄字段,改为 **opaque capability-negotiated object**(codex P1-5:远程执行真正需要 workspace sync/secret scope/artifact transport/network/cost/identity,当前两字段不够,硬编码会致未来破坏性变更)。

```jsonc
"execution_mode": { "kind": "Local" }
// Remote:v0.1.1 只占位,不定义内部字段;留给后续扩展 proposal
"execution_mode": { "kind": "Remote", "remote": { /* opaque, versioned separately */ } }
```

- **Local**:v0.1.1 唯一实现。
- **Remote**:wire 留 `kind`+opaque `remote` 对象;其内部 schema(workspace sync / secret scope / artifact transport / network policy / cost / identity / log retention)在独立扩展 proposal 定义,**不进 v0.1.1**,避免假装两字段能稳定未来 wire。未来对位 spawn agent×cloud、skypilot 调度。

**Response**(立即,受理):
```jsonc
{ "jsonrpc": "2.0", "id": 4, "result": { "run_id": "run_abc", "accepted": true } }
```

`orchestrate.run` 在受理前做硬校验(见 §6.2、§10):共识可满足性、approval 能力匹配、transport 可用。校验不过 → 立即 error response,不进 run。

---

## 5. 事件订阅:`events.subscribe` / `events.unsubscribe`

> v0.1.1 重写:v0.1 的 `events.stream` 既是订阅请求又是流,无法多订阅/取消/归属。v0.1.1 拆成「订阅拿 subscription_id」+「带 subscription_id 的事件 notification」。形状仍借鉴 cmux `CmuxEventBus`(seq 单调 + replay + 心跳 + slow_consumer)。

**订阅**(client→server,普通 request):
```jsonc
{ "jsonrpc": "2.0", "id": 5, "method": "events.subscribe",
  "params": { "run_id": "run_abc", "after_seq": 0,
              "categories": ["run","agent","consensus","approval"], "include_heartbeats": true } }
```

**Response**(立即,返回 subscription_id + 当前 latest_seq):
```jsonc
{ "jsonrpc": "2.0", "id": 5, "result": { "subscription_id": "sub_1", "latest_seq": 0 } }
```

**事件 notification**(server→client,**每条带 `subscription_id`**):先 replay(after_seq 之后的存量),再持续推。
```jsonc
{ "jsonrpc": "2.0", "method": "events.heartbeat",
  "params": { "subscription_id": "sub_1", "latest_seq": 12, "ts": 1718600000 } }
{ "jsonrpc": "2.0", "method": "events.event",
  "params": { "subscription_id": "sub_1", "seq": 13, "ts": 1718600001,
              "category": "agent", "name": "tool_called", "run_id": "run_abc", "payload": {...} } }
```

**取消订阅**:`{ "method": "events.unsubscribe", "params": { "subscription_id": "sub_1" } }`(client→server,request)。

**背压**:消费过慢 → server 发 `events.error { subscription_id, code: "slow_consumer", latest_seq }`(普通 notification)并关该订阅。来源 cmux `slow_consumer`。

**事件 `name` 集合**(来源 loopwright `EVENT_TYPE` + happier sessionMessages/approvals):
- `run`:`run_started`/`run_triaging`/`run_reviewing`/`run_fixing`/`run_merged`/`run_blocked`/`run_gave_up`
- `agent`:`agent_selected`/`step_started`/`tool_called`/`tool_result`/`fs_edited`/`agent_failed`
- `consensus`:`consensus_verdict`(见 §6)/`consensus_degraded`
- `approval`:`approval_requested`/`approval_resolved`(见 §7,**单通道**,不再是独立 notification)
- `lifecycle`:`escalated`/`lease_stolen`/`circuit_open`

每事件带 `subscription_id`、`seq`(单调、可重放)、`ts`、`run_id`、`category`、`name`、`payload`。

> 大 payload(diff 全文等)走 **artifact ref**(见 §8),不内联。

---

## 6. 共识裁决(协议级,HOLP 独有)

> 来源:loopwright `aggregateVerdict` + 共识评审。Oz 多 harness 并行但无共识聚合;happier reviews 是单引擎。**这是 HOLP 写进协议的真差异。**
> v0.1.1 修复:(a) 删掉示例数学矛盾;(b) verdict/evidence 分层;(c) 作者降到 provenance;(d) quorum 可满足性硬校验。

### 6.1 事件(consensus_verdict 是事件,不是独立方法)

共识裁决**只作为 `events.event` 的一个 name**(category=consensus),不是独立 notification 方法(v0.1.1 修复 P0-2:删掉「`consensus.verdict` 既是 §6 标题又被说成独立消息」的矛盾)。

```jsonc
{ "jsonrpc": "2.0", "method": "events.event",
  "params": { "subscription_id": "sub_1", "seq": 27, "ts": 1718600100,
              "category": "consensus", "name": "consensus_verdict", "run_id": "run_abc",
    "payload": {
      "target": { "artifact_id": "art_diff_1", "produced_by_agent_id": "codex" },
      "outcome": "request_changes",                  // approve | request_changes | reject | ask_human
      "max_severity": "P1",                          // P0 | P1 | P2 | NONE
      "quorum": { "required": 2, "eligible": 2, "met": true },
      "rule": "majority-non-author",
      "reviews": [
        { "agent": "claude",  "eligible": true,  "verdict": "request_changes", "max_severity": "P1",
          "findings_ref": "art_findings_claude", "status": "completed" },
        { "agent": "gemini",  "eligible": true,  "verdict": "approve",          "max_severity": "P2",
          "findings_ref": "art_findings_gemini", "status": "completed" }
      ],
      "excluded": [ { "agent": "codex", "reason": "produced_by_agent_id (author)" } ],
      "errors": []                                   // timeout/error/abstain 的评审
    } } }
```

**分层**(v0.1.1 修复 P2-2):
- `outcome`:聚合裁决(单一枚举)。
- `reviews[]`:每家评审结果 + `status`(completed/timeout/error/abstain)+ `findings_ref`(evidence 走 artifact)。
- `quorum`:显式 `{required, eligible, met}`——`eligible` = 排除作者后的可投票家数。
- `errors[]`:失败/超时/弃权的评审(quorum 只统计 `eligible && status==completed`)。

### 6.2 可满足性硬校验(在 `orchestrate.run` 受理时)

> v0.1.1 修复 P0-3:v0.1 示例 panel=[claude,codex] quorum=2 exclude_author=true 但 codex 是作者,排后只剩 claude,不可能达 quorum,却仍产出 verdict。

`orchestrate.run` 受理前校验:**排除作者后的 eligible 投票家数 ≥ quorum**。
- 不满足 → 按 `policy.on_quorum_unsatisfiable` 处置:`ask_human`(escalate)| `reject`(error `quorum_unsatisfiable`,见 §10)| `degrade_quorum`(降到 eligible 数)。
- **绝不产出 `met:false` 的正常 verdict**;`met:false` 只出现在降级/escalate 路径,且 `outcome` 必为 `ask_human` 或配合 `consensus_degraded` 事件。

### 6.3 作者身份(provenance,不是 wire 业务概念)

> v0.1.1 修复 P0-5:v0.1 把 `author` 裸布尔塞进 wire 层,但没定义来源。

wire 层只表达**provenance**:`target.produced_by_agent_id` / `target.artifact_id`。「排除作者」是 `policy.exclude_author` + `policy.author_provenance` 决定的 orchestrator 行为,wire 不假设「author」是单一全局身份——多步骤 run 不同 artifact 可能有不同 producer。

---

## 7. 人工介入(approval):单通道状态机

> v0.1.1 修复 P0-6:v0.1 的 approval 既是 §5 事件(`approval_needed`)又是 §7 独立 notification(`approval.request`),双通道竞争、会重复发。v0.1.1 统一为**单通道 + 状态机**。

**approval 只走事件流一种通道**:`approval_requested` / `approval_resolved` 都是 `events.event`(category=approval)。**不再有独立 `approval.request` notification。**

**状态机**:`requested → resolved | expired | cancelled`。

需要人拍板时(如合并前、危险操作):
```jsonc
{ "jsonrpc": "2.0", "method": "events.event",
  "params": { "subscription_id": "sub_1", "seq": 40, "category": "approval",
              "name": "approval_requested", "run_id": "run_abc",
    "payload": { "approval_id": "ap_1", "kind": "merge_approval",
                 "reason": "merge-gate requires human", "expires_at": 1718603000,
                 "provenance": { "step_id": "step_5", "artifact_id": "art_pr_1" },
                 "details_ref": "art_approval_details" } } }
```

人决定后(client→server,**普通 request**):
```jsonc
{ "jsonrpc": "2.0", "id": 6, "method": "approval.resolve",
  "params": { "approval_id": "ap_1", "decision": "approved", "by": "user:tizer" } }
```

server 回执 + 发 `approval_resolved` 事件:
```jsonc
{ "jsonrpc": "2.0", "id": 6, "result": { "approval_id": "ap_1", "accepted": true } }
// 随后在事件流:
{ "method": "events.event", "params": { "seq": 41, "category":"approval", "name":"approval_resolved",
  "run_id":"run_abc", "payload": { "approval_id":"ap_1", "decision":"approved", "by":"user:tizer" } } }
```

`kind`:`merge_approval`|`force_push_approval`|`semantic_decision`|`low_confidence`|`budget_exceeded`(来源 loopwright `ESCALATION_KIND`)。

**能力匹配**(`orchestrate.run` 受理时,见 §2/§10):
- client `approval.supported:false` → server 不得发起会触发 approval 的 run。
- client 不支持某 `kind` → 该 kind 触发时,server 按 unattended policy(§11)处置:escalate / 超时默认 / 拒绝。**不静默继续**。
- `expires_at`:超时未 resolve → 自动 `expired`,按 policy(默认 escalate 或拒绝该步)。

> awaiting_approval 的内部状态机迁移(旧 loopwright #11 强阻塞)是参考实现的事,不影响协议定义。

---

## 8. Artifact(大 payload 引用)

> v0.1.1 新增(codex P2-4):v0.1 提到「大 payload 走 artifact ref」但没协议。consumer 无法展示 review 证据/findings/diff。

**envelope**:
```jsonc
{ "artifact_id": "art_diff_1", "type": "diff", "mime": "text/x-diff",
  "size": 4523, "sha256": "abc...", "created_by": "codex", "created_at": 1718600000 }
```

事件里只带 ref(上面的 envelope),内容另取。

**读取**(client→server):
```jsonc
{ "jsonrpc": "2.0", "id": 7, "method": "artifact.get",
  "params": { "artifact_id": "art_diff_1" } }
```
**Response**:`{ "artifact_id": "art_diff_1", "content_ref": "...", "sha256": "abc...", "truncated": false }`。内容可内联(小)或走带 token 的临时读取路径(大,需 path traversal / token guard——来源 happier timeline 安全实践)。

**保留策略**:`artifact` envelope 带 `expires_at`(可选);server 可清理过期 artifact。v0.1.1 最小定义:type/mime/size/sha256/created_by + get 方法;细粒度权限/URI scheme 进 v0.2。

---

## 9. 版本化与能力降级

> v0.1.1 重写(codex P0-7):v0.1 说「minor 加新事件 name,旧 consumer 忽略即可」,但事件 name 是行为语义(如需停机等待的 approval kind),忽略可能致 run 卡死/危险操作无人处理。

- 协议版本在 `initialize` 协商;major 不匹配 → 拒绝(`protocol_version_mismatch`,见 §10)。
- **能力按 feature 细分 + required/optional**(见 §2):`consensus` / `approval.{supported,kinds}` / `unattended_loop` / `artifact_refs` / `remote_runner`。server 在 `initialize` 后**明确知道**:哪些行为可发、哪些 run 必须拒绝。
- **最小 consumer**:§2 initialize + §3 flock + §4 orchestrate.run + §5 events.subscribe。不支持 consensus/approval/artifact → server 按能力降级或拒绝相关 run,**不靠「忽略未知事件」兜底**。
- 演进只增不破(minor 加可选字段/方法/事件 name,且该 name 必须是「旧 consumer 忽略安全」的——即非阻塞性、非语义关键);破坏性 bump major。

---

## 10. 错误模型

> v0.1.1 新增(codex P2-5):v0.1 只有 `protocol_version_mismatch` 和 `slow_consumer`,实现会各处临时造字符串。

JSON-RPC error object:`{ "code": <int>, "message": <string>, "data": {...} }`。HOLP 错误 code 用区间 `-32000 ~ -32099`(JSON-RPC 保留段)。

| code | 名称 | 触发 |
|---|---|---|
| -32001 | `protocol_version_mismatch` | initialize 版本协商失败 |
| -32002 | `capability_required_but_unsupported` | run 需要 consensus/approval/artifact 但 client 不支持 |
| -32003 | `approval_required_but_unsupported` | run 会触发 approval 但 client `approval.supported:false` |
| -32004 | `quorum_unsatisfiable` | 排除作者后 eligible < quorum,且 policy=reject |
| -32005 | `unsupported_transport` | flock 声明的 transport 无 adapter |
| -32006 | `missing_auth` | agent 凭证探测失败 |
| -32007 | `invalid_quorum` | quorum 参数非法(≤0 / > panel) |
| -32008 | `run_not_found` | 操作不存在的 run |
| -32009 | `approval_not_found` / `approval_already_resolved` | approval.resolve 校验失败 |
| -32010 | `lease_stolen` / `run_locked` | 并发/lease 冲突 |
| -32099 | `internal_error` | 兜底 |

可重试(transient):`-32006 missing_auth`(可能刚登录)、`-32010 lease_stolen`(重试新 lease)。其余默认不可重试。

事件流错误:`slow_consumer`(§5,关订阅,非 JSON-RPC error)。

---

## 11. Unattended Policy(Human-on-Loop 落地)

> v0.1.1 新增(codex P1-6):v0.1 把「Human on Loop」当产品立场,但协议没有无人值守的可执行语义。

`orchestrate.run` 可带 `unattended_policy`(缺省值由 server 配置):
```jsonc
"unattended_policy": {
  "auto_pass_gates": ["lint","test","build"],          // 这些 gate 过了自动续
  "require_human_gates": ["merge_approval"],           // 这些必须 approval
  "on_approval_timeout": "escalate",                   // escalate | auto_reject | auto_approve(危险,默认禁用)
  "on_capability_gap": "reject_run",                   // client 缺能力时:reject_run | degrade
  "max_unattended_steps": 50
}
```

- 明确哪些 gate 自动过、哪些必须人。
- approval 超时 → `on_approval_timeout`(默认 `escalate`,**`auto_approve` 必须显式开启且 server 可拒绝**)。
- client 能力缺口 → `on_capability_gap`。
- 名字「Human on Loop」= 这些 policy 的默认立场:**默认尽量自动、只在 require_human_gates 打断**。

---

## 12. v0.1.1 实现边界(参考 daemon)

> v0.1.1 修复 P2-3:v0.1 的 spec/version/README 对「v0.1 做了什么」自相矛盾(spec 说做 native-claude+mcp-codex,registry 明说全是桩)。v0.1.1 分清 **protocol draft** 和 **daemon milestone**。

**协议层(protocol draft v0.1.1)**:本 spec 全部章节有定义(含 error/artifact/policy/capability)。

**参考 daemon milestone(当前)**:
- ✅ 协议接入骨架(控制面 JSON-RPC + 事件 subscription)。
- ✅ adapter **契约 + 桩**(registry 三 transport 全桩,**明示未接 agent**)。
- ✅ 从旧 loopwright 搬入:治理内核 / 数据铁三角 / 共识 / 状态机(进行中)。
- ❌ **未做(不声称已做)**:native-claude / mcp-codex 真接线(待 adapter 真实现 / 接 happier 方言库);Remote;acp;Web 传输。

**当前仓不得声称**「v0.1 已接 native-claude/mcp-codex」——只能声称「adapter contract stub + 协议 draft」。真接线前的 declare/discover 实测 status 多为 `rejected`(adapter 未接线)。

### 12.1 adapter 实现约束(codex P1-3/P1-4)

> v0.1.1 落到实现约束(adapter 契约文件同步改):
- **并发 session 归属**:一个 backend 实例**只允许一个 session**(v0.1.1 简化);若未来要多 session,`AgentMessage` 必须带 `sessionId/run_id/step_id`,handler 按 session 订阅。
- **permission 可恢复**:`PermissionHandler` 返回 `ask_human` 时,必须带 `request_id`/`call_id`/`session_id`;`approval.resolve` 后 adapter 能 resume/deny 原始 tool call(对应 §7 approval + adapter 契约)。

---

## 设计来源总表

见 `docs/positioning.md`「设计来源」表。各章就地标注借自哪个仓的什么。HOLP 不凭空发明,也不抄依赖(Oz proto 只借思路、不实现服务端)。

---

## v0.1 → v0.1.1 变更明细(按 review)

**P0 修复**:
1. §1 传输模型钉死:JSON-RPC 控制面 + 带 `subscription_id` 的事件 notification(删「连续 response chunk」矛盾)。
2. §6 consensus_verdict 固定为事件,删「独立消息/方法」矛盾。
3. §6.2 删共识示例数学矛盾 + 加 quorum 可满足性硬校验(panel 排作者后 eligible≥quorum)。
4. §4 共识配置合并到 `roles.reviewer` 单一入口(删 `roles.reviewer` 与顶层 `consensus` 重复)。
5. §6.3 作者降到 provenance(`produced_by_agent_id`),`exclude_author` 降为 policy;wire 不见裸 author。
6. §7 approval 单通道状态机(只走事件流,删独立 `approval.request` notification)。
7. §2/§9 能力按 feature 细分 required/optional(删「忽略未知事件即可」的危险兜底)。
8. §3 加 `flock.discover` + 实测能力回执(声明是 intent,实测才可调度)。

**P1 修复**:
- §2 capabilities 细化 + §12 adoption claim 降级(不声称 cmux/Warp 自然接入,需 bridge)。
- §12.1 adapter 并发(单 session)+ permission 可恢复(request_id/call_id/resume)。
- §4.1 Remote 改 opaque capability object(不假装两字段稳定未来 wire)。
- §11 unattended policy(Human-on-Loop 落成可执行语义)。
- 「agent 零改动」限定为「vendor 不需采纳 HOLP」(adapter 合格标准见 §12.1)。

**P2 修复**:
- §12 v0.1 范围声明统一(protocol draft vs daemon milestone,不声称已接 native-claude/mcp-codex)。
- §6.1 verdict/evidence 分层(outcome + reviews[] + findings_ref + errors[])。
- §8 artifact 协议(envelope + get + sha256 + 保留)。
- §10 错误模型(machine-readable code 表)。
- §12.1 标注:搬 loopwright 前先提取 invariants,不把旧表结构当事实标准(进行中)。
