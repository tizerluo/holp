# Issue #45 - Multi-Agent CLI Runtime Surface Completion

## Summary

Issue #45 is a pre-#41 runtime-surface parity phase. PR14 proved a first-batch
harness pilot, but it did not prove full `headless` + ACP/native-or-bridge +
`direct_user_session` parity for the bounded CLI cohort.

This phase exists to keep learned-router data readiness honest: #41 may build
recording/export/artifact foundations, but it cannot claim training data
sufficiency for #36 until the runtime candidate space is broad enough to audit
and an external terminal-style consumer can use HOLP public wire.

## Dependency Rule

Hard gate:

- #45 blocks #41's data-sufficiency declaration.
- #45 blocks #44's model compatibility constraints from being meaningful.
- #45 therefore blocks #36 real learned-active readiness.

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

## Child Issues

1. #46 - Runtime surface completion SPEC and baseline matrix
2. #47 - Generalize direct tmux for the bounded CLI cohort
3. #48 - Codex headless/ACP/direct runtime surface parity
4. #49 - Claude Code headless/ACP-bridge/direct runtime surface parity
5. #50 - First-batch direct session parity
6. #51 - First-batch ACP readiness hardening
7. #52 - User validation matrix and gate for multi-agent CLI surfaces
8. #54 - Terminal consumer integration smoke before #41 data sufficiency

Per-PR specs for these child issues should be written when each issue starts,
using the then-current main branch. Do not pre-write detailed implementation
specs for all eight children in this master spec.

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
