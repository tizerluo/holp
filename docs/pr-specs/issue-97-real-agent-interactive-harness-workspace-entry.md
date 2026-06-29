# Issue #97 - Real Agent-Interactive HOLP Harness Workspace Entry

## Summary

This PR fixes the actual human interaction gap in the Harness Workspace line:
cmux must show a real Controller Agent CLI pane that the human can talk to
directly, while HOLP provides a shared broker, worker dispatch, and a live
Sidecar observer.

PR #96 is intentionally paused as visual-only. This PR must not depend on #96
or claim that #96 solved interaction.

This PR does not change daemon/core, HOLP public protocol, runtime readiness,
`cmux-ready`, #41 sufficiency, or #36 readiness.

## Goal

Add an opt-in cmux entry that opens:

- a real interactive Controller Agent CLI pane, default `codex`;
- a HOLP Sidecar TUI pane connected to the same broker;
- a shared broker session;
- a path where the human talks to the Controller in natural language, and the
  Controller uses HOLP client commands to dispatch a worker;
- Sidecar live state showing run id, selected worker, approval, terminal/result,
  failure reason, and attach command.

The operator should not have to understand or copy broker socket commands.

## Key Requirements

### cmux entry

- Add `npm run harness:workspace:tui:cmux:agent`.
- Require `HOLP_HARNESS_WORKSPACE_TUI=1`.
- Require explicit `--workspace` or `CMUX_WORKSPACE_ID`; do not silently use the
  visually focused workspace for mutation.
- Create only HOLP-owned surfaces recorded in the existing cmux manifest.
- All cmux mutation must include `--workspace`; creation commands must include
  `--focus false`.
- Do not close, move, focus, or reorder user panes.
- Do not send input to any surface not recorded in the manifest.

### Controller Agent pane

- Default controller is real interactive Codex:
  `codex -C <repo> <boot prompt>`.
- The launcher must export `HOLP_HARNESS_BROKER_SOCKET=<socket>` into the
  Controller pane shell before launching the agent. If locale is set, export
  `HOLP_HARNESS_LOCALE` too. The Controller's HOLP client commands must work
  without the human copying or seeing the socket.
- This entry must not use `codex exec` as the product interaction path.
- The Controller pane must remain a real terminal surface. Do not replace it
  with markdown, a fake provider pane, or copied command instructions only.
- The product path must not satisfy the boot prompt by echoing instructions into
  a bare shell, optionally followed by `&& codex`. The boot prompt must be the
  Controller Agent's initial instruction.
- The launcher must not auto-send a synthetic human task into the Controller
  surface. The human types the first real turn.
- `kimi-code` remains a second path. If the interactive path is not verifiable,
  degrade honestly rather than claiming ready.
- The boot prompt must instruct the Controller that:
  - the human will interact in natural language;
  - it should use `npm run harness:workspace:client` for HOLP worker dispatch,
    relying on the exported broker socket environment;
  - it must not ask the human to manually copy broker/socket details;
  - it should first inspect `workers` or `status`;
  - it may run `run --goal "<human goal>" --worker auto`;
  - when approval is pending, it should explain and then use `approve` or
    `reject` as appropriate.

### Broker/client commands

Extend the existing Harness Workspace broker/client with the smallest useful
surface:

- `workers`: keep existing behavior.
- `status`: print current run id, selected worker, approval state/id, terminal,
  failure reason, worker session, attach command, and next suggested action.
  Implement this as a client-side render of the initial `WorkspaceTuiFrame.v1`
  received from the broker, mirroring `workers`; do not add a redundant broker
  command solely for status.
- `run --goal "<goal>" --worker auto|<id>`:
  - `auto` selects a currently discovered worker that is usable for this broker;
  - in real mode, exclude `fake-agent` and fake-registry agents;
  - require a concrete usability signal, at minimum a non-fake discovered agent
    with a usable runtime surface advertised by the broker frame;
  - use deterministic tie-break by sorted agent id, not discovery insertion
    order;
  - fail closed with a readable reason if nothing qualifies;
  - explicit unavailable worker fails closed;
  - explicit fake worker fails closed in real mode;
  - the command records the selected worker into broker state.
- `approve --decision approved|rejected --reason "<reason>"`:
  - resolves the current pending approval through existing `approval.resolve`;
  - fails closed if there is no current pending approval;
  - uses stable `by: "user:harness-workspace"`;
  - for `merge_approval`, reason is sufficient;
  - for `semantic_decision`, either provide the required audit fields
    (`previous_gate_outcome`, `new_gate_outcome`, `artifact_refs`) from broker
    state, or fail closed with a readable degraded reason. Do not surface an
    opaque protocol throw to the user;
  - does not add a second approval channel.

