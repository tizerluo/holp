# Issue #54 - Terminal Consumer Integration Smoke

## Summary

Issue #54 is the terminal-consumer smoke PR for the #45 multi-agent CLI runtime
surface completion phase. It proves that an external terminal-style consumer can
connect to HOLP through the public JSON-RPC/event wire, discover runtime
surfaces, start and observe a real run, exercise at least one control path, and
render the result without reading daemon internals.

This PR must not implement a cmux, Warp, or terminal-product UI adapter. It may
only claim `terminal-consumer-integration-ready`. `cmux-ready` remains blocked
until #52 records real cmux automation or explicit user validation.

## Current Baseline

- The reference consumer CLI already uses `DaemonClient` and `RunRenderer` to
  render event timelines, runtime matrices, gate reports, approval state, and
  artifacts from the stdio JSON-RPC daemon.
- The existing CLI scenarios are demo/reference flows. They primarily use
  `flock.declare` and fake/demo registries, so they do not by themselves prove a
  terminal-product integration smoke over `flock.discover` plus real #45-ready
  runtime surfaces.
- `npm run smoke:harnesses` now proves first-batch headless/ACP readiness. On
  this machine, the #51 merge evidence showed at least one non-Reasonix ACP path
  ready and schedulable, with Kimi Code, OpenCode, and Pi observed ready and
  Reasonix policy-degraded.
- #50 and #51 provide the runtime-surface evidence #54 may consume. #54 must not
  reclassify a surface as ready from a different surface's proof.

## Scope

### 1. Terminal Consumer Smoke Entrypoint

Add a reproducible smoke command, expected to be:

```bash
npm run smoke:terminal-consumer
```

Default behavior without the real-smoke opt-in must exit 0 with a clear SKIP,
for example:

```bash
SKIP HOLP_TERMINAL_CONSUMER_SMOKE=1 not set
```

Real opt-in behavior:

```bash
HOLP_TERMINAL_CONSUMER_SMOKE=1 \
HOLP_REAL_HARNESS_SMOKE=1 \
HOLP_TERMINAL_CONSUMER_TRANSPORT=kimi-code \
HOLP_TERMINAL_CONSUMER_SURFACE=acp \
npm run smoke:terminal-consumer
```

The script may choose a ready transport automatically only after
`flock.discover` returns matching-surface readiness evidence. If automatic
selection is implemented, it must prefer a locally ready non-Reasonix ACP path
from the #51 cohort and print which agent/runtime surface was selected.

The opt-in real path must launch the daemon from a HOLP-created throwaway cwd
such as a `mkdtemp` directory. Do not launch real provider probes from the live
repo checkout. The script may still point the daemon command to the repo's
`daemon/runtime/server.ts`; only the daemon process cwd and provider run cwd
must be isolated.

### 2. Public Wire Only

The smoke must launch the HOLP daemon through its public stdio JSON-RPC
entrypoint and use only public methods/events:

- `initialize` with at least `approval`, `artifact_refs`, and `gate_report`
  capabilities where supported;
- `flock.discover` with `probe:true`;
- `events.subscribe`;
- `orchestrate.run`;
- one control method, preferably `task.cancel` for deterministic terminal
  control evidence, or `approval.resolve` if the scenario naturally requests
  approval;
- `artifact.get` and/or gate report rendering when the run emits references.

It must not inspect `ConnectionContext`, `RunRecord`, governance stores, adapter
internals, or private in-process test harness state to decide readiness.

The real-probe `flock.discover` call must use a timeout large enough for real
provider probes, at least 120 seconds. Prefer probing the selected transport
first rather than all first-batch transports in a single blocking call. If the
script also prints a broader matrix, it may use `probe:false` or a separately
bounded best-effort probe for non-selected transports.

### 3. Real Runtime Surface Exercise

The main success path must exercise at least one real #45-ready runtime surface
end to end. For the first implementation, the expected target is a first-batch
ACP-ready agent such as Kimi Code, OpenCode, or Pi:

- discovered agent id comes from `flock.discover`;
- `orchestrate.run.roles.coder.preferred_runtime_surface` must match the
  selected surface, such as `"acp"`;
- daemon registry must be the default real registry. Do not use a synthetic
  selection registry that maps an ACP selection to `createFakeBackendFactory()`
  or any fake backend;
