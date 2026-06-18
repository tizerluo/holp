# Issue #11 SPEC - Cross-Agent Harness Isolation

## 目的

为真实 provider run 定义一套跨 agent / harness 的隔离模型,避免 PR5/M3 的 Codex app-server smoke 经验固化成 Codex 专用方案。

本 SPEC 先冻结设计词表和验收边界,不要求一次性实现 12 个真实 adapter。后续 PR6/M4a 的 state / decision skeleton 必须能承载这里定义的 harness identity、state declaration、isolation profile 和 fail-closed 语义。

## 协议基准目标

HOLP 的协议基准目标不是"今天就完整支持 12 个 agent 的所有运行形态",而是:

- 协议必须能把多 agent / 多 harness 的能力表达成明确矩阵,覆盖 `headless`、`acp`、`direct_user_session` 三类运行面。
- 协议必须能区分"可运行"、"可观察"、"可中途注入"、"可取消"、"可 approval resume"、"可隔离"这些不同能力,不能用一个 `ready` 把它们糊在一起。
- 协议必须允许同一个 harness 在不同运行面和 isolation profile 下得到不同结果。例如 Codex app-server 可支持真实 approval,但 Codex MCP path 可能不支持 rollback;某 agent 可 headless 运行,但不能 direct user session。
- 协议必须把不支持显式化:`unsupported` / `degraded` / `rejected` 都是合法的协议结果。缺 capability 不能被隐藏成 stub ready,也不能靠默认用户全局状态偷跑。
- 协议必须给未来 12+ agent 留扩展空间:新增 agent 应主要是新增 declaration / registry data / adapter wiring,而不是修改协议枚举和核心状态机。
- 协议的安全基线是 fail-closed。任一 harness 的 route、session、approval、model label、state override 或 hook 归属不可验证时,默认不批准副作用、不写无关 run 状态、不声称隔离已满足。

因此,本 SPEC 的 12-agent 覆盖要求是 **declaration coverage**:每个 agent 至少要能声明哪些运行面支持、哪些未知、哪些不支持、哪些 isolation profile 可达。它不是 **implementation coverage**:不要求本 PR 或 PR6 一次实现所有 adapter。

### 运行面词表

- `headless`:通过 CLI/API 一次性或可续跑命令执行,适合 Commander 派工、review、test、execution run。典型例子:`claude -p`、`kimi -p`、`opencode run`。
- `acp`:通过 Agent Client Protocol 或 bridge 进行会话控制,适合结构化 session/update、permission、mode/model 控制。并非所有 agent 都有原生 ACP。
- `direct_user_session`:用户可直接对话的产品会话层,类似 Happy/Happier 的本地/远程 UI 会话。它需要 session service、message queue、metadata、permission UI、ready/keepalive、resume/handoff 等产品能力,不是单个 backend adapter 自动具备。

协议必须能表达三种运行面,但每个 harness 对三种运行面的支持可以分别是 `supported`、`experimental`、`unsupported` 或 `unknown`。

## 当前代码事实

- PR5/M3 已把 `"mcp-codex"` 接到 Codex app-server over stdio;`native-claude` 和 `acp` 仍是 honest stubs。
- `AgentBackendOptions` 当前只有 `cwd`、`env`、`modelId`、`permissionHandler`;还没有通用 isolation profile、state declaration、hook/router/global mutation 模型。
- 真实 Codex smoke 通过临时 workspace、临时 `CODEX_HOME`、复制 auth seed、写入 `notify = []` 来隔离 Codex state 和 workspace 文件副作用。
- 该 smoke 不等于完整 OS sandbox:进程仍可能继承普通环境变量,网络、Keychain、provider quota、进程树和本机 auth 可见性不由 HOLP 完全隔离。
- `flock.declare/discover` 当前能报告 binary/auth/probe readiness,但还不能说明某个 harness 在指定 isolation profile 下是 `ready`、`degraded` 还是 `rejected`。
- 当前 HOLP 还没有 Happy/Happier 式 `direct_user_session` 产品层。后续若要支持,必须作为显式运行面接入,不能假设 headless/ACP adapter 天然等同于用户可直接对话的会话体验。

