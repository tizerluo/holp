# HOLP — Human On Loop Protocol

> **版本**:v0.1.x (draft,当前 v0.1.2)
> **状态**:草稿,参考实现进行中
> **变更历史**:v0.1 → v0.1.1(传输/共识/审批/版本/flock 首轮返工)→ v0.1.2(把 v0.1.1 的「表面改」逼到可执行:capability descriptor / approval 终态上 wire / quorum 两段式 / Remote 删净 / artifact 闭环 / flock 部分成功 / 错误码拆开 + 跨文件命名统一)。变更明细见文末。
> **定位**:见 `docs/positioning.md`。开源、免费、本地优先的 multi-agent 编排协议。

> 文中「v0.1.x」指当前协议态(本 spec 钉死的契约);「v0.1.1」/「v0.1」出现在历史标注里,指过往版本。

HOLP 是 **consumer**(终端 / 工具 / APP——cmux、Warp、happier、CLI)与 **orchestrator**(编排器——HOLP 参考 daemon 或任何实现)之间的那根线。consumer 声明「我有一窝异构 agent」,发起编排目标,orchestrator 派单并流式回吐事件;需要人拍板时,人在回路上介入——**Human on Loop**。

---

## 1. 传输与编码

> v0.1.1 钉死:v0.1 同时声称「JSON-RPC request/response」「notification」「连续 response chunk」,自相矛盾(JSON-RPC 2.0 无连续 chunk 语义)。v0.1.1 拆成**两个面**。

**两个传输面**:

- **控制面**:stdio 上的 **JSON-RPC 2.0**。client→server 的方法调用(`initialize` / `flock.*` / `orchestrate.run` / `events.subscribe` / `events.unsubscribe` / `approval.resolve` / `task.cancel`)走标准 request/response(带 `id`)。能力协商、错误码、取消都在这里。
- **事件面**:server→client 的**事件流**,用 JSON-RPC **notification**(无 `id`),但**每条都带 `subscription_id`** 绑定到订阅(见 §5)。事件面不是「JSON-RPC 连续 chunk」,是「带订阅归属的 notification 流」。

**编码**:newline-delimited JSON,每行一个对象(与 cmux `events.stream` 的 JSON-line 实践一致,来源 cmux `CmuxEventStream.swift`)。

> 未来可选 WebSocket 传输(给 Web/远程 APP),v0.1.x 只 stdio。

**明确不是**:事件不是「某个 long-running request 的连续 response」。`events.subscribe` 是普通 request(立即返回 `subscription_id`),事件是独立的、带 `subscription_id` 的 notification。这让多订阅、取消、错误归属都有干净语义。

---

## 2. 握手:`initialize` + 能力协商

