# HOLP 当前 backlog 优先级排序

> 整理时间:2026-06-22
> 数据来源:GitHub 开放 issues + `docs/pr-specs/` + `docs/roadmap.md` + `README.md` 当前声明
> 整理依据:2026-06-22 跨仓 review 完成后,对照外部参考项目(happier / warp / loopwright / cmux / spawn / skypilot / issue-to-pr)真实代码核实;commit 数基于本地 checkout,未额外 fetch remote

## 全景:开放 issue + 未落地 spec + roadmap 未完成项

**6 个开放 issue**(2026-06-22 创建):

- [#17 M3 后续:Codex app-server runtime 健壮性补强](https://github.com/tizerluo/holp/issues/17)
- [#18 PR11/M6b 参考素材:happier AcpBackend 最新形态](https://github.com/tizerluo/holp/issues/18)
- [#19 PR9/M5b 参考素材:happier codex-native-review 模块](https://github.com/tizerluo/holp/issues/19)
- [#20 V3 Remote proposal 参考素材:warp Remote Agent Mode 全套](https://github.com/tizerluo/holp/issues/20)
- [#21 V3+ 跨云算力参考素材:skypilot K8s/metrics/job control 更新](https://github.com/tizerluo/holp/issues/21)
- [#22 跨仓 review 参考与提醒:happier 产品层差异 + warp 设计边界印证](https://github.com/tizerluo/holp/issues/22)

**4 个 planned PR spec**(写完未落地):

- `docs/pr-specs/pr9-m5b-real-reviewer-execution.md`
- `docs/pr-specs/pr10-m6a-consumer-cli-experience.md`
- `docs/pr-specs/pr11-m6b-second-real-provider.md`
- `docs/pr-specs/pr12-m6c-runtime-session-matrix.md`

**roadmap 未落地(README "[ ]" 项 + 未声明项)**:

- 真实 reviewer backend 执行 / 稳定 gate protocol surface
- M2 contract heartbeat 转交后续(`m2_contract.test.ts` §F 锁定边界)
- M4a `permission_surface` / `observability_surface` 仍统一为 `unknown`
- 真实 OS/provider isolation enforcement(v0.1.5 baseline 只到声明层)

---

## 优先级排序(高 → 低)

### 🔴 P0 — 阻塞健壮性 / 阻塞下一里程碑

#### 1. **Issue #17 + PR9(M5b 真实 reviewer execution pilot)联动**

- **why bundle**:PR9 spec 明示 *"`mcp-codex` reviewer 只有在可用 read-only enforced session 时才可执行"*,但当前 `codex-app-server.ts` 仍硬编码 `sandbox:"workspace-write"`。先做 #17 让 codex adapter 至少有 turn 重试/退避,再做 PR9 加 read-only path + reviewer parser,否则 PR9 的可靠 Codex real reviewer path 很容易被 stdio/turn 抖动打断
- **顺序**:#17 先(健壮性底盘)→ PR9(在底盘上接 reviewer)
- **参考素材**:Issue #17 本身 + Issue #19(codex-native-review 形状)+ happier 最新 Codex runtime recovery 线(`13f701d4e` / `8c9f79f51` / `46ba80464` / `dd4288b12` / `08804d305`),只借 recovery/turn lifecycle 形状,不借 connected-service/account switching
- **额外参考**:issue-to-pr `739714b` 已把 Codex review 从全关沙箱改成 `codex exec -s read-only -c approval_policy="never"`,并收紧 Claude reviewer `--allowedTools`;这是 PR9/PR11 read-only enforcement attestation 的直接实战素材
- **阻塞**:阻塞 PR9 的可靠真实 Codex reviewer path,并间接影响 PR11 的真实 cross-vendor consensus;不阻塞 PR10 的 fake consumer CLI

#### 2. **PR10(M6a Consumer CLI Experience)**

- **why P0**:当前 consumer 只能跑 `npm run demo:m5` 硬编脚本,没有"开发者本地能用"的 CLI。这是 HOLP 从"协议跑通"到"有人能上手"的关键——也是 README 当前能诚实声称的"参考 consumer CLI" 真正能用的状态
- **当前事实**:`consumers/cli/` 已有 M1 闭环 demo + m5-consensus-demo.ts,但偏脚本化、协议验证用
- **不依赖**:PR9(可以先用 fake reviewer 跑 PR10;PR9 完成后再加真实 reviewer opt-in 渲染)
- **阻塞**:HOLP 对外被试用的可能性

### 🟠 P1 — 推进 vendor-neutral 主张

#### 3. **PR11(M6b Second Real Provider — native-claude headless reviewer)**

- **why P1**:HOLP "vendor-neutral" 主张当前只有 Codex 一家——`native-claude/acp` 全是 stub。接 native-claude headless reviewer 是证明协议层不只是 Codex-only 的最小步骤
- **依赖**:PR9 应先完成(PR11 spec 里写明 "通过 HOLP AgentBackend contract 接入,不是外部脚本 smoke",且 read-only enforcement 复用 PR9 的 attestation 机制)
- **参考素材**:spec 已自含完整 Claude CLI 参数说明(`-p` / `--output-format json` / `--allowedTools` / `--permission-mode` / `--setting-sources`)
- **不依赖**:Issue #18 (happier AcpBackend) — 那是 ACP 接线,native-claude 是 headless

#### 4. **Issue #17(Codex runtime recovery)的"细分"独立项**

注:#17 已是 P0 联动里的依赖。如果在 PR9 真正用 reviewer pilot 前不做完,会反复踩 stdio 脆弱性。loopwright V2.4 的 failure taxonomy / availability feedback(`fb8a0dd` / `bea0f5c`)也可作为 #17 的 transient / unavailable 分类参考,但不应搬它的整套 orchestrator。

### 🟡 P2 — 完整性 / 矩阵化

#### 5. **PR12(M6c Runtime Surface and Session Matrix)**

- **why P2**:v0.1.5 已经把 runtime surface / isolation matrix 提升为协议基准,但 consumer 端**还没有 matrix report 体验**——用户没法看到"为什么这个 agent 能做 reviewer,为什么那个被拒绝"
- **依赖**:PR10(CLI 容器)+ PR11(第二 provider 提供 matrix 多样性)。其中 matrix report 容器依赖 PR10;有意义的 second-provider matrix 依赖 PR11;stub-shape matrix consistency 可提前做,但只能声明 foundation,不能声明第二 provider ready
- **新增工作**:direct channel 词表加 `observe`/`read` 字段(spec 已声明 gap)
- **参考素材**:loopwright V2.4 `harness_registry` / registry-derived selection / availability invalidation(`3b445bb` / `fa30943` / `bea0f5c`)可作为 PR12 matrix 与 eligibility resolver 分层参考

#### 6. **Issue #18(PR11/M6b ACP 参考素材)**

- **why P2**:PR11 已选 native-claude headless 优先,不是 ACP。Issue #18 是为更远的 ACP 接线准备的素材池——只在 PR11 完成后、想接 ACP 时才用得上
- **状态**:纯记录,不主动启动

#### 7. **Issue #19(PR9 codex-native-review 参考素材)**

- **状态**:是 PR9 实施时回查的素材池。PR9 启动时同步用,不单独排期

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
P0-1: #17 (Codex recovery 底盘)   ──┐
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

**关键路径**:#17 → PR9 → PR11 → PR12,同时 PR10 可并行提前落地;**约 4-5 个 PR 完成 M5b + M6 完整体验**(取决于 #17 是否拆成独立 PR)。

**P0 阻塞依赖**:#17 是 PR9 的可靠性底盘——不做 #17 就让 PR9 的真实 Codex reviewer path 在 stdio/turn 抖动里反复爆炸;但它不阻塞 PR10 的 fake path CLI。

**P0 可并行**:PR10 可以提前做(用 fake registry 跑 consumer 体验),不必等 PR9。

**P2/P3 全部不阻塞主线**——可以在等 review、等 smoke 等空档顺手做。

---

## 一句话

**当前最该启动的是 #17**(Codex runtime recovery 底盘),**与 PR10 可以并行**(一个补底盘、一个补体验)。PR9 的可靠 Codex reviewer path 应在 #17 之后做,PR11 必须在 PR9 之后才能跑通真实 cross-vendor consensus,PR12 的完整 matrix 展示应在 PR10+PR11 后做。其余全是参考素材或远期工作。

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