- surface-match proof must come from the public event stream: the smoke must
  subscribe to the run and assert `run_started.payload.runtime.runtime_surface`
  equals the selected surface;
- provider-origin evidence must come from the public `flock.discover` result,
  such as a non-empty real version string and selected surface readiness from
  `runtime_surfaces[].isolation_profiles[...]`;
- explicit ACP/direct selection failure must fail the smoke. It must not
  fallback to headless and still claim success;
- output must record selected transport, agent id, runtime surface, tool/version
  or auth/degraded reason where available, run id, event count, terminal event,
  gate report status, and any artifact refs rendered.

If this machine cannot produce a real ready runtime surface under opt-in smoke,
the PR must stop and report. Do not mark #54 ready with fake-only evidence.

### 4. Terminal-Consumer State Report

The smoke output must include enough consumer-visible state for a terminal
product to implement a first integration:

- runtime/session matrix rows from `flock.discover`;
- selected agent/runtime surface and the matching readiness evidence;
- run timeline from `events.subscribe`;
- terminal state (`run_merged`, `run_blocked`, `run_cancelled`, or
  `run_gave_up`);
- gate report summary when negotiated and emitted;
- artifact references/content summaries when emitted;
- explicit degraded/rejected/fail-closed reasons discovered for at least one
  non-selected or failure path, when available.

The final success marker must be:

```text
PASS terminal-consumer-integration-ready
```

If real cmux automation is not run, the output must also include:

```text
INFO cmux_status=cmux-pending-user-validation
```

It must not print `cmux-ready` unless a real cmux-side automation or explicit
user validation path has been added and passed.

### 5. Failure / Control Path Evidence

The smoke must prove at least one consumer-visible failure or control path
without relying on private state. Acceptable evidence includes:

- a deterministic public-wire control path where the consumer sends
  `task.cancel` and observes a terminal event. The terminal may be
  `run_cancelled`, `run_gave_up`, or a successful terminal if the provider wins
  the race first; the proof is that control was sent and the consumer observed
  the final state through public events;
- discovery/probe matrix includes a degraded/rejected surface with explicit
  reason, such as a missing-binary row, `not_probed`, Cursor ACP auth
  required/timeout, or Reasonix policy-degraded;
- an approval reject/late resolve path if the selected scenario naturally
  requests approval.

The first implementation should prefer the least flaky option:

- send `task.cancel` after subscription and record the resulting public terminal
  event, without requiring cancel to beat a fast successful provider turn;
- use a fast deterministic degraded/reason row, such as `flock.discover` with
  `probe:false` returning `not_probed`, as the primary failure-path evidence;
- treat Cursor auth-required or Reasonix policy-degraded rows as useful
  best-effort extra evidence, not the only way to pass.

Do not wait for `approval_requested` on the single-coder ACP success path; that
path may never request approval. Approval control is optional unless the
selected scenario naturally emits an approval request.

### 6. Documentation Updates

Update:

- `docs/pr-specs/README.md`
- `docs/pr-specs/issue-45-multi-agent-cli-runtime-surface-completion.md`

The #45 master spec should record #54's new command and state that #52 consumes
its output for the final validation matrix. The documentation must preserve the
distinction between:

- `terminal-consumer-integration-ready`
- `cmux-pending-user-validation`
- `cmux-ready`

## GitNexus / Risk

Current index baseline: `main@2d19b38`.

Known impact before implementation:

- `DaemonClient`: MEDIUM, 5 upstream hits, affects the reference consumer CLI
  process. Prefer reuse over changing it.
- `RunRenderer`: LOW, 3 upstream hits, affects CLI rendering/tests. Additive
  helpers are acceptable if tests cover them.
- `runCli`: LOW, affects the reference CLI entrypoint and CLI tests. Prefer a
  separate smoke script over changing default CLI behavior.
- `buildDispatcher`: HIGH, 27 upstream hits across daemon runtime, handlers,
  tests, and smoke. This PR should not modify it. If Coder believes daemon
  dispatcher/runtime changes are required, stop and return to Architect review.

Before editing any indexed symbol, run `npx gitnexus impact <symbol> --repo
holp --direction upstream --include-tests` and report the blast radius. Before
commit, run `npx gitnexus detect-changes --repo holp`; after staging, run
`npx gitnexus detect-changes --repo holp --scope staged`.

## Acceptance Criteria

- AC1: `npm run smoke:terminal-consumer` exists and defaults to SKIP without
  `HOLP_TERMINAL_CONSUMER_SMOKE=1`.
