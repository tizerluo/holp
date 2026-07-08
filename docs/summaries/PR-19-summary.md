# PR-19 ZCode adapter summary

## Upstream recommendation status

1. **Registry entry**: implemented. `zcode` is an independent default registry transport, not added to `FIRST_BATCH_TRANSPORTS`.
2. **Headless CLI definition**: implemented. Args are `--prompt`, `--mode`, `--json`, `--cwd`; completion requires rc 0 plus JSON `response`.
3. **Direct tmux definition**: implemented. Args are `--prompt`, `--mode build`, `--json`, with no `--cwd`; direct model requests fail closed through `direct_tmux_model_unsupported`.
4. **Direct marker behavior**: implemented by reusing existing direct-tmux marker and echoed-marker stripping.
5. **ACP bridge**: unsupported declaration only. `surface_support:"unsupported"` with `zcode_acp_bridge_not_certified` readiness reasons; no bridge adapter and no ready claim.
6. **Credentials**: implemented for headless. The adapter reads enabled provider config and injects `ANTHROPIC_API_KEY` / `ZCODE_BASE_URL` / `ZCODE_MODEL`; per-run env may override only `ZCODE_MODEL` / `ZCODE_BASE_URL`.
7. **Probe**: implemented. Binary/version plus credential config are checked; real headless smoke is gated by `HOLP_REAL_ZCODE_SMOKE=1`.
8. **Prompt guard**: out of scope. This remains caller/reviewer prompt discipline, and ZCode is not added to the reviewer roster in this PR.
9. **Resume semantics**: out of scope. CLI `--resume` / ACP resume require the HOLP long-run/resume design.

## Verification

- `npm run typecheck`: passed with 0 TypeScript errors.
- `npm test`: passed, `41` test files, `450 passed | 2 skipped` tests (`452` total). Baseline in task was `40` files / `439` tests, net `+1` file and `+11` passing tests.

## Fake and smoke coverage

- Fake zcode CLI covers warning-prefixed stdout plus JSON `response` parsing, rc nonzero failure, credential env injection, config-missing fail-closed, and opt-in probe promotion.
- Fake tmux covers zcode direct argv shape and verifies no `--cwd` is passed in direct mode.
- The real zcode smoke is present but skipped by default; it only runs when `HOLP_REAL_ZCODE_SMOKE=1` is set.
- Tests use temp config fixtures with fake keys and do not read the real `~/.zcode/v2/config.json`.

## FIXUP-1

1. **FIX-1(P1)**: reverted `surface_support` to the pre-PR enum shape by removing `degraded` from the protocol/spec and implementation type. ZCode ACP now declares `surface_support:"unsupported"` while preserving `zcode_acp_bridge_not_certified` in readiness reasons.
2. **FIX-2(P1)**: changed per-run ZCode env overrides so empty strings no longer erase config-derived `ZCODE_BASE_URL` / `ZCODE_MODEL`; added a regression test for empty-string overrides.
3. **FIX-3(P2#4/#5)**: kept the cross-line balanced JSON scanner and now selects the last legal JSON object that contains a `response` field, so usage trailers do not mask the model response. Added the scanner assumption comment that only line-leading `{` blocks are considered.
4. **FIX-4(P2#6)**: added fail-closed tests for empty apiKey, disabled providers, and invalid config JSON, plus a credential non-leak regression over emitted messages and error payloads.
5. **FIX-5(simplifier shrink)**: reduced repeated degraded readiness objects with a helper, simplified ZCode probe reason selection with early returns, narrowed ZCode resolved roles to `coder`, removed the dead supported branch in direct channel declaration, and kept local `isRecord` / `stringValue` helpers because no shared equivalent exists.
6. **FIX-6(smoke timeout)**: removed the 20s ZCode real-smoke clamp in `createZcodeProbe` and raised the ZCode adapter heavy-test timeout to 150s for real CLI latency under vitest load.
7. **FIX-7(real-smoke gate)**: cached `HOLP_REAL_ZCODE_SMOKE` before cleanup hooks and re-applied it inside the real smoke test so same-file cleanup cannot self-disable the probe.
8. **FIX-8(direct gate)**: kept ZCode direct degraded by default and promotes `coder_worktree` only when `HOLP_REAL_ZCODE_SMOKE=1` plus tmux capability probing succeeds.

Hard gates:

- `npm run typecheck`: passed with 0 TypeScript errors.
- `npm test`: passed, `41` test files, `455 passed | 2 skipped` tests (`457` total).

## Backlog(评审遗留,不修)

- Do not replace the balanced JSON parser with split-and-parse. Real ZCode `--json` evidence is multi-line pretty-printed JSON, so the one-line simplifier assumption is invalid.

## e2e 验收

- gated smoke:`HOLP_REAL_ZCODE_SMOKE=1 npx vitest run adapters/zcode.test.ts` 17/17 全绿 0 skip;probe 真跑一轮 `zcode --prompt` 拿到 `HOLP_OK` 升 ready。
- e2e 真单:MCP stdio client 经 holp-mcp `holp_run` 调 `worker: zcode-agent`,走 `direct_user_session` 真 tmux `/tmp/holp/zcode-26198`。
- pane 内执行 `'zcode' '--prompt' ... '--mode' 'build' '--json'`,JSON `response` 精确返回 `ZCODE_HOLP_E2E_b7c1`。
- run 终态 `merged`(`gate_report` seq 12),`run_id=run_1`,`session=holp-1783523676512-8d23a722cea06`;holp-mcp `configuredTransports` 需加 `zcode`(holp-mcp 仓已改,另行提交)。
