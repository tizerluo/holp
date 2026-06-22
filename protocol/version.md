# HOLP Protocol Versioning

## 当前版本

**v0.1.5 (draft)** — 见 `spec.md`。

## 版本号

版本号形如 `MAJOR.MINOR`(稳定协议);draft 阶段额外带第三段表示同 minor 内的草案迭代(如 `0.1.3` = `0.1` minor 的第 3 次草案修订)。**正式发布(脱离 draft)后只用 `MAJOR.MINOR` 两段**;draft 期的第三段不计入兼容性判定——兼容性只看 `MAJOR.MINOR`。

- `MAJOR`:破坏性变更(改 wire 格式 / 删方法 / 改字段语义)。consumer 与 server 必须同 major。
- `MINOR`:向后兼容新增(可选字段 / 新方法 / 新事件 name)。**新增的事件 name 必须是「旧 consumer 忽略安全」的**(非阻塞、非语义关键);需 client 交互的语义(如新 approval kind)必须走 capability 协商,不靠「忽略」兜底。
- draft 期(`0.x`):`MAJOR` 仍为 0,允许 draft 内破坏性修订(bump 第三段),不受「只增不破」约束——因为还没人依赖稳定协议。脱离 0.x(首个稳定版 1.0)起严格执行语义化。

`initialize` 时双方报 `protocol_version`(比 `MAJOR.MINOR`),major 不匹配 → 拒绝(`protocol_version_mismatch`)。

## v0.1.5 范围

**协议层(draft)**:spec 全章有定义——握手+能力(descriptor) / flock(declare+discover) / orchestrate.run(含 §4.2 agent 引用绑定 flock + role 校验) / events.subscribe(categories 白名单语义 + seq 从 1 起) / consensus(两段式 quorum + artifact_refs 降级 findings) / approval(单通道状态机 + artifact_refs 降级 details) / task.cancel / artifact(强制 content + provenance artifact_id 例外) / 版本化 / 错误模型 / unattended policy / 实现边界。

**v0.1.5 基准修订**:Issue #11 的 harness isolation baseline 已进入协议主干。`flock.declare`/`flock.discover` 必须能表达 runtime surface / isolation readiness matrix,覆盖 `headless`、`acp`、`direct_user_session` 三类运行面、runtime kind、direct channel、isolation profile readiness、state declaration ref、global mutation risk。`ready` 只表示某个 runtime surface + isolation profile 下可调度,不表示 agent 整体可用。当前实现可以返回 unknown/unsupported/rejected,但不能省略该语义。

**当前仓已落地**:
- protocol draft + adapter 契约桩。
- 参考 daemon 协议骨架(`daemon/`):stdio JSON-RPC 9 方法 + 事件订阅/replay(M1a+M1b)。
- 参考 consumer CLI(`consumers/cli/`)+ M1 e2e 闭环 + M6a fake consumer CLI partial——**仅用 fake backend**(`fake` transport),非真实 provider。
- M2 契约回归网(`daemon/handlers/m2_contract.test.ts`):已锁定当前实现的关键 v0.1.4 语义；approval 超时已由 M4a skeleton 接入正向 contract,显式 reviewer panel 的 consensus kernel 已由 M4b 接入正向 contract,heartbeat 仍转交后续。
- M3 首个真实 adapter:`"mcp-codex"` 接 Codex app-server over stdio;`flock.declare`/`flock.discover` 通过 registry probe 返回 honest `ready/degraded/rejected`;permission resume 复用 injected `permissionHandler` + `ApprovalRecord.resumeBackend` path。Codex app-server 已有基础 stdio/turn recovery:无 turn activity 的 transient/usage-limit failure 可退避重试,已有 activity 后 fail-closed;不做 connected-service 多账号切换。自动测试覆盖 fake app-server harness;真实 provider smoke 取决于本机 Codex binary/auth。
- M4a governance data/state/decision skeleton partial:内部记录 events、`decision_made`、harness registry runtime/isolation matrix、run lifecycle state machine,并实现 approval expiry timer。该层无 public query API;`permission_surface` / `observability_surface` 为保留列且当前统一 `unknown`。
- M4b consensus gate triage kernel partial:显式 reviewer panel 可触发纯 consensus aggregation、author exclusion、二段式 quorum、`consensus_verdict`/`consensus_degraded`。
- M5 deterministic unanimous-approve multi-agent consensus demo:`npm run demo:m5` 使用 fake+fake reviewer path 真走 stdio JSON-RPC daemon wire,覆盖 producer artifact、author exclusion、quorum、findings artifact envelope 和 `artifact_refs:false` inline fallback。该 demo 不表示真实 reviewer provider sessions 或 dissent/timeout demo 已执行。
- M5b real reviewer execution pilot:显式 reviewer panel 可把非作者 `mcp-codex` reviewer execution hook 接入 consensus gate。completed vote 必须来自 strict JSON parser/validator,并且本次 runtime selection 必须证明 `read_only_review` ready/enforced;fake reviewer path 也复用同一 validator。当前 Codex declaration 仍 degraded/read_only_not_enforced,真实 Codex reviewer smoke 默认 SKIP,显式开启后若无法证明只读则 INCONCLUSIVE。
- M6a fake consumer CLI partial:`npm run demo:cli` / `demo:cli:inline` / `demo:cli:degraded` 使用 fake path 真走 stdio JSON-RPC daemon wire,渲染 run/approval/terminal/consensus/artifact report 和 raw/debug frames。`real-reviewer` path 指向 PR9 opt-in smoke。
- M6b second real provider adapter partial:`"native-claude"` 接 Claude Code headless `-p --output-format json` reviewer path。外层 Claude CLI JSON 失败即 fail-closed;内层 reviewer output 复用 PR9 strict parser/attestation gate。`headless + read_only_review` 只有在 read-only tool whitelist enforcement probe 给出证据时才 ready;否则 degraded/rejected。真实 Claude reviewer smoke 默认 SKIP,需 `HOLP_REAL_CLAUDE_REVIEWER_SMOKE=1`。

