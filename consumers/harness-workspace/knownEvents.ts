// Mirrors the implemented HOLP public event vocabulary at the #71 baseline.
// Kept consumer-local so Harness Workspace has no daemon/core runtime dependency.
export const KNOWN_EVENT_NAMES: Readonly<Record<string, readonly string[]>> = {
  run: ["run_started", "run_merged", "run_blocked", "run_gave_up"],
  agent: [
    "step_started",
    "tool_called",
    "tool_result",
    "fs_edited",
    "model_output",
    "agent_event",
  ],
  approval: [
    "approval_requested",
    "approval_resolved",
    "approval_expired",
    "approval_cancelled",
  ],
  consensus: ["consensus_verdict", "consensus_degraded"],
  gate: ["gate_report"],
  lifecycle: [
    "workflow_selected",
    "workflow_step_planned",
    "workflow_step_completed",
    "workflow_revised",
    "workflow_revision_rejected",
  ],
} as const;

export function isKnownHarnessEvent(category: string, name: string): boolean {
  return KNOWN_EVENT_NAMES[category]?.includes(name) ?? false;
}
