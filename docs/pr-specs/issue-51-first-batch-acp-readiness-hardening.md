# Issue #51 - First-Batch ACP Readiness Hardening

## Summary

Issue #51 is the first-batch ACP/native-or-bridge readiness PR for the #45
multi-agent CLI runtime surface completion phase.

This PR must harden ACP readiness for Cursor Agent, Kimi Code, OpenCode, Pi,
and Reasonix using real ACP protocol evidence. It may adjust first-batch ACP
definitions, probe behavior, and smoke output so each target has an honest
state, command, version/auth context, and failure reason. Readiness must come
from matching ACP `initialize` + session creation + prompt/update terminal
evidence; headless or direct-session success must never count as ACP ready.

This PR does not touch Codex or Claude Code ACP work; those were handled by
#48 and #49. It also does not change first-batch direct-session parity from
#50, implement terminal-consumer smoke, claim `cmux-ready`, or unblock #41 data
sufficiency.

## Current Baseline

- #50 wired first-batch direct-session declarations and direct-only smoke.
  Direct readiness is now gated by `HOLP_REAL_HARNESS_DIRECT_SMOKE=1` and is
  out of scope for #51 except for avoiding regressions.
- `FIRST_BATCH_HARNESSES` declares ACP commands for all five first-batch
  transports, but current definitions are too generic:
  - OpenCode headless should pin a model for the combined #51 smoke; otherwise
    headless can degrade for a known self-inflicted command-shape reason.
  - OpenCode should use `opencode acp --pure`.
  - Reasonix should use `reasonix acp --model deepseek-flash`.
  - Reasonix headless should pin a model for the combined #51 smoke if local
    CLI reality requires it.
  - Reasonix ACP `session/new` must not be forced through the same params
    shape as Kimi/OpenCode/Pi. The driver skill says Reasonix should send `cwd`
    only and must not send `mcpServers: []`.
  - Cursor Agent ACP may require an auth step or a named bridge path before
    `session/new`; if local reality cannot prove it, it must stay degraded with
    a specific reason.
- `AcpClient` already fails pending requests on process exit, malformed JSON,
  request timeout, terminal timeout, and disposal. #51 should preserve those
  fail-closed properties and add tests around first-batch readiness behavior.
- `scripts/smoke/harnesses.ts` currently owns the first-batch combined
  headless/ACP smoke and ACP schedulability check. It remains #51's smoke
  entrypoint.

## Scope

### 1. Per-Agent ACP Definitions

Update first-batch ACP declarations so every target has an explicit command and
protocol/session shape grounded in local driver skills:

- Cursor Agent:
  - command path: official `cursor-agent acp` or an explicitly named bridge
    such as `cursor-agent-acp` if the official path cannot create sessions
    without an auth handshake.
  - If an auth method is required, implement a minimal explicit ACP auth step
    only if it can be proven from protocol JSON. Otherwise keep Cursor ACP
    degraded with a reason such as `cursor_acp_auth_required`.
  - Do not count `cursor-agent -p` headless output as ACP readiness.
- Kimi Code:
  - command: `kimi acp`
  - `session/new` params include `cwd` and `mcpServers: []`.
  - Terminal proof must aggregate `agent_message_chunk` / compatible ACP update
    text and verify `HOLP_OK`.
- OpenCode:
  - command: `opencode acp --pure`
  - `session/new` params include `cwd` and `mcpServers: []`.
  - Terminal proof must come from JSON-RPC ACP updates or terminal
    `session/prompt` result, not plugin startup prose.
- Pi:
  - command: `pi-acp`
  - `session/new` params include `cwd` and `mcpServers: []`.
  - Terminal proof must come from ACP JSON frames.
- Reasonix:
  - command: `reasonix acp --model deepseek-flash`
  - `session/new` params must send `cwd` only. Do not send `mcpServers: []` for
    Reasonix in either readiness probes or degraded-reason probes.
  - Reasonix ACP is not certified as ready in #51. Even if a local smoke
    observes `session/new`, prompt terminal, and `HOLP_OK`, #51 records that as
    degraded with an explicit reason such as
    `reasonix_acp_observed_ok_but_not_certified_this_pr`; certification remains
    downstream. A partial `initialize` pass is not ready.

