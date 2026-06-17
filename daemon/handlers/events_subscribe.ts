/**
 * `events.subscribe` handler — spec §5.
 *
 * - `categories` omitted/null → subscribe ALL categories (whitelist semantics).
 * - empty array [] OR an unknown category string → invalid_event_category
 *   (-32020). `categories` is a closed enum: run/agent/consensus/approval/lifecycle.
 * - `run_id` accepted as an opaque string; existence is NOT validated in M1a
 *   (orchestrate.run is PR3+). Heartbeats are not filtered by `categories`;
 *   `include_heartbeats` is recorded into the subscription.
 * - `after_seq` omitted → 0. Explicit values must be a non-negative integer
 *   because replay semantics are `seq > after_seq` and seq starts at 1.
 * - Returns { subscription_id, latest_seq }. M1a has no real event source, so
 *   latest_seq = 0 (empty-run sentinel; seq starts at 1, 0 = "no events yet").
 */

import { EVENT_CATEGORIES, isEventCategory } from "../core/context.js";
import type { EventCategory, Subscription } from "../core/context.js";
import { holpError, invalidRequest } from "../core/errors.js";
import { HolpRpcError } from "../core/dispatcher.js";
import { isObject } from "../core/internal.js";
import type { JsonRpcRequest } from "../runtime/jsonrpc.js";
import type { ConnectionContext } from "../core/context.js";

export function handleEventsSubscribe(req: JsonRpcRequest, ctx: ConnectionContext): unknown {
  const params = isObject(req.params) ? req.params : {};

  const runId = typeof params.run_id === "string" ? params.run_id : "";
  if (runId.length === 0) {
    throw new HolpRpcError(invalidRequest("events.subscribe: params.run_id (string) required"));
  }

  const categories = normalizeCategories(params.categories);

  const afterSeq = normalizeAfterSeq(params.after_seq);

  const includeHeartbeats = params.include_heartbeats === true;

  const subscriptionId = ctx.nextSubscriptionId();
  const subscription: Subscription = {
    subscriptionId,
    runId,
    categories,
    afterSeq,
    includeHeartbeats,
  };
  ctx.subscriptions.set(subscriptionId, subscription);

  // latest_seq: M1a has no event source; new run has produced nothing → 0.
  return { subscription_id: subscriptionId, latest_seq: 0 };
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
