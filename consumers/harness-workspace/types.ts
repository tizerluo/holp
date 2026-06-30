import type { EventFrame } from "../cli/wire.js";

export type HarnessWorkspaceLocale = "en-US" | "zh-CN";
export type HarnessWorkspaceProvenance = "smoke_script" | "unknown";
export type RoleSkinId = "CTRL" | "CODE" | "TEST" | "REV" | "ARCH" | "GATE";
export type OwnerVerificationState = "verified" | "unverified" | "unknown";
export type TerminalStateKind = "merged" | "blocked" | "gave_up" | "cancelled";
export type HarnessTimelineSeverity = "info" | "warn" | "error";
export type HarnessAffordanceState = "enabled" | "disabled" | "needs_confirmation" | "unsupported";
export type HarnessOperatorAffordanceId =
  | "copy_attach_command"
  | "copy_run_id"
  | "open_team_layout"
  | "replay_evidence"
  | "rerun_goal"
  | "continue_run"
  | "cancel_run"
  | "interrupt_worker";
export type FailureKind =
  | "run_blocked"
  | "run_gave_up"
  | "run_cancelled"
  | "consensus_degraded"
  | "gate_blocking"
  | "approval_expired"
  | "approval_cancelled";

export interface HarnessWorkspaceOptions {
  readonly locale?: HarnessWorkspaceLocale;
  readonly provenance?: HarnessWorkspaceProvenance;
  readonly previewLimit?: number;
}

