import type { EventFrame } from "../cli/wire.js";
import { deriveOperatorAffordances } from "./affordances.js";
import { deriveContinuity } from "./continuity.js";
import { deriveTimeline } from "./logs.js";
import { t } from "./messages.js";
import { deriveInspect, deriveOverview } from "./renderModel.js";
import { objectPayload, stringField } from "./state.js";
import type {
  HarnessInspectModel,
  HarnessOverviewModel,
  HarnessReplayRestoreResult,
  HarnessReplaySnapshotV1,
  HarnessSessionContinuity,
  HarnessTimelineModel,
  HarnessWorkspaceState,
  RawEvidenceAnchor,
  RenderEvidenceSummary,
  ReplayTruncation,
  SanitizedEventSummary,
  SanitizedEvidenceAnchor,
  WorkerPreview,
} from "./types.js";

const SNAPSHOT_SCHEMA = "HarnessReplaySnapshot.v1";
const DEFAULT_EVENT_LIMIT = 200;
const DEFAULT_EVIDENCE_LIMIT = 50;
const DEFAULT_LOG_LIMIT = 100;
const DEFAULT_PREVIEW_LIMIT = 512;
const DEFAULT_JSON_SIZE_LIMIT = 256 * 1024;
const COPY_COMMAND_AFFORDANCES = new Set(["copy_attach_command", "copy_run_id"]);
const EVENT_SUMMARY_KEYS = new Set(["run_id", "seq", "category", "name", "agent_id", "summary", "summary_truncated", "payload_preview", "payload_truncated"]);
const EVIDENCE_SUMMARY_KEYS = new Set(["source", "run_id", "seq", "category", "name", "payload_preview", "payload_truncated"]);
const TIMELINE_ENTRY_KEYS = new Set(["run_id", "seq", "label", "category", "name", "severity", "agent_id", "summary", "summary_truncated"]);
const OVERVIEW_EVIDENCE_KEYS = new Set(["run_id", "runtime_surface", "worker_session", "attach_command", "owner_verified", "latest_event", "gate", "artifact_refs", "approval", "terminal", "provenance", "provenance_caveat"]);
const OVERVIEW_GATE_KEYS = new Set(["gate_disposition", "review_outcome", "blocking_reason"]);
const OVERVIEW_APPROVAL_KEYS = new Set(["state", "approval_id", "decision"]);
const OVERVIEW_TERMINAL_KEYS = new Set(["state", "reason"]);
const OVERVIEW_KEYS = new Set(["title", "mode", "run_id", "chain", "evidence", "evidence_truncated", "worker_preview", "worker_preview_truncated", "terminal_state", "failures", "failures_truncated"]);
const INSPECT_KEYS = new Set(["title", "mode", "selectedAgentId", "empty"]);
const CHAIN_NODE_KEYS = new Set(["id", "label", "skin", "state", "agentId"]);
const KNOWN_ROLE_SKINS = new Set(["CTRL", "CODE", "TEST", "REV", "ARCH", "GATE"]);
const KNOWN_CHAIN_STATES = new Set(["idle", "active", "done", "failed", "unknown"]);
const CONTINUITY_KEYS = new Set(["run_id", "observed_agent_ids", "selected_agent_id", "runtime_surface", "worker_session", "attach_command", "terminal_state", "owner_verified", "replay_created_at", "can_continue", "can_rerun", "can_inspect", "can_copy", "replay_only", "reasons"]);
const KNOWN_AFFORDANCE_IDS = new Set([
  "copy_attach_command",
  "copy_run_id",
  "open_team_layout",
  "replay_evidence",
  "rerun_goal",
  "continue_run",
  "cancel_run",
  "interrupt_worker",
]);
const KNOWN_AFFORDANCE_STATES = new Set(["enabled", "disabled", "needs_confirmation", "unsupported"]);
const KNOWN_TIMELINE_SEVERITIES = new Set(["info", "warn", "error"]);
const FORBIDDEN_COMMAND_TEXT = /\b(?:kill|pkill|killall|send-key|focus-[\w-]*|select-[\w-]*|close-[\w-]*|move-[\w-]*)\b/i;

export interface ReplaySnapshotOptions {
  readonly createdAt?: string | Date;
  readonly inspectAgentId?: string;
  readonly eventLimit?: number;
  readonly evidenceLimit?: number;
  readonly logLimit?: number;
  readonly previewLimit?: number;
}

export interface ReplayJsonOptions extends ReplaySnapshotOptions {
  readonly maxJsonSize?: number;
}