All ACP definitions must remain JSON-serializable and must not require global
provider mutation. Environment variables may be read from the current process
only; do not write credentials or switch global providers.

### 1b. Combined Smoke Headless Command Corrections

#51 owns the combined first-batch headless+ACP smoke report, so it may fix
known self-inflicted first-batch headless command-shape problems when they would
otherwise make the smoke matrix misleading.

At minimum:

- OpenCode headless should pin an explicit model for `opencode run`.
- Reasonix headless should pin `--model deepseek-flash` or another documented
  working model if local CLI reality requires it.

These corrections are allowed only to make #51's report honest. They do not
expand #51 into a separate headless-parity PR, and headless success still cannot
prove ACP readiness.

### 2. ACP Client / Protocol Hardening

Prefer localized optional protocol parameters over changing generic
`AcpClient` behavior. If `AcpClient` changes are needed, keep them additive and
small, such as:

- optional `sessionNewParams` / `buildSessionNewParams` for per-agent
  `session/new` payloads;
- optional explicit authentication request only when a definition opts in;
- stricter missing-terminal / empty-output fail-closed checks;
- tests proving process exit, malformed JSON, missing terminal, timeout,
  cancel, and late update do not produce false readiness.

Any session-param addition must default to the current frame shape:
`{ cwd, mcpServers: [] }`. Existing callers that do not opt in to a custom
shape, including Codex ACP, Kimi, OpenCode, and Pi, must emit byte-equivalent
`session/new` params. Reasonix is the explicit exception and must opt in to
`{ cwd }`.

Do not introduce a broad SDK, a second runtime abstraction, or a headless
fallback inside ACP. Explicit `preferred_runtime_surface:"acp"` must either
resolve a ready ACP backend or fail/degrade; it must never run headless.

### 3. Readiness and Governance Evidence

ACP `ready` requires all of:

- target binary or bridge is present and version/auth context is recorded where
  available;
- `initialize` succeeds;
- session create/new succeeds with the target's real ACP params shape;
- prompt/update path returns an explicit terminal/final signal;
- terminal output contains `HOLP_OK`;
- empty output, auth prompt, prose-only output, process exit, parse error,
  request timeout, missing terminal, terminal timeout, cancel, or late update
  remains fail-closed;
- `flock.discover` / `flock.declare` reports the matching ACP surface as ready
  only from ACP evidence.

When not ready, reasons must distinguish at least:

- smoke not enabled;
- missing binary or bridge;
- auth required or missing;
- `initialize` failed;
- `session/new` failed;
- prompt terminal missing;
- output missing `HOLP_OK`;
- timeout;
- malformed JSON / parse error;
- provider quota or model unavailable.

The ACP smoke/probe path must return structured readiness results for all five
transports, not a boolean plus a single conflated
`acp_smoke_not_enabled_or_failed` reason. The result must distinguish "smoke
not enabled" from "smoke enabled and failed" so a present binary with a failed
ACP probe is reported as degraded with a useful reason, not rejected as absent.

Cursor Agent ACP must report `cursor_acp_auth_required` or an equivalently
specific auth reason when the ACP server returns an authentication-required
error. Cursor ACP readiness may depend on `CURSOR_API_KEY` being present in the
smoke process environment, but HOLP must not write that key or pass it on a CLI
flag.

Reasonix must expose its degraded reason, especially whether failure happened
at `session/new` or after session creation. It must not be marked ready from
`initialize` alone, and in #51 it remains degraded even when observed terminal
proof exists.

### 4. Smoke / Validation Command

Keep `npm run smoke:harnesses` as the #51 first-batch headless+ACP smoke:

- default without `HOLP_REAL_HARNESS_SMOKE=1` exits 0 with SKIP and runs no real
  provider turns;
- opt-in env: `HOLP_REAL_HARNESS_SMOKE=1`;
- prints one row per first-batch transport with ACP state, headless state,
  version/auth context when available, and reason;
