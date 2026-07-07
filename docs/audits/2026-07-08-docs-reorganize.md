# HOLP Docs Reorganization Report

Date: 2026-07-08

Scope: docs-only reorganization. Only Markdown files were moved or edited, and
only new directories were created.

## Moves

| From | To | Reason |
| --- | --- | --- |
| `SKILL_USAGE_GAPS.md` | `docs/notes/SKILL_USAGE_GAPS.md` | Workflow/skill gap ledger, not a normative root spec. |
| `DOCS-AUDIT-SUMMARY.md` | `docs/audits/2026-07-08-docs-audit.md` | Prior docs audit report. |
| `docs/pr-specs/issue-105-extract-harness-workspace-to-holp-cmux.md` | `docs/pr-specs/completed/issue-105-extract-harness-workspace-to-holp-cmux.md` | Completed repo split; README P4 and git log #106/#107. |
| `docs/pr-specs/issue-11-agent-harness-isolation.md` | `docs/pr-specs/completed/issue-11-agent-harness-isolation.md` | v0.1.5 protocol baseline; README/pr-specs README. |
| `docs/pr-specs/issue-45-multi-agent-cli-runtime-surface-completion.md` | `docs/pr-specs/completed/issue-45-multi-agent-cli-runtime-surface-completion.md` | P3 runtime-surface parity complete; README P3 and #52 matrix. |
| `docs/pr-specs/issue-47-generalize-direct-tmux-cohort.md` | `docs/pr-specs/completed/issue-47-generalize-direct-tmux-cohort.md` | Direct tmux foundation shipped; git log #56 and #50 baseline. |
| `docs/pr-specs/issue-48-codex-runtime-surface-parity.md` | `docs/pr-specs/completed/issue-48-codex-runtime-surface-parity.md` | #48 shipped; pr-specs README current code facts and git log #57. |
| `docs/pr-specs/issue-49-claude-code-runtime-surface-parity.md` | `docs/pr-specs/completed/issue-49-claude-code-runtime-surface-parity.md` | #49 shipped; pr-specs README current code facts and git log #58. |
| `docs/pr-specs/issue-50-first-batch-direct-session-parity.md` | `docs/pr-specs/completed/issue-50-first-batch-direct-session-parity.md` | #50 shipped; pr-specs README and git log #59. |
| `docs/pr-specs/issue-51-first-batch-acp-readiness-hardening.md` | `docs/pr-specs/completed/issue-51-first-batch-acp-readiness-hardening.md` | #51 shipped; pr-specs README and git log #60. |
| `docs/pr-specs/issue-52-user-validation-matrix-gate.md` | `docs/pr-specs/completed/issue-52-user-validation-matrix-gate.md` | #52 validation matrix gate shipped. |
| `docs/pr-specs/issue-54-terminal-consumer-integration-smoke.md` | `docs/pr-specs/completed/issue-54-terminal-consumer-integration-smoke.md` | #54 terminal-consumer smoke shipped; git log #61. |
| `docs/pr-specs/issue-63-visible-agent-chain-cmux-validation.md` | `docs/pr-specs/completed/issue-63-visible-agent-chain-cmux-validation.md` | Visible-chain smoke shipped; git log #64. |
| `docs/pr-specs/issue-65-observable-attachable-worker-session.md` | `docs/pr-specs/completed/issue-65-observable-attachable-worker-session.md` | Attachable worker session shipped; git log #65. |
| `docs/pr-specs/pr1-m0-contract-surface.md` | `docs/pr-specs/completed/pr1-m0-contract-surface.md` | PR1 shipped; pr-specs README landed foundation list. |
| `docs/pr-specs/pr2-m1a-protocol-substrate.md` | `docs/pr-specs/completed/pr2-m1a-protocol-substrate.md` | PR2 shipped; pr-specs README landed foundation list. |
| `docs/pr-specs/pr3-m1b-fake-harness-cli.md` | `docs/pr-specs/completed/pr3-m1b-fake-harness-cli.md` | PR3 shipped; pr-specs README landed foundation list. |
| `docs/pr-specs/pr5-m3-first-real-adapter.md` | `docs/pr-specs/completed/pr5-m3-first-real-adapter.md` | PR5 shipped; README adapter status. |
| `docs/pr-specs/pr6-m4a-data-state-decision.md` | `docs/pr-specs/completed/pr6-m4a-data-state-decision.md` | PR6 shipped; README M4a checkbox. |
| `docs/pr-specs/pr7-m4b-consensus-gate-triage.md` | `docs/pr-specs/completed/pr7-m4b-consensus-gate-triage.md` | PR7 shipped; README M4b checkbox. |
| `docs/pr-specs/pr8-m5-consensus-demo.md` | `docs/pr-specs/completed/pr8-m5-consensus-demo.md` | PR8 shipped; README M5 checkbox. |
| `docs/pr-specs/pr9-m5b-real-reviewer-execution.md` | `docs/pr-specs/completed/pr9-m5b-real-reviewer-execution.md` | PR9 shipped; README M5b checkbox. |
| `docs/pr-specs/pr10-m6a-consumer-cli-experience.md` | `docs/pr-specs/completed/pr10-m6a-consumer-cli-experience.md` | PR10 shipped; README M6a checkbox. |
| `docs/pr-specs/pr11-m6b-second-real-provider.md` | `docs/pr-specs/completed/pr11-m6b-second-real-provider.md` | PR11 shipped; README M6b checkbox. |
| `docs/pr-specs/pr12-m6c-runtime-session-matrix.md` | `docs/pr-specs/completed/pr12-m6c-runtime-session-matrix.md` | PR12 M6c foundation shipped; README M6c checkbox. |
| `docs/pr-specs/pr13-m7-foundation-loop.md` | `docs/pr-specs/completed/pr13-m7-foundation-loop.md` | Re-audit correction: HEAD ancestor commits `6ac698e` (#30) and `a288e94` (#32) implement and harden M7; README's old unchecked M7 box was stale. |
| `docs/pr-specs/pr14-m8-real-runtime-surface-harness-pilot.md` | `docs/pr-specs/completed/pr14-m8-real-runtime-surface-harness-pilot.md` | Re-audit correction: HEAD ancestor commit `c72cc07` (#34) implements the M8 first real runtime surface harness pilot; README's old unchecked M8 box was stale. |
| `docs/pr-specs/pr15-m9-consumer-stable-gate-surface.md` | `docs/pr-specs/completed/pr15-m9-consumer-stable-gate-surface.md` | Re-audit correction: HEAD ancestor commit `958784f` (#35) implements the M9 stable gate surface; README's old unchecked M9 box was stale. |
| `docs/pr-specs/pr16-m10-m11-learned-router-dynamic-workflow.md` | `docs/pr-specs/completed/pr16-m10-m11-learned-router-dynamic-workflow.md` | Re-audit correction: HEAD ancestor commit `2caab2b` (#37) implements the M10/M11 safe-lane foundation; README's old unchecked M10/M11 boxes were stale. |

## PR Spec Status

| Spec | Status | Basis |
| --- | --- | --- |
| PR1 | completed | `docs/pr-specs/README.md` landed foundation list. |
| PR2 | completed | `docs/pr-specs/README.md` landed foundation list. |
| PR3 | completed | `docs/pr-specs/README.md` landed foundation list. |
| PR4 | completed, not moved | Shipped per landed foundation list, but non-Markdown code comments reference its old path. |
| PR5 | completed | Landed foundation list and README adapter status. |
| PR6 | completed | Landed foundation list and README M4a checkbox. |
| PR7 | completed | Landed foundation list and README M4b checkbox. |
| PR8 | completed | Landed foundation list and README M5 checkbox. |
| PR9 | completed | Landed foundation list and README M5b checkbox. |
| PR10 | completed | Landed next-stage list and README M6a checkbox. |
| PR11 | completed | Landed next-stage list and README M6b checkbox. |
| PR12 | completed | Landed next-stage list and README M6c checkbox. |
| PR13 | completed | Re-audit correction: `6ac698e` implements M7 foundation loop and `a288e94` hardens workflow contracts; HEAD contains `workPlanner`, `workflowEngine`, `trainingSamples`, and `m7_workflow.test.ts` coverage for the acceptance path. |
| PR14 | completed | Re-audit correction: `c72cc07` implements first-batch harness registry/probes, ACP thin client, direct tmux backend, runtime-surface selection, protocol/version updates, and opt-in smoke entrypoints. |
| PR15 | completed | Re-audit correction: `958784f` implements `GateReport.v1`, capability-gated `gate_report`, approval/override audit handling, protocol/version updates, and CLI renderer/tests. |
| PR16 | completed | Re-audit correction: `2caab2b` implements learned-router planner-only role support, replay/eval helpers, shadow/fail-closed active/canary audit, L1 bounded workflow, and L2 revision validator/reject/audit. This is the SPEC's safe-lane foundation, not real learned-model active readiness. |
| PR17 | open | README and roadmap list M12 as not started. |
| Issue #11 | completed | v0.1.5 protocol baseline in README/pr-specs README. |
| Issue #45 | completed | README P3 says #45 chain complete and #52 matrix is present. |
| Issue #47 | completed | git log #56 and later #50 baseline. |
| Issue #48 | completed | pr-specs README current facts and git log #57. |
| Issue #49 | completed | pr-specs README current facts and git log #58. |
| Issue #50 | completed | pr-specs README current facts and git log #59. |
| Issue #51 | completed | pr-specs README current facts and git log #60. |
| Issue #52 | completed | runtime surface validation matrix and README P3. |
| Issue #54 | completed | pr-specs README current facts and git log #61. |
| Issue #63 | completed | git log #64. |
| Issue #65 | completed | git log #65. |
| Issue #105 | completed | README P4 repo split note and git log #106/#107. |

## Uncertain

None for PR13-PR16 after re-audit. The earlier classification was wrong: I
treated the root `README.md` milestone checkboxes as authoritative even though
they were written before the later implementation commits, and I saw conflicting
`git log` evidence for PR14/PR16 but downgraded it instead of following the HEAD
ancestor history and code/tests. The corrected rule is that completed/open status
must be based on implementation commits plus HEAD code/spec acceptance evidence;
README milestone checkboxes are derived status and can drift.

PR17/M12 remains open because this re-audit found no HEAD ancestor implementation
commit for remote/distributed HOLP.

## Exceptions

- `docs/pr-specs/pr4-m2-contract-tests.md` stayed in `docs/pr-specs/`.
  `daemon/handlers/m2_contract.test.ts` contains non-Markdown references to the
  old path, and this docs-only pass cannot update code comments.
- `docs/audits/2026-07-08-docs-audit.md` intentionally preserves audit-time
  paths after moving. A note was added at the top per task instructions.

## Link Updates

- Updated 36 Markdown path/link references for moved specs and the skill-gap
  ledger.
- Updated `docs/pr-specs/README.md` links to use `./completed/...` for moved
  specs, including PR13-PR16 after re-audit correction.
- Updated `docs/2026-06-22-backlog-priority.md`,
  `docs/holp-blueprint.md`, and `docs/notes/SKILL_USAGE_GAPS.md` plain path
  references where they pointed at moved specs.
- Updated `AGENTS.md` to point the local skill-gap ledger at
  `docs/notes/SKILL_USAGE_GAPS.md`.
- Re-audit correction updated `README.md` and `docs/roadmap.md` so M7/M8/M9 and
  M10/M11 safe-lane foundation no longer show as not started.
