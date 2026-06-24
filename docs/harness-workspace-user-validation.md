# HOLP Harness Workspace User Validation Gate

This document is the Issue #76 validation record for the Issue #69 usable HOLP
Harness Workspace phase.

It is a gate record, not a new implementation. It decides whether HOLP Harness
Workspace is usable enough for future real multi-agent sessions to count as
real-usage training-distribution evidence for #41.

## Gate Decision

| Gate | Decision | Evidence |
| --- | --- | --- |
| Runtime-surface / public-wire gate | `allowed` | Reference-only: #52 recorded `terminal-consumer-integration-ready` and a complete bounded runtime-surface matrix in `docs/runtime-surface-validation-matrix.md`. |
| Usable UI real-usage data collection | `pending-user-validation` | No explicit human-authored real-use validation record has been captured for the #71-#75 Harness Workspace UI stack. Automated smoke and Commander-run demos are not enough. |
| cmux product readiness | `cmux-pending-user-validation` | Reference-only: #52 remains the canonical source for the current cmux product-readiness marker. #76 has not recorded a human cmux acceptance transcript. |
| Learned-router real-usage data for #41 | `blocked` | #41 may rely on the #52 runtime-surface/public-wire gate, but future data cannot be counted as real-usage training-distribution evidence until this document records `usable-ui-real-usage-data-collection: allowed`. |

The #52 runtime-surface/public-wire `allowed` decision remains valid. It is a
necessary but not sufficient condition for #41 real-usage dataset sufficiency.

## Current Rationale

#71 through #75 implemented the usable UI substrate:

- public-wire Sidecar state and render model;
- Focus Shell and Sidecar rendering;
- Inspect(agent), Evidence, and Failure UX;
- cmux Team Layout planning/integration;
- replay, session continuity, logs, and safe operator affordances.

Those PRs make the Harness Workspace inspectable and script-verifiable. They do
not prove that a human operator has used it for real multi-agent work in cmux and
accepted the experience as good enough to generate training-distribution data.

Until that human validation exists:

- smoke/script runs remain supporting evidence only;
- `cmux-ready` remains false / pending user validation;
- #42/#43 may still build plumbing, but their smoke/script outputs must carry a
  real-usage caveat;
- #41 real-usage data sufficiency remains blocked.

## Real-Use Scenario Checklist

State vocabulary:

- `not_run`: no human validation record yet.
- `passed`: human operator accepted the scenario.
- `blocked`: human operator could not complete the scenario.
- `degraded`: scenario was usable with caveats.
- `skipped`: intentionally not tested, with reason.

Severity vocabulary:

- `P0`: unusable or unsafe; blocks the whole gate.
- `P1`: major workflow failure; blocks `allowed`.
- `P2`: meaningful usability or evidence gap; blocks `allowed` unless explicitly waived by the human operator with rationale.
- `P3`: polish or clarity issue; does not block if recorded.
- `none`: no blocker.

| Scenario | Evidence required | Current status | Severity | Notes |
| --- | --- | --- | --- | --- |
| Focus Shell controller interaction | Human uses a native Controller Agent CLI in cmux while HOLP Sidecar remains visible and understandable. | `not_run` | `P0` | No human record yet. |
| Inspect(agent) drill-down | Human selects or inspects an agent and confirms evidence/failure context is understandable without raw-log spelunking. | `not_run` | `P0` | No human record yet. |
| cmux Team Layout | Human expands or observes real cmux panes/surfaces and confirms panes are additive, non-disruptive, and not fake TUI panes. | `not_run` | `P0` | No human record yet. |
| Replay and logs | Human reviews a completed run with replay/timeline/log context and can understand what happened. | `not_run` | `P0` | No human record yet. |
| Operator affordance comprehension | Human understands copy/open/replay/cancel/interrupt/continue/rerun affordance states and which ones are disabled or confirmation-only. | `not_run` | `P0` | No human record yet. |
| Failure diagnosis | Human can diagnose a failed/degraded run from Sidecar/Inspect/Evidence without treating raw logs as the primary UI. | `not_run` | `P0` | No human record yet. |
| Session continuity | Human can tell whether a worker session is replay-only, attachable, or continuation-capable, and why. | `not_run` | `P0` | No human record yet. |
| zh-CN / en-US text sanity | Human confirms localized human text is readable while protocol fields, commands, paths, and IDs remain untranslated. | `not_run` | `P0` | No human record yet. |

Because every required real-use scenario is currently `not_run`, the gate cannot
be `allowed`.

## Human Validation Record Template

When the user performs real validation, append one record per scenario:

```markdown
### Validation Record - <YYYY-MM-DD> - <scenario>

- Human operator:
- cmux version:
- HOLP commit:
- Controller agent:
- Worker agent:
- Runtime surface:
- Command / attach / pane evidence:
- Result: passed | blocked | degraded | skipped
- Severity: P0 | P1 | P2 | P3 | none
- Notes:
- Follow-up owner:
```

Only records authored or explicitly confirmed by the human operator may move
`usable-ui-real-usage-data-collection` to `allowed`.

## Automated Evidence Context

The following evidence is useful context but does not satisfy the human gate by
itself:

- #52 `terminal-consumer-integration-ready`;
- #63/#65 visible/attachable worker smokes;
- #71-#75 local tests and demos;
- Commander-run cmux automation;
- `npm run harness:workspace` and `npm run harness:workspace:cmux-layout`.

Automated evidence can help diagnose blockers during validation. It cannot
replace human acceptance.

## Local Consistency Checks

Before changing this record, run the docs-safe checks from the #76 spec:

- `git diff --check`;
- grep/readability checks that `cmux-ready` is not claimed as achieved;
- confirm #52 runtime-surface/public-wire `allowed` remains a reference-only
  prerequisite, not a reversal target;
- confirm `usable-ui-real-usage-data-collection` stays
  `pending-user-validation` unless a human validation record exists;
- confirm `learned-router-real-usage-data-for-#41` stays `blocked` while this
  document has no human `passed` records.

## Downstream Rules

- #42 and #43 may continue as plumbing, but their data must be labeled
  smoke/script/plumbing unless this gate later becomes `allowed`.
- #41 may not count future Harness Workspace sessions as real-usage
  training-distribution evidence while this gate is `pending-user-validation` or
  `blocked`.
- #44 remains downstream of #41 and must not bind a model artifact to data whose
  provenance #41 has not accepted.
- #36 remains blocked on #41, #44, real learned-model backing, active/canary
  smoke, and L2 learned-active readiness.

## Current Final State

```text
runtime-surface-public-wire-gate: allowed
usable-ui-real-usage-data-collection: pending-user-validation
cmux-product-readiness: cmux-pending-user-validation
learned-router-real-usage-data-for-#41: blocked
```
