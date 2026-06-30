# Issue #101 / HOLP Focus and Worker Refresh Fix

## Summary

- Fix same-pane startup focus so keyboard input lands in the left Codex Controller split, not the right Sidecar split.
- Fix stale broker worker discovery by adding an internal `refresh_workers` broker command and a `holp refresh-workers` CLI facade.
- Keep the change consumer-only: no daemon/core/protocol changes and no readiness claim for `cmux-ready`, #41, or #36.

## Key Changes

- Same-pane tmux command appends `select-pane -L` after `split-window -h`; do not target `:0.0`, because user `pane-base-index` can make that wrong.
- Same-workspace `holp` launches reuse an existing healthy HOLP-owned controller surface instead of creating another cmux pane; if the reused surface is stale and `send` fails, fall back to one fresh `new-pane` attempt.
- Broker can rerun existing `flock.discover`, update `state.agents`, persist replay, and broadcast a fresh frame.
- Refresh uses replace semantics for the usability snapshot: latest discovery fully replaces `state.agents`, so vanished ready workers cannot remain selectable.
- Keep `recordDiscovery()` additive by default; add a narrow opt-in replace option for refresh only.
- `run --worker auto` refreshes discovery exactly once before returning `no usable direct_user_session worker`; no refresh on the happy path.
- Broker discovery uses a real-smoke-safe timeout (60s in this PR); client `refresh-workers` must cover it (65s), and `run` must cover auto-refresh plus `orchestrate.run` (90s), not the 3s default.
- Non-JSON `refresh-workers` must fail visibly: if refresh returns a typed broker error, print the message to stderr and return non-zero; JSON mode still prints the structured response.
- Explicit workers stay fail-closed; if not found or not usable, the error should point users to `holp refresh-workers`.
- Client/`holp` support `refresh-workers [--json]`; this is a harness broker command, not a daemon protocol extension.

## Test Plan

- Focused:
  - `npm test -- tests/consumers/cmux-bridge/samePaneLauncher.test.ts tests/consumers/harness-workspace/broker.test.ts tests/consumers/harness-workspace/client.test.ts tests/consumers/harness-workspace/holp.test.ts`
  - `samePaneLauncher.test.ts`: `buildPaneCommand()` contains `split-window -h ... \\; select-pane -L`.
  - `broker.test.ts`: `refresh_workers` reruns `flock.discover`, changes degraded direct to ready direct, persists replay, and broadcasts.
  - `broker.test.ts`: refresh uses replace semantics; a worker ready at start but absent after refresh is no longer selectable by auto.
  - `broker.test.ts`: `run --worker auto` refreshes once, then selects a newly ready direct worker; if still unavailable, it fails closed and does not call `orchestrate.run`.
  - `broker.test.ts`: auto happy path does not refresh; explicit degraded/not-found workers do not fallback headless and point to `holp refresh-workers`.
  - `client.test.ts` / `holp.test.ts`: `refresh-workers [--json]` sends the broker command, uses refresh-safe timeout, returns non-zero on non-JSON refresh errors, and `holp refresh-workers --json` maps to client argv.
- Gate:
  - `npm run typecheck`
  - `npm test`
  - `cd consumers/harness-workspace/tui && go test ./...`
  - `git diff --check`
  - `npx gitnexus detect-changes --repo holp`
  - staged: `npx gitnexus detect-changes --repo holp --scope staged`

## Assumptions

- `HOLP_REAL_CODEX_SMOKE=1` remains the explicit proof path for real Codex direct readiness.
- Refresh only updates discovery snapshots; it must not weaken `direct_user_session`, `ready`, non-fake, or `owner_verified` checks.
- `BrokerCommand` union, `isCommand`, `commandType`, and the `handleCommand` switch must all support `refresh_workers`.
- Broker tests need a sequence fake daemon: first and second `flock.discover` calls return different snapshots, proving refresh changes state.
- Merge remains user-owned.