export function createReplaySnapshot(
  state: HarnessWorkspaceState,
  options: ReplaySnapshotOptions = {},
): HarnessReplaySnapshotV1 {
  const created_at = createdAt(options.createdAt);
  const eventLimit = options.eventLimit ?? DEFAULT_EVENT_LIMIT;
  const evidenceLimit = options.evidenceLimit ?? DEFAULT_EVIDENCE_LIMIT;
  const logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;
  const previewLimit = options.previewLimit ?? DEFAULT_PREVIEW_LIMIT;
  const overview = deriveOverview(state);
  const inspect = options.inspectAgentId ? deriveInspect(state, options.inspectAgentId) : undefined;
  const continuity = replayContinuity(deriveContinuity(state, { replayCreatedAt: created_at }));
  const operator_affordances = deriveOperatorAffordances(state, continuity);
  const logs = deriveTimeline(state.events, { limit: logLimit, previewLimit });
  const orderedEvents = [...state.events].sort((left, right) => left.seq - right.seq);
  const orderedEvidence = [...state.rawEvidenceAnchors].sort((left, right) => left.seq - right.seq);
  const events = orderedEvents.slice(0, Math.max(0, eventLimit)).map((event) => eventSummary(event, previewLimit));
  const evidence = orderedEvidence
    .slice(0, Math.max(0, evidenceLimit))
    .map((anchor) => evidenceAnchorSummary(anchor, previewLimit));
  const title = boundedString(overview.title, previewLimit);
  const preview = boundedString(overview.workerPreview.renderedText, previewLimit);
  const failures = overview.failures.map((failure) => boundedString(failure, previewLimit));
  const failuresTruncated = failures.some((failure) => failure.truncated);
  const evidenceSummary = sanitizeEvidenceSummary(overview.evidence, previewLimit);
  const chain = overview.chain.map((node) => sanitizeChainNode(node, previewLimit));

  return {
    schema_version: SNAPSHOT_SCHEMA,
    created_at,
    run: { ...state.run },
    locale: state.locale,
    provenance: state.provenance,
    events,
    ...(orderedEvents.length > events.length ? { events_truncated: truncation("event_summary_cap", orderedEvents.length, events.length) } : {}),
    evidence,
    ...(orderedEvidence.length > evidence.length
      ? { evidence_truncated: truncation("evidence_anchor_cap", orderedEvidence.length, evidence.length) }
      : {}),
    overview: {
      title: title.value,
      mode: overview.mode,
      run_id: evidenceSummary.evidence.run_id,
      chain,
      evidence: evidenceSummary.evidence,
      ...(evidenceSummary.truncated ? { evidence_truncated: truncation("overview_evidence_string_cap", 1, 1) } : {}),
      worker_preview: preview.value,
      worker_preview_truncated: overview.workerPreview.truncated || preview.truncated,
      terminal_state: overview.evidence.terminal?.state,
      failures: failures.map((failure) => failure.value),
      ...(failuresTruncated ? { failures_truncated: truncation("overview_failure_string_cap", overview.failures.length, failures.length) } : {}),
    },
    ...(inspect
      ? {
          inspect: {
            title: inspect.title,
            mode: inspect.mode,
            selectedAgentId: inspect.selectedAgentId,
            empty: inspect.empty,
          },
        }
      : {}),
    logs,
    operator_affordances,
    continuity,
  };
}

export function restoreReplaySnapshot(snapshot: HarnessReplaySnapshotV1): HarnessReplayRestoreResult {
  validateSnapshot(snapshot);
  const timeline = snapshot.logs;
  const continuity = {
    ...snapshot.continuity,
    replay_created_at: snapshot.created_at,
  };
  const overview = replayOverview(snapshot, timeline, continuity);
  const inspect = snapshot.inspect ? replayInspect(snapshot, overview) : undefined;
  return {
    snapshot,
    overview,
    ...(inspect ? { inspect } : {}),
    timeline,
    continuity,
    operator_affordances: snapshot.operator_affordances,
  };
}

export function exportReplaySnapshotJson(
  snapshot: HarnessReplaySnapshotV1,
  options: ReplayJsonOptions = {},
): string {
  validateSnapshot(snapshot, options);
  const json = JSON.stringify(snapshot);
  const maxJsonSize = options.maxJsonSize ?? DEFAULT_JSON_SIZE_LIMIT;
  if (json.length > maxJsonSize) {
    throw new Error(`Replay snapshot exceeds JSON size guard: ${json.length} > ${maxJsonSize}`);
  }
  return json;
}

