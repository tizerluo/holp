/**
 * Typed per-connection stores for M1b.
 *
 * All stores are connection-scoped (flock is §4.2 connection-level).
 * These replace the opaque Map<string, unknown> placeholders in ConnectionContext.
 */

import type { AgentBackend } from "../../adapters/agent-backend.js";
import type { EventBus } from "./eventBus.js";

// ---------------------------------------------------------------------------
// Flock (§3 / §4.2)
// ---------------------------------------------------------------------------

/** Status of a declared/discovered agent (per spec §3.3). */
export type AgentStatus = "ready" | "degraded" | "rejected";

/** Per-agent flock record stored on the connection after flock.declare/discover. */
export interface FlockAgent {
  readonly id: string;
  readonly transport: string;
  readonly status: AgentStatus;
  readonly version?: string;
  readonly logged_in?: boolean;
  readonly resolved_roles: readonly string[];
  readonly missing?: readonly string[];
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Artifact store (§8)
// ---------------------------------------------------------------------------

/** Artifact envelope (§8.1). */
export interface ArtifactEnvelope {
  readonly artifact_id: string;
  readonly type: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly created_by: string;
  readonly created_at: number;
  readonly expires_at?: number;
}

/** Stored artifact record. */
export interface ArtifactRecord {
  readonly envelope: ArtifactEnvelope;
  /** UTF-8 text or base64-encoded binary string. */
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Approval store (§7)
// ---------------------------------------------------------------------------

/** Terminal states of an approval. */
export type ApprovalState = "pending" | "resolved" | "expired" | "cancelled";

/** Pending approval record: holds the Promise resolve fn so the backend resumes on resolve. */
export interface ApprovalRecord {
  readonly approval_id: string;
  readonly run_id: string;
  readonly kind: string;
  readonly reason: string;
  readonly expires_at: number;
  state: ApprovalState;
  decision?: "approved" | "rejected";
  by?: string;
  /** Resolves the Promise the fake backend is awaiting. */
  readonly resumeBackend: (decision: "allow" | "deny") => void;
}

// ---------------------------------------------------------------------------
// Run store (§4 / §5)
// ---------------------------------------------------------------------------

/** Terminal or active run status. */
export type RunStatus = "active" | "merged" | "gave_up" | "cancelled";

/** Per-run record. */
export interface RunRecord {
  readonly run_id: string;
  readonly goal: string;
  readonly trigger: string;
  status: RunStatus;
  /** Backend handle for the coder agent. */
  backend?: AgentBackend;
  /** Backend session id returned by startSession. */
  sessionId?: string;
  /** Per-run event bus — replay + live delivery. */
  readonly bus: EventBus;
  /** Pending approval ids (for task.cancel to drain). */
  readonly pendingApprovals: Set<string>;
  /** Monotonic per-run counter for deterministic approval id generation. */
  approvalSeq: number;
}
