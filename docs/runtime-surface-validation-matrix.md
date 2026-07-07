# Runtime Surface Validation Matrix

This document is the Issue #52 validation record for the Issue #45
multi-agent CLI runtime-surface completion phase.

It is a gate record, not a new runtime implementation. It summarizes local
smoke/probe evidence for the bounded CLI cohort and decides whether the #45
precondition is complete enough for #41 to declare learned-router training data
sufficiency. It does not claim #36 learned-active readiness, active/canary
readiness, or cmux product readiness.

## Gate Decision

| Gate | Decision | Evidence |
| --- | --- | --- |
| #45 bounded cohort matrix complete | `allowed` | All 21 agent/surface cells below have an explicit state and evidence/reason. No cell is blank, unknown, or `not_validated`. |
| #41 learned-router training data sufficiency declaration | `allowed` | Ready cells span seven agents, both live and first-batch cohorts, and all three runtime-surface families. This decision also depends on the final Merge Gate terminal-consumer rerun staying green. #41 still owns its dataset/sample sufficiency checks and must not treat this as learned-active readiness. |
| Terminal consumer integration | `terminal-consumer-integration-ready` | `HOLP_TERMINAL_CONSUMER_SMOKE=1 HOLP_REAL_HARNESS_SMOKE=1 npm run smoke:terminal-consumer` passed through HOLP public wire against `kimi-code-agent` ACP. This row is valid only after the final Merge Gate reruns that opt-in smoke and uses the latest result; see the transient-risk note below. |
| cmux / terminal product readiness | `cmux-pending-user-validation` | The #54 smoke prints `cmux_claim=not_requested` and `INFO cmux_status=cmux-pending-user-validation`. No real cmux automation transcript or explicit user validation has been recorded. This row is likewise tied to the final Merge Gate rerun. |

`cmux-pending-user-validation` does not block #41 because #41 needs a
terminal-style public-wire integration signal, not a full cmux UI adapter.
`cmux-ready` remains false until real cmux-side automation or explicit user
validation is recorded.

## Evidence Runbook

All commands were run from `/Users/tizer_mac_studio/claude-workspace/holp` on
branch `codex/issue-52-user-validation-matrix-gate` after #54 was merged into
`main@89427be`.

| Command | Result | Notes |
| --- | --- | --- |
| `npm run smoke:terminal-consumer` | `SKIP` | Default path is safe and non-mutating. This does not count as gate evidence. |
| `HOLP_REAL_CODEX_SMOKE=1 npm run smoke:codex:surfaces` | `PASS` | Codex headless, ACP, and direct all passed. |
| `HOLP_REAL_CLAUDE_SMOKE=1 npm run smoke:claude:surfaces` | `PASS` | Claude headless and direct passed; ACP is honest `unsupported`. |
| `HOLP_REAL_HARNESS_SMOKE=1 npm run smoke:harnesses` | `PASS` | First-batch headless passed. Kimi Code, OpenCode, and Pi ACP passed; Cursor Agent and Reasonix ACP stayed degraded with reasons. |
| `HOLP_REAL_HARNESS_DIRECT_SMOKE=1 npm run smoke:first-batch:direct` | `PASS` | Cursor Agent, Kimi Code, OpenCode, Pi, and Reasonix direct tmux passed. |
| `HOLP_TERMINAL_CONSUMER_SMOKE=1 HOLP_REAL_HARNESS_SMOKE=1 npm run smoke:terminal-consumer` | `PASS` | Selected `kimi-code-agent` ACP, observed `run_started` runtime `acp`, cancelled through public wire, terminal `run_gave_up`, gate report present, artifact summary `none`. |

During internal review, one repeat of the terminal-consumer opt-in smoke saw
Kimi ACP degrade with `acp_prompt_timeout`; an immediate Commander rerun passed
with the same command and is the counting gate evidence above. Treat this as a
transient external-CLI risk: the Merge Gate must rerun the opt-in smoke and use
the latest result, not the historical pass, before merging.

