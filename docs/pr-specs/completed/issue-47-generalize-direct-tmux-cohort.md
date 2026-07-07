> status: completed — direct tmux foundation shipped; see git log #56 and Issue #50 baseline.

# Issue #47 - Generalize Direct Tmux For The Bounded CLI Cohort

## Summary

Issue #47 is the direct-session foundation PR for #45. It generalizes the
current Kimi-only tmux path into a per-agent direct-session configuration model
for the bounded CLI cohort, without claiming full direct parity for every
agent. #50 owns the later first-batch direct-session parity gate.

This PR may change product code and tests. Commander must not implement those
changes directly; Coder owns implementation.

## Current Baseline

- `DirectTmuxBackend` is generic enough to create HOLP-owned `holp-*` tmux
  sessions, inject a one-shot CLI command, read output, interrupt, cancel, and
  clean up.
- `probeDirectTmux` still returns Kimi-specific availability reasons.
- `FIRST_BATCH_HARNESSES` wires `direct` only for Kimi Code.
- Codex and Claude Code direct parity remain scoped to #48 and #49.
- Cursor Agent, Kimi Code, OpenCode, Pi, and Reasonix first-batch direct parity
  remains scoped to #50.

## Key Changes

- Replace Kimi-specific direct probe naming and reasons with transport-neutral
  direct-session reasons. The required rename is `kimi_unavailable` to
  `direct_agent_unavailable`; existing reasons such as
  `direct_tmux_capability_not_proven` and `direct_user_session_not_declared`
  remain valid.
- Introduce a small per-agent direct-session declaration shape for the bounded
  cohort that can express:
  - supported tmux command path and agent command/args where already safely
    configured;
  - unsupported/rejected state with reason where direct control is not yet safe;
  - HOLP-owned namespace requirements: `session_origin:"holp_created"` and
    `session_id_namespace:"holp-*"`.
- Keep ready strict: direct `ready` requires a real agent-in-tmux round-trip
  through `DirectTmuxBackend.startSession` + `sendPrompt`, owner verification,
  terminal output observation, cleanup, and
  `observe/read/inject/interrupt/cancel/owner_verified`. `probeDirectTmux`
  capability verification is necessary for availability, but is not sufficient
  by itself to declare `ready`. The implementation gate is
  `directProbeReady`: it must not return true from `probeDirectTmux` alone.
- Preserve the existing Kimi direct path as the first concrete configured tmux
  path, but remove Kimi-specific assumptions from shared backend/probe code.
- Add explicit non-Kimi unsupported/rejected direct declarations for the
  bounded first-batch cohort where commands are not yet safe to control. Do not
  leave blank direct states.
- Do not add a tmux-backed `direct` definition or backend factory for any
  non-Kimi first-batch agent in #47. #50 owns first-batch direct parity.
- Define `direct_channel.attach` as attaching only to a HOLP-created session
  owned by this run, never attaching to existing user shells or user-created
  tmux sessions. Keep `attach` as observation metadata; do not add it to the
  ready `capability_bitmask`, whose control/readiness contract remains
  `observe/read/inject/interrupt/cancel/owner_verified`.
- Do not change `handleOrchestrateRun` or `parsePreferredRuntimeSurface` unless
  Coder first reports `BLOCKED` and Commander sends the change back to Architect
  review. Existing explicit direct selection fail-closed behavior should be
  reused.

## Acceptance Criteria

- AC1: No `kimi_unavailable` or Kimi-specific direct probe reason remains in
  shared backend/probe code. Agent availability failures use
  `direct_agent_unavailable` with `missing:["binary:<agentCommand>"]` or an
  equivalent transport-neutral missing entry.
- AC2: Granular tmux probe reasons are preserved:
  `tmux_unavailable`, `tmux_create_probe_failed`, `tmux_inject_probe_failed`,
  and `tmux_read_probe_failed`.
- AC3: Kimi direct remains `degraded` by default unless a real
  agent-in-tmux round-trip plus owner/capability proof is recorded. No committed
  definition may set `probeDirectReady:true` without a recorded real direct
  smoke.
