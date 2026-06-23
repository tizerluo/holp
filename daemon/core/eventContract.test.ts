import { describe, expect, it } from "vitest";
import {
  assertDefaultSingleStepEventAllowed,
  isKnownEventName,
} from "./eventContract.js";

describe("event contract registry", () => {
  it("accepts legacy event names and contains workflow multi-step names", () => {
    expect(isKnownEventName("run", "run_started")).toBe(true);
    expect(isKnownEventName("approval", "approval_requested")).toBe(true);
    expect(isKnownEventName("consensus", "consensus_verdict")).toBe(true);
    expect(isKnownEventName("lifecycle", "workflow_step_planned")).toBe(true);
  });

  it("rejects workflow events on the default single-step path", () => {
    expect(() => assertDefaultSingleStepEventAllowed("run_started")).not.toThrow();
    expect(() => assertDefaultSingleStepEventAllowed("workflow_step_planned")).toThrow(
      "not allowed",
    );
  });
});
