import { describe, expect, it } from "vitest";
import { ConnectionContext } from "../core/context.js";
import { EventBus } from "../core/eventBus.js";
import { FakeClock } from "../core/clock.js";
import { handleApprovalResolve } from "./approval_resolve.js";
import type { ApprovalRecord, RunRecord } from "../core/stores.js";

describe("approval.resolve gate audit handling", () => {
  it("keeps merge_approval resolution payload unchanged", () => {
    const clock = new FakeClock();
    const ctx = newContextWithGateReport();
    const run = makeRun("run_merge", clock);
    ctx.runs.set(run.run_id, run);
    ctx.approvals.set("ap_merge", approval("ap_merge", run.run_id, "merge_approval"));
    run.pendingApprovals.add("ap_merge");

    const result = handleApprovalResolve({
      jsonrpc: "2.0",
      id: 1,
      method: "approval.resolve",
      params: { approval_id: "ap_merge", decision: "approved", by: "user:test" },
    }, ctx, clock);

    expect(result).toEqual({ approval_id: "ap_merge", accepted: true });
    const resolved = run.bus.allEvents().find((event) => event.name === "approval_resolved")!;
    expect(resolved.payload).toEqual({
      approval_id: "ap_merge",
      state: "resolved",
      decision: "approved",
      reason: "user_decision",
      by: "user:test",
    });
    expect(run.bus.allEvents().some((event) => event.name === "gate_report")).toBe(false);
  });

  it("fails closed for semantic_decision without required audit fields", () => {
    const clock = new FakeClock();
    const ctx = newContextWithGateReport();
    const run = makeRun("run_semantic_missing", clock);
    const record = approval("ap_semantic", run.run_id, "semantic_decision");
    ctx.runs.set(run.run_id, run);
    ctx.approvals.set(record.approval_id, record);
    run.pendingApprovals.add(record.approval_id);

    expect(() => handleApprovalResolve({
      jsonrpc: "2.0",
      id: 1,
      method: "approval.resolve",
      params: { approval_id: "ap_semantic", decision: "approved", by: "user:test" },
    }, ctx, clock)).toThrow("semantic_decision params.reason");
    expect(record.state).toBe("pending");
    expect(run.bus.allEvents()).toHaveLength(0);
  });

  it("emits semantic_decision audit fields and a derived gate report", () => {
    const clock = new FakeClock();
    const ctx = newContextWithGateReport();
    const run = makeRun("run_semantic", clock);
    run.bus.publish("consensus", "consensus_verdict", {
      target: { artifact_id: "art_diff", produced_by_agent_id: "coder" },
      outcome: "reject",
      max_severity: "P1",
      quorum: { required: 1, eligible: 1, met: true },
      rule: "majority-non-author",
      reviews: [],
      excluded: [],
      errors: [],
    });
    const record = approval("ap_semantic", run.run_id, "semantic_decision");
    ctx.runs.set(run.run_id, run);
    ctx.approvals.set(record.approval_id, record);
    run.pendingApprovals.add(record.approval_id);

    handleApprovalResolve({
      jsonrpc: "2.0",
      id: 1,
      method: "approval.resolve",
      params: {
        approval_id: "ap_semantic",
        decision: "approved",
        by: "user:test",
        reason: "accepted risk",
        previous_gate_outcome: "reject",
        new_gate_outcome: "approved",
        artifact_refs: ["art_diff"],
      },
    }, ctx, clock);

    const resolved = run.bus.allEvents().find((event) => event.name === "approval_resolved")!;
    expect(resolved.payload).toMatchObject({
      approval_id: "ap_semantic",
      kind: "semantic_decision",
      reason: "accepted risk",
      previous_gate_outcome: "reject",
      new_gate_outcome: "approved",
      artifact_refs: ["art_diff"],
    });
    const report = run.bus.allEvents().find((event) => event.name === "gate_report")!;
    expect(report.payload).toMatchObject({
      decision_surface: {
        review_outcome: "reject",
        gate_disposition: "overridden",
      },
      override: {
        approval_id: "ap_semantic",
        new_gate_outcome: "approved",
      },
    });
  });

  it("fails closed for unknown approval kinds before resolving", () => {
    const clock = new FakeClock();
    const ctx = newContextWithGateReport();
    const run = makeRun("run_unknown", clock);
    const record = approval("ap_unknown", run.run_id, "new_kind");
    ctx.runs.set(run.run_id, run);
    ctx.approvals.set(record.approval_id, record);
    run.pendingApprovals.add(record.approval_id);

    expect(() => handleApprovalResolve({
      jsonrpc: "2.0",
      id: 1,
      method: "approval.resolve",
      params: { approval_id: "ap_unknown", decision: "approved", by: "user:test" },
    }, ctx, clock)).toThrow("unknown approval kind");
    expect(record.state).toBe("pending");
    expect(run.bus.allEvents()).toHaveLength(0);
  });
});

function newContextWithGateReport(): ConnectionContext {
  const ctx = new ConnectionContext();
  ctx.initialized = {
    protocolVersion: "0.1.4",
    clientName: "test",
    clientVersion: "0",
    negotiated: {
      approval: { supported: true, kinds: ["merge_approval", "semantic_decision"] },
      consensus: { supported: true },
      unattended_loop: { supported: false },
      artifact_refs: { supported: false },
      gate_report: { supported: true },
    },
  };
  return ctx;
}

function makeRun(runId: string, clock: FakeClock): RunRecord {
  return {
    run_id: runId,
    goal: "goal",
    trigger: "manual",
    status: "active",
    bus: new EventBus(runId, clock, (recordRunId, event) => {
      void recordRunId;
      void event;
    }),
    pendingApprovals: new Set(),
    approvalSeq: 0,
  };
}

function approval(approvalId: string, runId: string, kind: string): ApprovalRecord {
  return {
    approval_id: approvalId,
    run_id: runId,
    kind,
    reason: "reason",
    expires_at: 1718600300,
    state: "pending",
    resumeBackend: () => {},
  };
}
