# Issue #69 - HOLP Harness Workspace Usable UI Before Real-Usage Data Sufficiency

## Status

This is a documentation and issue-planning spec. It changes no product code,
tests, protocol, runtime readiness, data recording behavior, or learned-model
readiness.

This spec does **not** reopen or reverse the #45/#52 runtime-surface gate.
`docs/runtime-surface-validation-matrix.md` remains valid:

- `terminal-consumer-integration-ready` is still achieved for the #52 public-wire
  terminal-consumer signal;
- `cmux-ready` is still false / `cmux-pending-user-validation`;
- #41 is still allowed at the runtime-surface level.

The new requirement lives inside #41's dataset-quality and training-distribution
scope: smoke/script data alone must not be treated as sufficient real-usage
training data. A usable HOLP Harness Workspace is a precondition for collecting
the real multi-agent usage sessions that #41 will later evaluate.

## Rationale

#66 defines a reference-consumer UX note for HOLP Harness Workspace, but it does
not implement a usable product surface and advances no gate. #63/#65 prove
visible-chain and observable worker substrates, while #52 proves public-wire
terminal-consumer integration.

Those signals are necessary, but not enough for learned-router training data.
Training data must come from real use: a human actually using HOLP to run
multi-agent work in cmux, with readable chain state, evidence, failures, replay,
and role context. A technically runnable MVP or smoke harness is not sufficient.

This phase creates the usable UI path needed before #41 can count future runs as
real-usage training-distribution evidence.

## Dependency Model

The dependency model is:

```text
#45/#52 runtime-surface + public-wire gate: already satisfied

Usable HOLP Harness Workspace UI
  -> real-usage sessions can be collected
  -> #41 can evaluate real-usage data sufficiency
  -> #44 can bind model artifact/attestation to that dataset
  -> #36 can later evaluate real learned-active readiness
```

#42 and #43 remain parallel plumbing. They are not blocked from implementation by
this UI phase, but their smoke/script outputs cannot by themselves satisfy #41's
real-usage data sufficiency. #42/#43 outputs should carry a real-usage caveat
until the #69 user validation gate records actual use.

## Usable UI Completion Standard

This phase is complete only when the UI is actually usable for real work, not
merely theoretically runnable.

The bar:

- native Agent CLIs remain visible and usable;
- the HOLP Sidecar is attractive, stable, readable, and interaction-good;
- Overview and Inspect(agent) are one shell with shared chrome and visual
  language;
- worker output, evidence, gate state, and failure explanations are understandable
  without raw-log spelunking;
- Team Layout uses real cmux panes when expanded, never fake panes inside one
  TUI;
- replay/session continuity/logs make real runs reviewable afterward;
- user validation confirms the experience is good enough for real multi-agent
  tasks;
- no visual polish is used as a substitute for readiness evidence.

## Child Issues

The #69 child issues run serially unless a later per-PR spec explicitly marks a
child as parallel-safe.

| Order | Issue | Purpose |
| --- | --- | --- |
| 1 | #70 - Harness Workspace implementation baseline and architecture spec | Consume #66 and define the implementation architecture without superseding the UX note. |
| 2 | #71 - Sidecar state and render model | Derive Overview/Inspect render state from HOLP public wire, not daemon internals. |
| 3 | #72 - Focus Shell and Sidecar TUI | Build the default usable Focus Shell with native Controller CLI plus polished Sidecar. |
| 4 | #73 - Inspect(agent), Evidence, and Failure UX | Add Inspect as a state of the same shell, with evidence and failure explanations. |
| 5 | #74 - cmux Team Layout integration | Expand into real cmux panes without stealing focus or faking panes in one TUI. |
| 6 | #75 - Replay, session continuity, logs, and operator affordances | Make real runs reviewable and add safe operator affordances. |
| 7 | #76 - User validation gate for usable HOLP Harness Workspace | Record whether real use is good enough for #41 to count future real-usage data. |

Each child issue must get its own per-PR spec from then-current `main`. Do not
pre-write detailed implementation specs here.

## Relationship To Existing Issues

- #66 remains a non-normative UX reference. It advances no gate by itself.
- #42 can still implement live stop-decision recording as plumbing, but the
  resulting data must be labeled appropriately until real-usage validation exists.
- #43 can still implement dataset manifest/export health as plumbing, but smoke
  datasets must not be the main evidence for #41 sufficiency.
- #41 owns the final real-usage data sufficiency decision.
- #44 remains downstream of #41 and should bind model artifact/attestation to a
  dataset whose provenance #41 accepted.
- #36 remains blocked on real learned-model backing and active readiness; nothing
  in this UI phase claims #36 readiness.

## Non-Goals

- Do not change HOLP public wire.
- Do not add protocol events or fields.
- Do not change runtime surface readiness.
- Do not claim `cmux-ready`.
- Do not reverse `terminal-consumer-integration-ready`.
- Do not train a model.
- Do not connect learned-active execution.
- Do not claim #36 readiness.
