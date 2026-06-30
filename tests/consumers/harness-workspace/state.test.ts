import { describe, expect, it } from "vitest";
import {
  ROLE_SKINS,
  createHarnessWorkspaceState,
  deriveInspect,
  deriveOverview,
  frame,
  harnessDiscoveryFixture,
  recordDiscovery,
  recordEvent,
  recordRunAccepted,
  t,
} from "../../../consumers/harness-workspace/index.js";
import type { EventFrame } from "../../../consumers/cli/wire.js";

function seededState() {
  return recordRunAccepted(
    recordDiscovery(createHarnessWorkspaceState(), harnessDiscoveryFixture),
    {
      run_id: "run_71",
      runtime: {
        agent_id: "coder-1",
        runtime_surface: "direct_user_session",
        isolation_profile: "coder_worktree",
      },
    },
  );
}

describe("harness workspace state projection", () => {
  it("marks the selected agent active after discovery and run acceptance before events", () => {
    const overview = deriveOverview(seededState());

    expect(overview.chain.find((node) => node.id === "agent:coder-1")).toMatchObject({
      agentId: "coder-1",
      state: "active",
    });
  });

  it("projects a live run with step session, nested attach target, and model preview", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "run_started", {
      runtime: {
        agent_id: "coder-1",
        runtime_surface: "direct_user_session",
        isolation_profile: "coder_worktree",
      },
    }));
    state = recordEvent(state, frame(2, "step_started", {
      agent_id: "coder-1",
      detail: "holp-worker-abc",
    }, "agent"));
    state = recordEvent(state, frame(3, "agent_event", {
      name: "attach_target",
      payload: {
        agent_id: "coder-1",
        session_id: "holp-direct-123",
        attach_command: "tmux attach -t holp-direct-123",
      },
    }, "agent"));
    state = recordEvent(state, frame(4, "model_output", { text_delta: "hello " }, "agent"));
    state = recordEvent(state, frame(5, "model_output", { text_delta: "world" }, "agent"));

    const overview = deriveOverview(state);
    expect(overview.evidence).toMatchObject({
      run_id: "run_71",
      runtime_surface: "direct_user_session",
      worker_session: "holp-direct-123",
      attach_command: "tmux attach -t holp-direct-123",
      owner_verified: "verified",
      latest_event: "agent.model_output#5",
    });
    expect(overview.workerPreview.renderedText).toBe("hello world");
    expect(overview.chain.map((node) => node.id)).toEqual([
      "human",
      "controller",
      "holp",
      "agent:coder-1",
      "agent:reviewer-1",
      "gate",
    ]);
  });

  it("ignores top-level attach_target while accepting nested agent_event attach_target", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "attach_target", {
      session_id: "holp-wrong",
      attach_command: "tmux attach -t holp-wrong",
    }, "agent"));
    expect(deriveOverview(state).evidence.worker_session).toBeUndefined();
    expect(state.unknownEvents[0]?.name).toBe("attach_target");

    state = recordEvent(state, frame(2, "agent_event", {
      name: "attach_target",
      payload: {
        session_id: "holp-right",
        attach_command: "tmux attach -t holp-right",
      },
    }, "agent"));
    expect(deriveOverview(state).evidence).toMatchObject({
      worker_session: "holp-right",
      attach_command: "tmux attach -t holp-right",
    });
  });

  it("derives attach command only for HOLP-owned step sessions", () => {
    const nonHolp = recordEvent(seededState(), frame(1, "step_started", {
      agent_id: "coder-1",
      detail: "user-shell;rm -rf",
    }, "agent"));
    expect(deriveOverview(nonHolp).evidence.attach_command).toBeUndefined();

    const injectedHolp = recordEvent(seededState(), frame(2, "step_started", {
      agent_id: "coder-1",
      detail: "holp-x;rm -rf",
    }, "agent"));
    expect(deriveOverview(injectedHolp).evidence.worker_session).toBeUndefined();
    expect(deriveOverview(injectedHolp).evidence.attach_command).toBeUndefined();

    const holp = recordEvent(seededState(), frame(3, "step_started", {
      agent_id: "coder-1",
      detail: "holp-direct-123",
    }, "agent"));
    expect(deriveOverview(holp).evidence).toMatchObject({
      worker_session: "holp-direct-123",
      attach_command: "tmux attach -t holp-direct-123",
    });
  });

  it("keeps public attach target command ahead of later derived step sessions", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "agent_event", {
      name: "attach_target",
      payload: {
        agent_id: "coder-1",
        session_id: "holp-public",
        attach_command: "tmux attach -t holp-public",
      },
    }, "agent"));
    state = recordEvent(state, frame(2, "step_started", {
      agent_id: "coder-1",
      detail: "holp-derived",
    }, "agent"));

    expect(deriveOverview(state).evidence).toMatchObject({
      worker_session: "holp-public",
      attach_command: "tmux attach -t holp-public",
    });
  });

  it("uses nested agent_event attach target as selected agent latestEvent in Inspect", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "agent_event", {
      name: "attach_target",
      payload: {
        agent_id: "coder-1",
        session_id: "holp-right",
        attach_command: "tmux attach -t holp-right",
      },
    }, "agent"));

    expect(deriveInspect(state, "coder-1").selectedAgent?.latestEvent).toMatchObject({
      seq: 1,
      name: "agent_event",
    });
  });

  it("uses latest gate_report.decision_surface and terminal state for completed runs", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "gate_report", {
      decision_surface: { gate_disposition: "blocked", review_outcome: "request_changes" },
    }));
    state = recordEvent(state, frame(2, "gate_report", {
      decision_surface: { gate_disposition: "approved", review_outcome: "approve" },
      artifact_refs: ["art_gate"],
    }));
    state = recordEvent(state, frame(3, "run_merged", {
      artifact_id: "art_terminal",
    }));

    expect(deriveOverview(state).evidence).toMatchObject({
      gate: { gate_disposition: "approved", review_outcome: "approve" },
      terminal: { state: "merged" },
      artifact_refs: ["art_gate", "art_terminal"],
    });
  });

  it("maps cancelled run_gave_up distinctly from non-cancelled gave-up", () => {
    const cancelled = recordEvent(seededState(), frame(1, "run_gave_up", { reason: "cancelled" }));
    expect(deriveOverview(cancelled).evidence.terminal).toEqual({
      state: "cancelled",
      reason: "cancelled",
    });
    expect(deriveOverview(cancelled).failures).toEqual(["Run cancelled: cancelled"]);

    const gaveUp = recordEvent(seededState(), frame(1, "run_gave_up", { reason: "too_many_failures" }));
    expect(deriveOverview(gaveUp).evidence.terminal).toEqual({
      state: "gave_up",
      reason: "too_many_failures",
    });
    expect(deriveOverview(gaveUp).failures).toEqual(["Run gave up: too_many_failures"]);
  });

  it("summarizes failures and preserves raw anchors for degraded or blocked runs", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "consensus_degraded", {
      reason: "quorum_unsatisfiable_after_author_exclusion",
    }));
    state = recordEvent(state, frame(2, "gate_report", {
      decision_surface: { gate_disposition: "blocked", review_outcome: "reject" },
      blocking_reason: "consensus_reject",
    }));
    state = recordEvent(state, frame(3, "approval_expired", { approval_id: "ap_1" }));
    state = recordEvent(state, frame(4, "approval_cancelled", { approval_id: "ap_2" }));
    state = recordEvent(state, frame(5, "run_blocked", { reason: "gate_blocked" }));

    const overview = deriveOverview(state);
    expect(overview.failures).toEqual([
      "Consensus degraded: quorum_unsatisfiable_after_author_exclusion",
      "Gate blocking: consensus_reject",
      "Approval expired",
      "Approval cancelled",
      "Run blocked: gate_blocked",
    ]);
    expect(overview.rawEvidenceAnchors.map((anchor) => anchor.name)).toEqual([
      "consensus_degraded",
      "gate_report",
      "approval_expired",
      "approval_cancelled",
      "run_blocked",
    ]);
    expect(overview.rawEvidenceAnchors[0]?.payload).toMatchObject({
      reason: "quorum_unsatisfiable_after_author_exclusion",
    });
  });

  it("sources owner_verified from discovery matrix, not event payloads", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "step_started", {
      agent_id: "reviewer-1",
      owner_verified: true,
    }, "agent"));

    expect(deriveInspect(state, "coder-1").selectedAgent?.owner_verified).toBe("verified");
    expect(deriveInspect(state, "reviewer-1").selectedAgent?.owner_verified).toBe("unknown");
  });

  it("uses full_text as authoritative model output, appends delta-only events, and dedupes by run_id:seq", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "model_output", { text_delta: "old " }, "agent"));
    state = recordEvent(state, frame(2, "model_output", { full_text: "snapshot" }, "agent"));
    state = recordEvent(state, frame(3, "model_output", { text_delta: " + delta" }, "agent"));
    state = recordEvent(state, frame(3, "model_output", { text_delta: " + duplicate" }, "agent"));

    expect(deriveOverview(state).workerPreview).toMatchObject({
      fullText: "snapshot + delta",
      renderedText: "snapshot + delta",
      authoritativeSnapshot: true,
    });
    expect(state.events).toHaveLength(3);
  });

  it("attributes inspect output only to the actual selected worker", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "model_output", { full_text: "worker-only output" }, "agent"));

    expect(deriveInspect(state, "coder-1").inspect?.output).toMatchObject({
      state: "captured",
      text: "worker-only output",
    });
    expect(deriveInspect(state, "reviewer-1").inspect?.output).toMatchObject({
      state: "unavailable",
      text: "no model_output captured for this agent",
    });
  });

  it("marks matching attributed empty output as pending rather than unavailable", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "model_output", { full_text: "" }, "agent"));

    expect(state.workerPreview.producer_attribution).toBe("single");
    expect(state.workerPreview.producer_agent_id).toBe("coder-1");
    expect(deriveInspect(state, "coder-1").inspect?.output).toMatchObject({
      state: "pending",
      text: "no model_output.text_delta yet",
    });
    expect(deriveInspect(state, "reviewer-1").inspect?.output).toMatchObject({
      state: "unavailable",
      text: "no model_output captured for this agent",
    });
  });

  it("keeps captured output attribution stable after a later non-worker step becomes selected", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "model_output", { full_text: "coder output" }, "agent"));
    state = recordEvent(state, frame(2, "step_started", {
      agent_id: "reviewer-1",
      detail: "review-started",
    }, "agent"));

    expect(state.run.selected_agent_id).toBe("reviewer-1");
    expect(state.workerPreview.producer_agent_id).toBe("coder-1");
    expect(deriveInspect(state, "reviewer-1").inspect?.output).toMatchObject({
      state: "unavailable",
      text: "no model_output captured for this agent",
    });
    expect(deriveInspect(state, "coder-1").inspect?.output).toMatchObject({
      state: "captured",
      text: "coder output",
    });
  });

  it("reattributes later full_text replacement to the current selected agent", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "model_output", { full_text: "coder output" }, "agent"));
    state = recordEvent(state, frame(2, "step_started", {
      agent_id: "reviewer-1",
      detail: "review-started",
    }, "agent"));
    state = recordEvent(state, frame(3, "model_output", { full_text: "reviewer output" }, "agent"));

    expect(state.workerPreview.producer_agent_id).toBe("reviewer-1");
    expect(deriveInspect(state, "reviewer-1").inspect?.output).toMatchObject({
      state: "captured",
      text: "reviewer output",
    });
    expect(deriveInspect(state, "coder-1").inspect?.output).toMatchObject({
      state: "unavailable",
      text: "no model_output captured for this agent",
    });
  });

  it("fails closed for mixed text_delta output from different selected agents", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "model_output", { text_delta: "coder output" }, "agent"));
    state = recordEvent(state, frame(2, "step_started", {
      agent_id: "reviewer-1",
      detail: "review-started",
    }, "agent"));
    state = recordEvent(state, frame(3, "model_output", { text_delta: " + reviewer output" }, "agent"));

    expect(state.workerPreview.renderedText).toBe("coder output + reviewer output");
    expect(state.workerPreview.producer_attribution).toBe("mixed");
    expect(state.workerPreview.producer_agent_id).toBeUndefined();
    expect(deriveInspect(state, "coder-1").inspect?.output).toMatchObject({
      state: "unavailable",
      text: "no model_output captured for this agent",
    });
    expect(deriveInspect(state, "reviewer-1").inspect?.output).toMatchObject({
      state: "unavailable",
      text: "no model_output captured for this agent",
    });
  });

  it("keeps mixed text_delta attribution closed across later same-agent deltas", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "model_output", { text_delta: "coder out. " }, "agent"));
    state = recordEvent(state, frame(2, "step_started", {
      agent_id: "reviewer-1",
      detail: "review-started",
    }, "agent"));
    state = recordEvent(state, frame(3, "model_output", { text_delta: "reviewer out. " }, "agent"));
    state = recordEvent(state, frame(4, "model_output", { text_delta: "reviewer again." }, "agent"));

    expect(state.workerPreview.renderedText).toBe("coder out. reviewer out. reviewer again.");
    expect(state.workerPreview.producer_attribution).toBe("mixed");
    expect(state.workerPreview.producer_agent_id).toBeUndefined();
    expect(deriveInspect(state, "coder-1").inspect?.output).toMatchObject({
      state: "unavailable",
      text: "no model_output captured for this agent",
    });
    expect(deriveInspect(state, "reviewer-1").inspect?.output).toMatchObject({
      state: "unavailable",
      text: "no model_output captured for this agent",
    });
  });

  it("keeps overview run-level while inspect latest event is scoped to the inspected agent", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "model_output", { text_delta: "worker output" }, "agent"));
    state = recordEvent(state, frame(2, "step_started", {
      agent_id: "reviewer-1",
      detail: "review-started",
    }, "agent"));

    const overview = deriveOverview(state);
    const inspect = deriveInspect(state, "reviewer-1");

    expect(overview.evidence.latest_event).toBe("agent.step_started#2");
    expect(overview.workerPreview.renderedText).toBe("worker output");
    expect(inspect.selectedAgent?.latestEvent).toMatchObject({
      seq: 2,
      name: "step_started",
    });
    expect(inspect.inspect?.sections.flatMap((section) => section.rows)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "latest event", value: "agent.step_started#2" }),
        expect.objectContaining({ label: "owner", value: "unknown" }),
      ]),
    );
  });

  it("derives bounded inspect evidence refs without raw payload JSON", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "gate_report", {
      decision_surface: { gate_disposition: "blocked" },
      blocking_reason: "secret_payload_must_not_render",
    }));

    const inspect = deriveInspect(state, "coder-1");
    expect(inspect.inspect?.evidenceRefs).toEqual([
      { ref: "gate.gate_report#1", run_id: "run_71", seq: 1 },
    ]);
    expect(JSON.stringify(inspect.inspect?.evidenceRefs)).not.toContain("secret_payload_must_not_render");
  });

  it("localizes inspect failure explanations while preserving raw reason tokens", () => {
    let state = recordRunAccepted(
      recordDiscovery(createHarnessWorkspaceState({ locale: "zh-CN" }), harnessDiscoveryFixture),
      {
        run_id: "run_71",
        runtime: { agent_id: "coder-1", runtime_surface: "direct_user_session" },
      },
    );
    state = recordEvent(state, frame(1, "gate_report", {
      decision_surface: { gate_disposition: "blocked", review_outcome: "reject" },
      blocking_reason: "consensus_reject",
    }));
    state = recordEvent(state, frame(2, "run_blocked", { reason: "gate_blocked" }));

    expect(deriveInspect(state, "coder-1").inspect?.sections.flatMap((section) => section.rows)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: expect.stringContaining("Gate 阻塞: consensus_reject") }),
        expect.objectContaining({ value: expect.stringContaining("运行被阻塞: gate_blocked") }),
      ]),
    );
  });

  it("bounds model output preview with a truncation marker", () => {
    let state = recordDiscovery(createHarnessWorkspaceState({ previewLimit: 12 }), harnessDiscoveryFixture);
    state = recordEvent(state, frame(1, "model_output", { full_text: "abcdefghijklmnopqrstuvwxyz" }, "agent"));

    expect(deriveOverview(state).workerPreview).toMatchObject({
      renderedText: "\n[truncated]",
      truncated: true,
    });
  });

  it("preserves unknown and spec-only events without throwing", () => {
    const event: EventFrame = {
      run_id: "run_71",
      seq: 1,
      category: "run",
      name: "run_cancelled",
      payload: { reason: "legacy_spec_name" },
    };
    const state = recordEvent(seededState(), event);

    expect(state.unknownEvents).toEqual([event]);
    expect(deriveOverview(state).evidence.terminal).toBeUndefined();
    expect(state.rawEvidenceAnchors[0]).toMatchObject({
      source: "unknown_event",
      name: "run_cancelled",
      payload: { reason: "legacy_spec_name" },
    });
  });

  it("localizes labels while keeping protocol anchors untranslated", () => {
    let state = recordDiscovery(createHarnessWorkspaceState({ locale: "zh-CN" }), harnessDiscoveryFixture);
    state = recordEvent(state, frame(1, "run_started", {
      runtime: { runtime_surface: "direct_user_session", agent_id: "coder-1" },
    }));
    const overview = deriveOverview(state);

    expect(t("en-US", "evidence")).toBe("Evidence");
    expect(overview.labels.evidence).toBe("证据");
    expect(overview.evidence.runtime_surface).toBe("direct_user_session");
    expect(overview.evidence.latest_event).toBe("run.run_started#1");
  });

  it("keeps role skin table complete and visual-only", () => {
    expect(Object.keys(ROLE_SKINS).sort()).toEqual(["ARCH", "CODE", "CTRL", "GATE", "REV", "TEST"]);
    expect(ROLE_SKINS.CODE).toEqual({
      id: "CODE",
      accent: "green",
      badge: "CODE",
      description: "coder visual skin",
    });
  });

  it("defaults provenance to unknown and only renders explicit smoke_script as a caveat", () => {
    const defaultOverview = deriveOverview(seededState());
    expect(defaultOverview.evidence.provenance).toBe("unknown");
    expect(defaultOverview.evidence.provenance_caveat).toContain("no real-usage");

    let state = recordDiscovery(createHarnessWorkspaceState({ provenance: "smoke_script" }), harnessDiscoveryFixture);
    state = recordEvent(state, frame(1, "model_output", {
      full_text: "terminal-consumer-integration-ready",
    }, "agent"));
    state = recordEvent(state, frame(2, "run_merged", { artifact_id: "art_ready" }));
    const overview = deriveOverview(state);
    expect(overview.evidence.provenance).toBe("smoke_script");
    expect(overview.evidence.provenance_caveat).toContain("Smoke-script provenance");
  });

  it("degrades unknown selected agents to an overview-compatible empty inspect model", () => {
    const state = seededState();
    const overview = deriveOverview(state);
    const inspect = deriveInspect(state, "missing-agent");

    expect(inspect.mode).toBe("inspect");
    expect(inspect.empty).toBe(true);
    expect(inspect.selectedAgent).toBeUndefined();
    expect(inspect.chain).toEqual(overview.chain);
    expect(inspect.evidence).toEqual(overview.evidence);
  });
});
