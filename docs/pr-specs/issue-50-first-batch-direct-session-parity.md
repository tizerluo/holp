# Issue #50 - First-Batch Direct Session Parity

## Summary

Issue #50 is the direct-session parity PR for the PR14 first-batch cohort in
the #45 multi-agent CLI runtime surface completion phase.

This PR must give Cursor Agent, Kimi Code, OpenCode, Pi, and Reasonix explicit
`direct_user_session` states with evidence. It may configure tmux-backed direct
session factories for agents whose one-shot CLI command can be safely injected
into a HOLP-owned throwaway tmux session, but readiness must remain gated by a
matching direct smoke/probe. A headless or ACP pass must never count as direct
readiness.

This PR does not touch Codex or Claude Code direct parity; those were handled
by #48 and #49. It also does not harden first-batch ACP readiness, implement
terminal-consumer smoke, claim `cmux-ready`, or unblock #41 data sufficiency.

## Current Baseline

- #47 generalized `DirectTmuxBackend` and `probeDirectTmux`:
  - HOLP creates `holp-*` tmux sessions.
  - The backend injects one-shot commands with `send-keys`, reads terminal
    output, supports interrupt/cancel/cleanup, and does not attach existing
    user shells.
  - Direct `ready` already requires both capability proof and
    agent-in-tmux `HOLP_OK` output.
- `FIRST_BATCH_HARNESSES` now declares configured direct factories for Cursor
  Agent, Kimi Code, OpenCode, Pi, and Reasonix. They remain degraded by default
  and upgrade only when `HOLP_REAL_HARNESS_DIRECT_SMOKE=1` proves the matching
  HOLP-owned tmux direct path and `HOLP_OK`.
- `scripts/smoke/harnesses.ts` is the existing PR14 first-batch harness smoke,
  but it mixes headless/ACP readiness and #51-owned ACP schedulability. #50
  needs a direct-only smoke or a direct-only mode so #50 evidence does not
  depend on #51.
- The #45 baseline matrix says #50 owns direct-session parity for the
  first-batch cohort.

## Scope

### 1. Direct Session Declarations

Update first-batch direct declarations so every target agent has one of:

- `configured`: a real tmux-backed direct backend is wired, but readiness is
  degraded by default until a direct smoke proves it.
- `degraded` / `rejected` / `unsupported`: direct cannot be safely wired or
  cannot be honestly controlled yet, with actionable reason and missing
  evidence.

Do not leave any first-batch direct cell blank or as
`*_unsupported_until_issue_50`.

`configured` always means `firstBatchAdapterFactories()` wires a
`direct_user_session` backend factory and the runtime probe may still report
degraded/not-ready. Declaration-level `degraded`, `rejected`, and `unsupported`
mean no direct backend factory is exposed for that target.

Expected direct command shapes, based on local driver skills:

- Cursor Agent:
  - command: `cursor-agent`
  - args: `["-p", prompt, "--output-format", "text", "--force"]`
  - Any `CURSOR_API_KEY` / auth missing path is degraded or skipped by smoke,
    not ready.
- Kimi Code:
  - preserve current command: `kimi`
  - args: `["-p", prompt, "-m", "kimi-code/kimi-for-coding", "--output-format", "text"]`
  - Keep coding-plan/provider caveats as evidence.
- OpenCode:
  - command: `opencode`
  - args: `["run", "--pure", prompt, "-m", "opencode/deepseek-v4-flash-free"]`
  - The model is explicit and grounded in the local `drive-opencode` skill's
    known usable examples. This provenance only justifies the configured direct
    factory; real direct smoke remains the only readiness proof.
- Pi:
  - command: `pi`
  - args: `["-p", prompt, "--mode", "text", "--provider", "xiaomi-token-plan-sgp", "--model", "mimo-v2.5-pro"]`
    unless repo reality proves another pinned command is required.
- Reasonix:
  - command: `reasonix`
  - args: `["run", "--model", "deepseek-flash", prompt]`, relying on the
    HOLP-created tmux session cwd, or `["run", "--model", "deepseek-flash",
    "--dir", ".", prompt]` if the CLI requires an explicit `--dir`.
  - Reasonix direct may be `configured` but degraded by default. If local
    `reasonix doctor` / CLI reality shows planner/provider config makes direct
    one-shot unsafe, keep it degraded/rejected with an explicit reason.

All configured direct declarations must use HOLP-owned tmux sessions only:

- `session_origin:"holp_created"`
- `session_id_namespace:"holp-*"`
- no attach to existing user shells or user-created tmux sessions
- no readiness from `probeDirectTmux` alone

### 2. Readiness and Reasons

