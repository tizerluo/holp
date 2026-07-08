> status: open

# PR18 Per-run env/model passthrough(consumer-driven)

## Summary

让 consumer(第一需求方:holp-mcp 的 `holp_run({env?, model?})`)能按 run 指定 worker 的环境变量与模型,全链打通:协议 → orchestrate.run handler → backend factory → 各 adapter 真实消费。吸收 drive-codex 技能对照表(holp-mcp `docs/drive-codex-absorption.md`)upstream 清单的第 1、2 条。

不是 declaration:验收必须是 holp-mcp 发 `holp_run({model, env})` 后,**真实 codex 进程**的 banner 显示指定模型、worker 进程环境里能读到指定变量,端到端有证据。

## 当前代码现实(全部已核实,文件:行号)

- **consumer 侧已就绪**:holp-mcp `src/holpService.ts` 的 `run()` 已把 `env`/`model` 条件写入 `orchestrate.run` params(holp-mcp PR-2,2026-07-08);daemon handler 逐字段解析、未知字段静默忽略(已实测无害),所以此 PR 落地即生效,consumer 无需再改。
- **adapter 接口早留了口子**:`adapters/agent-backend.ts:82-84` 的 `AgentBackendOptions` 已有 `env?: Readonly<Record<string, string>>` 和 `modelId?: string`。
- **断在中间两层**:
  - `daemon/handlers/orchestrate_run.ts` 不解析 params 里的 env/model(grep 0 匹配);
  - factory 调用(`orchestrate_run.ts:580-587`)不传 env/modelId。
- **adapter 消费现状不一**:
  - `codex-app-server.ts:494` 已消费 `opts.modelId`(`if (this.opts.modelId) params.model = ...`);`:1040` 已合并 env。**headless 面基本只差上游接线。**
  - `direct-tmux.ts:387-392` 的 `runCommand` spawn 用 `envWithoutTmux`,不合并 `opts.env`。**且注意:这个 spawn 起的是 tmux 客户端命令,pane 内 worker 进程的 env 继承自 tmux server**——只在"该 spawn 恰好首次拉起 tmux server"时合并 spawn env 才有效。稳妥做法是 `tmux set-environment`(session 级)或 `new-session` 时显式注入,不能只改 spawn env。
  - `registry.ts:277-287` codex direct 的命令 args 硬编码,无 model 注入点;`agentArgsForPrompt` 需参数化以支持 `-m <model>`(codex `-m` 非法名报错不回退,fail-fast 特性可依赖)。
- **协议约束(必须正面处理)**:`protocol/spec.md` 的凭证纪律是 `auth_ref`(`env:XXX`|`login:agent`|`secret:name`),**不传明文**。per-run `env` 若允许裸传密钥值,与此纪律冲突。

## Key Changes

1. **协议增补(spec §4 + version.md minor bump)**:
   - `orchestrate.run.roles.<role>` 增加可选 `model?: string`(per-role:coder 与 reviewer 可不同模型)。
   - `orchestrate.run.roles.<role>` 增加可选 `env?: Record<string, string>`。
   - **env 的凭证纪律**:spec 明文规定 per-run env 用于**非机密配置**(如 `CODEX_HOME` 路径、代理开关);机密仍走 `auth_ref` 通道。实现层按 key deny-pattern 校验,env key 必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`,env value 不得含 C0 控制字符或 `0x7f`。首版不做 value 密钥形状检测,也不提供 `allow_secret_env` 协商,但必须写清边界,不许静默放行明文密钥。
   - 未知/非法类型 → `invalid_request`,与现有错误模型一致。
2. **handler 解析**:`orchestrate_run.ts` 解析校验上述字段,存入 run record。
3. **factory 接线**:factory 调用传 `env` / `modelId` 进 `AgentBackendOptions`(接口零改动)。
4. **adapter 消费补齐**:
   - app-server:上游接通即可(消费代码已在),补测试。
   - direct-tmux:session 级 env 注入(`set-environment` 或 new-session 注入,不是只改 spawn env);registry 的 `agentArgsForPrompt` 参数化支持 model 注入。
   - cli-harness:合并 `opts.env`。
5. **测试**:contract test 新字段(合法/非法/缺省);direct-tmux env 注入需要真 tmux 测试(证 pane 内进程真读到,不是 spawn env 自嗨);codex `-m` 非法名的 fail-fast 路径。
6. **验收(端到端)**:holp-mcp 真机发 `holp_run({model, env})` → codex banner 显示指定模型(看 banner 不信自报)+ worker 内 `printenv` 证据。holp-mcp 侧集成测随后扩(consumer 仓自己的 PR)。

## Out of scope(对照表 upstream 清单其余三条,单列后续)

- banner 解析(direct-tmux 不信模型自报)——独立小 PR。
- sandbox/approval flags 参数化(`registry.ts:279-282`)——涉及风险策略,单独立项。
- codex session resume(app-server `ephemeral:true`)——依赖 holp long-run 语义讨论。

## 风险与边界

- env 明文密钥是本 PR 最大的协议风险点,宁可首版只允许 allowlist 配置类变量,也不放开裸密钥。
- direct-tmux 的 env 注入若与已存在 tmux server 的全局 env 冲突,以 session 级为准;测试须覆盖"server 已在"场景。
- 全程保持 fail-closed:model/env 声明了但 adapter 面不支持 → 显式 degraded/错误,不静默丢弃(与 runtime surface 纪律一致)。

## e2e 验收证据(2026-07-08,真机)

1. 探针方式:MCP stdio client 经 holp-mcp 调 `holp_run({goal: printenv HOLP_PR18_PROBE, worker: codex-agent, model: gpt-5.4-mini, env: {HOLP_PR18_PROBE: pr18_e2e_9f3a}})`,`direct_user_session` 真 tmux + 真 codex。
2. 证据:`run_id=run_1`,`session=holp-1783517528655-092489db7a843`;direct 命令行含 `-m 'gpt-5.4-mini'`;codex 启动 banner 行 `model: gpt-5.4-mini`(以 banner 为准,非模型自报);worker `printenv` 输出 `pr18_e2e_9f3a`。run 终态 `merged`,gate_report seq 17。
3. 消费方修正记录:首轮 e2e 失败(banner 显示默认 gpt-5.5、printenv 空),根因是 holp-mcp 曾把 model/env 放 `orchestrate.run` 顶层,与协议 per-role(`roles.<role>.model/env`)不符;已在 holp-mcp 仓修复(挪入 `roles.coder`),本仓零改动。daemon 对顶层未知字段 model/env 静默接受,该宽松行为记为已知现状。
