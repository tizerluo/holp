# Issue #49 - Claude Code Headless / ACP-Bridge / Direct Runtime Surface Parity

## Summary

Issue #49 is the Claude Code runtime-surface parity PR inside the #45
multi-agent CLI runtime surface completion phase. It brings `native-claude`
into the bounded matrix without pretending Claude Code has native ACP.

This PR must preserve the existing Claude Code `-p --output-format json`
headless/reviewer path, keep ACP-like parity honestly unsupported, and wire a
HOLP-owned direct tmux path. It must not train/connect learned routing, claim
`cmux-ready`, implement a stream-json bridge, or change #41/#36 gates.

## Current Baseline

- `adapters/claude-code.ts` implements Claude Code through `claude -p` JSON
  output and read-only enforcement probing.
- `probeClaudeCode(...)` currently reports:
  - `headless` / `claude_code_print_json`;
  - `acp` / `claude_code_no_acp`;
  - `direct_user_session` / `direct_user_session_not_declared`.
- `createDefaultAdapterRegistry()` currently maps `"native-claude"` to a flat
  `createClaudeCodeBackendFactory()` headless factory.
- #47 provides reusable `DirectTmuxBackend` foundation.
- #48 proved the per-surface registry pattern for `mcp-codex`.

## Scope

### 1. Headless

Preserve Claude Code headless behavior:

- Runtime kind remains `claude_code_print_json`.
- The probe must still run a bounded capability check and read-only enforcement
  check before declaring `read_only_review` ready.
- Empty output, parse failure, auth/quota failure, write enforcement failure,
  process exit, or timeout must fail closed.
- Do not relax read-only attestation to make other surfaces ready.

### 2. ACP / ACP-like Bridge

Claude Code has no native ACP. #49 must **not** implement a stream-json bridge.
This PR's ACP-like outcome is deliberately settled as honest unsupported:

- `runtime_surface:"acp"` remains `surface_support:"unsupported"`.
- `runtime_kind` remains `claude_code_no_acp`.
- Reason remains `claude_no_native_acp`.
- Explicit `native-claude` `acp` registry selection must return `undefined`
  rather than the headless factory.
- No code, docs, or tests may call Claude Code native ACP ready.
- No bridge may be declared `supported`, `ready`, or
  `streaming_controlled` in this PR.

A future stream-json bridge must be a separate issue/PR with its own protocol,
terminal/final-signal, parse-error, process-exit, timeout, and fidelity tests.

### 3. Direct User Session

Wire Claude Code direct session through #47 foundation:

- Use HOLP-created throwaway tmux sessions in `holp-*` namespace.
- Do not attach existing user shells.
- Direct readiness requires `probeDirectTmux({ verifyCapabilities:true })` and
  a real Claude-in-tmux `HOLP_OK` round-trip under explicit opt-in smoke.
- Direct command form is pinned to a non-interactive one-shot:
  `claude -p <prompt> --output-format json --allowedTools <read-only list>`.
  Do not attach or keep a long-lived interactive Claude REPL.
- Direct `actual_fidelity` must be `one_shot`. It must not copy Codex's
  `streaming_controlled` fidelity.
- Default probe must not run real direct turns.
- Explicit `direct_user_session` registry selection must resolve to the direct
  backend and must not fall back to headless.
- `direct_user_session` becomes `surface_support:"supported"` with
  `coder_worktree` degraded by default, reason
  `claude_direct_smoke_not_enabled`, and missing
  `["env:HOLP_REAL_CLAUDE_SMOKE"]`.
- Direct `capability_bitmask` is populated only after smoke proof.
- Direct `read_only_review` stays degraded unless reviewer execution config is
  genuinely wired for direct.
- Missing binary/auth/quota/direct capability must degrade or reject honestly.

### 4. Smoke / Evidence

Add the smallest opt-in smoke command for Claude Code surfaces, or extend an
existing one:

- Default without env exits 0 with SKIP and runs no real smoke turns. This
  smoke command behavior is separate from `probeClaudeCode`'s existing default
  headless capability/read-only checks.
- Suggested env: `HOLP_REAL_CLAUDE_SMOKE=1`.
- Headless smoke records `claude --version`, auth/quota/read-only attestation
  outcome, and a machine-checkable marker.
- ACP/native-or-bridge smoke records `unsupported:claude_no_native_acp`; it does
  not run a fake bridge smoke.
- Direct smoke records tmux version, Claude version, session namespace, and
  `HOLP_OK` evidence.
- If OAuth/provider/quota prevents a surface smoke, report SKIP/INCONCLUSIVE
  with reason; do not claim ready.

### 5. Docs

Update:

- `docs/pr-specs/README.md`
- `docs/pr-specs/issue-45-multi-agent-cli-runtime-surface-completion.md`

The #45 matrix must say exactly what #49 proves. If ACP-like bridge is not
ready, it must remain unsupported/rejected/degraded, not blank and not native
ACP.

