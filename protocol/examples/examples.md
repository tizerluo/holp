# HOLP v0.1.8 最小 JSON 示例集

> 示例派生自 `spec.md` v0.1.8,字段语义以 `spec.md` 为准。

本文档为 M0 验收材料:**9 个方法各至少一组 request/response**,**每类关键 notification 至少一条**。
所有 JSON 为合法 JSON;`jsonc` 代码块中保留的 `//` 注释仅供阅读,去掉注释后结构仍合法(引号闭合、无非法尾逗号)。

字段、语义与 `spec.md` 对应章节一致;凡 spec 正文已给出的示例(initialize / flock.* / orchestrate.run / events.subscribe / artifact.get / approval / task.cancel / consensus_verdict 等)在此**直接采用并保持字段一致**。

---

## 一、方法 request / response(9 个)

### 1. `initialize` — request(§2)

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
      "gate_report": { "supported": true },
      "dynamic_workflow": { "supported": true }
    },
    "protocol_version": "0.1.8"
  }
}
```

### 1. `initialize` — response(§2)

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
      "gate_report": { "supported": true },
      "dynamic_workflow": { "supported": true }
    },
    "protocol_version": "0.1.8"
  }
}
```

### 2. `flock.declare` — request(§3.1)

```jsonc
{ "jsonrpc": "2.0", "id": 2, "method": "flock.declare",
  "params": { "agents": [
    { "id": "claude", "transport": "native-claude", "roles": ["architect","reviewer","coder","tester"],
      "auth_ref": "env:ANTHROPIC_API_KEY", "enabled": true },
    { "id": "codex", "transport": "mcp-codex", "roles": ["coder","reviewer","tester"],
      "auth_ref": "login:codex", "enabled": true }
  ] } }
```

### 2. `flock.declare` — response(§3.3,部分成功语义,永不抛 error;返回 declare 声明过的同两个 agent)

```jsonc
{ "jsonrpc": "2.0", "id": 2, "result": {
  "agents": [
    { "id": "claude", "transport": "native-claude", "status": "ready",
      "version": "1.0.0", "logged_in": true, "resolved_roles": ["architect","reviewer","coder","tester"] },
    { "id": "codex", "transport": "mcp-codex", "status": "degraded",
      "version": "0.21.0", "logged_in": true, "resolved_roles": ["coder","reviewer","tester"],
      "missing": ["role:architect"],
      "runtime_surfaces": [
        { "runtime_surface": "headless", "runtime_kind": "app_server", "surface_support": "supported",
          "isolation_profiles": {
            "coder_worktree": { "readiness": "ready" },
            "real_provider_smoke": { "readiness": "ready", "warnings": ["inherits:network"] },
            "high_isolation": { "readiness": "degraded", "missing": ["keychain_isolation"] }
          },
          "state_declaration_ref": "harness-state:codex", "global_mutation_required": false },
        { "runtime_surface": "direct_user_session", "runtime_kind": "tmux", "surface_support": "unknown",
          "isolation_profiles": { "multi_agent_concurrent": { "readiness": "rejected", "reason": "route_not_declared" } },
          "direct_channel": { "channel_type": "tmux", "attach": "unknown", "inject": "unknown", "interrupt": "unknown", "cancel": "unknown", "owner_scope": "unknown" },
          "global_mutation_required": false }
      ] }
  ]
} }
```

### 3. `flock.discover` — request(§3.2)

```jsonc
{ "jsonrpc": "2.0", "id": 3, "method": "flock.discover",
  "params": { "transports": ["acp"], "probe": true } }
```

### 3. `flock.discover` — response(§3.2/§3.3,per-agent status;探测到 gemini 走 acp,degraded 但 reviewer 可用)

```jsonc
{ "jsonrpc": "2.0", "id": 3, "result": {
  "agents": [
    { "id": "gemini", "transport": "acp", "status": "degraded",
      "version": "0.3.0", "logged_in": true, "resolved_roles": ["reviewer"],
      "missing": ["role:coder"],
      "runtime_surfaces": [
        { "runtime_surface": "acp", "runtime_kind": "acp", "surface_support": "experimental",
          "isolation_profiles": { "read_only_review": { "readiness": "ready" }, "coder_worktree": { "readiness": "rejected", "reason": "role_missing" } },
          "state_declaration_ref": "harness-state:gemini", "global_mutation_required": false }
      ] }
  ]
} }
```

### 4. `orchestrate.run` — request(§4)

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
    }
  } }
```

### 4. `orchestrate.run` — response(§4,立即受理)

```jsonc
{ "jsonrpc": "2.0", "id": 4, "result": { "run_id": "run_abc", "accepted": true } }
```

### 5. `events.subscribe` — request(§5)

```jsonc
{ "jsonrpc": "2.0", "id": 5, "method": "events.subscribe",
  "params": { "run_id": "run_abc", "after_seq": 0,
              "categories": ["run","agent","consensus","approval","lifecycle"], "include_heartbeats": true } }
