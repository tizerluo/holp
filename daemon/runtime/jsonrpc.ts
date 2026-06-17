/**
 * JSON-RPC 2.0 types + construct/discriminate helpers.
 *
 * spec §1: 控制面 = stdio 上的 JSON-RPC 2.0。client→server 方法调用走标准
 * request/response(带 `id`);server→client 事件流走 notification(无 `id`)。
 * spec §10: error object = { code, message, data? }。
 *
 * Only the subset HOLP needs. We model `id` per JSON-RPC (string | number);
 * `null` id is permitted by the base spec for error responses to unparseable
 * requests, but HOLP requests always carry a string/number id, so request
 * helpers use `JsonRpcId`.
 */

export type JsonRpcId = string | number;

/** A client→server request (has `id` + `method`). */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

/** A server→client (or client→server) notification (no `id`). */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ---------------------------------------------------------------------------
// Discriminators
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** True iff `value` is a well-formed JSON-RPC 2.0 request (jsonrpc=2.0, id present, method is a string). */
export function isRequest(value: unknown): value is JsonRpcRequest {
  if (!isObject(value)) return false;
  if (value.jsonrpc !== "2.0") return false;
  if (typeof value.method !== "string") return false;
  const id = value.id;
  return typeof id === "string" || typeof id === "number";
}

/** True iff `value` is a well-formed JSON-RPC 2.0 notification (jsonrpc=2.0, method string, no id). */
export function isNotification(value: unknown): value is JsonRpcNotification {
  if (!isObject(value)) return false;
  if (value.jsonrpc !== "2.0") return false;
  if (typeof value.method !== "string") return false;
  return value.id === undefined;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function makeResult(id: JsonRpcId | null, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function makeError(
  id: JsonRpcId | null,
  error: JsonRpcError,
): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error };
}

export function makeNotification(method: string, params?: unknown): JsonRpcNotification {
  const n: JsonRpcNotification = { jsonrpc: "2.0", method };
  if (params !== undefined) n.params = params;
  return n;
}
