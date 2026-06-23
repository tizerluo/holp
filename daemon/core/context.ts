/**
 * In-memory per-connection context.
 *
 * spec: flock is 连接级会话状态,不跨连接共享(§4.2);capability negotiation
 * result is fixed at `initialize` (§2); subscriptions + seq are run-scoped (§5).
 *
 * M1b: typed stores for flock, runs, artifacts, and approvals now populated by
 * the new handlers (flock.declare, orchestrate.run, approval.resolve, etc.).
 */

import type { NegotiatedCapabilities } from "./capabilities.js";
import type { FlockAgent, RunRecord, ArtifactRecord, ApprovalRecord } from "./stores.js";
import { GovernanceStore } from "./governance.js";

/** A live event subscription (spec §5). seq starts at 1; 0 is the empty sentinel. */
export interface Subscription {
  readonly subscriptionId: string;
  /** Opaque run id (existence NOT validated in M1a — orchestrate.run is PR3+). */
  readonly runId: string;
  /** Subscribe-all when null (categories omitted/null → all categories). */
  readonly categories: readonly EventCategory[] | null;
  /** Only deliver events with seq > afterSeq. 0 = replay from the start. */
  readonly afterSeq: number;
  readonly includeHeartbeats: boolean;
}

/** Closed enum of event categories (spec §5; catalog (b)). */
export const EVENT_CATEGORIES = [
  "run",
  "agent",
  "consensus",
  "approval",
  "gate",
  "lifecycle",
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export function isEventCategory(value: unknown): value is EventCategory {
  return typeof value === "string" && (EVENT_CATEGORIES as readonly string[]).includes(value);
}

/** Result of `initialize` capability negotiation; null until initialized. */
export interface InitializedState {
  readonly protocolVersion: string;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly negotiated: NegotiatedCapabilities;
}

/**
 * Per-connection mutable state. One instance per stdio connection.
 */
export class ConnectionContext {
  /** Null until `initialize` succeeds. */
  initialized: InitializedState | null = null;

  /**
   * Flock: per-agent records populated by flock.declare/discover (§3 / §4.2).
   * Connection-scoped; not shared across connections.
   */
  readonly flock: Map<string, FlockAgent> = new Map();

  /** Active subscriptions, keyed by subscription_id (§5). */
  readonly subscriptions: Map<string, Subscription> = new Map();

  /** Run records populated by orchestrate.run (§4 / §5). */
  readonly runs: Map<string, RunRecord> = new Map();

  /** Artifact records populated during run execution (§8). */
  readonly artifacts: Map<string, ArtifactRecord> = new Map();

  /** Approval records keyed by approval_id (§7). */
  readonly approvals: Map<string, ApprovalRecord> = new Map();

  /** Internal M4a governance state: events, decisions, registry snapshots, run lifecycle. */
  readonly governance: GovernanceStore = new GovernanceStore();

  private subscriptionCounter = 0;

  /** Monotonic per-connection subscription id generator: sub_1, sub_2, ... */
  nextSubscriptionId(): string {
    this.subscriptionCounter += 1;
    return `sub_${this.subscriptionCounter}`;
  }
}