Default probe behavior must not run real direct turns unless the explicit
direct-only smoke env is enabled. `probeFirstBatchHarness` /
`directProbeReady` must gate first-batch `direct_user_session` readiness on
`HOLP_REAL_HARNESS_DIRECT_SMOKE=1`, not on the existing combined
`HOLP_REAL_HARNESS_SMOKE=1` env used by #51's headless/ACP smoke. Default
`flock.discover` / `flock.declare` should report configured direct surfaces as
degraded, not ready.

`HOLP_REAL_HARNESS_SMOKE=1` alone must never make a first-batch direct surface
ready. This keeps #51 combined harness evidence from laundering itself into #50
direct readiness.

Direct readiness is `ready` only when all are true:

- tmux binary/version probe succeeds;
- target agent binary/version probe succeeds;
- `probeDirectTmux({ verifyCapabilities:true })` proves HOLP can create,
  inject into, read from, interrupt/cancel, and clean up a HOLP-owned session;
- `DirectTmuxBackend.startSession` + `sendPrompt` executes the target agent
  inside the HOLP session;
- observed terminal/model output includes `HOLP_OK`;
- direct channel reports `observe/read/inject/interrupt/cancel/owner_verified`.

When not ready, reasons must distinguish:

- smoke not enabled;
- missing tmux;
- missing target binary;
- tmux create/inject/read/cancel/cleanup failure;
- agent output did not include `HOLP_OK`;
- auth/quota/provider/model configuration missing;
- direct unsupported by policy.

### 3. Direct Smoke / Validation Command

Add or extend a direct-only smoke command. Suggested script:

- `npm run smoke:first-batch:direct`
- Default without env exits 0 with SKIP and runs no real provider turns.
- Opt-in env: `HOLP_REAL_HARNESS_DIRECT_SMOKE=1`.

The smoke must report each first-batch agent separately:

- transport
- direct state: PASS / SKIP / INCONCLUSIVE / FAIL
- CLI version when available
- tmux version when available
- readiness reason or failure reason
- evidence marker for `HOLP_OK` when passed

Missing local binary/auth/quota should be SKIP or INCONCLUSIVE unless the code
claims ready. A failing direct tmux control path for a configured target is
FAIL.

Real direct smoke must run provider/agent turns from a HOLP-owned throwaway
working directory, not the live repository checkout. Cursor Agent, OpenCode,
Pi, Reasonix, and Kimi are coding agents with write-capable behavior; a benign
`HOLP_OK` probe must not be able to mutate the repo working tree.

The existing `HOLP_REAL_HARNESS_SMOKE=1 npm run smoke:harnesses` remains #51's
combined headless/ACP smoke and must not become #50's only direct evidence.

### 4. Registry and Scheduling

`firstBatchAdapterFactories()` should expose a `direct_user_session` backend
factory for every configured first-batch direct target. Explicit direct
selection must not fallback to headless or ACP.

Tests must cover both directions:

- direct factory exists for configured targets;
- explicit direct selection rejects when direct is degraded/rejected;
- explicit direct selection can be accepted for a fake configured target whose
  direct smoke is proven ready.

### 5. Documentation

Update:

- `docs/pr-specs/README.md`
- `docs/pr-specs/issue-45-multi-agent-cli-runtime-surface-completion.md`

The #45 matrix must say what #50 proves for each first-batch direct surface.
If local auth or tool availability prevents a real ready smoke, the matrix
must record degraded/rejected/unsupported honestly rather than implying ready.

Remove the temporary #47 scaffolding strings/helpers for
`direct_user_session_not_declared_until_issue_50` once all five direct cells are
declared. Degraded/rejected direct entries should use specific runtime kinds
and reasons, such as `opencode_direct_degraded_missing_model`, rather than a
generic `*_unsupported_until_issue_50` placeholder.

## Acceptance Criteria

- AC1: Cursor Agent, Kimi Code, OpenCode, Pi, and Reasonix each have an
  explicit `direct_user_session` state and evidence/refusal reason.
- AC2: No first-batch direct state remains
  `direct_user_session_not_declared_until_issue_50`.
- AC3: Configured direct targets expose a real `direct_user_session` backend
  factory and explicit direct selection never falls back to headless;
  declaration-level degraded/rejected/unsupported targets expose no direct
  backend factory.
- AC4: Default probes do not run real direct tmux/provider turns and do not
  declare direct ready.
- AC5: Direct `ready` requires HOLP-owned tmux capability proof plus
  agent-in-tmux `HOLP_OK`; `probeDirectTmux` alone is insufficient.
- AC6: Direct channel metadata is populated only from matching direct evidence:
  `observe/read/inject/interrupt/cancel/owner_verified`, `holp-*`,
  `holp_created`.
- AC7: Unsupported/degraded/rejected targets include actionable reasons and
  missing capability entries.
- AC8: User validation can run a direct-only smoke and intentionally skip
  unavailable local tools/auth with recorded reasons.
- AC9: #50 does not change Codex/Claude direct surfaces, first-batch
  headless/ACP readiness, terminal-consumer smoke, #41, #44, or #36 gates.

