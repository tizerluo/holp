# Issue #52 - User Validation Matrix and Gate for Multi-Agent CLI Surfaces

## Summary

Issue #52 is the final gate PR for the #45 multi-agent CLI runtime-surface
completion phase. It consumes the evidence produced by #46, #47, #48, #49, #50,
#51, and #54, then publishes a user-facing validation matrix and gate decision.

This PR must not implement new adapters, change runtime selection, add learned
model behavior, or claim full cmux/Warp/product UI readiness. Its job is to make
the phase outcome inspectable and reproducible enough for #41 to know whether it
may declare learned-router training data sufficiency.

## Current Baseline

- #46 created the #45 master spec, bounded cohort, evidence schema, and serial
  order.
- #47 generalized the direct tmux foundation for the bounded CLI cohort.
- #48 wired Codex headless, ACP, and direct runtime-surface parity evidence.
- #49 wired Claude Code headless and direct parity while keeping ACP honest as
  unsupported.
- #50 completed first-batch direct-session parity evidence.
- #51 hardened first-batch headless and ACP readiness evidence.
- #54 added `npm run smoke:terminal-consumer`, which proves a terminal-style
  consumer can use HOLP public wire against at least one #45-ready runtime
  surface. It emits `terminal-consumer-integration-ready` only after a terminal
  event and continues to emit `cmux-pending-user-validation` unless real cmux
  automation or explicit user validation exists.

## Goal

Add a durable validation record for #45 that answers:

1. Which bounded-cohort agent/surface cells are ready, degraded, rejected, or
   unsupported?
2. What command, env, auth/tool-version context, and evidence source supports
   each state?
3. Which cells count toward #41 learned-router training distribution coverage?
4. Whether #41 may now declare learned-router training data sufficiency.
5. Whether terminal-product validation is `terminal-consumer-integration-ready`,
   `cmux-pending-user-validation`, or `cmux-ready`.

## Non-Goals

- Do not implement cmux, Warp, Happier, or any terminal-product UI adapter.
- Do not record `cmux-ready` without real cmux automation or explicit user
  validation.
- Do not modify daemon runtime selection, adapter factories, registry behavior,
  direct tmux ownership, ACP clients, or product code.
- Do not add learned-router training, active/canary, #36 readiness, or PR17
  Remote behavior.
- Do not change HOLP public wire protocol.

## Deliverables

### 1. User Validation Matrix Document

Add `docs/runtime-surface-validation-matrix.md` as the canonical #52 output.

It must include:

- the #45 phase status and downstream gate decision;
- bounded cohort rows for Codex, Claude Code, Cursor Agent, Kimi Code,
  OpenCode, Pi, and Reasonix;
- per-surface columns for `headless`, ACP/native-or-bridge, and
  `direct_user_session`;
- status vocabulary: `ready`, `degraded`, `rejected`, `unsupported`,
  `not_validated`;
- evidence refs for each status, including smoke command, required env,
  CLI/tool version, auth or quota context, source spec or script, and reason
  for degraded/rejected/unsupported;
- a terminal-consumer section consuming #54 evidence, including smoke command,
  selected agent/surface, terminal event, gate/artifact summary,
  degraded/rejected reason evidence, `PASS terminal-consumer-integration-ready`,
  and `cmux_status` marker;
- a user validation section that distinguishes `cmux-pending-user-validation`
  from `cmux-ready`;
- explicit #41 gate output: `allowed` or `blocked`, with rationale.

The document must be useful even when the reader has not followed the PR
thread. It should make skipped or degraded paths visible rather than burying
them in prose.

### 2. Gate Semantics

The #41 gate must be explicit and conservative:

- `#41 data-sufficiency declaration allowed` only if:
  - the bounded cohort has no blank, unknown, or `not_validated` cells;
  - every target surface is either ready or has an honest degraded/rejected/
    unsupported reason;
  - ready cells span at least three distinct agents;
  - ready cells include at least one existing live-cohort agent (Codex or
    Claude Code) and at least one first-batch agent (Cursor Agent, Kimi Code,
    OpenCode, Pi, or Reasonix);
  - ready cells include at least one `headless`, one ACP/native-or-bridge, and
    one `direct_user_session` cell, except that Claude Code ACP remains an
    honest `unsupported` cell and does not count against this threshold;
    depending on local evidence, the ACP threshold may hinge on Codex ACP or
    one of the first-batch ACP paths that actually returns terminal proof;
  - `npm run smoke:terminal-consumer` has a real #54 opt-in pass or a newer
    evidence record with the same proof fields;
  - the document states that #41 may proceed to data-sufficiency declaration,
    not real learned-active readiness.
- `not_validated` is gate-blocking. It is allowed only as an interim local
  placeholder while assembling evidence; it must not appear in the published
  matrix when the final gate reads `allowed`.
