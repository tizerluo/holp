# PR10 SPEC - M6a Consumer CLI Experience

> 状态:planned。目标是在真实 reviewer pilot 之后,把 HOLP 从 "daemon 可以跑" 推进到 "开发者可以通过 CLI 看得懂、插得上手、取得到证据"。该 PR 是 consumer experience,不是产品化 UI。

## 目的

补齐一个可用的本地 consumer 体验:发起 run、订阅事件、处理 approval、查看 consensus report、拉取 artifact,并保持 vendor-neutral。

完成后,开发者不需要读 JSON-RPC 原始流,也能理解一个 HOLP run 的过程和结论。

## 当前代码事实

- `consumers/cli/` 已有 M1 闭环 demo,但仍偏脚本化和协议验证。
- `npm run demo:m5` 是 deterministic demo,输出用于证明 PR8 wire path,不是通用 consumer。
- daemon 已支持 `initialize`、`flock.declare`、`orchestrate.run`、`events.subscribe`、`approval.resolve`、`task.cancel`、`artifact.get`。
- approval 单通道、artifact envelope/inline fallback、consensus events 都已存在。
- cmux/Warp/tmux 等 consumer 仍未接入;M6 roadmap 只要求先有 vendor-neutral 示例。

## 范围

扩展或新增一个 CLI consumer,覆盖从启动到总结的最小人类可用路径。

预期产出:

- CLI run command:
  - 能选择 registry/transport。
  - 能声明 producer/coder/reviewer panel。
  - 能设置 quorum 和 artifact_refs capability。
  - 能输出 run_id、subscription_id、selected runtime/isolation metadata。
- Event rendering:
  - run lifecycle、agent output、approval、consensus、artifact refs 有稳定可读格式。
  - 单 coder run 和 reviewer panel run 的输出区别清楚。
  - 不把 raw JSON 作为唯一体验,但保留 raw/debug 开关。
- Approval interaction:
  - CLI 可以在 approval_requested 时提示用户 approve/deny。
  - 超时、取消、late resolve 结果可见。
  - 仍只走 `approval.resolve`,不新增 approval channel。
- Consensus report:
  - 展示 excluded authors、eligible reviewers、quorum、outcome、max_severity、errors。
  - findings envelope 可自动 `artifact.get` 拉取并展示摘要。
  - `artifact_refs:false` inline fallback 能正常展示。
- Demo commands:
  - 一个 fake deterministic path。
  - 一个 real reviewer pilot path,可 opt-in。
- Consumer docs:
  - README 给出最小命令。
  - roadmap 标注 M6a consumer CLI partial landed 后才能声称。

## 非目标

- 不做 Web UI。
- 不接 cmux 主线。
- 不实现 Warp/tmux direct session。
- 不新增 daemon wire 方法。
- 不改变 JSON-RPC envelope。
- 不把 CLI 输出格式承诺为稳定 API。

## 验收

- CLI 能跑通 M1 fake single-coder path。
- CLI 能跑通 M5 fake consensus path。
- 若 PR9 real reviewer pilot 可用,CLI 能跑 opt-in real reviewer path;不可用时给出 honest skip/rejected reason。
- approval_requested 时 CLI 能 resolve approve/deny,并展示最终 run_merged/run_blocked。
- consensus report 展示 author exclusion、quorum 和 findings。
- `artifact_refs:true` findings 能自动取 artifact;`artifact_refs:false` inline findings 能展示。
- `task.cancel` 可从 CLI 触发,且终态事件清楚。
- tests 覆盖 renderer、approval prompt flow、artifact report flow;不要求真实 provider 默认跑。

## Review 重点

本 PR 的重点不是加更多 daemon 能力,而是把已有 wire 诚实地呈现给人。review 时优先检查:

- CLI 有没有绕过 protocol 直接读内部 store。
- approval 是否仍只走 §7 单通道。
- consensus report 是否会把 degraded/rejected runtime 说成 ready。
- raw/debug 输出是否足够定位问题。
- fake demo 是否被描述成真实 provider consensus。
