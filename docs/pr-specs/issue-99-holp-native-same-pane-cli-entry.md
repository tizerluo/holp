# Issue #99 - `holp` Native-Style Same-Pane CLI Entry

## Summary

This PR turns the Harness Workspace entry into a native-style CLI: `holp`
enters the workspace with the default Controller, and `holp codex` explicitly
selects Codex. It builds on #97's real Controller path, but changes the user
entry from long npm scripts and multi-pane cmux layout to a single cmux terminal
pane containing a HOLP-owned tmux split: real Codex Controller on one side,
Sidecar TUI on the other.

The user entry must use real workers only. It must not expose a demo command,
set `HOLP_REGISTRY=fake`, select `fake-agent`, or claim `cmux-ready`, #41 data
sufficiency, or #36 learned readiness.

## Key Changes

- Add repo-local executable entry:
  - `bin/holp`
  - `package.json` bin mapping `{ "holp": "bin/holp" }` only for optional
    local `npm link`; do not add a new `npm run holp` user entry.
- Add a thin CLI facade:
  - `holp` and `holp codex` launch the same-pane entry with Codex.
  - `holp "goal"` and `holp codex "goal"` pass the goal into the Controller
    initial context.
  - `holp workers`, `holp status`, `holp run "goal" --worker auto`,
    `holp approve "reason"`, and `holp reject "reason"` reuse the existing
    broker client.
- Add same-pane launch behavior:
  - In cmux, create at most one HOLP terminal pane.
  - Inside that pane, start a HOLP-owned throwaway tmux session named
    `holp-harness-<session_id>`.
  - The tmux session starts the broker, runs real `codex -C <repo> <prompt>` in
    the Controller split, and runs the existing Sidecar TUI in the Sidecar
    split.
  - The broker socket is injected through environment variables and hidden from
    the human-facing workflow.
  - The tmux commands prepend `<repo>/bin` to `PATH` inside the HOLP-owned
    session only, so `holp` is real for the Controller without mutating the
    user's global shell profile.
  - The same-pane path uses its own Controller prompt builder. Do not change the
    existing multi-pane `buildControllerBootPrompt` behavior except if tests are
    updated for an intentional shared helper change.
  - The same-pane path must use a fresh random session id and kill only its own
    `holp-harness-*` session on exit. It must never attach or kill user tmux
    sessions.
  - If `tmux` is missing, return a readable degraded reason such as
    `missing_tmux_binary`; do not dump a raw shell failure as success.
  - If `holp` runs outside a cmux workspace, preserve the existing
    `missing_workspace` fail-closed behavior and do not half-launch.
- Simplify the Controller prompt:
  - Tell the Controller that the human will talk naturally.
  - Tell it to inspect `holp workers` / `holp status`.
  - Tell it to dispatch with `holp run "<goal>" --worker auto`.
  - Tell it to resolve approvals with `holp approve "<reason>"` or
    `holp reject "<reason>"`.
  - Do not ask the human to copy socket paths or start another daemon.

## Non-Goals

- No daemon/core changes.
- No HOLP public protocol changes.
- No fake/demo user entry.
- No global shell profile or PATH mutation.
- No visual polish beyond the minimum needed for the same-pane entry.
- No readiness claim for cmux, #41, or #36.

## Tests

- CLI parsing:
  - `holp`, `holp codex`, `holp "goal"`, and `holp codex "goal"` route to
    same-pane launch.
  - `holp workers|status|run|approve|reject` route to the broker client.
  - `holp demo` is rejected.
- Same-pane launch:
  - cmux path creates one terminal pane with `--workspace` and `--focus false`.
  - pane command creates only a fresh `holp-harness-*` tmux session, prepends
    `<repo>/bin` to session-local `PATH`, and never attaches an existing user
    session.
  - pane command installs a trap or equivalent cleanup path that kills only the
    created `holp-harness-*` session on exit.
  - missing `tmux` returns a readable degraded result.
  - outside-cmux launch returns `missing_workspace` and creates no pane.
  - Controller command uses `codex -C <repo> <prompt>` and never `codex exec`.
  - Controller and Sidecar share the same broker socket.
  - no generated user entry contains `HOLP_REGISTRY=fake` or `fake-agent`.
- Real worker boundary:
  - `worker auto` remains fail-closed unless a real direct worker is
    `direct_user_session`, supported, non-fake, ready, and owner-verified.

Gate commands:

- `npm run typecheck`
- `npm test`
- `cd consumers/harness-workspace/tui && go test ./...`
- `git diff --check`
- `npx gitnexus detect-changes --repo holp`
- staged: `npx gitnexus detect-changes --repo holp --scope staged`

## Real Validation

From the repo inside a cmux workspace:

```bash
./bin/holp codex "让 worker 检查当前仓库的测试风险"
```

If linked:

```bash
holp codex "让 worker 检查当前仓库的测试风险"
```

Expected result: cmux shows one HOLP terminal pane. Inside it, the left split is
the real Codex Controller CLI and the right split is the HOLP Sidecar. The user
can continue talking to Codex. Codex dispatches real workers through `holp run`,
and the Sidecar shows run id, worker session, approval, terminal result, or a
readable blocked reason.

The existing `harness:workspace:tui:cmux:agent` multi-pane launcher remains as an
internal/debug path in this PR. The new `holp` same-pane launcher is the
human-facing entry.