client 连上后第一条。双方报身份与**细粒度能力**。v0.1.x:每个 capability 是一个 **descriptor** `{ supported, required?, kinds? }`(codex 新P0-3:v0.1.1 只用布尔/kind 列表,server 无法区分「client 不能处理」vs「client 能忽略」,required/optional 是口号)。descriptor 语义:
- `supported`:本端是否支持该能力。
- `required`:本端是否**硬要求**对方支持(缺则拒绝 run / 拒绝连接)。缺省 false。
- `kinds`(仅 approval):本端支持/要求的 kind 子集。

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
    "protocol_version": "0.1.x"
  }
}
```

**Response**(server→client):
```jsonc
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "server": { "name": "holp-reference-daemon", "version": "0.1.x" },
    "capabilities": {
      "consensus":    { "supported": true },
      "approval":     { "supported": true, "kinds": ["merge_approval","force_push_approval","budget_exceeded"] },
      "unattended_loop": { "supported": true },
      "artifact_refs":{ "supported": true }
    },
    "protocol_version": "0.1.x"
  }
}
```

**能力协商规则**(v0.1.x 钉死,取代 v0.1.1 的布尔语义):
- 协商 = 双方 descriptor 的交集:`effective.cap = client.cap.supported && server.cap.supported`。
- **`required` 的 scope(codex 第三轮 P1)**:`initialize.capabilities.*.required:true` 一律是**连接级**——缺则 `initialize` 拒绝(`capability_required_but_unsupported`)。**run 级硬要求不放 descriptor**,放 `orchestrate.run` params(如 `roles.reviewer` 隐含要求 consensus);run 受理时若需要的能力不可用 → 受理前 reject(同 error code)。这样 descriptor 的 required 语义单一(连接级),不二义。
- **缺省 capability**(descriptor 未出现):视为 `{supported:false}`(保守;不支持)。client 不在某 capability 显式声明,server 当作不支持。
- `consensus` 不可用 → server 不发 `consensus_verdict`,run 退化为单 agent(或 client 在 `orchestrate.run` 显式接受无共识)。
- `approval` 不可用 → server 不得发起会触发 approval 的 run;若 run 的 unattended_policy.require_human_gates 非空且 client 不支持 approval → 受理前 reject(`approval_required_but_unsupported`)。
- `approval.kinds`:取交集;**双方都 required 但 kinds 空交集** → `initialize` 拒绝(required 没法满足);非 required 但空交集 → run 触发该 kind 时按 §7/§11 降级或 escalate。
- `artifact_refs` 不可用 → server 不得发 artifact ref(大 payload 内联截断)。

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
      "reason": "acp adapter not wired in v0.1.x", "missing": ["adapter:acp"] }
  ]
} }
```

`status`:`ready` | `degraded`(部分能力可用)| `rejected`(不可调度,带 `reason`+`missing`)。

> **部分成功语义**:`flock.declare`/`flock.discover` **永远返回 per-agent status,不抛 JSON-RPC error**(哪怕全部 rejected)。`unsupported_transport`/`missing_auth` 作为 per-agent `status=rejected` 的 `reason`,不是 error。只有请求格式非法才 error。见 §10.1。

> v0.1.x 参考实现:`native-claude`/`mcp-codex` adapter **目前是桩**(见 §12),故 declare/discover 的实测 status 在真接线前多为 `rejected`。**不冒充已接通**(守规:stub 不假装能 spawn)。

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

> v0.1.x 逼到可执行(codex P1-5/新P1-3):v0.1.1 留了 `{kind:"Remote", remote:{opaque}}` 半截占位,又说没做,边界模糊。v0.1.x **彻底删掉 Remote**——wire 里只有 `Local`。Remote 整个(workspace sync / secret scope / artifact transport / network / cost / identity)在独立扩展 proposal 一次性定义,**v0.1.x 不留任何 Remote 形状**(不留 opaque 占位、不出现 `kind:"Remote"`),避免「定义了又没做」的歧义。

```jsonc
"execution_mode": { "kind": "Local" }   // v0.1.x 唯一合法值
```

- `kind` 唯一合法值:`"Local"`。其他值 → error `unsupported_execution_mode`(见 §10)。
- Remote 未来对位 spawn agent×cloud、skypilot 调度,**不进 v0.1.x wire**;届时作为新协议 minor(带 capability 协商 `remote_runner`)引入,consumer 按 §2 descriptor 协商是否启用。

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
- `approval`:`approval_requested`/`approval_resolved`/`approval_expired`/`approval_cancelled`(见 §7,**单通道状态机**,每态一事件)
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

**分层**(v0.1.1 修复 P2-2):
- `outcome`:聚合裁决(单一枚举)。
- `reviews[]`:每家评审结果 + `status`(completed/timeout/error/abstain)+ `findings`(artifact envelope,evidence 走 §8)。
- `quorum`:显式 `{required, eligible, met}`——`eligible` = 排除作者后的可投票家数。
- `errors[]`:失败/超时/弃权的评审(quorum 只统计 `eligible && status==completed`)。

### 6.2 可满足性校验(两段式)