- proves at least one non-Reasonix first-batch ACP path is ready and
  dispatchable through `orchestrate.run` with
  `preferred_runtime_surface:"acp"` when local tools/auth permit;
- prints Reasonix's ACP degraded reason;
- runs real provider turns from a HOLP-created throwaway cwd, not the live repo
  checkout, and does not depend on #50 direct smoke.

If this local machine cannot produce at least one non-Reasonix ACP-ready path
under opt-in smoke, stop and report. Do not open a ready PR that only documents
degraded ACP paths for all first-batch agents.

### 5. Documentation

Update:

- `docs/pr-specs/README.md`
- `docs/pr-specs/issue-45-multi-agent-cli-runtime-surface-completion.md`

The #45 matrix must say what #51 proves for each first-batch ACP surface. If
local auth or tool availability prevents a real ready smoke, record
degraded/rejected/unsupported honestly rather than implying ready.

## Acceptance Criteria

- AC1: Cursor Agent, Kimi Code, OpenCode, Pi, and Reasonix each have an
  explicit ACP/native-or-bridge state and evidence/refusal reason.
- AC2: OpenCode uses `opencode acp --pure`; Pi uses `pi-acp`; Kimi uses
  `kimi acp`; Reasonix uses `reasonix acp --model deepseek-flash` unless local
  CLI reality proves a different pinned ACP command is required.
- AC3: Per-agent ACP session creation params match real protocol behavior;
  Reasonix is not forced through an incompatible `mcpServers: []` path.
- AC4: ACP `ready` requires JSON-RPC ACP terminal/final evidence containing
  `HOLP_OK`; prose scraping and headless/direct output do not count.
- AC5: Explicit ACP selection never falls back to headless or direct.
- AC6: Process exit, malformed JSON, missing terminal, timeout, cancel, and
  late-update paths fail closed and do not emit false readiness.
- AC7: At least one non-Reasonix first-batch ACP path is ready and schedulable
  in real opt-in smoke on the local machine before this PR is marked ready.
- AC8: Reasonix ACP remains degraded in #51; the degraded reason names the
  failing stage or states that terminal proof was observed but not certified
  for readiness in this PR.
- AC9: #51 does not change Codex/Claude ACP surfaces, first-batch direct
  readiness, terminal-consumer smoke, #41, #44, or #36 gates.
- AC10: Default ACP `session/new` frames remain `{ cwd, mcpServers: [] }` for
  existing non-Reasonix callers; Reasonix explicitly opts into `{ cwd }`.
- AC11: #51 fixes known self-inflicted combined-smoke headless command-shape
  issues for first-batch agents, but headless success still cannot prove ACP
  readiness.

## GitNexus / Risk

Current baseline: `main@e0ecae5`.

Observed impact before spec freeze:

- `AcpClient`: CRITICAL. Impacted by reviewer execution, smoke scripts, and ACP
  backend factories. Avoid broad behavior changes; if an implementation needs
  more than additive optional params/strict tests, stop for Architect re-review.
  Any `session/new` parameterization must preserve the default
  `{ cwd, mcpServers: [] }` frame for existing callers.
- `createDefaultAdapterRegistry`: HIGH. Avoid changing generic registry
  semantics.
- `acpSmokeReady`: LOW.
- `probeFirstBatchHarness`: LOW.
- `reasonixAcpDegradedReason`: LOW.
- `acpSelectionSchedulable`: LOW.

Expected product/test touchpoints:

- `adapters/acp-client.ts`
- `adapters/first-batch-harnesses.ts`
- `scripts/smoke/harnesses.ts`
- `adapters/acp-client.test.ts`
- `adapters/registry.test.ts`
- `daemon/handlers/m1b_contract.test.ts`
- `daemon/handlers/flock_probe.test.ts`
- `docs/pr-specs/README.md`
- `docs/pr-specs/issue-45-multi-agent-cli-runtime-surface-completion.md`
- `package.json` only if the smoke script entry changes.

