# HOLP Protocol Versioning

## 当前版本

**v0.1 (draft)** — 见 `spec.md`。

## 版本号

语义化版本:`MAJOR.MINOR`。

- `MAJOR`:破坏性变更(改 wire 格式 / 删方法 / 改字段语义)。consumer 与 server 必须同 major。
- `MINOR`:向后兼容新增(可选字段 / 新方法 / 新事件 name)。旧 consumer 忽略未知字段应正常工作。

`initialize` 时双方报 `protocol_version`,取交集。major 不匹配 → 拒绝连接。

## v0.1 范围

- 协议面:initialize / flock.declare / orchestrate.run / events.stream / consensus.verdict / approval.* / task.cancel 全定义。
- 执行模式:Local 实现;Remote 留 wire 口子(不实现)。
- 朝下:native-claude + mcp-codex(参考实现);acp 留口子(接 happier)。
- 传输:stdio JSON-RPC only。

## 变更记录

### v0.1 (draft, 2026-06-17)
- 协议初稿。设计来源见 `docs/positioning.md`。
- 8 章定义:握手 / flock / orchestrate / events / consensus / approval / lifecycle / 版本化。
- Human on Loop 立场确立(consensus + unattended loop 写进协议语义)。