> codex 新P0-1:v0.1.1 要求在 `orchestrate.run` **受理前**校验「排除作者后 eligible ≥ quorum」,但受理时 coder 还没干活、artifact/作者还没产出——校验时机根本错(多 artifact、多 coder、修复后再 review 直接卡住)。v0.1.x 改两段式。

**第 1 段:静态形状校验(`orchestrate.run` 受理时,无作者信息)**
- 校验 panel 的**形状**(不是可满足性):`panel` 中 enabled 且 capability 可用、status=ready 的 agent 数 ≥ quorum。
- v0.1.3 修正:不在第 1 段预留「作者余量」——作者是否在 reviewer panel 未知,且作者可能根本不在 panel(如 coder=codex、reviewer panel=[claude,gemini])。预留余量的公式会误杀合法配置(原 `≥quorum+1` 会判本 spec 示例失败)。作者命中 panel 的动态不足,交给第 2 段。
- 不满足(形状就不够)→ error `quorum_unsatisfiable`(见 §10)。

**第 2 段:精确 quorum 校验(consensus step 开始前,作者已确定)**
- 此时被评审 artifact 的 `produced_by_agent_id` 已知 → 计算 `eligible = panel 中 ≠ 作者 的 agent 数`。
- `eligible ≥ quorum` → 正常跑共识。
- `eligible < quorum` → 按 `policy.on_quorum_unsatisfiable`:`ask_human`(escalate,发 `consensus_degraded` 事件)| `degrade_quorum`(降到 eligible,发 `consensus_degraded`)| `reject`(该步失败,run 按 unattended policy 处置)。
- **绝不产出 `quorum.met:false` 的正常 verdict**;`met:false` 只出现在降级/escalate,且 `outcome` 必为 `ask_human` 或配 `consensus_degraded`。

两段式的好处:受理时挡死配置(早失败),consensus 前挡动态不足(作者已定时)。

> **错误码定序**(codex 第三轮 P1):`invalid_quorum`(§10)管**形状/引用合法性**——quorum≤0、quorum>panel 规模、panel 空、panel 含 unknown/rejected agent。`quorum_unsatisfiable`(§10)管**策略性不足**——形状合法但排除作者后不够。**同一次校验先 `invalid_quorum`(形状),再 `quorum_unsatisfiable`(策略)**,二者不重叠。

### 6.3 作者身份(provenance,不是 wire 业务概念)

> v0.1.1 修复 P0-5:v0.1 把 `author` 裸布尔塞进 wire 层,但没定义来源。

wire 层只表达**provenance**:`target.produced_by_agent_id` / `target.artifact_id`。「排除作者」是 `policy.exclude_author` + `policy.author_provenance` 决定的 orchestrator 行为,wire 不假设「author」是单一全局身份——多步骤 run 不同 artifact 可能有不同 producer。

---

## 7. 人工介入(approval):单通道状态机

> v0.1.1 修复 P0-6:v0.1 的 approval 既是 §5 事件(`approval_needed`)又是 §7 独立 notification(`approval.request`),双通道竞争、会重复发。v0.1.1 统一为**单通道 + 状态机**。

**approval 只走事件流一种通道**:`approval_requested` / `approval_resolved` 都是 `events.event`(category=approval)。**不再有独立 `approval.request` notification。**

**状态机(每个 approval 一个)**:`requested → resolved | expired | cancelled`。每个状态转移都有一条**对应事件**,consumer 据此一致更新 UI/状态(codex 新P0-2:v0.1.1 只有 requested/resolved 事件,expired/cancelled 没上 wire)。

终态事件 name:`approval_resolved`(人决定)| `approval_expired`(超时)| `approval_cancelled`(run 被取消导致)。三条事件的 payload 用**统一的 `state` 字段**区分。

