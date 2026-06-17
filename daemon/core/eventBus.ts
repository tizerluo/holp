/**
 * Per-run event bus: stores events, manages seq, fans out to subscribers.
 *
 * spec §5:
 *   - seq starts at 1, monotonic, unique within the run.
 *   - after_seq:0 = replay from the start (first event seq=1 > 0).
 *   - latest_seq in subscribe response = current max seq (0 if none yet).
 *   - Replay: for each subscriber, replay stored events with seq > sub.afterSeq
 *     matching the category filter.
 *   - Live delivery: each publish fans out to all active subscribers (with filter).
 *
 * The bus is the source of truth for seq and stored events.
 * EventSink is the wire-layer writer; the bus calls it.
 */

import type { Clock } from "./clock.js";
import type { EventCategory } from "./context.js";
import type { EventSink } from "./eventSink.js";

export interface StoredEvent {
  readonly seq: number;
  readonly ts: number;
  readonly category: EventCategory;
  readonly name: string;
  readonly payload: unknown;
}

/** A subscriber registered on this bus (carries its own filter state). */
export interface BusSubscriber {
  readonly subscriptionId: string;
  readonly categories: readonly EventCategory[] | null;
  readonly sink: EventSink;
}

export class EventBus {
  private events: StoredEvent[] = [];
  private seq = 0;
  private subscribers: BusSubscriber[] = [];

  constructor(
    readonly runId: string,
    private readonly clock: Clock,
  ) {}

  /** Current maximum seq (0 if no events have been published). */
  get latestSeq(): number {
    return this.seq;
  }

  /**
   * Publish a new event. Assigns the next seq, stores it, fans out to all
   * active subscribers that pass the category filter.
   */
  publish(category: EventCategory, name: string, payload: unknown): StoredEvent {
    this.seq += 1;
    const event: StoredEvent = {
      seq: this.seq,
      ts: this.clock.now(),
      category,
      name,
      payload,
    };
    this.events.push(event);

    for (const sub of this.subscribers) {
      if (matchesFilter(event, sub.categories)) {
        sub.sink.event({
          subscription_id: sub.subscriptionId,
          seq: event.seq,
          ts: event.ts,
          category: event.category,
          name: event.name,
          run_id: this.runId,
          payload: event.payload,
        });
      }
    }

    return event;
  }

  /**
   * Register a subscriber. Immediately replays stored events with seq > afterSeq
   * that pass the category filter, then registers for live delivery.
   */
  addSubscriber(sub: BusSubscriber, afterSeq: number): void {
    // Replay first, then register for live.
    for (const event of this.events) {
      if (event.seq > afterSeq && matchesFilter(event, sub.categories)) {
        sub.sink.event({
          subscription_id: sub.subscriptionId,
          seq: event.seq,
          ts: event.ts,
          category: event.category,
          name: event.name,
          run_id: this.runId,
          payload: event.payload,
        });
      }
    }
    this.subscribers.push(sub);
  }

  /** Remove a subscriber (unsubscribe). */
  removeSubscriber(subscriptionId: string): void {
    this.subscribers = this.subscribers.filter((s) => s.subscriptionId !== subscriptionId);
  }

  /** All stored events (for in-process test assertions). */
  allEvents(): readonly StoredEvent[] {
    return this.events;
  }
}

function matchesFilter(
  event: StoredEvent,
  categories: readonly EventCategory[] | null,
): boolean {
  if (categories === null) return true;
  return categories.includes(event.category);
}