- A #54 terminal-consumer pass certifies only the exercised
  `(agent, runtime_surface, isolation_profile)` cell, typically
  `coder_worktree`. It must not be generalized to other agents, other surfaces,
  or `read_only_review` readiness.
- SKIP-path output, fake-registry output, and declaration-only evidence cannot
  count toward the #41 gate. A counting terminal-consumer run must cite the
  selected agent/surface, terminal event, gate/artifact summary, degraded or
  rejected comparison evidence, `PASS terminal-consumer-integration-ready`, and
  `cmux_status` marker.
- `cmux-ready` must remain false unless a real cmux-side automation transcript
  or explicit user validation record is present.
- `cmux-pending-user-validation` is compatible with allowing #41 to proceed
  after `terminal-consumer-integration-ready` is proven, because #41 needs a
  public-wire terminal-consumer integration signal, not a full cmux product UI
  adapter.

### 3. Cross-Reference Updates

Update only the minimum docs needed to make the final phase state discoverable:

- `docs/pr-specs/README.md` must link this #52 spec and describe it as the
  final #45 gate.
- `docs/pr-specs/issue-45-multi-agent-cli-runtime-surface-completion.md` must
  point to the #52 validation matrix after completion.
- `docs/runtime-session-matrix.md` may receive a short pointer to the #52
  validation matrix if useful.

Do not rewrite historical PR specs. PR14, PR16, and earlier specs remain
historical context.

## Validation Commands

Focused:

```bash
npm run smoke:terminal-consumer
HOLP_TERMINAL_CONSUMER_SMOKE=1 HOLP_REAL_HARNESS_SMOKE=1 npm run smoke:terminal-consumer
```

The default command should continue to skip safely. The opt-in command should be
treated as the most recent terminal-consumer evidence only if it reaches a real
terminal event and prints the required PASS/status markers. If local auth/tooling
is unavailable, this PR must record the honest blocked/degraded reason instead
of manufacturing a ready result. The default SKIP path never counts as gate
evidence.

Gate:

```bash
npm run typecheck
npm test
git diff --check
npx gitnexus detect-changes --repo holp
git diff --cached --name-only
npx gitnexus detect-changes --repo holp --scope staged
```

This PR is docs-focused, but the full local gate still runs because #52 closes a
multi-PR phase.

## Review Workflow

- Architect: Claude Opus via the #45 fallback contract, read-only plan/spec
  review before implementation.
- Coder: only needed if this PR grows beyond documentation into scripts or
  product code. Otherwise Commander may edit docs directly.
- Tester: Kimi Code preferred, fallback ZCode, fallback internal Codex subagent.
- Internal Reviewer: Codex native leaf reviewer, focused on gate truthfulness,
  #41/cmux boundary, evidence completeness, and stale references.
- External Reviewer: Claude Opus read-only review, with fallback ledger recorded.

All reports must be posted to the PR after it exists. No P0/P1/P2 may remain.
P3 can be recorded only if it does not affect readiness truthfulness or #41 gate
semantics.

## GitNexus / Risk

This PR is expected to change Markdown documents only. It should not edit indexed
symbols. If implementation touches TypeScript code or tests, Commander must stop
and run symbol impact analysis before the edit.

Before commit, Commander must run GitNexus change detection and cross-check it
with git diff because docs-only changes may not map cleanly to indexed symbols.

## Acceptance Criteria

- AC1: `docs/runtime-surface-validation-matrix.md` exists and covers all seven
  bounded-cohort agents across all three runtime surfaces.
- AC2: every matrix cell has a non-blank state and evidence/reason reference;
  `not_validated` may appear only in a blocked/interim matrix, never in an
  allowed final gate.
- AC3: the document distinguishes `terminal-consumer-integration-ready`,
  `cmux-pending-user-validation`, and `cmux-ready`.
- AC4: the final gate explicitly states whether #41 may declare learned-router
  training data sufficiency and why.
- AC5: the final gate does not claim #36 learned-active readiness, active/canary
  readiness, or cmux product readiness.
- AC6: README/#45 docs link to the validation matrix and #52 spec.
- AC7: local verification and PR reviews report no P0/P1/P2.
- AC8: the matrix labels the isolation-profile scope for each ready claim, so a
  `coder_worktree` pass cannot imply `read_only_review` readiness.

## Stop Conditions

- Stop if the matrix cannot avoid blank/unknown cells without inventing evidence.
- Stop if #41 would be allowed based on declarations alone without real smoke or
  terminal-consumer evidence.
- Stop if `not_validated` appears in the final matrix while the #41 gate reads
  `allowed`.
- Stop if the ready-cell threshold does not span at least three agents, both
  live and first-batch cohorts, and all three runtime-surface families.
- Stop if a reviewer finds that `cmux-ready` is implied without real cmux
  automation or explicit user validation.
- Stop if implementation requires changes to adapter/runtime code; re-plan with
  Coder and GitNexus impact analysis before proceeding.