> v0.1.3 修正(codex 第三轮 P1):v0.1.2 说 approval_cancelled 可由 client/server 主动取消,但控制面没 `approval.cancel` 方法。v0.1.3 **规定:client 不能单独取消 approval——approval 取消只由 `task.cancel`(取消整个 run,§8)导致**。没有 `approval.cancel` 方法。要中止 approval 的唯一途径是 `task.cancel` 该 run,server 随后对所有 pending approval 发 `approval_cancelled`。这避免「client 取消 approval 但 run 还在跑」的不一致。

需要人拍板时(server→client,请求态):
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

人决定后(client→server,**普通 request**):
```jsonc
{ "jsonrpc": "2.0", "id": 6, "method": "approval.resolve",
  "params": { "approval_id": "ap_1", "decision": "approved", "by": "user:tizer" } }
```

server 回执 + 发终态事件(三条终态共享 payload 形状,`state` 区分):
```jsonc
{ "jsonrpc": "2.0", "id": 6, "result": { "approval_id": "ap_1", "accepted": true } }
// 随后在事件流(人批准):
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

终态 payload 必有:`approval_id`、`state`(`resolved`|`expired`|`cancelled`)、`reason`。`state=resolved` 额外带 `decision`(`approved`|`rejected`)、`by`。race 处理(codex 第三轮):client resolve 与 server 超时/cancel 并发时,**先到者赢,后到者收 `approval_already_resolved` error**(§10)。

`approval.resolve` 对已处终态的 approval → error `approval_already_resolved`(§10)。

`kind`:`merge_approval`|`force_push_approval`|`semantic_decision`|`low_confidence`|`budget_exceeded`(来源 loopwright `ESCALATION_KIND`)。

**能力匹配**(见 §2 descriptor 协商):
- `approval` 不可用 → server 不得发起会触发 approval 的 run(受理前 reject `approval_required_but_unsupported`)。
- 某 `kind` 不在交集 → 按 §11 unattended policy 处置(escalate / 超时默认 / 拒绝),**不静默继续**。
- `expires_at`:超时未 resolve → server 发 `approval_expired`,按 policy(默认 escalate 或拒绝该步)决定 run 后续。

> awaiting_approval 的内部状态机迁移(旧 loopwright #11 强阻塞)是参考实现的事,不影响协议定义。

---

## 7.5 取消 run:`task.cancel`

> codex 第三轮 P1:§1 把 `task.cancel` 列为控制面方法,但没 schema。v0.1.3 补完。这是取消 approval 的唯一途径(见 §7 v0.1.3 修正)。

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

> v0.1.x 逼到可执行(codex 新P1-1/P2-2/P2-4):v0.1.1 的 `findings_ref`/`details_ref` 是裸字符串,事件里又不带 envelope,`artifact.get` response 没 content schema、无错误码——闭环断了。v0.1.x 钉死:**所有 ref 必须是 artifact_id(字符串),事件里 ref 处必须带完整 envelope,§8 闭环。**

### 8.1 envelope(事件 ref 处必带)

```jsonc
{ "artifact_id": "art_diff_1", "type": "diff", "mime": "text/x-diff",
  "size": 4523, "sha256": "abc...", "created_by": "codex", "created_at": 1718600000,
  "expires_at": 1718610000 }
```

**规则**:事件 payload 里凡 ref(findings_ref / details_ref / artifact_id),**该位置放完整 envelope**(不是裸字符串),consumer 无需二次请求即可知类型/大小/hash。`artifact_id` 是全局唯一 id。

### 8.2 `artifact.get`

```jsonc
{ "jsonrpc": "2.0", "id": 7, "method": "artifact.get",
  "params": { "artifact_id": "art_diff_1" } }