```

### 5. `events.subscribe` — response(§5,返回 subscription_id + latest_seq)

```jsonc
{ "jsonrpc": "2.0", "id": 5, "result": { "subscription_id": "sub_1", "latest_seq": 0 } }
```

### 6. `events.unsubscribe` — request(§5)

```jsonc
{ "jsonrpc": "2.0", "id": 9, "method": "events.unsubscribe",
  "params": { "subscription_id": "sub_1" } }
```

### 6. `events.unsubscribe` — response(§5,确认已取消)

> 形状以 spec §5 定义的 unsubscribe response 为准:`{ subscription_id, unsubscribed:true }`;未知 `subscription_id` 走 `invalid_subscription`(§10)。

```jsonc
{ "jsonrpc": "2.0", "id": 9, "result": { "subscription_id": "sub_1", "unsubscribed": true } }
```

### 7. `approval.resolve` — request(§7)

```jsonc
{ "jsonrpc": "2.0", "id": 6, "method": "approval.resolve",
  "params": { "approval_id": "ap_1", "decision": "approved", "by": "user:tizer" } }
```

### 7. `approval.resolve` — response(§7,server 回执)

```jsonc
{ "jsonrpc": "2.0", "id": 6, "result": { "approval_id": "ap_1", "accepted": true } }
```

### 8. `task.cancel` — request(§7.5)

```jsonc
{ "jsonrpc": "2.0", "id": 8, "method": "task.cancel",
  "params": { "run_id": "run_abc", "reason": "user aborted" } }
```

### 8. `task.cancel` — response(§7.5,立即受理)

```jsonc
{ "jsonrpc": "2.0", "id": 8, "result": { "run_id": "run_abc", "cancelling": true } }
```

### 9. `artifact.get` — request(§8.2)

```jsonc
{ "jsonrpc": "2.0", "id": 7, "method": "artifact.get",
  "params": { "artifact_id": "art_diff_1" } }
```

### 9. `artifact.get` — response(§8.2,永远返回 content,不返回 content_ref)

```jsonc
{ "jsonrpc": "2.0", "id": 7, "result": {
  "artifact_id": "art_diff_1",
  "envelope": {
    "artifact_id": "art_diff_1", "type": "diff", "mime": "text/x-diff",
    "size": 4523, "sha256": "abc...", "created_by": "codex", "created_at": 1718600000,
    "expires_at": 1718610000
  },
  "content": "diff --git a/...",
  "truncated": false
} }
```

---

## 二、关键 notification 示例

事件面是 server→client 的 JSON-RPC notification(无 `id`),**每条带 `subscription_id`**(§5)。

### N1. `events.heartbeat`(§5,心跳由 include_heartbeats 控制,不受 categories 过滤)

```jsonc
{ "jsonrpc": "2.0", "method": "events.heartbeat",
  "params": { "subscription_id": "sub_1", "latest_seq": 12, "ts": 1718600000 } }
```

### N2. `events.event` — 普通 agent 事件 `tool_called`(§5,category=agent)

```jsonc
{ "jsonrpc": "2.0", "method": "events.event",
  "params": { "subscription_id": "sub_1", "seq": 13, "ts": 1718600001,
              "category": "agent", "name": "tool_called", "run_id": "run_abc",
              "payload": { "agent": "codex", "step_id": "step_3", "tool": "edit_file",
                           "args_summary": "tests/foo.test.ts" } } }
```

### N3. `events.event` — `consensus_verdict`(§6.1,category=consensus,findings 走 artifact envelope)

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

### N4. `events.event` — `approval_requested`(§7,category=approval,details 走 artifact envelope)

```jsonc
{ "jsonrpc": "2.0", "method": "events.event",
  "params": { "subscription_id": "sub_1", "seq": 40, "ts": 1718600200, "category": "approval",
              "name": "approval_requested", "run_id": "run_abc",
    "payload": { "approval_id": "ap_1", "kind": "merge_approval",
                 "reason": "merge-gate requires human", "expires_at": 1718603000,
                 "provenance": { "step_id": "step_5", "artifact_id": "art_pr_1" },
                 "details": { "artifact_id":"art_approval_details", "type":"approval_details", "mime":"application/json",
                              "size":312, "sha256":"jkl...", "created_by":"daemon", "created_at":1718600000 } } } }
```

### N5. `events.event` — `approval_resolved`(§7,终态 state=resolved,带 decision/by)

```jsonc
{ "jsonrpc": "2.0", "method": "events.event",
  "params": { "subscription_id": "sub_1", "seq": 41, "ts": 1718600300, "category": "approval",
              "name": "approval_resolved", "run_id": "run_abc",
    "payload": { "approval_id":"ap_1", "state":"resolved", "decision":"approved",
                 "reason":"user_decision", "by":"user:tizer" } } }
```

### N6. `events.event` — `approval_expired`(§7,超时无人 resolve,server 自动)

```jsonc
{ "jsonrpc": "2.0", "method": "events.event",
  "params": { "subscription_id": "sub_1", "seq": 42, "ts": 1718603000, "category": "approval",
              "name": "approval_expired", "run_id": "run_abc",
    "payload": { "approval_id":"ap_1", "state":"expired", "reason":"timeout", "expired_at":1718603000 } } }