- AC4: Non-Kimi first-batch agents have explicit direct unsupported/rejected or
  degraded declarations with actionable reasons; no non-Kimi tmux-backed direct
  backend factory is added in #47.
- AC5: `direct ready` cannot be produced by `probeDirectTmux` alone. Tests must
  prove a ready declaration requires `DirectTmuxBackend.sendPrompt` or an
  equivalent agent-in-tmux smoke.
- AC6: Session owner safety is fail-closed: a collision with an existing
  `holp-*` session causes `startSession` to fail rather than attach to that
  session.
- AC7: `handleOrchestrateRun` and `parsePreferredRuntimeSurface` remain
  unchanged. Existing direct runtime selection tests continue to prove explicit
  direct selection rejects degraded owner/control proof and accepts ready proof.

## GitNexus / Risk

Index baseline: `main@41dc0d2`.

Impact already checked:

- `DirectTmuxBackend`: LOW overall, but participates in
  `firstBatchAdapterFactories`.
- `DirectTmuxBackend.startSession`: HIGH; affects `driveRun`,
  `driveWorkflowRun`, `executeRuntimeAction`, and harness smoke paths.
- `probeDirectTmux`: LOW.
- `directProbeReady`: LOW.
- `firstBatchAdapterFactories`: LOW.
- `handleOrchestrateRun`: HIGH. Avoid changing.
- `parsePreferredRuntimeSurface`: HIGH. Avoid changing.

If implementation needs to alter `handleOrchestrateRun`,
`parsePreferredRuntimeSurface`, `driveRun`, or `driveWorkflowRun`, stop and
return to Commander for Architect re-review.

## Test Plan

Focused:

- `npm test -- adapters/direct-tmux.test.ts adapters/registry.test.ts daemon/handlers/m1b_contract.test.ts`
- Cover transport-neutral probe failure reasons instead of `kimi_unavailable`.
- Cover HOLP-owned session names only: no existing user tmux session attach, no
  silent attach when a generated `holp-*` session collides with an existing
  session.
- Cover unsupported direct control declarations for non-configured agents with
  explicit missing capability reasons.
- Cover Kimi direct remains degraded unless owner/capability proof is present.
- Cover explicit `direct_user_session` selection still fails closed when owner
  or control proof is missing and still accepts a ready direct proof. Existing
  `daemon/handlers/m1b_contract.test.ts` direct selection tests are regression
  guards and should not be duplicated unless behavior changes.

Full gate:

- `npm run typecheck`
- `npm test`
- `git diff --check`
- `npx gitnexus detect-changes --repo holp`
- staged: `npx gitnexus detect-changes --repo holp --scope staged`

Opt-in smoke:

- If local tmux and CLI auth are available, run the smallest direct tmux smoke
  for configured direct targets and record PASS/INCONCLUSIVE/SKIP honestly.
  Missing local binaries or auth must not block merge unless the code claims
  ready.

## Agent Workflow

- Architect: Claude Opus 4.8 via `drive-claude`, `--effort high`, read-only
  adversarial review before implementation. Fallback:
  Pioneer 100U -> Pioneer 50U -> official OAuth -> ZCode -> Kimi Code ->
  internal Codex subagent.
- Coder: Codex native leaf subagent; no subagents, no git, no PR comments.
  Must checkpoint file plan before editing.
- Tester: Kimi Code if needed for a formal test report; fallback ZCode, then
  internal Codex subagent. Commander still independently runs local checks.
- Internal Reviewer: Codex native leaf reviewer focused on direct readiness,
  owner scope, no headless fallback, and test coverage.
- External Reviewer: Claude Opus 4.8 read-only review after implementation.
- All reports are posted to the PR when the PR exists.

## Non-Goals

- Do not implement cmux, Warp, or terminal-product UI.
- Do not claim all first-batch direct surfaces ready; #50 owns that gate.
- Do not implement Codex or Claude direct parity; #48 and #49 own those gates.
- Do not implement learned routing, #41 data sufficiency, or #36 active
  readiness.
- Do not attach to existing user shells or user-created tmux sessions.