export interface RuntimeSurfaceRow {
  readonly runtime_surface?: string;
  readonly runtime_kind?: string;
  readonly surface_support?: string;
  readonly direct_channel?: Record<string, unknown>;
  readonly isolation_profiles?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface DiscoveredAgent {
  readonly id: string;
  readonly status?: string;
  readonly runtime_surfaces?: readonly RuntimeSurfaceRow[];
  readonly role?: string;
  readonly raw?: unknown;
}

export interface HarnessRunIdentity {
  readonly run_id?: string;
  readonly controller_agent_id?: string;
  readonly selected_agent_id?: string;
  readonly runtime_surface?: string;
  readonly isolation_profile?: string;
  readonly runtime_kind?: string;
  readonly goal?: string;
}

export interface WorkerAnchor {
  readonly worker_session?: string;
  readonly attach_command?: string;
  readonly agent_id?: string;
  readonly source: "step_started.detail" | "agent_event.attach_target";
}

export interface WorkerPreview {
  readonly fullText: string;
  readonly renderedText: string;
  readonly truncated: boolean;
  readonly authoritativeSnapshot: boolean;
  readonly producer_attribution: "none" | "single" | "mixed";
  readonly producer_agent_id?: string;
}

export interface GateState {
  readonly event: EventFrame;
  readonly decisionSurface?: Record<string, unknown>;
  readonly gateDisposition?: string;
  readonly reviewOutcome?: string;
  readonly blockingReason?: string;
}

export interface ApprovalState {
  readonly state: "requested" | "resolved" | "expired" | "cancelled";
  readonly approval_id?: string;
  readonly decision?: string;
  readonly event: EventFrame;
}

export interface TerminalState {
  readonly kind: TerminalStateKind;
  readonly event: EventFrame;
  readonly reason?: string;
  readonly artifactRefs: readonly string[];
}

export interface FailureState {
  readonly kind: FailureKind;
  readonly messageKey: string;
  readonly reason?: string;
  readonly event: EventFrame;
}

export interface RawEvidenceAnchor {
  readonly source: "event" | "unknown_event";
  readonly run_id: string;
  readonly seq: number;
  readonly category: string;
  readonly name: string;
  readonly payload: unknown;
}

export interface ReplayTruncation {
  readonly truncated: true;
  readonly reason: string;
  readonly original_count?: number;
  readonly retained_count?: number;
}

export interface SanitizedEventSummary {
  readonly run_id: string;
  readonly seq: number;
  readonly category: string;
  readonly name: string;
  readonly agent_id?: string;
  readonly summary?: string;
  readonly summary_truncated?: boolean;
  readonly payload_preview?: string;
  readonly payload_truncated: boolean;
}

export interface SanitizedEvidenceAnchor {
  readonly source: RawEvidenceAnchor["source"];
  readonly run_id: string;
  readonly seq: number;
  readonly category: string;
  readonly name: string;
  readonly payload_preview?: string;
  readonly payload_truncated: boolean;
}

export interface HarnessTimelineEntry {
  readonly run_id: string;
  readonly seq: number;
  readonly label: string;
  readonly category: string;
  readonly name: string;
  readonly severity: HarnessTimelineSeverity;
  readonly agent_id?: string;
  readonly summary: string;
  readonly summary_truncated?: boolean;
}

export interface HarnessTimelineModel {
  readonly entries: readonly HarnessTimelineEntry[];
  readonly truncated?: ReplayTruncation;
}

export interface HarnessSessionContinuity {
  readonly run_id?: string;
  readonly observed_agent_ids: readonly string[];
  readonly selected_agent_id?: string;
  readonly runtime_surface?: string;
  readonly worker_session?: string;
  readonly attach_command?: string;
  readonly rerun_command?: string;
  readonly terminal_state?: TerminalStateKind;
  readonly owner_verified: OwnerVerificationState;
  readonly replay_created_at?: string;
  readonly can_continue: boolean;
  readonly can_rerun: boolean;
  readonly can_inspect: boolean;
  readonly can_copy: boolean;
  readonly replay_only: boolean;
  readonly reasons: readonly string[];
}

export interface HarnessOperatorAffordance {
  readonly id: HarnessOperatorAffordanceId;
  readonly label_key: MessageCatalogKey;
  readonly label: string;
  readonly state: HarnessAffordanceState;
  readonly reason_key: MessageCatalogKey;
  readonly reason_label: string;
  readonly reason?: string;
  readonly confirmation_required: boolean;
  readonly destructive: boolean;
  readonly focus_changing: boolean;
  readonly command_text?: string;
}

export interface HarnessReplayRenderState {
  readonly status: "live" | "replay";
  readonly created_at?: string;
  readonly summary: string;
}

export type MessageCatalogKey = string;

export interface InspectEvidenceRef {
  readonly ref: string;
  readonly run_id: string;
  readonly seq: number;
}

export interface InspectRow {
  readonly label: string;
  readonly value: string;
  readonly anchor?: string;
  readonly priority: "identity" | "critical" | "normal" | "optional";
  readonly kind?: "identity" | "failure" | "content";
}

export interface InspectSection {
  readonly title: string;
  readonly rows: readonly InspectRow[];
}

export interface InspectOutputDetail {
  readonly state: "captured" | "pending" | "unavailable";
  readonly text: string;
  readonly truncated?: boolean;
}

export interface InspectAgentDetail {
  readonly agent_id: string;
  readonly sections: readonly InspectSection[];
  readonly output: InspectOutputDetail;
  readonly evidenceRefs: readonly InspectEvidenceRef[];
}

export interface ChainNode {
  readonly id: string;
  readonly label: string;
  readonly skin: RoleSkinId;
  readonly state: "idle" | "active" | "done" | "failed" | "unknown";
  readonly agentId?: string;
}

export interface HarnessWorkspaceState {
  readonly locale: HarnessWorkspaceLocale;
  readonly provenance: HarnessWorkspaceProvenance;
  readonly previewLimit: number;
  readonly run: HarnessRunIdentity;
  readonly agents: Readonly<Record<string, DiscoveredAgent>>;
  readonly chain: readonly ChainNode[];
  readonly events: readonly EventFrame[];
  readonly latestEvent?: EventFrame;
  readonly unknownEvents: readonly EventFrame[];
  readonly rawEvidenceAnchors: readonly RawEvidenceAnchor[];
  readonly seenEventKeys: readonly string[];
  readonly workerAnchor?: WorkerAnchor;
  readonly workerPreview: WorkerPreview;
  readonly gate?: GateState;
  readonly approval?: ApprovalState;
  readonly terminal?: TerminalState;
  readonly artifactRefs: readonly string[];
  readonly failures: readonly FailureState[];
}

export interface RenderEvidenceSummary {
  readonly run_id?: string;
  readonly runtime_surface?: string;
  readonly worker_session?: string;
  readonly attach_command?: string;
  readonly owner_verified: OwnerVerificationState;
  readonly latest_event?: string;
  readonly gate?: {
    readonly gate_disposition?: string;
    readonly review_outcome?: string;
    readonly blocking_reason?: string;
  };
  readonly artifact_refs: readonly string[];
  readonly approval?: {
    readonly state: ApprovalState["state"];
    readonly approval_id?: string;
    readonly decision?: string;
  };
  readonly terminal?: {
    readonly state: TerminalStateKind;
    readonly reason?: string;
  };
  readonly provenance: HarnessWorkspaceProvenance;
  readonly provenance_caveat: string;
}

export interface HarnessOverviewModel {
  readonly mode: "overview";
  readonly title: string;
  readonly labels: Record<string, string>;
  readonly chain: readonly ChainNode[];
  readonly workerPreview: WorkerPreview;
  readonly evidence: RenderEvidenceSummary;
  readonly failures: readonly string[];
  readonly rawEvidenceAnchors: readonly RawEvidenceAnchor[];
  readonly replay?: HarnessReplayRenderState;
  readonly timeline?: HarnessTimelineModel;
  readonly continuity?: HarnessSessionContinuity;
  readonly operator_affordances?: readonly HarnessOperatorAffordance[];
}

export interface HarnessInspectModel extends Omit<HarnessOverviewModel, "mode"> {
  readonly mode: "inspect";
  readonly selectedAgentId?: string;
  readonly selectedAgent?: {
    readonly id: string;
    readonly status?: string;
    readonly roleSkin: RoleSkinId;
    readonly owner_verified: OwnerVerificationState;
    readonly runtime_surfaces: readonly RuntimeSurfaceRow[];
    readonly latestEvent?: EventFrame;
  };
  readonly inspect?: InspectAgentDetail;
  readonly empty: boolean;
}

export interface ReplayStoredOverviewSummary {
  readonly title: string;
  readonly mode: HarnessOverviewModel["mode"];
  readonly run_id?: string;
  readonly chain: readonly ChainNode[];
  readonly evidence: RenderEvidenceSummary;
  readonly evidence_truncated?: ReplayTruncation;
  readonly worker_preview?: string;
  readonly worker_preview_truncated: boolean;
  readonly terminal_state?: TerminalStateKind;
  readonly failures: readonly string[];
  readonly failures_truncated?: ReplayTruncation;
}

export interface ReplayStoredInspectSummary {
  readonly title: string;
  readonly mode: HarnessInspectModel["mode"];
  readonly selectedAgentId?: string;
  readonly empty: boolean;
}

export interface HarnessReplaySnapshotV1 {
  readonly schema_version: "HarnessReplaySnapshot.v1";
  readonly created_at: string;
  readonly run: HarnessRunIdentity;
  readonly locale: HarnessWorkspaceLocale;
  readonly provenance: HarnessWorkspaceProvenance;
  readonly events: readonly SanitizedEventSummary[];
  readonly events_truncated?: ReplayTruncation;
  readonly evidence: readonly SanitizedEvidenceAnchor[];
  readonly evidence_truncated?: ReplayTruncation;
  readonly overview: ReplayStoredOverviewSummary;
  readonly inspect?: ReplayStoredInspectSummary;
  readonly logs: HarnessTimelineModel;
  readonly operator_affordances: readonly HarnessOperatorAffordance[];
  readonly continuity: HarnessSessionContinuity;
}

export interface HarnessReplayRestoreResult {
  readonly snapshot: HarnessReplaySnapshotV1;
  readonly overview: HarnessOverviewModel;
  readonly inspect?: HarnessInspectModel;
  readonly timeline: HarnessTimelineModel;
  readonly continuity: HarnessSessionContinuity;
  readonly operator_affordances: readonly HarnessOperatorAffordance[];
}
