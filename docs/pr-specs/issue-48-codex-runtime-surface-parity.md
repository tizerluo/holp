# Issue #48 - Codex Headless / ACP / Direct Runtime Surface Parity

## Summary

Issue #48 is the Codex-specific runtime-surface parity PR inside the #45
multi-agent CLI runtime-surface completion phase. It upgrades the existing
`mcp-codex` declaration from "headless app-server plus unwired ACP/direct" into
an honest three-surface matrix:

- `headless`: existing Codex app-server over stdio.
- `acp`: official Zed-maintained `codex-acp` bridge.
- `direct_user_session`: HOLP-owned throwaway tmux session running the real
  Codex CLI.

This PR is Medium. It touches runtime adapter/registry behavior and tests, so
Commander must run Architect review before implementation. Commander remains
orchestrator only; Coder owns product code and tests.

## Current Baseline

- `mcp-codex` headless is implemented by
  `adapters/codex-app-server.ts` as Codex app-server over stdio.
- `probeCodexAppServer(...)` currently returns a single status that marks
  `headless` ready/degraded/rejected, while `acp` is
  `codex_acp_unwired` and `direct_user_session` is unknown/rejected.
- `createDefaultAdapterRegistry()` currently wires `"mcp-codex"` to a flat
  headless-only factory. `createAdapterRegistry(...)` already supports
  per-surface factories and must not fall back to headless for explicit ACP or
  direct selection.
- #47 generalized the shared direct tmux foundation and proved Kimi remains the
  only configured first-batch direct path. #48 may now add a Codex-specific
  direct declaration, but must not change first-batch direct parity.

## Key Changes

### 1. Codex surface declarations

Introduce a small Codex runtime-surface declaration/probe shape that can express
each Codex surface independently:

- `headless` uses existing app-server readiness:
  - command: `codex`
  - kind: `app_server`
  - fidelity: `streaming_controlled`
  - ready only after `codex --version`, `codex doctor` auth proof, and
    app-server `initialize` succeed.
- `acp` uses the official/available Codex ACP bridge:
  - command: `codex-acp` or equivalent `npx @zed-industries/codex-acp` only if
    implemented through an explicit configured command path.
  - kind: `codex_acp`
  - fidelity: `streaming_controlled` if the ACP client receives session update
    chunks/terminal signals; otherwise `one_shot` only with a clear reason.
  - ready only after real `initialize`, authentication if needed,
    `session/new`, `session/prompt`, final text containing `HOLP_OK`, and
    terminal signal complete.
  - committed default readiness is `degraded` with an actionable reason such as
    `codex_acp_terminal_not_verified`; synthetic tests may exercise parsing and
    fail-closed logic, but cannot be the evidence that makes the committed
    Codex ACP surface ready.
- `direct_user_session` uses HOLP-owned tmux:
  - command: `codex`
  - runtime kind: `codex_direct_tmux`
  - fidelity: `streaming_controlled`
  - session origin: `holp_created`
  - namespace: `holp-*`
  - ready only after `probeDirectTmux({ verifyCapabilities:true })` plus
    `DirectTmuxBackend.startSession()` + `sendPrompt()` emits `HOLP_OK`.
  - committed default readiness is `degraded` with an actionable reason such as
    `codex_direct_terminal_not_verified`.
  - direct invocation must be non-interactive. The intended command is
    `codex exec --sandbox workspace-write -c 'approval_policy="never"' --skip-git-repo-check -c 'notify=[]' <prompt>`,
    or an implementation-equivalent argv form. If the direct tmux foundation
    needs a minimal extension to ensure EOF / no interactive stdin for
    `codex exec`, Coder may add that extension with tests; the command must not
    hang on an approval/sandbox prompt.

If a required binary/auth/session/smoke is missing, the corresponding surface is
`degraded`, `rejected`, or `unsupported` with actionable `reason` and `missing`
entries. A ready headless surface must not make ACP or direct ready.

### 2. Registry wiring

Wire `"mcp-codex"` in the live registry as a per-surface factory map:

- `headless`: existing `createCodexAppServerBackendFactory()`.
- `acp`: `createAcpBackendFactory(...)` for the Codex ACP bridge.
- `direct_user_session`: `createDirectTmuxBackendFactory(...)` for Codex direct
  tmux.

Do not change `createAdapterRegistry(...)` fallback semantics. Explicit
`acp`/`direct_user_session` resolution must keep returning only the matching
factory or `undefined`; it must never silently return headless.

The registry map must preserve the existing headless factory path: resolving
`"mcp-codex"` with no explicit surface or with `"headless"` must still return
`createCodexAppServerBackendFactory()`. Add a regression test for this because
converting `"mcp-codex"` from a flat factory to a per-surface map touches HIGH
risk runtime dispatch.

### 3. Probe and schedulability

Update Codex probing so that:

- `flock.declare` / `flock.discover` report all three Codex surfaces with
  independent readiness.