export function importReplaySnapshotJson(
  json: string,
  options: ReplayJsonOptions = {},
): HarnessReplaySnapshotV1 {
  const maxJsonSize = options.maxJsonSize ?? DEFAULT_JSON_SIZE_LIMIT;
  if (json.length > maxJsonSize) {
    throw new Error(`Replay snapshot import exceeds JSON size guard: ${json.length} > ${maxJsonSize}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Replay snapshot JSON is malformed");
  }
  validateSnapshot(parsed, options);
  return parsed;
}

function replayOverview(
  snapshot: HarnessReplaySnapshotV1,
  timeline: HarnessTimelineModel,
  continuity: HarnessSessionContinuity,
): HarnessOverviewModel {
  const labels = labelsFor(snapshot.locale);
  const rawEvidenceAnchors = snapshot.evidence.map((anchor): RawEvidenceAnchor => ({
    source: anchor.source,
    run_id: anchor.run_id,
    seq: anchor.seq,
    category: anchor.category,
    name: anchor.name,
    payload: anchor.payload_preview,
  }));
  return {
    mode: "overview",
    title: snapshot.overview.title,
    labels,
    chain: snapshot.overview.chain,
    workerPreview: workerPreview(snapshot.overview.worker_preview, snapshot.overview.worker_preview_truncated),
    evidence: replayEvidenceSummary(snapshot, continuity),
    failures: snapshot.overview.failures,
    rawEvidenceAnchors,
    replay: {
      status: "replay",
      created_at: snapshot.created_at,
      summary: `replay snapshot ${snapshot.schema_version}`,
    },
    timeline,
    continuity,
    operator_affordances: snapshot.operator_affordances,
  };
}

function replayContinuity(continuity: HarnessSessionContinuity): HarnessSessionContinuity {
  if (!continuity.can_continue) return continuity;
  return {
    ...continuity,
    can_continue: false,
    replay_only: !continuity.can_rerun,
    reasons: [...new Set([...continuity.reasons, "continue_disabled_in_replay_snapshot"])],
  };
}

function replayInspect(
  snapshot: HarnessReplaySnapshotV1,
  overview: HarnessOverviewModel,
): HarnessInspectModel {
  return {
    ...overview,
    mode: "inspect",
    title: snapshot.inspect?.title ?? t(snapshot.locale, "titleInspect"),
    selectedAgentId: snapshot.inspect?.selectedAgentId,
    selectedAgent: undefined,
    inspect: undefined,
    empty: snapshot.inspect?.empty ?? true,
  };
}

function eventSummary(event: EventFrame, limit: number): SanitizedEventSummary {
  const payload = objectPayload(event.payload);
  const agent_id = stringField(payload, "agent_id")
    ?? stringField(payload, "agent")
    ?? stringField(objectPayload(payload.payload), "agent_id")
    ?? stringField(objectPayload(payload.payload), "target_agent_id");
  const preview = payloadPreview(payload, limit);
  const summary = boundedOptionalString(safeSummary(event), limit);
  return {
    run_id: event.run_id,
    seq: event.seq,
    category: event.category,
    name: event.name,
    ...(agent_id ? { agent_id } : {}),
    ...(summary ? { summary: summary.value } : {}),
    ...(summary?.truncated ? { summary_truncated: true } : {}),
    ...(preview.value ? { payload_preview: preview.value } : {}),
    payload_truncated: preview.truncated,
  };
}

function evidenceAnchorSummary(anchor: RawEvidenceAnchor, limit: number): SanitizedEvidenceAnchor {
  const preview = payloadPreview(objectPayload(anchor.payload), limit);
  return {
    source: anchor.source,
    run_id: anchor.run_id,
    seq: anchor.seq,
    category: anchor.category,
    name: anchor.name,
    ...(preview.value ? { payload_preview: preview.value } : {}),
    payload_truncated: preview.truncated,
  };
}

function sanitizeEvidenceSummary(
  evidence: RenderEvidenceSummary,
  limit: number,
): { readonly evidence: RenderEvidenceSummary; readonly truncated: boolean } {
  let truncated = false;
  const cap = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const bounded = boundedString(value, limit);
    truncated ||= bounded.truncated;
    return bounded.value;
  };
  const artifact_refs = evidence.artifact_refs.map((ref) => cap(ref) ?? "");
  const sanitized: RenderEvidenceSummary = {
    artifact_refs,
    owner_verified: evidence.owner_verified,
    provenance: evidence.provenance,
    provenance_caveat: cap(evidence.provenance_caveat) ?? "",
    ...(cap(evidence.run_id) ? { run_id: cap(evidence.run_id) } : {}),
    ...(cap(evidence.runtime_surface) ? { runtime_surface: cap(evidence.runtime_surface) } : {}),
    ...(cap(evidence.worker_session) ? { worker_session: cap(evidence.worker_session) } : {}),
    ...(cap(evidence.attach_command) ? { attach_command: cap(evidence.attach_command) } : {}),
    ...(cap(evidence.latest_event) ? { latest_event: cap(evidence.latest_event) } : {}),
    ...(evidence.gate
      ? {
          gate: {
            ...(cap(evidence.gate.gate_disposition) ? { gate_disposition: cap(evidence.gate.gate_disposition) } : {}),
            ...(cap(evidence.gate.review_outcome) ? { review_outcome: cap(evidence.gate.review_outcome) } : {}),
            ...(cap(evidence.gate.blocking_reason) ? { blocking_reason: cap(evidence.gate.blocking_reason) } : {}),
          },
        }
      : {}),
    ...(evidence.approval
      ? {
          approval: {
            state: evidence.approval.state,
            ...(cap(evidence.approval.approval_id) ? { approval_id: cap(evidence.approval.approval_id) } : {}),
            ...(cap(evidence.approval.decision) ? { decision: cap(evidence.approval.decision) } : {}),
          },
        }
      : {}),
    ...(evidence.terminal
      ? {
          terminal: {
            state: evidence.terminal.state,
            ...(cap(evidence.terminal.reason) ? { reason: cap(evidence.terminal.reason) } : {}),
          },
        }
      : {}),
  };
  return { evidence: sanitized, truncated };
}

function sanitizeChainNode<T extends { readonly id: string; readonly label: string; readonly skin: string; readonly state: string; readonly agentId?: string }>(
  node: T,
  limit: number,
): T {
  return {
    ...node,
    id: boundedString(node.id, limit).value,
    label: boundedString(node.label, limit).value,
    ...(node.agentId ? { agentId: boundedString(node.agentId, limit).value } : {}),
  };
}

function payloadPreview(payload: Record<string, unknown>, limit: number): { readonly value?: string; readonly truncated: boolean } {
  const fields: string[] = [];
  for (const key of ["reason", "blocking_reason", "approval_id", "decision", "artifact_id", "artifact_ref", "name", "agent_id", "agent", "detail"]) {
    const value = stringField(payload, key);
    if (value) fields.push(`${key}=${value}`);
  }
  const decision = objectPayload(payload.decision_surface);
  for (const key of ["gate_disposition", "review_outcome"]) {
    const value = stringField(decision, key);
    if (value) fields.push(`${key}=${value}`);
  }
  for (const key of ["text_delta", "full_text"]) {
    const value = stringField(payload, key);
    if (value !== undefined) fields.push(`${key}=${value}`);
  }
  const keys = Object.keys(payload).sort();
  if (fields.length === 0 && keys.length > 0) fields.push(`keys=${keys.join(",")}`);
  const bounded = boundedString(fields.join(" "), limit);
  return {
    ...(bounded.value ? { value: bounded.value } : {}),
    truncated: bounded.truncated || fields.length === 0 && keys.length > 0,
  };
}

function safeSummary(event: EventFrame): string | undefined {
  const payload = objectPayload(event.payload);
  if (event.name === "model_output") return "model output";
  if (event.name === "gate_report") return "gate report";
  if (event.name.startsWith("approval_")) return event.name;
  return stringField(payload, "reason") ?? stringField(payload, "name") ?? event.name;
}

function replayEvidenceSummary(
  snapshot: HarnessReplaySnapshotV1,
  continuity: HarnessSessionContinuity,
): RenderEvidenceSummary {
  const stored = snapshot.overview.evidence;
  return {
    ...stored,
    run_id: stored.run_id ?? snapshot.run.run_id,
    runtime_surface: stored.runtime_surface ?? snapshot.run.runtime_surface ?? continuity.runtime_surface,
    worker_session: stored.worker_session ?? continuity.worker_session,
    attach_command: stored.attach_command ?? continuity.attach_command,
    owner_verified: stored.owner_verified ?? continuity.owner_verified,
    latest_event: stored.latest_event ?? (snapshot.events.at(-1)
      ? `${snapshot.events.at(-1)?.category}.${snapshot.events.at(-1)?.name}#${snapshot.events.at(-1)?.seq}`
      : undefined),
    artifact_refs: stored.artifact_refs,
    terminal: stored.terminal ?? (snapshot.overview.terminal_state ? { state: snapshot.overview.terminal_state } : undefined),
    provenance: snapshot.provenance,
    provenance_caveat: t(
      snapshot.locale,
      snapshot.provenance === "smoke_script" ? "provenanceSmoke" : "provenanceUnknown",
    ),
  };
}

