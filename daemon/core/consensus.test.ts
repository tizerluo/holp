import { describe, expect, it } from "vitest";
import {
  aggregateMaxSeverity,
  aggregateOutcome,
  buildConsensusVerdict,
  inlineFindings,
  type ConsensusReviewerResult,
} from "./consensus.js";

describe("consensus kernel", () => {
  it("aggregates the strictest verdict and max severity from completed reviews only", () => {
    const results: ConsensusReviewerResult[] = [
      { agent: "a", status: "completed", verdict: "approve", max_severity: "P2" },
      { agent: "b", status: "completed", verdict: "request_changes", max_severity: "P1" },
      { agent: "c", status: "timeout", reason: "slow" },
      { agent: "d", status: "completed", verdict: "reject", max_severity: "P0" },
    ];

    expect(aggregateOutcome(results)).toBe("reject");
    expect(aggregateMaxSeverity(results)).toBe("P0");
  });

  it("moves timeout/error/abstain to errors and excludes them from completed quorum", () => {
    const payload = buildConsensusVerdict({
      target: { artifact_id: "art_1", produced_by_agent_id: "coder" },
      panel: ["r1", "r2", "r3"],
      quorum: 2,
      producedByAgentId: "coder",
      excludeAuthor: true,
      results: [
        {
          agent: "r1",
          status: "completed",
          verdict: "approve",
          max_severity: "NONE",
          findings: inlineFindings("r1", "approve"),
        },
        { agent: "r2", status: "timeout", reason: "deadline" },
        { agent: "r3", status: "abstain", reason: "no signal" },
      ],
    });

    expect(payload.reviews).toHaveLength(1);
    expect(payload.errors).toEqual([
      { agent: "r2", status: "timeout", reason: "deadline" },
      { agent: "r3", status: "abstain", reason: "no signal" },
    ]);
    expect(payload.quorum).toEqual({ required: 2, eligible: 3, met: false });
  });

  it("treats completed reviews without verdict or severity as errors, not approve votes", () => {
    const payload = buildConsensusVerdict({
      target: { artifact_id: "art_1", produced_by_agent_id: "coder" },
      panel: ["r1", "r2"],
      quorum: 2,
      producedByAgentId: "coder",
      excludeAuthor: true,
      results: [
        { agent: "r1", status: "completed", verdict: "approve" },
        { agent: "r2", status: "completed", max_severity: "NONE" },
      ],
    });

    expect(payload.reviews).toEqual([]);
    expect(payload.errors).toEqual([
      {
        agent: "r1",
        status: "error",
        reason: "completed_review_missing_max_severity",
      },
      {
        agent: "r2",
        status: "error",
        reason: "completed_review_missing_verdict",
      },
    ]);
    expect(payload.quorum).toEqual({ required: 2, eligible: 2, met: false });
    expect(payload.outcome).toBe("approve");
    expect(payload.max_severity).toBe("NONE");
  });

  it("excludes the produced_by_agent_id author and computes eligible quorum", () => {
    const payload = buildConsensusVerdict({
      target: { artifact_id: "art_1", produced_by_agent_id: "codex" },
      panel: ["codex", "claude", "gemini"],
      quorum: 2,
      producedByAgentId: "codex",
      excludeAuthor: true,
      results: [
        { agent: "codex", status: "completed", verdict: "reject", max_severity: "P0" },
        { agent: "claude", status: "completed", verdict: "approve", max_severity: "NONE" },
        { agent: "gemini", status: "completed", verdict: "request_changes", max_severity: "P2" },
      ],
    });

    expect(payload.excluded).toEqual([
      { agent: "codex", reason: "produced_by_agent_id (author)" },
    ]);
    expect(payload.reviews.map((review) => review.agent)).toEqual(["claude", "gemini"]);
    expect(payload.outcome).toBe("request_changes");
    expect(payload.max_severity).toBe("P2");
    expect(payload.quorum).toEqual({ required: 2, eligible: 2, met: true });
  });
});
