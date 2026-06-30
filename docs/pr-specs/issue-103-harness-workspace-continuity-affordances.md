# Issue #103 - Harness Workspace Continuity Affordance Completion

## Summary

Small/Medium consumer-only fix after #102. The goal is to complete the remaining
Harness Workspace continuity/operator affordance gaps without changing daemon,
core runtime, protocol, runtime readiness, `cmux-ready`, #41 sufficiency, or #36
readiness.

This PR fixes:

- `attach_command_missing`;
- `rerun_goal_not_exported`;
- `continue_requires_public_wire_capability` appearing as broad degraded state
  instead of an honest continue-action limitation.

## Key Behavior

- When `step_started.detail` is a HOLP-owned `holp-*` worker session, derive
  `tmux attach -t <session>` in consumer state.
- If a later public `agent_event.attach_target.attach_command` arrives, prefer
  that public event command over the derived command.
- Never derive attach commands for non-`holp-*` sessions.
- Persist the broker run goal in consumer-owned state when `run` is accepted.
  Do not add daemon wire fields. Add the stored goal to consumer run identity
  only.
- Enable `rerun_goal` only when the frame has a run id, selected worker, runtime
  surface, verified owner, and stored goal.
- Carry the copyable rerun command on continuity, for example
  `continuity.rerun_command`, not on `rerun_goal.command_text`. Update replay
  continuity key validation and capped-string validation in the same change.
  Do not widen `COPY_COMMAND_AFFORDANCES`.
- Build rerun command text as POSIX-safe shell text using single-quote wrapping
  and standard `'` escaping. Goals containing spaces, quotes, `$()`, or
  backticks must remain inert text.
- Keep `continue_run` disabled unless public-wire/direct capability evidence
  includes `inject`. Continue unsupported state must not make the worker look
  unusable.
- Scope `continue_requires_public_wire_capability` to the action-level state:
  it may appear when the worker has all other continuation evidence and only
  lacks `inject`, but it must not be emitted as broad degraded state for an
  otherwise healthy run.
- Scope `rerun_goal_not_exported` similarly: it appears when rerun is otherwise
  plausible but no stored goal exists. It must disappear when `rerun_command`
  exists.
- `holp status` must show attach command, rerun command, and continue state.
  JSON status may include the new continuity field because status returns the
  frame projection; `workers --json` must remain unchanged.
  `holp workers` stays as defined by #102; JSON shape remains unchanged.

## GitNexus / Risk

Known CRITICAL consumer symbols:

- `deriveContinuity`
- `recordRunAccepted`
- `deriveOperatorAffordances`

Known lower-risk anchors:

- `recordStepStarted`: LOW
- `recordAgentEvent`: LOW
- `formatStatus`: LOW
- `runClientCli`: LOW
- `createReplaySnapshot`: LOW

Implementation must keep scope under `consumers/` and tests. If Coder thinks
daemon/core/protocol changes are required, stop and return to Architect review.

## Test Plan

- `tests/consumers/harness-workspace/state.test.ts`
  - `holp-*` step detail derives attach command.
  - non-HOLP session does not derive attach command.
  - `agent_event.attach_target` overrides derived attach command.
- `tests/consumers/harness-workspace/affordances.test.ts`
  - stored goal enables `rerun_goal` as `needs_confirmation`.
  - missing goal keeps rerun disabled.
  - missing `inject` keeps continue disabled without broad worker degradation,
    while the action-level reason still explains the missing capability.
- `tests/consumers/harness-workspace/broker.test.ts`
  - broker run stores goal in consumer state/frame.
  - `orchestrate.run` params remain unchanged.
- `tests/consumers/harness-workspace/client.test.ts`
  - `status` human output includes attach, rerun, and continue state.
- `tests/consumers/harness-workspace/replay.test.ts`
  - replay preserves attach/rerun continuity evidence and never overclaims
    `can_continue`.
  - replay export/import accepts the new continuity field and rejects oversized
    rerun command strings.
  - replay keeps `can_rerun` descriptive/copyable if a stored goal exists; this
    does not imply live session continuation.
- Add a rerun command quoting test with a goal containing spaces and a quote.
- If Go frame fields or text change:
  - `cd consumers/harness-workspace/tui && go test ./...`

Full gate:

- `npm run typecheck`
- `npm test`
- `cd consumers/harness-workspace/tui && go test ./...`
- `git diff --check`
- `npx gitnexus detect-changes --repo holp`
- staged: `npx gitnexus detect-changes --repo holp --scope staged`
- GitHub CI green

## Workflow

- Architect: Claude Opus via `drive-claude`, effort high, fallback recorded.
- Coder: Codex native leaf subagent; no subagents, no git.
- Tester: Kimi Code; fallback ZCode, then internal tester.
- Internal Reviewer and External Reviewer must verify no daemon/protocol scope,
  no fake readiness, no non-HOLP attach derivation, no continue overclaim.
- Merge Gate stops for user validation and user-performed merge.

## Assumptions

- `continue_requires_public_wire_capability` is not itself a worker failure.
- Rerun means starting a new run with the stored goal, not continuing the same
  worker session.
- This PR does not affect learned data, cmux readiness, #41, or #36.
