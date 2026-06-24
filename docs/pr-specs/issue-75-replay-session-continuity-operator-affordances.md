# Issue #75 - Replay, Session Continuity, Logs, And Operator Affordances

## Summary

This PR makes completed Harness Workspace runs reviewable after execution and
adds safe operator affordance models for the next usable-UI validation step.

It builds on #71-#74:

- #71 supplies public-wire state projection and render models.
- #72 supplies the Focus Shell renderer.
- #73 supplies Inspect(agent), evidence, and failure UX.
- #74 supplies cmux Team Layout bridge planning.

#75 does not change HOLP daemon/core behavior, public wire, runtime readiness,
or learned-router data sufficiency. It does not claim `cmux-ready`; #76 remains
the user validation gate.

## Product Goal

A real HOLP run must remain understandable after it finishes. The operator
should be able to reopen the run, inspect the chain, review the important event
timeline, see what can be safely copied or continued, and distinguish available
actions from unsupported/degraded ones.

This is the bridge between "the UI rendered while the smoke was running" and
"the UI is usable enough for real work and later data-quality evaluation."

## Key Changes

### Replay Snapshot

Add a public-wire-only replay snapshot contract under
`consumers/harness-workspace/`.

Suggested shape:

- `HarnessReplaySnapshotV1`
  - `schema_version: "HarnessReplaySnapshot.v1"`
  - `created_at`
  - `run`
  - `locale`
  - `provenance`
  - sanitized, bounded public-wire event summaries
  - sanitized, bounded evidence anchors
  - stored Overview/Inspect render summaries
  - `logs`
  - `operator_affordances`
- `createReplaySnapshot(state, options)`
- `restoreReplaySnapshot(snapshot)`
- `exportReplaySnapshotJson(snapshot)`
- `importReplaySnapshotJson(json)`

The snapshot must be derived only from the existing Harness Workspace state and
public-wire event frames. It must not read daemon stores, registry internals,
tmux internals, governance private state, or local shell history.

The snapshot must not serialize raw provider payloads. Exported event/evidence
records must use a sanitized summary shape, for example:

- `run_id`
- `seq`
- `category`
- `name`
- optional `agent_id`
- optional `summary`
- optional `payload_preview`, capped to a small string limit
- `payload_truncated: true | false`

Concrete caps:

- default event summary cap: 200 entries;
- default evidence anchor cap: 50 entries;
- default log entry cap: 100 entries;
- default per-preview string cap: 512 UTF-16 code units;
- default exported JSON size guard: 256 KiB.

Truncation must be explicit with `truncated:true` and a reason. Tests must
assert export-time bounds, not only renderer output bounds.

Replay import must fail closed on unknown schema version, malformed event
frames, or unbounded payloads. It may preserve unknown public-wire event anchors
as evidence, but must not execute anything during import.

`restoreReplaySnapshot(snapshot)` must return a replay view model, not a live
mutable daemon-backed state. Suggested return shape:

- sanitized `HarnessReplaySnapshotV1`;
- `overview: HarnessOverviewModel`;
- optional `inspect: HarnessInspectModel`;
- `timeline`;
- `continuity`;
- `operator_affordances`.

Restore may use the stored render summaries in the snapshot. It must not replay
raw event payloads through daemon/runtime paths, and it must not call cmux,
tmux, daemon control methods, shell commands, or file writers.

`exportReplaySnapshotJson(...)` returns a string by default. File persistence is
the caller's explicit choice; #75 must not add a storage daemon or implicit
snapshot writer.

### Session Continuity

Add a pure continuity model that explains what can be reused after a run:

- `run_id`
- selected / observed agent ids
- runtime surface
- worker session / attach command when present
- terminal state
- owner verification state
- replay freshness / created timestamp
- whether the run can be continued, rerun, inspected, copied, or only replayed

Continuity is descriptive in #75. It must not attach to a user shell, spawn a
new agent, or resume a runtime session by itself.