Version probes:

| Tool | Version / status |
| --- | --- |
| Codex | `codex-cli 0.141.0` |
| codex-acp | present |
| Claude Code | `2.1.186 (Claude Code)` |
| Cursor Agent | `2026.06.19-20-24-33-653a7fb` |
| Kimi Code | `0.19.1` |
| OpenCode | `1.17.9` |
| Pi | `0.79.10` |
| Reasonix | `reasonix v1.11.0` |
| tmux | `tmux 3.6b` |

Auth/quota context: every `ready` cell below is backed by a successful local
smoke in this environment. No command reported auth, quota, or provider-limit
failure during this validation pass. Degraded cells retain their explicit
protocol failure reasons.

## Bounded Cohort Matrix

State vocabulary:

- `ready`: matching-surface smoke/probe passed for the stated isolation profile.
- `degraded`: implementation or binary exists, but the matching-surface proof is
  incomplete or failed closed.
- `rejected`: explicitly not schedulable for the profile.
- `unsupported`: the agent does not provide that surface.
- `not_validated`: interim-only; it must not appear when the gate is `allowed`.

Every `ready` claim below is scoped to `coder_worktree` unless a row says
otherwise. A `coder_worktree` pass does not imply `read_only_review` readiness.
For `direct_user_session`, `ready` means the matching HOLP-owned direct-tmux
one-shot visible path passed its smoke/probe. It does not mean an interactive
agent UI exists, and it does not permit human mid-run correction through the
pane.

| Agent | `headless` | ACP/native-or-bridge | `direct_user_session` |
| --- | --- | --- | --- |
| Codex | `ready` (`coder_worktree`; `codex-cli 0.141.0`; app-server probe; `HOLP_REAL_CODEX_SMOKE=1 npm run smoke:codex:surfaces`) | `ready` (`coder_worktree`; `codex-acp` present; ACP returned `HOLP_OK`; same smoke command) | `ready` (`coder_worktree`; `tmux 3.6b`; HOLP-owned tmux pane captured `HOLP_OK`; same smoke command) |
| Claude Code | `ready` (`read_only_review`; `2.1.186`; `claude_code_print_json`; `HOLP_REAL_CLAUDE_SMOKE=1 npm run smoke:claude:surfaces`) | `unsupported` (`claude_no_native_acp`; no native ACP; explicit ACP must not fall back to headless) | `ready` (`coder_worktree`; `tmux 3.6b`; HOLP-owned direct tmux observed `HOLP_OK`; same smoke command) |
| Cursor Agent | `ready` (`coder_worktree`; `2026.06.19-20-24-33-653a7fb`; first-batch headless smoke passed; `HOLP_REAL_HARNESS_SMOKE=1 npm run smoke:harnesses`) | `degraded` (`coder_worktree`; `acp_session_new_timeout`; explicit ACP did not fall back to headless; same smoke command) | `ready` (`coder_worktree`; `tmux 3.6b`; HOLP-owned direct tmux verified `HOLP_OK`; `HOLP_REAL_HARNESS_DIRECT_SMOKE=1 npm run smoke:first-batch:direct`) |
| Kimi Code | `ready` (`coder_worktree`; `0.19.1`; first-batch headless smoke passed; `HOLP_REAL_HARNESS_SMOKE=1 npm run smoke:harnesses`) | `ready` (`coder_worktree`; `0.19.1`; ACP returned `HOLP_OK`; same smoke command) | `ready` (`coder_worktree`; `tmux 3.6b`; HOLP-owned direct tmux verified `HOLP_OK`; `HOLP_REAL_HARNESS_DIRECT_SMOKE=1 npm run smoke:first-batch:direct`) |
| OpenCode | `ready` (`coder_worktree`; `1.17.9`; first-batch headless smoke passed; `HOLP_REAL_HARNESS_SMOKE=1 npm run smoke:harnesses`) | `ready` (`coder_worktree`; `1.17.9`; ACP returned `HOLP_OK`; same smoke command) | `ready` (`coder_worktree`; `tmux 3.6b`; HOLP-owned direct tmux verified `HOLP_OK`; `HOLP_REAL_HARNESS_DIRECT_SMOKE=1 npm run smoke:first-batch:direct`) |
| Pi | `ready` (`coder_worktree`; `0.79.10`; first-batch headless smoke passed; `HOLP_REAL_HARNESS_SMOKE=1 npm run smoke:harnesses`) | `ready` (`coder_worktree`; `0.79.10`; ACP returned `HOLP_OK`; same smoke command) | `ready` (`coder_worktree`; `tmux 3.6b`; HOLP-owned direct tmux verified `HOLP_OK`; `HOLP_REAL_HARNESS_DIRECT_SMOKE=1 npm run smoke:first-batch:direct`) |
| Reasonix | `ready` (`coder_worktree`; `reasonix v1.11.0`; first-batch headless smoke passed; `HOLP_REAL_HARNESS_SMOKE=1 npm run smoke:harnesses`) | `degraded` (`coder_worktree`; `reasonix_acp_session_new_succeeded_prompt_terminal_not_verified:acp_request_timeout:session/prompt`; not certified as ready even when session/new progresses; same smoke command) | `ready` (`coder_worktree`; `tmux 3.6b`; HOLP-owned direct tmux verified `HOLP_OK`; `HOLP_REAL_HARNESS_DIRECT_SMOKE=1 npm run smoke:first-batch:direct`) |