function labelsFor(locale: HarnessReplaySnapshotV1["locale"]): Record<string, string> {
  return {
    chain: t(locale, "chain"),
    workerPreview: t(locale, "workerPreview"),
    evidence: t(locale, "evidence"),
    failures: t(locale, "failures"),
    unknown: t(locale, "unknown"),
    inspectEmpty: t(locale, "inspectEmpty"),
  };
}

function workerPreview(text: string | undefined, truncated: boolean): WorkerPreview {
  const value = text ?? "";
  return {
    fullText: value,
    renderedText: value,
    truncated,
    authoritativeSnapshot: true,
    producer_attribution: "none",
  };
}

function validateSnapshot(value: unknown, options: ReplayJsonOptions = {}): asserts value is HarnessReplaySnapshotV1 {
  const object = requireObject(value, "snapshot");
  if (object.schema_version !== SNAPSHOT_SCHEMA) throw new Error("Unsupported replay snapshot schema_version");
  if (typeof object.created_at !== "string") throw new Error("Replay snapshot created_at is required");
  if (object.locale !== "en-US" && object.locale !== "zh-CN") throw new Error("Replay snapshot locale is invalid");
  requireObject(object.run, "run");
  const events = requireArray(object.events, "events");
  const evidence = requireArray(object.evidence, "evidence");
  const logs = requireObject(object.logs, "logs");
  const entries = requireArray(logs.entries, "logs.entries");
  const eventLimit = options.eventLimit ?? DEFAULT_EVENT_LIMIT;
  const evidenceLimit = options.evidenceLimit ?? DEFAULT_EVIDENCE_LIMIT;
  const logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;
  const previewLimit = options.previewLimit ?? DEFAULT_PREVIEW_LIMIT;
  if (events.length > eventLimit) throw new Error("Replay snapshot event summaries exceed cap");
  if (evidence.length > evidenceLimit) throw new Error("Replay snapshot evidence anchors exceed cap");
  if (entries.length > logLimit) throw new Error("Replay snapshot log entries exceed cap");
  if (object.events_truncated !== undefined) validateTruncation(object.events_truncated, "events_truncated");
  if (object.evidence_truncated !== undefined) validateTruncation(object.evidence_truncated, "evidence_truncated");
  if (logs.truncated !== undefined) validateTruncation(logs.truncated, "logs.truncated");
  for (const entry of events) validateSanitizedEvent(entry, previewLimit);
  for (const anchor of evidence) validateSanitizedEvidence(anchor, previewLimit);
  for (const entry of entries) validateTimelineEntry(entry, previewLimit);
  const overview = requireObject(object.overview, "overview");
  validateOverviewSummary(overview, previewLimit);
  validateOverviewEvidence(overview.evidence, previewLimit);
  if (overview.evidence_truncated !== undefined) validateTruncation(overview.evidence_truncated, "overview.evidence_truncated");
  validateOverviewFailures(overview, previewLimit);
  if (object.inspect !== undefined) validateInspectSummary(object.inspect, previewLimit);
  const affordances = requireArray(object.operator_affordances, "operator_affordances");
  for (const affordance of affordances) validateAffordance(affordance, previewLimit);
  validateContinuity(object.continuity, previewLimit);
}

