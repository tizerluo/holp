# HOLP — Human On Loop Protocol

> **版本**:v0.1.3 (draft)
> **状态**:草稿,参考实现进行中
> **定位**:见 `docs/positioning.md`。开源、免费、本地优先的 multi-agent 编排协议。

HOLP 是 **consumer**(终端 / 工具 / APP——cmux、Warp、happier、CLI)与 **orchestrator**(编排器——HOLP 参考 daemon 或任何实现)之间的那根线。consumer 声明「我有一窝异构 agent」,发起编排目标,orchestrator 派单并流式回吐事件;需要人拍板时,人在回路上介入——**Human on Loop**。

设计来源(概念启发,非直接对位/搬运):events 订阅启发自 cmux `CmuxEventBus`(HOLP 的 subscribe+notification 是新协议设计);flock/orchestrate 启发自 Oz proto 概念(不抄依赖、不实现服务端);consensus 启发自 loopwright 共识评审的聚合策略(wire 结构是 HOLP 新设计);朝下 adapter 契约启发自 happier `AgentBackend` 形状(接入需 wrapper,非直接复用)。逐条对位与诚实表述见 `docs/positioning.md`。

---

## 1. 传输与编码

**两个传输面**:

- **控制面**:stdio 上的 **JSON-RPC 2.0**。client→server 方法调用走标准 request/response(带 `id`):`initialize` / `flock.*` / `orchestrate.run` / `events.subscribe` / `events.unsubscribe` / `approval.resolve` / `task.cancel`。
- **事件面**:server→client 的事件流,用 JSON-RPC **notification**(无 `id`),**每条带 `subscription_id`** 绑定订阅(见 §5)。

**编码**:newline-delimited JSON,每行一个对象。

事件**不是**「某个 long-running request 的连续 response」。`events.subscribe` 是普通 request(立即返回 `subscription_id`),事件是独立的、带 `subscription_id` 的 notification——这让多订阅、取消、错误归属都有干净语义。

> 未来可选 WebSocket 传输(给 Web/远程 APP);当前只 stdio。

---

## 2. 握手:`initialize` + 能力协商

client 连上后第一条。双方报身份与**细粒度能力**。每个 capability 是一个 **descriptor** `{ supported, required?, kinds? }`:

- `supported`:本端是否支持该能力。
- `required`:本端是否**硬要求**对方支持(缺则拒绝)。缺省 false。**`initialize.capabilities.*.required:true` 一律是连接级**——缺则 `initialize` 拒绝(`capability_required_but_unsupported`)。run 级硬要求不放 descriptor,放 `orchestrate.run` params。
- `kinds`(仅 approval):本端支持/要求的 kind 子集。
- **缺省 capability**(descriptor 未出现):视为 `{supported:false}`(不支持)。

**Request**(client→server):
```jsonc
{
  "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {
    "client": { "name": "cmux", "version": "0.64.16" },
    "capabilities": {
      "consensus":    { "supported": true },
      "approval":     { "supported": true, "kinds": ["merge_approval"] },
      "unattended_loop": { "supported": true, "required": true },
      "artifact_refs":{ "supported": true }
    },
    "protocol_version": "0.1.3"
  }
}
```

**Response**(server→client):
```jsonc
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "server": { "name": "holp-reference-daemon", "version": "0.1.3" },
    "capabilities": {
      "consensus":    { "supported": true },
      "approval":     { "supported": true, "kinds": ["merge_approval","force_push_approval","budget_exceeded"] },
      "unattended_loop": { "supported": true },
      "artifact_refs":{ "supported": true }
    },
    "protocol_version": "0.1.3"
  }
}
```

