# HOLP 协议面契约清单(catalog)

> 本文件是 `spec.md` 的派生索引,语义以 `spec.md` 为准,本文件只做清单与回链,不重新定义语义。

适用版本:**v0.1.5 (draft)**。回链中的 `§N` 指 `protocol/spec.md` 的章节号。
目的:让 review 者和实现者无需通读 spec,就能一次拿到完整的方法 / 事件 / 错误码 / capability / 语义边界清单,且每条都能回链到 spec 的具体章节。

---

## (a) 方法清单(9 个)

控制面方法均为 client→server 的 JSON-RPC request/response(带 `id`);事件面是 server→client 的 notification(见 (b))。

| 方法名 | 方向 | 一句话用途 | spec § |
|---|---|---|---|
| `initialize` | client→server | 握手:双方报身份 + 细粒度 capability 协商(descriptor 交集) | §2 |
| `flock.declare` | client→server | push:把「有哪几家 agent、什么 transport/roles」声明为数据(intent),并要求回执能表达 runtime surface / isolation readiness matrix | §3.1 / §3.4 |
| `flock.discover` | client→server | pull:让 orchestrator 主动探测本地 agent 的安装/登录/版本,并返回 runtime surface / isolation readiness matrix | §3.2 / §3.4 |
| `orchestrate.run` | client→server | 发起编排目标:派单 roles、reviewer panel/quorum、execution_mode、policy | §4 |
| `events.subscribe` | client→server | 订阅某 run 的事件流(立即返回 `subscription_id` + `latest_seq`) | §5 |
| `events.unsubscribe` | client→server | 取消某 `subscription_id` 的订阅 | §5 |
| `approval.resolve` | client→server | 人在回路对某 `approval_id` 拍板(approved/rejected) | §7 |
| `task.cancel` | client→server | 取消整个 run(幂等;对 pending approval 触发 `approval_cancelled`) | §7.5 |
| `artifact.get` | client→server | 按 `artifact_id` 取回 artifact 内容(永远返回 `content`,不返回 `content_ref`) | §8.2 |

> 说明:`spec.md §1` 把控制面方法统一描述为 client→server 方法调用;没有「双向」request 方法。server→client 仅有事件 notification(无 `id`),不在本表(见 (b))。

---

## (b) 事件清单(按 5 个 category 分组)

事件均为 server→client 的 JSON-RPC notification,载体方法为 `events.event`(每条带 `subscription_id`、`seq`、`ts`、`run_id`、`category`、`name`、`payload`)。心跳为 `events.heartbeat`、背压关订阅为 `events.error`(`slow_consumer`),不属于下列五个 category。`category` 是封闭枚举,合法值仅以下五个。

### category = `run`(§5)

| name | 一句话 | spec § |
|---|---|---|
| `run_started` | run 受理后开始 | §5 |
| `run_triaging` | run 进入分诊阶段 | §5 |
| `run_reviewing` | run 进入评审阶段 | §5 |
| `run_fixing` | run 进入修复阶段 | §5 |
| `run_merged` | run 成功合并(自然终态) | §5 |
| `run_blocked` | run 被阻塞 | §5 |
| `run_gave_up` | run 放弃/被取消的终态(`task.cancel` 完成后 payload `{reason:"cancelled"}`) | §5 / §7.5 |

### category = `agent`(§5)

| name | 一句话 | spec § |
|---|---|---|
| `agent_selected` | 为某角色选定 agent | §5 |
| `step_started` | 某 agent step 开始 | §5 |
| `tool_called` | agent 发起一次工具调用 | §5 |
| `tool_result` | 工具调用返回结果 | §5 |
| `fs_edited` | agent 编辑了文件系统 | §5 |
| `agent_failed` | 某 agent step 失败 | §5 |

### category = `consensus`(§5 / §6)

| name | 一句话 | spec § |
|---|---|---|
| `consensus_verdict` | 共识聚合裁决(outcome/quorum/reviews/excluded/errors) | §6 / §6.1 |
| `consensus_degraded` | quorum 降级或 escalate(`met:false` 只出现在此或 escalate) | §6.2 |

### category = `approval`(§5 / §7)

| name | 一句话 | spec § |
|---|---|---|
| `approval_requested` | 需要人拍板(带 kind/expires_at/provenance/details) | §7 |
| `approval_resolved` | 人已决定(`state:resolved`,带 decision/by) | §7 |
| `approval_expired` | 超时无人 resolve,server 自动终态 | §7 |
| `approval_cancelled` | 因 `task.cancel` 取消 run 而对 pending approval 终态 | §7 |

> approval 是单通道状态机:`requested → resolved | expired | cancelled`,每个转移一条对应事件;无独立 `approval.request` notification、无 `approval.cancel` 方法(§7)。

### category = `lifecycle`(§5)

