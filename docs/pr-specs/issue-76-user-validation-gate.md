# Issue #76 - User Validation Gate For Usable HOLP Harness Workspace

## Status

This is a documentation and validation-record PR. It changes no product code,
tests, protocol, runtime-surface readiness, data recording behavior, or
learned-model readiness.

This PR closes the #69 usable UI implementation phase by recording the current
human validation gate for HOLP Harness Workspace. It may honestly record
`pending-user-validation` or `blocked`; it must not claim `allowed` unless a
human operator has supplied an explicit real-use validation record.

## Gate Split

There are two different #41 gates:

1. **Runtime-surface / public-wire sufficiency**: owned by #45/#52 and already
   recorded as `allowed` in `docs/runtime-surface-validation-matrix.md`.
2. **Real-usage dataset sufficiency**: owned by #69/#76 inside #41's dataset
   quality scope. This gate decides whether future HOLP Harness Workspace runs
   may count as real-usage training-distribution evidence.

The first gate is necessary but not sufficient for the second. #76 must not
reverse #52, but it takes precedence when a document asks whether smoke/script
data can be counted as real-usage learned-router training data.

## Deliverables

- Add `docs/harness-workspace-user-validation.md` as the canonical #76 gate
  record.
- Update `docs/pr-specs/README.md` with the #76 spec link.
- Add a pointer note to `docs/runtime-surface-validation-matrix.md` explaining
  that #52's #41 `allowed` decision is runtime-surface/public-wire only.
- Update `docs/holp-blueprint.md` only to remove ambiguity around the new #69/#76
  real-usage UI gate.

## Validation Record Contract

`docs/harness-workspace-user-validation.md` must include:

- gate vocabulary:
  - `runtime-surface-public-wire-gate`: reference-only, sourced from #52;
  - `usable-ui-real-usage-data-collection`: `allowed | blocked | pending-user-validation`;
  - `cmux-product-readiness`: reference-only, sourced from the #52 cmux row;
  - `learned-router-real-usage-data-for-#41`: `allowed | blocked`.
- explicit current decision and rationale.
- real-use scenario checklist:
  - Focus Shell controller interaction;
  - Inspect(agent);
  - cmux Team Layout;
  - replay and logs;
  - operator affordance comprehension;
  - failure diagnosis;
  - session continuity;
  - zh-CN / en-US text sanity.
- evidence fields for each scenario:
  - date/time;
  - human operator;
  - cmux version;
  - HOLP commit;
  - controller agent;
  - worker agent;
  - runtime surface;
  - command, attach, or pane evidence;
  - result;
  - notes;
  - blocker severity and owner.
- severity vocabulary for UX blockers: `P0 | P1 | P2 | P3 | none`.

## Current Expected Outcome

Unless an explicit human validation record exists during this PR, the current
gate must be:

- `usable-ui-real-usage-data-collection: pending-user-validation`
- `learned-router-real-usage-data-for-#41: blocked`
- `cmux-product-readiness: cmux-pending-user-validation`

Automated smoke, Commander-run cmux automation, and scripted demo output may be
listed as supporting context, but they are not real-use validation and cannot
make the gate `allowed`.

## Acceptance Criteria

- AC1: the validation record distinguishes #52 runtime-surface/public-wire
  readiness from #76 real-usage UI validation.
- AC2: the validation record states an explicit current gate decision and
  rationale.
- AC3: every real-use scenario has a row with outcome, evidence requirement, and
  current status.
- AC4: the record cannot be read as claiming `cmux-ready`, #41 real-usage data
  sufficiency, #44 model artifact readiness, or #36 learned-active readiness
  without the required downstream evidence.
- AC5: `docs/runtime-surface-validation-matrix.md` keeps its #52 decision rows
  intact but points readers to #76 for real-usage dataset sufficiency.
- AC6: `docs/pr-specs/README.md` links this spec in the #69 usable UI phase.
- AC7: if no explicit human validation record exists, the final gate is
  `pending-user-validation` / blocked for #41 real-usage data.

## Validation

Local checks:

- `git diff --check`
- grep/readability checks that:
  - `cmux-ready` is not claimed;
  - #52 runtime-surface `allowed` is not reversed;
  - #41 real-usage data remains blocked unless a human validation record is
    present;
  - the #76 spec, README, runtime matrix pointer, and validation record agree.

This docs-only PR does not require `npm test` unless product code, protocol, or
generated docs are changed.

GitNexus:

- Run `npx gitnexus status` before editing.
- Run `npx gitnexus detect-changes --repo holp` before commit.
- Run `npx gitnexus detect-changes --repo holp --scope staged` after staging.

## Stop Conditions

- Stop if the PR would mark `usable-ui-real-usage-data-collection: allowed`
  without an explicit human-authored real-use validation record.
- Stop if Commander-run smoke or cmux automation is being used as the human
  acceptance record.
- Stop if reconciling #76 requires reversing #52's runtime-surface/public-wire
  gate decision instead of adding a scoped pointer.
- Stop if a reviewer finds an implied `cmux-ready`, #41 real-usage sufficiency,
  #44 readiness, or #36 readiness claim.

## Non-Goals

- Do not implement new UI features.
- Do not add scripts, tests, protocol fields, public wire events, daemon state,
  or runtime-surface readiness.
- Do not mutate #42/#43 data contracts.
- Do not train or connect a learned model.
- Do not claim #36 readiness.
