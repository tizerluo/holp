import type { EventCategory } from "./context.js";

export const EVENT_NAME_CONTRACT = {
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
} as const satisfies Record<EventCategory, readonly string[]>;

export type KnownEventName = (typeof EVENT_NAME_CONTRACT)[EventCategory][number];

export function isKnownEventName(category: EventCategory, name: string): name is KnownEventName {
  return (EVENT_NAME_CONTRACT[category] as readonly string[]).includes(name);
}
