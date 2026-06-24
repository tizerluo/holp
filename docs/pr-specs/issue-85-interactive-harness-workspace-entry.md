# Issue #85 - Interactive HOLP Harness Workspace Entry

## Summary

This PR fixes the #76 human validation blocker: HOLP Harness Workspace has
static Focus Shell / Inspect / Replay renders, cmux Team Layout panes, and
scripted visible-chain smokes, but no operator-facing interactive entry where a
human can use a native Controller Agent CLI through HOLP.

The goal is to add an opt-in cmux launcher that creates a real interactive
Controller CLI terminal plus honest HOLP Sidecar / Evidence / Replay panes. This
PR must not claim `cmux-ready`, #41 data sufficiency, or #36 learned readiness.

## Current Failure

Human validation on 2026-06-25 ran the available UI/smoke entry points and
still could not find a UI for direct interaction with a Controller Agent CLI.

The failure is not that smoke coverage is missing. The failure is that the
operator entry is missing:

- `npm run harness:workspace` renders a snapshot.
- `--mode inspect` renders a snapshot.
- `--mode replay` renders a snapshot.
- `harness:workspace:cmux-layout` creates real panes, but not a usable
  interactive workspace.
- `smoke:visible-agent-chain` proves scripted Controller -> HOLP -> Worker, not
  human-operated interaction.

## Key Changes

- Add `npm run harness:workspace:interactive`.
- Default mode is no-mutation / degraded preview. cmux mutation requires
  `HOLP_HARNESS_WORKSPACE_INTERACTIVE=1` and an explicit or caller-provided
  workspace.
- Create a real Controller terminal pane for `codex` by default and `kimi-code`
  as the second supported controller. In the current cmux CLI, `new-pane` cannot
  auto-run a command inside an existing workspace, so v1 must show the exact
  interactive REPL command the operator should type and mark automatic launch as
  `controller_manual_start_required`.
- Create HOLP Sidecar / Evidence / Replay panes that explain the current
  controller/workspace state and clearly mark real-human-run live follow as
  degraded until HOLP has a run-discovery / run-attach API.
- Surface worker expectation as explicit `direct_user_session`; missing direct
  evidence must not be presented as a synthesized headless fallback.
- Preserve cmux safety: scoped workspace, additive layout, no close/move/focus
  stealing, and `--focus false` on supported creation commands.
- Update `docs/harness-workspace-user-validation.md` to record the discovered
  blocker. Do not mark the gate `allowed` in this PR.

## Implementation Constraints

- Put cmux-specific launcher/planner/executor code under
  `consumers/cmux-bridge/`.
- Reuse `consumers/harness-workspace/` state/render helpers for Sidecar,
  Inspect, Evidence, and Replay; do not import daemon internals.
- Controller panes must be real terminal panes created with supported cmux
  flags. Markdown panes, provider-spawned fake panes, and static command
  transcripts do not satisfy the requirement.
- The controller command must come from a controller-label allowlist:
  `codex` and `kimi-code`. Those labels map to interactive binaries `codex`
  and `kimi` respectively. Arbitrary `--command` values, and the headless
  transport `claude-code`, are rejected.
- Controller invocation instructions must be interactive REPL mode. One-shot /
  headless invocations are forbidden, including `codex exec`, `kimi -p`,
  `--output-format text`, stdin-disabled controller specs, or prompt commands
  that complete without user input.
- The launcher must emit clear degraded reasons for missing cmux socket,
  missing workspace, missing controller binary, missing auth, missing direct
  worker readiness, missing live-run attach support, manual controller start
  requirement, unsupported controller pane creation, or failed controller pane
  creation.
- The Sidecar evidence must include at minimum: controller, selected/expected
  worker, runtime surface expectation, current run id when known, worker session
  when known, attach command when known, latest event when known,
  terminal/gate/failure state when known, degraded reasons, and provenance.
- Do not add Go, Bubble Tea, Lip Gloss, Ink, or other UI runtime dependencies in
  this PR.
- Do not change HOLP public wire, protocol events, daemon runtime behavior, or
  data recording in this PR.

## Live Sidecar Ownership Decision

This PR chooses the human-driven controller model:

- The human operates the Controller CLI directly in the cmux terminal pane.
- The Controller, not the launcher, is expected to initiate any real HOLP run.
- The launcher must not secretly call `orchestrate.run` and present that as the
  human-operated run.

