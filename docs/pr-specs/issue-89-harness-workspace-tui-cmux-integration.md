# Issue #89 - Harness Workspace TUI cmux Real Pane Integration

## Status

This is PR B in the true interactive HOLP Harness Workspace TUI sequence. It
builds on #87 / PR #88, which added the consumer-owned broker, controller
helper client, and Go TUI shell.

This PR replaces the #85/#86 markdown/pane-only interactive-entry direction for
the cmux integration layer. It does not declare `cmux-ready`, #41 training data
sufficiency, #36 learned readiness, or user validation success.

## Goal

Add a cmux-scoped Harness Workspace launcher and operator-action layer that can
create or identify real cmux terminal panes for:

- the HOLP TUI, running `npm run harness:workspace:tui`;
- a real Controller Agent CLI terminal, default `codex`, second path
  `kimi-code`;
- a Worker attach terminal that only attaches an observed `holp-*`
  `direct_user_session`.

The intended product shape is three real surfaces in a cmux workspace:

1. a keyboard-driven HOLP Mission Control / Sidecar TUI;
2. a native Controller Agent CLI terminal where the operator can type normally;
3. a Worker attach terminal for the HOLP-owned direct session after a run
   exposes a valid `holp-*` session.

## Key Requirements

### Scripts

Add scripts without changing existing #87 scripts:

- `harness:workspace:tui:cmux` starts the cmux integration launcher.
- `harness:workspace:tui:action` executes one bounded operator action against
  the launcher/session manifest.

Both scripts must be no-op/degraded unless `HOLP_HARNESS_WORKSPACE_TUI=1` is
set.

### cmux Scope And Safety

- All cmux mutation must be scoped to an explicit workspace using `--workspace`.
- Creation commands must include `--focus false`.
- The implementation must not call focus/select/close/move/reorder commands.
- Do not use `cmux send` to the caller surface or to any surface that is not
  proven to be HOLP-owned by this launcher session.
- `cmux send` must not be enabled by weakening the static command validator
  alone. The implementation must keep structural validation separate from a
  launcher-layer ownership gate:
  - static validation permits the `send` command shape only when it includes
    explicit `--workspace` and `--surface`;
  - for `send`, the text payload after `--` is opaque terminal input. It must
    not be scanned by generic forbidden-token checks or by the
    `tmux attach` substring guard. This requires a dedicated send-validation
    path rather than reusing the shared arg loop over every token;
  - launcher ownership validation then rejects the command unless the target
    surface appears in the current session manifest;
  - enabling `send` requires removing `send` from the generic forbidden-token
    set, but `send-key` remains forbidden in this PR.
- If `CMUX_WORKSPACE_ID` is unavailable and no `--workspace` is supplied, the
  launcher must degrade with `missing_workspace` rather than using the visually
  focused workspace silently.
- The launcher may use `cmux identify --json` only for diagnostics; it must not
  use focused workspace fallback for mutation without an explicit user-supplied
  `--workspace`.

### cmux Capability Probe

Before the launcher sends any text to a terminal, it must prove the installed
cmux command shapes are usable for this lane:

- terminal pane/surface creation exists (`new-pane --type terminal` or
  `new-surface --type terminal --working-directory`);
- creation or follow-up topology inspection yields an addressable `surface:*`
  handle;
- `cmux send --workspace <id> --surface <surface> -- <text>` exists.

If any probe fails, the launcher must degrade with an explicit reason and must
not send blind input. Unit tests may use injected runner output for this probe,
but injected results are only logic evidence; they are not proof that the local
cmux installation can create or send to real panes.

### HOLP-Owned Surface Manifest

Introduce a consumer-owned session manifest under the existing temporary
session boundary, for example:

`/tmp/holp-harness-workspace/<session_id>/cmux-surfaces.json`

The manifest must be JSON-serializable and include:

- `session_id`;
- `workspace_id`;
- `broker_socket`;
- `created_at`;
- known HOLP-owned surfaces by role:
  - `tui`;
  - `controller`;
  - `worker_attach`;
- each surface record's `surface_id`, `pane_id` when known, `kind`, `agent`
  when applicable, `created_by`, and `last_command`;
- degraded reasons and command results.

Only surfaces in this manifest may receive `cmux send`. A manifest entry is
created only from a successful cmux create/identify result or an injected test
runner result that represents a successful HOLP-owned surface creation.

The manifest is ephemeral and tied to the broker/launcher session. If it lives
inside `/tmp/holp-harness-workspace/<session_id>/`, it may be removed when the
broker session is closed. Tests must not depend on manifest persistence after
broker cleanup.

