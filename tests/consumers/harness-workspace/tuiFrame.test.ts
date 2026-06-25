import { describe, expect, it } from "vitest";
import {
  createHarnessWorkspaceState,
  frame,
  harnessDiscoveryFixture,
  recordDiscovery,
  recordEvent,
  recordRunAccepted,
} from "../../../consumers/harness-workspace/index.js";
import { createWorkspaceTuiFrame, isWorkspaceTuiFrameV1 } from "../../../consumers/harness-workspace/tuiFrame.js";

describe("WorkspaceTuiFrame.v1", () => {
  it("assembles a JSON-serializable frame from existing harness projections", () => {
    let state = recordRunAccepted(
      recordDiscovery(createHarnessWorkspaceState(), harnessDiscoveryFixture),
      {
        run_id: "run_tui",
        runtime: {
          agent_id: "coder-1",
          runtime_surface: "direct_user_session",
        },
      },
    );
    state = recordEvent(state, frame(1, "run_started", {
      runtime: { agent_id: "coder-1", runtime_surface: "direct_user_session" },
    }));
    state = recordEvent(state, frame(2, "model_output", { full_text: "hello tui" }, "agent"));

    const tuiFrame = createWorkspaceTuiFrame(state, {
      mode: "inspect",
      selectedAgentId: "coder-1",
      replayPath: "/tmp/replay.json",
      replayWrittenAt: "2026-06-25T00:00:00.000Z",
    });
    const roundTrip = JSON.parse(JSON.stringify(tuiFrame)) as unknown;

    expect(isWorkspaceTuiFrameV1(roundTrip)).toBe(true);
    expect(tuiFrame).toMatchObject({
      schema_version: "WorkspaceTuiFrame.v1",
      locale: "en-US",
      mode: "inspect",
      selected_agent: "coder-1",
      run_id: "run_71",
      replay_path: "/tmp/replay.json",
    });
    expect(tuiFrame.agents.find((agent) => agent.id === "coder-1")).toMatchObject({
      role_skin: "CODE",
    });
    expect(tuiFrame.timeline.entries.map((entry) => entry.label)).toContain("agent.model_output#2");
    expect(tuiFrame.overview.worker_preview.renderedText).toBe("hello tui");
    expect(tuiFrame.affordances.length).toBeGreaterThan(0);
  });

  it("preserves WorkspaceTuiFrame.v1 compatibility when optional polish fields are absent", () => {
    const minimal = {
      schema_version: "WorkspaceTuiFrame.v1",
      mode: "overview",
      agents: [],
      timeline: { entries: [] },
      failures: [],
      affordances: [],
      degraded_reasons: [],
      overview: {
        title: "legacy",
        chain: [],
        worker_preview: { renderedText: "" },
        evidence: { artifact_refs: [], owner_verified: "unknown", provenance: "unknown" },
      },
      continuity: {
        observed_agent_ids: [],
        owner_verified: "unknown",
        can_continue: false,
        can_rerun: false,
        can_inspect: false,
        can_copy: false,
        replay_only: true,
        reasons: [],
      },
    };

    expect(isWorkspaceTuiFrameV1(minimal)).toBe(true);
  });

  it("localizes frame chrome through the TypeScript state path", () => {
    const state = recordDiscovery(createHarnessWorkspaceState({ locale: "zh-CN" }), harnessDiscoveryFixture);

    const tuiFrame = createWorkspaceTuiFrame(state);

    expect(tuiFrame.locale).toBe("zh-CN");
    expect(tuiFrame.overview.evidence.provenance_caveat).toContain("来源 unknown");
  });
});
