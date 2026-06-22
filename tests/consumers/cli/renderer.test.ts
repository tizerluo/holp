import { describe, expect, it } from "vitest";
import {
  RunRenderer,
  renderArtifact,
  renderConsensusDegraded,
  renderReviewFinding,
} from "../../../consumers/cli/renderer.js";
import type { EventFrame } from "../../../consumers/cli/wire.js";

function roundTrip(event: EventFrame): EventFrame {
  return JSON.parse(JSON.stringify(event)) as EventFrame;
}

describe("consumer CLI renderer", () => {
  it("deduplicates replay/live events by run_id and seq after JSON round-trip", () => {
    const renderer = new RunRenderer();
    const event = roundTrip({
      run_id: "run_1",
      seq: 1,
      category: "run",
      name: "run_started",
      payload: {
        runtime: {
          agent_id: "producer",
          runtime_surface: "headless",
          isolation_profile: "coder_worktree",
        },
      },
    });

    expect(renderer.recordEvent(event)).toEqual([
      "run started: run_1 (agent=producer runtime=headless isolation=coder_worktree)",
    ]);
    expect(renderer.recordEvent(event)).toEqual([]);
    expect(renderer.summary("run_1")).toMatchObject({ seq_ok: true, seen_events: 1 });
  });

  it("detects non-contiguous event seq values per run", () => {
    const renderer = new RunRenderer();
    renderer.recordEvent({ run_id: "run_1", seq: 1, category: "run", name: "run_started", payload: {} });
    renderer.recordEvent({ run_id: "run_1", seq: 3, category: "run", name: "run_merged", payload: {} });

    expect(renderer.summary("run_1")).toMatchObject({ seq_ok: false, seen_events: 2 });
    expect(renderer.diagnostics()[0]).toContain("expected seq 2, got 3");
  });

  it("renders consensus verdict details, inline findings, and artifact findings", () => {
    const renderer = new RunRenderer();
    const lines = renderer.recordEvent({
      run_id: "run_1",
      seq: 1,
      category: "consensus",
      name: "consensus_verdict",
      payload: {
        outcome: "request_changes",
        max_severity: "P1",
        quorum: { required: 2, eligible: 2, met: true },
        excluded: [{ agent: "producer", reason: "produced_by_agent_id (author)" }],
        reviews: [
          {
            agent: "r1",
            findings: {
              inline: true,
              type: "findings",
              mime: "application/json",
              content: "{\"verdict\":\"request_changes\"}",
              truncated: false,
            },
          },
          {
            agent: "r2",
            findings: {
              type: "findings",
              mime: "application/json",
              artifact_id: "art_findings_r2",
            },
          },
        ],
        errors: [{ agent: "r3", status: "timeout" }],
      },
    });

    expect(lines).toEqual([
      "consensus verdict: outcome=request_changes max_severity=P1",
      "  quorum: required=2 eligible=2 met=true",
      "  excluded: producer",
      "  reviews: 2",
      "  errors: r3(timeout)",
    ]);
    expect(renderReviewFinding({
      agent: "r1",
      findings: { inline: true, content: "{\"verdict\":\"request_changes\"}" },
    })).toEqual(["review r1: inline findings {\"verdict\":\"request_changes\"}"]);
    expect(renderReviewFinding({
      agent: "r2",
      findings: { artifact_id: "art_findings_r2" },
    }, {
      artifact_id: "art_findings_r2",
      content: "{\"verdict\":\"approve\"}",
      truncated: false,
    })).toEqual(["review r2: findings artifact=art_findings_r2 {\"verdict\":\"approve\"}"]);
  });

  it("renders consensus_degraded as a consensus report rather than missing verdict", () => {
    expect(renderConsensusDegraded({
      outcome: "reject",
      reason: "quorum_unsatisfiable_after_author_exclusion",
      quorum: { required: 2, eligible: 1, met: false },
    })).toEqual([
      "consensus degraded: outcome=reject reason=quorum_unsatisfiable_after_author_exclusion",
      "  quorum: required=2 eligible=1 met=false",
    ]);
  });

  it("marks truncated artifacts with a reproducible artifact id", () => {
    expect(renderArtifact({
      artifact_id: "art_big",
      content: "large content",
      truncated: true,
    })).toBe("artifact art_big: TRUNCATED large content");
  });
});