function validateSanitizedEvent(value: unknown, previewLimit: number): void {
  const event = requireObject(value, "event");
  rejectUnknownKeys(event, EVENT_SUMMARY_KEYS, "Replay event");
  if (typeof event.run_id !== "string") throw new Error("Replay event run_id is invalid");
  if (!Number.isSafeInteger(event.seq)) throw new Error("Replay event seq is invalid");
  if (typeof event.category !== "string" || typeof event.name !== "string") {
    throw new Error("Replay event frame is malformed");
  }
  if ("payload" in event) throw new Error("Replay event contains unbounded payload");
  validateOptionalSummary(event.summary, "Replay event summary", previewLimit);
  if (event.summary_truncated !== undefined && typeof event.summary_truncated !== "boolean") {
    throw new Error("Replay event summary_truncated must be boolean");
  }
  validatePreview(event.payload_preview, previewLimit);
  if (typeof event.payload_truncated !== "boolean") throw new Error("Replay event payload_truncated is required");
}

function validateSanitizedEvidence(value: unknown, previewLimit: number): void {
  const anchor = requireObject(value, "evidence");
  rejectUnknownKeys(anchor, EVIDENCE_SUMMARY_KEYS, "Replay evidence");
  if (anchor.source !== "event" && anchor.source !== "unknown_event") throw new Error("Replay evidence source is invalid");
  if (typeof anchor.run_id !== "string") throw new Error("Replay evidence run_id is invalid");
  if (!Number.isSafeInteger(anchor.seq)) throw new Error("Replay evidence seq is invalid");
  if (typeof anchor.category !== "string" || typeof anchor.name !== "string") {
    throw new Error("Replay evidence frame is malformed");
  }
  if ("payload" in anchor) throw new Error("Replay evidence contains unbounded payload");
  validatePreview(anchor.payload_preview, previewLimit);
  if (typeof anchor.payload_truncated !== "boolean") throw new Error("Replay evidence payload_truncated is required");
}

