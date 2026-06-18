# Real-Codex patch + approval smoke

Rollback-safe smokes that exercise the **real** `mcp-codex` adapter against a live
`codex app-server --stdio`, proving the patch path and the approval bridge work with a
real provider — the thing the PR5/M3 safe-prompt smoke never covered.

These are **opt-in** and live outside the vitest globs (`adapters/**`, `daemon/**`,
`tests/**`), so `npm test` / CI never runs them and stays fake-backend deterministic.

## How real Codex actually behaves (measured 2026-06-18, codex 0.140.0)

Under the adapter's hardcoded session policy (`approvalPolicy: on-request` +
`sandbox: workspace-write`):

- **File edits are auto-applied and do NOT trigger approval** — in-workspace *or*
  out-of-workspace. So "edit a file" exercises the **patch** path, not approval.
- **A sandbox-escape command DOES trigger a real `shell_command` approval** — e.g. a
  network `curl` (the workspace sandbox blocks the local proxy), which Codex escalates
  with "...run the requested command outside the sandbox?". This is the only reliable
  real-approval trigger, and it is **LLM-dependent** (the model sometimes declines to run
  the command at all).

Consequently the smoke treats **patch** and **approval** as two independent scenarios,
and the deterministic approval-*resume* semantics (request → resolve → decline/accept →
`run_blocked`/`run_merged`) stay covered by the fake-server integration test
(`daemon/handlers/codex_adapter_integration.test.ts`), which can fabricate the request
frame on demand.

## What they check

| Script | npm | Covers |
|--------|-----|--------|
| `codex-approval-patch.adapter.ts` | `npm run smoke:codex:adapter` | **Layer 1, adapter-direct PATCH.** Real provider emits an `fs-edit` with a non-empty diff and applies the patch on disk; turn ends clean. Lowest flake. |
| `codex-approval-patch.e2e.ts` | `npm run smoke:codex` | **Layer 2, end-to-end daemon.** Live `initialize → flock.declare → orchestrate.run → events.subscribe → [approval.resolve] → [artifact.get]`. Three scenarios: **patch** (edit → `run_merged` + file changed); **approval approve** (network cmd → `run_merged`); **approval reject** (network cmd → `run_blocked`). Approval sub-runs report **INCONCLUSIVE** (not FAIL) if the provider declines to request approval that run. |

### Exit codes (e2e)

The e2e smoke prints one of three overall results and exits accordingly:

- **PASS** (exit 0) — patch passed AND at least one approval sub-run actually exercised
  the approval bridge end-to-end. Only this state may be cited as "real approval smoke
  ran".
- **PASS_NO_APPROVAL** (exit 1) — nothing failed, but the provider never requested
  approval this run (both approval sub-runs INCONCLUSIVE). The approval path was *not*
  tested; re-run to get a real approval. Non-zero on purpose so it is never mistaken for
  approval evidence or used as a merge gate.
- **FAIL** (exit 1) — a wrong terminal event, a probe/auth failure, a missing terminal
  event, or an unexpected approval request (see safety gate below).

### Safety gate on approval

The unattended `approved` sub-run only resolves `approved` if the requested approval is a
`shell_command` whose command matches the expected safe probe (`curl ... https://example.com`).
Any other request — a different command, or a non-`shell_command` approval — is
**rejected and the run FAILs**, so a model deviation can never get an unexpected command
approved outside the sandbox.

## Run

```bash
HOLP_REAL_CODEX_SMOKE=1 npm run smoke:codex:adapter   # Layer 1
HOLP_REAL_CODEX_SMOKE=1 npm run smoke:codex           # Layer 2 (2 scenarios)
```

Without `HOLP_REAL_CODEX_SMOKE=1` both no-op-exit-0 (so an accidental invocation is never
a failure). Each scenario makes **one real networked Codex turn and consumes ChatGPT
subscription quota** — Layer 1 is 1 turn, Layer 2 is up to 3 turns (patch + approve +
reject).

## Isolation — why it's rollback-safe

Each run builds, under the OS temp dir:

- a temp **`CODEX_HOME`** = a copy of `~/.codex/auth.json` + a minimal `config.toml`
  containing only `notify = []`. Codex honours `$CODEX_HOME`, so all sessions, logs,
  sqlite, state, version cache, and the app-server daemon dir land in temp — the real
  `~/.codex/` is never read or written. The `notify = []` line overrides the user's
  global `notify` hook (the `SkyComputerUseClient` that otherwise spawns orphans in
  automation).
- a temp **git workspace** seeded with a tracked `SMOKE.txt`. The adapter pins the
  session to `sandbox: workspace-write` rooted at this dir, so file edits are bounded here.

Teardown runs in a `finally` even on crash: graceful daemon-stdin close → `SIGTERM` the
process group → `SIGKILL` → `rm -rf` both temp dirs.

**Scope of the isolation claim:** Codex's own state (sessions, logs, sqlite, config,
auth lookups) and the workspace file effects are fully redirected into temp and removed on
teardown — `~/.codex` and the repo are never touched. The daemon is launched with the
repo-local `node_modules/.bin/tsx` (not `npx`) to avoid consulting user npm global
cache/config. It does still inherit the rest of `process.env` (minus `HOLP_REGISTRY`,
plus `CODEX_HOME`), so this is "Codex state + workspace effects are isolated", not "the
process touches nothing outside the OS temp dir".

**No production code is changed.** Isolation is purely launch-time: the daemon's own `cwd`
becomes Codex's `cwd`, and `CODEX_HOME` in the daemon's env is inherited by the spawned
Codex child and probe subprocesses.

## One-time manual gate (the make-or-break dependency)

The `flock.declare` probe greps `codex doctor` output for `auth is configured`. Confirm a
copied auth survives under a temp home before relying on the smoke:

```bash
TH=$(mktemp -d); cp ~/.codex/auth.json "$TH/auth.json"; printf 'notify = []\n' > "$TH/config.toml"
CODEX_HOME="$TH" codex doctor | grep -i 'auth is configured'   # expect a match
rm -rf "$TH"
```

If that prints nothing, copying `auth.json` is insufficient (e.g. token store moved) and
the smoke will fail fast at `flock.declare` with a clear message rather than degrading
silently.

## Known characteristics

- **Approval trigger is provider-dependent.** The approval scenario relies on Codex
  choosing to run the network command and then escalating. When it doesn't, the sub-run
  is **INCONCLUSIVE**, not FAIL — the smoke only fails on a wrong terminal event, a probe
  failure, or a missing terminal event.
- **Reject reason.** A rejected approval surfaces as `run_blocked` with reason
  `"<tool> denied"` (e.g. `shell_command denied`), emitted by the adapter — not a generic
  `approval_rejected`. The smoke asserts the event **type**, not the string.
- **Diff artifact is best-effort.** `art_diff_<run_id>` is registered only when the
  file-change frame carried a `.diff`; a `run_merged` can legitimately carry none. The
  smoke treats the **on-disk file** as the source of truth and fetches the artifact only
  if present.
- **LLM non-determinism.** The patch prompt forces a single direct edit ("apply a patch,
  no shell") to a tracked file. If a turn stalls, the driver fails fast on its own
  deadline (well under the adapter's 10-min turn timeout).
