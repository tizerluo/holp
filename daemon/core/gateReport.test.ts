import { describe, expect, it } from "vitest";
import { buildGateReport, emitGateReport } from "./gateReport.js";
import { ConnectionContext } from "./context.js";
import { EventBus } from "./eventBus.js";
import { FakeClock } from "./clock.js";
import type { RunRecord } from "./stores.js";

describe("GateReport.v1 projection", () => {
  it("builds a stable approved report from consensus evidence", () => {
    const report = buildGateReport({
      generated_at: 10,
      run: {
        run_id: "run_gate",
        status: "merged",
        consensus: {
          panel: [{ agent_id: "r2" }, { agent_id: "r1" }],
          quorum: 2,
          producer_agent_id: "coder",
          policy: {
            exclude_author: true,
            author_provenance: "produced_by_agent_id",
            on_quorum_unsatisfiable: "reject",
            on_consensus_blocking: "reject",
          },
        },
      },
      approvals: [],
      decisions: [],
      events: [
        {
          seq: 1,
          ts: 10,
          category: "consensus",
          name: "consensus_verdict",
          payload: {
            target: { artifact_id: "art_diff", produced_by_agent_id: "coder" },
            outcome: "approve",
            max_severity: "NONE",
            quorum: { required: 2, eligible: 2, met: true },
            rule: "majority-non-author",
            reviews: [
              {
                agent: "r2",
                eligible: true,
                status: "completed",
                verdict: "approve",
                max_severity: "NONE",
              },
              {
                agent: "r1",
                eligible: true,
                status: "completed",
                verdict: "approve",
                max_severity: "NONE",
              },
            ],
            excluded: [],
            errors: [],
          },
        },
        {
          seq: 2,
          ts: 10,
          category: "run",
          name: "run_merged",
          payload: { reason: "run completed" },
        },
      ],
    });

    expect(report.decision_surface).toEqual({
      review_outcome: "approve",
      gate_disposition: "approved",
    });
    expect(report.runtime.reviewers.map((reviewer) => reviewer.agent_id)).toEqual(["r1", "r2"]);
    expect(report.reviews.map((review) => review.agent)).toEqual(["r1", "r2"]);
    expect(report.terminal).toEqual({
      state: "merged",
      event: "run_merged",
      reason: "run completed",
    });
    expect(report.blocking_reason).toBeUndefined();
  });

  it("reports waiting_approval before a blocking semantic decision becomes terminal", () => {
    const report = buildGateReport({
      generated_at: 10,
      run: {
        run_id: "run_waiting",
        status: "active",
        consensus: {
          panel: [{ agent_id: "r1" }],
          quorum: 1,
          producer_agent_id: "coder",
          policy: {
            exclude_author: true,
            author_provenance: "produced_by_agent_id",
            on_quorum_unsatisfiable: "reject",
            on_consensus_blocking: "ask_human",
          },
        },
      },
      approvals: [
        {
          approval_id: "ap_1",
          run_id: "run_waiting",
          kind: "semantic_decision",
          reason: "consensus quorum requires human semantic decision",
          expires_at: 11,
          state: "pending",
          resumeBackend: () => {},
        },
      ],
      decisions: [],
      events: [
        {
          seq: 1,
          ts: 10,
          category: "consensus",
          name: "consensus_verdict",
          payload: {
            target: { artifact_id: "art_diff", produced_by_agent_id: "coder" },
            outcome: "reject",
            max_severity: "P1",
            quorum: { required: 1, eligible: 1, met: true },
            rule: "majority-non-author",
            reviews: [],
            excluded: [],
            errors: [],
          },
        },
      ],
    });

    expect(report.decision_surface).toEqual({
      review_outcome: "reject",
      gate_disposition: "waiting_approval",
    });
    expect(report.pending_approval?.approval_id).toBe("ap_1");
  });

  it("does not report degraded quorum policy outcome as a reviewer verdict", () => {
    const report = buildGateReport({
      generated_at: 10,
      run: {
        run_id: "run_degraded",
        status: "blocked",
        consensus: {
          panel: [{ agent_id: "author" }, { agent_id: "r1" }],
          quorum: 2,
          producer_agent_id: "author",
          policy: {
            exclude_author: true,
            author_provenance: "produced_by_agent_id",
            on_quorum_unsatisfiable: "reject",
            on_consensus_blocking: "reject",
          },
        },
      },
      approvals: [],
      decisions: [],
      events: [
        {
          seq: 1,
          ts: 10,
          category: "consensus",
          name: "consensus_degraded",
          payload: {
            target: { artifact_id: "art_diff", produced_by_agent_id: "author" },
            outcome: "reject",
            max_severity: "NONE",
            quorum: { required: 2, eligible: 1, met: false },
            rule: "majority-non-author",
            reviews: [],
            excluded: [{ agent: "author", reason: "produced_by_agent_id (author)" }],
            errors: [],
            reason: "quorum_unsatisfiable_after_author_exclusion",
            policy_action: "reject",
          },
        },
        {
          seq: 2,
          ts: 10,
          category: "run",
          name: "run_blocked",
          payload: { reason: "quorum_unsatisfiable_after_author_exclusion" },
        },
      ],
    });

    expect(report.decision_surface).toEqual({
      review_outcome: "none",
      gate_disposition: "blocked",
    });
    expect(report.blocking_reason).toBe("quorum_unsatisfiable_after_author_exclusion");
  });

  it("projects semantic override audit without changing consensus evidence", () => {
    const report = buildGateReport({
      generated_at: 12,
      run: {
        run_id: "run_override",
        status: "merged",
        consensus: {
          panel: [{ agent_id: "r1" }],
          quorum: 1,
          producer_agent_id: "coder",
          policy: {
            exclude_author: true,
            author_provenance: "produced_by_agent_id",
            on_quorum_unsatisfiable: "reject",
            on_consensus_blocking: "ask_human",
          },
        },
      },
      approvals: [],
      decisions: [],
      events: [
        {
          seq: 1,
          ts: 10,
          category: "consensus",
          name: "consensus_verdict",
          payload: {
            target: { artifact_id: "art_diff", produced_by_agent_id: "coder" },
            outcome: "request_changes",
            max_severity: "P2",
            quorum: { required: 1, eligible: 1, met: true },
            rule: "majority-non-author",
            reviews: [],
            excluded: [],
            errors: [],
          },
        },
        {
          seq: 2,
          ts: 11,
          category: "approval",
          name: "approval_resolved",
          payload: {
            approval_id: "ap_1",
            state: "resolved",
            decision: "approved",
            kind: "semantic_decision",
            reason: "accepted risk",
            by: "user:test",
            previous_gate_outcome: "request_changes",
            new_gate_outcome: "approved",
            artifact_refs: ["art_diff"],
          },
        },
      ],
    });

    expect(report.decision_surface).toEqual({
      review_outcome: "request_changes",
      gate_disposition: "overridden",
    });
    expect(report.override).toMatchObject({
      approval_id: "ap_1",
      by: "user:test",
      previous_gate_outcome: "request_changes",
      new_gate_outcome: "approved",
      artifact_refs: ["art_diff"],
    });
    expect(report.consensus_snapshot?.outcome).toBe("request_changes");
  });

  it("summarizes artifact and inline findings with stable order and truncation markers", () => {
    const report = buildGateReport({
      generated_at: 10,
      run: { run_id: "run_findings", status: "active" },
      approvals: [],
      decisions: [],
      events: [
        {
          seq: 1,
          ts: 10,
          category: "consensus",
          name: "consensus_verdict",
          payload: {
            target: { artifact_id: "art_diff", produced_by_agent_id: "coder" },
            outcome: "approve",
            max_severity: "NONE",
            quorum: { required: 2, eligible: 2, met: true },
            rule: "majority-non-author",
            reviews: [
              {
                agent: "z",
                eligible: true,
                status: "completed",
                verdict: "approve",
                max_severity: "NONE",
                findings: {
                  inline: true,
                  type: "findings",
                  mime: "application/json",
                  content: "x".repeat(260),
                  truncated: false,
                },
              },
              {
                agent: "a",
                eligible: true,
                status: "completed",
                verdict: "approve",
                max_severity: "NONE",
                findings: {
                  artifact_id: "art_findings",
                  type: "findings",
                  mime: "application/json",
                  size: 2,
                  sha256: "abc",
                  created_by: "a",
                  created_at: 10,
                },
              },
            ],
            excluded: [],
            errors: [],
          },
        },
      ],
    });

    expect(report.findings.map((finding) => finding.agent)).toEqual(["a", "z"]);
    expect(report.findings[0]).toMatchObject({ carrier: "artifact", artifact_id: "art_findings", truncated: false });
    expect(report.findings[1]).toMatchObject({ carrier: "inline", truncated: true, truncated_reason: "content_limit" });
    expect(report.findings[1].preview).toHaveLength(240);
  });

  it("does not emit gate reports unless the capability is negotiated", () => {
    const clock = new FakeClock();
    const ctx = new ConnectionContext();
    const run = makeRun("run_no_cap", clock);
    ctx.runs.set(run.run_id, run);

    emitGateReport(run, ctx, clock);
    expect(run.bus.allEvents()).toHaveLength(0);

    ctx.initialized = {
      protocolVersion: "0.1.4",
      clientName: "test",
      clientVersion: "0",
      negotiated: {
        approval: { supported: true, kinds: ["merge_approval"] },
        consensus: { supported: true },
        unattended_loop: { supported: false },
        artifact_refs: { supported: false },
        gate_report: { supported: true },
      },
    };
    emitGateReport(run, ctx, clock);
    expect(run.bus.allEvents()).toHaveLength(1);
    expect(run.bus.allEvents()[0]).toMatchObject({ category: "gate", name: "gate_report" });
  });
});

function makeRun(runId: string, clock: FakeClock): RunRecord {
  return {
    run_id: runId,
    goal: "goal",
    trigger: "manual",
    status: "active",
    bus: new EventBus(runId, clock),
    pendingApprovals: new Set(),
    approvalSeq: 0,
  };
}
