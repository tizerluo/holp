> status: completed — PR10 shipped; see pr-specs README landed next-stage list and README M6a checkbox.

# PR10 SPEC - M6a Consumer CLI Experience

> 状态:implemented as M6a fake consumer CLI partial。本 PR 基于 fake reviewer path 把 HOLP 从 "daemon 可以跑" 推进到 "开发者可以通过 CLI 看得懂、插得上手、取得到证据";PR9 real reviewer pilot 可用后再展示 opt-in real reviewer path。该 PR 是 consumer experience,不是产品化 UI。

## 目的

补齐一个可用的本地 consumer 体验:发起 run、订阅事件、处理 approval、查看 consensus report、拉取 artifact,并保持 vendor-neutral。

完成后,开发者不需要读 JSON-RPC 原始流,也能理解一个 HOLP run 的过程和结论。

## 当前代码事实

- `consumers/cli/` 已有 `run` CLI:fake single-coder、fake consensus、fake consensus_degraded/degraded report、raw/debug wire frame、approval decision、artifact report。
- `npm run demo:m5` 是 deterministic demo,输出用于证明 PR8 wire path,不是通用 consumer。
- daemon 已支持 `initialize`、`flock.declare`、`orchestrate.run`、`events.subscribe`、`approval.resolve`、`task.cancel`、`artifact.get`。
- approval 单通道、artifact envelope/inline fallback、consensus events 都已存在。
- cmux/Warp/tmux 等 consumer 仍未接入;M6 roadmap 只要求先有 vendor-neutral 示例。
- `real-reviewer` path 已指向 PR9 opt-in smoke;默认仍可 honest skip / INCONCLUSIVE,不得把未证明的真实 reviewer 当 completed vote。

## 范围

扩展或新增一个 CLI consumer,覆盖从启动到总结的最小人类可用路径。

预期产出:

- CLI run command:
  - 能选择 registry/transport。
  - 能声明 producer/coder/reviewer panel。
  - 能设置 quorum 和 artifact_refs capability。
  - 能输出 run_id、subscription_id、selected runtime/isolation metadata。
- Event rendering:
  - run lifecycle、agent output、approval、consensus、artifact refs 有一致、人类可读的格式;该格式不是机器可解析稳定 API。
  - CLI 输出必须明确区分 wire truth 与 rendered view:raw/debug 展示原始 frame,默认人类视图只能投影 wire 字段,不得重新计算 consensus/eligibility。
  - 单 coder run 和 reviewer panel run 的输出区别清楚。
  - 不把 raw JSON 作为唯一体验,但保留 raw/debug 开关。
  - renderer 必须处理 replay + live event 去重、seq 连续性、终态后 unsubscribe。事件 identity 使用 `(run_id, seq)`,因为 EventBus seq 在 run 内单调唯一;category/name 只用于展示和断言。
- Approval interaction:
  - CLI 可以在 approval_requested 时提示用户 approve/deny。
  - CLI 必须同时提供非交互 decision 通道(例如 `--decision approved|rejected` 或等价 flag),用于 demo/CI 不阻塞 stdin。
  - 超时、取消、late resolve 结果可见。若 `approval.resolve` response 与终态事件竞态,CLI 以 `run_merged` / `run_blocked` / `run_cancelled` 等 terminal event 为最终事实。
  - 仍只走 `approval.resolve`,不新增 approval channel。
- Consensus report:
  - 展示 excluded authors、eligible reviewers、quorum、outcome、max_severity、errors。
  - findings envelope 可自动 `artifact.get` 拉取并展示摘要。
  - `artifact_refs:false` inline fallback 能正常展示。
- Demo commands:
  - 一个 fake deterministic path。
  - 一个 deterministic dissent/error fixture,用于证明 request_changes/reject 或非空 `errors[]` 的 report 渲染真的走到。
  - 一个 real reviewer pilot path,可 opt-in。
- Consumer docs:
  - README 给出最小命令。
  - roadmap/README 只有在 fake + real opt-in 状态分别清楚时才能声称:M6a fake consumer CLI partial、real reviewer consumer path opt-in/available/unavailable。

## 非目标

- 不做 Web UI。
- 不接 cmux 主线。
- 不实现 Warp/tmux direct session。
- 不新增 daemon wire 方法。
- 不改变 JSON-RPC envelope。
- 不把 CLI 输出格式承诺为稳定 API。
- 不把 fake unanimous-approve demo 的通过解释成 errors/dissent/timeout 渲染已覆盖。

## 验收

- CLI 能跑通 M1 fake single-coder path。
- CLI 能跑通 M5 fake consensus path。
- 若 PR9 real reviewer pilot 可用,CLI 能跑 opt-in real reviewer path;不可用时给出 honest skip/rejected reason。
- approval_requested 时 CLI 的交互模式能提示用户 approve/deny;非交互模式能用预设 decision 自动 resolve approve/deny,并展示最终 run_merged/run_blocked。
- late `approval.resolve` 返回 `approval_already_resolved` 时,CLI 显示为 server 已终态接管,不当作崩溃;`approval_expired` / `approval_cancelled` 事件在事件流可见。
- approval resolve 与 terminal event 乱序时,最终 summary 只取 terminal event;resolve response 作为过程日志展示。
- consensus report 展示 author exclusion、eligible reviewers、quorum、outcome、max_severity、findings 和 `errors[]`。
- 至少一个 deterministic dissent/error fixture 让 CLI 渲染非 approve outcome 或非空 `errors[]`,避免只靠 unanimous-approve fake path。
- `artifact_refs:true` findings 能自动取 artifact;`artifact_refs:false` inline findings 能展示。
- `artifact.get` 返回 `truncated:true` 时,CLI 明确显示 `TRUNCATED` 状态和可复现的 artifact id / fetch hint。
- `task.cancel` 可从 CLI 触发,并展示 `approval_cancelled` 与 run 终态。
- CLI 在 run 终态后调用 `events.unsubscribe`;renderer 对 replay + live 的同一事件不重复渲染,并断言同一 run 的 seq 从 1 连续。
- raw/debug 模式输出未删减 JSON-RPC 帧(含 seq/category/payload),默认模式提供人类可读 report,不只打印 raw JSON。
- CLI 数据来源只能是 stdio JSON-RPC response/notification 帧;不得 import daemon internal store。renderer tests 至少有一条经过 JSON round-trip 的 wire-frame fixture。
- tests 覆盖 renderer、interactive approval prompt、non-interactive approval decision、artifact report、raw/debug、dissent/error report;不要求真实 provider 默认跑。

## Review 重点

本 PR 的重点不是加更多 daemon 能力,而是把已有 wire 诚实地呈现给人。review 时优先检查:

- CLI 有没有绕过 protocol 直接读内部 store。
- approval 是否仍只走 §7 单通道。
- consensus report 是否会把 degraded/rejected runtime 说成 ready。
- consensus_degraded 是否作为 consensus category 正常渲染,而不是被当成无 verdict。
- raw/debug 输出是否足够定位问题。
- fake demo 是否被描述成真实 provider consensus。
