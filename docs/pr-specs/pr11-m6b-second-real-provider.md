# PR11 SPEC - M6b Second Real Provider Adapter

> 状态:implemented as M6b second real provider adapter partial。`native-claude` 通过 Claude Code headless `-p --output-format json` 接入 reviewer path。该 PR 证明 adapter contract 不是 Codex-only,但不追求 12-agent 完整矩阵,不接 ACP/direct session。

## 目的

让 HOLP 至少能编排两类真实 provider:一个 producer/coder 可以来自 Codex,一个 reviewer 可以来自第二 provider。这样 HOLP 的 vendor-neutral 主张开始有真实支撑。

## 当前代码事实

- `mcp-codex` 已是首个真实 adapter。
- `native-claude` 已接 Claude Code headless reviewer partial;`acp` 仍是 stub。
- PR9 已提供真实 reviewer execution pilot 和 canonical parser/attestation gate。
- PR10 已提供 consumer-facing CLI,能展示 reviewer selection、approval、artifact、consensus report。
- runtime surface / isolation readiness matrix 已是 v0.1.5 基准,新增 provider 不能退回 transport/status-only。
- Claude Code headless 的可用入口是 `claude -p`;Claude Code 无官方 ACP,但有自有 stream-json / JSON output、OAuth/user settings、`--allowedTools`、`--permission-mode`、`--model` 等驱动面。

## 范围

实现第二真实 provider adapter 的最小可用 headless path。默认候选为 `native-claude` reviewer adapter;如果实际本地 CLI/auth 不可用,实现必须 honest degraded/rejected,而不是假 ready。

预期产出:

- Adapter factory:
  - provider availability probe,分成 capability probe 与 enforced-tool probe 两段;只有两段都通过时才可把 `headless + read_only_review` 声明为 ready。
  - `flock.declare` / `flock.discover` 返回 honest `ready | degraded | rejected`。
  - 支持 reviewer role 的 headless execution。
  - 映射 provider output 到 HOLP reviewer result。
- Native Claude driver:
  - 必须通过 HOLP `AgentBackend` contract 接入,即 registry resolve → backend `startSession` / `sendPrompt` / `onMessage` / `cancel`;直接运行 `claude -p` 的外部验证脚本不算 adapter 接通。
  - headless 入口使用 `claude -p`。结构化输出可用 `--output-format json` 解析 `result`、`session_id`、`total_cost_usd`、`modelUsage`、`is_error`、`subtype`;若用 `stream-json`,必须同样归一化成 HOLP `AgentMessage` / reviewer result。
  - 模型参数使用 `--model <full-or-alias>`;需要 Opus 4.8 时用完整 `claude-opus-4-8`,不使用不存在的 `-m` 短参。
  - 禁止默认使用 `--bare`,因为它跳过 OAuth、hooks/LSP/plugin/auto-memory/CLAUDE.md 和 keychain;只有明确 API-key-only smoke 才可 opt-in。
  - 必须显式选择 `--setting-sources`:默认优先 project-only 以减少全局 hook/settings 污染;若用户选择的供应商配置只能通过 user/local settings 生效,可以 opt-in user/local,但必须在 runtime declaration / smoke 输出中记录 global state dependency。
- Runtime declaration:
  - `headless + read_only_review` 是首要目标。
  - `read_only_review` 只有在 reviewer session 使用受限 tool 白名单且没有写工具时才可声明 ready。默认 reviewer tools 应限于 Read/Grep/Glob/LS/WebFetch/WebSearch 及只读 git diff/status/log 等;不得包含 Edit/Write/NotebookEdit 或写入型 Bash。
  - `read_only_review` 不得使用 `--permission-mode bypassPermissions` / `acceptEdits` 搭配写工具。若必须保留写工具或绕过权限,该 profile 必须 degraded/rejected,不得进入 PR9 的 real completed vote。
  - ready 需要本次 probe 的 enforcement evidence:可接受形式包括工具白名单生效的执行 trace、写工具被拒绝的 probe 结果、或 provider 明确返回的 deny-write capability signal。只有配置声明而无 evidence 时最多 degraded。
  - read-only/tool constraints 通过 native-claude adapter 私有 options 传入,类比 `CodexAppServerBackendOptions`;不扩通用 `AgentBackendOptions`,因此不改变 adapter contract。
  - `coder_worktree` 只有在真实可安全执行时才声明 ready;否则 degraded/rejected。
  - `acp` surface 对 native-claude 必须声明 `surface_support:"unsupported"` 并 rejected profiles,因为 Claude Code 无官方 ACP。`direct_user_session` 未实现时可声明 unknown/rejected。
  - `global_mutation_required` 必须按 provider 真实需求声明。
  - `session_id`、`total_cost_usd`、`modelUsage` 等 provider metadata 如需保存,只进标记为 `internal_only:true` 的 decision/governance data,不进 public wire event payload。