Do not add daemon handlers or protocol fields.

### Sidecar state

Only add interaction-critical state, not broad visual polish:

- whether the Controller pane was created/launched;
- current next action;
- derive next action from existing frame evidence/affordances where possible;
- pending approval id and decision options;
- latest run terminal/result;
- worker session and attach command;
- clear degraded reasons for controller missing, worker unavailable, waiting for
  approval, run failed, or no broker.

## Non-Goals

- Do not implement more Sidecar visual polish from #96.
- Do not count demo/fake success as the real interaction pass.
- Do not embed, redraw, or proxy Agent CLI output inside the Sidecar.
- Do not claim `cmux-ready`.
- Do not mark #76 validation `allowed`.
- Do not write learned-router data or training samples.
- Do not change daemon/core, EventBus, workflow engine, runtime selection, or
  direct tmux backend unless Architect re-approves the expanded scope.

## Risk And GitNexus

Expected consumer-owned touch points:

- `consumers/cmux-bridge/tuiLauncher.ts`;
- `consumers/cmux-bridge/tuiAction.ts`;
- `consumers/harness-workspace/broker.ts`;
- `consumers/harness-workspace/client.ts`;
- minimal `consumers/harness-workspace/tui/` rendering hints.

Before editing any existing function/class/method, run GitNexus impact on that
symbol. If impact is HIGH or CRITICAL, stop for Commander/Architect review
before editing.

Do not edit these symbols without explicit re-review:

- `DirectTmuxBackend`;
- `driveRun` / `driveWorkflowRun`;
- `EventBus`;
- `handleOrchestrateRun`;
- daemon approval lifecycle internals.

## Test Plan

Focused tests:

- `tests/consumers/cmux-bridge/tuiLauncher.test.ts`:
  - `harness:workspace:tui:cmux:agent` launches real interactive `codex -C`;
  - broker socket env is exported before the Controller Agent starts;
  - boot prompt is delivered as the Agent's initial instruction, not printed as
    shell-only instructions;
  - product path does not contain `codex exec`;
  - product path does not echo instructions then append `&& codex`;
  - launcher does not send a synthetic human task into the Controller pane;
  - all cmux mutation uses explicit workspace and `--focus false`;
  - send targets only manifest-owned surfaces.
- `tests/consumers/harness-workspace/broker.test.ts`:
  - `status` reflects run, worker, approval, terminal, failure, and next action;
  - `status` is rendered from the frame without adding a redundant broker status
    command;
  - `run --worker auto` chooses a usable deterministic worker and fails closed
    when none exists;
  - real-mode auto excludes fake agents;
  - explicit unsupported worker fails closed;
  - `approve` / reject resolves pending merge approval through the broker;
  - pending semantic approval resolves with required audit fields or degrades
    readably, never as an opaque throw;
  - no pending approval fails closed.
- `tests/consumers/harness-workspace/client.test.ts`:
  - CLI parses `status`, `run --worker auto`, and `approve`;
  - missing/stale socket errors are readable.
- Go TUI tests:
  - next-action, controller-launched, approval, and result/degraded hints render
    in deterministic no-ANSI output.

Opt-in validation:

```bash
HOLP_HARNESS_WORKSPACE_TUI=1 \
  npm run harness:workspace:tui:cmux:agent -- \
  --workspace <id> --controller codex --worker auto
```

Pass means the user can type a normal request in the Controller Agent CLI; the
Controller dispatches through HOLP without asking the user to copy broker/socket
commands; Sidecar updates with a terminal result or readable failure reason.

Full gate:

- `npm run typecheck`
- `npm test`
- `cd consumers/harness-workspace/tui && go test ./...`
- `git diff --check`
- `npx gitnexus detect-changes --repo holp`
- staged: `npx gitnexus detect-changes --repo holp --scope staged`

## Review Workflow

- Architect: Claude Opus via `drive-claude`, effort `high`; fallback per HOLP
  default and recorded.
- Coder: Codex native leaf subagent; no git, no subagents.
- Tester: Kimi Code conservative path; fallback ZCode, then internal tester.
- Internal Reviewer: Codex native leaf reviewer focused on real Agent
  interaction, hidden broker mechanics, approval completion, and no fake pane.
- External Reviewer: Claude Opus read-only deep review.
- PR comments must record Architect, Tester, Internal Reviewer, External
  Reviewer, fallback ledger, and Merge Gate.
