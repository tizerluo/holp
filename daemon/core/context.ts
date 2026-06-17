/**
 * In-memory per-connection context.
 *
 * spec: flock is 连接级会话状态,不跨连接共享(§4.2);capability negotiation
 * result is fixed at `initialize` (§2); subscriptions + seq are run-scoped (§5).
 *
 * M1a holds the *shape* of this state. Run records, artifact records, and flock
 * are placeholders — the methods that populate them (orchestrate.run, flock.*,
 * artifact.get) are out of scope for this PR.
 */

import type { NegotiatedCapabilities } from "./capabilities.js";

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
   * flock placeholder — populated by flock.declare/discover (out of M1a scope).
   * Held as an opaque map so later PRs can fill it without changing this shape.
   */
  readonly flock: Map<string, unknown> = new Map();

  /** Active subscriptions, keyed by subscription_id (§5). */
  readonly subscriptions: Map<string, Subscription> = new Map();

  /** run records placeholder — orchestrate.run is PR3+. */
  readonly runs: Map<string, unknown> = new Map();

  /** artifact records placeholder — artifact.get is out of M1a scope. */
  readonly artifacts: Map<string, unknown> = new Map();

  private subscriptionCounter = 0;

  /** Monotonic per-connection subscription id generator: sub_1, sub_2, ... */
  nextSubscriptionId(): string {
    this.subscriptionCounter += 1;
    return `sub_${this.subscriptionCounter}`;
  }
}
