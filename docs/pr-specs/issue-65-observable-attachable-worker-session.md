# Issue #65 - Observable + Attachable direct_user_session Worker

## Summary

Today a HOLP `direct_user_session` worker really runs a real agent CLI in a tmux
session, but the human can only see an after-the-fact `dashboard.md` summary. The
worker session is detached (`tmux new-session -d`), lives on whatever tmux server
the daemon's inherited `$TMUX` resolves to, and is killed at run terminal — so the
printed `tmux attach -t holp-...` has a near-zero window and no guaranteed server.

This PR makes the worker **observable while it runs** and **attachable**, in three
layers, without changing the HOLP public wire protocol:

- **L1 hold**: keep the worker session alive past run terminal for a bounded,
  reaper-guarded window instead of killing it immediately.
- **L2 attachable socket**: create the session on a caller-pinned absolute tmux
  socket (`tmux -S <abspath>`) with the daemon's inherited `$TMUX` stripped, and
  return a fully-qualified `attach` / `kill` command pair.
- **L3 live stream**: tee the worker pane's byte stream via `tmux pipe-pane` to a
  per-session logfile and publish incremental `model_output.text_delta` events, so
  a consumer sees the process live **without attaching**.

This PR must not claim `cmux-ready`. It delivers the attachable/observable
**substrate**, not a polished cmux UI.

## Why protocol-layer change is NOT required (verified)

- `adapters/agent-backend.ts` `AgentMessage` already has
  `{ type: "model-output"; textDelta?: string; fullText?: string }`.
- `daemon/core/runEngine.ts` already publishes
  `model_output { text_delta: msg.textDelta, full_text: msg.fullText }`.
- So emitting incremental `textDelta` flows to the existing `model_output` event
  wire with **zero** protocol change. L3 fills a reserved seam.
- Pre-flight grep confirmed **no test asserts `model_output` is emitted exactly
  once / with only `full_text`**; the only consumer (visible-agent-chain smoke) is
  presence-based (`markerInControllerOutput`).

## Boundaries

### What this PR does

- `adapters/direct-tmux.ts`:
  - **L2**: thread a caller-supplied absolute `socketPath`; prefix every tmux
    call with `-S <socketPath>`; strip `TMUX` from the spawned-tmux child env;
    create the session on that socket; `mkdir -p` the socket parent dir.
  - Surface structured attach info `{ sessionId, socketPath }` in the
    `status:starting` detail (extend, do not break, the existing string form).
  - **L1**: `AgentBackendOptions.holdSession?: boolean` + `holdTimeoutMs?: number`.
    When `holdSession`, `dispose()` skips the kill, emits a terminal `status:held`
    with the attach target, and arms a bounded reaper `setTimeout` → kill after
    `holdTimeoutMs`. `cancel()` is unchanged (still kills — cancel = interrupt).
  - **L3**: on `startSession`, `tmux -S <socket> pipe-pane -t <session> -o
    'cat >> <logfile>'`; maintain a byte-offset cursor; on each poll tick tail the
    logfile from offset and emit `{type:"model-output", textDelta: chunk}`; keep
    the final `{type:"model-output", fullText}` emit unchanged; on `dispose`, stop
    pipe-pane and unlink the logfile.
- `adapters/agent-backend.ts`: document the `text_delta` (0..N, raw, advisory) vs
  `full_text` (0..1 per prompt, authoritative, cleaned) contract on the
  `model-output` message.
- `probeDirectTmux`: accept + use the same `socketPath` so probe and run agree on
  the server.
- `scripts/smoke/visible-agent-chain.ts`: choose an explicit socket, pass
  `holdSession:true`, print fully-qualified `tmux -S <socket> attach -t <session>`
  and a matching `kill-session` reap command, and reap on exit after a hold window.
- Tests: assert the spawned-tmux child env has no `TMUX`; assert `dispose` with
  `holdSession` does not kill within the window and does after the reaper fires;
  assert `text_delta` deltas are emitted for streamed output while `full_text`
  still arrives once at completion.

### Non-Goals

- Does not change the HOLP public wire protocol or event contract.
- Does not claim `cmux-ready` under any condition.
- Does not implement a cmux/Warp/terminal product UI.
- Does not solve cross-uid socket attach (single-user-local posture; documented).
- Does not sanitize ANSI/escape sequences in the delta stream (consumer-rendering
  concern; deltas are raw/advisory by contract).
- Does not add delta backpressure/coalescing.
- Does not wire a second real direct_user_session provider (that remains M8).

## L2 — socket targeting (the crux)

Create the worker on a caller-pinned absolute socket; make no assumption about the
daemon's launch context.

- Socket: `${XDG_RUNTIME_DIR:-/tmp}/holp/<runId>/tmux.sock`, parent `mkdir -p` 0700.
- Strip `TMUX` from the tmux child env (a daemon launched inside cmux/tmux must not
  silently retarget the worker to that server).
- `tmux -S <socket> new-session -d -s holp-<ts>-<rand>`.
- Return `tmux -S <socket> attach -t <session>` and
  `tmux -S <socket> kill-session -t <session>`.

