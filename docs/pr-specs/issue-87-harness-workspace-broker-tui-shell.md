# Issue #87 - Harness Workspace Broker + TUI Shell Foundation

## Status

This is the first implementation PR in the true interactive HOLP Harness
Workspace TUI sequence. It supersedes the #85/#86 markdown/pane-only entry:
#86 was mechanically green, but it did not provide a keyboard-driven TUI event
loop, shared live HOLP session, or Controller/Worker coordination surface.

This PR is a foundation PR. It does not create cmux panes, does not change
daemon/core, does not extend HOLP public protocol, and does not claim
`cmux-ready`, #41 data sufficiency, #36 learned readiness, or user validation
success.

## Goal

Add the minimum real TUI foundation needed for later cmux integration:

- a consumer-owned broker with one shared HOLP public-wire `DaemonClient`;
- a controller helper client that talks to that broker instead of spawning a
  second daemon;
- a Go Bubble Tea / Lip Gloss / Bubbles TUI shell with Overview, Inspect,
  Replay, and Help modes.

The product shape remains: TUI Mission Control / Sidecar plus real cmux Agent
CLI panes. This PR only builds the TUI and shared-session foundation; PR B owns
cmux pane creation and operator actions.

## Key Requirements

- Add npm scripts:
  - `harness:workspace:tui`;
  - `harness:workspace:broker`;
  - `harness:workspace:client`.
- Add a broker under the Harness Workspace consumer boundary. The broker must:
  - start and own exactly one shared HOLP `DaemonClient`;
  - use only public wire methods such as `initialize`, `flock.discover`,
    `orchestrate.run`, `events.subscribe`, `approval.resolve`, `task.cancel`,
    and public artifact/gate responses;
  - establish its available agents with `flock.discover` at startup; this PR's
    required integration test uses the fixture-safe registry path, while real
    registry selection remains environment-driven like existing consumers;
  - validate `run --worker <agent>` against discovered agent ids and fail closed
    when the worker is unsupported;
  - expose a local Unix socket at
    `/tmp/holp-harness-workspace/<session_id>/broker.sock`;
  - mint `session_id` once at broker start; clients and the TUI must never guess
    it and must receive the complete socket path through
    `HOLP_HARNESS_BROKER_SOCKET`;
  - use newline-delimited JSON over the broker socket: the broker pushes a
    `WorkspaceTuiFrame.v1` JSON object on every state change, and clients/TUI may
    send newline-delimited command objects such as `run`, `cancel`, `follow`, and
    `snapshot`;
  - maintain a JSON-serializable `WorkspaceTuiFrame.v1` with mode, selected
    agent, run id, worker session, attach command, timeline, gate, approval,
    terminal, failures, affordances, and degraded reasons;
  - assemble `WorkspaceTuiFrame.v1` from existing Harness Workspace projections
    such as `deriveOverview`, `deriveInspect`, timeline, continuity, and
    operator-affordance helpers. CRITICAL/HIGH GitNexus symbols may be called
    read-only; they must not be edited in this PR;
  - write a bounded replay snapshot at
    `/tmp/holp-harness-workspace/<session_id>/replay.json`;
  - reuse the existing replay snapshot/export helpers for `replay.json` instead
    of creating a second replay format;
  - never write training samples or learned-router data.
- Add a controller helper client. It must:
  - require `HOLP_HARNESS_BROKER_SOCKET`;
  - support `run --goal "<goal>" --worker <agent>` in v1;
  - fail closed when the socket is missing or stale; stale means the socket path
    exists but `connect()` is refused or no live broker responds within the
    bounded timeout;
  - not instantiate its own `DaemonClient`.
