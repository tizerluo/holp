# Issue #45 - Multi-Agent CLI Runtime Surface Completion

## Summary

Issue #45 is a pre-#41 runtime-surface parity phase. PR14 proved a first-batch
harness pilot, but it did not prove full `headless` + ACP/native-or-bridge +
`direct_user_session` parity for the bounded CLI cohort.

This phase exists to keep learned-router data readiness honest: #41 may build
recording/export/artifact foundations, but it cannot claim training data
sufficiency for #36 until the runtime candidate space is broad enough to audit
and an external terminal-style consumer can use HOLP public wire.

#46 scope is documentation only: baseline matrix, evidence requirements,
dependency gates, and execution order. It must not change adapters, daemon
runtime behavior, protocol wire, or tests.

## Dependency Rule

Hard gate:

- #45 blocks #41's data-sufficiency declaration.
- #45 blocks #44's model compatibility constraints from being meaningful.
- #45 therefore blocks #36 real learned-active readiness.

Release conditions:

- #41 may claim learned-router training data sufficiency only after #52 records
  that the bounded cohort matrix and terminal-consumer smoke are complete enough
  for training distribution coverage.
- #44 may apply model artifact compatibility constraints only after the matrix
  has per-surface readiness/fidelity rows; otherwise the model target space is
  underspecified.
- #36 real learned-active readiness stays downstream of both #41 data
  sufficiency and #44 compatibility constraints.

Not a hard gate:

- #42 live stop-decision sample recording may proceed in parallel.
- #43 dataset manifest and export health reporting may proceed in parallel.

#42 and #43 are plumbing contracts. Their outputs must carry a
training-distribution caveat until #45 is complete.

## Bounded Cohort

This phase covers seven CLI agents:

- Existing live cohort: Codex, Claude Code.
- PR14 first-batch cohort: Cursor Agent, Kimi Code, OpenCode, Pi, Reasonix.

It does not claim the roadmap's deferred 12-agent full coverage.

## Surface Contract

Each target agent must declare every relevant surface as `ready`, `degraded`,
`rejected`, or `unsupported`, with evidence. Unknown or unsupported surfaces
must never be counted as ready.

- `headless`: real one-shot CLI/server path; empty output, auth prompt,
  permission/error text, or non-terminal output fails closed.
- ACP/native-or-bridge: native ACP, official bridge, or explicitly named
  HOLP-owned bridge. Explicit ACP selection must not fall back to headless.
- `direct_user_session`: HOLP-created throwaway tmux/PTY session only; no
  attach to existing user shells. Owner verification is mandatory before ready.

Claude Code has no native ACP. Claude ACP-like parity must either be an
explicit HOLP-owned stream-json bridge with declared fidelity
(`one_shot` or `streaming_controlled`) and fail-closed behavior, or an honest
`unsupported` / `rejected` state.

## Baseline Matrix

This matrix is the #46 baseline for the bounded cohort. It records what the
current implementation can honestly claim before the child PRs run. A blank
cell is never ready; every cell must resolve to `ready`, `degraded`,
`rejected`, or `unsupported` with evidence before #52 can pass the phase gate.

`ready` in later PRs requires matching-surface smoke/probe evidence. A
headless pass cannot prove ACP readiness, an ACP pass cannot prove direct
session readiness, and a matrix declaration alone cannot prove schedulability.

| Agent | `headless` baseline | ACP/native-or-bridge baseline | `direct_user_session` baseline | Evidence refs |
| --- | --- | --- | --- | --- |
| Codex | `degraded` by default; `ready` after headless app-server probe succeeds (codex --version + doctor auth + initialize). #48 wired. | `degraded` by default (fail-closed, `codex_acp_smoke_not_enabled`); upgrades to `ready` only after real ACP handshake + `HOLP_OK` under `HOLP_REAL_CODEX_SMOKE=1`. #48 wired. | `degraded` by default (fail-closed, `codex_direct_smoke_not_enabled`); upgrades to `ready` only after holp-owned tmux probe + agent `HOLP_OK` under opt-in smoke. #48 wired. | `adapters/codex-app-server.ts` codexRuntimeSurfaces(); `adapters/registry.ts` per-surface map; `scripts/smoke/codex-surfaces.ts`. |
| Claude Code | `degraded` until #49 records Claude Code `-p --output-format json` evidence and read-only attestation outcome. | `unsupported`; Claude Code has no native ACP. | `rejected`; unwired. | `adapters/claude-code.ts` reports `claude_code_print_json`, `claude_code_no_acp`, and `direct_user_session_not_declared`. |
| Cursor Agent | `degraded` until #51 records matching headless smoke evidence. | `degraded` until #51 records real ACP terminal smoke evidence. | `rejected`; not declared until #50. | `adapters/first-batch-harnesses.ts`; `scripts/smoke/harnesses.ts`. |
| Kimi Code | `degraded` until #51 records matching headless smoke evidence. | `degraded` until #51 records real ACP terminal smoke evidence. | `degraded`; only current direct tmux definition, still capability/owner verification gated for #47/#50. | `adapters/first-batch-harnesses.ts` Kimi `direct` definition; `adapters/direct-tmux.ts`. |
| OpenCode | `degraded` until #51 records matching headless smoke evidence. | `degraded` until #51 records real ACP terminal smoke evidence. | `rejected`; not declared until #50. | `adapters/first-batch-harnesses.ts`; `scripts/smoke/harnesses.ts`. |
| Pi | `degraded` until #51 records matching headless smoke evidence. | `degraded` until #51 records real `pi-acp` terminal smoke evidence. | `rejected`; not declared until #50. | `adapters/first-batch-harnesses.ts`; `scripts/smoke/harnesses.ts`. |
| Reasonix | `degraded` until #51 records matching headless smoke evidence. | `degraded`; `session/new` / prompt terminal path is not stable enough to count ready. | `rejected`; not declared until #50. | `adapters/first-batch-harnesses.ts` Reasonix degraded reason path; `scripts/smoke/harnesses.ts`. |