- AC2: Opt-in real smoke uses public JSON-RPC/event wire only and includes
  `initialize`, `flock.discover`, `orchestrate.run`, `events.subscribe`, and at
  least one public control/degraded-path evidence item from section 5. Emitted
  artifact/gate retrieval should be rendered when present, but it does not
  replace the section 5 control/degraded-path requirement. The `flock.discover`
  real-probe call must have a timeout of at least 120 seconds or an explicitly
  bounded selected-transport probe.
- AC3: At least one real #45-ready runtime surface is exercised end to end under
  opt-in smoke before the PR is marked ready. Real proof requires the default
  registry, a public `run_started.payload.runtime.runtime_surface` match, and
  public `flock.discover` provider-origin evidence such as version/readiness.
- AC4: Runtime readiness is matching-surface only. ACP/direct smoke cannot
  fallback to headless and still pass. Fake backends, synthetic selection
  registries, or private `ctx.runs`/`RunRecord` reads cannot prove readiness.
- AC5: Smoke output contains runtime matrix, selected agent/surface, run id,
  timeline/event count, terminal state, gate/artifact summary when available,
  and at least one explicit degraded/rejected/fail-closed reason or deterministic
  control-path outcome.
- AC6: The smoke prints `PASS terminal-consumer-integration-ready` only when
  AC2-AC5 pass.
- AC7: The smoke prints `cmux-pending-user-validation` unless real cmux
  automation or user validation proves `cmux-ready`.
- AC8: #45 master spec and this README point #52 at the smoke command/output as
  the evidence source for the final validation matrix.

## Test Plan

Focused:

```bash
npm test -- tests/consumers/cli/index.test.ts tests/consumers/cli/renderer.test.ts
```

Add focused tests for any new exported helper or renderer behavior introduced
by the smoke. If the smoke script is structured as testable pure helpers plus a
small executable wrapper, cover:

- default SKIP without opt-in env;
- selected runtime surface must match the requested surface;
- selected runtime surface match must be read from the public `run_started`
  event, not from the request params or private run record;
- success marker cannot be emitted without a terminal event;
- `cmux-ready` cannot be emitted without explicit cmux validation input.

Smoke:

```bash
npm run smoke:terminal-consumer
HOLP_TERMINAL_CONSUMER_SMOKE=1 HOLP_REAL_HARNESS_SMOKE=1 npm run smoke:terminal-consumer
```

Gate:

```bash
npm run typecheck
npm test
npm run demo:cli
npm run demo:cli:inline
npm run demo:cli:degraded
npm run demo:m5
git diff --check
npx gitnexus detect-changes --repo holp
npx gitnexus detect-changes --repo holp --scope staged
```

## Agent Workflow

- Architect: Claude Opus via `drive-claude`, high effort. Fallback:
  Pioneer 100U -> Pioneer 50U -> official OAuth -> ZCode -> Kimi Code ->
  internal Codex subagent. Only fallback on quota/session/auth/rate-limit,
  process exit, missing/invalid final output, or explicit blocking condition.
- Coder: Codex native leaf subagent; do not spawn or delegate; do not touch git;
  first response must be `CHECKPOINT:` with planned touched files. Implement
  the real path as a new smoke script that reuses `DaemonClient`, `RunRenderer`,
  and renderer helpers where useful; do not reuse `runCli`'s approval-waiting
  flow for the single-coder ACP path.
- Tester: Kimi Code conservative path `kimi -p --output-format text`; fallback
  ZCode -> internal Codex subagent. Kimi ACP is not used as the formal tester
  path.
- Internal Reviewer: Codex native leaf reviewer focused on public-wire-only
  evidence, readiness truthfulness, cmux claim boundary, and smoke flakiness.
- External Reviewer: Claude Opus read-only review; static review and Commander
  test evidence must be reported separately.

PR comments must record Architect, Tester, Internal Reviewer, External Reviewer,
fallback ledger, local verification, CI, remaining P3, and Merge Gate.

## Non-Goals

- Do not implement a cmux, Warp, or terminal-product UI adapter.
- Do not claim `cmux-ready` without real cmux automation or user validation.
- Do not train or connect a learned model.
- Do not claim #41 learned-router data sufficiency; #52 owns the final phase
  gate.
- Do not claim #36 learned-active, canary, or L2 learned-active readiness.