function validatePreview(value: unknown, previewLimit: number): void {
  if (value === undefined) return;
  if (typeof value !== "string") throw new Error("Replay payload preview must be a string");
  if (value.length > previewLimit) throw new Error("Replay payload preview exceeds cap");
}

function validateTimelineEntry(value: unknown, previewLimit: number): void {
  const entry = requireObject(value, "log entry");
  rejectUnknownKeys(entry, TIMELINE_ENTRY_KEYS, "Replay log entry");
  if ("payload" in entry) throw new Error("Replay log entry contains unbounded payload");
  if (typeof entry.run_id !== "string") throw new Error("Replay log entry run_id is invalid");
  if (!Number.isSafeInteger(entry.seq)) throw new Error("Replay log entry seq is invalid");
  for (const key of ["label", "category", "name", "summary"]) {
    if (typeof entry[key] !== "string") {
      throw new Error(`Replay log entry ${key} must be a string`);
    }
    if ((entry[key] as string).length > previewLimit) {
      throw new Error(`Replay log entry ${key} exceeds cap`);
    }
  }
  if (typeof entry.severity !== "string" || !KNOWN_TIMELINE_SEVERITIES.has(entry.severity)) {
    throw new Error("Replay log entry severity is invalid");
  }
  if (entry.agent_id !== undefined) validateCappedOptionalString(entry.agent_id, "agent_id", previewLimit);
  if (entry.summary_truncated !== undefined && typeof entry.summary_truncated !== "boolean") {
    throw new Error("Replay log entry summary_truncated must be boolean");
  }
}

function validateOverviewFailures(overview: Record<string, unknown>, previewLimit: number): void {
  const failures = requireArray(overview.failures, "overview.failures");
  for (const failure of failures) {
    if (typeof failure !== "string") throw new Error("Replay overview failure must be a string");
    if (failure.length > previewLimit) throw new Error("Replay overview failure exceeds cap");
  }
  if (overview.failures_truncated !== undefined) validateTruncation(overview.failures_truncated, "overview.failures_truncated");
}

function validateOverviewSummary(overview: Record<string, unknown>, previewLimit: number): void {
  rejectUnknownKeys(overview, OVERVIEW_KEYS, "Replay overview");
  if (overview.mode !== "overview") throw new Error("Replay overview mode is invalid");
  validateRequiredCappedString(overview.title, "overview.title", previewLimit);
  validateOptionalEvidenceString(overview.run_id, "overview.run_id", previewLimit);
  validateOptionalEvidenceString(overview.worker_preview, "overview.worker_preview", previewLimit);
  if (typeof overview.worker_preview_truncated !== "boolean") {
    throw new Error("Replay overview worker_preview_truncated must be boolean");
  }
  if (overview.terminal_state !== undefined && !["merged", "blocked", "gave_up", "cancelled"].includes(String(overview.terminal_state))) {
    throw new Error("Replay overview terminal_state is invalid");
  }
  const chain = requireArray(overview.chain, "overview.chain");
  for (const node of chain) validateChainNode(node, previewLimit);
}

function validateChainNode(value: unknown, previewLimit: number): void {
  const node = requireObject(value, "overview.chain[]");
  rejectUnknownKeys(node, CHAIN_NODE_KEYS, "Replay overview chain node");
  validateRequiredCappedString(node.id, "overview.chain[].id", previewLimit);
  validateRequiredCappedString(node.label, "overview.chain[].label", previewLimit);
  if (typeof node.skin !== "string" || !KNOWN_ROLE_SKINS.has(node.skin)) {
    throw new Error("Replay overview chain node skin is invalid");
  }
  if (typeof node.state !== "string" || !KNOWN_CHAIN_STATES.has(node.state)) {
    throw new Error("Replay overview chain node state is invalid");
  }
  validateOptionalEvidenceString(node.agentId, "overview.chain[].agentId", previewLimit);
}