```
**Response**(v0.1.3:**永远返回 `content`,不返回 `content_ref`**):
```jsonc
{ "jsonrpc": "2.0", "id": 7, "result": {
  "artifact_id": "art_diff_1", "envelope": { /* §8.1 全字段 */ },
  "content": "diff --git a/...",
  "truncated": false,
  "truncated_at": 65536                         // 仅 truncated:true 时有,截断字节数
} }
```

> v0.1.3 修正(codex 第三轮 P0):v0.1.2 对大 artifact 返回 `content_ref: holp-art://...?token=`,但 stdio 协议没有该 ref 的可执行读取通道、token 验证也推到 v0.2——consumer 拿到 ref 无法实现读取。**v0.1.3 禁用 `content_ref`,强制 `artifact.get` 总返回 `content`**(可能是截断的字符串)。`envelope.size` 是真实大小,`truncated:true` + `truncated_at` 表示返回的 content 被截断;consumer 需要 full content 时,大 artifact 的分块读取通道(`artifact.read(offset,len)`)留 v0.2 协议。**这保证 v0.1.x 的 artifact 链路完全可执行**(小/中 artifact 全量返回,超大 artifact 截断但 consumer 知道被截)。

**`content` 编码**:`string`(utf-8 文本:diff/findings/json)。二进制 artifact(mime 非 text)→ base64 编码进 `content` + `envelope.mime` 标明。v0.1.x 不支持流式。

**错误**(见 §10):`artifact_not_found` / `artifact_expired` / `artifact_forbidden`。

### 8.3 保留

envelope 带 `expires_at`(可选);server 可清理过期;`artifact.get` 过期 → `artifact_expired`。v0.1.x 最小:type/mime/size/sha256/created_by/expires_at + get + 三错误码;细粒度权限/token scheme 进 v0.2。

---

## 9. 版本化与能力降级

> v0.1.1 重写(codex P0-7):v0.1 说「minor 加新事件 name,旧 consumer 忽略即可」,但事件 name 是行为语义(如需停机等待的 approval kind),忽略可能致 run 卡死/危险操作无人处理。

- 协议版本在 `initialize` 协商;major 不匹配 → 拒绝(`protocol_version_mismatch`,见 §10)。
- **能力按 feature 细分 + descriptor `{supported, required?, kinds?}`**(见 §2):`consensus` / `approval` / `unattended_loop` / `artifact_refs`。server 在 `initialize` 后**明确知道**:哪些行为可发、哪些 run 必须拒绝。(Remote 没有对应 capability——v0.1.x wire 不含 Remote,见 §4.1;未来引入时再加 `remote_runner` descriptor。)
- **最小 consumer**:§2 initialize + §3 flock + §4 orchestrate.run + §5 events.subscribe。不支持 consensus/approval/artifact → server 按能力降级或拒绝相关 run,**不靠「忽略未知事件」兜底**。
- 演进只增不破(minor 加可选字段/方法/事件 name,且该 name 必须是「旧 consumer 忽略安全」的——即非阻塞性、非语义关键);破坏性 bump major。

---

## 10. 错误模型

> v0.1.x 完整化(codex P2-5 + 新P1-2 + 新P2-3):v0.1.1 只有少量 code、多个错误名共用一个 code、缺 flock partial failure / artifact / execution_mode 等。v0.1.x 拆开共用 code、补齐、并定义 flock 部分成功语义。

JSON-RPC error object:`{ "code": <int>, "message": <string>, "data": {...} }`。HOLP 错误 code 用区间 `-32000 ~ -32099`(JSON-RPC 保留段)。**一错误一 code,不共用**(机器处理无需 parse message)。

| code | 名称 | 触发 |
|---|---|---|
| -32001 | `protocol_version_mismatch` | initialize 版本协商失败 |
| -32002 | `capability_required_but_unsupported` | 某 capability 一方 required 但对方 supported:false(连接级或 run 级) |
| -32003 | `approval_required_but_unsupported` | run 会触发 approval 但 client `approval.supported:false` |
| -32004 | `quorum_unsatisfiable` | 两段式校验(§6.2)不满足且 policy=reject |
| -32005 | `unsupported_transport` | flock 某 agent transport 无 adapter(per-agent status 或 error,见下) |
| -32006 | `missing_auth` | agent 凭证探测失败(可重试:可能刚登录) |
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