## Acceptance Criteria

- AC1: `native-claude` probe output includes honest `headless`, `acp`, and
  `direct_user_session` surface declarations.
- AC2: No code, docs, or tests call Claude Code native ACP ready.
- AC3: Explicit `native-claude` `acp` and `direct_user_session` selection never
  returns the headless factory.
- AC4: Default probe runs no real ACP/direct/direct-tmux turns.
- AC5: `headless` read-only reviewer readiness still depends on real
  read-only enforcement evidence.
- AC6: ACP-like surface remains honest unsupported in #49; no stream-json bridge
  is implemented or claimed ready.
- AC7: Direct readiness, if present, requires HOLP-owned tmux capability proof
  plus `HOLP_OK`; no existing shell attach.
- AC8: Direct surface reports `actual_fidelity:"one_shot"` and never
  `streaming_controlled` in #49.
- AC9: Smoke/docs record actual OAuth/provider/quota constraints.

## Risk / GitNexus

Run impact before product edits:

- `probeClaudeCode`: expected HIGH/MEDIUM depending current index.
- `createClaudeCodeBackendFactory`: HIGH if registry/runtime execution paths are
  affected.
- `createDefaultAdapterRegistry`: HIGH; only make per-surface wiring changes
  needed for `native-claude`.
- `DirectTmuxBackend` / `createDirectTmuxBackendFactory`: avoid changing if
  possible; if changed, run impact and treat HIGH seriously.
- Do not change `createAdapterRegistry` semantics unless blocked and re-review
  Architect first.

Before commit:

- `npx gitnexus detect-changes --repo holp`
- after staging: `npx gitnexus detect-changes --repo holp --scope staged`

## Test Plan

Focused:

- `npm test -- adapters/claude-code.test.ts adapters/direct-tmux.test.ts adapters/registry.test.ts daemon/handlers/flock_probe.test.ts daemon/handlers/m1b_contract.test.ts`
- Add/update tests for:
  - no native ACP ready claim;
  - explicit ACP/direct selection not falling back to headless;
  - default probe keeps ACP/direct degraded/rejected without real turns;
  - read-only review remains gated by enforcement;
  - ACP remains unsupported and no bridge is declared supported/ready;
  - direct channel namespace/capability/readiness and `read_only_review`
    boundary.
  - direct surface fidelity is `one_shot`, not `streaming_controlled`.

Opt-in smoke:

- `npm run smoke:claude:surfaces`
- `HOLP_REAL_CLAUDE_SMOKE=1 npm run smoke:claude:surfaces`

Full gate:

- `npm run typecheck`
- `npm test`
- `npm run demo:m5`
- `git diff --check`
- GitNexus detect as above

## Agent Workflow

- Architect: Claude Opus preferred, fallback per #45:
  Pioneer 100U -> Pioneer 50U -> official OAuth -> ZCode -> Kimi Code ->
  internal Codex. Claude uses high effort.
- Coder: leaf implementation agent; no git, no subagents.
- Tester: Kimi Code CLI conservative path; fallback ZCode -> internal.
- Internal Reviewer: Codex native leaf reviewer.
- External Deep Reviewer: same external fallback chain as Architect.
- All reports go to PR comments after PR creation.

## Stop Conditions

- Stop if implementation would label Claude Code as native ACP ready.
- Stop if implementation would add a Claude stream-json bridge in #49.
- Stop if explicit ACP/direct selection silently falls back to headless.
- Stop if direct session requires attaching an existing user shell.
- Stop if any surface declares `streaming_controlled` without a recorded real
  stream-json chunk plus bounded terminal/final signal.
- Stop if default probe runs real ACP or direct/tmux turns.
- Stop if injected smoke runners are used as live readiness evidence outside
  unit tests.
- Stop if #45 matrix records Claude direct/headless `ready` without real
  `HOLP_OK` pane capture or read-only denial capture evidence.
- Stop if bridge semantics require broad `AgentBackend` or `AdapterRegistry`
  redesign beyond a local factory/adapter shape.
- Stop if no truthful readiness/degraded/rejected state can be represented.

## Assumptions

- Claude Code provider/OAuth/quota constraints are evidence, not failures to
  hide.
- `probeClaudeCode` currently runs real headless capability/read-only
  enforcement checks on the default path. #49 preserves this behavior and
  documents the cost: provider quota/rate-limit/auth failures degrade or reject
  honestly and must never be hidden as ready.
- `createDefaultAdapterRegistry` passes no smoke runners for `native-claude`;
  live direct readiness depends on real opt-in smoke, not injected unit-test
  helpers.
- Claude Code stream-json bridge is future work, not part of #49.
- #50/#51 first-batch parity, #54 terminal consumer smoke, #52 final matrix,
  #41 learned-router data sufficiency, and #36 real learned model readiness
  remain out of scope.
