import { describe, expect, it } from "vitest";
import {
  createHarnessWorkspaceState,
  deriveContinuity,
  deriveOperatorAffordances,
  frame,
  harnessDiscoveryFixture,
  recordDiscovery,
  recordEvent,
  recordRunAccepted,
} from "../../../consumers/harness-workspace/index.js";

function seededState(locale: "en-US" | "zh-CN" = "en-US") {
  return recordRunAccepted(
    recordDiscovery(createHarnessWorkspaceState({ locale }), harnessDiscoveryFixture),
    {
      run_id: "run_75",
      runtime: {
        agent_id: "coder-1",
        runtime_surface: "direct_user_session",
        runtime_kind: "tmux",
      },
    },
  );
}

describe("harness workspace operator affordances", () => {
  it("enables copy-only descriptors from source evidence and gates runtime-changing actions", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "agent_event", {
      name: "attach_target",
      payload: {
        agent_id: "coder-1",
        session_id: "holp-direct-75",
        attach_command: "tmux attach -t holp-direct-75",
      },
    }, "agent"));
    state = recordEvent(state, frame(2, "model_output", { full_text: "evidence" }, "agent"));
    const continuity = deriveContinuity(state, { replayCreatedAt: "2026-06-25T00:00:00.000Z" });
    const affordances = deriveOperatorAffordances(state, continuity);

    expect(affordances.find((item) => item.id === "copy_attach_command")).toMatchObject({
      state: "enabled",
      command_text: "tmux attach -t holp-direct-75",
      destructive: false,
      focus_changing: false,
    });
    expect(affordances.find((item) => item.id === "copy_run_id")).toMatchObject({
      state: "enabled",
      command_text: "run_75",
    });
    expect(affordances.find((item) => item.id === "continue_run")).toMatchObject({
      state: "needs_confirmation",
      confirmation_required: true,
      focus_changing: true,
    });
    expect(affordances.find((item) => item.id === "cancel_run")).toMatchObject({
      state: "needs_confirmation",
      destructive: true,
    });
    expect(affordances.find((item) => item.id === "interrupt_worker")).toMatchObject({
      state: "disabled",
      destructive: true,
      focus_changing: true,
    });
    expect(affordances.find((item) => item.id === "rerun_goal")).toMatchObject({
      state: "disabled",
      destructive: true,
    });
    expect(affordances.find((item) => item.id === "open_team_layout")).toMatchObject({
      state: "needs_confirmation",
      focus_changing: false,
    });
    const rendered = JSON.stringify(affordances);
    expect(rendered).not.toMatch(/\b(?:kill|pkill|killall|send-key|focus-pane|select-workspace)\b/);
  });

  it("reports unsupported or disabled states with localized catalog text when evidence is missing", () => {
    const state = createHarnessWorkspaceState({ locale: "zh-CN" });
    const continuity = deriveContinuity(state);
    const affordances = deriveOperatorAffordances(state, continuity);

    expect(continuity.replay_only).toBe(true);
    expect(continuity.reasons).toEqual(expect.arrayContaining([
      "owner_not_verified",
      "worker_session_missing",
      "attach_command_missing",
    ]));
    expect(affordances.find((item) => item.id === "copy_attach_command")).toMatchObject({
      state: "disabled",
      label: "复制 attach 命令",
      reason_label: "attach_command 证据不可用",
    });
    expect(affordances.find((item) => item.id === "open_team_layout")).toMatchObject({
      state: "unsupported",
      reason_label: "run_id 证据不可用",
    });
  });

  it("does not overclaim continue without accepted run and runtime-surface evidence", () => {
    let state = recordDiscovery(createHarnessWorkspaceState(), harnessDiscoveryFixture);
    state = recordEvent(state, frame(1, "agent_event", {
      name: "attach_target",
      payload: {
        agent_id: "coder-1",
        session_id: "holp-direct-75",
        attach_command: "tmux attach -t holp-direct-75",
      },
    }, "agent"));

    const continuity = deriveContinuity(state);
    const affordances = deriveOperatorAffordances(state, continuity);

    expect(continuity.can_continue).toBe(false);
    expect(continuity.reasons).toContain("runtime_surface_missing");
    expect(affordances.find((item) => item.id === "continue_run")).toMatchObject({
      state: "disabled",
    });
  });
});
