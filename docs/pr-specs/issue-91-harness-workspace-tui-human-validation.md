# Issue #91 - Harness Workspace TUI Visual Polish And Human Validation Gate

## Status

This is PR C in the true interactive HOLP Harness Workspace TUI sequence after
#87 and #89. It polishes the merged broker + Go TUI shell + cmux real-pane
integration and prepares the human validation gate.

This PR does not change daemon/core, HOLP public protocol, runtime readiness,
training-data recording, learned-router sufficiency, or #36 readiness. It must
not declare `cmux-ready`. Human validation remains pending/blocked unless the
human operator explicitly accepts the experience after using it.

#85/#86 are treated as superseded for product direction. #86 was mechanically
green, but it did not provide the keyboard-driven TUI linked to real cmux Agent
panes required by the current product direction.

## Goals

1. Make the Go Harness Workspace TUI feel like a coherent operator product:
   Overview, Inspect, Replay, and Help must share visual language, navigation
   vocabulary, role skins, and status treatment.
2. Support `zh-CN` and `en-US` human-facing chrome without translating
   diagnostic anchors.
3. Keep display semantics single-sourced:
   - TypeScript broker/frame owns locale selection and role-skin derivation;
   - Go owns terminal rendering, layout, Lip Gloss colors, and keyboard model;
   - Go must not invent independent role-to-skin or data-string semantics.
4. Update the #76 validation record so it names the #87/#89/#91 Go TUI stack,
   remains honest about pending human validation, and does not point at the
   superseded #71-#75 static/script stack as sufficient.

## Locale And Message Boundary

Use a broker-localized, Go-rendered model:

- Add an optional `locale` field to `WorkspaceTuiFrame.v1` with accepted values
  `en-US` and `zh-CN`.
- The locale source is consumer-owned and must not change HOLP public protocol:
  broker CLI `--locale <en-US|zh-CN>` and `HOLP_HARNESS_LOCALE` are allowed,
  with `en-US` as default.
- The broker must pass locale into the Harness Workspace state/projection path
  so existing TypeScript message catalog behavior remains the source for
  frame-provided data strings.
- Go may have a very small chrome catalog for TUI-owned labels such as mode
  names, global help, and panel headings. It must not retranslate frame-provided
  evidence, failure, affordance, or reason strings.
- Unknown locale or missing `locale` in an older frame must fall back to
  `en-US` without crashing.

This is consumer broker-to-TUI wire, not HOLP public wire. Adding optional
consumer-frame metadata is allowed; adding daemon protocol fields or public
events is not.

## Role Skin Boundary

Role skin selection is single-sourced in TypeScript:

- Extend the consumer frame/agent view with optional `role_skin` values:
  `CTRL`, `CODE`, `TEST`, `REV`, `ARCH`, `GATE`.
- `role_skin` must be derived from the existing Harness Workspace role-skin
  mapping, not re-derived independently in Go.
- Go maps `role_skin` to Lip Gloss colors only:
  - `CTRL`: blue/cyan;
  - `CODE`: green;
  - `TEST`: yellow;
  - `REV`: purple;
  - `ARCH`: orange;
  - `GATE`: gray/status color.
- Missing or unknown `role_skin` must use a neutral fallback.
- ANSI role colors must disappear under `--no-ansi` / `NO_COLOR`; deterministic
  no-ANSI output must remain stable.

`schema_version` remains `WorkspaceTuiFrame.v1`. New frame fields are optional
and backward-compatible.

## TUI Polish Requirements

Overview must read as a task/chain dashboard:

- clear run/goal/gate/terminal summary;
- role-colored agent chain;
- selected agent preview;
- latest timeline and failure/gate highlights;
- visible key hints without crowding the frame.

Inspect must read as agent/evidence/failure drill-down:

- selected agent identity, role skin, runtime surface, status;
- evidence and failure explanation first, raw-ish details second;
- attach command, run id, and worker session presented as diagnostic anchors;
- unsupported/degraded operator actions shown honestly.

Replay must read as post-run review:

- completed timeline;
- terminal outcome and gate/failure context;
- replay path or bounded replay snapshot state;
- clear distinction between replay-only, attachable, and continuation-capable
  session state.

Help must explain keyboard navigation and operator actions:

- fixed keys remain: `tab`, `j/k`, arrow keys, `enter`, `esc`, `r`, `f`, `c`,
  `?`, `q`;
