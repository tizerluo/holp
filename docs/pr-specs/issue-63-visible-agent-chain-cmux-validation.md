# Issue #63 - Visible Multi-Agent Chain Smoke and cmux Validation

## Summary

Issue #63 adds a compact opt-in smoke that proves a visible multi-agent chain
works end-to-end: a real controller (codex or kimi-code) drives a HOLP client
mode process, which in turn starts a daemon, discovers a worker via
`flock.discover`, orchestrates a run on a real `direct_user_session` surface,
observes the worker session in tmux, and returns a machine-parseable result
block that the runner can verify.

This PR must not claim `cmux-ready`. It may only emit
`INFO cmux_status=cmux-pending-user-validation` regardless of the smoke
outcome.

## Boundaries

### What this PR does

- Adds `scripts/smoke/visible-agent-chain.ts` with:
  - **Runner mode** (default): spawns the controller binary, collects its
    stdout, extracts the result block, verifies marker triangulation, asserts
    the success gate, and emits `PASS visible-agent-chain` (optionally with extra
    detail) or `FAIL`.
  - **Client mode** (`--client --worker <t> --marker <m> --controller <c>`):
    starts a throwaway HOLP daemon with `HOLP_REAL_HARNESS_DIRECT_SMOKE=1`,
    discovers the worker, orchestrates a run on `direct_user_session`, waits
    for `step_started` to extract the tmux session and print
    `attach_command=tmux attach -t <session>`, waits for `run_merged`, checks
    the marker appears in `model_output`, and prints the machine-parseable
    result block.
- Adds `tests/smoke/visible-agent-chain.test.ts` covering all pure helpers.
- Adds `npm run smoke:visible-agent-chain` (SKIP without opt-in env).
- Always emits `INFO cmux_status=cmux-pending-user-validation`; never
  `cmux-ready`.

### Non-Goals

- Does not implement a cmux, Warp, Happier, or terminal product UI adapter.
- Does not claim `cmux-ready` under any condition.
- Does not modify daemon core paths, adapters, or the event contract.
- Does not add learned-router training, active/canary, or PR17 Remote
  behavior.
- Does not change HOLP public wire protocol.
- Does not claim full product readiness; this is a smoke, not a product gate.

## Enabled / Disabled Controllers

| Controller  | Status   | Reason                                       |
|-------------|----------|----------------------------------------------|
| codex       | enabled  | —                                            |
| kimi-code   | enabled  | —                                            |
| claude-code | disabled | controller_driver_not_enabled_in_issue_63    |
| cursor-agent| disabled | controller_driver_not_enabled_in_issue_63    |
| opencode    | disabled | controller_driver_not_enabled_in_issue_63    |
| pi          | disabled | controller_driver_not_enabled_in_issue_63    |
| reasonix    | disabled | controller_driver_not_enabled_in_issue_63    |

## Default Chains

| Controller | Worker (default) |
|------------|-----------------|
| codex      | kimi-code       |
| kimi-code  | opencode        |

## Controller Commands

**codex (stdin ignored):**
```
codex --disable code_mode exec --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  -c notify=[] \
  -C <repo> \
  <prompt>
```

> **Opt-in smoke only.** The Codex controller uses `--dangerously-bypass-approvals-and-sandbox` so the nested HOLP `direct_user_session` harness can verify real tmux/auth/session readiness inside the smoke. This does not change HOLP runtime readiness or the production protocol, and the smoke still never claims `cmux-ready`.
The controller inherits the runner environment, so this mode is only for trusted
local validation where the developer intentionally opts in.

**kimi-code:**
```
kimi -p <prompt> --output-format text
```
(cwd = repo)

## PASS Gate

All five conditions must hold:

1. `terminal = run_merged`
2. `surface = direct_user_session`
3. `worker_session` matches `/^holp-/` (extracted from `step_started.detail`)
4. Random marker appears in HOLP `model_output` (`model_output_marker=found`)
5. Random marker appears in controller stdout (triangulation)

## Opt-In

```bash
HOLP_VISIBLE_AGENT_CHAIN_SMOKE=1 npm run smoke:visible-agent-chain
```

Optional overrides:
- `HOLP_VISIBLE_AGENT_CHAIN_CONTROLLER=codex|kimi-code`
- `HOLP_VISIBLE_AGENT_CHAIN_WORKER=<transport>`

Default (no env): SKIP, exit 0.

## Result Block Format

The client mode prints a machine-parseable block:

```
HOLP_CHAIN_RESULT_BEGIN
marker=<marker>
surface=<surface>
worker_session=<session>
attach_command=tmux attach -t <session>
run_id=<run_id>
terminal=<terminal_name>
model_output_marker=found|not_found
controller=<controller>
timeline=<event_summary>
result=pass|fail
HOLP_CHAIN_RESULT_END
```

The runner requires this block to appear verbatim in controller stdout.

## cmux Status

Regardless of smoke outcome, the runner always emits:

```
INFO cmux_status=cmux-pending-user-validation
```

`cmux-ready` must not appear. Real cmux readiness requires real cmux
automation or explicit user validation per the #52 gate.

## cmux Command Resolution

When cmux dashboard updates are enabled, the runner resolves the cmux binary
best-effort in this order:

1. `HOLP_VISIBLE_AGENT_CHAIN_CMUX_BIN` — explicit override
2. `cmux` if available on `PATH`
3. `/Applications/cmux.app/Contents/Resources/bin/cmux` if executable
4. `cmux` as final fallback

A missing or failing cmux binary does not fail the smoke; dashboard updates are
strictly best-effort.

## cmux Dashboard Opt-In

Dashboard markdown is written to disk when **either** of the following is true:

- `HOLP_VISIBLE_AGENT_CHAIN_CMUX=1`
- `CMUX_WORKSPACE_ID` is set

Setting `HOLP_VISIBLE_AGENT_CHAIN_CMUX=1` alone writes the dashboard markdown
file; actual `cmux` CLI commands additionally require `CMUX_WORKSPACE_ID` to be
set. The runner uses `CMUX_WORKSPACE_ID` as the workspace for `cmux` commands.
The cmux binary can be overridden with `HOLP_VISIBLE_AGENT_CHAIN_CMUX_BIN` (see
**cmux Command Resolution** above). Regardless of the outcome, the runner still
only emits `INFO cmux_status=cmux-pending-user-validation` and never claims
`cmux-ready`.