### Launcher Flow

The launcher must:

1. require `HOLP_HARNESS_WORKSPACE_TUI=1`;
2. resolve an explicit workspace from `--workspace` or `CMUX_WORKSPACE_ID`;
3. create a broker session or accept an existing `--broker-socket`;
4. run the cmux capability probe; if it fails, degrade and stop before sending;
5. create a TUI terminal pane/surface and capture or derive its addressable
   `surface:*` handle through stdout capture or explicit topology inspection;
6. record TUI surface ownership in the manifest;
7. send a command to the owned TUI surface that exports
   `HOLP_HARNESS_BROKER_SOCKET` and runs `npm run harness:workspace:tui`;
8. create a Controller terminal pane/surface and capture or derive its
   addressable `surface:*` handle;
9. record Controller surface ownership in the manifest;
10. send the Controller boot prompt/command only to the owned Controller
    surface;
11. record cmux sidebar status/progress/log entries for operator visibility.

The launcher may create panes with `cmux new-pane --type terminal --workspace
<id> --focus false`, then send commands with `cmux send --workspace <id>
--surface <holp-owned-surface> -- <text>` after ownership is recorded.

If the installed cmux version does not return a surface id from creation
commands, the launcher must degrade with an explicit reason rather than sending
blindly.

Because the existing generic best-effort runner discards stdout, this PR must
either add a new stdout-capturing cmux runner for the TUI/cmux lane or extend
the existing runner without changing existing callers' ignore-stdout behavior.
Any change to shared runner behavior requires GitNexus impact on
`runCmuxBestEffort` and `executeCmuxLayoutPlan`.

### Controller Pane

- Controller pane must be a real terminal surface, not markdown and not a fake
  provider pane.
- Markdown fallback is forbidden for Controller and Worker roles. If a terminal
  pane cannot be created or addressed, degrade instead of showing a markdown
  substitute.
- v1 supports:
  - `codex` as default controller;
  - `kimi-code` as second controller path.
- v1 launcher pre-flight checks only controller binary availability. It must
  not infer Codex/Kimi auth or config state from local files or environment.
  If auth/config is missing, the real Controller CLI pane must surface that
  failure during interaction and the session can then be recorded as degraded;
  the launcher must describe its evidence as binary-only.
- The controller boot prompt must include:
  - current HOLP repo path;
  - the broker socket;
  - a concrete command such as
    `HOLP_HARNESS_BROKER_SOCKET=<socket> npm run harness:workspace:client -- run --goal "<goal>" --worker <agent>`;
  - a short explanation that the controller should use HOLP public wire through
    the broker instead of starting its own daemon.

### Worker Attach Pane

- Worker attach pane may only be opened when the broker/TUI frame exposes a
  worker session matching `holp-*`.
- Attach command must be a HOLP-owned direct-session attach path such as
  `tmux attach -t holp-*`, but it must not be sent through a generic unowned
  surface path. The action must first create and record an owned worker attach
  terminal surface, then send the attach command only to that owned surface.
- Non-`holp-*` session values must be rejected/degraded.
- If no worker session is present, `open_worker_attach_pane` must degrade with
  `missing_worker_session`.
- This PR acknowledges the #65/#66 caveat: `tmux attach` visibility through cmux
  is a validation aid, not a readiness claim. If the local cmux/tmux path cannot
  reliably expose the worker session, report degraded rather than claim ready.

### Operator Actions

Support these action names in `harness:workspace:tui:action`:

- `open_controller_pane`;
- `send_controller_boot_prompt`;
- `start_run_via_broker`;
- `follow_run_id`;
- `open_worker_attach_pane`;
- `copy_run_id`;
- `copy_attach_command`;
- `cancel_run`;
- `interrupt_worker`.

Rules:

- The action script must load exactly one session manifest through an explicit
  selector, such as `--session-id` or `--broker-socket`. Deriving `session_id`
  from `--broker-socket` is allowed when the path is under
  `/tmp/holp-harness-workspace/<session_id>/broker.sock`.
- The action script must not use an implicit "newest directory under
  `/tmp/holp-harness-workspace/`" fallback for any mutating action. Missing or
  stale session selectors fail closed.
- `cancel_run` requires an explicit confirmation flag such as `--confirm`.
- `interrupt_worker` is `unsupported` / degraded in v1 unless current public-wire
  evidence explicitly exposes a safe interrupt capability.
