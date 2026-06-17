/**
 * Event sink — server→client event notifications (spec §5 / §6.1 / §7).
 *
 * Three notification methods, each carrying `subscription_id` so multi-sub,
 * cancel, and error attribution have clean semantics (§1):
 *   - events.event      { subscription_id, seq, ts, category, name, run_id, payload }
 *   - events.heartbeat  { subscription_id, latest_seq, ts }
 *   - events.error      { subscription_id, code, latest_seq }  (slow_consumer → 关订阅)
 *
 * M1a provides the abstraction + the ability to construct a valid frame and
 * send it via the writer. There is no real run/event source pushing yet (§5):
 * orchestrate.run is PR3+, so nothing increments seq during M1a.
 */

import { makeNotification } from "../runtime/jsonrpc.js";
import type { JsonRpcNotification } from "../runtime/jsonrpc.js";
import type { EventCategory } from "./context.js";
import type { FrameWriter } from "../runtime/ndjson.js";

/** Payload of an events.event notification (§5). seq is monotonic, starts at 1. */
export interface EventNotificationParams {
  subscription_id: string;
  seq: number;
  ts: number;
  category: EventCategory;
  name: string;
  run_id: string;
  payload: unknown;
}

export interface HeartbeatParams {
  subscription_id: string;
  latest_seq: number;
  ts: number;
}

/** events.error backpressure code. M1a only models slow_consumer (§5). */
export type EventErrorCode = "slow_consumer";

export interface EventErrorParams {
  subscription_id: string;
  code: EventErrorCode;
  latest_seq: number;
}

export function makeEventNotification(params: EventNotificationParams): JsonRpcNotification {
  return makeNotification("events.event", params);
}

export function makeHeartbeatNotification(params: HeartbeatParams): JsonRpcNotification {
  return makeNotification("events.heartbeat", params);
}

export function makeEventErrorNotification(params: EventErrorParams): JsonRpcNotification {
  return makeNotification("events.error", params);
}

/**
 * EventSink wraps a FrameWriter and exposes typed senders. Each method
 * constructs the notification frame and writes it to the transport.
 */
export class EventSink {
  constructor(private readonly write: FrameWriter) {}

  event(params: EventNotificationParams): void {
    this.write(makeEventNotification(params));
  }

  heartbeat(params: HeartbeatParams): void {
    this.write(makeHeartbeatNotification(params));
  }

  /** Send a backpressure error (slow_consumer); caller is responsible for closing the subscription. */
  error(params: EventErrorParams): void {
    this.write(makeEventErrorNotification(params));
  }
}
