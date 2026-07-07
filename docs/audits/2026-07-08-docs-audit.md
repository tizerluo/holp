> 本审计中的文件路径为审计时点(2026-07-08 整理前)的路径。

# HOLP Docs Audit Summary

Audit date: 2026-07-08

Scope: README, `protocol/`, and all Markdown files under `docs/`.

| File | Disposition | Reason |
| --- | --- | --- |
| `README.md` | fix | Added canonical Human On the Loop definition and clarified `direct_user_session` as current one-shot visible mode. |
| `protocol/spec.md` | fix | Clarified HOLP is not HIL and added the structured completion-signal axiom in §11. |
| `protocol/examples/examples.md` | keep | Protocol examples use approval/gate as message surfaces only and do not redefine HOLP as approval-driven. |
| `protocol/messages/catalog.md` | keep | Message catalog describes approval/gate mechanics without making them the protocol essence. |
| `protocol/version.md` | keep | Version notes are historical protocol deltas and already frame gate/approval as optional negotiated surfaces. |
| `docs/2026-06-22-backlog-priority.md` | keep | Backlog notes keep gate/direct references scoped to readiness evidence and do not claim HIL semantics. |
| `docs/holp-adjustments-spec.md` | keep | WorkPlanner adjustments preserve approval/consensus as existing paths and do not drift into approval-first framing. |
| `docs/holp-blueprint.md` | fix | Reframed HOLP around harness abstraction/reviewability and added direct-tmux one-shot visible limitation. |
| `docs/holp-learned-router-framework.md` | keep | Learned-router framework keeps approval as a safety constraint and does not replace HOLP with approval flow. |
| `docs/holp-multiround-base-spec.md` | keep | Multiround spec treats approval/gate as existing hard constraints, consistent with canonical HOLP. |
| `docs/positioning.md` | fix | Clarified approval is a useful optional gate, not HOLP's core value. |
| `docs/roadmap.md` | keep | Roadmap uses gate/approval as milestone mechanics and keeps future direct UI work scoped. |
| `docs/runtime-session-matrix.md` | fix | Added current direct-tmux one-shot visible mode boundary and no mid-run correction claim. |
| `docs/runtime-surface-validation-matrix.md` | fix | Scoped direct `ready` cells to one-shot visible direct-tmux proof, not interactive agent UI. |
| `docs/pr-specs/README.md` | keep | PR index already warns which runtime/gate claims are scoped and does not overstate direct session interactivity. |
| `docs/pr-specs/issue-11-agent-harness-isolation.md` | fix | Clarified `direct_user_session` is not automatically interactive and updated historical/current direct-tmux wording. |
| `docs/pr-specs/issue-45-multi-agent-cli-runtime-surface-completion.md` | fix | Added direct-tmux one-shot visible limitation to the surface contract. |
| `docs/pr-specs/issue-47-generalize-direct-tmux-cohort.md` | keep | Direct-tmux foundation already says one-shot command, HOLP-owned sessions, and no attach to user shells. |
| `docs/pr-specs/issue-48-codex-runtime-surface-parity.md` | keep | Codex parity spec treats direct evidence as HOLP-owned tmux proof and avoids interactive-session claims. |
| `docs/pr-specs/issue-49-claude-code-runtime-surface-parity.md` | keep | Claude parity spec keeps ACP unsupported and direct scoped to HOLP-owned throwaway tmux evidence. |
| `docs/pr-specs/issue-50-first-batch-direct-session-parity.md` | fix | Added explicit note that direct-tmux is one-shot visible, not a mid-run human correction surface. |
| `docs/pr-specs/issue-51-first-batch-acp-readiness-hardening.md` | keep | ACP readiness spec focuses on protocol terminal evidence and does not rely on TUI completion as truth. |
| `docs/pr-specs/issue-52-user-validation-matrix-gate.md` | keep | Validation gate spec distinguishes terminal integration from cmux readiness and keeps gate semantics scoped. |
| `docs/pr-specs/issue-54-terminal-consumer-integration-smoke.md` | keep | Terminal-consumer smoke uses public wire evidence and does not claim full terminal product UI. |
| `docs/pr-specs/issue-63-visible-agent-chain-cmux-validation.md` | keep | Visible-chain spec is validation-oriented and does not redefine HOLP as approval-driven. |
| `docs/pr-specs/issue-65-observable-attachable-worker-session.md` | fix | Added up-front limitation that attachability is visibility/debugging, not interactive agent correction. |
| `docs/pr-specs/issue-105-extract-harness-workspace-to-holp-cmux.md` | keep | Extraction note correctly moves UI validation to holp-cmux without changing HOLP semantics. |
| `docs/pr-specs/pr1-m0-contract-surface.md` | keep | Early contract scope is historical and approval appears only as one protocol message surface. |
| `docs/pr-specs/pr2-m1a-protocol-substrate.md` | keep | Protocol substrate spec keeps approval as part of the wire contract, not the protocol's core story. |
| `docs/pr-specs/pr3-m1b-fake-harness-cli.md` | keep | Fake CLI spec is implementation-scoped and does not contain HOLP/HIL drift. |
| `docs/pr-specs/pr4-m2-contract-tests.md` | keep | Contract-test spec records approval state-machine tests without making approval the main HOLP loop. |
| `docs/pr-specs/pr5-m3-first-real-adapter.md` | keep | First real adapter spec correctly treats approval as permission resume for Codex app-server. |
| `docs/pr-specs/pr6-m4a-data-state-decision.md` | keep | Governance skeleton centers events/decision records and does not overstate approval. |
| `docs/pr-specs/pr7-m4b-consensus-gate-triage.md` | keep | Consensus gate triage is local to review aggregation and consistent with optional gate semantics. |
| `docs/pr-specs/pr8-m5-consensus-demo.md` | keep | Consensus demo is clearly fake+fake evidence and not a HIL narrative. |
| `docs/pr-specs/pr9-m5b-real-reviewer-execution.md` | keep | Reviewer pilot keeps gate/readiness attestation scoped to completed votes. |
| `docs/pr-specs/pr10-m6a-consumer-cli-experience.md` | keep | CLI experience spec uses approval as rendered protocol state only. |
| `docs/pr-specs/pr11-m6b-second-real-provider.md` | keep | Native Claude spec scopes execution to headless reviewer path and read-only evidence. |
| `docs/pr-specs/pr12-m6c-runtime-session-matrix.md` | keep | Runtime matrix spec already distinguishes observation/control and fail-closed readiness. |
| `docs/pr-specs/pr13-m7-foundation-loop.md` | keep | Foundation loop treats approval/cancel/consensus as terminal conditions and preserves auditability. |
| `docs/pr-specs/pr14-m8-real-runtime-surface-harness-pilot.md` | keep | M8 spec already rejects TUI state as automation truth and requires structured terminal/final signals. |
| `docs/pr-specs/pr15-m9-consumer-stable-gate-surface.md` | keep | Stable gate surface is explicitly consumer projection, not the essence of HOLP. |
| `docs/pr-specs/pr16-m10-m11-learned-router-dynamic-workflow.md` | keep | Learned-router spec keeps approval/gate as hard constraints outside learned routing. |
| `docs/pr-specs/pr17-m12-remote-distributed-holp.md` | keep | Remote spec preserves local approval relay and does not make remote bypass or HIL semantics. |

Archive: none. No document was moved to `docs/archive/`.

Blocked: none.