### 10.1 flock 部分成功语义(codex 新P1-2)

> v0.1.1 的 `unsupported_transport`/`missing_auth` 既出现在 §3 per-agent `status` 又出现在 §10 error,实现者不知道 flock.declare 是整体失败还是部分成功。v0.1.x 钉死:

**`flock.declare` / `flock.discover` 永远是「部分成功」语义**——返回值是 per-agent `agents[]`(每个带 status:ready/degraded/rejected + reason + missing),**不抛 JSON-RPC error**,哪怕全部 rejected。
- `unsupported_transport` / `missing_auth` 作为 **per-agent `status=rejected` 的 `reason`**(在 response 里),不是 JSON-RPC error。
- 仅当请求本身格式非法(无 agents 字段、transport 非法字符串)才抛 JSON-RPC error(`invalid_request`,JSON-RPC 标准 -32600)。
- `orchestrate.run` 受理时,若该 run 需要的 agent 全是 rejected status → error `unsupported_transport` 或 `missing_auth`(此时才是 JSON-RPC error,因为 run 无法进行)。

事件流错误:`slow_consumer`(§5,关订阅,非 JSON-RPC error)。

---

## 11. Unattended Policy(Human-on-Loop 落地)

> v0.1.1 新增(codex P1-6):v0.1 把「Human on Loop」当产品立场,但协议没有无人值守的可执行语义。

> ⚠️ **v0.1.2 诚实标注(codex 新P1-4)**:本节的 `gate` 概念(`auto_pass_gates`/`require_human_gates`)在协议层**尚未定义** gate object/gate event/gate outcome。v0.1.2 的 gate 列表值(`lint`/`test`/`build`/`merge_approval`)当前是 **daemon 私约定字符串**,consumer 无法可靠解析。**v0.2 会定义 gate 协议**(gate 种类、gate 通过/失败事件、gate→approval kind 映射)。v0.1.x 阶段:policy 字段可传,但 consumer 应把 gate 列表当不透明、只依赖 `on_approval_timeout`/`on_capability_gap`/`max_unattended_steps` 这几个已定义字段。

`orchestrate.run` 可带 `unattended_policy`(缺省值由 server 配置):
```jsonc
"unattended_policy": {
  "auto_pass_gates": ["lint","test","build"],          // v0.1.x:daemon 私约定字符串;v0.2 定义 gate 协议
  "require_human_gates": ["merge_approval"],           // 同上;且这些必须 approval(走 §7)
  "on_approval_timeout": "escalate",                   // 已定义:escalate | auto_reject | auto_approve(危险,默认禁用)
  "on_capability_gap": "reject_run",                   // 已定义:reject_run | degrade
  "max_unattended_steps": 50                           // 已定义
}
```

- 已定义可依赖字段:`on_approval_timeout`、`on_capability_gap`、`max_unattended_steps`。
- approval 超时 → `on_approval_timeout`(默认 `escalate`,**`auto_approve` 必须显式开启且 server 可拒绝**)→ 配合 §7 `approval_expired` 事件。
- client 能力缺口 → `on_capability_gap`(配 §2 descriptor 协商)。
- gate 相关字段(`auto_pass_gates`/`require_human_gates`)→ v0.1.x 私约定,v0.2 协议化。
- 名字「Human on Loop」= 这些 policy 的默认立场:**默认尽量自动、只在 require_human 打断**。

---

## 12. v0.1.x 实现边界(参考 daemon)

> v0.1.x 修复 P2-3:v0.1 的 spec/version/README 对「v0.1 做了什么」自相矛盾(spec 说做 native-claude+mcp-codex,registry 明说全是桩)。v0.1.x 分清 **protocol draft** 和 **daemon milestone**。

**协议层(protocol draft v0.1.x)**:本 spec 全部章节有定义(含 capability descriptor / error / artifact / policy)。

