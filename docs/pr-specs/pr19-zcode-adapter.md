> status: open

# PR19 ZCode adapter registry entry

## Summary

把 ZCode 作为独立 transport `zcode` 接入 HOLP default adapter registry,覆盖 headless CLI 与 direct_user_session 两个可执行面,并对 ACP 面做诚实降级声明。需求来自 holp-mcp `docs/zcode-absorption.md` 的 "(b) 类缺口 upstream 建议清单" 第 1-4、6、7 条。

本 PR 不扩 `FIRST_BATCH_TRANSPORTS`;该 cohort 是 #45 冻结语义。ZCode 只作为独立 registry entry 加进 `createDefaultAdapterRegistry()`,形状对齐 `mcp-codex` 的 per-surface 注册方式。

## Scope

1. **Default registry entry**
   - 新增 transport id:`zcode`,vendor:`ZCode`。
   - `headless` 解析到 ZCode CLI backend。
   - `direct_user_session` 解析到 direct-tmux backend。
   - `acp` 不提供 backend factory,避免 explicit ACP 调度 fallback 到 headless。

2. **Headless CLI surface**
   - command:`zcode`。
   - args:`["--prompt", prompt, "--mode", mode, "--json", "--cwd", cwd]`。
   - mode 映射:默认 `build`;只读 review profile 为 `plan`。
   - 完成判定:rc 0 + stdout 中最后一个合法 JSON object 的 `response` 字段。
   - stdout 解析必须容忍 AI SDK warning 前缀,只从行首 `{` 开始扫描 JSON block。
   - 声明 `actual_fidelity:"one_shot"`;不声明 streaming。

3. **Direct user session surface**
   - direct-tmux command:`zcode`。
   - args:`["--prompt", prompt, "--mode", "build", "--json"]`,不带 `--cwd`;cwd 由 pane 提供。
   - 完成判定复用 direct-tmux marker 与 `stripEchoedMarkerCommand`。
   - 不声明 `supportsModelId`;声明了 model 时沿用 direct-tmux fail-closed `direct_tmux_model_unsupported`。
   - 凭证依赖交互 zsh pane 的用户 `~/.zshrc` zcode function;definition 不注 key。

4. **Headless credential injection**
   - spawn 前读取 `~/.zcode/v2/config.json` 的 `provider` 段 enabled provider。
   - 注入 `ANTHROPIC_API_KEY`、`ZCODE_BASE_URL`、`ZCODE_MODEL` 到子进程 env。
   - canonical model id 使用 config models 的原始 key,优先 `GLM-5.2`,否则取第一个 model key。
   - `apiKey` 不进入日志、错误消息或事件 payload。
   - config 缺失、格式无效或无 enabled provider 时:probe degraded,spawn fail-closed。
   - per-run env 只允许非机密 `ZCODE_MODEL` / `ZCODE_BASE_URL` 覆盖 config 值。

5. **ACP honest unsupported declaration**
   - `runtime_surface:"acp"` 声明 `surface_support:"unsupported"`。
   - readiness reason:`zcode_acp_bridge_unwired`。
   - 不实现 bridge adapter,不声明 ready。升级必须依赖真实 ACP 协议证据,对齐 #51 discipline。

6. **Probe**
   - 检查 binary exists + `--version`,记录 CLI version。
   - 检查 credential config 是否存在且可解析 enabled provider。
   - 默认不跑真实 headless smoke;只有 `HOLP_REAL_ZCODE_SMOKE=1` 才可把 headless 升 ready。
   - probe 只证明 CLI 面,不外推 ACP/MCP/direct ready。

## Out of scope

- ACP ready 化与 zcode ACP bridge adapter;本 PR 只声明 unsupported + readiness reason。
- item 8 prompt guard:这是 caller/reviewer prompt discipline。ZCode 本轮不进入 reviewer 名册,不在 HOLP 默认 reviewer 路径加 zcode-specific prompt guard。
- item 9 resume 语义:CLI `--resume` / ACP session resume 依赖 HOLP long-run/resume 讨论,本 PR 不接。
- MCP `zcode_review` tools 接入;它不是 HOLP worker runtime registry。

## Acceptance

- Registry tests assert `zcode` default entry has headless supported/one-shot declaration, direct declaration, and ACP unsupported declaration with readiness reason.
- Headless tests use fake zcode script that emits warning prefix before JSON; adapter extracts `response`.
- Headless rc nonzero fails closed.
- Headless credential fixture uses fake key in a temp config; no real `~/.zcode/v2/config.json` is read by tests.
- Headless missing config fails closed and probe reports degraded with missing credential config reason.
- Direct fake tmux test asserts argv contains `--prompt` / `--mode` / `--json` and no `--cwd`.
- Direct model option fails closed with `direct_tmux_model_unsupported`.
- Probe does not resolve `reviewer`; ZCode is not added to the reviewer roster in this PR.
- Real ZCode smoke exists but defaults to skipped unless `HOLP_REAL_ZCODE_SMOKE=1`.
- Hard gates: `npm run typecheck` and `npm test` pass.

## Risks

- Credential injection is the main risk. Implementation must never surface `apiKey` in errors/events/test snapshots. Errors use stable reason strings only.
- 本 PR 曾考虑扩展 `surface_support` 枚举加入 `"degraded"`,但 FIXUP-1 评审后已撤回该方案;ACP 未认证状态改用既有 `unsupported` + `readiness.reason` 表达,协议枚举零改动。
- ZCode CLI `--json` stdout may include warning text; parsing must not assume the full stdout is JSON.

## e2e 验收证据(2026-07-08,真机)

1. gated smoke:`HOLP_REAL_ZCODE_SMOKE=1 npx vitest run adapters/zcode.test.ts` -> 17/17 全绿 0 skip;probe 真跑一轮 `zcode --prompt` 拿到 `HOLP_OK` 升 ready。
2. e2e 真单:MCP stdio client 经 holp-mcp `holp_run({goal: 'Reply with exactly: ZCODE_HOLP_E2E_b7c1', worker: zcode-agent})` -> `direct_user_session` 真 tmux(socket `/tmp/holp/zcode-26198`),pane 内命令行 `'zcode' '--prompt' ... '--mode' 'build' '--json'`,JSON `response` 字段精确返回 `ZCODE_HOLP_E2E_b7c1`,run 终态 `merged`(`gate_report` seq 12),`run_id=run_1`,`session=holp-1783523676512-8d23a722cea06`。
3. 消费方配套:holp-mcp `configuredTransports` 需加 `zcode`(holp-mcp 仓已改,另行提交)。
