# HOLP 当前 backlog 优先级排序

> 时点快照(2026-06-22),非当前权威路线;当前路线见 docs/holp-blueprint.md 与 docs/roadmap.md。

> 整理时间:2026-06-22
> 数据来源:GitHub 开放 issues + `docs/pr-specs/` + `docs/roadmap.md` + `README.md` 当前声明
> 整理依据:2026-06-22 跨仓 review 完成后,对照外部参考项目(happier / warp / loopwright / cmux / spawn / skypilot / issue-to-pr)真实代码核实;commit 数基于本地 checkout,未额外 fetch remote
> 状态:历史快照。PR9-PR12 已落地后,后续权威路线改由 `docs/holp-blueprint.md` 的 M7-M12 维护;当前关键路径是 M7 foundation loop。

## 全景:开放 issue + 未落地 spec + roadmap 未完成项

**当前相关 issue 状态**:

- [#17 M3 后续:Codex app-server runtime 健壮性补强](https://github.com/tizerluo/holp/issues/17) — 已由 PR-A 落地并关闭。
- [#18 PR11/M6b 参考素材:happier AcpBackend 最新形态](https://github.com/tizerluo/holp/issues/18)
- [#19 PR9/M5b 参考素材:happier codex-native-review 模块](https://github.com/tizerluo/holp/issues/19) — 已由 PR9 吸收为 `mcp-codex` real reviewer pilot 并关闭。
- [#20 V3 Remote proposal 参考素材:warp Remote Agent Mode 全套](https://github.com/tizerluo/holp/issues/20)
- [#21 V3+ 跨云算力参考素材:skypilot K8s/metrics/job control 更新](https://github.com/tizerluo/holp/issues/21)
- [#22 跨仓 review 参考与提醒:happier 产品层差异 + warp 设计边界印证](https://github.com/tizerluo/holp/issues/22)

**PR spec 状态**:

- `docs/pr-specs/completed/pr9-m5b-real-reviewer-execution.md` — PR9/M5b real reviewer execution pilot 已在本 PR 实现。
- `docs/pr-specs/completed/pr10-m6a-consumer-cli-experience.md` — PR10/M6a fake consumer CLI partial 已落地。
- `docs/pr-specs/completed/pr11-m6b-second-real-provider.md` — PR11/M6b native-claude headless reviewer partial 已由本 PR 实现。
- `docs/pr-specs/completed/pr12-m6c-runtime-session-matrix.md`

**roadmap 未落地(README "[ ]" 项 + 未声明项)**:

- 稳定 gate protocol surface / 真实 provider dissent-timeout demo / ACP 或 direct session 真接线
- M2 contract heartbeat 转交后续(`m2_contract.test.ts` §F 锁定边界)
- M4a `permission_surface` / `observability_surface` 仍统一为 `unknown`
- 真实 OS/provider isolation enforcement(v0.1.5 baseline 只到声明层)

---

## 优先级排序(高 → 低)

### 🔴 P0 — 阻塞健壮性 / 阻塞下一里程碑

#### 1. **Issue #17 + PR9(M5b 真实 reviewer execution pilot)联动 — 已处理**

- **why bundle**:PR9 spec 明示 *"`mcp-codex` reviewer 只有在可用 read-only enforced session 时才可执行"*,而 #17 已把 Codex app-server 从一次性脆弱模型推进到基础 turn recovery,并为后续 read-only sandbox 启动路径留出 adapter option。PR9 已在此基础上补 enforcement attestation + reviewer parser,没有把 default `workspace-write` 当 read-only reviewer。
- **顺序**:#17 已作为健壮性底盘落地 → PR9 在底盘上接入 `mcp-codex` reviewer execution hook + read-only attestation gate;当前 Codex `read_only_review` declaration 仍 degraded 时真实 smoke 只能 INCONCLUSIVE
- **参考素材**:Issue #17 本身 + Issue #19(codex-native-review 形状)+ happier 最新 Codex runtime recovery 线(`13f701d4e` / `8c9f79f51` / `46ba80464` / `dd4288b12` / `08804d305`),只借 recovery/turn lifecycle 形状,不借 connected-service/account switching
- **额外参考**:issue-to-pr `739714b` 已把 Codex review 从全关沙箱改成 `codex exec -s read-only -c approval_policy="never"`,并收紧 Claude reviewer `--allowedTools`;这是 PR9/PR11 read-only enforcement attestation 的直接实战素材
- **收口**:PR9 已补 canonical reviewer parser/validator、read-only attestation 和 opt-in Codex reviewer smoke。剩余阻塞转移到 PR11 的 second provider 接线。

#### 2. **PR10(M6a Consumer CLI Experience) — 已处理**

- **why P0**:当前 consumer 只能跑 `npm run demo:m5` 硬编脚本,没有"开发者本地能用"的 CLI。这是 HOLP 从"协议跑通"到"有人能上手"的关键——也是 README 当前能诚实声称的"参考 consumer CLI" 真正能用的状态
- **当前事实**:`consumers/cli/` 已有 M1 闭环 demo + m5-consensus-demo.ts,但偏脚本化、协议验证用
- **不依赖**:PR9(可以先用 fake reviewer 跑 PR10;PR9 完成后再加真实 reviewer opt-in 渲染)
- **阻塞**:HOLP 对外被试用的可能性

### 🟠 P1 — 推进 vendor-neutral 主张

#### 3. **PR11(M6b Second Real Provider — native-claude headless reviewer)**

- **why P1**:HOLP "vendor-neutral" 主张不能只停在 Codex 一家。接 native-claude headless reviewer 是证明协议层不只是 Codex-only 的最小步骤
- **依赖**:PR9 已完成,PR11 复用 PR9 canonical parser / read-only attestation gate,并通过 HOLP `AgentBackend` contract 接入,不是外部脚本 smoke
- **参考素材**:spec 已自含完整 Claude CLI 参数说明(`-p` / `--output-format json` / `--allowedTools` / `--permission-mode` / `--setting-sources`)
- **不依赖**:Issue #18 (happier AcpBackend) — 那是 ACP 接线,native-claude 是 headless
- **收口**:本 PR 已补 `native-claude` Claude Code `-p --output-format json` adapter、outer CLI JSON fail-closed、runtime matrix 和 opt-in smoke。缺 deny-write evidence 时仍 degraded/INCONCLUSIVE,不冒充 ready。

#### 4. **Issue #17(Codex runtime recovery)的"细分"独立项**

注:#17 基础 runtime recovery 已落地;PR9 已在此基础上补 read-only enforcement attestation 和 canonical reviewer parser。当前 Codex declaration 仍不能证明 enforced read-only,所以真实 reviewer smoke 必须 fail-closed/INCONCLUSIVE,不能把 degraded runtime 当 completed vote。loopwright V2.4 的 failure taxonomy / availability feedback(`fb8a0dd` / `bea0f5c`)已作为 transient / unavailable 分类参考,但没有搬它的整套 orchestrator。

### 🟡 P2 — 完整性 / 矩阵化

#### 5. **PR12(M6c Runtime Surface and Session Matrix)**

- **why P2**:v0.1.5 已经把 runtime surface / isolation matrix 提升为协议基准;PR12 已补 consumer matrix report foundation,让用户能看到"为什么这个 agent 能做 reviewer,为什么那个被拒绝"
- **依赖**:PR10(CLI 容器)+ PR11(第二 provider 提供 matrix 多样性)。两者完成后,PR12 可以把 Codex/Claude/fake/acp/direct 的 readiness 差异做成 consumer-visible report。
- **收口**:direct channel 词表已加 `observe`/`read`;CLI report 已区分 observation surface 与 control surface。真实 ACP/direct session、cmux/Warp/tmux UI 控制和稳定 event model mapping 仍是后续项。
- **参考素材**:loopwright V2.4 `harness_registry` / registry-derived selection / availability invalidation(`3b445bb` / `fa30943` / `bea0f5c`)可作为 PR12 matrix 与 eligibility resolver 分层参考

#### 6. **Issue #18(PR11/M6b ACP 参考素材)**

- **why P2**:PR11 已选 native-claude headless 优先,不是 ACP。Issue #18 是为更远的 ACP 接线准备的素材池——只在 PR11 完成后、想接 ACP 时才用得上
- **状态**:纯记录,不主动启动

#### 7. **Issue #19(PR9 codex-native-review 参考素材)**

- **状态**:PR9 实施时已回查并吸收为 canonical parser / prompt / smoke 参考。PR9 合并后已关闭。

#### 8. **roadmap:M2 heartbeat 转交后续**

- **状态**:契约层小补丁,spec 已明示在 `m2_contract.test.ts §F` 锁定边界。可在任何 PR 顺手补完
- **不阻塞**:任何主线

#### 9. **roadmap:M4a `permission_surface` / `observability_surface` 接真实来源**

- **状态**:当前统一 `unknown`,等 PR11 第二真实 provider 提供具体声明来源
- **依赖**:PR11

### 🔵 P3 — 远期参考 / 不主动启动

#### 10. **Issue #22**(跨仓 review 参考与提醒)

- **状态**:研究记录,无 deliverable。后续 PR review 时引用章节号(A1-A6 / B / C / D)

#### 11. **Issue #20**(V3 Remote warp 素材池)

- **状态**:V3 proposal 启动前不动

#### 12. **Issue #21**(V3+ skypilot 素材池)

- **状态**:V3+ proposal 启动前不动

#### 13. **roadmap:真实 OS/provider isolation enforcement**

- **状态**:positioning 明示 v0.1.5 baseline 只到声明层。enforcement 是更远期工作

---

## 推荐执行序

```
P0-1: #17 (Codex recovery 底盘,已落地) ──┐
                                     ├─→ PR9 (真实 reviewer pilot)  ──┐
                                                                       │
P0-2: PR10 (Consumer CLI 体验)  ─────────────────────────────────────┤
       (可并行,先用 fake reviewer)                                    │
                                                                       ▼
                                              PR11 (native-claude headless reviewer)
                                                          │
                                                          ▼
                                              PR12 (matrix consumer view)
                                                          │
                                                          ▼
                                              M4a permission/observability 接真源
                                              (顺路收口)
```

**关键路径**:PR12;#17、PR10、PR9、PR11 已作为前置底盘/体验/pilot/second-provider partial 落地。

**P0 阻塞依赖**:#17 已解除 PR9 的 stdio/turn recovery 底盘阻塞;PR9 已解除 PR11 所需的 reviewer parser / read-only attestation 机制阻塞。

**P0 可并行**:PR10 已提前落地;后续 PR11/PR12 继续串行推进。

**P2/P3 全部不阻塞主线**——可以在等 review、等 smoke 等空档顺手做。

---

## 一句话

**历史结论**:当时最该启动的是 PR12。现在 PR12 已落地,下一步按 `docs/holp-blueprint.md` 启动 M7 foundation loop:WorkPlanner / multiround step loop / L0 workflow / step-level JSONL export。

---

## 附录:数据来源与核实方法

本排序基于 2026-06-22 完成的跨仓 review,覆盖:

- happier:379 commits since 2026-05-15(真正影响 HOLP 主线的是 Codex app-server recovery / native review / ACP 相关路径)
- warp:70 commits since 2026-05-15(7 个 Remote/Oz 相关 commit 已拆 #20,仍属 V3 边界外)
- loopwright:146 commits since 2026-05-15(V2.4 PR-α/β/γ/δ + PR-A/B 对 #17/PR12 有参考价值)
- cmux:130 commits since 2026-05-15(当前核实未改变 HOLP 对 CmuxEventBus 的引用边界)
- spawn / happy-cli-snapshot / warp-proto-apis:零或近零更新(spawn 本地 1 commit,仅 gitignore)
- skypilot:~22 commits
- issue-to-pr:90 commits since 2026-05-15,其中 `739714b` 对 review-only CLI/read-only enforcement 有直接参考价值

对照 23 个候选影响点 → 双边读真代码核实 → 真实剩余 1 项需 holp 主动处理(#17),4 项未来素材记录(#18-#21),18 项排除/降级为研究备查(#22)。

跨仓 review 的完整逻辑见 #17/#18/#19/#20/#21/#22 各 issue 的「参考素材」「不要直接搬」章节。