Continuity booleans must be tied to public-wire evidence, not role labels or
transport names. Use the same kinds of evidence already present in Harness
Workspace state:

- direct channel capability bitmask when present;
- owner verification state;
- terminal state;
- attach command / worker session presence;
- accepted run identity and runtime surface.

When evidence is missing, report disabled/unsupported with an explicit reason.
Do not infer readiness from agent name, role skin, or previous smoke success.

### Logs And Timeline

Add a bounded operator log/timeline model:

- stable ordering by event `seq`;
- event label, role/agent if known, severity, and short summary;
- special treatment for terminal, approval, gate, failure, model output, and
  unknown events;
- truncation marker when event or evidence count is capped.

The log surface must stay user-readable. It should not dump raw provider blobs
or large payloads into the primary UI. Raw evidence remains bounded refs.

Severity is derived by #75, because `EventFrame` has no severity field:

- `error`: non-merged terminal events, explicit failures, approval expiry or
  cancellation;
- `warn`: gate blocking, consensus degraded, unknown events, unsupported
  affordance attempts in replay data;
- `info`: normal lifecycle, approval requested/resolved, model output summary,
  successful terminal events.

The derivation must be deterministic and tested.

### Operator Affordances

Add explicit, safe action descriptors. These are UI affordances, not automatic
execution.

Suggested affordance ids:

- `copy_attach_command`
- `copy_run_id`
- `open_team_layout`
- `replay_evidence`
- `rerun_goal`
- `continue_run`
- `cancel_run`
- `interrupt_worker`

Each affordance must include:

- `id`
- localized label key
- `state: "enabled" | "disabled" | "needs_confirmation" | "unsupported"`
- reason / unavailable reason
- whether confirmation is required
- whether it is destructive or focus-changing
- optional command text only for copy/display actions

Rules:

- Copy-only actions can be enabled when the source data exists.
- `open_team_layout` may point to the #74 dry-run/opt-in cmux layout path, but
  must preserve non-focus and caller-workspace constraints.
- Destructive or runtime-changing actions (`cancel_run`, `interrupt_worker`,
  `continue_run`, `rerun_goal`) must be disabled or represented as
  `needs_confirmation` models only.
- #75 executes no operator action of any kind. It must not call
  `approval.resolve`, `task.cancel`, future interrupt/inject methods, cmux,
  tmux, shell commands, or daemon control methods from an affordance.
- Real execution of operator actions is deferred to a future gated PR that names
  exact public-wire methods, confirmation UX, audit behavior, and tests.
- No affordance may synthesize `kill`, `tmux`, `send-key`, or focus-changing cmux
  commands.
- Unsupported runtime capabilities must remain honestly unsupported; do not infer
  readiness from role labels.

Affordance labels and reasons must use the existing small message catalog in
both `en-US` and `zh-CN`. Protocol fields, command names, paths, event names,
and diagnostic anchors remain untranslated.

### Reference Rendering / Demo

Extend the Harness Workspace reference consumer so replay and operator state can
be inspected without a live run.

Acceptable implementation options:

- extend `npm run harness:workspace` with a replay/demo mode; or
- add a focused script such as `npm run harness:workspace:replay`.

The demo must be deterministic and must not execute operator actions. It should
show replay status, timeline/log entries, continuity status, and affordances.

Replay/log/continuity/affordance state must surface through the existing Focus
Shell rendering path, not only through a standalone toy script. Acceptable
integration:

- add a replay view-state/demo mode that still calls the same `renderFocusShell`
  frame path; or
- extend Overview/Inspect render models with replay/timeline/affordance sections
  rendered by the existing shell.

#75 should preserve the single-product invariant from #70: replay is another
state of the Harness Workspace, not a separate product.

## Code Boundaries

- Prefer new pure modules under `consumers/harness-workspace/`, such as
  `replay.ts`, `logs.ts`, and `affordances.ts`.
- Keep cmux-specific command generation under `consumers/cmux-bridge/`.
- Harness Workspace remains public-wire-only.
- Do not change daemon/core/runtime behavior unless the Architect explicitly
  re-approves a revised plan.