function validateInspectSummary(value: unknown, previewLimit: number): void {
  const inspect = requireObject(value, "inspect");
  rejectUnknownKeys(inspect, INSPECT_KEYS, "Replay inspect");
  if (inspect.mode !== "inspect") throw new Error("Replay inspect mode is invalid");
  validateRequiredCappedString(inspect.title, "inspect.title", previewLimit);
  validateOptionalEvidenceString(inspect.selectedAgentId, "inspect.selectedAgentId", previewLimit);
  if (typeof inspect.empty !== "boolean") throw new Error("Replay inspect empty must be boolean");
}

function validateOverviewEvidence(value: unknown, previewLimit: number): void {
  const evidence = requireObject(value, "overview.evidence");
  rejectUnknownKeys(evidence, OVERVIEW_EVIDENCE_KEYS, "Replay overview evidence");
  for (const key of ["run_id", "runtime_surface", "worker_session", "attach_command", "latest_event", "provenance_caveat"]) {
    validateOptionalEvidenceString(evidence[key], `overview.evidence.${key}`, previewLimit);
  }
  if (evidence.owner_verified !== "verified" && evidence.owner_verified !== "unverified" && evidence.owner_verified !== "unknown") {
    throw new Error("Replay overview evidence owner_verified is invalid");
  }
  if (evidence.provenance !== "smoke_script" && evidence.provenance !== "unknown") {
    throw new Error("Replay overview evidence provenance is invalid");
  }
  const artifactRefs = requireArray(evidence.artifact_refs, "overview.evidence.artifact_refs");
  for (const ref of artifactRefs) validateOptionalEvidenceString(ref, "overview.evidence.artifact_refs[]", previewLimit);
  if (evidence.gate !== undefined) {
    const gate = requireObject(evidence.gate, "overview.evidence.gate");
    rejectUnknownKeys(gate, OVERVIEW_GATE_KEYS, "Replay overview evidence gate");
    for (const key of ["gate_disposition", "review_outcome", "blocking_reason"]) {
      validateOptionalEvidenceString(gate[key], `overview.evidence.gate.${key}`, previewLimit);
    }
  }
  if (evidence.approval !== undefined) {
    const approval = requireObject(evidence.approval, "overview.evidence.approval");
    rejectUnknownKeys(approval, OVERVIEW_APPROVAL_KEYS, "Replay overview evidence approval");
    if (!["requested", "resolved", "expired", "cancelled"].includes(String(approval.state))) {
      throw new Error("Replay overview evidence approval state is invalid");
    }
    for (const key of ["approval_id", "decision"]) {
      validateOptionalEvidenceString(approval[key], `overview.evidence.approval.${key}`, previewLimit);
    }
  }
  if (evidence.terminal !== undefined) {
    const terminal = requireObject(evidence.terminal, "overview.evidence.terminal");
    rejectUnknownKeys(terminal, OVERVIEW_TERMINAL_KEYS, "Replay overview evidence terminal");
    if (!["merged", "blocked", "gave_up", "cancelled"].includes(String(terminal.state))) {
      throw new Error("Replay overview evidence terminal state is invalid");
    }
    validateOptionalEvidenceString(terminal.reason, "overview.evidence.terminal.reason", previewLimit);
  }
}

function validateContinuity(value: unknown, previewLimit: number): void {
  const continuity = requireObject(value, "continuity");
  rejectUnknownKeys(continuity, CONTINUITY_KEYS, "Replay continuity");
  for (const key of ["run_id", "selected_agent_id", "runtime_surface", "worker_session", "attach_command", "terminal_state", "replay_created_at"]) {
    validateOptionalEvidenceString(continuity[key], `continuity.${key}`, previewLimit);
  }
  if (continuity.terminal_state !== undefined && !["merged", "blocked", "gave_up", "cancelled"].includes(String(continuity.terminal_state))) {
    throw new Error("Replay continuity terminal_state is invalid");
  }
  if (continuity.owner_verified !== "verified" && continuity.owner_verified !== "unverified" && continuity.owner_verified !== "unknown") {
    throw new Error("Replay continuity owner_verified is invalid");
  }
  const observed = requireArray(continuity.observed_agent_ids, "continuity.observed_agent_ids");
  for (const agentId of observed) validateRequiredCappedString(agentId, "continuity.observed_agent_ids[]", previewLimit);
  const reasons = requireArray(continuity.reasons, "continuity.reasons");
  for (const reason of reasons) validateRequiredCappedString(reason, "continuity.reasons[]", previewLimit);
  for (const key of ["can_continue", "can_rerun", "can_inspect", "can_copy", "replay_only"]) {
    if (typeof continuity[key] !== "boolean") throw new Error(`Replay continuity ${key} must be boolean`);
  }
  if (continuity.can_continue === true) {
    throw new Error("Replay continuity can_continue is unsupported for replay import");
  }
}

