# Issue #73 - Inspect(agent), Evidence, And Failure UX

## Summary

This PR fills the Inspect(agent) state that #72 deliberately left as a slot in
the same Focus Shell.

It makes selected-agent evidence, failure explanation, gate/approval/terminal
state, attach/cancel capability, and bounded evidence anchors readable enough
for real debugging without raw-log spelunking.

This PR does not create cmux panes, fake multiple Agent CLI panes inside one
TUI, change runtime behavior, add protocol fields, record data, add runtime
readiness, or claim `cmux-ready`, #41 sufficiency, or #36 readiness.

## Binding Constraints

- Overview and Inspect remain one product surface. #73 must extend #72's
  Focus Shell renderer, theme, layout, status bar, and view-state conventions;
  it must not create a second renderer or a separate Inspect UI.
- State remains public-wire-only. Do not import daemon/core, registry internals,
  tmux internals, governance stores, or private runtime state.
- The renderer must not re-derive public-wire state. New selected-agent evidence
  belongs in the render model/types; `frame.ts` may format sections but must not
  inspect raw events to discover meaning.
- Do not fabricate missing data. Every row must be either derived from current
  public-wire state or explicitly shown as unavailable.
- Protocol fields, event names, command strings, paths, `run_id`,
  `direct_user_session`, `gate_report`, `approval_*`, `model_output.*`, and
  evidence references must remain untranslated.
- Human explanations and failure summaries must support `en-US` and `zh-CN`.
- No runtime dependencies. Stay TypeScript; do not add TUI libraries or Go
  modules in this PR.
- Provenance caveat remains visible in every rendered frame. Visual polish must
  not imply real-usage validation or readiness.

## Data Honesty Decisions

#73 must classify each requested UX item by what the current public wire can
honestly support:

| UX item | Current data source | #73 behavior |
| --- | --- | --- |
| Selected-agent output excerpt | Current #71 state has one run-level `workerPreview`, not per-agent output. | Show the excerpt only when `selectedAgentId === run.selected_agent_id`. For any other inspected agent, show a localized "no model_output captured for this agent" explanation. Do not show the worker's output under another agent. |
| Selected-agent latest event | `selectedAgent.latestEvent` already exists in #71 render model. | Render selected-agent latest event, not the run-level latest event. |
| Selected-agent owner verification | `selectedAgent.owner_verified` already exists in #71 render model. | Render selected-agent owner verification in Inspect. Overview remains run-level. |
| Evidence anchors | `rawEvidenceAnchors` contains references and raw payloads. | Render bounded references only, such as `agent.step_started#2 run_id=...`; never dump raw payload JSON. |
| Gate status | `evidence.gate` from latest `gate_report`. | Render gate disposition/review/blocking reason with `gate_report` anchor text preserved. |
| Approval status | `evidence.approval` exists but #72 does not render it. | Render requested/resolved/expired/cancelled approval state with approval id/decision when present. |
| Attach command | `workerAnchor.attach_command` from public event payload. | Render verbatim if present. Do not synthesize an attach command. |
| Kill/cancel command | No public-wire command string exists. Direct channel may expose a `cancel` capability token. | Do not render a runnable kill command. Render cancel capability as `cancel: supported` / `cancel: unavailable` based on selected agent direct-channel capability evidence. |
| Failure reason | `failures` and terminal/gate/approval state. | Render localized explanation plus raw reason token when present. |

## Implementation

Extend the existing consumer modules under `consumers/harness-workspace/`.

Suggested implementation shape:

- `types.ts`
  - Add pure render-model types for Inspect sections, such as
    `InspectSection`, `InspectRow`, `InspectEvidenceRef`, and
    `InspectAgentDetail`.
  - Keep rows structured enough that `frame.ts` can render without reading raw
    event payloads.
- `messages.ts`
  - Add `en-US` / `zh-CN` labels for Inspect sections, output-unavailable
    explanation, approval state, cancel capability, failure explanations, and
    evidence reference headings.
  - Translate human explanations into Chinese. Keep diagnostic anchors and raw
    reason tokens untranslated.