## 调研依据

- `loopwright`:治理 registry 和 runtime backend 应分层。`harness_id`、`transport_class`、role、lifecycle 是治理维度;CLI / ACP / app-server / MCP 是执行维度。
- `happier`:provider isolation 适合先生成 per-run isolation bundle,叠加 XDG state/cache/data,同时保留 `HOME`,避免破坏 OAuth、Keychain 或 provider 自身 auth。
- `warp`:第三方 harness 自己负责 config/env/resume payload;driver 不应拆 provider 私有状态,也不应在通用层猜测 resume payload。
- `cmux`:hook 安装是用户全局副作用,hook 运行时路由是 per-session/per-workspace 行为。两者必须拆开建模,不能把"装过 hook"误认为"本次 run 已隔离"。
- Issue #11 提到的 `6tizer/codex-auto-PR-loop-plusin` 可作为 hook routing / snapshot / rollback prior art,但 HOLP 不依赖该项目代码。

## 核心模型

### 1. Harness identity

每个 harness 必须先声明稳定身份,再绑定一个或多个 runtime kind。

必填字段:

- `harness_id`:HOLP 内部稳定 id,例如 `codex`、`claude-code`、`cursor-agent`。
- `vendor`:provider 或 CLI 归属,例如 OpenAI、Anthropic、Cursor。
- `transport_class`:HOLP 协议/治理层分类,例如 `mcp-codex`、`native-claude`、`acp`、`headless-cli`、`hook-feed`。
- `runtime_kind`:具体启动面,例如 app-server、ACP、headless print、MCP bridge、hook router。
- `runtime_surface`:协议运行面,取 `headless`、`acp`、`direct_user_session` 之一。
- `runtime_surface_support`:该运行面的支持级别,取 `supported`、`experimental`、`unsupported`、`unknown`。
- `role_fit`:可作为 Architect、Coder、Tester、Reviewer 的默认能力声明。

同一个 agent 可以有多个 runtime kind。Codex 例子:app-server、ACP、headless exec、MCP path 都不能在治理层混成一个不可区分的能力。

### 2. Harness state declaration

每个 harness 必须声明自己会读写哪些本机状态。未知状态不能默认视为安全。

必填字段:

- `state_roots`:config、auth、session、log、cache、data、plugin、hook、router、db 的路径或发现规则。
- `state_override_env`:可重定向 provider state 的环境变量,例如 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`HERMES_HOME`。
- `auth`:status command、credential paths、auth env vars、background check 是否 safe、是否可能使用 Keychain/GUI auth。
- `session`:session id 来源、resume/fork 语义、session 是否跨 headless/ACP/app-server 共享。
- `hooks`:是否有安装期 hook、运行期 hook、disable env、route key、hook state file。
- `global_mutation`:是否会写用户全局 config、hook、plugin、router、db,以及是否支持 snapshot/rollback。

### 3. Isolation profile

每次 run 必须选择一个 profile。profile 表达本次 run 希望限制哪些副作用,不表达 provider 天然一定能做到。

支持状态:

- `ready`:harness 声明且 probe 证明该 profile 可满足。
- `degraded`:可运行,但有明确缺口,必须把缺口返回给 `flock.discover` / run metadata。
- `rejected`:不能满足 profile,且 fallback 会带来不被允许的副作用。

### 4. Permission surface

真实 provider approval 必须声明:

- provider 是否有结构化 approval request。
- request id / turn id / session id 如何绑定 HOLP approval record。
- `allow`、`allow-for-session`、`deny`、`cancel` 如何映射回 provider。
- pending approval 是否能跨 async boundary 挂起并 resume。
- 缺少 handler、route 不可信、request 过期时的默认行为。

默认行为必须是 deny / cancel / rejected,不能静默 approve。

### 5. Observability surface

