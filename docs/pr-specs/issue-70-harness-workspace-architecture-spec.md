# Issue #70 - Harness Workspace Implementation Baseline And Architecture Spec

## Status

This is a documentation-only architecture baseline for the usable HOLP Harness
Workspace phase. It changes no product code, tests, protocol, runtime-surface
readiness, data recording behavior, or learned-model readiness.

This spec consumes #66 as the UX source and #69 as the phase gate. It does not
supersede #66. #66 remains the non-normative reference-consumer UX note; this
document defines the implementation seams future child PRs must respect.

This spec also preserves the #45/#52 result:

- `terminal-consumer-integration-ready` remains achieved for the #52 public-wire
  terminal-consumer signal;
- `cmux-ready` remains false / `cmux-pending-user-validation`;
- #41 remains allowed at the runtime-surface level, while real-usage data
  sufficiency remains gated by the usable UI phase;
- #36 remains blocked on real learned-model backing and active readiness.

## Architecture Baseline

The usable Harness Workspace is a reference consumer around HOLP public wire,
not a daemon/core feature. Native Agent CLIs stay native; cmux owns workspace
panes; HOLP provides chain, evidence, role, gate, and failure context.

Future consumer code should default to:

- `consumers/harness-workspace/` for Focus Shell, Sidecar, state projection, and
  render-model code;
- `tests/consumers/harness-workspace/` for unit and integration tests;
- `consumers/cmux-bridge/` as the existing but currently empty candidate home
  for #74 cmux Team Layout pane/automation integration.

#70 does not delete, repurpose, or fill `consumers/cmux-bridge/`. #74's per-PR
spec must decide whether its code lives there or under `consumers/harness-workspace/`,
but it must not leave two competing cmux integration homes.

The normative seams are:

1. public-wire client / input adapter;
2. pure state projection;
3. render model;
4. Sidecar / TUI renderer;
5. cmux layout integration.

These seams are binding. The internal API shape inside each seam is owned by the
child PR that implements it.

## Public-Wire State Sources

Harness Workspace state must be derived from HOLP public wire, not daemon
internals.

Allowed state sources:

- `initialize`;
- `flock.discover`;
- `orchestrate.run`;
- `events.subscribe`;
- public artifact, gate report, approval, cancel, and terminal event responses;
- public event payloads such as `step_started`, `model_output.text_delta`,
  `gate_report`, `approval_requested`, `approval_resolved`, and terminal run
  events.

`flock.declare` is intentionally not a render-state source. It is a client
intent-declaration method, while Harness Workspace render state should reflect
accepted discovery, run, event, artifact, approval, and gate evidence.

Do not read daemon stores, registry internals, tmux internals, or governance
private state to render the UI. If a future UI needs data not present on public
wire, that is a separate protocol/product decision, not a #70 shortcut.

## Product And Layout Invariants

Overview and Inspect(agent) are states of the same Focus Shell. They must share
chrome, headers, spacing, role skins, status bar, keyboard language, and visual
hierarchy.

#72 must build the Focus Shell with Inspect as a designed-in state slot, even
though #73 adds the detailed Inspect evidence and failure UX. #73 must not need
to restructure #72 into a different product.

Team Layout must be a real cmux workspace expansion:

- each Agent CLI is a complete independent cmux pane or surface;
- Mission Control and Evidence may be helper panes;
- a single TUI must not pretend to contain multiple real Agent CLI panes;
- layout automation must be scoped to the caller workspace, additive, and
  non-disruptive by default;
- no default action may close, move, focus, or select user panes without an
  explicit user command.

## Visual, Language, And Role Baseline

Charmbracelet, Lip Gloss, Bubble Tea, Bubbles, Glamour, Glow, VHS, Freeze, and
Crush remain visual and interaction references. They are not language, runtime,
module, dependency, or readiness decisions in this PR.

The future #72 per-PR spec owns the TS-vs-Go decision and any dependency pinning.
Until then, Charmbracelet means terminal-native visual vocabulary: role color
tokens, calm borders, badges, readable spacing, status density, and polished
failure/evidence presentation.

#71 owns the first message catalog and role-skin token table:

- supported human languages: `zh-CN` and `en-US`;
- human explanations, panel titles, hints, and failure summaries may be
  localized;
- protocol fields, commands, paths, event names, `run_id`, `direct_user_session`,
  and other diagnostic anchors follow #66 and must not be translated;
- role skins remain visual mappings only, not new protocol roles.

## Child PR Boundaries

#71 - Sidecar state and render model:

- define the public-wire projection for Overview and Inspect;
- define render-model shapes for chain map, worker preview, evidence summary,
  gate status, failure state, and selection state;
- define the message catalog and role-skin token table;
- do not implement the final TUI.

#72 - Focus Shell and Sidecar TUI:

- implement the default Focus Shell and polished Sidecar renderer;
- preserve the native Controller Agent CLI;
- include Inspect as a designed-in state slot with shared shell chrome;
- do not implement full Inspect evidence/failure detail beyond the slot needed
  for #73.

#73 - Inspect(agent), Evidence, and Failure UX:

- fill the Inspect state with selected-agent detail, evidence, and failure
  explanations;
- keep Overview and Inspect as one shell;
- avoid raw-log spelunking as the primary user experience.

#74 - cmux Team Layout integration:

- expand into real cmux panes/surfaces using caller-workspace scoped,
  non-disruptive automation;
- decide the final `consumers/cmux-bridge/` versus `consumers/harness-workspace/`
  code home for cmux-specific integration;
- do not fake multiple Agent panes inside a single TUI.

#75 - Replay, session continuity, logs, and operator affordances:

- make real runs reviewable after execution;
- define safe operator affordances such as cancel, interrupt, rerun, continue,
  and evidence replay;
- keep destructive or focus-changing controls explicit.

#76 - User validation gate:

- record whether the Harness Workspace is good enough for real multi-agent work;
- distinguish actual user validation from smoke/script success;
- decide whether future real-usage sessions may count toward #41 data
  sufficiency evidence.

## Non-Goals

- Do not implement a TUI, Sidecar, cmux bridge, or Team Layout.
- Do not add a Go module, npm dependency, or Charmbracelet dependency.
- Do not change HOLP public wire.
- Do not add protocol events or fields.
- Do not change runtime-surface readiness.
- Do not claim `cmux-ready`.
- Do not reverse `terminal-consumer-integration-ready`.
- Do not unblock #41 data sufficiency.
- Do not train a model.
- Do not connect learned-active execution.
- Do not claim #36 readiness.
