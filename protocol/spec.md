# HOLP — Human On Loop Protocol

> **版本**:v0.1 (draft)
> **状态**:草稿,参考实现进行中
> **定位**:见 `docs/positioning.md`。开源、免费、本地优先的 multi-agent 编排协议。

HOLP 是 **consumer**(终端 / 工具 / APP——cmux、Warp、happier、CLI)与 **orchestrator**(编排器——HOLP 参考 daemon 或任何实现)之间的那根线。consumer 声明「我有一窝异构 agent」,发起编排目标,orchestrator 派单并流式回吐事件;需要人拍板时,人在回路上介入——**Human on Loop**。

---

## 1. 传输与编码

**传输**:stdio 上的 JSON-RPC 2.0(与 ACP / MCP 同家族)。consumer 是 client,orchestrator 是 server。双向:

- **请求/响应**(client→server 方法,如 `flock.declare`):标准 JSON-RPC request/response。
- **流式通知**(server→client,如事件流):用 JSON-RPC notification(`"jsonrpc":"2.0","method":"...","params":{...}`,无 id),或 long-running request 的连续 response chunk。
- **每行一个 JSON 对象**(newline-delimited),与 cmux `events.stream` 的 JSON-line 实践一致(来源:cmux `CmuxEventStream.swift`)。

> 未来可选 WebSocket 传输(给 Web/远程 APP),v0.1 只 stdio。

---

## 2. 握手:`initialize`

client 连上后第一条。双方报身份与能力。

**Request**(client→server):
```jsonc
{
  "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {
    "client": { "name": "cmux", "version": "0.64.16" },
    "capabilities": { "streaming": true, "consensus": true, "remote_runner": false },
    "protocol_version": "0.1"
  }
}
```

**Response**(server→client):
```jsonc
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "server": { "name": "holp-reference-daemon", "version": "0.1.0" },
    "capabilities": { "consensus": true, "unattended_loop": true, "remote_runner": false },
    "protocol_version": "0.1"
  }
}
```

能力降级:client 不支持 consensus → server 不发 `consensus.verdict`(退化为单 agent 模式)。来源:ACP/MCP 的 `initialize` 家族惯例。

---

## 3. 声明 agent 队伍:`flock.declare`

> **替代 cmux 的硬编码 switch**(`AgentSessionProvider.swift` 里 codex/claude/opencode 三家各一个 case)。把「哪几家、什么传输」从 consumer 源码挪成数据。
> **设计借自**:Oz `Harness` oneof(`orchestration.proto`)+ happier catalog(`apps/cli/src/backends/catalog.ts`)+ spawn `manifest.json`。

consumer 声明它机器上的 agent,orchestrator 据此知道能调度谁。

**Request**:
```jsonc
{
  "jsonrpc": "2.0", "id": 2, "method": "flock.declare",
  "params": {
    "agents": [
      {
        "id": "claude",
        "transport": "native-claude",
        "roles": ["architect", "reviewer", "coder", "tester"],
        "auth_ref": "env:ANTHROPIC_API_KEY",
        "enabled": true
      },
      {
        "id": "codex",
        "transport": "mcp-codex",
        "roles": ["coder", "reviewer", "tester"],
        "auth_ref": "login:codex",
        "enabled": true
      },
      {
        "id": "gemini",
        "transport": "acp",
        "roles": ["reviewer"],
        "auth_ref": "env:GEMINI_API_KEY",
        "enabled": false
      }
    ]
  }
}
```

**字段**:
- `id`:agent 标识(开放字符串;来源 spawn manifest 的 agent id 集)。v0.1 不穷举,运行时校验。
- `transport`:`native-claude` | `mcp-codex` | `acp` | 自定义(对位 loopwright `harness_registry.transport_class`、happier backend modes)。
- `roles`:该 agent 能担的角色(architect/reviewer/coder/tester/test_audit/test_strengthen——来源 loopwright `Role`)。
- `auth_ref`:凭证引用,**不传明文**(`env:XXX` / `login:agent` / `secret:name`)。
- `enabled`:是否当前可调度。

**Response**:`{ "accepted": [...], "rejected": [{"id":"gemini","reason":"acp backend not wired in v0.1"}] }`

