# PR14 / M8 Real Runtime Surface Harness Pilot

## Summary

实现 Blueprint M8:把 runtime/session matrix 从声明推进到第一批真实 harness 路径。第一批 harness 固定为 Cursor Agent、Kimi Code、OpenCode、Pi、Reasonix;每个 harness 都要覆盖 headless/run 与 ACP 目标,并接第一条真实 `direct_user_session` path。

这不是“多写几行 readiness”。验收必须能启动真实 headless backend 或真实 ACP session,并通过 HOLP daemon wire 选中、运行、记录 governance。

当前代码现实:

- live registry 只有 `mcp-codex`、`native-claude`;`acp` 是 honest stub。
- `resolveRuntimeSelection` 固定选择 `headless`。
- `reviewerExecutionConfig` 对新 transport 默认 `unsupported`。
- `issue-to-pr` 已有 Cursor/Kimi/OpenCode headless 命令经验;本机调研确认 Pi headless/ACP 可测,Reasonix headless 可测但 ACP `session/new` 仍 degraded。
- ACP 官方模型是 JSON-RPC over stdio;OpenCode 官方文档提供 `opencode acp`;Cursor/Kimi/Pi/Reasonix 以本机技能和 smoke 为准。

## Key Changes

- 新增 harness registry entries。
  - transport ids:`cursor-agent`、`kimi-code`、`opencode`、`pi`、`reasonix`。
  - 每个 transport 提供 probe、backend factory、runtime surface declaration。
  - headless path 必须能跑真实 prompt,产出 model output / fs edit / terminal summary。
  - ACP path 必须能 initialize + session/create + prompt/update + terminal;Reasonix ACP 在修到 `session/new` 稳定前只能 `degraded`,不能 ready。
  - registry resolution 必须从 `resolve(transport)` 升级为按 `(transport, runtime_surface)` 解析 backend;同一 transport 的 headless 和 ACP 必须能解析到不同 backend kind。

- 定义 backend fidelity contract。
  - headless one-shot CLI 可以作为真实执行路径,但必须声明 fidelity:`one_shot`。它不能声称 mid-turn permission interception;approval-required run 若只能走 one-shot 必须 accept-time fail-closed 或选择 ACP/direct。
  - ACP/direct session 可以声明 fidelity:`streaming_controlled`,前提是能转发 updates、permission/cancel、terminal。
  - 每个 run 的 actual fidelity 必须写入 runtime metadata/governance,不能只看静态 matrix。
  - one-shot success 不能只看 exit code 0;必须至少有非空 machine-checkable output 或 transport-specific success marker,且不得包含 known auth/permission/error prompt。
  - 如果 permission requirement 不能在执行前确定,且 backend 没有 permission ledger/streaming interception,该 run 必须改选 ACP/direct 或 reject,不能静默执行。

- 新增通用 ACP thin client。
  - 只实现 HOLP 需要的最小 ACP client:spawn process、initialize、new session、send prompt、stream updates、cancel/dispose。
  - 不把 ACP SDK/IDE 产品状态搬进 HOLP。
  - ACP errors、tool permission、timeout、process exit 必须 fail-closed,并写入 governance。
  - ACP terminal mapping 必须固定:process_exit/stdout_eof -> error,parse_error -> error,no_terminal_within_timeout -> timeout,permission_denied -> deny,missing_final_result -> timeout/error。
  - ACP completion contract:只有 explicit terminal/completed signal 或 protocol-defined final update 才能成功;最后一条普通 update 不得被强行当 success。
  - coder path 和 reviewer path 都必须有 transport-level timeout,不能只给 reviewer executor 加 timeout。

- 接入 first real direct_user_session path。
  - 选择一条本机可验证路径,优先 tmux/PTY terminal session,实现 attach/observe/read/inject/interrupt/cancel 的最小闭环。
  - direct channel 必须声明 observation 与 control 能力;缺 inject/interrupt/cancel/owner_scope 时不可调度为 ready。
  - direct ready 必须具备 capability bitmask:`observe/read/inject/interrupt/cancel/owner_verified`;任一缺失只能 degraded/rejected。
  - direct path 必须通过 `orchestrate.run` 真实选中并执行一条 smoke,不是只在 matrix 报告里出现。
  - 第一条 direct path 必须绑定 HOLP 创建并拥有的 throwaway tmux/PTY session;attach 到既有用户 shell/session 时 `owner_scope` 必须 rejected。
  - session provenance 必须记录 `session_origin:"holp_created"` 和 `session_id` namespace,例如 `holp-*`。
  - session route 缺失或歧义必须 fail-closed,不得向未知 session inject。
  - 本 PR 不解决 Issue #11 的 provider 全局 config/hook/log 隔离;direct smoke 必须在 throwaway session/workspace 中跑,并保持 `declared_not_enforced:true` 直到有真实隔离。

- runtime selection 从固定 headless 升级为可选。
  - 协议新增可选字段:`roles.<role>.preferred_runtime_surface` = `headless | acp | direct_user_session`。
  - resolution order 固定:role `preferred_runtime_surface` -> transport/role default surface -> legacy headless default。
  - legacy headless default 只用于缺字段的旧 consumer;显式请求 ACP/direct 失败时不得 fallback headless。
  - degraded runtime 默认不可被 `orchestrate.run` 选择,除非 run policy 显式允许该 degraded reason;rejected 永不可选。
  - ACP/direct selection 必须写入 `RunRecord.runtime` 和 governance `runtime_selected`。
  - 必须同步 `protocol/spec.md` 和 `protocol/version.md`;未知 runtime value 走 invalid_request,缺省字段保持当前 headless 行为。
  - `runtime_selected`、actual fidelity、readiness 一旦 run 开始即 immutable;不能事后把 degraded 改写成 ready。