- Smoke:
  - fake/app-server tests 默认跑。
  - real provider smoke 用 env flag opt-in。
  - availability probe 不得只看 `claude --version`,也不得因 `ANTHROPIC_API_KEY` 缺失就判 rejected(OAuth/user supplier 可能可用)。必须至少跑一次受限 headless capability probe,按 CLI 外层 `is_error` / `subtype` / result 判定 binary/auth/quota;随后再跑 enforced-tool probe 证明 read-only 约束生效。
  - 缺 binary/auth/quota、provider unavailable、outer CLI output 非 JSON/空、`is_error:true`、`subtype!="success"` 时返回 skipped/rejected/degraded,不失败成假阴性,也不假 ready。
  - smoke 需要声明 state 隔离边界:可用 `CLAUDE_CONFIG_DIR` 和 explicit `--setting-sources` 降低 settings 污染,但 HOME/OAuth/keychain/供应商订阅 quota 通常不完全隔离;不得声称完全隔离。
- Docs:
  - README / roadmap / version 只声明第二 provider headless reviewer partial。
  - 不声称 Claude/Kimi/Gemini/Cursor 全部完成。

## 非目标

- 不实现所有 Claude Code 功能。
- 不接 Kimi/Gemini/Cursor。
- 不实现 ACP 真实 session。
- 不实现 direct user session。
- 不让第二 provider 当默认 coder。
- 不改变 adapter contract。
- 不把外部验证 CLI 当作 HOLP adapter,除非它通过 adapter contract 接入。
- 不把 provider-specific cost/session/modelUsage 字段加入 stable HOLP wire。

## 验收

- `flock.discover` 可以返回第二 provider 的 honest readiness。
- 有 `mcp-codex` producer + 第二 provider reviewer 的 opt-in smoke 能跑到 consensus verdict,或在本机不可用时给出明确 rejected/degraded reason。
- reviewer result 必须通过 PR9 的严格结构化校验。
- author exclusion、quorum、findings artifact/inline fallback 与单 provider path 一致。
- 缺 provider binary/auth 时不假装 ready。
- native-claude probe 覆盖 binary missing、auth/quota unavailable、outer CLI malformed/error output,并 honest rejected/degraded。
- runtime matrix 包含 headless/acp/direct_user_session 三类 surface 的显式声明。
- `headless + read_only_review` ready 只在受限 tool 白名单 + 非 bypass/非写入权限成立时出现;否则 degraded/rejected。
- `headless + read_only_review` ready 还必须有 probe evidence 证明 whitelist/deny-write 生效;只有声明配置无执行证据时不得 ready。
- `acp` 明确 unsupported;direct_user_session 未接时 unknown/rejected。
- native-claude reviewer output 有两层 fail-closed:外层 Claude CLI JSON/stream result 失败即 `status:error`;内层 verdict/finding 复用 PR9 严格结构化校验。两层都不得默认 approve/NONE。
- 外层 Claude CLI parse 失败时不得调用 inner reviewer parser;只有外层 `subtype:"success"` / `is_error:false` 且 result 字段存在时,才进入 PR9 canonical parser。
- tests 覆盖 availability probe、role support、runtime matrix、outer CLI parse failure、inner reviewer output parse failure。

## Review 重点

本 PR 最容易失焦成 "接一堆 provider"。review 时优先检查:

- 第二 provider 是否真的通过 HOLP adapter contract,而不是测试脚本旁路。
- runtime/isolation 声明是否 honest。
- provider output parse failure 是否 fail-closed。
- Claude CLI 外层输出 parse failure 是否 fail-closed,且不绕过 PR9 的 inner parser。
- read-only reviewer 是否真的靠 tool whitelist/permission mode 强制,而不是口头声明。
- user/local settings 供应商依赖是否被记录为 global state dependency。
- opt-in smoke 是否不污染默认 CI。
- 是否把 provider-specific 字段泄漏进 HOLP stable wire。