> v0.1 参考实现只接 enabled 的 native-claude / mcp-codex;acp 行接受声明但回 rejected(acp 方言库 = happier,接入留后续)。

---

## 4. 发起编排:`orchestrate.run`

> **设计借自**:Oz `RunAgents`(`task.proto:1832`,批量派单 + 共享配置)+ loopwright triage 派单。**Local|Remote 进 wire**(Oz `ExecutionMode` 思路)。**consensus 作为协议参数**(Oz 没有,HOLP 独有)。

**Request**:
```jsonc
{
  "jsonrpc": "2.0", "id": 3, "method": "orchestrate.run",
  "params": {
    "goal": "Fix the flaky test in tests/foo.test.ts",
    "trigger": "issue:42",
    "roles": {
      "coder":   { "agent": "codex" },
      "reviewer":{ "panel": ["claude", "codex"], "quorum": 2, "exclude_author": true }
    },
    "consensus": { "panel": ["claude","codex"], "quorum": 2, "exclude_author": true },
    "execution_mode": { "kind": "Local" },
    "plan": { "required": true }
  }
}
```

**字段**:
- `goal`:自然语言目标。
- `trigger`:触发来源(`issue:N` / `manual` / `webhook:...`——来源 loopwright `TRIGGER_SOURCE`)。
- `roles`:角色派单(可指定 agent 或交 orchestrator 选);reviewer 可给 panel+quorum+exclude_author(来源 loopwright 共识评审)。
- `consensus`:**协议级共识参数**——要几家、几家同意、是否排除作者。Oz/happier 无此语义。
- `execution_mode`:`{kind:"Local"}` | `{kind:"Remote", environment_id, worker_host}`。**v0.1 只实现 Local;Remote 留 wire 口子**(来源 Oz `ExecutionMode`,实现待 V3 对位 spawn/skypilot)。
- `plan.required`:是否要求先出骨架计划(来源 loopwright `runs.plan_required`)。

**Response**(立即,表示编排已受理):
```jsonc
{ "jsonrpc": "2.0", "id": 3, "result": { "run_id": "run_abc", "accepted": true } }
```

后续进展通过 `events.stream` 推送。

---

## 5. 流式事件:`events.stream`

> **几乎照搬 cmux `events.stream` + `CmuxEventBus`**(`CmuxEventStream.swift`)——它已验证「JSON-line + seq + replay + 心跳 + slow_consumer 背压」可用。事件内容换成编排事件。

**Request**(client→server,订阅):
```jsonc
{
  "jsonrpc": "2.0", "id": 4, "method": "events.stream",
  "params": { "after_seq": 0, "categories": ["run","agent","consensus","approval"], "include_heartbeats": true }
}
```

**流式 Response**(server→client,先 ack + replay,再持续推):
```jsonc
{ "jsonrpc": "2.0", "method": "events.ack", "params": { "latest_seq": 0 } }
{ "jsonrpc": "2.0", "method": "events.heartbeat", "params": { "latest_seq": 12, "ts": 1718600000 } }
{ "jsonrpc": "2.0", "method": "events.event", "params": { "seq": 13, "ts": 1718600001, "category": "agent", "name": "tool_called", "run_id": "run_abc", "payload": {...} } }
```

**背压**:消费过慢 → server 发 `events.error { code: "slow_consumer", latest_seq }` 并关流(来源 cmux `slow_consumer`)。

**事件 `name` 集合**(来源 loopwright `EVENT_TYPE` + happier sessionMessages/approvals):
- `run`:`run_started` / `run_triaging` / `run_reviewing` / `run_fixing` / `run_merged` / `run_blocked` / `run_gave_up`
- `agent`:`agent_selected` / `step_started` / `tool_called` / `tool_result` / `fs_edited` / `agent_failed`
- `consensus`:`consensus_verdict`(见 §6)/ `consensus_degraded`
- `approval`:`approval_needed`(见 §7)/ `approval_resolved`
- `lifecycle`:`escalated` / `lease_stolen` / `circuit_open`

每事件带 `seq`(单调、可重放)、`ts`、`run_id`、`category`、`name`、`payload`。

> v0.1 事件 `payload` 用 JSON 对象,大 payload(diff 全文等)走 artifact ref,不内联(来源 happier timeline 安全:不返回 raw content)。

