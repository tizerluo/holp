/**
 * HOLP error model — spec §10 + catalog.md (c).
 *
 * JSON-RPC error object: { code, message, data? }. HOLP-specific codes live in
 * the reserved range -32000..-32099, one error one code (machine handling needs
 * no message parsing). Standard JSON-RPC -32600/-32601 are also used by the
 * dispatcher (catalog "HOLP 也用的 JSON-RPC 标准错误码").
 *
 * All HOLP codes are defined as named constants here so later milestones can
 * reference them by name; M1a only actually triggers a subset (see PR SPEC).
 */

import type { JsonRpcError } from "../runtime/jsonrpc.js";

/** Stable name for each HOLP error, mirrored from spec §10 / catalog (c). */
export type HolpErrorName =
  | "protocol_version_mismatch"
  | "capability_required_but_unsupported"
  | "approval_required_but_unsupported"
  | "quorum_unsatisfiable"
  | "unsupported_transport"
  | "missing_auth"
  | "invalid_quorum"
  | "run_not_found"
  | "approval_not_found"
  | "approval_already_resolved"
  | "lease_stolen"
  | "run_locked"
  | "unsupported_execution_mode"
  | "artifact_not_found"
  | "artifact_expired"
  | "artifact_forbidden"
  | "invalid_subscription"
  | "role_unsupported"
  | "agent_not_found"
  | "invalid_event_category"
  | "isolation_profile_rejected"
  | "internal_error";

/** HOLP-specific JSON-RPC error codes (-32001..-32020, +-32099 fallback). */
export const HOLP_ERROR_CODES = {
  protocol_version_mismatch: -32001,
  capability_required_but_unsupported: -32002,
  approval_required_but_unsupported: -32003,
  quorum_unsatisfiable: -32004,
  unsupported_transport: -32005,
  missing_auth: -32006,
  invalid_quorum: -32007,
  run_not_found: -32008,
  approval_not_found: -32009,
  approval_already_resolved: -32010,
  lease_stolen: -32011,
  run_locked: -32012,
  unsupported_execution_mode: -32013,
  artifact_not_found: -32014,
  artifact_expired: -32015,
  artifact_forbidden: -32016,
  invalid_subscription: -32017,
  role_unsupported: -32018,
  agent_not_found: -32019,
  invalid_event_category: -32020,
  isolation_profile_rejected: -32021,
  internal_error: -32099,
} as const satisfies Record<HolpErrorName, number>;

/** Standard JSON-RPC codes the dispatcher emits (spec §10.1 / catalog (c)). */
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/** Default human-readable message per HOLP error (machine handling uses code). */
const DEFAULT_MESSAGES: Record<HolpErrorName, string> = {
  protocol_version_mismatch: "protocol version mismatch",
  capability_required_but_unsupported: "a required capability is unsupported by the peer",
  approval_required_but_unsupported: "run requires approval but client does not support it",
  quorum_unsatisfiable: "quorum cannot be satisfied",
  unsupported_transport: "no adapter for agent transport",
  missing_auth: "agent credential probe failed",
  invalid_quorum: "invalid quorum shape",
  run_not_found: "run not found",
  approval_not_found: "approval not found",
  approval_already_resolved: "approval already in a terminal state",
  lease_stolen: "lease stolen by a concurrent holder",
  run_locked: "run is locked",
  unsupported_execution_mode: "unsupported execution_mode.kind",
  artifact_not_found: "artifact not found",
  artifact_expired: "artifact expired",
  artifact_forbidden: "artifact access forbidden",
  invalid_subscription: "invalid subscription_id",
  role_unsupported: "role not in agent resolved_roles",
  agent_not_found: "agent not in this connection's flock",
  invalid_event_category: "categories empty or contains unknown category",
  isolation_profile_rejected: "agent isolation profile is unavailable",
  internal_error: "internal error",
};

/**
 * Build a HOLP JSON-RPC error object by name. Message defaults to the spec
 * description for that code but may be overridden; `data` is optional.
 */
export function holpError(
  name: HolpErrorName,
  message?: string,
  data?: unknown,
): JsonRpcError {
  const error: JsonRpcError = {
    code: HOLP_ERROR_CODES[name],
    message: message ?? DEFAULT_MESSAGES[name],
  };
  if (data !== undefined) error.data = data;
  return error;
}

/** Standard JSON-RPC invalid_request (-32600). */
export function invalidRequest(message = "invalid request", data?: unknown): JsonRpcError {
  const error: JsonRpcError = { code: JSONRPC_INVALID_REQUEST, message };
  if (data !== undefined) error.data = data;
  return error;
}

/** Standard JSON-RPC method not found (-32601). */
export function methodNotFound(method: string): JsonRpcError {
  return {
    code: JSONRPC_METHOD_NOT_FOUND,
    message: `method not found: ${method}`,
    data: { method },
  };
}