每个 harness 必须声明事件来源:

- structured stream:ACP、app-server、stream-json。
- transcript scan:provider jsonl / sqlite / session db。
- hook feed:pre-tool、post-tool、session start、prompt submit。
- heuristic log:只能作为 telemetry,不能单独触发 approval。

观察策略:

- 外部 agent 长任务优先 ACP 或 structured stream。
- Host 不需要高频盯住;启动/auth/首个事件/approval/terminal 是关键节点。
- 无关键节点时,3 到 5 分钟观察一次即可。
- 观察失败时只能降级为 unknown/degraded,不能推断成功。

## Isolation profiles

### `read_only_review`

用于 Architect / Reviewer / Tester 中的只读审查。

要求:

- 不写 project files,不改 git index,不创建 commit。
- 不默认使用 provider plan mode。plan mode 只适合 Commander 或专门的 plan review gate。
- 禁止安装或更新全局 hook。
- hook/feed 可观察,但 unknown tool event 只能作为 telemetry。
- 如果 provider 无法禁止写操作,必须 `degraded` 或 `rejected`,并在任务 brief 中明确只读约束。

### `coder_worktree`

用于普通实现工作。

要求:

- 写入只允许发生在分配的 repo/worktree。
- git 操作按 workflow gate 授权,不得跨 repo/worktree。
- provider global config 不得被改写。
- session/log/cache 写入可以进入 provider state,但必须由 harness declaration 标注。
- 如需 provider home override,必须在 `state_override_env` 中声明。

### `real_provider_smoke`

用于真实 provider approval / patch / command smoke。

要求:

- 使用临时 workspace 承载文件副作用。
- 使用 scoped provider state 或明确声明哪些 state 会继承。
- auth 只能通过声明式 copy/link/inherit 读取,不能临时写用户全局 auth。
- side-effect command 必须有 allowlist 或可审计的 approval record。
- smoke 必须显式 opt-in,不得作为默认 CI。
- smoke 结果必须写明隔离边界,例如"隔离 Codex state 和 workspace,不隔离网络/quota/完整 env"。

PR5/M3 的 Codex smoke 是此 profile 的第一例。

### `multi_agent_concurrent`

用于同一机器上多个 agent/harness 并发。

要求:

- route key 至少包含 run id / session id / workspace id 中足够可信的组合。
- hook runtime state 必须与 hook install state 分离。
- route 模糊、session 缺失、stale hook、orphan fork、parent/child lineage 不可信时 fail-closed。
- fail-closed 表示不批准副作用、不更新无关 run 的可见状态、不把 telemetry 当 decision。

### `user_global_install`

用于安装或修改用户全局 hook、router、plugin、provider config。

要求:

- 必须和普通 adapter smoke 分离。
- 必须有 preview/diff、snapshot、rollback 或 doctor。
- 必须记录用户显式确认。
- 失败后必须能说明已写入哪些 global state。
- 没有 snapshot/rollback 的 harness 只能 `degraded` 或 `rejected`。

### `high_isolation`

用于高隔离实验或未来 sandbox。

要求:

- 临时 workspace。
- provider home/config/state override。
- XDG state/cache/data overlay,如果 provider 支持。
- 尽量过滤继承 env,但 auth/env secret 规则必须由 harness declaration 控制。
- 如果 provider 依赖 Keychain、GUI auth 或不可重定向 global db,必须返回 `degraded` 或 `rejected`。

## 初始 harness declaration 覆盖

以下表格是 issue 修复时必须记录的最小声明对象。它不是实现承诺,也不是 ready 矩阵。