- Normal `flock.declare` / `flock.discover` must not run real ACP or direct
  prompt turns by default. ACP/direct real round-trips are attempted only under
  explicit opt-in env, reusing `HOLP_REAL_CODEX_SMOKE=1` or a sibling env whose
  name is documented in this PR. Without opt-in, ACP/direct remain degraded with
  actionable reasons.
- Agent-level `status` is `ready` if at least one schedulable Codex surface is
  ready; otherwise `degraded` if any Codex binary/auth/bridge/direct evidence is
  present; otherwise `rejected`.
- `resolved_roles` are present only when a usable surface exists or the agent is
  honestly degraded with actionable missing evidence; rejected stays empty.
- `read_only_review` remains degraded unless read-only enforcement is actually
  proven. Do not upgrade reviewer readiness just because Codex headless/ACP/direct
  coder surface is ready.
- ACP/direct `read_only_review` must stay non-ready in #48. If a future PR wants
  Codex ACP/direct reviewer readiness, it must first update
  `reviewerExecutionConfig(...)` so a selected non-headless Codex reviewer
  actually runs through the matching surface rather than the existing headless
  app-server reviewer path.

### 4. Smoke and evidence

Add or extend opt-in smoke coverage so a local user can reproduce Codex surface
states:

- Existing `HOLP_REAL_CODEX_SMOKE=1 npm run smoke:codex` and
  `smoke:codex:adapter` continue proving app-server headless behavior.
- Add the smallest Codex ACP smoke, either under `npm run smoke:codex:surfaces`
  or another clearly named script. It must SKIP by default without opt-in env,
  and when enabled record PASS/INCONCLUSIVE/FAIL honestly.
- Add the smallest Codex direct tmux smoke to the same command or a sibling
  command. It must create only HOLP-owned sessions and must not attach to an
  existing shell.
- Smoke output must include command/tool versions, env/auth assumptions, outcome,
  and degraded/skipped reasons where available.
- Real ACP/direct smoke evidence must be recorded before a surface may be
  committed as `ready`. If local tooling/auth/quota is unavailable, commit the
  surface as `degraded` / `rejected` with reason; do not infer readiness from
  synthetic unit tests.
- Direct tmux smoke should avoid losing the completion marker to visible-pane
  truncation. Prefer full scrollback capture or another deterministic capture
  path if Codex output is verbose. If not implemented, timeout must degrade
  honestly rather than claim ready.
- Direct Codex smoke must suppress notify-hook side effects as much as the CLI
  allows (`-c 'notify=[]'`) and record any remaining orphan-process risk as a
  degraded/skipped reason rather than a ready proof.

The PR may use synthetic unit tests for CI. Real Codex ACP/direct smokes are
opt-in because they consume local auth/quota and depend on installed tools.

### 5. Documentation updates

Update:

- This per-PR spec.
- `docs/pr-specs/README.md`.
- `docs/pr-specs/issue-45-multi-agent-cli-runtime-surface-completion.md` Codex
  row/evidence notes to record the post-#48 state.
- Any runtime/session matrix docs that would otherwise claim Codex ACP/direct is
  still unwired after #48.

Do not rewrite historical PR specs; they remain historical records.

## Acceptance Criteria

- AC1: Codex `headless`, `acp`, and `direct_user_session` surfaces all appear in
  `mcp-codex` probe output with independent readiness, reason, missing, runtime
  kind, fidelity, and state ref.
- AC2: Explicit ACP/direct runtime selection never falls back to headless.
  Existing per-surface registry tests remain green and Codex-specific tests cover
  missing ACP/direct factory or degraded proof rejecting selection.
- AC3: Codex ACP ready requires real ACP handshake/session/prompt terminal proof
  containing `HOLP_OK` under explicit opt-in smoke. Process exit, parse error,
  missing terminal/final text, timeout, and empty/error output fail closed.
  Synthetic tests alone may not make the committed ACP declaration ready.
- AC4: Codex direct ready requires real HOLP-owned tmux probe plus
  agent-in-tmux `HOLP_OK` under explicit opt-in smoke; probe availability alone
  is insufficient.
- AC5: Direct session owner scope remains fail-closed: only `holp-*` sessions
  created by HOLP are controlled; no attach to user shells.
- AC6: Headless app-server behavior remains compatible with existing Codex
  approval/patch smokes and tests.
- AC7: `read_only_review` for Codex is not upgraded unless this PR adds a real
  read-only enforcement proof and updates reviewer execution to honor the
  selected surface. In #48, ACP/direct reviewer readiness remains
  degraded/fail-closed.
- AC8: #45 master spec and README reflect the new Codex post-#48 matrix state.

## GitNexus / Risk

Baseline: `main@9b23d2a` after #47.

Impact already checked:

- `probeCodexAppServer`: LOW, direct test impact.
- `createCodexAppServerBackendFactory`: HIGH; affects
  `createDefaultAdapterRegistry`, `reviewerExecutionConfig`, Codex reviewer
  smoke, `handleOrchestrateRun`, `buildDispatcher`, daemon runtime, and harness
  smoke paths.
