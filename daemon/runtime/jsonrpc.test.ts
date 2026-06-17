import { describe, it, expect } from "vitest";
import {
  isRequest,
  isNotification,
  makeResult,
  makeError,
  makeNotification,
} from "./jsonrpc.js";

describe("jsonrpc discriminators", () => {
  it("isRequest accepts a well-formed request and rejects notifications/garbage", () => {
    expect(isRequest({ jsonrpc: "2.0", id: 1, method: "initialize" })).toBe(true);
    expect(isRequest({ jsonrpc: "2.0", id: "a", method: "x" })).toBe(true);
    // notification (no id)
    expect(isRequest({ jsonrpc: "2.0", method: "events.event" })).toBe(false);
    // missing method
    expect(isRequest({ jsonrpc: "2.0", id: 1 })).toBe(false);
    // wrong jsonrpc
    expect(isRequest({ jsonrpc: "1.0", id: 1, method: "x" })).toBe(false);
    expect(isRequest(null)).toBe(false);
    expect(isRequest("nope")).toBe(false);
  });

  it("isNotification requires method + absence of id", () => {
    expect(isNotification({ jsonrpc: "2.0", method: "events.event" })).toBe(true);
    expect(isNotification({ jsonrpc: "2.0", id: 1, method: "x" })).toBe(false);
    expect(isNotification({ jsonrpc: "2.0" })).toBe(false);
  });
});

describe("jsonrpc constructors", () => {
  it("makeResult / makeError shape", () => {
    expect(makeResult(7, { ok: true })).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
    expect(makeError(7, { code: -32601, message: "x" })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "x" },
    });
  });

  it("makeNotification omits params when undefined", () => {
    expect(makeNotification("events.heartbeat")).toEqual({
      jsonrpc: "2.0",
      method: "events.heartbeat",
    });
    expect(makeNotification("events.event", { seq: 1 })).toEqual({
      jsonrpc: "2.0",
      method: "events.event",
      params: { seq: 1 },
    });
  });
});
