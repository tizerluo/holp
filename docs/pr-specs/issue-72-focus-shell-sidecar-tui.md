# Issue #72 - Focus Shell And Sidecar TUI

## Summary

This PR implements the first usable Focus Shell / Sidecar terminal rendering
surface for HOLP Harness Workspace.

It consumes the #71 state/render model and adds deterministic terminal frame
rendering, a view-state reducer, layout regions, theme helpers, width-aware
truncation, and a default-safe demo command.

This PR does not implement cmux Team Layout, spawn or host a real Controller
Agent CLI, create panes, add dependencies, change public wire, record data, or
claim `cmux-ready`.

## Binding Constraints

- The renderer is pure: `renderFocusShell(model, options) -> string[]`. It must
  not write to stdout, own raw mode, move the cursor, spawn processes, create
  panes, or mutate terminal state in the default path.
- The controller area is an external passthrough slot. `layout.ts` must expose a
  `controllerRegion` with `external: true`; #72 must not redraw, pipe, host, or
  replace the native Controller Agent CLI.
- The Sidecar and status bar are the only rendered regions. Team Layout and real
  cmux panes belong to #74.
- Consume #71's `deriveOverview` and `deriveInspect` output. Do not re-derive
  state in the renderer and do not import daemon/core.
- No runtime dependencies. Stay TypeScript. Do not add Ink, Blessed, Bubble Tea,
  Lip Gloss, Go modules, `string-width`, or other packages in this PR.
- ANSI is optional. `NO_COLOR=1`, `--no-ansi`, or non-TTY output must render
  plain text without escape codes.
- Width handling must be terminal-cell aware enough for `zh-CN` labels. ASCII
  `.length` truncation is not acceptable for visible layout.
- The provenance caveat from #71 must appear in every rendered frame. Visual
  polish must not imply `cmux-ready`, `terminal-consumer-integration-ready`, #41
  sufficiency, or real-usage validation.
- Overview and Inspect are one shell. #72 must include an Inspect state slot with
  shared chrome, theme, status bar, spacing, role accents, and layout.

## Implementation

Add these modules under `consumers/harness-workspace/`:

- `theme.ts`: ANSI/SGR helpers, no-ANSI mode, role accent mapping, shared chrome
  tokens, and box-drawing helpers.
- `width.ts`: terminal-cell width, truncation, and padding helpers with CJK-wide
  code-point support.
- `layout.ts`: `computeFocusShellLayout({ cols, rows })` returning
  `controllerRegion`, `sidecarRegion`, and `statusRegion`; controller region is
  always `external: true`.
- `viewState.ts`: pure reducer for `select(agentId)`, `enterInspect`, and
  `escapeToOverview`.
- `frame.ts`: `renderFocusShell(model, options)` that renders Overview or
  Inspect-slot frames using #71 models.
- `demo.ts`: default-safe fixture-driven command entrypoint.

Update `consumers/harness-workspace/index.ts` to export the new public consumer
surface.

Update `package.json` with:

```json
"harness:workspace": "tsx consumers/harness-workspace/demo.ts"
```

The command must:

- run without env vars;
- spawn no daemon, no Controller CLI, no tmux, no cmux, no network;
- render deterministic non-empty Overview output from fixtures;
- support `--locale en-US|zh-CN`, `--width <cols>`, `--height <rows>`,
  `--no-ansi`, `--mode overview|inspect`, and `--agent <id>`.

## Visual Requirements

The output should be attractive enough to serve as a real UI baseline, not a raw
debug dump:

- use restrained role colors in ANSI mode;
- use box borders and consistent spacing;
- render a sidecar title/header;
- show a chain map, worker preview, evidence summary, failure/provenance rows,
  and a bottom status/hints bar;
- render Inspect using the same shell/chrome with an explicit Inspect body slot;
- degrade gracefully at narrow widths/heights by truncating or dropping optional
  rows rather than throwing.

## Tests

Add tests under `tests/consumers/harness-workspace/` for:

- Overview frame renders deterministic non-empty output.
- Inspect frame renders through the same shell and supports unknown selected
  agent without throwing.
- `computeFocusShellLayout` returns controller/sidecar/status regions and marks
  controller region `external: true`.
- `NO_COLOR` / `--no-ansi` mode has no escape codes; ANSI mode includes expected
  SGR codes.
- CJK labels truncate/pad by terminal cells, not JavaScript string length.
- Narrow width and short height degrade gracefully.
- Role accents are visually distinct for `CTRL`, `CODE`, `TEST`, `REV`, `ARCH`,
  and `GATE`.
- Status bar shows `run_id`, runtime surface, mode, and safe hints.
- Evidence, gate, failure lines, worker preview, and provenance caveat are
  present in every frame.
- Protocol anchors such as `run_id`, `direct_user_session`,
  `model_output.text_delta`, event names, and `gate_report` remain untranslated.
- View-state reducer round-trips `select -> enterInspect -> escapeToOverview`.
- `npm run harness:workspace -- --no-ansi --width 100 --height 28` produces
  deterministic non-empty output and spawns no daemon/CLI.

## Validation

- `npm test -- tests/consumers/harness-workspace`
- `npm run harness:workspace -- --no-ansi --width 100 --height 28`
- `npm run harness:workspace -- --locale zh-CN --no-ansi --width 72 --height 20`
- `npm run typecheck`
- `npm test`
- `git diff --check`
- `npx gitnexus detect-changes --repo holp`
- staged: `npx gitnexus detect-changes --repo holp --scope staged`

## Non-Goals

- Do not implement Team Layout.
- Do not create cmux panes or touch `consumers/cmux-bridge/`.
- Do not spawn, wrap, host, redraw, or replace a real Controller Agent CLI.
- Do not implement full #73 Inspect evidence/failure detail; only provide the
  designed-in slot and shared shell.
- Do not implement replay, session continuity, logs, or operator controls.
- Do not add runtime dependencies or a Go module.
- Do not change HOLP public wire, protocol events, daemon behavior, runtime
  readiness, or data recording.
- Do not claim `cmux-ready`, `terminal-consumer-integration-ready`, #41 data
  sufficiency, #44 artifact readiness, or #36 learned-active readiness.