- Copy actions may print to stdout and/or use a clipboard command when available,
  but absence of clipboard support must be degraded rather than fatal.
- Actions must not mutate daemon/core or use private daemon internals.
- `start_run_via_broker` must use a run-appropriate timeout. It must not rely on
  the controller helper client's short default socket timeout if the broker may
  legitimately wait for `orchestrate.run`.

### Go TUI Integration

The Go TUI remains a broker-frame consumer. This PR may add action hints and
view state needed to show operator affordances, but the TUI must not shell out
to unscoped cmux commands by itself.

Keyboard actions may surface command hints or send broker commands already
defined in #87. cmux mutation remains in the TypeScript launcher/action layer.

## Non-Goals

- Do not change daemon/core, runtime selection, EventBus, or HOLP public wire.
- Do not embed or redraw Agent CLI output inside the TUI.
- Do not train learned models or write training data.
- Do not change #76 gate to allowed.
- Do not claim `cmux-ready`.
- Do not use markdown panes as the main interactive entry.

## Risk And GitNexus

Before touching existing symbols, run GitNexus impact and report risk.

Expected touched symbols:

- `CMUX_COMMAND_ALLOWLIST`;
- `validateCmuxLayoutCommand`;
- `cmuxCommandArgs`;
- `runCmuxBestEffort`;
- `executeCmuxLayoutPlan` only if shared runner behavior must change.

Known high-risk symbols to avoid:

- `recordEvent` and `deriveOverview`: CRITICAL;
- `deriveInspect`, `handleEventsSubscribe`, and `handleOrchestrateRun`: HIGH;
- `DirectTmuxBackend`, `driveWorkflowRun`, and `EventBus`: must not be changed
  without returning to Architect review.

Adding new consumer-owned symbols under `consumers/cmux-bridge/` or
`consumers/harness-workspace/` is preferred over changing daemon or workflow
engine code.

## Test Plan

Focused tests:

- cmux command validation:
  - all mutating commands require `--workspace`;
  - create commands require `--focus false`;
  - forbidden focus/select/close/move/reorder commands stay rejected;
  - `cmux send` has structural validation for explicit workspace/surface;
  - launcher ownership validation rejects `cmux send` unless the target surface
    is HOLP-owned.
- cmux capability probe:
  - missing terminal create support degrades;
  - missing addressable surface id degrades;
  - missing `send --surface` support degrades;
  - send support probing is command-shape/help/version evidence only; real
    delivery is proven only by opt-in real validation and manual acceptance;
  - probes must not leave orphan panes;
  - injected runner success is labeled as logic evidence, not real cmux proof.
- launcher/session manifest:
  - default no-op when `HOLP_HARNESS_WORKSPACE_TUI` is absent;
  - missing workspace degrades;
  - successful runner output records owned TUI/controller/worker surfaces;
  - manifest writes are JSON-serializable and bounded.
- controller paths:
  - default controller is `codex`;
  - `kimi-code` is supported;
  - missing binary reports degraded;
  - auth/config is not inferred by v1 launcher pre-flight and must not be
    claimed ready without later real CLI evidence.
- worker attach:
  - only `holp-*` sessions are attachable;
  - non-`holp-*` sessions are rejected;
  - missing worker session is degraded.
- operator actions:
  - send boot prompt only to HOLP-owned controller surface;
  - action script requires `--session-id` or `--broker-socket` and never mutates
    against an implicit latest manifest;
  - start run uses broker/client path with a run-appropriate timeout and never
    starts a second daemon directly;
  - follow run id sends broker `follow` or records selected run state;
  - cancel requires explicit confirmation;
  - interrupt worker is unsupported/degraded by default.
- send validation tests:
  - `send --workspace W --surface S -- tmux attach -t holp-worker` passes
    structural validation;
  - the same command still fails launcher ownership validation when `S` is not
    in the manifest;
  - `send` without `--surface` fails;
  - `send-key` remains forbidden.

Opt-in real validation:

```bash
HOLP_HARNESS_WORKSPACE_TUI=1 npm run harness:workspace:tui:cmux -- --workspace <workspace>
```

Manual acceptance for this PR:

- cmux shows a real TUI terminal pane;
- cmux shows a real Controller CLI terminal pane;
- `cmux send` does not steal focus in the tested cmux version;
- Controller pane can run the broker client command;
- TUI updates through the broker frame stream;
- Worker attach action refuses non-`holp-*` sessions and opens only a real
  attach terminal for `holp-*` sessions.

Full gate:

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
