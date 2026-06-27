# Issue #95 - Harness Workspace TUI Sidecar Visual Shape

## Status

This PR is a consumer-only visual upgrade after #87/#89/#91 and #94. It moves
the Go Harness Workspace TUI from a flat operational status panel toward the
Sidecar / Overview / Inspect visual shape in:

- `docs/assets/holp-harness-workspace/focus-overview.png`
- `docs/assets/holp-harness-workspace/focus-inspect.png`

It does not change daemon/core, HOLP public protocol, broker frame semantics,
runtime readiness, cmux pane topology, training data, #41 sufficiency, #36
readiness, or the #76 human validation gate.

## Goals

- Render a recognizable HOLP Sidecar, not a fake full workspace.
- Make Overview read as a three-part Sidecar: Chain Map, Active Worker Preview,
  and Evidence Summary.
- Make Inspect read as the same Sidecar shell with selected-agent drill-down,
  selected evidence, output, and operator actions.
- Keep Replay visually consistent, but secondary.
- Add demo-only flags for deterministic visual validation:
  `--mode overview|inspect|replay|help`, `--agent <id>`,
  `--width <cols>`, and `--height <rows>`.

## Hard Boundaries

- The Go TUI owns only the Sidecar pane. It must not draw or simulate the left
  Controller Agent CLI pane from the concept images.
- Agent CLIs remain real cmux terminal panes.
- `--no-ansi` output must contain no ANSI escape sequences and remain
  deterministic.
- Diagnostic anchors must remain literal in both locales, including `run_id`,
  `selected`, `schema_version`, `direct_user_session`, `worker_session`,
  `attach_command`, `terminal_state`, and the mode ids
  `overview`, `inspect`, `replay`, `help`.
- Width-sensitive rendering must use terminal display width, not byte length,
  and narrow views must collapse to a readable single-column stack.
- Do not add dependencies. Reuse the existing Bubble Tea, Lip Gloss, and
  Bubbles viewport/help stack.

## Implementation Notes

- Keep changes focused on `consumers/harness-workspace/tui/main.go` and
  `consumers/harness-workspace/tui/main_test.go`.
- Reuse existing frame fields. If a desired visual field is missing from
  `WorkspaceTuiFrame.v1`, render a bounded fallback rather than changing
  TypeScript producers in this PR.
- Add small local helpers only where they reduce repetition: panel, role badge,
  chain row, key/value table, worker preview, timeline, and status bar.
- Demo flags should affect the demo render path by applying mode/agent
  selection and a synthetic window size before `View()`.
- Update `docs/harness-workspace-user-validation.md` only to record that this
  PR improves automated visual evidence. Do not mark any human gate as allowed.

## Tests

Focused tests:

- `cd consumers/harness-workspace/tui && go test ./...`
- Overview output contains `Chain Map`, `Active Worker Preview`, and
  `Evidence Summary`.
- Inspect output contains selected-agent detail, selected evidence, operator
  actions, and the literal diagnostic anchors.
- `--no-ansi` output contains no `\x1b[`.
- `zh-CN` output keeps protocol/path/id anchors untranslated.
- Demo flags `--mode`, `--agent`, `--width`, and `--height` produce stable
  output for Overview and Inspect.

Full gate:

- `npm run typecheck`
- `npm test`
- `git diff --check`
- `npx gitnexus detect-changes --repo holp`
- staged: `npx gitnexus detect-changes --repo holp --scope staged`

## Non-Goals

- Do not implement Team Layout changes.
- Do not add public wire fields or daemon events.
- Do not change cmux launcher/action behavior.
- Do not claim `cmux-ready`.
- Do not claim #41 data sufficiency or #36 learned readiness.
- Do not move the #76 validation gate from `pending-user-validation`.