- reviewer/tester/architect headless path。
  - 新 transports 的 read-only reviewer/tester/architect role 必须支持 `read_only_review` profile。
  - real reviewer parser/validator 仍沿用 PR9 canonical path;completed 缺 verdict/max_severity 必须 fail-closed 为 error。
  - reviewer run 必须强制 CLI 输出 strict JSON-only stdout;禁止从 prose 中 regex 抠 JSON。
  - `reviewerExecutionConfig` 必须显式 exhaustively 支持 registry 中声明 reviewer-ready 的 transports;缺实现是 config incomplete hard error,不是静默 `unsupported`。
  - `read_only_review:ready` 只能在有真实写入阻断机制时声明。只有 `--force`、`--dangerously-skip-permissions` 或提示词约束时必须 degraded/declared_not_enforced,其 vote 按 attestation 失败处理。

## Harness Matrix Target

- Cursor Agent:
  - headless command 参考 `cursor-agent -p ... --output-format text --force`。
  - 认证失败即使 exit 0 也要按输出检测 fail-closed。
  - ACP ready 以本机 adapter/smoke 通过为准。

- Kimi Code:
  - headless command 强制 Coding Plan alias:`kimi -p ... -m kimi-code/kimi-for-coding --output-format text`。
  - ACP ready 以本机 `initialize/session/prompt` smoke 通过为准。

- OpenCode:
  - headless command 参考 `opencode run`。
  - ACP command 参考官方 `opencode acp`。
  - 自动化必须固定 profile/model/permission,不能吃用户交互 TUI 状态。

- Pi:
  - headless/run 与 `pi-acp` bridge 都必须 smoke。
  - bridge 失败时不得把 headless ready 扩展成 ACP ready。

- Reasonix:
  - headless/run 必须 ready。
  - ACP 当前按 degraded 记录,并必须保留 `session/new` 失败 reason。
  - PR14 完成不被 Reasonix upstream 修复卡死:完成条件是 Reasonix ACP 诚实 degraded + 至少一个其他 first-batch harness 的 ACP path ready 且可被 `orchestrate.run` 调度。Reasonix ACP ready 作为 follow-up gate。

## Test Plan

- Unit tests:
  - 每个 transport 的 probe 能返回完整 headless/acp/direct matrix。
  - unsupported/unknown surfaces 的 isolation profiles 不会被当作 ready。
  - runtime selector 能按 role 选择 headless/acp/direct,并在缺声明时 fail-closed。
  - 同一 transport 的 headless/acp 解析到不同 backend kind;unsupported `(transport,surface)` 不回退 headless。
  - unknown `preferred_runtime_surface` invalid_request;字段缺省保持 headless。
  - 显式请求 ACP/direct 失败时不会 fallback headless。
  - degraded Reasonix ACP 不会被普通 `orchestrate.run` 调度,除非 policy 显式允许该 degraded reason。
  - ACP client 对 process exit、timeout、malformed JSON、missing final result 都返回 rejected/error。
  - ACP server 在 first update 后退出时,run 不挂死并收敛为 terminal。
  - ACP 普通 update 后没有 terminal/final signal 时不得成功。
  - cancel、timeout、late partial update race 只产生一个 terminal。
  - exit 0 + empty output 或无 success marker 的 headless run 是 invalid result。
  - one-shot headless 遇到 approval-required run 时 fail-closed 或改选 streaming runtime,不得 silent auto-approve。

- Integration / smoke tests:
  - 每个 first-batch harness 至少一条 opt-in headless smoke。
  - 每个 first-batch harness 一条 opt-in ACP smoke;Reasonix 当前允许 degraded,但必须记录失败 reason;至少一个非 Reasonix ACP smoke 必须 ready 并可调度。
  - direct_user_session smoke 真 attach/read/inject/cancel,且 session 必须由 HOLP 创建并拥有。
  - `orchestrate.run` 用 ACP runtime 执行一条 run 并保存 runtime metadata。
  - reviewer/tester/architect read-only headless path 真走 strict parser/validator,异常/prose 输出 fail-closed。
  - read-only reviewer smoke 必须做 deny-write check;未阻断写入不得标 ready。

- Verification:
  - `npm run typecheck`
  - `npm test`
  - opt-in harness smoke suite,例如 `HOLP_REAL_HARNESS_SMOKE=1 npm run smoke:harnesses`
  - `git diff --check`
  - `npx gitnexus detect-changes --repo holp`

## Acceptance Criteria

- `flock.discover` 能发现并探测第一批 5 个 harness。
- 至少 headless 和 ACP 两类真实 runtime surface 都可被 `orchestrate.run` 调度。
- direct_user_session 有一条真实可运行路径。
- runtime/session matrix 如实区分 ready/degraded/rejected/unknown,没有空白冒充 ready。
- 新 adapters 只读取 env/CLI 默认登录状态,不得把 provider account switching、quota recovery、backend catalog 搬进 HOLP 协议或 daemon。
- probe 是诊断/声明来源,不得产生会话副作用;factory 才能创建可执行 session。

## Out Of Scope

- 不接 Kilo/Cline/Mimo 进第一批。
- 不实现 Remote。
- 不把 provider account/quota switching 写进 HOLP 协议。
- 不声称 12-agent/runtime adapter 全覆盖。
