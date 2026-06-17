import { describe, it, expect } from "vitest";
import { EventSink, makeEventNotification } from "./eventSink.js";

describe("EventSink (spec §5)", () => {
  it("constructs a valid events.event notification frame carrying subscription_id + seq", () => {
    const n = makeEventNotification({
      subscription_id: "sub_1",
      seq: 13,
      ts: 1718600001,
      category: "agent",
      name: "tool_called",
      run_id: "run_abc",
      payload: { tool: "edit" },
    });
    expect(n.jsonrpc).toBe("2.0");
    expect(n.method).toBe("events.event");
    // notification: no id field
    expect("id" in n).toBe(false);
    expect(n.params).toMatchObject({ subscription_id: "sub_1", seq: 13, category: "agent" });
  });

  it("sink.event / heartbeat / error each write one notification frame via the writer", () => {
    const out: unknown[] = [];
    const sink = new EventSink((frame) => out.push(frame));

    sink.event({
      subscription_id: "sub_1",
      seq: 1,
      ts: 1,
      category: "run",
      name: "run_started",
      run_id: "r",
      payload: {},
    });
    sink.heartbeat({ subscription_id: "sub_1", latest_seq: 12, ts: 2 });
    sink.error({ subscription_id: "sub_1", code: "slow_consumer", latest_seq: 12 });

    expect(out).toHaveLength(3);
    expect((out[0] as { method: string }).method).toBe("events.event");
    expect((out[1] as { method: string }).method).toBe("events.heartbeat");
    expect((out[2] as { method: string; params: { code: string } }).method).toBe("events.error");
    expect((out[2] as { params: { code: string } }).params.code).toBe("slow_consumer");
    // every event notification carries subscription_id (spec §1/§5)
    for (const frame of out) {
      expect((frame as { params: { subscription_id: string } }).params.subscription_id).toBe("sub_1");
    }
  });
});
