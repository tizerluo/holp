# Issue #71 - Sidecar State And Render Model

## Summary

This PR creates the first consumer-side state and render model for the HOLP
Harness Workspace. It implements pure TypeScript projection code under
`consumers/harness-workspace/` and tests under
`tests/consumers/harness-workspace/`.

It does not implement a TUI, cmux panes, Team Layout, replay controls, data
recording, runtime readiness, protocol changes, #41 data sufficiency, or #36
learned-active readiness.

## Binding Constraints

- State must be derived from HOLP public wire only. Do not import daemon stores,
  registry internals, tmux internals, or governance private state.
- Use the implemented event vocabulary from `daemon/core/eventContract.ts` as
  the known event set. Protocol prose may mention older/spec-only event names;
  those must route through an unknown-event branch with raw payload preserved.
- `agent_event` is an envelope. An attach target appears as
  `event.name === "agent_event"` with payload `{ name: "attach_target",
  payload: {...} }`, not as a top-level `attach_target` event.
- `worker_session` / attach target data are best-effort optional anchors from
  unspecified payload conventions, either `step_started.payload.detail` matching
  `/^holp-/` or the nested `agent_event` attach target payload. They are never
  required for valid state.
- Cancellation is represented as `run_gave_up` with `payload.reason ===
  "cancelled"`. Do not rely on a real `run_cancelled` wire event.
- `owner_verified` is sourced from the selected agent's discovered runtime matrix
  direct-channel capability tokens, not from event payloads.
- `model_output.full_text` is the authoritative preview snapshot. Append
  `text_delta` only when `full_text` is absent. Deduplicate by `run_id:seq` so
  replay plus live delivery does not double-append.
- Gate state is derived from the latest `gate_report.decision_surface`; earlier
  gate reports are timeline evidence. Do not derive gate outcome from
  `consensus_snapshot`.
- Provenance is caller-supplied only: `provenance?: "smoke_script" | "unknown"`.
  It defaults to `unknown`, renders only as a neutral caveat, and must never be
  inferred from terminal success, `terminal-consumer-integration-ready`, or any
  runtime surface success marker.
- Overview and Inspect(agent) must derive from one shared
  `HarnessWorkspaceState`. There is no separate Inspect store. Unknown selected
  agents degrade gracefully to an Overview-compatible empty Inspect model.

## Implementation

Add `consumers/harness-workspace/` with pure modules:

- `types.ts`: public state and render-model interfaces.
- `messages.ts`: tiny `zh-CN` / `en-US` message catalog plus `t(locale, key)`.
- `roleSkins.ts`: visual-only `CTRL`, `CODE`, `TEST`, `REV`, `ARCH`, and `GATE`
  token table.
- `state.ts`: pure projector/reducer from public wire inputs and `EventFrame`
  events into `HarnessWorkspaceState`.
- `renderModel.ts`: `deriveOverview(state)` and
  `deriveInspect(state, selectedAgentId)` from the same state.
- `fixtures.ts`: reusable realistic fixtures for tests.
- `index.ts`: stable exports for later #72/#73 PRs.

The model must cover:

- run identity and connection/client metadata;
- chain graph nodes for human, controller, HOLP, worker/reviewer/tester/gate;
- selected agent state and latest event;
- worker output preview with bounded length and truncation marker;
- evidence summary: `run_id`, runtime surface, worker session / attach command
  when available, owner verification state, latest event, gate report, artifact
  refs, approval state, and terminal state;
- failure summary from `run_blocked`, `run_gave_up`, cancelled
  `run_gave_up`, `consensus_degraded`, gate `blocking_reason`,
  `approval_expired`, and `approval_cancelled`;
- raw evidence anchors for diagnostic correlation.

Use unknown-safe parsing. Malformed or missing payload fields must degrade to
`unknown` / absent render fields, not throw.

## Evidence Source Table

The implementation must make these source boundaries explicit in code or tests:

| Field | Source | Required? |
| --- | --- | --- |
| `run_id` | `orchestrate.run` result and event frame `run_id` | required after run acceptance |
| runtime surface | `run_started.payload.runtime.runtime_surface` and discovery matrix | optional until known |
| `worker_session` | `step_started.payload.detail` `/^holp-/` or nested `agent_event.attach_target` | optional best-effort |
| attach command | nested `agent_event.attach_target.payload.attach_command` | optional best-effort |
| `owner_verified` | selected agent discovery runtime matrix direct-channel capability tokens | optional, not event-derived |
| latest event | last accepted `EventFrame` after dedupe | optional before events |
| gate | latest `gate_report.decision_surface` | optional |
| artifact refs | terminal/gate/artifact public payloads | optional |
| approval | approval public events | optional |
| terminal state | `run_merged`, `run_blocked`, `run_gave_up`; cancellation is `run_gave_up{reason:"cancelled"}` | optional until terminal |

## Tests

Add `tests/consumers/harness-workspace/` coverage for:

- live run projection with `step_started`, nested `agent_event.attach_target`,
  and `model_output` preview;
- top-level `attach_target` is ignored while nested `agent_event` is accepted;
- completed run with latest `gate_report` and terminal state;
- `run_gave_up{reason:"cancelled"}` maps to cancelled, distinct from
  non-cancelled gave-up;
- failed/degraded run with human-readable failure summary and raw anchors
  preserved;
- `owner_verified` sourced from discovery matrix, not events;
- `model_output` snapshot uses `full_text`; delta-only events append; duplicate
  `run_id:seq` does not double-append;
- unknown/spec-only events preserve raw payload without throwing;
- `zh-CN` / `en-US` labels translate while protocol anchors from #66 remain
  untranslated;
- role skin table contains `CTRL`, `CODE`, `TEST`, `REV`, `ARCH`, `GATE` and is
  visual-only;
- provenance defaults to `unknown`; explicit `smoke_script` renders as a caveat;
  terminal success or `terminal-consumer-integration-ready` text does not infer
  real usage;
- unknown `selectedAgentId` degrades gracefully to an Overview-compatible Inspect
  model.

## Validation

- `npm test -- tests/consumers/harness-workspace`
- `npm run typecheck`
- `npm test`
- `git diff --check`
- `npx gitnexus detect-changes --repo holp`
- staged: `npx gitnexus detect-changes --repo holp --scope staged`

## Non-Goals

- Do not implement a TUI, Sidecar renderer, cmux bridge, Team Layout, replay
  controls, or operator controls.
- Do not add a Go module, npm dependency, or Charmbracelet dependency.
- Do not change HOLP public wire, protocol events, daemon behavior, runtime
  readiness, or training/data recording.
- Do not claim `cmux-ready`, #41 data sufficiency, #44 artifact readiness, or
  #36 learned-active readiness.