**参考 daemon milestone(当前)**:
- ✅ 协议接入骨架(控制面 JSON-RPC + 事件 subscription)。
- ✅ adapter **契约 + 桩**(registry 三 transport 全桩,**明示未接 agent**)。
- ✅ 从旧 loopwright 搬入:治理内核 / 数据铁三角 / 共识 / 状态机(进行中)。
- ❌ **未做(不声称已做)**:native-claude / mcp-codex 真接线(待 adapter 真实现 / 接 happier 方言库);acp;Web 传输;Remote(v0.1.x wire 不含 Remote,见 §4.1)。

**当前仓不得声称**「已接 native-claude/mcp-codex」——只能声称「adapter contract stub + 协议 draft」。真接线前的 declare/discover 实测 status 多为 `rejected`(adapter 未接线)。

### 12.1 adapter 实现约束(codex P1-3/P1-4)

> v0.1.x 落到实现约束(adapter 契约文件同步,见 `adapters/agent-backend.ts`):
- **并发 session 归属**:一个 backend 实例**只允许一个 session**(v0.1.x 简化);若未来要多 session,`AgentMessage` 必须带 `sessionId/run_id/step_id`,handler 按 session 订阅。
- **permission 可恢复**:`PermissionHandler` 返回 `ask_human` 时,带 `request_id`/`call_id`(单 session 约束下 session_id 冗余,故不带——与 adapter 类型一致);`approval.resolve` 后 daemon 调 `resolvePermission(request_id, decision)` 让 adapter resume/deny 原始 tool call(对应 §7 approval)。
- **命名一致性**:adapter 注释/报错/文档统一用 v0.1.x 命名(`events.subscribe`/`approval_requested`/`consensus_verdict`),不得残留 v0.1 的 `events.stream`/`approval.request`/`consensus.verdict`。

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

---

## v0.1.1 → v0.1.2 变更明细(把「表面改」逼到可执行)

> 第二轮 codex review 判 v0.1.1「16/19 表面改 + 3 个新 P0」,不值得写实现。v0.1.2 逐条逼到可执行状态机/wire schema,或彻底删除。

**3 个新 P0 修成可执行**:
1. §6.2 quorum 校验改**两段式**(codex 新P0-1):run 受理时只做「静态上界」(panel 规模 ≥ quorum+1),真正「排除作者后 eligible ≥ quorum」在 consensus step 前(作者已确定)校验——修掉 v0.1.1「受理时校验但作者还没产出」的时机错。
2. §7 approval **终态全上 wire**(codex 新P0-2):加 `approval_expired`/`approval_cancelled` 事件,三条终态共享 payload 用 `state` 字段区分;`approval_already_resolved` 成独立错误码。
3. §2 capability **descriptor `{supported, required?, kinds?}`**(codex 新P0-3):取代布尔/kind 列表;required 让 server 能区分「client 不能处理」vs「能忽略」。

**「表面改」逼到可执行**:
- §4.1 **Remote 彻底删**(codex P1-5/新P1-3):v0.1.1 留了 opaque 半截占位又说没做。v0.1.2 wire 里只有 `Local`,其他 kind → error `unsupported_execution_mode`;remote_runner capability 一并删。Remote 未来作为新 minor + capability 引入。
- §8 **artifact 闭环**(codex 新P1-1/P2-2/P2-4):ref 处必带完整 envelope(非裸字符串);`artifact.get` 定义 content vs content_ref + token;补 `artifact_not_found/expired/forbidden` 错误码。§6.1 `findings`、§7 `details` 同步成 envelope。
- §10.1 **flock 部分成功语义**(codex 新P1-2):`flock.declare/discover` 永远 per-agent status 不抛 error;`unsupported_transport/missing_auth` 是 reason 不是 error;仅 `orchestrate.run` 无法进行时才 error。

