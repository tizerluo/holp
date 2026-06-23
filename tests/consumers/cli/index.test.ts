import { describe, expect, it } from "vitest";
import {
  chooseDecision,
  parseArgs,
  renderSummaryReport,
  waitForPostTerminalGateReport,
} from "../../../consumers/cli/index.js";
import { RunRenderer } from "../../../consumers/cli/renderer.js";
import { formatRawFrame, type EventFrame } from "../../../consumers/cli/wire.js";

class FakeEventWaiter {
  waitCalls = 0;
  private pending?: {
    readonly predicate: (event: EventFrame) => boolean;
    readonly resolve: (event: EventFrame) => void;
  };

  waitForEvent(
    predicate: (event: EventFrame) => boolean,
    _label: string,
    _timeoutMs?: number,
  ): Promise<EventFrame> {
    this.waitCalls += 1;
    return new Promise((resolve) => {
      this.pending = { predicate, resolve };
    });
  }

  deliver(event: EventFrame): void {
    if (!this.pending?.predicate(event)) throw new Error(`unexpected event ${event.name}`);
    this.pending.resolve(event);
    this.pending = undefined;
  }
}

describe("consumer CLI argument and approval handling", () => {
  it("parses a non-interactive consensus command with raw/debug controls", () => {
    expect(parseArgs([
      "run",
      "--scenario=consensus",
      "--registry=fake",
      "--artifact-refs=false",
      "--decision=rejected",
      "--report=json",
      "--raw",
      "--debug=false",
    ])).toMatchObject({
      scenario: "consensus",
      registry: "fake",
      artifactRefs: false,
      decision: "rejected",
      report: "json",
      raw: true,
      debug: false,
    });
  });

  it("defaults non-interactive approvals to approved for deterministic demos", async () => {
    await expect(chooseDecision(
      { interactive: false, decision: undefined },
      { approval_id: "ap_1", kind: "merge_approval" },
    )).resolves.toBe("approved");
  });

  it("uses the explicit non-interactive approval decision when provided", async () => {
    await expect(chooseDecision(
      { interactive: false, decision: "rejected" },
      { approval_id: "ap_1", kind: "merge_approval" },
    )).resolves.toBe("rejected");
  });

  it("delegates interactive approval prompting to the provided prompt function", async () => {
    const seen: Array<{ approval_id: string; kind?: string }> = [];
    const decision = await chooseDecision(
      { interactive: true, decision: undefined },
      { approval_id: "ap_2", kind: "merge_approval" },
      async (approval) => {
        seen.push(approval);
        return "rejected";
      },
    );

    expect(decision).toBe("rejected");
    expect(seen).toEqual([{ approval_id: "ap_2", kind: "merge_approval" }]);
  });

  it("formats raw/debug wire frames without dropping event fields", () => {
    const line = formatRawFrame("out", {
      jsonrpc: "2.0",
      method: "events.event",
      params: {
        seq: 7,
        category: "consensus",
        payload: { outcome: "approve" },
      },
    });

    expect(line).toContain("raw out:");
    expect(line).toContain("\"method\":\"events.event\"");
    expect(line).toContain("\"seq\":7");
    expect(line).toContain("\"category\":\"consensus\"");
    expect(line).toContain("\"payload\":{\"outcome\":\"approve\"}");
  });

  it("drains post-terminal gate_report before rendering cancelled JSON and human summaries", async () => {
    const renderer = new RunRenderer();
    const events: EventFrame[] = [];
    const record = (event: EventFrame): EventFrame => {
      events.push(event);
      renderer.recordEvent(event);
      return event;
    };
    record({ run_id: "run_1", seq: 1, category: "run", name: "run_started", payload: {} });
    const terminal = record({
      run_id: "run_1",
      seq: 2,
      category: "run",
      name: "run_gave_up",
      payload: { reason: "cancelled" },
    });

    const waiter = new FakeEventWaiter();
    const wait = waitForPostTerminalGateReport(events, waiter, "run_1", terminal, {
      enabled: true,
      timeoutMs: 25,
    });
    expect(waiter.waitCalls).toBe(1);

    const gateReport = record({
      run_id: "run_1",
      seq: 3,
      category: "gate",
      name: "gate_report",
      payload: {
        version: "GateReport.v1",
        decision_surface: { gate_disposition: "degraded", review_outcome: "none" },
        terminal: { event: "run_gave_up", reason: "cancelled" },
      },
    });
    waiter.deliver(gateReport);
    await expect(wait).resolves.toBe(gateReport);

    const summary = renderer.summary("run_1");
    expect(JSON.parse(renderSummaryReport(summary, "json")[0])).toMatchObject({
      version: "GateReport.v1",
      decision_surface: { gate_disposition: "degraded", review_outcome: "none" },
    });
    expect(renderSummaryReport(summary, "human")).toEqual([
      "  terminal=run_gave_up",
      "  gate=degraded",
      "  review=none",
      "  consensus=none",
      "  events=3",
      "  seq=contiguous",
    ]);
  });

  it("keeps the gate_report drain bounded when no post-terminal report arrives", async () => {
    const terminal: EventFrame = {
      run_id: "run_1",
      seq: 2,
      category: "run",
      name: "run_gave_up",
      payload: { reason: "cancelled" },
    };
    const waiter = {
      waitForEvent: async () => {
        throw new Error("post-terminal gate_report timed out");
      },
    };

    await expect(waitForPostTerminalGateReport([terminal], waiter, "run_1", terminal, {
      enabled: true,
      timeoutMs: 1,
    })).resolves.toBeUndefined();
  });

  it("does not wait for gate_report when the capability was not negotiated", async () => {
    const terminal: EventFrame = {
      run_id: "run_1",
      seq: 2,
      category: "run",
      name: "run_gave_up",
      payload: { reason: "cancelled" },
    };
    const waiter = {
      waitForEvent: async () => {
        throw new Error("should not wait");
      },
    };

    await expect(waitForPostTerminalGateReport([terminal], waiter, "run_1", terminal, {
      enabled: false,
      timeoutMs: 1,
    })).resolves.toBeUndefined();
  });
});