**能力协商规则**:
- 协商 = 双方 descriptor 的交集:`effective.cap = client.cap.supported && server.cap.supported`。
- 任一方 `required:true` 但对方 `supported:false` → `initialize` 拒绝(`capability_required_but_unsupported`)。
- `consensus` 不可用 → server 不发 `consensus_verdict`,run 退化为单 agent(或 client 在 `orchestrate.run` 显式接受无共识)。
- `approval` 不可用 → server 不得发起会触发 approval 的 run;若 run 的 unattended_policy.require_human_gates 非空且 client 不支持 approval → 受理前 reject(`approval_required_but_unsupported`)。
- `approval.kinds` 取交集;**任一方 `approval.required:true` 且 kinds 交集为空** → `initialize` 拒绝;**双方都非 required 但 kinds 空交集** → 不拒绝连接,run 触发该 kind 时按 §7/§11 降级或 escalate。
- `artifact_refs` 不可用 → server 不得发 artifact ref(大 payload 内联截断)。

---

## 3. agent 队伍:声明 + 发现 + 探测

### 3.1 `flock.declare`(push:声明 intent)

把「哪几家、什么传输」从 consumer 源码挪成数据(替代 cmux `AgentSessionProvider` 那种硬编码 switch)。

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

consumer 不知道每家的真实安装路径/登录/版本时,可让 orchestrator 自己探。

```jsonc
{ "jsonrpc": "2.0", "id": 3, "method": "flock.discover",
  "params": { "transports": ["native-claude","mcp-codex"], "probe": true } }
```

### 3.3 Response:返回**可执行能力**,不是照单全收

orchestrator 对每个声明/发现的 agent 返回实测能力——版本、登录状态、缺失凭证。声明只是 intent,实测才是可调度依据。

```jsonc
{ "jsonrpc": "2.0", "id": 2, "result": {
  "agents": [
    { "id": "claude", "transport": "native-claude", "status": "ready",
      "version": "1.0.0", "logged_in": true, "resolved_roles": ["architect","reviewer","coder","tester"] },
    { "id": "gemini", "transport": "acp", "status": "rejected",
      "reason": "acp adapter not wired", "missing": ["adapter:acp"] }
  ]
} }
```

`status`:`ready` | `degraded`(部分能力可用)| `rejected`(不可调度,带 `reason`+`missing`)。

**部分成功语义**:`flock.declare`/`flock.discover` **永远返回 per-agent status,不抛 JSON-RPC error**(哪怕全部 rejected)。`unsupported_transport`/`missing_auth` 作为 per-agent `status=rejected` 的 `reason`,不是 error。只有请求格式非法才 error。见 §10.1。

> 参考实现:`native-claude`/`mcp-codex` adapter 目前是桩(见 §12),故 declare/discover 的实测 status 在真接线前多为 `rejected`。

---

## 4. 发起编排:`orchestrate.run`

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
- `goal` / `trigger`(`issue:N`|`manual`|`webhook:...`)。
- `roles`:角色派单;reviewer 带 `panel`+`quorum`。**共识配置只在 `roles.reviewer` 一处**。
- `execution_mode`:见 §4.1。
- `policy`:治理策略(不是 wire 层业务概念)。
  - `exclude_author`:是否排除作者(orchestrator policy)。
  - `author_provenance`:作者身份来源——`produced_by_agent_id` | `commit_author` | `run_initiator`。
  - `on_quorum_unsatisfiable`:`ask_human` | `reject` | `degrade_quorum`(见 §6.2)。
- `plan.required`:是否要求先出骨架计划。

### 4.1 `execution_mode`

```jsonc
"execution_mode": { "kind": "Local" }   // 当前唯一合法值
```

- `kind` 唯一合法值:`"Local"`。其他值 → error `unsupported_execution_mode`(见 §10)。
- Remote(workspace sync / secret scope / artifact transport / network / cost / identity)在独立扩展 proposal 一次性定义,**当前 wire 不含任何 Remote 形状**;届时作为新协议 minor(带 capability `remote_runner`)引入。

**Response**(立即,受理):
```jsonc
{ "jsonrpc": "2.0", "id": 4, "result": { "run_id": "run_abc", "accepted": true } }
```

`orchestrate.run` 在受理前做硬校验(见 §6.2、§10):共识可满足性、approval 能力匹配、transport 可用。校验不过 → 立即 error response,不进 run。

---

## 5. 事件订阅:`events.subscribe` / `events.unsubscribe`