- `createDefaultAdapterRegistry`: HIGH; affects daemon runtime,
  `acpSelectionSchedulable`, handler tests, and smoke paths.
- `createAdapterRegistry`: HIGH; shared per-surface resolution; must not change
  fallback semantics unless Architect re-approves.

Implementation guidance:

- Prefer adding Codex-specific helpers over changing `createAdapterRegistry`.
- Preserve `"mcp-codex"` headless resolution through
  `createCodexAppServerBackendFactory()` and add a direct regression test.
- Do not change `parsePreferredRuntimeSurface`, `handleOrchestrateRun`,
  `driveRun`, or `driveWorkflowRun` unless Coder first reports `BLOCKED` and
  Commander returns to Architect review.
- If `AcpClient` must change to support Codex ACP chunk/terminal shape, keep the
  change protocol-generic and preserve existing first-batch ACP tests.
- Any change to `DirectTmuxBackend.startSession` or `dispose` is HIGH/CRITICAL
  sensitive due #47 ownership safety; avoid unless absolutely necessary.

Commander must warn the user before implementation that this PR touches HIGH
risk runtime registry/adapter paths. This spec is that warning and must be
repeated in the Coder brief.

## Test Plan

Focused:

- `npm test -- adapters/codex-app-server.test.ts adapters/acp-client.test.ts adapters/direct-tmux.test.ts adapters/registry.test.ts daemon/handlers/flock_probe.test.ts daemon/handlers/m1b_contract.test.ts daemon/handlers/codex_adapter_integration.test.ts`
- Add/update Codex tests covering:
  - headless ready while ACP/direct degraded does not mark ACP/direct ready;
  - default probe does not run real ACP/direct prompt turns without opt-in env;
  - ACP ready with synthetic `codex-acp` terminal `HOLP_OK`;
  - ACP fail-closed for process exit, malformed JSON, timeout/missing terminal,
    and empty final output;
  - synthetic ACP tests do not by themselves make committed Codex ACP ready;
  - direct degraded when only `probeDirectTmux` passes but agent smoke lacks
    `HOLP_OK`;
  - direct ready includes owner/capability metadata and no user-shell attach;
  - explicit ACP/direct selection does not fallback to headless.
  - `"mcp-codex"` headless resolution still returns the app-server factory after
    live registry wiring changes from a flat factory to a per-surface map.

Full gate:

- `npm run typecheck`
- `npm test`
- `npm run demo:m5`
- `git diff --check`
- `npx gitnexus detect-changes --repo holp`
- staged: `npx gitnexus detect-changes --repo holp --scope staged`

Opt-in real smokes:

- `HOLP_REAL_CODEX_SMOKE=1 npm run smoke:codex:adapter`
- `HOLP_REAL_CODEX_SMOKE=1 npm run smoke:codex`
- New Codex surface smoke command with opt-in env, for ACP and direct. If local
  `codex-acp`, `tmux`, Codex auth, or quota is unavailable, print SKIP or
  INCONCLUSIVE with reason; do not claim ready.

## Agent Workflow

- Architect: Claude Opus 4.8 via `drive-claude`, `--effort high`, read-only
  adversarial review before implementation. Fallback:
  Pioneer 100U -> Pioneer 50U -> official OAuth -> ZCode -> Kimi Code ->
  internal Codex subagent.
- Coder: Codex native leaf subagent; no subagents, no git. First reply must
  start with `CHECKPOINT:` and list planned touched files before editing.
- Tester: Kimi Code via `kimi -p --output-format text`; fallback ZCode, then
  internal Codex subagent. Kimi ACP is not the formal tester path.
- Internal Reviewer: Codex native leaf reviewer focused on surface honesty,
  no fallback-across-surfaces, owner scope, and test coverage.
- External Reviewer: Claude Opus 4.8 read-only deep review after implementation.
- Every PR comment / Merge Gate must include fallback ledger with planned chain,
  actual agent/model/provider/mode, fallback reason, evidence class, and whether
  the result is external.

## Stop Conditions

- No real or synthetic proof path exists for Codex ACP semantics and explicit
  ACP selection would be indistinguishable from headless fallback.
- Direct tmux owner scope cannot be proven without changing #47 ownership
  invariants.
- Direct tmux requires an interactive Codex prompt/approval flow that cannot be
  made non-interactive with explicit sandbox/approval settings.
- Coder believes `createAdapterRegistry`, `handleOrchestrateRun`,
  `parsePreferredRuntimeSurface`, `driveRun`, or `driveWorkflowRun` must change.
- Any P0/P1/P2 remains after fix loop.
- CI fails.

## Non-Goals

- Do not implement Claude Code parity (#49).
- Do not implement first-batch direct parity (#50) or ACP hardening (#51).
- Do not build cmux/Warp/terminal product UI.
- Do not claim #41 data sufficiency, #36 learned-active readiness, or real
  learned model readiness.
- Do not claim Codex `cmux-ready`.
