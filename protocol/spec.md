# HOLP — Human On Loop Protocol

> **版本**:v0.1.8 (draft)
> **状态**:草稿,参考实现进行中
> **定位**:见 `docs/positioning.md`。开源、免费、本地优先的 multi-agent 编排协议。

HOLP 是 **consumer**(终端 / 工具 / APP——cmux、Warp、happier、CLI)与 **orchestrator**(编排器——HOLP 参考 daemon 或任何实现)之间的那根线。consumer 声明「我有一窝异构 agent」,发起编排目标,orchestrator 派单并流式回吐事件;需要人拍板时,人在回路上介入——**Human on Loop**。

设计来源(概念启发,非直接对位/搬运):events 订阅启发自 cmux `CmuxEventBus`(HOLP 的 subscribe+notification 是新协议设计);flock/orchestrate 启发自 Oz proto 概念(不抄依赖、不实现服务端);consensus 启发自 loopwright 共识评审的聚合策略(wire 结构是 HOLP 新设计);朝下 adapter 契约启发自 happier `AgentBackend` 形状(接入需 wrapper,非直接复用)。逐条对位与诚实表述见 `docs/positioning.md`。

---

## 1. 传输与编码

**两个传输面**:

- **控制面**:stdio 上的 **JSON-RPC 2.0**。client→server 方法调用走标准 request/response(带 `id`):`initialize` / `flock.*` / `orchestrate.run` / `events.subscribe` / `events.unsubscribe` / `approval.resolve` / `task.cancel` / `artifact.get`。
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
      "artifact_refs":{ "supported": true },
      "gate_report":  { "supported": true },
      "dynamic_workflow": { "supported": true }
    },
    "protocol_version": "0.1.8"
  }
}
```

**Response**(server→client):
```jsonc
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "server": { "name": "holp-reference-daemon", "version": "0.1.8" },
    "capabilities": {
      "consensus":    { "supported": true },
      "approval":     { "supported": true, "kinds": ["merge_approval","force_push_approval","budget_exceeded"] },
      "unattended_loop": { "supported": true },
      "artifact_refs":{ "supported": true },
      "gate_report":  { "supported": true },
      "dynamic_workflow": { "supported": true }
    },
    "protocol_version": "0.1.8"
  }
}
```

**能力协商规则**:
- 协商 = 双方 descriptor 的交集:`effective.cap = client.cap.supported && server.cap.supported`。
- 任一方 `required:true` 但对方 `supported:false` → `initialize` 拒绝(`capability_required_but_unsupported`)。
- `consensus` 不可用 → server 不发 `consensus_verdict`,run 退化为单 agent(或 client 在 `orchestrate.run` 显式接受无共识)。
- `approval` 不可用 → server 不得发起会触发 approval 的 run;若 run 的 unattended_policy.require_human_gates 非空且 client 不支持 approval → 受理前 reject(`approval_required_but_unsupported`)。
- `approval.kinds` 取交集;**任一方 `approval.required:true` 且 kinds 交集为空** → `initialize` 拒绝;**双方都非 required 但 kinds 空交集** → 不拒绝连接,run 触发该 kind 时按 §7/§11 降级或 escalate。
- `artifact_refs` 不可用 → server 不得用 artifact envelope 承载**大 payload/evidence**;凡 spec 中放 evidence envelope 的位置(consensus `reviews[].findings`、approval `details`)改放**内联降级形态**(见 §6.1、§7)。`artifact_refs` 不控制 provenance/identity 字段里的裸 `artifact_id`(如 `target.artifact_id`、`provenance.artifact_id`),这些 id 只是关联已知产物,不要求 consumer 再取大 payload。
- `gate_report` 不可用 → server **不得**发 `gate.gate_report`。旧 consumer 继续只收 `consensus_*` / `approval_*` / `run_*` 事件。
- `dynamic_workflow` 不可用 → server **不得**发 `workflow_revised` / `workflow_revision_rejected` lifecycle events。L0/M7 `workflow_selected` / `workflow_step_planned` / `workflow_step_completed` 仍是旧 consumer 可忽略的 lifecycle events。

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

字段:`id`(开放字符串,运行时校验)/ `transport`(`native-claude`|`mcp-codex`|`acp`|`learned-router`|自定义)/ `roles`(architect/reviewer/coder/tester/test_audit/test_strengthen/work_planner)/ `auth_ref`(凭证引用,**不传明文**:`env:XXX`|`login:agent`|`secret:name`)/ `enabled`。

`learned-router` transport 只能声明 `work_planner` role。`work_planner` 是 planner-only role:它只能通过 `orchestrate.run.planner` 参与 WorkPlanner 决策,不得作为 `roles.coder` / `roles.reviewer` / `roles.tester` 等 executor role 使用。任何把 `work_planner` 或 `learned-router` agent 放入 executor role graph 的请求,必须在 runtime selection 前 fail-closed 为 `role_unsupported`。

### 3.2 `flock.discover`(pull:让 orchestrator 主动发现本地 agent)

consumer 不知道每家的真实安装路径/登录/版本时,可让 orchestrator 自己探。

```jsonc
{ "jsonrpc": "2.0", "id": 3, "method": "flock.discover",
  "params": { "transports": ["acp"], "probe": true } }