形状借鉴 cmux `CmuxEventBus`(seq 单调 + replay + 心跳 + slow_consumer)。

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

**背压**:消费过慢 → server 发 `events.error { subscription_id, code: "slow_consumer", latest_seq }`(普通 notification)并关该订阅。

**事件 `name` 集合**:
- `run`:`run_started`/`run_triaging`/`run_reviewing`/`run_fixing`/`run_merged`/`run_blocked`/`run_gave_up`
- `agent`:`agent_selected`/`step_started`/`tool_called`/`tool_result`/`fs_edited`/`agent_failed`
- `consensus`:`consensus_verdict`(见 §6)/`consensus_degraded`
- `approval`:`approval_requested`/`approval_resolved`/`approval_expired`/`approval_cancelled`(见 §7,单通道状态机,每态一事件)
- `lifecycle`:`escalated`/`lease_stolen`/`circuit_open`

每事件带 `subscription_id`、`seq`(单调、可重放)、`ts`、`run_id`、`category`、`name`、`payload`。

> 大 payload(diff 全文等)走 **artifact envelope**(见 §8),不内联。

---

## 6. 共识裁决(协议级,HOLP 独有)

跨厂商共识评审是 HOLP 写进协议的真差异:Oz 有多 harness 并行但未把 quorum 共识聚合作为协议对象;happier 有 review engine 入口,但没有 HOLP/loopwright 式协议级 quorum consensus 聚合。

### 6.1 事件

共识裁决**只作为 `events.event` 的一个 name**(category=consensus),不是独立 notification 方法。

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
          "findings": { "artifact_id":"art_findings_claude", "type":"findings", "mime":"application/json",
                        "size":821, "sha256":"def...", "created_by":"claude", "created_at":1718600050 },
          "status": "completed" },
        { "agent": "gemini",  "eligible": true,  "verdict": "approve",          "max_severity": "P2",
          "findings": { "artifact_id":"art_findings_gemini", "type":"findings", "mime":"application/json",
                        "size":740, "sha256":"ghi...", "created_by":"gemini", "created_at":1718600060 },
          "status": "completed" }
      ],
      "excluded": [ { "agent": "codex", "reason": "produced_by_agent_id (author)" } ],
      "errors": []                                   // timeout/error/abstain 的评审
    } } }
