import type { EventFrame, RpcErrorPayload } from "./wire.js";

export type TerminalName = "run_merged" | "run_blocked" | "run_cancelled" | "run_gave_up";

export interface ArtifactView {
  readonly artifact_id: string;
  readonly content?: string;
  readonly truncated?: boolean;
  readonly envelope?: unknown;
}

export interface RenderedRunSummary {
  readonly run_id: string;
  readonly terminal?: EventFrame;
  readonly consensus?: EventFrame;
  readonly degraded?: EventFrame;
  readonly seq_ok: boolean;
  readonly seen_events: number;
}

export class RunRenderer {
  private readonly seen = new Set<string>();
  private readonly expectedSeqByRun = new Map<string, number>();
  private readonly events: EventFrame[] = [];
  private readonly seqErrors: string[] = [];

  recordEvent(event: EventFrame): string[] {
    const key = `${event.run_id}:${event.seq}`;
    if (this.seen.has(key)) return [];
    this.seen.add(key);

    const expected = this.expectedSeqByRun.get(event.run_id) ?? 1;
    if (event.seq !== expected) {
      this.seqErrors.push(`run ${event.run_id}: expected seq ${expected}, got ${event.seq}`);
    }
    this.expectedSeqByRun.set(event.run_id, event.seq + 1);
    this.events.push(event);
    return renderEvent(event);
  }

  summary(runId: string): RenderedRunSummary {
    const runEvents = this.events.filter((event) => event.run_id === runId);
    return {
      run_id: runId,
      terminal: runEvents.find((event) => isTerminalEvent(event.name)),
      consensus: runEvents.find((event) => event.name === "consensus_verdict"),
      degraded: runEvents.find((event) => event.name === "consensus_degraded"),
      seq_ok: this.seqErrors.length === 0,
      seen_events: runEvents.length,
    };
  }

  diagnostics(): readonly string[] {
    return this.seqErrors;
  }
}

export function renderEvent(event: EventFrame): string[] {
  const payload = objectPayload(event.payload);
  switch (event.name) {
    case "run_started":
      return [`run started: ${event.run_id} ${runtimeLine(payload)}`.trim()];
    case "run_merged":
      return [`run merged: artifact=${stringField(payload, "artifact_id") ?? "none"}`];
    case "run_blocked":
      return [`run blocked: reason=${stringField(payload, "reason") ?? "unknown"}`];
    case "run_cancelled":
      return [`run cancelled: reason=${stringField(payload, "reason") ?? "unknown"}`];
    case "run_gave_up":
      return [`run gave up: reason=${stringField(payload, "reason") ?? "unknown"}`];
    case "tool_called":
      return [`tool called: ${stringField(payload, "tool_name") ?? "unknown"}`];
    case "tool_result":
      return [`tool result: ${stringField(payload, "tool_name") ?? "unknown"}`];
    case "fs_edited":
      return [`fs edited: ${stringField(payload, "path") ?? stringField(payload, "description") ?? "unknown"}`];
    case "approval_requested":
      return [
        `approval requested: id=${stringField(payload, "approval_id") ?? "unknown"} kind=${stringField(payload, "kind") ?? "unknown"}`,
      ];
    case "approval_resolved":
      return [
        `approval resolved: id=${stringField(payload, "approval_id") ?? "unknown"} decision=${stringField(payload, "decision") ?? "unknown"}`,
      ];
    case "approval_expired":
      return [`approval expired: id=${stringField(payload, "approval_id") ?? "unknown"}`];
    case "approval_cancelled":
      return [`approval cancelled: id=${stringField(payload, "approval_id") ?? "unknown"}`];
    case "consensus_verdict":
      return renderConsensusVerdict(payload);
    case "consensus_degraded":
      return renderConsensusDegraded(payload);
    default:
      return [`[${event.category}] ${event.name}: ${preview(event.payload)}`];
  }
}