```

### N7. `events.event` — `approval_cancelled`(§7,task.cancel 致 run 取消,对所有 pending approval)

```jsonc
{ "jsonrpc": "2.0", "method": "events.event",
  "params": { "subscription_id": "sub_1", "seq": 43, "ts": 1718600400, "category": "approval",
              "name": "approval_cancelled", "run_id": "run_abc",
    "payload": { "approval_id":"ap_1", "state":"cancelled", "reason":"run_cancelled" } } }
```

### N8. `events.error` — `slow_consumer`(§5/§10.1,普通 notification,关该订阅)

```jsonc
{ "jsonrpc": "2.0", "method": "events.error",
  "params": { "subscription_id": "sub_1", "code": "slow_consumer", "latest_seq": 58 } }
```

### N9. `events.event` — `run_started`(§5,category=run,run 生命周期起点)

```jsonc
{ "jsonrpc": "2.0", "method": "events.event",
  "params": { "subscription_id": "sub_1", "seq": 1, "ts": 1718600000,
              "category": "run", "name": "run_started", "run_id": "run_abc",
              "payload": { "goal": "Fix the flaky test in tests/foo.test.ts", "trigger": "issue:42" } } }
```

### N10. `events.event` — `run_gave_up`(§5,category=run,终态;此处取消致终态,payload `{reason:"cancelled"}` 见 §7.5)

```jsonc
{ "jsonrpc": "2.0", "method": "events.event",
  "params": { "subscription_id": "sub_1", "seq": 44, "ts": 1718600500,
              "category": "run", "name": "run_gave_up", "run_id": "run_abc",
              "payload": { "reason": "cancelled" } } }
```

### N11. `events.event` — `workflow_revision_rejected`(§5,category=lifecycle)

```jsonc
{ "jsonrpc": "2.0", "method": "events.event",
  "params": { "subscription_id": "sub_1", "seq": 45, "ts": 1718600600,
              "category": "lifecycle", "name": "workflow_revision_rejected", "run_id": "run_abc",
              "payload": { "revision_id": "rev_1", "rollback_cursor": 2,
                           "reason": "hard_constraint_violation" } } }
```

---

## 三、`artifact_refs:false` 降级形态(§2 / §6.1 / §7)

`artifact_refs` 不可用时,凡承载 evidence 的位置(consensus `reviews[].findings`、approval `details`)改放**内联降级对象**,不放 envelope、不带 `artifact_id`。`outcome`/`quorum`/`excluded`/`errors`、provenance/identity 裸 `artifact_id` 不受影响。

### D1. consensus `consensus_verdict` 的 `reviews[].findings` inline 形态(§6.1)

```jsonc
{ "jsonrpc": "2.0", "method": "events.event",
  "params": { "subscription_id": "sub_1", "seq": 27, "ts": 1718600100,
              "category": "consensus", "name": "consensus_verdict", "run_id": "run_abc",
    "payload": {
      "target": { "artifact_id": "art_diff_1", "produced_by_agent_id": "codex" },
      "outcome": "request_changes",
      "max_severity": "P1",
      "quorum": { "required": 2, "eligible": 2, "met": true },
      "rule": "majority-non-author",
      "reviews": [
        { "agent": "claude", "eligible": true, "verdict": "request_changes", "max_severity": "P1",
          "findings": { "inline": true, "type": "findings", "mime": "application/json",
                        "content": "{\"items\":[{\"severity\":\"P1\",\"msg\":\"missing await\"}]}",
                        "truncated": false },
          "status": "completed" },
        { "agent": "gemini", "eligible": true, "verdict": "approve", "max_severity": "P2",
          "findings": { "inline": true, "type": "findings", "mime": "application/json",
                        "content": "{\"items\":[{\"severity\":\"P2\",\"msg\":\"style nit\"}]}",
                        "truncated": false },
          "status": "completed" }
      ],
      "excluded": [ { "agent": "codex", "reason": "produced_by_agent_id (author)" } ],
      "errors": []
    } } }
```

### D2. approval `approval_requested` 的 `details` inline 形态(§7)

```jsonc
{ "jsonrpc": "2.0", "method": "events.event",
  "params": { "subscription_id": "sub_1", "seq": 40, "ts": 1718600200, "category": "approval",
              "name": "approval_requested", "run_id": "run_abc",
    "payload": { "approval_id": "ap_1", "kind": "merge_approval",
                 "reason": "merge-gate requires human", "expires_at": 1718603000,
                 "provenance": { "step_id": "step_5", "artifact_id": "art_pr_1" },
                 "details": { "inline": true, "type": "approval_details", "mime": "application/json",
                              "content": "{\"pr\":\"art_pr_1\",\"files_changed\":3,\"summary\":\"merge to main\"}",
                              "truncated": false } } } }
```