```

**Response**(同 §3.3 部分成功语义,per-agent status):探测到 `gemini` 走 acp,凭证/版本部分可用,故 `degraded`;其 `resolved_roles` 含 `reviewer`(reviewer 角色可用),`missing` 不含 reviewer 相关——因此可合法进入 §4 的 reviewer panel。
```jsonc
{ "jsonrpc": "2.0", "id": 3, "result": {
  "agents": [
    { "id": "gemini", "transport": "acp", "status": "degraded",
      "version": "0.3.0", "logged_in": true, "resolved_roles": ["reviewer"],
      "missing": ["role:coder"] }
  ]
} }
```

### 3.3 Response:返回**可执行能力**,不是照单全收

orchestrator 对每个声明/发现的 agent 返回实测能力——版本、登录状态、缺失凭证。声明只是 intent,实测才是可调度依据。

这是 §3.1 那条 `flock.declare`(id:2)的真实回执——返回 request 里声明的同两个 agent `claude` + `codex` 的实测能力,不返回未声明的 agent。
```jsonc
{ "jsonrpc": "2.0", "id": 2, "result": {
  "agents": [
    { "id": "claude", "transport": "native-claude", "status": "ready",
      "version": "1.0.0", "logged_in": true, "resolved_roles": ["architect","reviewer","coder","tester"] },
    { "id": "codex", "transport": "mcp-codex", "status": "degraded",
      "version": "0.21.0", "logged_in": true, "resolved_roles": ["coder","reviewer","tester"],
      "missing": ["role:architect"] }
  ]
} }
```

`status`:`ready` | `degraded`(部分能力可用)| `rejected`(不可调度,带 `reason`+`missing`)。

**部分成功语义**:`flock.declare`/`flock.discover` **永远返回 per-agent status,不抛 JSON-RPC error**(哪怕全部 rejected)。`unsupported_transport`/`missing_auth` 作为 per-agent `status=rejected` 的 `reason`,不是 error。只有请求格式非法才 error。见 §10.1。

> 参考实现:`mcp-codex` 已接 Codex app-server over stdio;`native-claude` 已接 Claude Code headless reviewer partial;`acp` 仍是桩(见 §12),故未接线 transport 的 declare/discover 实测 status 多为 `rejected`。

### 3.4 Harness runtime surface + isolation readiness matrix

从 v0.1.5 draft 起,`transport/status/resolved_roles` 不是完整可调度能力模型。一个 agent 只有在**声明过的 runtime surface + isolation profile** 下为 `ready` 或被 policy 接受的 `degraded` 时,才可被调度。

**必备语义**:每个 flock agent 的 declare/discover 结果必须能表达以下矩阵,即使当前实现只能返回 `unknown`/`unsupported`/`rejected`。空白不是合格声明。

- `runtime_surface`:`headless` | `acp` | `direct_user_session`。
- `runtime_kind`:具体接入形态,如 `cli`、`app_server`、`acp`、`mcp`、`product_session`、`pty`、`tmux`、`terminal_app`、`hook_router`。
- `actual_fidelity`:`one_shot` | `streaming_controlled`。该字段由实际 backend/runtime kind 决定,不是由 surface 名字推断。one-shot CLI/print-json 路径必须声明 `one_shot`;能中途转发 updates、permission/cancel、terminal 的 app-server/ACP/direct control path 才能声明 `streaming_controlled`。
- `surface_support`:`supported` | `experimental` | `unsupported` | `unknown`。
- `isolation_profiles`:按 profile 返回 readiness,profile 至少覆盖 `read_only_review`、`coder_worktree`、`real_provider_smoke`、`multi_agent_concurrent`、`user_global_install`、`high_isolation`。
- `readiness`:`ready` | `degraded` | `rejected`,带 `reason`、`missing`、`warnings`。
- `direct_channel`:仅当 `runtime_surface=direct_user_session` 时出现,声明 `channel_type`(`product_session`/`pty`/`tmux`/`terminal_app`)、`attach`、`observe`、`read`、`inject`、`interrupt`、`cancel`、`owner_scope`。`attach`/`observe`/`read` 属 observation surface;`inject`/`interrupt`/`cancel` 属 control surface,不能合并成一个 ready 标记。
- `state_declaration_ref`:指向该 harness 的 config/auth/session/cache/log/hook/router/plugin/db 声明。
- `global_mutation_required`:本 runtime/profile 是否需要写用户全局 hook/config/plugin/router/db。
- `declared_not_enforced`:当前实现只记录声明矩阵、尚未强制 OS/provider/read-only 隔离时必须为 `true`;consumer 不能把该字段误读成真实 sandbox 已生效。

M4a 内部 governance registry 还预留 `permission_surface` / `observability_surface` 列;当前参考 daemon 统一记录为 `unknown`,直到后续 adapter/governance PR 提供真实声明来源。

默认 role → profile 映射:`coder` 使用 `coder_worktree`;`architect` / `reviewer` / `tester` 以及其他只读审查类 role 使用 `read_only_review`。缺失 declaration 必须 fail-closed 为 `rejected` 或 run 受理错误,不能靠旧 `status:ready` 默认放行。

示例(省略与 §3.3 重复的基础字段):

```jsonc
{
  "id": "codex",
  "transport": "mcp-codex",
  "status": "ready",
  "runtime_surfaces": [
    {
      "runtime_surface": "headless",
      "runtime_kind": "app_server",
      "actual_fidelity": "streaming_controlled",
      "surface_support": "supported",
      "isolation_profiles": {
        "coder_worktree": { "readiness": "ready" },
        "real_provider_smoke": { "readiness": "ready", "warnings": ["inherits:network", "inherits:provider_quota"] },
        "high_isolation": { "readiness": "degraded", "missing": ["full_env_filter", "keychain_isolation"] }
      },
      "state_declaration_ref": "harness-state:codex",
      "global_mutation_required": false,
      "declared_not_enforced": true
    },
    {
      "runtime_surface": "direct_user_session",
      "runtime_kind": "tmux",
      "actual_fidelity": "streaming_controlled",
      "surface_support": "unknown",
      "isolation_profiles": {
        "multi_agent_concurrent": { "readiness": "rejected", "reason": "route_not_declared" }
      },
      "direct_channel": {
        "channel_type": "tmux",
        "attach": "unknown",
        "observe": "unknown",
        "read": "unknown",
        "inject": "unknown",
        "interrupt": "unknown",
        "cancel": "unknown",
        "owner_scope": "unknown"
      },
      "global_mutation_required": false,
      "declared_not_enforced": true
    }
  ]
}
```

`direct_user_session` 不是普通 backend adapter 自动具备的能力。Happy/Happier 这类 product session,以及 Warp/cmux/tmux 这类 terminal session,必须显式声明 direct channel 能力和隔离边界。若 route/session/owner 不可信,默认 `rejected` 或 fail-closed。`attach`/`observe`/`read` 只能证明可连接或可看见 output stream / transcript;没有可信 `inject`/`interrupt`/`cancel`/`owner_scope` 时,不得声明可注入调度 ready,也不能把可观察 transcript 当成可 approval resume。

---

## 4. 发起编排:`orchestrate.run`

**Request**:
```jsonc
{ "jsonrpc": "2.0", "id": 4, "method": "orchestrate.run",
  "params": {
    "goal": "Fix the flaky test in tests/foo.test.ts",
    "trigger": "issue:42",
    "roles": {
      "coder":    { "agent": "codex", "preferred_runtime_surface": "headless" },
      "reviewer": { "panel": ["claude", "gemini"], "quorum": 2, "preferred_runtime_surface": "acp" }
    },
    "execution_mode": { "kind": "Local" },
    "planner": {
      "mode": "rule"
    },
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
- `roles`:角色派单;reviewer 带 `panel`+`quorum`。**共识配置只在 `roles.reviewer` 一处**。引用的 agent id 绑定 flock(见 §4.2)。
  - `roles.<role>.preferred_runtime_surface` 可选,取值 `headless` | `acp` | `direct_user_session`。缺省保持旧 consumer 的 legacy `headless` 行为。显式请求 `acp` / `direct_user_session` 时,该 surface 的 declaration/factory 不可用必须 fail-closed,不得 fallback 到 headless。未知值为 JSON-RPC `invalid_request`。
- `execution_mode`:见 §4.1。
- `planner`:可选的 planner 选择,顶层字段,不得通过 `roles` 表达。`mode` 取值:`rule` | `learned_shadow` | `learned_active` | `canary`;可选 `agent` 引用一个 flock 中已声明的 `learned-router` / `work_planner`;可选 `evidence_id`;`canary` 支持 `{seed, ratio, allowlist}`。fixture backing 只能 replay/shadow;active/canary 必须有 `real_learned_model` attestation 和 promotion evidence,否则 fail-closed 回退 `RuleWorkPlanner` 并记录 governance audit。当前参考实现只声称 fixture fail-closed safe lane,不声称 active/canary readiness。
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

### 4.2 agent 引用绑定 flock + role 校验

`roles.*.agent` / `roles.reviewer.panel[]` 里的 agent id **必须在同连接已知的 flock 集合内**——即本连接此前 `flock.declare`/`flock.discover` response 返回过的 agent。判定:

- **unknown agent**(从未在本连接 flock response 出现过的 id)→ error `agent_not_found`(§10)。
- **known 但 status=rejected**(声明/发现过但不可调度)→ 该 agent 视为不可用:用于 reviewer panel 时按 §6.2 走 `invalid_quorum`(panel 含 rejected agent);用于单点 role(coder/architect 等)时按 §10.1 走 `unsupported_transport`/`missing_auth`。
- **known 但 status=degraded**:只有当其 `resolved_roles` 含目标角色且声明/发现结果没有把该角色标为缺失时,才可用于该 role/panel;否则按 role 不匹配走 `role_unsupported`。
- **role 不匹配**:被派的 agent 其 flock response `resolved_roles` 不含该角色(如把 `resolved_roles:["coder"]` 的 agent 派为 reviewer)→ error `role_unsupported`(§10)。
- **planner-only 误用**:`roles.work_planner` 或把 `transport:"learned-router"` / `resolved_roles:["work_planner"]` 的 agent 放入 executor role → error `role_unsupported`。planner 选择只能走顶层 `orchestrate.run.planner`。

「known」以本连接 flock 状态为准——flock 是连接级会话状态,不跨连接共享。

**Response**(立即,受理):
```jsonc
{ "jsonrpc": "2.0", "id": 4, "result": { "run_id": "run_abc", "accepted": true } }
```

`orchestrate.run` 在受理前做硬校验(见 §3.4、§4.2、§6.2、§10):agent 引用合法性 + role 匹配、共识可满足性、approval 能力匹配、transport 可用,以及所需 runtime surface / isolation profile 的 readiness。校验不过 → 立即 error response,不进 run。

---

## 5. 事件订阅:`events.subscribe` / `events.unsubscribe`

形状借鉴 cmux `CmuxEventBus`(seq 单调 + replay + 心跳 + slow_consumer)。

**订阅**(client→server,普通 request):
```jsonc
{ "jsonrpc": "2.0", "id": 5, "method": "events.subscribe",
  "params": { "run_id": "run_abc", "after_seq": 0,
              "categories": ["run","agent","consensus","approval","gate","lifecycle"], "include_heartbeats": true } }
```

**`categories` 语义**:可选的**订阅白名单**。给出 → 只推列出 category 的事件;**省略或 `null` → 订阅全部 category**(不是不推)。空数组 `[]` 或含未知 category 字符串 → error `invalid_event_category`(§10)。`categories` 是**封闭枚举**,合法值:`run` | `agent` | `consensus` | `approval` | `gate` | `lifecycle`。心跳不受 `categories` 过滤,由 `include_heartbeats` 单独控制。

**`after_seq` 与 seq 起点**:seq 从 **1** 起,单调递增,run 内唯一。`after_seq:0` = 从头 replay(第一个事件 seq=1 > 0);`after_seq:N` = 只要 seq > N 的事件。新建 run 未产事件时 `latest_seq:0`(尚无 seq=0 的事件,0 是「空」哨兵)。

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

**取消订阅**(client→server,request):
```jsonc
{ "jsonrpc": "2.0", "id": 9, "method": "events.unsubscribe",
  "params": { "subscription_id": "sub_1" } }
```
**Response**(立即,确认已取消):
```jsonc
{ "jsonrpc": "2.0", "id": 9, "result": { "subscription_id": "sub_1", "unsubscribed": true } }
```
未知 `subscription_id`(从未发过或已取消)→ error `invalid_subscription`(§10)。

**背压**:消费过慢 → server 发 `events.error { subscription_id, code: "slow_consumer", latest_seq }`(普通 notification)并关该订阅。

**事件 `name` 集合**:
- `run`:`run_started`/`run_triaging`/`run_reviewing`/`run_fixing`/`run_merged`/`run_blocked`/`run_gave_up`
- `agent`:`agent_selected`/`step_started`/`tool_called`/`tool_result`/`fs_edited`/`agent_failed`
- `consensus`:`consensus_verdict`(见 §6)/`consensus_degraded`
- `approval`:`approval_requested`/`approval_resolved`/`approval_expired`/`approval_cancelled`(见 §7,单通道状态机,每态一事件)
- `gate`:`gate_report`(见 §6.4;仅在 `gate_report` capability 协商成功时发送)
- `lifecycle`:`workflow_selected`/`workflow_step_planned`/`workflow_step_completed`/`workflow_revised`/`workflow_revision_rejected`。`workflow_revised` 与 `workflow_revision_rejected` 仅在 `dynamic_workflow` capability 协商成功时发送。

每事件带 `subscription_id`、`seq`(单调、可重放)、`ts`、`run_id`、`category`、`name`、`payload`。

> 大 payload(diff 全文等)默认走 **artifact envelope**(见 §8),不内联;client 不支持 `artifact_refs` 时,证据 payload 按 §2/§6.1/§7 降级为内联截断。provenance/identity 中的裸 `artifact_id` 仍可出现,但不得要求 consumer 通过它取回大 payload。

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
- `reviews[]`:每家评审结果 + `status`(completed/timeout/error/abstain)+ `findings`(默认 artifact envelope,evidence 走 §8;`artifact_refs` 不可用时走下方内联降级)。
- `quorum`:显式 `{required, eligible, met}`——`eligible` = 排除作者后的可投票家数。
- `errors[]`:失败/超时/弃权的评审(quorum 只统计 `eligible && status==completed`)。

**`artifact_refs` 不可用时的 findings 降级**:`reviews[].findings` 改放内联对象 `{ "inline": true, "type": "findings", "mime": "application/json", "content": "...", "truncated": false }`(`content` 编码同 §8.2,大 evidence 截断并置 `truncated:true`),不放 envelope、不带 `artifact_id`。`outcome`/`quorum`/`excluded`/`errors` 等聚合字段不受影响——共识裁决本身不依赖 artifact_refs,只有 evidence 的承载形态降级。

### 6.2 可满足性校验(两段式)

**第 1 段:静态形状校验(`orchestrate.run` 受理时,无作者信息)**
- 校验 panel 的形状:panel 非空、quorum 合法、所有成员均为 known、非 rejected、`resolved_roles` 含 `reviewer`。degraded 成员只有在其 reviewer role 可用时才可参与 panel。
- 校验可投票规模:panel 中 reviewer role 可用的 agent 数 ≥ quorum。
- 不预留「作者余量」——作者是否在 reviewer panel 未知,且可能根本不在 panel(如 coder=codex、reviewer panel=[claude,gemini])。预留余量的公式会误杀合法配置。作者命中 panel 的动态不足,交给第 2 段。
- 形状非法(panel 空、quorum≤0、quorum>panel 规模、含 rejected agent)→ error `invalid_quorum`。形状合法但 reviewer role 可用数 < quorum → error `quorum_unsatisfiable`。

**第 2 段:精确 quorum 校验(consensus step 开始前,作者已确定)**
- 此时被评审 artifact 的 `produced_by_agent_id` 已知 → 计算 `eligible = panel 中 ≠ 作者 的 agent 数`。
- `eligible ≥ quorum` → 正常跑共识。
- `eligible < quorum` → 按 `policy.on_quorum_unsatisfiable`:`ask_human`(escalate,发 `consensus_degraded`)| `degrade_quorum`(降到 eligible,发 `consensus_degraded`)| `reject`(该步失败,run 按 unattended policy 处置)。
- **绝不产出 `quorum.met:false` 的正常 verdict**;`met:false` 只出现在降级/escalate,且 `outcome` 必为 `ask_human` 或配 `consensus_degraded`。

**错误码定序**(四段,不重叠):
1. `agent_not_found`(§4.2/§10)管**引用合法性**:panel/role 含 unknown agent(本连接 flock 从未出现)。最先校验。
2. `role_unsupported`(§4.2/§10)管 role 不匹配:known agent 的 `resolved_roles` 不含目标 role,或 degraded agent 缺该 role。
3. `invalid_quorum`(§10)管 quorum **形状**:quorum≤0、quorum>panel 规模、panel 空、panel 含 rejected agent、全部 excluded。
4. `quorum_unsatisfiable`(§10)管**策略性不足**:形状合法且 role 可用,但静态可投票数或排除作者后 eligible 不够。

**顺序固定:引用合法性(unknown)→ role 匹配→ 形状(invalid_quorum)→ 策略(quorum_unsatisfiable)**。到第 3 段时 panel agent 已全部 known 且 reviewer role 可用。

### 6.3 作者身份(provenance)

wire 层只表达 provenance:`target.produced_by_agent_id` / `target.artifact_id`。「排除作者」是 `policy.exclude_author` + `policy.author_provenance` 决定的 orchestrator 行为,wire 不假设「author」是单一全局身份——多步骤 run 不同 artifact 可能有不同 producer。

### 6.4 Stable gate report surface

`GateReport.v1` 是 consumer-facing gate snapshot projection,作为 `events.event` 发送:

```jsonc
{ "method": "events.event", "params": { "seq": 50, "category":"gate",
  "name":"gate_report", "run_id":"run_abc",
  "payload": {
    "version": "GateReport.v1",
    "run_id": "run_abc",
    "generated_at": 1718600200,
    "target": { "artifact_id": "art_diff_1", "produced_by_agent_id": "codex" },
    "policy": {
      "exclude_author": true,
      "author_provenance": "produced_by_agent_id",
      "on_quorum_unsatisfiable": "reject",
      "on_consensus_blocking": "ask_human"
    },
    "quorum": { "required": 2, "eligible": 2, "met": true },
    "decision_surface": {
      "review_outcome": "request_changes",
      "gate_disposition": "waiting_approval"
    },
    "consensus_snapshot": { "...": "latest consensus_verdict or consensus_degraded payload" },
    "reviews": [],
    "findings": [],
    "pending_approval": { "approval_id": "ap_1", "kind": "semantic_decision", "reason": "..." },
    "blocking_reason": "consensus_request_changes",
    "audit_refs": [{ "kind": "event", "ref": "seq:49", "name": "consensus_verdict" }]
  } } }
```

Rules:
- Sent only when `initialize.capabilities.gate_report.supported` is negotiated true by both sides. If not negotiated, zero `gate.gate_report` events are sent.
- Append-only: consumers use the latest `gate_report` for current UI state and may keep earlier reports as timeline evidence.
- `decision_surface` is the summary truth. `consensus_snapshot` is evidence only and must not be used by consumers as an alternate state machine.
- `decision_surface.review_outcome` is `approve | request_changes | reject | none`.
- `decision_surface.gate_disposition` is `approved | waiting_approval | blocked | overridden | degraded | no_gate`.
- `ask_human` and `degrade_quorum` remain policy-action evidence; they are not flat terminal gate states by themselves.
- `reviews`, `findings`, `audit_refs`, and reviewer runtime entries are sorted deterministically. Any truncated inline evidence must carry `truncated:true` and a truncation reason.
- `artifact_refs:true/false` must preserve `decision_surface`, target, quorum, blocking, override, and audit fields. Evidence bytes may differ between artifact envelopes and inline fallback.
- `task.cancel` is run abort, not gate override. It may produce a final report with terminal `run_gave_up`/cancel reason, but never an `overridden` disposition.

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

`semantic_decision` approval 是 gate override / semantic gate decision 的单通道。`approval.resolve` 对该 kind 必须额外带 audit fields:
```jsonc
{ "jsonrpc": "2.0", "id": 6, "method": "approval.resolve",
  "params": {
    "approval_id": "ap_semantic_1",
    "decision": "approved",
    "by": "user:tizer",
    "reason": "accepted known P2 risk",
    "previous_gate_outcome": "request_changes",
    "new_gate_outcome": "approved",
    "artifact_refs": ["art_diff_1"]
  } }
```
这些 audit fields 对 `semantic_decision` **必填**,对 `merge_approval` 等其他 kind 不要求且不得改变旧 merge approval 行为。未知 approval kind fail-closed。

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

终态 payload 必有:`approval_id`、`state`(`resolved`|`expired`|`cancelled`)、`reason`。`state=resolved` 额外带 `decision`(`approved`|`rejected`)、`by`。`semantic_decision` resolved 事件还带 `kind:"semantic_decision"` 以及上述 audit fields。`approval.resolve` 不直接 mutate `GateReport.v1`;server 只发 approval audit event 并恢复 backend,新的 `gate_report` 由事件/状态投影派生。

**`artifact_refs` 不可用时的 details 降级**:`approval_requested.payload.details` 改放内联对象 `{ "inline": true, "type": "approval_details", "mime": "application/json", "content": "...", "truncated": false }`(同 §6.1 findings 降级),不放 envelope。

**race**:`approval.resolve` 与 server 自动终态(超时 `approval_expired` / `task.cancel` 致 `approval_cancelled`)并发时,以 server 先落定的终态为准:
- server 已先落终态 → client 的 `approval.resolve` 收 `approval_already_resolved` error(§10)。
- client resolve 先落定 → server 放弃自动终态,不再发 `approval_expired`/`approval_cancelled`(server 是状态机持有方,不存在"收 error"一说)。

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

### 8.1 envelope(大 payload/evidence ref 处必带)

```jsonc
{ "artifact_id": "art_diff_1", "type": "diff", "mime": "text/x-diff",
  "size": 4523, "sha256": "abc...", "created_by": "codex", "created_at": 1718600000,
  "expires_at": 1718610000 }
```

**规则**:事件 payload 里凡承载大 payload/evidence 的 ref(如 `findings`、`details`),该位置放**完整 envelope**(不是裸字符串),consumer 无需二次请求即可知类型/大小/hash。`artifact_id` 是全局唯一 id。

**provenance/identity 例外**:`target.artifact_id`、`provenance.artifact_id` 这类字段只是关联某个已知产物的身份,可以是裸字符串;它们不承诺可取回大 payload,也不受 `artifact_refs` 能力控制。若同一位置要承载可取回内容,必须另放 envelope 字段或按 `artifact_refs:false` 走内联降级。

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
| -32007 | `invalid_quorum` | quorum 参数非法:≤0 / > panel / panel 空 / panel 含 rejected agent / 全部 excluded(unknown agent 不归这里,走 `agent_not_found` §4.2) |
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
| -32018 | `role_unsupported` | orchestrate.run 派给某 agent 的角色不在其 `resolved_roles`(§4.2) |
| -32019 | `agent_not_found` | orchestrate.run 引用本连接 flock 从未返回过的 agent id(§4.2) |
| -32020 | `invalid_event_category` | events.subscribe.categories 为空数组或含未知 category(§5) |
| -32021 | `isolation_profile_rejected` | 选中的 runtime surface / isolation profile 缺失或为 rejected |
| -32099 | `internal_error` | 兜底 |

> 引用合法性:unknown agent(从未在本连接 flock 出现)走 `agent_not_found`(§4.2/§10.1);known-but-rejected 按用途分流到 `invalid_quorum`(reviewer panel)或 `unsupported_transport`/`missing_auth`(单点 role)。

可重试(transient):`-32006 missing_auth`、`-32011 lease_stolen`、`-32012 run_locked`。其余默认不可重试。

### 10.1 flock 部分成功语义

**`flock.declare` / `flock.discover` 永远是「部分成功」语义**——返回值是 per-agent `agents[]`(每个带 status:ready/degraded/rejected + reason + missing),**不抛 JSON-RPC error**,哪怕全部 rejected。
- `unsupported_transport` / `missing_auth` 作为 per-agent `status=rejected` 的 `reason`(在 response 里),不是 JSON-RPC error。
- 仅当请求本身格式非法(无 agents 字段、transport 非法字符串)才抛 JSON-RPC 标准 `invalid_request`(-32600);well-formed request 的语义/引用错误走 HOLP 专用错误码。
- `orchestrate.run` 受理时,**单点 role**(coder/architect/tester 等)所需 agent 是 rejected status → error `unsupported_transport` 或 `missing_auth`(此时才是 JSON-RPC error,因为 run 无法进行)。**reviewer panel** 含 rejected agent 不走这里,走 §6.2 的 `invalid_quorum`(形状校验,panel 含 rejected)。引用未声明的 unknown agent → `agent_not_found`(§4.2)。

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
  "on_consensus_blocking": "reject",
  "max_unattended_steps": 50
}
```

- 已定义可依赖字段:`on_approval_timeout`(`escalate` | `auto_reject` | `auto_approve`——后者危险,默认禁用,须显式开启且 server 可拒绝)、`on_capability_gap`(`reject_run` | `degrade`)、`on_consensus_blocking`(`reject` | `ask_human`)、`max_unattended_steps`。
- approval 超时 → `on_approval_timeout`(默认 `escalate`)→ 配合 §7 `approval_expired` 事件。
- client 能力缺口 → `on_capability_gap`(配 §2 descriptor 协商)。
- quorum 已满足但 consensus outcome 为 `request_changes`/`reject` → `on_consensus_blocking`。缺省 `reject` 保持旧行为;`ask_human` 必须先 mint `semantic_decision` approval,run 进入 `waiting_approval`,不得先 terminal `blocked`。
- 名字「Human on Loop」= 默认尽量自动、只在 require_human 打断。

> `GateReport.v1` 是当前稳定 consumer surface。`auto_pass_gates` / `require_human_gates` 的具体 gate 名称仍可能是实现私约定字符串;consumer 应依赖 `gate_report.decision_surface` 而不是自行解析私有 gate 名称。

---

## 12. 实现边界(参考 daemon)

**协议层(draft v0.1.8)**:本 spec 全章有定义。v0.1.5 将 Issue #11 的 harness isolation baseline 吸收进 §3 flock:runtime surface / isolation readiness matrix;v0.1.7 增加 consumer stable gate report surface;v0.1.8 增加 learned router safe lane 与 dynamic workflow capability-gated lifecycle revision events。

**当前仓已落地**:
- ✅ 协议 draft(`protocol/`)。
- ✅ adapter 契约 + Codex app-server real adapter(`mcp-codex`) + native-claude headless reviewer partial;`fake` transport 仅用于 demo/test,`acp` 仍是 stub。
- ✅ 参考 daemon 协议骨架(`daemon/`):stdio JSON-RPC 9 方法 + 事件订阅/replay(M1a+M1b)。
- ✅ 参考 consumer CLI(`consumers/cli/`)+ M1 e2e 闭环 + M6a fake consumer CLI partial——默认 demo 仍用 `fake` transport。
- ✅ M2 契约回归网(`daemon/handlers/m2_contract.test.ts`):已锁定当前实现的关键 v0.1.4 语义；approval 超时已由 M4a skeleton 接入正向 contract,显式 reviewer panel 的 consensus kernel 已由 M4b 接入正向 contract,heartbeat 仍转交后续。
- ✅ M3 首个真实 adapter:`mcp-codex` 接 Codex app-server over stdio,含基础 stdio/turn recovery;真实 provider smoke 取决于本机 Codex binary/auth/quota。
- ✅ M4a governance data/state/decision skeleton partial:内部 event archive、`decision_made`、harness registry archive、run lifecycle state machine、approval expiry timer。
- ✅ M4b consensus gate triage kernel partial:纯 consensus aggregation、author exclusion、二段式 quorum、显式 reviewer panel 的 `consensus_verdict`/`consensus_degraded`。
- ✅ M5 deterministic unanimous-approve fake+fake multi-agent consensus demo:`npm run demo:m5` 真走 stdio JSON-RPC daemon wire,覆盖 findings artifact envelope 和 `artifact_refs:false` inline fallback。
- ✅ M5b real reviewer execution pilot:`mcp-codex` reviewer execution hook 只有在 strict JSON parser/validator + read-only attestation 通过时才计为 completed vote。
- ✅ M6b second real provider adapter partial:`native-claude` 通过 Claude Code headless `-p --output-format json` 接入 reviewer path,read-only ready 取决于 enforcement probe evidence。
- ✅ M6c runtime/session matrix foundation:consumer CLI 从 flock public wire response 渲染 headless/acp/direct_user_session、direct channel observation/control、isolation readiness 和声明风险。
- ✅ M9 stable gate surface partial:`gate_report` capability + `gate.gate_report` / `GateReport.v1` projection,覆盖 consensus verdict/degraded、approval pending/resolved、override audit、terminal consistency、artifact_refs 降级等价和 CLI summary。
- ✅ M10/M11 safe-lane partial:`learned-router` / `work_planner` planner-only role,top-level `orchestrate.run.planner`,fixture replay/shadow/fail-closed active fallback,promotion evidence shape,L1 bounded `request_changes -> fix -> review`,L2 `WorkflowRevision.v1` validator/reject/audit foundation,and capability-gated `workflow_revised` / `workflow_revision_rejected` events. No `real_learned_model` backing, active/canary smoke/readiness, or L2 learned-active readiness is claimed.

**参考 daemon 下一步 milestone**:
- ⏳ M10 learned router real active lane:requires `real_learned_model` attestation and fresh promotion evidence before active/canary can execute learned decisions.
- ⏳ M11 L2 learned-active dynamic workflow:full pending-graph replacement requires fresh matching evidence;fixture backing remains replay/shadow/fallback only.
- ⏳ M12 Remote/distributed HOLP:remote runner surface,artifact/event/approval relay。
- ❌ 未做(不声称):12-agent 完整矩阵;Web 传输;Remote(wire 不含)。PR14/M8 已落第一批真实 runtime surface pilot,但不表示所有 headless/ACP/direct paths 全覆盖。

**当前仓只声称**「protocol draft + fake backend 跑通的 M1 闭环 + M2 契约层锁定 + Codex app-server 首个真实 adapter + v0.1.5 runtime surface/isolation baseline + M4a governance skeleton partial + M4b consensus kernel partial + M5 fake+fake demo + M5b real reviewer pilot + M6a fake consumer CLI partial + M6b native-claude headless reviewer partial + M6c runtime/session matrix foundation + M8 first real runtime surface pilot + M9 stable gate surface partial + M10/M11 fixture replay/shadow/fail-closed/L1 bounded dynamic workflow plus L2 revision validator/reject/audit foundation partial」。未接线 transport 的 declare/discover 实测 status 仍为 `rejected`;不声称 12 个 agent 已完整支持 `headless` / `acp` / `direct_user_session` 三类运行面,也不声称 `real_learned_model` backing、learned router active/canary smoke/readiness、L2 learned-active workflow readiness 或 Remote 已完成。

### 12.1 adapter 实现约束

- **并发 session**:一个 backend 实例**只允许一个 session**;若未来要多 session,`AgentMessage` 必须带 `sessionId/run_id/step_id`,handler 按 session 订阅。
- **permission 可恢复**:PR5 主路径是 daemon 注入 `PermissionHandler`,由它创建 approval 并返回 pending Promise;`approval.resolve` / `task.cancel` 调 `ApprovalRecord.resumeBackend(decision)`,adapter await 后把 allow/deny 回写 provider。可选 `resolvePermission(request_id, decision)` 保留给未来无法用 injected handler 表达的 provider wrapper。
- **命名**:adapter 注释/报错/文档统一用协议命名(`events.subscribe`/`approval_requested`/`consensus_verdict`)。

---

## 留 v0.2 的(诚实标注)

- unattended_policy 的 `gate` 协议(gate object/event/outcome/kind 映射)。
- big artifact 分块读取(`artifact.read(offset,len)`)。
- Remote 执行(workspace sync / secret scope / 等,独立扩展 proposal)。
- adapter 真接线(acp/direct session;`mcp-codex` 已有 Codex app-server 接线,`native-claude` 已有 headless reviewer partial,后续可继续扩展更完整 provider 覆盖)。
- client 单独 abort approval(不取消整个 run)。

---

## CHANGELOG

- **v0.1.8**:M10/M11 learned router safe lane + dynamic workflow partial。新增 `dynamic_workflow` capability;新增 `learned-router` transport 与 planner-only `work_planner` role;`orchestrate.run.planner` 顶层选择 `rule` / `learned_shadow` / `learned_active` / `canary`,不得通过 executor `roles` 表达。fixture planner 只可 replay/shadow;active/canary/L2 learned-active 需要 `real_learned_model` attestation + fresh promotion evidence,否则 fail-closed 回退 RuleWorkPlanner。新增 `workflow_revised` / `workflow_revision_rejected` lifecycle events,仅在 `dynamic_workflow` 协商成功时发送。L1 支持受限 `request_changes -> fix -> review`;L2 pending graph revision 必须整体验证或整体拒绝。
- **v0.1.7**:M9 consumer stable gate surface。新增 `gate_report` capability、`gate` event category、唯一 event name `gate_report`、`GateReport.v1.decision_surface`(`review_outcome` + `gate_disposition`)作为 consumer summary truth。`approval.resolve` 对 `semantic_decision` 增加必填 audit fields,未知 approval kind fail-closed;`policy.on_consensus_blocking` 支持 quorum-met `request_changes`/`reject` 先进入 `waiting_approval`。`task.cancel` 明确为 run abort,不是 override。
- **v0.1.5**:Issue #11 baseline amendment。把多 harness 隔离模型提升为协议基准:§3 增加 runtime surface / isolation readiness matrix,要求 flock declare/discover 能表达 `headless` / `acp` / `direct_user_session` 三类运行面、runtime kind、direct channel observation/control 能力、isolation profile readiness、state declaration ref、global mutation risk。`ready` 不再表示"agent 整体可用",只表示某个 runtime surface + isolation profile 下可调度。当前实现可以返回 unknown/unsupported/rejected,但不能省略该语义。
- **v0.1.4**:跨仓 review(对照 cmux/warp/loopwright/happier/spawn/skypilot 真实代码)后补互操作缺口。**P1**:`artifact_refs` 不可用时 consensus `findings` / approval `details` 的内联降级形态,并澄清 provenance 裸 `artifact_id` 不受该能力控制(§2/§6.1/§7/§8.1);`orchestrate.run` 的 agent 引用绑定 flock + role 校验(§4.2,新错误码 `role_unsupported` -32018、`agent_not_found` -32019);`events.subscribe.categories` 语义(白名单/省略=全订)+ 五 category 封闭枚举(§5,新错误码 `invalid_event_category` -32020)。**P2**:§7 race 表述对 server-timeout 分支修正;§10.1 单点 role vs reviewer panel 的 rejected 分流交叉引用;seq 从 1 起的边界定义(§5);happier 权限枚举更正(五值,非三值)+ 补 loopwright `reviewerCandidates` 归因(positioning)。**冻结门(PR1)**:修了 4 处 spec 源内不自洽——§1 控制面方法列表补 `artifact.get`(§8.2 已定义却漏列);flock declare/discover 示例 cast 一致化(§3.3 回执改为返回 declare 声明过的 `claude`+`codex`,不再凭空返回未声明的 `gemini`;`gemini` 改走 §3.2 discover 并配 response 示例,`status=degraded` 且 `resolved_roles` 含 `reviewer`);§4 `orchestrate.run` 示例与 flock 实测 status 自洽(panel `[claude,gemini]` 均 known、reviewer 可用、非 rejected,排除作者 codex 后 eligible=2≥quorum2 → `accepted:true` 合法);§5 补 `events.unsubscribe` 的 success response 形状 `{subscription_id, unsubscribed:true}` + 未知 id 走 `invalid_subscription`。本 PR 即在冻结 v0.1.4,**不 bump 版本号**。
- **v0.1.3**:quorum 两段式校验 + 错误码定序;artifact 强制 content(禁 content_ref);approval 单通道状态机(cancel 只由 task.cancel 导致)+ race 规则;`task.cancel` schema;capability descriptor `{supported, required?, kinds?}`(required 连接级);错误码拆开(一错误一码)+ flock 部分成功语义。经四轮深度 review,判「实现前无 P0」(跨仓 review 后在 v0.1.4 补了 3 个 P1 互操作缺口)。
- **v0.1.2**:把首轮返工的表面改逼到可执行(Remote 删净、错误码拆开、跨文件命名统一)。
- **v0.1.1**:首轮 review 返工(传输面拆分、approval 单通道、flock discover)。
- **v0.1**:协议初稿。