export function renderRuntimeMatrix(agent: {
  readonly id: string;
  readonly status?: string;
  readonly runtime_surfaces?: readonly Record<string, unknown>[];
}): string[] {
  const surfaces = agent.runtime_surfaces ?? [];
  const selected = surfaces.find((surface) => surface.runtime_surface === "headless");
  const lines = [`agent ${agent.id}: status=${agent.status ?? "unknown"}`];
  if (selected) {
    const profiles = selected.isolation_profiles as Record<string, { readiness?: string }> | undefined;
    lines.push(
      `  selected runtime=${selected.runtime_surface} kind=${selected.runtime_kind} ` +
        `coder=${profiles?.coder_worktree?.readiness ?? "unknown"} ` +
        `reviewer=${profiles?.read_only_review?.readiness ?? "unknown"}`,
    );
  }
  for (const surface of surfaces) {
    lines.push(
      `  surface ${surface.runtime_surface}: support=${surface.surface_support} kind=${surface.runtime_kind}`,
    );
  }
  return lines;
}

export function renderConsensusVerdict(payload: Record<string, unknown>): string[] {
  const quorum = objectPayload(payload.quorum);
  const excluded = arrayPayload(payload.excluded);
  const errors = arrayPayload(payload.errors);
  const reviews = arrayPayload(payload.reviews);
  const lines = [
    `consensus verdict: outcome=${stringField(payload, "outcome") ?? "unknown"} max_severity=${stringField(payload, "max_severity") ?? "unknown"}`,
    `  quorum: required=${quorum.required ?? "?"} eligible=${quorum.eligible ?? "?"} met=${quorum.met ?? "?"}`,
  ];
  lines.push(`  excluded: ${excluded.length === 0 ? "none" : excluded.map((entry) => stringField(objectPayload(entry), "agent") ?? "?").join(", ")}`);
  lines.push(`  reviews: ${reviews.length}`);
  lines.push(`  errors: ${errors.length === 0 ? "none" : errors.map(renderConsensusError).join(", ")}`);
  return lines;
}

export function renderConsensusDegraded(payload: Record<string, unknown>): string[] {
  const quorum = objectPayload(payload.quorum);
  return [
    `consensus degraded: outcome=${stringField(payload, "outcome") ?? "unknown"} reason=${stringField(payload, "reason") ?? "unknown"}`,
    `  quorum: required=${quorum.required ?? "?"} eligible=${quorum.eligible ?? "?"} met=${quorum.met ?? "?"}`,
  ];
}

export function renderReviewFinding(review: Record<string, unknown>, artifact?: ArtifactView): string[] {
  const findings = objectPayload(review.findings);
  const agent = stringField(review, "agent") ?? "unknown";
  if (findings.inline === true) {
    return [`review ${agent}: inline findings ${inlineSummary(findings)}`];
  }
  const artifactId = stringField(findings, "artifact_id") ?? artifact?.artifact_id ?? "unknown";
  const suffix = artifact?.truncated ? " TRUNCATED" : "";
  return [`review ${agent}: findings artifact=${artifactId}${suffix} ${artifactSummary(artifact)}`.trim()];
}

export function renderArtifact(artifact: ArtifactView): string {
  const suffix = artifact.truncated ? " TRUNCATED" : "";
  return `artifact ${artifact.artifact_id}:${suffix} ${artifactSummary(artifact)}`.trim();
}

export function renderRpcError(prefix: string, error: RpcErrorPayload): string {
  return `${prefix}: server rejected code=${error.code} message=${error.message}`;
}

export function isTerminalEvent(name: string): name is TerminalName {
  return name === "run_merged" || name === "run_blocked" || name === "run_cancelled" || name === "run_gave_up";
}

export function objectPayload(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function arrayPayload(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringField(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function runtimeLine(payload: Record<string, unknown>): string {
  const runtime = objectPayload(payload.runtime);
  const agent = stringField(runtime, "agent_id");
  const surface = stringField(runtime, "runtime_surface");
  const profile = stringField(runtime, "isolation_profile");
  if (!agent && !surface && !profile) return "";
  return `(agent=${agent ?? "?"} runtime=${surface ?? "?"} isolation=${profile ?? "?"})`;
}

function renderConsensusError(value: unknown): string {
  const payload = objectPayload(value);
  const agent = stringField(payload, "agent") ?? "?";
  const status = stringField(payload, "status");
  const reason = stringField(payload, "reason");
  if (status && reason) return `${agent}(${status}:${reason})`;
  if (status) return `${agent}(${status})`;
  return agent;
}

function inlineSummary(payload: Record<string, unknown>): string {
  const content = stringField(payload, "content");
  if (!content) return "(empty)";
  return preview(content);
}

function artifactSummary(artifact?: ArtifactView): string {
  if (!artifact?.content) return "";
  return preview(artifact.content);
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}