Rejected alternatives: default-server-with-stripped-$TMUX only works in the common
case (breaks if the user's interactive tmux is on a custom `-L`); `-L <name>` still
drifts with `$TMUX_TMPDIR`. `-S <abspath>` is immune to TMPDIR/uid drift.

Residual honest limit: the human must *use* the returned command; we cannot make a
bare `tmux attach` work across differing sockets. Returning the fully-qualified
command is the honest ceiling.

## L1 — hold semantics

- Decision lives on `AgentBackendOptions` (per-run), not the static
  `DirectTmuxDefinition` and not a new `AgentBackend` method (keeps the contract
  surface unchanged for fake / mcp-codex / native-claude).
- Hold regardless of success/failure when the flag is set (failed runs are exactly
  what you want to inspect); leak-safety comes from the bounded reaper, not
  success-gating.
- Double cover: backend reaper + smoke-level explicit reap on exit. A hard SIGKILL
  can still orphan one session for one window; the printed kill command is the
  manual fallback.

## L3 — live stream: pipe-pane primary, capture-pane diff fallback

Primary: `pipe-pane` tees the full PTY byte stream from session birth →
append-only logfile → `slice(offset)` gives a trivially-correct lossless monotonic
delta. This is the standard-tmux path.

Fallback (added after real verification): **cmux ships its own tmux compatibility
shim (`~/.cmuxterm/omo-bin/tmux`) that does NOT support `pipe-pane`** (it returns
`Unsupported tmux compatibility command: pipe-pane`; it also lacks
`ls`/`list-sessions`). Under that shim the pipe-pane logfile stays empty, so L3
falls back to `capture-pane` diffing: each poll captures the visible pane and emits
the appended suffix as `text_delta`. This is **lossy** (visible pane only, no
scrollback; burst output scrolled off between polls is missed) but a lossy live
process is strictly better than none in the cmux target environment. Verified: a
real kimi worker under the cmux shim produced 6 `text_delta` events / 737 bytes via
the capture-diff fallback.

Selection is automatic: if `pipe-pane` succeeds and writes bytes, use the lossless
logfile; otherwise fall back to capture-diff.

Completion detection is unchanged either way:
- `capture-pane` + standalone marker stays the **authoritative completion** path →
  `full_text` (post-`stripEchoedMarkerCommand`).
- `text_delta` is the **best-effort live** path (raw, includes echoed command +
  marker printf + ANSI; advisory; lossless on standard tmux, lossy under cmux).

## Ordered risk list

1. `$TMUX` inheritance silently retargets the socket → strip it; test asserts no
   `TMUX` in tmux child env.
2. Burst data loss if capture-pane-diff is used for streaming → pipe-pane only.
3. Session leak if reaper never fires (SIGKILL) → bounded reaper + smoke reap +
   printed kill command.
4. Downstream assuming one `model_output` per step → contract doc + pre-flight grep
   (confirmed clean).
5. Socket parent dir / perms → orchestrator `mkdir -p` 0700.
6. pipe-pane logfile growth → unlink on dispose.
7. Probe/run socket mismatch → thread the same socket through both.

## Phased delivery

**Phase 1 — attachability (L2 + L1).** direct-tmux socket + `$TMUX` strip + hold
option + reaper + probe socket + smoke attach/reap commands + tests.

**Phase 2 — live stream (L3), after Phase 1.** pipe-pane logfile + offset tailer +
`text_delta` emit + contract doc + tests.

## Opt-In / Validation

- Reuse `HOLP_VISIBLE_AGENT_CHAIN_SMOKE=1 npm run smoke:visible-agent-chain`.
- Default (no env): SKIP, exit 0.
- A real PASS requires a logged-in controller + worker and consumes provider quota;
  the attach window and live deltas are verified against the real worker session.

## Honest Claim (when done)

> **direct_user_session observable + attachable worker (partial, substrate-only):**
> `DirectTmuxBackend` creates the worker on a caller-pinned tmux socket
> (`tmux -S <abspath>`), strips the daemon-inherited `$TMUX`, and returns
> fully-qualified attach/kill commands; `holdSession` keeps the session attachable
> for a bounded, reaper-guarded window instead of zero. L3 streams the worker pane
> as `model_output.text_delta` (protocol unchanged; `text_delta` raw/advisory,
> `full_text` authoritative/cleaned): lossless via `pipe-pane` on standard tmux,
> lossy via `capture-pane` diff under the cmux tmux shim (which lacks `pipe-pane`).
> Verified: real worker emits text_delta under both — including 6 events under the
> cmux shim fallback.
> **Still not `cmux-ready`**: standard `tmux attach` does not work under the cmux
> shim (sessions land on the cmux server); cross-uid socket attach, ANSI
> sanitization, and consumer rendering are not done; `attach` is an observation
> surface, not injectable control; a second real direct_session provider remains M8.
> The consumer-facing path under cmux is the `text_delta` event stream, not attach.