## GitNexus / Risk

Current baseline: `main@a61bda2`.

Expected product/test touchpoints:

- `adapters/first-batch-harnesses.ts`
- `adapters/registry.ts` only if needed for factory wiring; avoid changing
  generic registry semantics.
- `scripts/smoke/harnesses.ts` or a new `scripts/smoke/first-batch-direct.ts`.
- `adapters/registry.test.ts` and possibly `adapters/direct-tmux.test.ts`.
- `docs/pr-specs/README.md`
- `docs/pr-specs/issue-45-multi-agent-cli-runtime-surface-completion.md`
- `package.json` for the direct smoke script.

Impact checks required before product/test edits:

- `firstBatchAdapterFactories`
- `probeFirstBatchHarness`
- `directProbeReady`
- `FIRST_BATCH_HARNESSES`
- `DirectTmuxBackend`
- `DirectTmuxBackend.startSession`
- `DirectTmuxBackend.sendPrompt`
- `probeDirectTmux`
- `createDefaultAdapterRegistry` if touched

If Coder believes `handleOrchestrateRun`, `parsePreferredRuntimeSurface`,
`driveRun`, or `driveWorkflowRun` must change, stop and return to Commander for
Architect re-review. #50 should reuse existing explicit direct selection
semantics.

## Test Plan

Focused:

- `npm test -- adapters/direct-tmux.test.ts adapters/registry.test.ts daemon/handlers/m1b_contract.test.ts daemon/handlers/flock_probe.test.ts`
- Cover all five first-batch direct declarations.
- Cover non-Kimi direct factory exposure for configured targets.
- Cover default direct degraded/not-ready without real smoke.
- Cover `HOLP_REAL_HARNESS_SMOKE=1` alone does not make first-batch direct
  ready; only `HOLP_REAL_HARNESS_DIRECT_SMOKE=1` may opt in direct readiness.
- Cover fake direct-ready target requires `DirectTmuxBackend.sendPrompt`
  output containing `HOLP_OK`.
- Cover missing `HOLP_OK` remains degraded and direct channel bitmask is empty.
- Cover explicit direct selection does not fallback headless.
- Cover direct smoke script default SKIP.

Opt-in smoke:

- `npm run smoke:first-batch:direct`
- `HOLP_REAL_HARNESS_DIRECT_SMOKE=1 npm run smoke:first-batch:direct`

The opt-in smoke may pass, skip, or be inconclusive per target depending on
local CLI binaries/auth/quota. It must fail only on a configured direct target
whose tmux/owner/control mechanics break. The Merge Gate may pass with honest
degraded/skipped entries, but it may not pass if any code path claims direct
ready without matching direct evidence.

Full gate:

- `npm run typecheck`
- `npm test`
- `npm run demo:m5`
- `git diff --check`
- `npx gitnexus detect-changes --repo holp`
- staged: `npx gitnexus detect-changes --repo holp --scope staged`

## Agent Workflow

- Architect: Claude Opus 4.8 via `drive-claude`, `--effort high`, read-only
  adversarial review before implementation. Fallback:
  Pioneer 100U -> Pioneer 50U -> official OAuth -> ZCode -> Kimi Code ->
  internal Codex subagent.
- Coder: Codex native leaf subagent; no subagents, no git, checkpoint file plan
  before editing.
- Tester: Kimi Code CLI conservative path; fallback ZCode, then internal Codex
  subagent. Kimi ACP is not the formal report path here.
- Internal Reviewer: Codex native leaf reviewer focused on direct readiness,
  owner scope, no headless/ACP fallback, smoke evidence, and test coverage.
- External Deep Reviewer: Claude Opus 4.8 read-only review after
  implementation.
- Architect/Tester/Internal Reviewer/External Reviewer/Merge Gate reports must
  be posted as PR comments when the PR exists.

## Stop Conditions

- Stop if any first-batch direct readiness is inferred from headless or ACP.
- Stop if direct ready can be produced by `probeDirectTmux` without an
  agent-in-tmux `HOLP_OK` round-trip.
- Stop if any path attaches to an existing user shell/session.
- Stop if explicit direct selection falls back to headless/ACP.
- Stop if the direct smoke script runs real provider turns by default.
- Stop if Reasonix limitations are hidden as ready.
- Stop if #50 requires changing generic orchestrate runtime selection
  semantics.
- Stop if no truthful direct state can be represented for any target.

## Non-Goals

- Do not change Codex or Claude Code surfaces.
- Do not harden or complete first-batch headless/ACP readiness; #51 owns that.
- Do not add terminal-consumer smoke; #54 owns that.
- Do not create the final user validation matrix; #52 owns that.
- Do not train/connect learned routing, #41 data sufficiency, #44 model
  compatibility constraints, #36 active/canary readiness, or PR17 Remote.
- Do not implement cmux, Warp, or terminal-product UI.
