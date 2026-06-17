/**
 * Small internal shared helpers + type re-exports used across core modules.
 * Keeps a single `isObject` definition and avoids deep relative import churn.
 */

export type {
  JsonRpcError,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from "../runtime/jsonrpc.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
