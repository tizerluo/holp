# HOLP Protocol Versioning

## 当前版本

**v0.1.1 (draft)** — 见 `spec.md`。

## 版本号

语义化版本:`MAJOR.MINOR`。

- `MAJOR`:破坏性变更(改 wire 格式 / 删方法 / 改字段语义)。consumer 与 server 必须同 major。
- `MINOR`:向后兼容新增(可选字段 / 新方法 / 新事件 name)。**新增的事件 name 必须是「旧 consumer 忽略安全」的**(非阻塞、非语义关键);需 client 交互的语义(如新 approval kind)必须走 capability 协商,不靠「忽略」兜底(v0.1.1 修复:原「忽略未知字段即可」不安全)。

`initialize` 时双方报 `protocol_version`,major 不匹配 → 拒绝(`protocol_version_mismatch`)。

## v0.1.1 范围

**协议层(draft)**:spec 全 12 章有定义——握手+能力 / flock(declare+discover) / orchestrate.run / events.subscribe / consensus / approval / artifact / 版本化 / 错误模型 / unattended policy / 实现边界。

**参考 daemon milestone(当前)**:
- 协议接入骨架 + adapter 契约桩。
- 治理内核/数据铁三角/共识/状态机 从 loopwright 搬入(进行中)。
- **未做(不声称)**:native-claude/mcp-codex 真接线、Remote、acp、Web 传输。

> v0.1.1 修复 P2-3:v0.1 的 spec/version/README 对「做了什么」自相矛盾。现在统一:当前只声称「protocol draft + adapter stub」,不声称已接 native-claude/mcp-codex。

## 变更记录

### v0.1.1 (draft, 2026-06-17) — 按深度 review 返工
P0:传输模型钉死(控制面 JSON-RPC + 带 subscription_id 事件);consensus 固定为事件 + 删示例数学矛盾 + quorum 可满足性校验 + verdict/evidence 分层 + 作者降 provenance;共识配置单一入口;approval 单通道状态机;能力 feature 细分;flock 加 discover+实测回执。
P1:capabilities 细化 + adoption 降级;adapter 单 session + permission 可恢复;Remote 改 opaque object;unattended policy。
P2:v0.1 范围声明统一;artifact 协议;错误模型。
明细见 `spec.md` 文末「v0.1 → v0.1.1 变更明细」。

### v0.1 (draft, 2026-06-17)
- 协议初稿。8 章。后被 v0.1.1 返工(传输/共识/审批/版本/范围声明有根本性缺口)。
