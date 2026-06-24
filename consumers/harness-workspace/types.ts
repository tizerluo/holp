import type { EventFrame } from "../cli/wire.js";

export type HarnessWorkspaceLocale = "en-US" | "zh-CN";
export type HarnessWorkspaceProvenance = "smoke_script" | "unknown";
export type RoleSkinId = "CTRL" | "CODE" | "TEST" | "REV" | "ARCH" | "GATE";
export type OwnerVerificationState = "verified" | "unverified" | "unknown";
export type TerminalStateKind = "merged" | "blocked" | "gave_up" | "cancelled";
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
  readonly empty: boolean;
}