- `renderModel.ts`
  - Derive selected-agent Inspect detail from `HarnessWorkspaceState`.
  - Fix Inspect evidence scoping so selected-agent owner/latest-event rows use
    `selectedAgent`, not run-level `evidence`.
  - Keep Overview evidence run-level even if `selectedAgentId` is remembered by
    `viewState`.
  - Derive output excerpt honesty:
    - selected worker -> bounded `workerPreview` excerpt;
    - non-worker / unknown agent -> localized unavailable row.
  - Derive direct cancel capability from selected agent direct-channel
    `capability_bitmask`; do not synthesize commands.
  - Convert `rawEvidenceAnchors` into bounded reference rows containing
    `category.name#seq`, `run_id`, and optionally selected safe key fields.
    Do not include raw payload JSON.
- `frame.ts`
  - Replace the minimal #72 `inspectLines()` body with section-aware Inspect
    rendering using the new model rows.
  - Maintain #72 shell/chrome/status/layout.
  - Define a deterministic truncation priority for constrained height:
    selected agent identity, failure reason, and provenance must survive before
    optional anchor rows.
  - Keep Overview rendering behavior and run-level evidence semantics.
- `fixtures.ts` / `demo.ts`
  - Add or reuse fixture scenarios for:
    - selected worker with output;
    - non-worker inspected agent with no per-agent output;
    - gate blocking / approval expired or cancelled / terminal failure.
  - Demo may remain fixture-driven and safe; no daemon, CLI, tmux, cmux, or
    network spawn.

## UX Requirements

Inspect(agent) should answer these questions without raw log spelunking:

- Which agent am I inspecting?
- What role/status/owner evidence does this agent have?
- Is there a direct session and attach command?
- Can HOLP cancel this selected agent path, and is that a proven capability or
  unavailable?
- What was the latest event associated with this agent?
- What output excerpt is honestly attributable to this agent?
- What did the gate/approval/terminal state decide?
- Why did the run fail or block, in human language?
- Which public-wire evidence references support these rows?

The output should still fit the #72 Sidecar. It should not become a raw event
viewer. Evidence refs are breadcrumbs, not payload dumps.

## Tests

Add or update tests under `tests/consumers/harness-workspace/` for:

- Inspecting the actual selected worker renders the worker output excerpt.
- Inspecting a non-worker agent does not show the worker output and instead
  renders localized "no model_output captured for this agent" text.
- Inspect owner verification and latest event are scoped to the inspected agent,
  proven with `selectedAgentId !== run.selected_agent_id`.
- Overview stays run-level even if the view state preserves a selected agent.
- Approval requested/resolved/expired/cancelled rows render from
  `evidence.approval`.
- Gate blocking and terminal failure render localized explanations plus raw
  reason tokens.
- zh-CN failure explanations contain Chinese text while `run_id`,
  `gate_report`, `approval_*`, `model_output.*`, `attach_command`, and raw
  reason tokens remain untranslated.
- Evidence anchors render as bounded references such as `category.name#seq`
  without raw payload JSON.
- Cancel capability renders as a capability token and no runnable kill command
  string appears.
- Constrained-height Inspect frames still contain selected-agent identity,
  failure reason, and provenance caveat.
- Existing #72 renderer tests remain green.

## Validation

- `npm test -- tests/consumers/harness-workspace`
- `npm run harness:workspace -- --mode inspect --agent coder-1 --no-ansi --width 100 --height 28`
- `npm run harness:workspace -- --mode inspect --agent reviewer-1 --locale zh-CN --no-ansi --width 72 --height 20`
- `npm run typecheck`
- `npm test`
- `git diff --check`
- `npx gitnexus detect-changes --repo holp`
- staged: `npx gitnexus detect-changes --repo holp --scope staged`

## Non-Goals

- Do not create cmux panes or touch Team Layout automation.
- Do not fake multiple Agent CLI panes inside the Focus Shell.
- Do not add per-agent `model_output` protocol semantics.
- Do not add public wire fields or event names.
- Do not synthesize attach, kill, tmux, or HOLP command strings that were not
  provided by public evidence.
- Do not implement replay/session continuity/logs/operator controls; #75 owns
  those.
- Do not change daemon/runtime behavior, runtime readiness, governance storage,
  or data recording.
- Do not claim `cmux-ready`, `terminal-consumer-integration-ready`, #41 data
  sufficiency, #44 artifact readiness, or #36 learned-active readiness.