- `c` must not silently imply real clipboard integration if it remains a
  placeholder or frame-sourced affordance;
- cancel must remain confirmation-driven where it is exposed;
- interrupt stays unsupported/degraded unless public-wire evidence supports it.

## Diagnostic Anchors

These strings and identifiers must remain untranslated in both locales:

- `run_id`;
- `selected`;
- agent `id`;
- `status`;
- `role`;
- `direct_user_session`;
- mode ids: `overview`, `inspect`, `replay`, `help`;
- `schema_version`;
- commands, paths, socket paths, tmux attach commands, and event names.

Tests must include at least one zh-CN render assertion proving these anchors
survive localization.

## Validation Record Update

Update `docs/harness-workspace-user-validation.md` to reflect the current
interactive TUI line:

- the current artifact under validation is the #87 broker/TUI foundation, #89
  cmux real-pane integration, and #91 visual polish / validation gate;
- #71-#75 remain useful historical/static foundation references, but they are
  not sufficient as the current human validation artifact;
- `usable-ui-real-usage-data-collection` must remain `pending-user-validation`
  or `blocked` unless the human operator explicitly confirms acceptance;
- `cmux product readiness` remains `cmux-pending-user-validation` unless a
  separate user acceptance record says otherwise;
- do not declare #41 real-usage data sufficient or #36 ready.

This PR may add a fresh validation template/checklist for the Go TUI, but it
must not pre-fill human verdicts.

## Misleading Readiness Claim Guard

Add a docs-safe guard or test that fails on affirmative readiness claims while
allowing honest negations. The banned phrase set must include at least:

- `cmux-ready: true`;
- `cmux-ready = true`;
- `claims cmux-ready`;
- `cmux ready ✅`;
- `#41 data sufficiency: allowed`;
- `#41 is sufficient`;
- `#36 ready`;
- `learned model readiness: ready`.

The guard must allow negations such as `does not claim cmux-ready`, `must not
claim cmux-ready`, `cmux-ready remains false`, and
`cmux-pending-user-validation`.

## Tests

Focused tests:

- Go TUI tests under `consumers/harness-workspace/tui`:
  - `en-US` and `zh-CN` render paths;
  - unknown/missing locale fallback;
  - all six role skins have distinct ANSI treatment;
  - role colors disappear under `--no-ansi`;
  - diagnostic anchors remain unchanged in zh-CN;
  - Overview / Inspect / Replay / Help remain keyboard-reachable.
- TypeScript tests under `tests/consumers/harness-workspace`:
  - frame includes optional locale and TS-derived `role_skin`;
  - old/minimal frames remain accepted as `WorkspaceTuiFrame.v1`;
  - broker/client locale parsing rejects unknown locale fail-closed or falls
    back only where explicitly defined.
- Docs/readiness guard:
  - affirmative banned phrase fixture fails;
  - honest negation fixture passes;
  - validation record does not mark `usable-ui-real-usage-data-collection` as
    `allowed` without an explicit human validation marker.

Full gate:

- `npm run typecheck`;
- `npm test`;
- `cd consumers/harness-workspace/tui && go test ./...`;
- `npm run harness:workspace:tui -- --demo --no-ansi`;
- `git diff --check`;
- `npx gitnexus detect-changes --repo holp`;
- staged: `npx gitnexus detect-changes --repo holp --scope staged`.

## Non-Goals

- Do not modify daemon/core.
- Do not modify `EventBus`, `handleEventsSubscribe`, `handleOrchestrateRun`,
  `driveWorkflowRun`, or runtime backend readiness logic.
- Do not change HOLP public wire or protocol docs.
- Do not embed, repaint, or simulate Agent CLIs inside the TUI.
- Do not perform cmux pane mutation beyond existing #89 paths.
- Do not mark `usable-ui-real-usage-data-collection` as `allowed` without
  explicit human acceptance.
- Do not declare `cmux-ready`, #41 sufficiency, #44 artifact readiness, #36
  readiness, or learned-active readiness.

## Review Focus

Reviewers must check:

- no split-brain locale or role-skin mapping;
- Go TUI chrome polish does not invent protocol semantics;
- frame schema stays backward-compatible;
- no false readiness claim appears in docs or output;
- validation doc names the current Go TUI stack and remains honest;
- no daemon/core or public protocol surface changes slipped in.
