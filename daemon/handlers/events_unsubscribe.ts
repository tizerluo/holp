/**
 * `events.unsubscribe` handler — spec §5.
 *
 * - known subscription_id → { subscription_id, unsubscribed:true } (and the
 *   subscription is removed from connection state).
 * - unknown subscription_id (never issued, or already cancelled) →
 *   invalid_subscription (-32017).
 */

import { holpError } from "../core/errors.js";
import { HolpRpcError } from "../core/dispatcher.js";
import { isObject } from "../core/internal.js";
import type { JsonRpcRequest } from "../runtime/jsonrpc.js";
import type { ConnectionContext } from "../core/context.js";

export function handleEventsUnsubscribe(req: JsonRpcRequest, ctx: ConnectionContext): unknown {
  const params = isObject(req.params) ? req.params : {};
  const subscriptionId = params.subscription_id;

  if (typeof subscriptionId !== "string" || !ctx.subscriptions.has(subscriptionId)) {
    throw new HolpRpcError(
      holpError("invalid_subscription", `unknown subscription_id: ${String(subscriptionId)}`, {
        subscription_id: subscriptionId,
      }),
    );
  }

  ctx.subscriptions.delete(subscriptionId);
  return { subscription_id: subscriptionId, unsubscribed: true };
}
