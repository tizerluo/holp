import { describe, expect, it } from "vitest";
import { EventBus } from "./eventBus.js";
import { FakeClock } from "./clock.js";
import { isKnownEventName } from "./eventContract.js";

describe("event contract registry", () => {
  it("accepts legacy event names and contains workflow multi-step names", () => {
    expect(isKnownEventName("run", "run_started")).toBe(true);
    expect(isKnownEventName("approval", "approval_requested")).toBe(true);
    expect(isKnownEventName("consensus", "consensus_verdict")).toBe(true);
    expect(isKnownEventName("gate", "gate_report")).toBe(true);
    expect(isKnownEventName("lifecycle", "workflow_step_planned")).toBe(true);
  });

  it("rejects unknown published names before mutating the bus", () => {
    const bus = new EventBus("run_contract", new FakeClock());

    expect(() => bus.publish("run", "workflow_step_planned", {})).toThrow(
      "unknown event 'run.workflow_step_planned'",
    );
    expect(() => bus.publish("gate", "gate_overridden", {})).toThrow(
      "unknown event 'gate.gate_overridden'",
    );
    expect(bus.latestSeq).toBe(0);
    expect(bus.allEvents()).toHaveLength(0);

    bus.publish("run", "run_started", {});
    expect(bus.latestSeq).toBe(1);
    expect(bus.allEvents().map((event) => event.name)).toEqual(["run_started"]);
  });
});