```

**分层**:
- `outcome`:聚合裁决(单一枚举)。
- `reviews[]`:每家评审结果 + `status`(completed/timeout/error/abstain)+ `findings`(artifact envelope,evidence 走 §8)。
- `quorum`:显式 `{required, eligible, met}`——`eligible` = 排除作者后的可投票家数。
- `errors[]`:失败/超时/弃权的评审(quorum 只统计 `eligible && status==completed`)。

### 6.2 可满足性校验(两段式)

**第 1 段:静态形状校验(`orchestrate.run` 受理时,无作者信息)**
- 校验 panel 的形状:`panel` 中 enabled 且 capability 可用、status=ready 的 agent 数 ≥ quorum。
- 不预留「作者余量」——作者是否在 reviewer panel 未知,且可能根本不在 panel(如 coder=codex、reviewer panel=[claude,gemini])。预留余量的公式会误杀合法配置。作者命中 panel 的动态不足,交给第 2 段。
- 不满足(形状就不够)→ error `quorum_unsatisfiable`(见 §10)。

**第 2 段:精确 quorum 校验(consensus step 开始前,作者已确定)**
- 此时被评审 artifact 的 `produced_by_agent_id` 已知 → 计算 `eligible = panel 中 ≠ 作者 的 agent 数`。
- `eligible ≥ quorum` → 正常跑共识。
- `eligible < quorum` → 按 `policy.on_quorum_unsatisfiable`:`ask_human`(escalate,发 `consensus_degraded`)| `degrade_quorum`(降到 eligible,发 `consensus_degraded`)| `reject`(该步失败,run 按 unattended policy 处置)。
- **绝不产出 `quorum.met:false` 的正常 verdict**;`met:false` 只出现在降级/escalate,且 `outcome` 必为 `ask_human` 或配 `consensus_degraded`。

**错误码定序**:`invalid_quorum`(§10)管形状/引用合法性(quorum≤0、quorum>panel 规模、panel 空、panel 含 unknown/rejected agent)。`quorum_unsatisfiable` 管策略性不足(形状合法但排除作者后不够)。**同一次校验先 `invalid_quorum`(形状),再 `quorum_unsatisfiable`(策略)**,二者不重叠。

### 6.3 作者身份(provenance)

wire 层只表达 provenance:`target.produced_by_agent_id` / `target.artifact_id`。「排除作者」是 `policy.exclude_author` + `policy.author_provenance` 决定的 orchestrator 行为,wire 不假设「author」是单一全局身份——多步骤 run 不同 artifact 可能有不同 producer。

---

## 7. 人工介入(approval):单通道状态机

**approval 只走事件流一种通道**:`approval_requested`/`approval_resolved`/`approval_expired`/`approval_cancelled` 都是 `events.event`(category=approval)。没有独立 `approval.request` notification。

**状态机(每个 approval 一个)**:`requested → resolved | expired | cancelled`,每个转移一条对应事件。

**取消语义**:client **不能**单独取消 approval。没有 `approval.cancel` 方法。approval 取消只由 `task.cancel`(取消整个 run,§7.5)导致——server 对所有 pending approval 发 `approval_cancelled`。这避免「client 取消 approval 但 run 还在跑」的不一致。(client 想 abort approval 又不想取消 run 的场景留 v0.2。)

需要人拍板时(server→client):
```jsonc
{ "jsonrpc": "2.0", "method": "events.event",
  "params": { "subscription_id": "sub_1", "seq": 40, "category": "approval",
              "name": "approval_requested", "run_id": "run_abc",
    "payload": { "approval_id": "ap_1", "kind": "merge_approval",
                 "reason": "merge-gate requires human", "expires_at": 1718603000,
                 "provenance": { "step_id": "step_5", "artifact_id": "art_pr_1" },
                 "details": { "artifact_id":"art_approval_details", "type":"approval_details", "mime":"application/json",
                              "size":312, "sha256":"jkl...", "created_by":"daemon", "created_at":1718600000 } } }
```

人决定后(client→server,普通 request):
```jsonc
{ "jsonrpc": "2.0", "id": 6, "method": "approval.resolve",
  "params": { "approval_id": "ap_1", "decision": "approved", "by": "user:tizer" } }
```

server 回执 + 发终态事件(三条终态共享 payload,`state` 区分):
```jsonc
{ "jsonrpc": "2.0", "id": 6, "result": { "approval_id": "ap_1", "accepted": true } }
// 人批准:
{ "method": "events.event", "params": { "seq": 41, "category":"approval",
  "name":"approval_resolved", "run_id":"run_abc",
  "payload": { "approval_id":"ap_1", "state":"resolved", "decision":"approved", "reason":"user_decision", "by":"user:tizer" } } }
// 超时无人 resolve → server 自动:
{ "method": "events.event", "params": { "seq": 42, "category":"approval",
  "name":"approval_expired", "run_id":"run_abc",
  "payload": { "approval_id":"ap_1", "state":"expired", "reason":"timeout", "expired_at":1718603000 } } }
// task.cancel 导致 run 取消 → server 对所有 pending approval:
{ "method": "events.event", "params": { "seq": 43, "category":"approval",
  "name":"approval_cancelled", "run_id":"run_abc",
  "payload": { "approval_id":"ap_1", "state":"cancelled", "reason":"run_cancelled" } } }
```

终态 payload 必有:`approval_id`、`state`(`resolved`|`expired`|`cancelled`)、`reason`。`state=resolved` 额外带 `decision`(`approved`|`rejected`)、`by`。**race**:client resolve 与 server 超时/cancel 并发时,先到者赢,后到者收 `approval_already_resolved` error(§10)。

`approval.resolve` 对已处终态的 approval → error `approval_already_resolved`。

`kind`:`merge_approval`|`force_push_approval`|`semantic_decision`|`low_confidence`|`budget_exceeded`。

**能力匹配**:
- `approval` 不可用 → server 不得发起会触发 approval 的 run(受理前 reject `approval_required_but_unsupported`)。
- 某 `kind` 不在交集 → 按 §11 unattended policy 处置(escalate / 超时默认 / 拒绝),不静默继续。
- `expires_at`:超时未 resolve → server 发 `approval_expired`,按 policy(默认 escalate 或拒绝该步)决定 run 后续。

---

## 7.5 取消 run:`task.cancel`

**Request**(client→server):
```jsonc
{ "jsonrpc": "2.0", "id": 8, "method": "task.cancel",
  "params": { "run_id": "run_abc", "reason": "user aborted" } }
```

**Response**(立即受理):
```jsonc
{ "jsonrpc": "2.0", "id": 8, "result": { "run_id": "run_abc", "cancelling": true } }
```

**语义**:
- 取消整个 run(不是单个 step/approval)。server 收到后尽力停止 in-flight 的 agent step(经 adapter `cancel`),并对所有 pending approval 发 `approval_cancelled`(§7)。
- **幂等**:对已处终态(merged/gave_up/已取消)的 run 调 task.cancel → 成功 response(`cancelling:false`,表示无需动作),不报错。对不存在 run → error `run_not_found`(§10)。
- run 终态:取消完成后发 `run_gave_up` 事件(payload `{reason:"cancelled"}`);若取消时 run 已自然终态,不发额外事件。
- race:task.cancel 与 server 自然的 step 推进并发时,以 server 实际状态为准;consumer 靠事件流的终态事件(`run_gave_up`/`run_merged`)收敛,不依赖 `cancelling` 字段。

---

## 8. Artifact(大 payload 引用)

### 8.1 envelope(事件 ref 处必带)

```jsonc
{ "artifact_id": "art_diff_1", "type": "diff", "mime": "text/x-diff",
  "size": 4523, "sha256": "abc...", "created_by": "codex", "created_at": 1718600000,
  "expires_at": 1718610000 }
```

**规则**:事件 payload 里凡 ref(findings/details/artifact_id),该位置放**完整 envelope**(不是裸字符串),consumer 无需二次请求即可知类型/大小/hash。`artifact_id` 是全局唯一 id。

### 8.2 `artifact.get`

```jsonc
{ "jsonrpc": "2.0", "id": 7, "method": "artifact.get",
  "params": { "artifact_id": "art_diff_1" } }
```
**Response**(**永远返回 `content`,不返回 `content_ref`**):
```jsonc
{ "jsonrpc": "2.0", "id": 7, "result": {
  "artifact_id": "art_diff_1", "envelope": { /* §8.1 全字段 */ },
  "content": "diff --git a/...",
  "truncated": false,
  "truncated_at": 65536                         // 仅 truncated:true 时有,截断字节数
} }
```

`artifact.get` 总返回 `content`(可能是截断的字符串)。`envelope.size` 是真实大小,`truncated:true` + `truncated_at` 表示返回的 content 被截断。大 artifact 的分块读取通道(`artifact.read(offset,len)`)留 v0.2——当前保证 artifact 链路完全可执行(小/中 artifact 全量返回,超大 artifact 截断但 consumer 知道被截)。

**`content` 编码**:`string`。utf-8 文本(diff/findings/json)直接放;二进制 artifact(mime 非 text)→ base64 编码进 `content` + `envelope.mime` 标明。当前不支持流式。

**错误**(见 §10):`artifact_not_found` / `artifact_expired` / `artifact_forbidden`。

### 8.3 保留

envelope 带 `expires_at`(可选);server 可清理过期;`artifact.get` 过期 → `artifact_expired`。

---

## 9. 版本化

版本号形如 `MAJOR.MINOR`(稳定协议);draft 阶段额外带第三段表示同 minor 内的草案迭代(如 `0.1.3`)。**正式发布(脱离 draft)后只用 `MAJOR.MINOR` 两段**;draft 期第三段不计入兼容性判定——兼容性只看 `MAJOR.MINOR`。

- `MAJOR`:破坏性变更(改 wire 格式 / 删方法 / 改字段语义)。双方必须同 major。
- `MINOR`:向后兼容新增(可选字段 / 新方法 / 新事件 name)。新增的事件 name 必须是「旧 consumer 忽略安全」的(非阻塞、非语义关键);需 client 交互的语义(如新 approval kind)必须走 capability 协商,不靠「忽略」兜底。
- draft 期(`0.x`):允许 draft 内破坏性修订(bump 第三段),不受「只增不破」约束——还没人依赖稳定协议。脱离 0.x(首个稳定版 1.0)起严格执行语义化。

`initialize` 时双方报 `protocol_version`(比 `MAJOR.MINOR`),major 不匹配 → 拒绝(`protocol_version_mismatch`)。

---

## 10. 错误模型

JSON-RPC error object:`{ "code": <int>, "message": <string>, "data": {...} }`。HOLP 错误 code 用区间 `-32000 ~ -32099`(JSON-RPC 保留段)。**一错误一 code,不共用**(机器处理无需 parse message)。

| code | 名称 | 触发 |
|---|---|---|
| -32001 | `protocol_version_mismatch` | initialize 版本协商失败 |
| -32002 | `capability_required_but_unsupported` | 某 capability 一方 required 但对方 supported:false |
| -32003 | `approval_required_but_unsupported` | run 会触发 approval 但 client `approval.supported:false` |
| -32004 | `quorum_unsatisfiable` | 两段式校验(§6.2)不满足:第1段(静态形状不够)受理时直接报;第2段(排除作者后不够)且 `policy.on_quorum_unsatisfiable=reject` 时报 |
| -32005 | `unsupported_transport` | flock 某 agent transport 无 adapter |
| -32006 | `missing_auth` | agent 凭证探测失败(可重试) |
| -32007 | `invalid_quorum` | quorum 参数非法:≤0 / > panel / panel 空 / panel 含 unknown 或 rejected agent / 全部 excluded |
| -32008 | `run_not_found` | 操作不存在的 run |
| -32009 | `approval_not_found` | approval.resolve 的 approval_id 不存在 |
| -32010 | `approval_already_resolved` | approval.resolve 对已终态 approval(§7) |
| -32011 | `lease_stolen` | 并发/lease 被偷(可重试) |
| -32012 | `run_locked` | run 被锁(可重试) |
| -32013 | `unsupported_execution_mode` | `execution_mode.kind` ≠ "Local"(§4.1) |
| -32014 | `artifact_not_found` | artifact.get 的 id 不存在 |
| -32015 | `artifact_expired` | artifact 已过 `expires_at` |
| -32016 | `artifact_forbidden` | client 无权读该 artifact |
| -32017 | `invalid_subscription` | events.unsubscribe / 事件路由用了无效 subscription_id |
| -32099 | `internal_error` | 兜底 |

可重试(transient):`-32006 missing_auth`、`-32011 lease_stolen`、`-32012 run_locked`。其余默认不可重试。

### 10.1 flock 部分成功语义

**`flock.declare` / `flock.discover` 永远是「部分成功」语义**——返回值是 per-agent `agents[]`(每个带 status:ready/degraded/rejected + reason + missing),**不抛 JSON-RPC error**,哪怕全部 rejected。
- `unsupported_transport` / `missing_auth` 作为 per-agent `status=rejected` 的 `reason`(在 response 里),不是 JSON-RPC error。
- 仅当请求本身格式非法(无 agents 字段、transport 非法字符串)才抛 JSON-RPC error(`invalid_request`,JSON-RPC 标准 -32600)。
- `orchestrate.run` 受理时,若该 run 需要的 agent 全是 rejected status → error `unsupported_transport` 或 `missing_auth`(此时才是 JSON-RPC error,因为 run 无法进行)。

事件流错误:`slow_consumer`(§5,关订阅,非 JSON-RPC error)。

---

## 11. Unattended Policy(Human-on-Loop 落地)

`orchestrate.run` 可带 `unattended_policy`(缺省值由 server 配置):
```jsonc
"unattended_policy": {
  "auto_pass_gates": ["lint","test","build"],
  "require_human_gates": ["merge_approval"],
  "on_approval_timeout": "escalate",
  "on_capability_gap": "reject_run",
  "max_unattended_steps": 50
}
```

- 已定义可依赖字段:`on_approval_timeout`(`escalate` | `auto_reject` | `auto_approve`——后者危险,默认禁用,须显式开启且 server 可拒绝)、`on_capability_gap`(`reject_run` | `degrade`)、`max_unattended_steps`。
- approval 超时 → `on_approval_timeout`(默认 `escalate`)→ 配合 §7 `approval_expired` 事件。
- client 能力缺口 → `on_capability_gap`(配 §2 descriptor 协商)。
- 名字「Human on Loop」= 默认尽量自动、只在 require_human 打断。

> ⚠️ `gate` 概念(`auto_pass_gates`/`require_human_gates`)在协议层**尚未定义** gate object/gate event/gate outcome。当前 gate 列表值(`lint`/`test`/`build`/`merge_approval`)是 **daemon 私约定字符串**,consumer 无法可靠解析;consumer 应把 gate 列表当不透明,只依赖上述三个已定义字段。gate 协议(gate 种类、通过/失败事件、gate→approval kind 映射)留 v0.2。

---

## 12. 实现边界(参考 daemon)

**协议层(draft v0.1.3)**:本 spec 全章有定义。

**当前仓已落地**:
- ✅ 协议 draft(`protocol/`)。
- ✅ adapter 契约 + 桩(`adapters/`)。

**参考 daemon 下一步 milestone**:
- ⏳ 协议接入骨架(控制面 JSON-RPC + 事件 subscription)。
- ⏳ 从旧 loopwright 搬入:治理内核 / events-decisions-registry 数据骨架 / 共识 / 状态机。
- ❌ 未做(不声称):native-claude / mcp-codex 真接线(待 adapter 真实现 / 通过 wrapper 或抽取包复用 happier backend 模块);acp;Web 传输;Remote(wire 不含)。

**当前仓只声称**「adapter contract stub + 协议 draft」。真接线前的 declare/discover 实测 status 多为 `rejected`。

### 12.1 adapter 实现约束

- **并发 session**:一个 backend 实例**只允许一个 session**;若未来要多 session,`AgentMessage` 必须带 `sessionId/run_id/step_id`,handler 按 session 订阅。
- **permission 可恢复**:`PermissionHandler` 返回 `ask_human` 时带 `request_id`/`call_id`(单 session 约束下 session_id 冗余,故不带——与 adapter 类型一致);`approval.resolve` 后 daemon 调 `resolvePermission(request_id, decision)` 让 adapter resume/deny 原始 tool call。
- **命名**:adapter 注释/报错/文档统一用协议命名(`events.subscribe`/`approval_requested`/`consensus_verdict`)。

---

## 留 v0.2 的(诚实标注)

- unattended_policy 的 `gate` 协议(gate object/event/outcome/kind 映射)。
- big artifact 分块读取(`artifact.read(offset,len)`)。
- Remote 执行(workspace sync / secret scope / 等,独立扩展 proposal)。
- adapter 真接线(native-claude/mcp-codex/acp)。
- client 单独 abort approval(不取消整个 run)。

---

## CHANGELOG

- **v0.1.3**:quorum 两段式校验 + 错误码定序;artifact 强制 content(禁 content_ref);approval 单通道状态机(cancel 只由 task.cancel 导致)+ race 规则;`task.cancel` schema;capability descriptor `{supported, required?, kinds?}`(required 连接级);错误码拆开(一错误一码)+ flock 部分成功语义。经四轮深度 review,判「实现前无 P0」。
- **v0.1.2**:把首轮返工的表面改逼到可执行(Remote 删净、错误码拆开、跨文件命名统一)。
- **v0.1.1**:首轮 review 返工(传输面拆分、approval 单通道、flock discover)。
- **v0.1**:协议初稿。