If Coder believes `handleOrchestrateRun`, `driveRun`, `driveWorkflowRun`,
`DirectTmuxBackend`, or registry fallback semantics must change, stop and
return to Commander for Architect re-review. #51 should reuse existing explicit
runtime-surface selection semantics.

## Test Plan

Focused:

- `npm test -- adapters/acp-client.test.ts adapters/registry.test.ts daemon/handlers/m1b_contract.test.ts daemon/handlers/flock_probe.test.ts`
- Cover all five first-batch ACP declarations and reasons.
- Cover default ACP degraded/not-ready without real smoke.
- Cover structured ACP failure reasons for smoke disabled, auth required,
  initialize failure, session/new failure, prompt terminal missing, timeout,
  malformed JSON, and missing `HOLP_OK`.
- Cover real-smoke opt-in path can make a non-Reasonix ACP surface ready.
- Cover explicit ACP selection does not fallback headless or direct.
- Cover Reasonix `session/new` frame omits `mcpServers`, Reasonix degraded
  reasons, and no ready from initialize alone or observed-but-uncertified
  terminal proof.
- Cover Kimi/OpenCode/Pi content/update aggregation and terminal `HOLP_OK`
  proof.
- Cover process exit, malformed JSON, missing terminal, timeout, cancel, and
  late-update fail-closed behavior.
- Cover default `AcpClient` `session/new` params remain `{ cwd, mcpServers: [] }`
  for non-Reasonix definitions.
- Cover `createDefaultAdapterRegistry()` resolves first-batch ACP factories for
  all five transports without proving readiness.
- Cover OpenCode ACP command uses `--pure`.
- Cover first-batch combined smoke uses a HOLP-owned throwaway cwd for real
  provider turns.
- Cover smoke script default SKIP.

Runtime smoke:

- `npm run smoke:harnesses`
- `HOLP_REAL_HARNESS_SMOKE=1 npm run smoke:harnesses`

Full gate:

- `npm run typecheck`
- `npm test`
- `npm run demo:m5`
- `git diff --check`
- `npx gitnexus detect-changes --repo holp`
- staged: `npx gitnexus detect-changes --repo holp --scope staged`

## Agent Workflow

- Architect: Claude Opus via `drive-claude`, adversarial plan/spec review
  before implementation. HOLP fallback: Pioneer 100U -> Pioneer 50U ->
  official OAuth -> ZCode -> Kimi Code -> internal Codex subagent. Use high
  reasoning effort for Claude unless re-review requires max.
- Coder: Codex native leaf subagent; no sub-subagents, no git, checkpoint a
  file/change plan before product edits. Must run GitNexus impact before
  editing product/test symbols.
- Tester: Kimi Code via conservative headless report path; fallback ZCode ->
  internal Codex subagent. Tester must report commands and exact pass/fail.
- Internal Reviewer: Codex native leaf reviewer, focusing on ACP readiness
  evidence, no headless/direct laundering, fail-closed terminal behavior, and
  tests.
- External Reviewer: Claude Opus read-only deep review; fallback per Architect
  chain. Static code review and Commander local/CI evidence must be separated.
- PR comments: Architect, Tester, Internal Reviewer, External Reviewer, and
  Merge Gate reports must be posted to the PR.
- After PR completion, Commander must inspect/clean live subagents before
  starting #54.

## Stop Conditions

- No non-Reasonix first-batch ACP path can be proven ready and schedulable by
  opt-in real smoke on this machine.
- ACP readiness depends on headless/direct output or prose scraping.
- Explicit ACP selection falls back to headless or direct.
- Reasonix is marked ready without real `session/new` and prompt terminal
  proof.
- `AcpClient` requires broad behavior changes rather than local optional
  protocol params and tests.
- Any P0/P1/P2 remains after review/fix loop.
- CI is not green.

## Assumptions

- #51 is a runtime-surface readiness PR, not a learned-router PR.
- #50 direct evidence remains valid and should not be redefined here.
- #54 terminal-consumer smoke and #52 user validation gate remain downstream.
- Merge is delegated to Commander once Merge Gate passes.