**参考 daemon 下一步 milestone**:
- 真实 provider dissent/timeout demo、稳定 gate protocol surface。
- **未做(不声称)**:acp 真接线、direct user session、12 个 agent 的三类运行面完整支持、Web 传输。**Remote 不在 v0.1.x wire**(见 spec §4.1:wire 只 Local)。

> 当前只声称「protocol draft + fake backend 跑通的 M1 闭环 + M2 契约层锁定 + Codex app-server 首个真实 adapter(含基础 runtime recovery) + v0.1.5 runtime surface/isolation baseline + M4a governance data/state/decision skeleton partial + M4b consensus kernel partial + M5 deterministic unanimous-approve fake+fake demo + M5b real reviewer execution pilot + M6a fake consumer CLI partial + M6b native-claude headless reviewer partial」,不声称已接 acp 真 agent/direct user session,也不声称 12 个 agent 已完整支持 `headless` / `acp` / `direct_user_session`,也不声称真实 provider dissent/timeout demo、或稳定 gate protocol surface 已完成。

## 变更记录

### v0.1.5 (draft) — Issue #11 baseline amendment
- P1:把 runtime surface / isolation readiness matrix 提升为协议基准,而非后续可选扩展。
- P1:`flock.declare`/`flock.discover` 必须能表达 `headless` / `acp` / `direct_user_session` 三类运行面、runtime kind、direct channel、isolation profile readiness、state declaration ref、global mutation risk。
- P1:澄清 `ready` 不是 agent 整体 ready,只是在某个 runtime surface + isolation profile 下 ready。
- P2:当前实现允许返回 unknown/unsupported/rejected,但空白不是合格声明;PR6+ 必须承接该数据模型。

### v0.1.4 (draft) — 跨仓 review 后补互操作缺口
- P1:`artifact_refs` 不可用时 consensus findings / approval details 内联降级,并澄清 provenance 裸 `artifact_id` 不受该能力控制(§2/§6.1/§7/§8.1)。
- P1:`orchestrate.run` agent 引用绑定 flock + role 校验(§4.2),新错误码 `role_unsupported`(-32018)、`agent_not_found`(-32019)。
- P1:`events.subscribe.categories` 白名单语义(省略=全订)+ 五 category 封闭枚举(§5),新错误码 `invalid_event_category`(-32020)。
- P2:§7 race 表述修 server-timeout 分支;§10.1 rejected 分流交叉引用;seq 从 1 起边界。
- P2:happier 权限枚举更正(五值 approved/approved_for_session/approved_execpolicy_amendment/denied/abort);补 loopwright `reviewerCandidates`(排除作者原型)归因。

### v0.1.3 (draft) — 第三轮 review 后修阻塞缺口
- quorum 第1段公式修正(`panel可用数 ≥ quorum`,删作者余量,修误杀合法配置 + 示例自洽)。
- artifact 强制 `content`、禁 `content_ref`(修大 artifact 不可取回)。
- approval cancel 语义钉死(只由 task.cancel 导致,无 approval.cancel 方法);resolved payload 补 reason;race「先终态者赢」。
- `task.cancel` 补完整 schema(幂等/终态事件/run_not_found/race)。
- capability `required` 钉为连接级(run 级走 params);缺省 capability = 不支持;kinds 空交集语义。
- 错误码定序(`invalid_quorum` 形状 vs `quorum_unsatisfiable` 策略)。

### v0.1.2 (draft) — 把 v0.1.1「表面改」逼到可执行
capability descriptor / approval 终态上 wire / quorum 两段式 / Remote 删净 / artifact 闭环 / flock 部分成功 / 错误码拆开 + 跨文件命名统一。

### v0.1.1 (draft) — 按首轮 review 返工
传输模型钉死 / consensus 固定为事件 / approval 单通道 / 能力 feature 细分 / flock 加 discover。

### v0.1 (draft) — 协议初稿
8 章。后经三轮 review 返工(传输/共识/审批/版本/范围声明/可执行性)。
