# Issue #74 - cmux Team Layout Integration

## Summary

This PR implements the cmux Team Layout reference-consumer path for HOLP
Harness Workspace.

It creates a pure cmux layout planner plus an opt-in executor/smoke path that
can add real cmux panes/surfaces in the caller workspace without stealing focus.
It does not claim `cmux-ready`; #76 remains the user validation gate.

This PR does not implement a generic terminal-product adapter, does not change
HOLP public wire, does not change runtime behavior, and does not affect #41 data
sufficiency or #36 learned readiness.

## Binding Product Decision: Pane Content Honesty

#74 must resolve an apparent tension between earlier UX language and later
implementation reality.

#66 describes Team Layout as visible role panes. #65/#73 establish that the
reliable live substrate for worker/reviewer/tester observation is HOLP public
wire and `model_output.*` / Inspect evidence, not attaching arbitrary cmux panes
to HOLP-owned tmux sessions.

Therefore:

- The existing caller Controller Agent CLI pane is the only native Agent CLI pane
  #74 may treat as already real.
- #74 must not recreate the caller Controller pane.
- #74 must not use `tmux attach -t holp-*` as the Team Layout worker/reviewer
  pane content.
- #74 must not use `cmux new-surface --provider ...` to spawn cmux-owned agent
  sessions and label them as HOLP workers/reviewers/testers.
- Worker/Reviewer/Tester panes created by #74 are HOLP consumer-view panes over
  public wire. They may render Focus Shell / Inspect / role-scoped evidence for
  the corresponding discovered agent, but they must not claim to be the native
  worker CLI unless HOLP later provides a proven native-pane bridge.

This is not a downgrade. It is the honest Team Layout v1: real cmux panes, real
HOLP public-wire evidence, no fake agent sessions.

## Code Home

All cmux-specific code belongs under `consumers/cmux-bridge/`.

`consumers/harness-workspace/` remains cmux-agnostic. It may be imported as a
read-only source for state/render model helpers, role skins, and fixture data,
but #74 must not bolt cmux command generation into harness-workspace modules.

Existing cmux helpers in `scripts/smoke/visible-agent-chain.ts` should be
extracted or wrapped from `consumers/cmux-bridge/` rather than copied into a
second home. #70 forbids two competing cmux integration homes.

## Implementation Shape

Add pure and executable layers under `consumers/cmux-bridge/`:

- `types.ts`
  - `CmuxLayoutPlan`, `CmuxLayoutCommand`, `CmuxLayoutTarget`,
    `CmuxCallerContext`, `CmuxExecutionResult`, and degraded reason types.
- `planner.ts`
  - Pure function that maps caller context + Harness Workspace render/state
    evidence into a cmux command plan.
  - Emits only allowlisted commands.
  - Does not shell out.
- `commands.ts`
  - Cmux command formatting and validation helpers.
  - Enforces `--workspace` on every mutating command.
  - Enforces `--focus false` on every create command.
- `executor.ts`
  - Opt-in executor that shells out to cmux only when explicitly enabled.
  - Default mode is planner dry-run: print/return the command plan and execute
    nothing.
  - Missing caller workspace degrades to plan-only; it must not guess the
    focused workspace.
- `demo.ts`
  - Safe command entrypoint for plan preview and optional smoke.

Update `package.json` with a script such as:

```json
"harness:workspace:cmux-layout": "tsx consumers/cmux-bridge/demo.ts"
```

The script must default to no execution. Execution requires an explicit opt-in
environment variable such as `HOLP_CMUX_TEAM_LAYOUT=1` plus caller workspace
context or explicit `--workspace`.

## cmux Command Allowlist

The planner/executor may emit only:

- `new-pane`
- `new-surface`
- `new-split`
- `markdown open`
- `set-status`
- `set-progress`
- `log`
- `notify`

Every mutating command must include an explicit `--workspace <ref>`.

Every pane/surface/split creation command must include `--focus false`. Do not
rely on cmux defaults.

Forbidden commands include, but are not limited to:

- `focus-window`, `focus-pane`, `focus-panel`, `select-workspace`;
- `close-window`, `close-workspace`, `close-pane`, `close-surface`;
- `move-workspace-to-window`, `move-surface`, `reorder-workspace`,
  `reorder-workspaces`, `swap-pane`, `break-pane`, `join-pane`,
  `respawn-pane`;
- `find-window --select`;
- `send`, `send-key`, `clear-history`;
- `set-hook`;
- `new-surface --provider ...` for HOLP role panes.

Anything outside the allowlist is a test failure.

## Layout Rules

- Scope to the caller workspace by default.
- Require `CMUX_WORKSPACE_ID` or an explicit `--workspace` for execution.
  Missing workspace means honest degraded / dry-run only.
- Use `CMUX_SURFACE_ID` as the caller Controller surface when available.
- Do not create a Controller pane when the caller surface already represents the
  Controller.
- Do not create panes for absent roles. Role panes are derived from discovered
  agents / chain nodes only.
- Worker/Reviewer/Tester panes must use HOLP consumer-view commands over public
  wire, not native-agent claims.
- Mission Control / Evidence panes may be created only when the plan has
  corresponding public-wire content:
  - Evidence pane requires gate, failure, terminal, approval, or evidence refs.
  - Mission Control pane may summarize run/chain/status and must remain a HOLP
    consumer view.
- All layout construction must be additive. No moving, closing, focusing, or
  reparenting user panes.

## Tests

Add tests under `tests/consumers/cmux-bridge/` for:

- Plan generation emits real cmux pane/surface commands for discovered agent
  roles and helper panes.
- No pane is emitted for a missing role.
- No Controller pane is emitted when caller surface exists.
- Every command is allowlisted.
- Every mutating command has `--workspace`.
- Every create command has `--focus false`.
- No forbidden command appears, especially focus/select/close/move/send-key and
  `new-surface --provider`.
- Missing `CMUX_WORKSPACE_ID` or explicit workspace returns degraded plan-only
  and executes zero commands.
- Default script mode is dry-run / no exec.
- Opt-in execution can be tested with a fake cmux runner; it must receive exactly
  the planned commands.
- Role pane content commands are HOLP consumer-view commands and do not include
  `tmux attach`, native provider sessions, or empty role placeholders.
- Evidence pane appears only when gate/failure/terminal/approval/evidence-ref
  data exists.
- Existing harness workspace tests remain green.

## Validation

- `npm test -- tests/consumers/cmux-bridge tests/consumers/harness-workspace`
- `npm run harness:workspace:cmux-layout`
- `HOLP_CMUX_TEAM_LAYOUT=1 npm run harness:workspace:cmux-layout` only when
  running inside cmux with `CMUX_WORKSPACE_ID`; otherwise it must degrade
  without mutating cmux.
- `npm run typecheck`
- `npm test`
- `git diff --check`
- `npx gitnexus detect-changes --repo holp`
- staged: `npx gitnexus detect-changes --repo holp --scope staged`

## Non-Goals

- Do not claim `cmux-ready`.
- Do not perform #76 user validation.
- Do not implement replay/session continuity/operator controls; #75 owns those.
- Do not add protocol fields or events.
- Do not change daemon/core/runtime behavior.
- Do not record data or alter #41 sufficiency.
- Do not use `tmux attach` to make worker panes.
- Do not spawn cmux-owned provider sessions and label them as HOLP agents.
- Do not implement a generic terminal-product adapter.
