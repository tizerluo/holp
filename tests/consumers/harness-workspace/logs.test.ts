import { describe, expect, it } from "vitest";
import {
  deriveTimeline,
  frame,
  severityForEvent,
} from "../../../consumers/harness-workspace/index.js";

describe("harness workspace logs and timeline", () => {
  it("orders timeline entries by seq and applies an explicit truncation marker", () => {
    const timeline = deriveTimeline([
      frame(3, "run_merged", {}),
      frame(1, "run_started", {}),
      frame(2, "gate_report", {
        decision_surface: { gate_disposition: "blocked" },
        blocking_reason: "consensus_reject",
      }),
    ], { limit: 2 });

    expect(timeline.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(timeline.truncated).toMatchObject({
      truncated: true,
      reason: "log_entry_cap",
      original_count: 3,
      retained_count: 2,
    });
  });

  it("bounds per-entry summaries with an explicit truncation marker", () => {
    const longReason = "x".repeat(700);
    const timeline = deriveTimeline([
      frame(1, "run_blocked", { reason: longReason }),
    ]);

    expect(timeline.entries[0]).toMatchObject({
      severity: "error",
      summary_truncated: true,
    });
    expect(timeline.entries[0]?.summary.length).toBe(512);
    expect(timeline.entries[0]?.summary).toContain("run blocked:");
  });

  it("derives deterministic severity from public event names and payload evidence", () => {
    expect(severityForEvent(frame(1, "run_merged", {}))).toBe("info");
    expect(severityForEvent(frame(2, "model_output", { text_delta: "ok" }, "agent"))).toBe("info");
    expect(severityForEvent(frame(3, "consensus_degraded", { reason: "quorum_unsatisfiable" }))).toBe("warn");
    expect(severityForEvent(frame(4, "gate_report", { blocking_reason: "consensus_reject" }))).toBe("warn");
    expect(severityForEvent(frame(5, "operator_affordance_unsupported", {}))).toBe("warn");
    expect(severityForEvent(frame(6, "approval_expired", { approval_id: "ap_1" }))).toBe("error");
    expect(severityForEvent(frame(7, "run_blocked", { reason: "gate_blocked" }))).toBe("error");
  });
});
