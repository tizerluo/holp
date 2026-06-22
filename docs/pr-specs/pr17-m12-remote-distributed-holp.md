# PR17 / M12 Remote And Distributed HOLP

## Summary

实现 Blueprint M12:第一条完整 Remote / distributed HOLP 路径。目标是让 HOLP 可以把 run 派到远端 runner,同时保留 local-first safety、approval、artifact、event、runtime readiness 和 consumer 可观测性。

这不是 remote declaration。验收必须有真实 remote runner、真实 artifact/event/approval relay、真实 cancel/timeout/failure handling,并能从 reference consumer 看见完整 run。

当前代码现实:

- protocol 当前只允许 `execution_mode.kind="Local"`。
- runtime matrix 已能表达 remote 作为未来 surface,但没有 wire。
- governance/event/artifact/approval 都是本地内存 store。
- open issue inputs 提到 Warp Remote Agent Mode 与 SkyPilot jobs/metrics,但 HOLP 只吸收 remote runner 形状,不复制产品账号/cloud 假设。

## Key Changes

- 新增 remote capability 和 execution mode。
  - `initialize.capabilities.remote_runner` 协商。
  - `orchestrate.run.execution_mode.kind` 增加 `Remote`。
  - Remote params 必须有具体 wire schema:
    `execution_mode:{kind:"Remote", runner_id, workspace:{source_kind:"git_ref"|"snapshot_ref", ref, sha256}, secret_scope:[{ref, scope}], artifact_policy:{mode:"relay"|"fetch_on_demand"}, network_policy, cost_policy:{max_relay_reconnects}, timeout_ms}`。
  - client/server 未协商 remote 时 fail-closed。
  - 新增错误码/错误语义:`remote_not_negotiated`、`invalid_remote_params`、`runner_not_found`、`runner_unhealthy`、`remote_artifact_unreachable`、`relay_exhausted`。
  - protocol/version/server/CLI smoke 必须同步到 Remote minor version,同时证明 Local 旧路径兼容。

- 新增 remote runner contract。
  - runner probe 返回 health/readiness/runtime matrix。
  - runner 能接收 workspace context,启动 selected harness,转发 events/artifacts/approvals,执行 cancel/dispose。
  - runner identity、version、capabilities、last health check 写入 governance。
  - `runner_id` 只是 registry key,不是 trust boundary。daemon/runner 必须建立 `runner_session` handshake,包含 `session_id`、`runner_instance_id`、monotonic nonce;本地 fake runner 也必须走同一 handshake。
  - relay frame 必须绑定 runner_session;未知 session、nonce 回退或重复 frame 签名/校验不一致必须拒绝。
  - runner 建模必须明确:要么作为 distinct runner registry,要么把 `remote` 加入 `RuntimeSurface` 并作为 flock surface。PR17 必须二选一并同步 resolveRuntimeSelection;不得同时混用。
  - M12 只需要 single named `runner_id`,不做 fleet scheduler。
  - acceptance fake/local remote runner 必须跨真实序列化边界运行:独立 child process + NDJSON/stdout 或 socket frame;禁止 in-process function-call shortcut。

- artifact/event/approval relay。
  - remote event relay frame 必须包含 `(runner_id, remote_run_id, remote_seq, event_id)`;daemon 用该 tuple 幂等映射到本地 seq。
  - 重放/重复 remote event 不得分配新 local seq;remote events 必须按 remote_seq 严格应用。
  - out-of-order event 可进入 bounded pending buffer;gap 超过窗口或 timeout 后发 `relay_gap` lifecycle event,并把 run 标 degraded/blocked by policy,不能静默跳过。
  - artifact envelope 支持 remote origin、sha256、size、fetch policy。`relay` 模式 eager push content,`fetch_on_demand` 模式由 daemon lazy fetch;runner 不可达时返回 `remote_artifact_unreachable`。
  - fetch_on_demand 必须幂等,按 policy 限制 retry;只返回 success、temporary_unavailable、permanent_unavailable。
  - approval 仍由本地 HOLP consumer 单通道处理;remote 不得绕过本地 approval。
  - approval relay frame 必须双向定义:runner->daemon `approval_request{remote_approval_id,...}`;daemon->runner `approval_verdict{remote_approval_id,decision}`。verdict 超时未送达则 run blocked/gave_up。
  - remote approval lifecycle 固定:`pending | approved | denied | timed_out | superseded`;runner 在 approved 前不得乐观继续。timeout 后到达的 verdict 必须 ignored/superseded,不能改 run state。
  - cancel/timeout 必须同时更新 local run state 和 remote runner state;run terminal 后到达的 remote events 必须被 drop,不得出现在 terminal 后。
  - terminal 时 daemon 必须发送 `terminate{run_id,reason,terminal_seq}` 给 runner;runner 只能回 `terminate_ack`,不得继续发业务 event。

