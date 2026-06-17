/**
 * `events.subscribe` handler — spec §5.
 *
 * - `categories` omitted/null → subscribe ALL categories (whitelist semantics).
 * - empty array [] OR an unknown category string → invalid_event_category
 *   (-32020). `categories` is a closed enum: run/agent/consensus/approval/lifecycle.
 * - `run_id`: validated against the connection's run store in M1b.
 * - `after_seq` omitted → 0. Explicit values must be a non-negative integer
 *   because replay semantics are `seq > after_seq` and seq starts at 1.
 * - Returns { subscription_id, latest_seq } where latest_seq = current max seq
 *   for the run (0 if no events yet — §5 empty sentinel).
 * - Replay: stored events with seq > after_seq matching the category filter are
 *   immediately sent to the subscriber before registration for live delivery.
 *
 * M1b: real replay via EventBus. run_id existence is validated (orchestrate.run
 * populates ctx.runs; unknown run_id → invalidRequest).
 */

import { EVENT_CATEGORIES, isEventCategory } from "../core/context.js";
import type { EventCategory, Subscription } from "../core/context.js";
import { holpError, invalidRequest } from "../core/errors.js";
import { HolpRpcError } from "../core/dispatcher.js";
import { isObject } from "../core/internal.js";
import type { JsonRpcRequest } from "../runtime/jsonrpc.js";
import type { ConnectionContext } from "../core/context.js";
import type { EventSink } from "../core/eventSink.js";
import type { BusSubscriber } from "../core/eventBus.js";

export function handleEventsSubscribe(
  req: JsonRpcRequest,
  ctx: ConnectionContext,
  sink?: EventSink,
): unknown {
  const params = isObject(req.params) ? req.params : {};

  const runId = typeof params.run_id === "string" ? params.run_id : "";
  if (runId.length === 0) {
    throw new HolpRpcError(invalidRequest("events.subscribe: params.run_id (string) required"));
  }

  const categories = normalizeCategories(params.categories);
  const afterSeq = normalizeAfterSeq(params.after_seq);
  const includeHeartbeats = params.include_heartbeats === true;

  // M1b: validate that the run_id exists before allocating any subscription state.
  const run = ctx.runs.get(runId);
  if (!run) {
    throw new HolpRpcError(
      holpError("run_not_found", `run '${runId}' not found`, { run_id: runId }),
    );
  }

  const subscriptionId = ctx.nextSubscriptionId();
  const subscription: Subscription = {
    subscriptionId,
    runId,
    categories,
    afterSeq,
    includeHeartbeats,
  };
  ctx.subscriptions.set(subscriptionId, subscription);

  // Register for replay + live delivery if a sink is available.
  if (sink) {
    const busSub: BusSubscriber = {
      subscriptionId,
      categories,
      sink,
    };
    run.bus.addSubscriber(busSub, afterSeq);
  }

  return { subscription_id: subscriptionId, latest_seq: run.bus.latestSeq };
}

/**
 * Normalize the `categories` param to either null (subscribe all) or a
 * validated non-empty list. Throws invalid_event_category for [] or unknown.
 */
function normalizeCategories(value: unknown): readonly EventCategory[] | null {
  // Omitted or explicit null → subscribe all.
  if (value === undefined || value === null) return null;

  if (!Array.isArray(value)) {
    throw new HolpRpcError(
      holpError("invalid_event_category", "categories must be an array, null, or omitted", {
        allowed: EVENT_CATEGORIES,
      }),
    );
  }

  // Empty array → reject (this is NOT "subscribe all"; that's null/omitted).
  if (value.length === 0) {
    throw new HolpRpcError(
      holpError("invalid_event_category", "categories must not be an empty array", {
        allowed: EVENT_CATEGORIES,
      }),
    );
  }

  for (const c of value) {
    if (!isEventCategory(c)) {
      throw new HolpRpcError(
        holpError("invalid_event_category", `unknown event category: ${String(c)}`, {
          allowed: EVENT_CATEGORIES,
          got: c,
        }),
      );
    }
  }

  return value as EventCategory[];
}

/** Normalize `after_seq`: omitted/null = 0; explicit value must be a non-negative integer. */
function normalizeAfterSeq(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new HolpRpcError(
    invalidRequest("events.subscribe: params.after_seq must be a non-negative integer"),
  );
}
