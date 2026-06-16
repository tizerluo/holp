# HOLP Protocol Versioning

## 当前版本

**v0.1.4 (draft)** — 见 `spec.md`。

## 版本号

版本号形如 `MAJOR.MINOR`(稳定协议);draft 阶段额外带第三段表示同 minor 内的草案迭代(如 `0.1.3` = `0.1` minor 的第 3 次草案修订)。**正式发布(脱离 draft)后只用 `MAJOR.MINOR` 两段**;draft 期的第三段不计入兼容性判定——兼容性只看 `MAJOR.MINOR`。

- `MAJOR`:破坏性变更(改 wire 格式 / 删方法 / 改字段语义)。consumer 与 server 必须同 major。
- `MINOR`:向后兼容新增(可选字段 / 新方法 / 新事件 name)。**新增的事件 name 必须是「旧 consumer 忽略安全」的**(非阻塞、非语义关键);需 client 交互的语义(如新 approval kind)必须走 capability 协商,不靠「忽略」兜底。
- draft 期(`0.x`):`MAJOR` 仍为 0,允许 draft 内破坏性修订(bump 第三段),不受「只增不破」约束——因为还没人依赖稳定协议。脱离 0.x(首个稳定版 1.0)起严格执行语义化。

`initialize` 时双方报 `protocol_version`(比 `MAJOR.MINOR`),major 不匹配 → 拒绝(`protocol_version_mismatch`)。

## v0.1.4 范围

**协议层(draft)**:spec 全章有定义——握手+能力(descriptor) / flock(declare+discover) / orchestrate.run(含 §4.2 agent 引用绑定 flock + role 校验) / events.subscribe(categories 白名单语义 + seq 从 1 起) / consensus(两段式 quorum + artifact_refs 降级 findings) / approval(单通道状态机 + artifact_refs 降级 details) / task.cancel / artifact(强制 content + provenance artifact_id 例外) / 版本化 / 错误模型 / unattended policy / 实现边界。

**当前仓已落地**:
- protocol draft + adapter 契约桩。

**参考 daemon 下一步 milestone**:
- 协议接入骨架。
- 治理内核/events-decisions-registry 数据骨架/共识/状态机 从 loopwright 搬入。
- **未做(不声称)**:native-claude/mcp-codex 真接线、acp、Web 传输。**Remote 不在 v0.1.x wire**(见 spec §4.1:wire 只 Local)。

> 当前只声称「protocol draft + adapter stub」,不声称已接 native-claude/mcp-codex。

## 变更记录

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