With the current public wire, a Sidecar can subscribe only after it knows a
specific `run_id`. There is no public run-discovery or controller-run attach API
today. Therefore, this PR must not claim live Sidecar follow for a human-driven
run unless the run id is explicitly known.

For this PR, the honest behavior is:

- show the interactive Controller pane;
- show Sidecar/Evidence/Replay panes in `waiting_for_run_id` /
  `live_follow_degraded` state;
- display exact next-step instructions and degraded reasons;
- support fixture/unit reducer tests for public-wire event projection without
  presenting them as proof of human-run live follow.

Future work must add a public run-discovery / run-attach surface before HOLP can
claim automatic live Sidecar follow for human-initiated Controller runs.

## Environment Gates

`HOLP_HARNESS_WORKSPACE_INTERACTIVE=1` is the only opt-in gate for this launcher.
It may reuse shared cmux command helpers, but it must not require
`HOLP_CMUX_TEAM_LAYOUT=1`. The default path without
`HOLP_HARNESS_WORKSPACE_INTERACTIVE=1` executes zero cmux mutations.

## GitNexus / Risk

Expected scope is `consumers/harness-workspace/`, `consumers/cmux-bridge/`,
`scripts/smoke/visible-agent-chain.ts`, docs, and tests.

Before product-code edits, run GitNexus impact for any touched existing symbol.
If Coder believes the PR requires changes to any of these symbols, stop and
return to Commander for impact review and Architect re-review:

- `DirectTmuxBackend`
- `driveRun`
- `driveWorkflowRun`
- `EventBus`
- `handleOrchestrateRun`
- runtime selection / registry resolution symbols

## Test Plan

Focused:

- `npm test -- tests/consumers/harness-workspace tests/consumers/cmux-bridge tests/smoke/visible-agent-chain.test.ts`
- New tests for the interactive launcher:
  - default mode executes no cmux mutation;
  - missing workspace degrades without guessing focused UI state;
  - missing controller binary degrades with a visible reason;
  - all cmux commands are allowlisted and scoped with `--workspace`;
  - create commands include `--focus false`;
  - Controller pane is a real `cmux new-pane --type terminal` entry with
    workspace scoping and `--focus false`;
  - controller labels `codex` / `kimi-code` map only to interactive startup
    instructions `codex` / `kimi`; arbitrary controller labels are rejected;
  - Controller instructions contain no one-shot flags such as `exec`, `-p`, or
    `--output-format text`;
  - expected `direct_user_session` evidence does not fallback or render as
    headless readiness;
  - Sidecar state clearly reports `waiting_for_run_id` /
    `live_follow_degraded` when no run id is known;
  - fixture-only reducer tests may update run id, worker session, attach
    command, terminal/gate/failure from synthetic events, but those tests must
    be labeled as projection logic, not live human-run evidence.

Opt-in real validation:

```bash
HOLP_HARNESS_WORKSPACE_INTERACTIVE=1 npm run harness:workspace:interactive
```

Human validation after merge must confirm:

- the Controller CLI pane is visible and interactive;
- the Sidecar clearly tells the operator to start `codex` or `kimi` manually in
  that pane when cmux cannot auto-run commands in an existing pane;
- HOLP Sidecar honestly reports whether it can follow the run or is waiting for
  a public run id / run-attach surface;
- worker direct session is visible / attachable when known, or the missing
  direct-run evidence is clearly degraded;
- Inspect, Evidence, and Replay explain the run;
- failures/degraded states are understandable without raw logs as primary UI.

Full gate:

- `npm run typecheck`
- `npm test`
- `git diff --check`
- `npx gitnexus detect-changes --repo holp`
- staged: `npx gitnexus detect-changes --repo holp --scope staged`

## Non-Goals

- Do not mark `usable-ui-real-usage-data-collection` as `allowed`.
- Do not claim `cmux-ready`.
- Do not claim #41 learned-router data sufficiency.
- Do not claim #36 real learned-model readiness.
- Do not replace native Controller CLI with a HOLP-rendered imitation.
- Do not build a full TUI framework or final visual polish layer.
- Do not use a launcher-owned `orchestrate.run` as proof that a human-operated
  Controller run has live Sidecar follow.