| Harness | 接入面 | 模型指定 | Auth / state 位置 | ACP | Scoped state | Hook/global 风险 | Approval 能力 | 观察策略 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `claude -p` / stream-json | `--model claude-opus-4-8` 等 | `~/.claude`, `CLAUDE_CONFIG_DIR`, HOME 相关全局 state | 无官方 ACP | `CLAUDE_CONFIG_DIR` 可部分隔离;HOME 通常保留 | hooks/settings 可能全局;可用 `--setting-sources project` 减少影响 | CLI/tool approval 需按 driver 能力声明 | stream-json;Opus 长任务按关键节点和 3-5 分钟观察 |
| Codex | app-server / headless / ACP bridge / MCP | `-m` 或 config;错误模型不应静默 fallback | `~/.codex`, `CODEX_HOME`, sessions | 有 ACP bridge,app-server 为 PR5 主 path | `CODEX_HOME` 可隔离;smoke 已验证 | `notify`/hooks/config 可能全局;smoke 写临时 config 禁用 notify | app-server 有结构化 command/file approval | app-server stream;approval/terminal 为关键节点 |
| Cursor Agent | headless `-p` / ACP | composer 系列,如 `composer-2.5`、`composer-2.5-fast`、`auto` | API key / Cursor agent state,具体 state 需 driver 声明 | 有官方 ACP | scoped home 能力不确定 | hooks/session/feed 能力弱,全局状态需保守 | ACP/headless 能力按 runtime 声明 | ACP 或 stream-json;不要依赖 plan mode 输出 |
| Kimi Code | headless / ACP | `moonshot-cn/kimi-k2.7-code` | `~/.kimi/config.toml` 等 | 有 | provider config override 需声明 | 全局 config 写入需禁止 | ACP permission 能力需按 driver 验证 | ACP preferred;headless 输出为辅助 |
| Gemini | `gemini -p` / `--acp` | `-m` 可能 fallback,需验证 exact | `~/.gemini`, OAuth/env auth | 有 | Gemini home/config 隔离需声明 | extensions/hooks/config 可能全局 | approval mode 有 default/auto/yolo/plan 等 | ACP;模型 fallback 必须显式探测 |
| Antigravity | `agy -p` | exact label,否则可能 silent fallback | GUI/Keychain auth,local app state | 当前 binary 无 ACP | 高隔离受限 | app/Keychain/global state 风险高 | headless approval 能力需保守声明 | 长 timeout;关键节点和 3-5 分钟观察 |
| Hermes | headless `-z` / ACP | profile 内 provider/model | `~/.hermes/profiles/<name>` | 有 | profile 天然隔离一部分 state | profile config/fallback 链会影响行为 | ACP/profile 能力声明 | ACP preferred;profile 是 route key |
| OpenCode | `opencode run` / ACP | `-m provider/model` | `~/.config/opencode` | 有 | `--pure` 可减少 user config/plugin 影响 | plugins 可能延迟或污染 initialize | ACP/run session 共享,permission 按 config | ACP with timeout >= 15s |
| Kilo | ACP | configured model | `~/.config/kilo`, `~/.local/share/kilo` | 有 | `--pure` 可减少污染 | global config/auth state | ACP only;headless 不作为主 path | ACP |
| Pi | headless / ACP bridge | default or configured model | `~/.pi/agent`, session map | bridge | scoped state 需声明 | auth/config/session map shared | ACP bridge 能力声明 | ACP bridge 或 headless;session map 需 route |
| Reasonix | `reasonix run` / ACP | configured provider/model | app support config, env api keys | 有 | config isolation 需声明;API key 只 env 注入 | 不应把 key 写入 config | ACP permission 由 config 决定 | ACP/headless shared sessions |
| ZCode | CLI prompt / ACP bridge / MCP | env/config 指定 | `~/.zcode/v2`, sqlite db | bridge | session db shared,需保守 | bridge 默认 yolo 风险;global db/config | yolo bridge 需要隔离 worktree/trusted dir | bridge nonstreaming;降低假实时假设 |

## HOLP 接口影响

本 issue 的直接修复是 SPEC 文档,不修改 runtime。后续实现应按以下方向演进:

- 保持 `AgentBackend` 兼容;新增字段必须是可选能力,不能破坏 PR5/M3 fake 和 real Codex path。
- `AgentProbeInput` 后续可增加 `isolationProfile`、`runIntent`、`workspaceId`、`sessionRouteKey` 等可选输入。
- `AgentProbeResult` 后续可增加 `isolation_status`、`isolation_warnings`、`state_declaration_ref`、`global_mutation_required`。
- harness declaration 后续应增加 runtime surface support 矩阵,至少覆盖 `headless`、`acp`、`direct_user_session` 三列。
- registry wiring 只负责选择 backend factory;harness declaration 应由独立 registry 管理,避免 runtime factory 内硬编码治理规则。
- `flock.declare/discover` 应能表达同一 harness 在不同 profile 下 readiness 不同。例如 Codex 在 `real_provider_smoke` 下可 ready,在 `high_isolation` 下可能 degraded。
- PR6/M4a data/state skeleton 应把 harness identity 和 isolation profile 作为 run metadata,不要只存 transport string。

## Codex 迁移路径

- 保留当前 Codex app-server adapter 行为。
- 把 `scripts/smoke/_codex-isolation.ts` 记录为 `real_provider_smoke` 的 reference implementation。
- 在后续 runtime 改造中,让 Codex backend 从 isolation bundle 接收 `cwd`、`env.CODEX_HOME`、`notify=[]` config 和 auth seed policy,而不是在 smoke helper 里形成唯一方案。
- Codex approval mapping 继续使用现有 injected `permissionHandler` resume 语义;未来如果引入 `backend.resolvePermission`,fake backend 和 real adapter 必须共享同一 cancel/deny/approve 语义。
- 不把 Codex 的 `CODEX_HOME` 能力推广成所有 agent 的通用假设。

## Fail-closed rules

- unknown harness id:可 discover 为 unsupported/degraded,但不可运行。
- unknown provider event:只能进入 generic event,不能触发 approval。
- malformed approval request:拒绝或 cancel,不能 approve。
- missing binary/auth/config override:返回 degraded/rejected,不能偷偷 fallback 到用户全局 state。
- stale hook route:丢弃或记录 telemetry,不能写入无关 run。
- ambiguous session id:不恢复、不 fork、不 approve。
- orphan child session:保留 raw telemetry,不纳入受控 run tree。
- model label 被 provider silent fallback 的 harness:必须 probe 或在 result 中记录不可信,不能声称 exact model ready。

## 验收

本 issue 修复完成时:

- 新增本 SPEC。
- `docs/pr-specs/README.md` 链接本 SPEC。
- PR6 SPEC 明确在设计 state/decision skeleton 前读取本 SPEC。
- SPEC 明确协议基准目标:HOLP 必须能表达 12+ harness 在 `headless` / `acp` / `direct_user_session` 三类运行面下的 capability 和 isolation readiness,即使当前实现只接通其中一小部分。
- 不修改 runtime,不安装 hook,不写用户全局 provider config。
- `git diff --check` 通过。
- `npx gitnexus detect-changes --repo holp` 或本仓支持的等价命令通过。

后续实现 PR 应新增测试:

- declaration/profile resolver:同一 harness 在不同 profile 下可返回不同 readiness。
- Codex smoke profile:生成 temp workspace、temp `CODEX_HOME`、`notify=[]`,并显式记录 env 继承边界。
- permission fail-closed:unknown event、malformed approval、stale route 不触发 approval。
- cancellation:pending approval cancel 后 provider request 被 deny/cancel,不泄漏 pending state。
- discover:缺 binary/auth/config override 时返回 degraded/rejected。

## 非目标

- 不在本 issue 中实现 12 个 adapter。
- 不声称 12 个 agent 已完整支持 `headless` / `acp` / `direct_user_session` 三种运行面。
- 不在本 issue 中安装或修改任何用户全局 hook。
- 不把 `happier`、`loopwright`、`warp`、`cmux` 变成 HOLP runtime 依赖。
- 不承诺完整 OS sandbox 或 provider quota 隔离。
- 不把 provider plan mode 当作通用 review 模式。