**错误模型完善**(codex P2-5/新P2-3):
- 拆开 v0.1.1 共用的 code:`approval_not_found`/`already_resolved` 拆成 -32009/-32010,`lease_stolen`/`run_locked` 拆成 -32011/-32012。一错误一 code。
- 新增:`unsupported_execution_mode`(-32013)、`artifact_not_found/expired/forbidden`(-32014/5/6)、`invalid_subscription`(-32017)。
- `invalid_quorum` 覆盖完整边界:panel 空 / 含 unknown 或 rejected agent / 全部 excluded。

**跨文件命名统一**(codex 新P2-1/P1-5 + 多处残留):
- `docs/positioning.md`:`consensus.verdict`/`approval.request`/`events.stream`/Remote 旧字段全改 v0.1.x 命名。
- `adapters/agent-backend.ts` 注释:`events.stream`→`events.subscribe`、`approval Needed`→`approval_requested`。
- `protocol/version.md`:三段 vs MAJOR.MINOR 矛盾——定义 draft 期第三段语义(draft 修订,不计入兼容性)。
- `README.md`:不再说「12 章含 lifecycle」(lifecycle 是事件 category + task.cancel,不单列章)。
- §12.1 session_id 去除(单 session 约束下冗余),与 adapter 类型对齐。

**仍未做(诚实标注,留 v0.2)**:
- unattended_policy 的 `gate` 概念仍未在协议层定义 gate object/event/outcome(codex 新P1-4)——v0.1.2 保留 policy 字段但标注「gate 列表当前是 daemon 私约定,v0.2 定义 gate 协议」。
- adapter 真接线(native-claude/mcp-codex)仍是桩。
- big artifact 的分块读取通道(`artifact.read(offset,len)`)未定义——v0.1.3 强制 `artifact.get` 返回(可截断的)content 兜底,full content 分块留 v0.2。

---

## v0.1.2 → v0.1.3 变更明细(第三轮 review 后修阻塞缺口)

> 第三轮 codex review 判 v0.1.2「yes-with-caveats,偏 no」——方向对了但有 5 个会卡实现的缺口。v0.1.3 逐条修。

1. **§6.2 quorum 第1段公式**(codex 第三轮 P0):`panel可用数 ≥ quorum+1` 误杀合法配置(作者可能不在 panel,如本 spec 示例)。改 `≥ quorum`,作者余量删;作者命中 panel 的动态不足交第2段。补错误码定序(`invalid_quorum` 形状 vs `quorum_unsatisfiable` 策略)。
2. **§8.2 artifact 强制 content**(codex 第三轮 P0):禁 `content_ref`(无读取通道),`artifact.get` 永远返回 `content`(可 `truncated`+`truncated_at`)。big artifact 分块留 v0.2。
3. **§7 approval cancel 语义**(codex 第三轮 P1):无 `approval.cancel` 方法;approval 取消只由 `task.cancel` 导致。resolved payload 补 `reason`;race「先终态者赢」。
4. **§7.5 `task.cancel` 补完整 schema**(codex 第三轮 P1):request/response、幂等、`run_not_found`、终态事件、race。
5. **§2 capability `required` scope**(codex 第三轮 P1):`initialize.capabilities.*.required` 一律连接级;run 级要求走 params。缺省 capability = 不支持。kinds 空交集语义钉死。
6. **跨文件一致性**(codex 第三轮):version.md/README/adapter 注释/registry 全部对齐 v0.1.x 当前态(修掉 version.md 仍写 v0.1.1、Remote opaque 旧态残留等)。本次用脚本自查所有文件版本号一致,不再靠肉眼。

**结论**:codex 第三轮判 v0.1.2「值得开写协议骨架 + 契约测试」。v0.1.3 修完阻塞缺口后,**进入实现阶段**(协议骨架 + 最小 daemon/consumer + 契约测试),用实现倒逼剩余的缝(v0.2:gate 协议、big artifact 分块、adapter 真接线)。
