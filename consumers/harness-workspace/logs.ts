import type { EventFrame } from "../cli/wire.js";
import { objectPayload, stringField } from "./state.js";
import type {
  HarnessTimelineEntry,
  HarnessTimelineModel,
  HarnessTimelineSeverity,
  ReplayTruncation,
} from "./types.js";

const DEFAULT_LOG_ENTRY_LIMIT = 100;
const DEFAULT_PREVIEW_LIMIT = 512;

export interface TimelineOptions {
  readonly limit?: number;
  readonly previewLimit?: number;
}

export function deriveTimeline(
  events: readonly EventFrame[],
  options: TimelineOptions = {},
): HarnessTimelineModel {
  const limit = options.limit ?? DEFAULT_LOG_ENTRY_LIMIT;
  const previewLimit = options.previewLimit ?? DEFAULT_PREVIEW_LIMIT;
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const retained = ordered.slice(0, Math.max(0, limit));
  const truncated = ordered.length > retained.length
    ? truncation("log_entry_cap", ordered.length, retained.length)
    : undefined;
  return {
    entries: retained.map((event) => timelineEntry(event, previewLimit)),
    ...(truncated ? { truncated } : {}),
  };
}

export function severityForEvent(event: Pick<EventFrame, "category" | "name" | "payload">): HarnessTimelineSeverity {
  const payload = objectPayload(event.payload);
  const reason = stringField(payload, "reason") ?? stringField(payload, "blocking_reason");
  if (
    event.name === "run_blocked"
    || event.name === "run_gave_up"
    || event.name === "approval_expired"
    || event.name === "approval_cancelled"
    || event.name.includes("failed")
    || event.name.includes("failure")
  ) {
    return "error";
  }
  if (
    event.name === "consensus_degraded"
    || reason === "gate_blocked"
    || Boolean(stringField(payload, "blocking_reason"))
    || event.name.includes("unknown")
    || event.name.includes("unsupported")
  ) {
    return "warn";
  }
  if (event.category === "unknown") return "warn";
  return "info";
}

function timelineEntry(event: EventFrame, previewLimit: number): HarnessTimelineEntry {
  const payload = objectPayload(event.payload);
  const agent_id = stringField(payload, "agent_id")
    ?? stringField(payload, "agent")
    ?? stringField(objectPayload(payload.payload), "agent_id")
    ?? stringField(objectPayload(payload.payload), "target_agent_id");
  return {
    run_id: event.run_id,
    seq: event.seq,
    label: `${event.category}.${event.name}#${event.seq}`,
    category: event.category,
    name: event.name,
    severity: severityForEvent(event),
    ...(agent_id ? { agent_id } : {}),
    ...boundedSummary(eventSummary(event), previewLimit),
  };
}

function eventSummary(event: EventFrame): string {
  const payload = objectPayload(event.payload);
  if (event.name === "model_output") {
    return "model output captured";
  }
  if (event.name === "gate_report") {
    const decision = objectPayload(payload.decision_surface);
    return [
      "gate",
      stringField(decision, "gate_disposition"),
      stringField(decision, "review_outcome"),
      stringField(payload, "blocking_reason"),
    ].filter(Boolean).join(" ");
  }
  if (event.name.startsWith("approval_")) {
    return [
      event.name,
      stringField(payload, "approval_id"),
      stringField(payload, "decision"),
    ].filter(Boolean).join(" ");
  }
  if (event.name === "run_merged") return "run merged";
  if (event.name === "run_blocked") return `run blocked${reasonSuffix(payload)}`;
  if (event.name === "run_gave_up") return `run gave up${reasonSuffix(payload)}`;
  if (event.name === "agent_event") {
    return stringField(payload, "name") ?? "agent event";
  }
  return event.name;
}

function reasonSuffix(payload: Record<string, unknown>): string {
  const reason = stringField(payload, "reason");
  return reason ? `: ${reason}` : "";
}

function boundedSummary(summary: string, limit: number): Pick<HarnessTimelineEntry, "summary" | "summary_truncated"> {
  if (summary.length <= limit) return { summary };
  return {
    summary: summary.slice(0, Math.max(0, limit)),
    summary_truncated: true,
  };
}

function truncation(reason: string, original_count: number, retained_count: number): ReplayTruncation {
  return { truncated: true, reason, original_count, retained_count };
}