- Add a Go TUI module in `consumers/harness-workspace/tui/`. It must:
  - use Bubble Tea for the key loop, Lip Gloss for visual styling, and Bubbles
    where useful for viewport/list/help behavior;
  - support Overview, Inspect, Replay, and Help modes;
  - support fixed keys: `tab`, `j/k`, arrow keys, `enter`, `esc`, `r`, `f`,
    `c`, `?`, and `q`;
  - read `HOLP_HARNESS_BROKER_SOCKET` and connect to the same newline-delimited
    JSON broker stream as the controller helper client;
  - include a deterministic demo/no-ANSI path suitable for tests;
  - read broker frames without depending on daemon internals.

## Go Module

This PR intentionally supersedes #70's earlier "do not add a Go module" boundary
for this new true-TUI implementation line. Add the Go module only under
`consumers/harness-workspace/tui/`; do not introduce Go code elsewhere.

Use module path `holp-harness-workspace-tui`, Go `1.26`, and direct dependencies
on Charmbracelet packages only:

- `github.com/charmbracelet/bubbletea`;
- `github.com/charmbracelet/lipgloss`;
- `github.com/charmbracelet/bubbles`.

Pin versions through `go.mod` / `go.sum`. Go tests remain a separate explicit
gate (`cd consumers/harness-workspace/tui && go test ./...`) and are not folded
into `npm test` in this PR.

## Non-Goals

- Do not create, move, focus, close, or send input to cmux panes.
- Do not embed or redraw Codex/Kimi/other Agent CLI inside the TUI.
- Do not add protocol fields, daemon storage, daemon handlers, or runtime
  readiness claims.
- Do not mark `usable-ui-real-usage-data-collection` as allowed.
- Do not merge #86 behavior into this PR as the final product entry.

## Risk And GitNexus

Before product-code edits, run GitNexus impact for any touched symbol. Known
high-risk symbols to avoid in this PR:

- `recordEvent` and `deriveOverview`: CRITICAL;
- `deriveInspect`, `handleEventsSubscribe`, and `handleOrchestrateRun`: HIGH.

If implementation requires daemon handler or public-wire changes, stop and
return to Architect review before editing.

## Test Plan

- TypeScript focused tests:
  - broker socket lifecycle;
  - one shared daemon/client session;
  - controller helper uses the broker socket and does not spawn a daemon;
  - frame projection from public-wire events;
  - replay snapshot bounds and JSON serializability;
  - fail-closed paths for missing socket, stale broker, malformed command, and
    unsupported worker;
  - required broker integration path: controller client `run` over the socket
    drives one real `orchestrate.run` against the daemon under the fixture-safe
    registry; the broker must project resulting public-wire events into
    `WorkspaceTuiFrame.v1`. Fixture-only substitutes do not satisfy this gate.
- Go TUI tests:
  - Overview / Inspect / Replay / Help view rendering;
  - keyboard navigation and mode switching;
  - Bubble Tea `tea.Model` implementation with `Init`, `Update`, and `View`;
  - key handling through `Update(tea.KeyMsg)` with tests that feed key sequences
    and assert mode transitions;
  - no-color/no-ANSI deterministic output;
  - narrow width and CJK width behavior;
  - quit/help/copy/start/follow action state transitions.
- Demo smoke:
  - `npm run harness:workspace:tui -- --demo --no-ansi`;
  - broker/client local smoke with fixture-safe data through the shared broker.
- Full gate:
  - `npm run typecheck`;
  - `npm test`;
  - `cd consumers/harness-workspace/tui && go test ./...`;
  - `git diff --check`;
  - `npx gitnexus detect-changes --repo holp`;
  - staged: `npx gitnexus detect-changes --repo holp --scope staged`.

## Review Workflow

- Architect: Claude Opus via `drive-claude`, effort `high`, fallback per HOLP
  default and recorded in PR comments.
- Coder: Codex native leaf subagent; no git, no subagents.
- Tester: Kimi Code conservative path; fallback ZCode, then internal tester.
- Internal Reviewer: Codex native leaf reviewer.
- External Reviewer: Claude Opus read-only deep review.
- PR comments must include Architect, Tester, Internal Reviewer, External
  Reviewer, fallback ledger, and Merge Gate.
