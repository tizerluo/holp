import { describe, expect, it } from "vitest";
import {
  RunRenderer,
  renderArtifact,
  renderConsensusDegraded,
  renderGateReport,
  renderRuntimeMatrix,
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

  it("prefers the latest gate report in the run summary", () => {
    const renderer = new RunRenderer();
    renderer.recordEvent({
      run_id: "run_1",
      seq: 1,
      category: "gate",
      name: "gate_report",
      payload: {
        decision_surface: { review_outcome: "reject", gate_disposition: "blocked" },
      },
    });
    renderer.recordEvent({
      run_id: "run_1",
      seq: 2,
      category: "gate",
      name: "gate_report",
      payload: {
        decision_surface: { review_outcome: "reject", gate_disposition: "overridden" },
      },
    });

    expect(renderer.summary("run_1").gate_report?.payload).toMatchObject({
      decision_surface: { gate_disposition: "overridden" },
    });
  });

  it("detects non-contiguous event seq values per run", () => {
    const renderer = new RunRenderer();
    renderer.recordEvent({ run_id: "run_1", seq: 1, category: "run", name: "run_started", payload: {} });
    renderer.recordEvent({ run_id: "run_1", seq: 3, category: "run", name: "run_merged", payload: {} });

    expect(renderer.summary("run_1")).toMatchObject({ seq_ok: false, seen_events: 2 });
    expect(renderer.diagnostics()[0]).toContain("expected seq 2, got 3");
  });

  it("renders run_gave_up cancellation as a cancelled abort", () => {
    const renderer = new RunRenderer();

    expect(renderer.recordEvent({
      run_id: "run_1",
      seq: 1,
      category: "run",
      name: "run_gave_up",
      payload: { reason: "cancelled" },
    })).toEqual(["run cancelled: reason=cancelled"]);
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

  it("renders gate reports without provider blobs", () => {
    expect(renderGateReport({
      decision_surface: { review_outcome: "request_changes", gate_disposition: "overridden" },
      quorum: { required: 2, eligible: 2, met: true },
      blocking_reason: "consensus_request_changes",
      override: {
        approval_id: "ap_1",
        by: "user:test",
        new_gate_outcome: "approved",
      },
      terminal: { event: "run_merged", reason: "run completed" },
    })).toEqual([
      "gate report: disposition=overridden review=request_changes",
      "  quorum: required=2 eligible=2 met=true",
      "  blocking: consensus_request_changes",
      "  override: approval=ap_1 by=user:test new=approved",
      "  terminal: run_merged reason=run completed",
    ]);
  });

  it("renders the runtime/session matrix from JSON-round-tripped flock wire data", () => {
    const agent = JSON.parse(JSON.stringify({
      id: "direct-observer",
      status: "degraded",
      runtime_surfaces: [
        {
          runtime_surface: "direct_user_session",
          runtime_kind: "tmux",
          surface_support: "experimental",
          direct_channel: {
            channel_type: "tmux",
            attach: "supported",
            observe: "supported",
            read: "supported",
            inject: "unknown",
            interrupt: "unknown",
            cancel: "unknown",
            owner_scope: "supported",
          },
          isolation_profiles: {
            coder_worktree: {
              readiness: "rejected",
              reason: "direct_control_not_declared",
              missing: ["inject", "interrupt", "cancel"],
            },
            read_only_review: {
              readiness: "degraded",
              reason: "observe_only",
              warnings: ["declared_not_enforced"],
            },
            real_provider_smoke: { readiness: "rejected", reason: "not_supported" },
            multi_agent_concurrent: { readiness: "rejected", reason: "not_supported" },
            user_global_install: { readiness: "rejected", reason: "not_supported" },
            high_isolation: { readiness: "rejected", reason: "not_supported" },
          },
          state_declaration_ref: "harness-state:direct-observer",
          global_mutation_required: true,
          declared_not_enforced: true,
        },
      ],
    }));

    expect(renderRuntimeMatrix(agent)).toEqual([
      "agent direct-observer: status=degraded",
      "  runtime matrix: source=flock-wire descriptive_only=true",
      "  surface direct_user_session: support=experimental kind=tmux mutation=true declared_not_enforced=true state=harness-state:direct-observer",
      "    observation: channel=tmux attach=supported observe=supported read=supported owner_scope=supported",
      "    control: inject=unknown interrupt=unknown cancel=unknown",
      "    profile coder_worktree: rejected reason=direct_control_not_declared missing=inject,interrupt,cancel",
      "    profile read_only_review: degraded reason=observe_only warnings=declared_not_enforced",
      "    profile real_provider_smoke: rejected reason=not_supported",
      "    profile multi_agent_concurrent: rejected reason=not_supported",
      "    profile user_global_install: rejected reason=not_supported",
      "    profile high_isolation: rejected reason=not_supported",
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
