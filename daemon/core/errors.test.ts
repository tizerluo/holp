import { describe, it, expect } from "vitest";
import {
  HOLP_ERROR_CODES,
  holpError,
  invalidRequest,
  methodNotFound,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
} from "./errors.js";

describe("HOLP error codes", () => {
  it("maps the M1a-relevant names to their spec §10 codes", () => {
    expect(HOLP_ERROR_CODES.protocol_version_mismatch).toBe(-32001);
    expect(HOLP_ERROR_CODES.capability_required_but_unsupported).toBe(-32002);
    expect(HOLP_ERROR_CODES.invalid_subscription).toBe(-32017);
    expect(HOLP_ERROR_CODES.invalid_event_category).toBe(-32020);
    expect(HOLP_ERROR_CODES.internal_error).toBe(-32099);
  });

  it("defines all 21 HOLP codes in -32001..-32020 plus -32099, each unique", () => {
    const codes = Object.values(HOLP_ERROR_CODES);
    expect(codes.length).toBe(21);
    expect(new Set(codes).size).toBe(21); // one error one code
    const sorted = [...codes].sort((a, b) => a - b);
    expect(sorted[0]).toBe(-32099);
    expect(sorted[1]).toBe(-32020);
    expect(sorted[sorted.length - 1]).toBe(-32001);
  });

  it("holpError carries code + default message + optional data", () => {
    const e = holpError("invalid_event_category");
    expect(e.code).toBe(-32020);
    expect(typeof e.message).toBe("string");
    expect(e.data).toBeUndefined();

    const withData = holpError("protocol_version_mismatch", "custom", { client: "1.0" });
    expect(withData.code).toBe(-32001);
    expect(withData.message).toBe("custom");
    expect(withData.data).toEqual({ client: "1.0" });
  });

  it("standard JSON-RPC error helpers", () => {
    expect(invalidRequest().code).toBe(JSONRPC_INVALID_REQUEST);
    expect(invalidRequest().code).toBe(-32600);
    const mnf = methodNotFound("orchestrate.run");
    expect(mnf.code).toBe(JSONRPC_METHOD_NOT_FOUND);
    expect(mnf.code).toBe(-32601);
    expect(mnf.data).toEqual({ method: "orchestrate.run" });
  });
});