function validateOptionalEvidenceString(value: unknown, label: string, previewLimit: number): void {
  if (value === undefined) return;
  if (typeof value !== "string") throw new Error(`Replay ${label} must be a string`);
  if (value.length > previewLimit) throw new Error(`Replay ${label} exceeds cap`);
}

function validateRequiredCappedString(value: unknown, label: string, previewLimit: number): void {
  if (typeof value !== "string") throw new Error(`Replay ${label} must be a string`);
  if (value.length > previewLimit) throw new Error(`Replay ${label} exceeds cap`);
}

function validateTruncation(value: unknown, label: string): void {
  const marker = requireObject(value, label);
  rejectUnknownKeys(marker, new Set(["truncated", "reason", "original_count", "retained_count"]), `Replay ${label}`);
  if (marker.truncated !== true) throw new Error(`Replay ${label} marker must be truncated`);
  if (typeof marker.reason !== "string") throw new Error(`Replay ${label} reason must be a string`);
  if (marker.reason.length > DEFAULT_PREVIEW_LIMIT) throw new Error(`Replay ${label} reason exceeds cap`);
  if (marker.original_count !== undefined && !Number.isSafeInteger(marker.original_count)) {
    throw new Error(`Replay ${label} original_count is invalid`);
  }
  if (marker.retained_count !== undefined && !Number.isSafeInteger(marker.retained_count)) {
    throw new Error(`Replay ${label} retained_count is invalid`);
  }
}

function rejectUnknownKeys(object: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}`);
  }
}

function validateOptionalSummary(value: unknown, label: string, previewLimit: number): void {
  if (value === undefined) return;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > previewLimit) throw new Error(`${label} exceeds cap`);
}

function validateCappedOptionalString(value: unknown, label: string, previewLimit: number): void {
  if (typeof value !== "string") throw new Error(`Replay log entry ${label} must be a string`);
  if (value.length > previewLimit) throw new Error(`Replay log entry ${label} exceeds cap`);
}

function validateAffordance(value: unknown, previewLimit: number): void {
  const affordance = requireObject(value, "operator_affordance");
  if (typeof affordance.id !== "string" || !KNOWN_AFFORDANCE_IDS.has(affordance.id)) {
    throw new Error("Replay operator affordance id is invalid");
  }
  if (typeof affordance.state !== "string" || !KNOWN_AFFORDANCE_STATES.has(affordance.state)) {
    throw new Error("Replay operator affordance state is invalid");
  }
  for (const key of ["confirmation_required", "destructive", "focus_changing"]) {
    if (typeof affordance[key] !== "boolean") {
      throw new Error(`Replay operator affordance ${key} must be boolean`);
    }
  }
  if (affordance.command_text === undefined) return;
  if (!COPY_COMMAND_AFFORDANCES.has(affordance.id)) {
    throw new Error("Replay operator affordance command_text is only allowed for copy actions");
  }
  if (typeof affordance.command_text !== "string") {
    throw new Error("Replay operator affordance command_text must be a string");
  }
  if (affordance.command_text.length > previewLimit) {
    throw new Error("Replay operator affordance command_text exceeds cap");
  }
  if (FORBIDDEN_COMMAND_TEXT.test(affordance.command_text)) {
    throw new Error("Replay operator affordance command_text contains a forbidden command token");
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Replay snapshot ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Replay snapshot ${label} must be an array`);
  return value;
}

function boundedString(value: string, limit: number): { readonly value: string; readonly truncated: boolean } {
  if (value.length <= limit) return { value, truncated: false };
  return { value: value.slice(0, Math.max(0, limit)), truncated: true };
}

function boundedOptionalString(value: string | undefined, limit: number): { readonly value: string; readonly truncated: boolean } | undefined {
  return value === undefined ? undefined : boundedString(value, limit);
}

function createdAt(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  return value ?? new Date().toISOString();
}

function truncation(reason: string, original_count: number, retained_count: number): ReplayTruncation {
  return { truncated: true, reason, original_count, retained_count };
}
