# HOLP x Learned Router - 方向性框架

> 版本: draft v0.2
> 目的: 把 Sakana Fugu / TRINITY / Conductor 的启发,落到 HOLP 的真实边界上。
> 结论: HOLP 先做可观测、可回退、可导出数据的编排基座;learned router 是后接的小决策层,不是 HOLP 本体。

## 0. commander 与 router 的区别

- **commander**: 写 spec、拆 plan、生成自然语言任务、综合评审结果。它创造内容,仍应由强模型和人类工作流承担。
- **router / WorkPlanner**: 做选择题,例如“这一步派哪个 worker、用什么角色、是否进入 review/fix/test”。它不写代码、不写 spec、不替代人。

HOLP 要复刻的是 learned router 的思想,不是把 commander 也做成小模型。

## 1. 外部调研结论

一手来源:

- Sakana Fugu: https://sakana.ai/fugu/
- Fugu release: https://sakana.ai/fugu-release/
- TRINITY: https://sakana.ai/trinity/
- TRINITY paper: https://arxiv.org/html/2512.04695v3
- Conductor: https://sakana.ai/learning-to-orchestrate/

可采信事实:

- Fugu 对外提供单一 OpenAI-compatible API,内部是多 agent / 多模型 orchestration。
- TRINITY 是 learned coordinator,通过轻量 coordinator 在多轮过程中选择 LLM 并分配 Thinker / Worker / Verifier 等角色。
- TRINITY 论文描述了 sep-CMA-ES 等 coordinator 优化方式;这只作为论文事实记录,不是 HOLP 的实现要求。
- Conductor/Fugu Ultra 方向是学习自然语言 agentic workflow / orchestration;公开信息足够做方向参考,不足以在 HOLP 里硬写具体训练细节。

HOLP 采用的启发:

- orchestration 决策需要多轮 state/history,不是只看一次 prompt。
- learned 组件应先离线评估和 shadow,再考虑 active。
- rollout / reward 成本很高,所以训练数据宁少勿脏。

需要避免的错误表述:

- 不写“TRINITY 只选 worker、忽略角色选择”。
- 不写“Fugu 小模型替代强模型做 commander”。
- 不写“HOLP 现在缺的就只有 router”。HOLP 还缺多轮基座、step history、样本导出和评估闭环。

## 2. HOLP 现在的位置

当前 HOLP 已有:

- 协议和参考 daemon。
- fake multi-agent consensus demo。
- Codex app-server adapter 与 native-claude headless reviewer partial。
- governance event/decision/run state/registry 数据底座。
- consumer CLI 和 runtime/session matrix report。

当前 HOLP 缺:

- 多轮 step loop。
- 工作流模板和 step history。
- WorkPlanner 抽象。
- 训练样本导出与 reward 归因。
- 第一条真实 ACP/direct session path。
- stable consumer/gate surface。
- learned router 的 shadow/replay/active 接入。

因此 learned router 不是下一刀;下一刀是基座。

## 3. 目标架构

HOLP 分层:

- **Protocol**: wire、events、approval、artifact、consensus、runtime matrix。
- **Reference daemon**: run lifecycle、governance、adapter 调度。
- **WorkPlanner**: 在合法候选中选择下一步动作、agent、role。规则版默认;learned 版可选。
- **Adapters**: Codex、Claude、未来 ACP/direct session 等执行层。
- **Consumers**: CLI、未来 cmux/Warp/happier 等展示和交互层。
- **Router training**: 离线训练/评估,不进入协议核心。

关键边界:

- WorkPlanner 不绕过 safety gate。
- learned router 不直接执行任务。
- active learned routing 必须显式开启。
- 人类 approval 单通道不被替代。

## 4. 路线

最小顺序(对齐 `docs/holp-blueprint.md`):

1. M7 foundation loop:抽 `WorkPlanner` / `RuleWorkPlanner`,引入多轮 step loop、L0 静态 workflow、step history、JSONL exporter 和 reward versioning。
2. M8 real runtime surfaces:接第一条真实 ACP path 和 direct_user_session path。
3. M9 consumer and gate surface:把 gate/consensus/runtime/report 做成稳定 consumer 体验。
4. M10 learned router safe lane:offline replay / eval harness → `LearnedWorkPlanner` shadow → opt-in active/canary。
5. M11 dynamic workflow:L1 半动态 workflow,再到有证据支撑的 L2 全动态 workflow。

M12 Remote / distributed HOLP 属完整蓝图,不是 router 框架本身的训练/接入步骤。

这条路线的懒人原则: 能用规则跑的先用规则跑;数据不够前不训练;没有 shadow 证据前不 active。

## 5. 非目标

- 不复刻 Fugu 产品。
- 不在 HOLP wire 里暴露 provider 私有细节。
- 不把 learned router 设为必需。
- 不在 M7/M10 之前实现 Conductor 式 L2 全动态 workflow;L2 是 M11 目标。
- 不把 ACP/direct session 接入混进 router 基座;它们属于 M8 runtime surface。

一句话: HOLP 是开源、可观测、人在回路上的 orchestration protocol;learned router 只是将来可插拔的派单优化器。
