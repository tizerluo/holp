import { describe, it, expect } from "vitest";
import { ConnectionContext } from "./context.js";
import { Dispatcher, HolpRpcError } from "./dispatcher.js";
import {
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  HOLP_ERROR_CODES,
  holpError,
} from "./errors.js";
import type { JsonRpcErrorResponse, JsonRpcSuccessResponse } from "../runtime/jsonrpc.js";

function newDispatcher() {
  const ctx = new ConnectionContext();
  return new Dispatcher(ctx);
}

describe("Dispatcher routing (spec §1 / §10.1)", () => {
  it("routes a known method and wraps the result", async () => {
    const d = newDispatcher().register("ping", () => ({ pong: true }));
    const res = (await d.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    })) as JsonRpcSuccessResponse;
    expect(res).toEqual({ jsonrpc: "2.0", id: 1, result: { pong: true } });
  });

  it("unknown method → -32601 method not found", async () => {
    const d = newDispatcher();
    const res = (await d.dispatch({
      jsonrpc: "2.0",
      id: 9,
      method: "orchestrate.run",
    })) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(JSONRPC_METHOD_NOT_FOUND);
    expect(res.error.code).toBe(-32601);
    expect(res.id).toBe(9);
  });

  it("missing method → -32600 invalid_request (id preserved when present)", async () => {
    const d = newDispatcher();
    const res = (await d.dispatch({ jsonrpc: "2.0", id: 3 })) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(JSONRPC_INVALID_REQUEST);
    expect(res.id).toBe(3);
  });

  it("missing jsonrpc → -32600 invalid_request", async () => {
    const d = newDispatcher();
    const res = (await d.dispatch({ id: 4, method: "initialize" })) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(JSONRPC_INVALID_REQUEST);
  });

  it("garbage frame (non-object) → -32600 invalid_request with null id", async () => {
    const d = newDispatcher();
    const res = (await d.dispatch("not a frame")) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(JSONRPC_INVALID_REQUEST);
    expect(res.id).toBeNull();
  });

  it("a notification (valid jsonrpc+method, no id) produces no response", async () => {
    const d = newDispatcher().register("noop", () => ({}));
    const res = await d.dispatch({ jsonrpc: "2.0", method: "events.event" });
    expect(res).toBeUndefined();
  });

  it("handler throwing HolpRpcError maps to that error code", async () => {
    const d = newDispatcher().register("boom", () => {
      throw new HolpRpcError(holpError("invalid_subscription"));
    });
    const res = (await d.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "boom",
    })) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(HOLP_ERROR_CODES.invalid_subscription);
  });

  it("handler throwing an unexpected error maps to -32099 internal_error", async () => {
    const d = newDispatcher().register("crash", () => {
      throw new Error("kaboom");
    });
    const res = (await d.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "crash",
    })) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(HOLP_ERROR_CODES.internal_error);
    expect(res.error.message).toContain("kaboom");
  });
});