- remote safety model。
  - local-first 默认:Remote 必须显式 opt-in。
  - secret scope 默认最小化,不得传明文 provider credentials。HOLP 只 relay secret ref;secret value 必须 runner-side resolve。
  - raw/debug frame 和 CLI 输出必须通过 sentinel credential 测试,确认不泄露明文 secret。
  - workspace 必须是 content-addressed ref,不能 inline 大量 workspace bytes;runner 启动前必须校验 sha256,不匹配则 `workspace_integrity` blocked。
  - remote runtime/isolation declaration 不等于真实 sandbox;readiness 必须可追踪。
  - network/cost/quota failure 必须成为 run_gave_up/run_blocked,不能静默 retry 到失控。
  - relay reconnect 必须受 `cost_policy.max_relay_reconnects` 和 bounded backoff 限制;耗尽后 `relay_exhausted` terminal。
  - backoff 使用 seeded exponential jitter,测试中可复现。
  - runner 必须发送 heartbeat;Remote params/runner config 必须包含 `heartbeat_interval_ms`、`heartbeat_timeout_ms`、degraded/unhealthy missed thresholds。
  - degraded runner 可继续当前 run 但阻止新 dispatch;unhealthy 或 timeout_ms 超限时本地终结 run,防止 zombie。
  - runner restart/reconnect 必须定义 replay model:runner 重新 handshake 后从 last committed remote_seq 继续或请求 replay window;daemon 是本地 consumer event truth。

- consumer/report。
  - CLI 显示 remote runner、workspace snapshot、remote harness、health/readiness、relay latency、artifact origin、approval/override audit。
  - CLI 必须提供 structured JSON report mode,带 schema version,用于 CI diff。
  - raw/debug 可显示 remote protocol frame,默认输出不泄露 secret。

## Test Plan

- Unit tests:
  - Remote execution mode 协商和 validation。
  - remote event seq mapping。
  - duplicate remote event 不分配新 local seq;remote seq gap 发 relay gap event。
  - out-of-order remote events 在 bounded window 内按序应用;超窗/超时后发 relay_gap。
  - artifact envelope remote origin/hash validation。
  - fetch_on_demand runner 不可达时返回 `remote_artifact_unreachable`。
  - approval relay 不允许 remote 直接 resolve。
  - approval verdict frame 送达 runner 后才 resume remote turn。
  - late verdict after timeout 被 ignored/superseded。
  - timeout/cancel 状态机无 double terminal。
  - terminal 发送 terminate,runner 只回 terminate_ack。
  - terminal 后 late remote event 被 drop。

- Integration tests:
  - local fake remote runner 必须作为独立进程端到端 run:workspace snapshot -> remote harness -> event relay -> approval -> artifact -> terminal。
  - remote cancel 在 pending approval / running backend 两种状态都能收敛。
  - runner silent/crash mid-turn 在 watchdog 内 terminal,没有 zombie。
  - runner restart/reconnect 从 last committed remote_seq 恢复或按 replay window 补齐。
  - remote runner health degraded 时 accept-time fail-closed 或按 policy blocked。
  - sentinel secret 不出现在任何 relay frame、raw/debug CLI 输出或 artifact。
  - reconnect 超过 `max_relay_reconnects` 后 terminal。
  - consumer CLI 显示 remote report。

- Verification:
  - `npm run typecheck`
  - `npm test`
  - remote fake-runner smoke command
  - `git diff --check`
  - `npx gitnexus detect-changes --repo holp`

## Acceptance Criteria

- 一个 `execution_mode.kind="Remote"` 的 run 能通过 reference daemon 和 fake/local remote runner 完整跑通。
- 本地 consumer 能审批、取消、查看 artifact 和完整事件流。
- remote runner failure 不会产生僵尸 run 或绕过本地 approval。
- protocol 文档明确 Remote 是新 minor capability,Local 旧路径完全兼容。

## Out Of Scope

- 不实现 Warp cloud account / SkyPilot cluster 产品功能。
- 不要求真实 Kubernetes provider。
- 不把 remote secret management 做成 HOLP 核心协议;只定义最小 secret scope/ref 语义。