| name | 一句话 | spec § |
|---|---|---|
| `escalated` | 升级给人处理 | §5 |
| `lease_stolen` | lease 被并发抢占 | §5 |
| `circuit_open` | 熔断打开 | §5 |

### artifact 不是事件 category

**artifact 不是事件 category**(是 `artifact.get` 方法 + envelope ref)。大 payload/evidence 默认走 artifact envelope(`findings`、`details` 等位置),按 `artifact_id` 经 `artifact.get` 取回;它只是事件 payload 内的引用形态,不构成独立的事件 category。见 §8 / §8.1 / §8.2。

---

## (c) 错误码清单

JSON-RPC error object:`{ code, message, data }`。HOLP 专用码用区间 `-32000 ~ -32099`,一错误一 code。可重试列只对 transient 错误标 ✓(§10:`missing_auth`/`lease_stolen`/`run_locked`)。

### HOLP 专用错误码(21 个,§10)

| code | 名称 | 触发 | 可重试? | spec § |
|---|---|---|---|---|
| -32001 | `protocol_version_mismatch` | initialize 版本协商失败(major 不匹配) | | §9 / §10 |
| -32002 | `capability_required_but_unsupported` | 某 capability 一方 required 但对方 supported:false(连接级) | | §2 / §10 |
| -32003 | `approval_required_but_unsupported` | run 会触发 approval 但 client `approval.supported:false` | | §2 / §7 / §10 |
| -32004 | `quorum_unsatisfiable` | 两段式校验不满足:第1段静态形状不够受理时报,或第2段排除作者后不够且 `policy.on_quorum_unsatisfiable=reject` | | §6.2 / §10 |
| -32005 | `unsupported_transport` | flock 某 agent transport 无 adapter(单点 role 受理时才是 error) | | §10 / §10.1 |
| -32006 | `missing_auth` | agent 凭证探测失败 | ✓ | §10 / §10.1 |
| -32007 | `invalid_quorum` | quorum 形状非法:≤0 / > panel / panel 空 / panel 含 rejected agent / 全部 excluded | | §6.2 / §10 |
| -32008 | `run_not_found` | 操作不存在的 run | | §7.5 / §10 |
| -32009 | `approval_not_found` | `approval.resolve` 的 approval_id 不存在 | | §7 / §10 |
| -32010 | `approval_already_resolved` | `approval.resolve` 对已终态 approval(race 输方) | | §7 / §10 |
| -32011 | `lease_stolen` | 并发/lease 被偷 | ✓ | §10 |
| -32012 | `run_locked` | run 被锁 | ✓ | §10 |
| -32013 | `unsupported_execution_mode` | `execution_mode.kind` ≠ "Local" | | §4.1 / §10 |
| -32014 | `artifact_not_found` | `artifact.get` 的 id 不存在 | | §8.2 / §10 |
| -32015 | `artifact_expired` | artifact 已过 `expires_at` | | §8.3 / §10 |
| -32016 | `artifact_forbidden` | client 无权读该 artifact | | §8.2 / §10 |
| -32017 | `invalid_subscription` | `events.unsubscribe` / 事件路由用了无效 subscription_id | | §5 / §10 |
| -32018 | `role_unsupported` | 派给某 agent 的角色不在其 `resolved_roles`(或 degraded 缺该角色) | | §4.2 / §10 |
| -32019 | `agent_not_found` | 引用本连接 flock 从未返回过的 agent id | | §4.2 / §10 |
| -32020 | `invalid_event_category` | `events.subscribe.categories` 为空数组或含未知 category | | §5 / §10 |
| -32099 | `internal_error` | 兜底 | | §10 |

### HOLP 也用的 JSON-RPC 标准错误码

| code | 名称 | 触发 | 可重试? | spec § |
|---|---|---|---|---|
| -32600 | `invalid_request` | 请求本身格式非法(如 flock 无 agents 字段、transport 非法字符串) | | §10.1 |
| -32601 | (method not found) | 调用未知方法 | | §10.1 |

---

## (d) capability 清单(4 个,§2)

每个 capability 是 descriptor `{ supported, required?, kinds? }`:`supported` = 本端是否支持;`required` = 是否硬要求对方支持(连接级,缺省 false);`kinds`(仅 approval)= 支持/要求的 kind 子集。缺省 capability(descriptor 未出现)= `{supported:false}`。协商 = 双方 descriptor 交集。