PR14 proved a first-batch harness pilot. It did not prove this full bounded
cohort matrix, and it wired a direct tmux path only for Kimi Code. #47 must
generalize that foundation before #48-#50 can claim direct parity.

For first-batch agents, #51 owns combined headless+ACP smoke revalidation
because the existing harness smoke probes both surfaces before checking ACP
schedulability. #50 owns direct-session parity for the same first-batch cohort.

## Evidence Requirements

- `headless`: record CLI/tool version, auth or quota context, command, cwd/env
  flags, non-empty machine-checkable output or transport success marker, and
  fail-closed behavior for empty output, auth prompts, permission/error text,
  non-zero exit, and timeout.
- ACP/native-or-bridge: prove real `initialize`, session create/new, prompt or
  update, explicit terminal/final signal, cancel/timeout handling, and
  governance evidence. Explicit ACP selection must never fall back to headless.
- `direct_user_session`: use only HOLP-created throwaway tmux/PTY sessions in a
  HOLP-owned namespace. Ready requires `observe`, `read`, `inject`,
  `interrupt`, `cancel`, cleanup, and `owner_verified`; any missing control
  capability is degraded or rejected, not ready.
- Terminal consumer smoke: use HOLP public wire only. It may prove
  `terminal-consumer-integration-ready`, but it cannot prove `cmux-ready`
  unless real cmux automation or user validation is also recorded.

## External Agent Fallback Contract

Role fallback may change who reviews or tests a PR. Runtime-surface fallback
must never change what is counted as ready: headless, ACP/native-or-bridge, and
direct session readiness can only be proven by matching-surface probe/smoke
evidence.

Architect and external reviewer fallback order:

1. Claude Opus via Pioneer 100U
2. Claude Opus via Pioneer 50U
3. Claude Opus via official OAuth
4. ZCode
5. Kimi Code
6. Internal Codex subagent only

When invoking Claude Opus, use high reasoning effort rather than max effort
unless a per-PR spec explicitly requires max effort. This preserves quota while
keeping the review strong enough for this phase.

Tester fallback order:

1. Kimi Code
2. ZCode
3. Internal Codex subagent only

Every PR under this phase must record an external agent fallback ledger in the
PR comments or Merge Gate report. The ledger must include the planned chain,
actual agent/model/provider/mode, fallback reason, evidence class, and whether
the result is external or internal-only. If all external agents fail and the PR
uses only internal subagents for a role, state that explicitly.

External agent runs should be given enough time for model startup, thinking, and
final report generation. A quiet long-running process is not by itself a
fallback trigger; fallback only after an explicit quota/session/auth/rate-limit
failure, process exit, invalid or missing final output, or another concrete
blocking condition.

After each PR completes, Commander should inspect and clean up live subagents
before starting the next PR so the next review/fix loop has available slots.

## Execution Order

The #45 child PRs run strictly in this order:

`#46 -> #47 -> #48 -> #49 -> #50 -> #51 -> #54 -> #52`

#54 must run before #52 because it produces the terminal-consumer smoke evidence
that #52 consumes in the final validation matrix and #41 data-sufficiency gate.
#41, #44, and #36 are downstream consumers of the phase result, not child steps
inside this execution sequence. #53 already created this prerequisite phase and
is historical context, not part of the remaining execution chain.

## Child Issues

1. #46 - Runtime surface completion SPEC and baseline matrix
2. #47 - Generalize direct tmux for the bounded CLI cohort
3. #48 - Codex headless/ACP/direct runtime surface parity
4. #49 - Claude Code headless/ACP-bridge/direct runtime surface parity
5. #50 - First-batch direct session parity
6. #51 - First-batch ACP readiness hardening
7. #54 - Terminal consumer integration smoke before #41 data sufficiency
8. #52 - User validation matrix and gate for multi-agent CLI surfaces

Per-PR specs for these child issues should be written when each issue starts,
using the then-current main branch. Do not pre-write detailed implementation
specs for all eight children in this master spec.

Gate ownership:

- #54 owns `terminal-consumer-integration-ready`: a generic terminal-style
  consumer smoke over HOLP public wire, not a cmux adapter.
- #52 owns `cmux-pending-user-validation` and the final #41 gate decision.
- #52 may record `cmux-ready` only after real cmux automation or explicit user
  validation. No child PR in this phase builds a full cmux, Warp, or terminal
  product UI adapter.

## Completion Criteria

- The bounded cohort has a reviewed runtime-surface matrix with evidence refs.
- Ready means a real smoke/probe passed locally or in CI with documented auth
  and tool-version context.
- Degraded/rejected/unsupported states include actionable reasons.
- User validation records the local CLI versions, env flags, commands, outcomes,
  skipped paths, and hard stops.
- A terminal-consumer smoke proves an external terminal-style consumer can use
  HOLP public wire without reading daemon internals.
- The validation gate distinguishes `terminal-consumer-integration-ready`,
  `cmux-ready`, and `cmux-pending-user-validation`. It must not claim
  `cmux-ready` without real cmux automation or user validation.
- #41 can explicitly distinguish narrow plumbing data from runtime-surface and
  terminal-consumer sufficient learned-router training data.

## Non-Goals

- Do not train a learned model.
- Do not connect learned-active execution.
- Do not claim #36 active/canary readiness.
- Do not start PR17 Remote work.
- Do not implement full cmux, Warp, or terminal-product UI.
- Do not claim 12-agent full coverage.
