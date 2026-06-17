/**
 * Method registry + dispatch (spec §1, §10.1).
 *
 * Routes a parsed control-plane frame to a registered handler by method name.
 *   - malformed (not a well-formed request: missing jsonrpc / missing method)
 *     → -32600 invalid_request.
 *   - unknown method → -32601 method not found.
 *   - handler returns a result → success response; handler returns/throws a
 *     JsonRpcError → error response; unexpected throw → -32099 internal_error.
 *
 * Notifications (client→server, no id) are accepted but produce no response
 * (returns void). M1a's three handlers are all request/response, so in practice
 * every dispatched frame is a request.
 */

import {
  isObject,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./internal.js";
import { isRequest, makeError, makeResult } from "../runtime/jsonrpc.js";
import { holpError, invalidRequest, methodNotFound } from "./errors.js";
import type { ConnectionContext } from "./context.js";

/** A method handler. May return a result, return a JsonRpcError, or throw. */
export type MethodHandler = (
  req: JsonRpcRequest,
  ctx: ConnectionContext,
) => unknown | Promise<unknown>;

/** Thrown by handlers to map to a specific JSON-RPC error response. */
export class HolpRpcError extends Error {
  constructor(public readonly rpc: JsonRpcError) {
    super(rpc.message);
    this.name = "HolpRpcError";
  }
}

export class Dispatcher {
  private readonly handlers = new Map<string, MethodHandler>();

  constructor(private readonly ctx: ConnectionContext) {}

  register(method: string, handler: MethodHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  /**
   * Dispatch one parsed frame. Returns a response for requests, or undefined
   * for notifications / unrecoverable malformed frames with no usable id.
   */
  async dispatch(frame: unknown): Promise<JsonRpcResponse | undefined> {
    // Malformed: not a well-formed request (missing jsonrpc / missing method /
    // missing id). spec §10.1: request 本身格式非法 → -32600 invalid_request.
    if (!isRequest(frame)) {
      const id = extractId(frame);
      // A notification (valid jsonrpc + method, no id) gets no response.
      if (isLikelyNotification(frame)) return undefined;
      return makeError(id, invalidRequest("malformed request: missing jsonrpc/method/id"));
    }

    const handler = this.handlers.get(frame.method);
    if (!handler) {
      return makeError(frame.id, methodNotFound(frame.method));
    }

    // Handshake gate (spec §2): initialize must be the first message. Every other
    // method is rejected until the connection is initialized. There is no
    // dedicated HOLP code for out-of-order calls, so a malformed-sequence client
    // request maps to -32600 invalid_request (spec §10.1). Non-initialize
    // notifications were already dropped above (they carry no id), so only
    // requests (id present) reach here.
    if (frame.method !== "initialize" && !this.ctx.initialized) {
      return makeError(
        frame.id,
        invalidRequest(`method '${frame.method}' requires initialize first`),
      );
    }

    try {
      const result = await handler(frame, this.ctx);
      // A handler may return a JsonRpcError object directly to signal failure.
      if (isJsonRpcError(result)) {
        return makeError(frame.id, result);
      }
      return makeResult(frame.id, result ?? null);
    } catch (err) {
      if (err instanceof HolpRpcError) {
        return makeError(frame.id, err.rpc);
      }
      if (isJsonRpcError(err)) {
        return makeError(frame.id, err);
      }
      const message = err instanceof Error ? err.message : String(err);
      return makeError(frame.id, holpError("internal_error", message));
    }
  }
}

function isJsonRpcError(value: unknown): value is JsonRpcError {
  return (
    isObject(value) &&
    typeof value.code === "number" &&
    typeof value.message === "string"
  );
}

/** Best-effort id extraction for malformed frames (so the error response is correlatable). */
function extractId(frame: unknown): JsonRpcRequest["id"] | null {
  if (isObject(frame)) {
    const id = frame.id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return null;
}

/** A frame that is a valid notification (jsonrpc=2.0, method string, no id). */
function isLikelyNotification(frame: unknown): boolean {
  return (
    isObject(frame) &&
    frame.jsonrpc === "2.0" &&
    typeof frame.method === "string" &&
    frame.id === undefined
  );
}