| 名称 | descriptor 字段 | 不可用时行为 | spec § |
|---|---|---|---|
| `consensus` | `{ supported, required? }` | server 不发 `consensus_verdict`,run 退化为单 agent(或 client 在 `orchestrate.run` 显式接受无共识) | §2 |
| `approval` | `{ supported, required?, kinds? }` | server 不得发起会触发 approval 的 run;若 run 的 `require_human_gates` 非空且 client 不支持 → 受理前 reject `approval_required_but_unsupported`。`kinds` 取交集:任一方 `required:true` 且交集为空 → initialize 拒绝;双方都非 required 但交集为空 → 不拒连接,run 触发该 kind 时按 §7/§11 降级或 escalate | §2 / §7 / §11 |
| `unattended_loop` | `{ supported, required? }` | 不支持时无人值守循环能力缺失,按 descriptor 协商 + `on_capability_gap`(§11)处置 | §2 / §11 |
| `artifact_refs` | `{ supported, required? }` | server 不得用 artifact envelope 承载大 payload/evidence;`reviews[].findings`、approval `details` 改放内联降级形态(`{inline:true,...}`);只控 evidence envelope,不控 provenance/identity 的裸 `artifact_id` | §2 / §6.1 / §7 / §8.1 |

> 任一方 `capability.required:true` 但对方 `supported:false` → `initialize` 拒绝(`capability_required_but_unsupported`)。run 级硬要求不放 descriptor,放 `orchestrate.run` params(§2)。

---

## (e) 语义边界清单

| 边界 | 一句话 | spec § |
|---|---|---|
| artifact_refs 只控 evidence envelope | `artifact_refs` 仅决定是否用 artifact envelope 承载大 payload/evidence(`findings`/`details`);不控制 provenance/identity 字段里的裸 `artifact_id`(如 `target.artifact_id`、`provenance.artifact_id`)——这些 id 只关联已知产物身份,不承诺可取回大 payload,也不受该能力控制 | §2 / §6.1 / §7 / §8.1 |
| artifact_refs 不可用→内联降级 | 不可用时 consensus `reviews[].findings` 与 approval `details` 改放内联对象 `{inline:true,type,mime,content,truncated}`,不放 envelope、不带 `artifact_id`;`outcome`/`quorum`/`excluded`/`errors` 等聚合字段不受影响 | §6.1 / §7 |
| unknown agent → `agent_not_found` | 引用本连接 flock 从未返回过的 agent id(连接级会话状态,不跨连接共享)→ 独立错误码 `agent_not_found`(-32019);最先校验 | §4.2 / §6.2 / §10 |
| invalid category → `invalid_event_category` | `events.subscribe.categories` 为空数组或含未知 category 字符串 → 独立错误码 `invalid_event_category`(-32020);`categories` 是封闭枚举(run/agent/consensus/approval/lifecycle),省略或 null = 全订 | §5 / §10 |
| role mismatch → `role_unsupported` | 被派 agent 的 `resolved_roles` 不含目标角色(或 degraded agent 缺该角色)→ 独立错误码 `role_unsupported`(-32018) | §4.2 / §6.2 / §10 |
| rejected agent 按用途分流 | known-but-rejected agent:用于 reviewer panel → 走 §6.2 形状校验 `invalid_quorum`(panel 含 rejected);用于单点 role(coder/architect/tester 等)→ 走 `unsupported_transport`/`missing_auth` | §4.2 / §6.2 / §10.1 |
| degraded agent 条件可用 | known-but-degraded agent:仅当其 `resolved_roles` 含目标角色且声明/发现未把该角色标缺失时可用;否则按 role 不匹配走 `role_unsupported` | §4.2 / §6.2 |
| runtime surface matrix 是必备语义 | `ready` 不表示 agent 整体可用,只表示某个 runtime surface + isolation profile 下可调度。`flock.declare`/`flock.discover` 必须能表达 `headless`/`acp`/`direct_user_session`、runtime kind、direct channel、isolation readiness、state declaration ref、global mutation risk;当前实现可以返回 unknown/unsupported/rejected,但空白不是合格声明 | §3.4 |
| direct_user_session 必须显式声明 | Happy/Happier product session 与 Warp/cmux/tmux terminal session 不能从 headless/ACP adapter 自动推导;必须声明 attach/inject/interrupt/cancel、owner scope 和 route/session 隔离边界 | §3.4 |
| 错误码定序固定 | 引用合法性(`agent_not_found`)→ role 匹配(`role_unsupported`)→ quorum 形状(`invalid_quorum`)→ 策略不足(`quorum_unsatisfiable`),四段不重叠 | §6.2 |
| Remote 不进 v0.1.x wire | `execution_mode.kind` 唯一合法值 `"Local"`;其他值 → `unsupported_execution_mode`(-32013)。Remote(workspace sync/secret scope/artifact transport/network/cost/identity)留独立扩展 proposal,当前 wire 不含任何 Remote 形状,届时作为新 minor + capability `remote_runner` 引入 | §4.1 / §10 |
| flock 永远部分成功 | `flock.declare`/`flock.discover` 永远返回 per-agent `status`(ready/degraded/rejected + reason + missing),不抛 JSON-RPC error(哪怕全部 rejected);`unsupported_transport`/`missing_auth` 作为 `status=rejected` 的 reason;只有请求格式非法才抛 `invalid_request`(-32600) | §3.3 / §10.1 |

---

## 对照 spec.md 发现的矛盾/缺口

none
