# PR18 Slice A Summary

## Deliverables

1. Spec landed at `docs/pr-specs/pr18-run-env-model-passthrough.md` with first-line status changed to `> status: open`; remaining source content copied from the upstream task spec.
2. Protocol updated in `protocol/spec.md` and `protocol/version.md` to draft `v0.1.9`, adding `orchestrate.run.roles.<role>.model` and `env`.
3. `daemon/handlers/orchestrate_run.ts` now parses and validates per-role `model/env`, stores accepted role options on the run record, and maps coder options to `AgentBackendOptions.modelId/env`.
4. Backend factory wiring now carries coder `env/modelId` through both single-step and workflow paths; reviewer backend execution also forwards reviewer role options.
5. Adapter slice coverage:
   - Codex app-server: existing consumer path is now wired from handler; tests prove `modelId` reaches `thread/start` and `env` reaches the spawned fake app-server process.
   - CLI harness: existing spawn env merge is locked by a test proving `opts.env` is visible in the child process.
   - Direct tmux: fail-closed guard rejects any `opts.env` or `opts.modelId`; handler also rejects direct runtime env/model before run acceptance.
6. Contract coverage added for legal passthrough, illegal model/env types, deny-pattern key rejection, omitted-field backward compatibility, and direct-tmux fail-closed.

## Hard Gates

- `npm run typecheck`: passed, 0 errors.
- `npm test`: passed, 40 files / 434 tests.
- Baseline vs new: baseline 40 files / 427 tests; new 40 files / 434 tests; +7 tests.

## Deny Pattern

Implemented in `daemon/handlers/orchestrate_run.ts` as `SECRET_ENV_KEY_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i`.

The validator rejects matching env keys with JSON-RPC `invalid_request` and an error message that points users to `auth_ref`.

## Direct Tmux Fail-Closed

Implemented in two places:

- `daemon/handlers/orchestrate_run.ts`: selected `direct_user_session` runtime plus declared per-role env/model returns `unsupported_transport` with reason `direct_tmux_env_model_unsupported`.
- `adapters/direct-tmux.ts`: adapter factory throws `direct_tmux_env_model_unsupported` if constructed directly with `env` or `modelId`.

## Deviations

No deviation from Slice A scope. Direct tmux does not implement env/model support in this slice; it explicitly fails closed as required.

## Slice B

### Deliverables

1. Direct tmux now consumes per-run env by passing `-e KEY=value` to `tmux new-session` when creating the HOLP-owned worker session. This was chosen over post-creation `set-environment` because the pane shell is created with the session; injecting at `new-session` time makes the worker process inherit the session env instead of only changing the tmux client process env.
2. Direct tmux model handling is fail-closed per definition: definitions must opt into `supportsModelId`. The `mcp-codex` direct registry entry opts in and injects `-m <model>` into `codex exec`; definitions without support throw `direct_tmux_model_unsupported`.
3. Handler-level Slice A direct-tmux env/model rejection was removed so direct runtimes can pass role options to the selected backend factory, where support is decided by the adapter.
4. Tests updated from the Slice A fail-closed expectations:
   - fake tmux coverage proves env is passed as `new-session -e HOLP_FLAG=enabled`, not through spawned tmux client env.
   - registry unit coverage proves codex direct args include `-m <model>`.
   - handler coverage proves direct runtime env/model reaches the direct backend factory.
   - real tmux coverage pre-starts a server on the target socket, sets a conflicting global env value, then verifies the worker pane reads the session value.

### Hard Gates

- Slice A baseline: 40 files / 434 tests.
- `npm run typecheck`: passed, 0 errors.
- `npm test`: passed, 40 files / 437 tests = 436 passed / 1 skipped.
- Baseline vs new: +3 tests total, including +1 real-tmux skip in this sandbox.

### Real Tmux Skip

The current sandbox has `tmux` installed but cannot create `-S <socket>` servers (`Operation not permitted` while creating the socket, and `has-session` fails). The real tmux "server already running" test is therefore guarded by a socket smoke probe, emits an explicit warning, and skipped here. Orchestrator should rerun on a machine where tmux socket creation is permitted.

### Deviations

No scope deviation. The real tmux test was authored but skipped by sandbox capability; fake tmux and unit coverage still exercised the implementation path locally.

## FIXUP-1

1. `parseRoleEnv` now validates env key shape at the handler layer with `^[A-Za-z_][A-Za-z0-9_]*$`, returning JSON-RPC `invalid_request` before any runtime surface reaches adapter code. The direct-tmux guard remains as defense in depth.
2. `parseRoleEnv` now rejects env values containing C0 control characters or `0x7f` with `invalid_request`. `protocol/spec.md` and `docs/pr-specs/pr18-run-env-model-passthrough.md` document the value control-character discipline while keeping value secret-shape detection out of scope.
3. `parseSingleRoleRuntimeOptions` was inlined into `parseRoleRuntimeOptions`; the single-call wrapper was removed.
4. Handler coverage now includes invalid env key shape and newline-containing env value cases, alongside the existing legal passthrough and illegal type/secret-key assertions.

### Hard Gates

- `npm run typecheck`: passed, 0 errors.
- `npm test`: passed, 40 files / 437 tests = 436 passed / 1 skipped.

## Backlog(评审遗留,不修)

1. `roleOptionsRecord` 可内联为一行。
2. direct-tmux 真 tmux 测试与探针 ~15 行 bring-up/teardown 可提共享 helper。
3. `RoleRuntimeOptions.model` -> `modelId` 改名被编排方拒采。理由:`model` 是协议线上字段名,remap 是 wire -> adapter 边界翻译,非冗余。

## e2e 验收

2026-07-08 真机 e2e 使用 MCP stdio client 经 holp-mcp 调 `holp_run({goal: printenv HOLP_PR18_PROBE, worker: codex-agent, model: gpt-5.4-mini, env: {HOLP_PR18_PROBE: pr18_e2e_9f3a}})`,走 `direct_user_session` 真 tmux + 真 codex。
证据:`run_id=run_1`,`session=holp-1783517528655-092489db7a843`;direct 命令行含 `-m 'gpt-5.4-mini'`;codex banner 为 `model: gpt-5.4-mini`;worker `printenv` 输出 `pr18_e2e_9f3a`。run 终态 `merged`,gate_report seq 17。
首轮 e2e 失败是 holp-mcp 把 model/env 放在 `orchestrate.run` 顶层导致,已在 holp-mcp 仓改为 per-role `roles.coder.model/env`;本仓零改动。daemon 对顶层未知字段 model/env 静默接受,记为已知现状。