## Terminal Consumer Evidence

The counting #54 smoke was:

```bash
HOLP_TERMINAL_CONSUMER_SMOKE=1 HOLP_REAL_HARNESS_SMOKE=1 npm run smoke:terminal-consumer
```

It used only HOLP public wire:

- `initialize` negotiated protocol `0.1.8` with `gate_report=true`;
- `flock.discover` selected `kimi-code-agent`, `runtime_surface=acp`,
  `coder_worktree=ready`, version `0.19.1`;
- `orchestrate.run` accepted `run_1`;
- `events.subscribe` observed `run_started`;
- `run_started.payload.runtime.runtime_surface` matched requested `acp`;
- `task.cancel` was accepted as public control evidence;
- terminal event was `run_gave_up`;
- post-terminal gate report was present with `disposition=no_gate`;
- artifact summary was `none`;
- `cmux_claim=not_requested` was printed before the run;
- final markers were `PASS terminal-consumer-integration-ready` and
  `INFO cmux_status=cmux-pending-user-validation`.

This certifies only the exercised `(kimi-code-agent, acp, coder_worktree)` path.
It does not certify other agents, other surfaces, `read_only_review`, or cmux UI
readiness.

## #41 / #36 Boundary

#41 may now proceed to learned-router training data sufficiency declaration
because the #45 prerequisite has a resolved multi-agent, multi-surface matrix and
a real terminal-consumer public-wire pass. #41 still owns its own dataset
quality, sampling, reward, manifest, and training-distribution checks.

Issue #76 adds a separate real-usage UI gate for HOLP Harness Workspace data.
The #52 decision above is a runtime-surface/public-wire prerequisite and remains
valid, but it is not by itself permission to count smoke/script Harness
Workspace sessions as real-usage training-distribution evidence. The #76
validation record moved with the Harness Workspace consumer to the holp-cmux
repo (#105); see
[holp-cmux `docs/harness-workspace-user-validation.md`](https://github.com/tizerluo/holp-cmux/blob/main/docs/harness-workspace-user-validation.md)
for the current #76 decision.

#36 remains blocked on #41 data sufficiency, #44 model compatibility
constraints, real learned-model backing, active/canary smoke, and L2
learned-active readiness. Nothing in this document claims those downstream
states.