- Do not add a persistence daemon or database in this PR.
- Do not record learned-router training data.

## GitNexus / Risk

Before editing existing symbols, run impact analysis and report risk.

Likely symbols:

- `recordEvent`: existing public-wire state ingestion; expected HIGH-ish risk
  only if modified. Prefer avoiding changes unless necessary.
- `deriveOverview` / `deriveInspect`: shared render-model derivation; impact
  likely MEDIUM/HIGH depending on current graph.
- `renderFocusShell` / frame helpers: UI rendering path; avoid large rewrites.
- `planCmuxTeamLayout` / `executeCmuxLayoutPlan`: cmux bridge path; touch only
  if `open_team_layout` needs a descriptor link.
- New pure replay/log/affordance helpers may not be indexed until after analyze;
  still test them directly.

If implementation requires public protocol changes, daemon internals, direct
tmux inspection, or real destructive action execution, stop and return to
Architect review.

## Agent Workflow

- Architect: Claude Opus 4.8 via `drive-claude`, effort high. Pioneer 100U is
  skipped today if still quota-exhausted; fallback chain:
  Pioneer 50U -> official OAuth -> ZCode -> Kimi Code -> internal Codex.
- Coder: Codex native leaf subagent; no subagents, no git operations. Implement
  the approved spec and tests.
- Tester: Kimi Code conservative path if needed; fallback ZCode -> internal
  Codex tester.
- Internal Reviewer: Codex native leaf reviewer. Focus on replay import/export,
  public-wire-only sourcing, destructive affordance safety, raw payload bounds,
  and no readiness overclaim.
- External Reviewer: Claude Opus read-only deep review; static review and
  Commander local validation evidence must be recorded separately.
- PR comments must include Architect, Tester if run, Internal Reviewer, External
  Reviewer, Merge Gate, and fallback ledger.

## Test Plan

Focused:

- `npm test -- tests/consumers/harness-workspace tests/consumers/cmux-bridge`
- Add replay/log/affordance focused tests covering:
  - replay snapshot export/import round trip;
  - unknown schema / malformed event fail-closed;
  - export-time event/evidence/log caps and truncation markers;
  - payload sanitization: raw provider payloads are stripped or preview-capped;
  - restore returns replay view model and is side-effect free;
  - Focus Shell render path surfaces replay/timeline/affordance state;
  - deterministic severity derivation;
  - terminal run remains reviewable without live daemon;
  - copy affordances enabled only when source data exists;
  - destructive/focus-changing affordances require confirmation or remain
    disabled/unsupported;
  - no synthesized `kill`, `tmux`, `send-key`, focus, close, or move command;
  - no raw provider blob dump in primary replay/log render output.

Full gate:

- `npm run typecheck`
- `npm test`
- replay/demo command introduced by this PR
- `npm run harness:workspace`
- `npm run harness:workspace:cmux-layout`
- `git diff --check`
- `npx gitnexus detect-changes --repo holp`
- staged: `npx gitnexus detect-changes --repo holp --scope staged`

## Non-Goals

- Do not claim `cmux-ready`.
- Do not perform #76 user validation.
- Do not change HOLP public wire or daemon internals.
- Do not implement real learned-router data recording.
- Do not unblock #41 data sufficiency.
- Do not train a model or connect #36 learned-active readiness.
- Do not implement a database, background replay service, or remote storage.
- Do not execute any operator action in #75. Confirmation is modeled only.
- Do not attach to user-owned shells or move/focus/close cmux panes by default.

## Stop Conditions

Stop and return to Commander / Architect if:

- replay cannot be derived from public wire;
- import requires daemon private state;
- an operator affordance would execute any action instead of only describing it;
- a renderer must dump raw provider payloads to explain failures;
- cmux integration requires focus/select/close/move behavior;
- implementation needs protocol changes;
- any P0/P1/P2 remains after review.