---

## 6. 共识裁决:`consensus.verdict`(协议级,HOLP 独有)

> **来源**:loopwright `aggregateVerdict` + 共识评审(fan-out + 聚合 + ≠作者 + severity 判级)。Oz 多 harness 并行但无共识聚合;happier reviews 是单引擎。**这是 HOLP 写进协议的真差异。**

当一次评审跨多家 agent,orchestrator 聚合后发:
```jsonc
{
  "jsonrpc": "2.0", "method": "events.event",
  "params": {
    "seq": 27, "category": "consensus", "name": "consensus_verdict", "run_id": "run_abc",
    "payload": {
      "verdict": "request_changes",          // approve | request_changes | reject | ask_human
      "max_severity": "P1",                   // P0 | P1 | P2 | NONE
      "voters": [
        { "agent": "claude", "verdict": "request_changes", "max_severity": "P1", "author": false },
        { "agent": "codex",  "verdict": "approve",          "max_severity": "P2", "author": true }
      ],
      "quorum": 2, "exclude_author": true,
      "rule": "majority-non-author"           // 判级规则(可扩展)
    }
  }
}
```

`exclude_author:true` 时,作者那家的投票不计入 quorum(来源 loopwright PRD §9「角色不等式」)。

---

## 7. 人工介入:`approval.request` / `approval.resolve`

> **来源**:loopwright merge-gate `ask_human` + awaiting_approval;happier `approvals`。**Human on Loop 的核心**:绝大多数步骤无人值守,只在 gate 判定要人时打断。

需要人拍板时(如合并前、危险操作):
```jsonc
{ "jsonrpc": "2.0", "method": "approval.request",
  "params": { "approval_id": "ap_1", "run_id": "run_abc", "kind": "merge_approval", "reason": "merge-gate requires human", "payload": {...} } }
```

人决定后:
```jsonc
{ "jsonrpc": "2.0", "id": 5, "method": "approval.resolve",
  "params": { "approval_id": "ap_1", "decision": "approved", "by": "user:tizer" } }
```

`kind`:`merge_approval` | `force_push_approval` | `semantic_decision` | `low_confidence` | `budget_exceeded`(来源 loopwright `ESCALATION_KIND`)。

> ⚠️ v0.1 实现:`merge_approval` 走完整 approval 流;其余 kind 至少回 `approval.request` 让 consumer 知道,即使 consumer 不实现 UI 也能 log。awaiting_approval 的状态机迁移(旧 loopwright 的 #11 强阻塞)在参考实现里理顺,不阻塞协议定义。

---

## 8. 生命周期与取消

> **来源**:ACP cancel + Oz `LifecycleEvent`(`task.proto`,子 agent 报 started/blocked/failed/errored)。

```jsonc
{ "jsonrpc": "2.0", "id": 6, "method": "task.cancel", "params": { "run_id": "run_abc", "reason": "user aborted" } }
```

agent 生命周期经 `events.event` 的 `lifecycle` category 推送(`agent_failed` / `escalated` / `circuit_open` / `lease_stolen`)。

---

## 9. 版本化与能力降级

- 协议版本在 `initialize` 协商;版本不兼容 → 拒绝并报 `server_error: protocol_version_mismatch`。
- **最小 consumer** 只需实现:§2 initialize + §3 flock.declare + §4 orchestrate.run + §5 events.stream。共识(§6)/approval(§7)是可选能力,按 `capabilities` 协商降级。
- 协议演进只增不破(minor 版本加可选字段/方法);破坏性变更 bump major。

---

## v0.1 实现边界(参考 daemon)

- **做**:Local 执行;native-claude + mcp-codex 朝下接入(参考实现先用桩 adapter 接口,happier 方言库留口子);flock.declare / orchestrate.run / events.stream / consensus / approval 全协议面。
- **不做**(留 wire 口子):Remote 执行;acp 朝下(待接 happier backends);Web/远程 APP 传输。

## 设计来源总表

见 `docs/positioning.md` 「设计来源」表。各章已就地标注借自哪个仓的什么。HOLP 不凭空发明,也不抄依赖(Oz proto 只借思路、不实现服务端)。
