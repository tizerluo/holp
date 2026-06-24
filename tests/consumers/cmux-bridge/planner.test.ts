import { describe, expect, it } from "vitest";
import {
  assertValidCmuxLayoutCommand,
  cmuxCommandArgs,
  cmuxWorkspaceFromEnv,
  formatCmuxCommand,
  planCmuxTeamLayout,
  validateCmuxLayoutCommand,
} from "../../../consumers/cmux-bridge/index.js";
import {
  createHarnessWorkspaceState,
  deriveOverview,
  frame,
  harnessDiscoveryFixture,
  recordDiscovery,
  recordEvent,
  recordRunAccepted,
} from "../../../consumers/harness-workspace/index.js";
import { buildFocusShellDemoModel } from "../../../consumers/harness-workspace/demo.js";

function demoPlan() {
  return planCmuxTeamLayout({
    caller: { workspaceId: "workspace:74", surfaceId: "surface:ctrl" },
    model: buildFocusShellDemoModel({ locale: "en-US", mode: "overview" }),
    viewDir: "/tmp/holp-test-layout",
  });
}

describe("cmux Team Layout planner", () => {
  it("emits public-wire consumer-view panes for discovered agent roles and helpers", () => {
    const plan = demoPlan();

    expect(plan.executable).toBe(true);
    expect(plan.commands.length).toBeGreaterThan(0);
    expect(plan.views.map((view) => view.target.kind)).toEqual([
      "mission-control",
      "role",
      "role",
      "evidence",
    ]);
    expect(plan.views.find((view) => view.target.agentId === "coder-1")?.markdown).toContain(
      "HOLP public-wire consumer view",
    );
    expect(plan.views.find((view) => view.target.kind === "mission-control")?.markdown).toContain(
      "Controller: existing caller surface, not recreated",
    );
  });

  it("does not emit missing roles or recreate the Controller pane", () => {
    const plan = demoPlan();
    const roleTargets = plan.commands.filter((command) => command.target.kind === "role");

    expect(roleTargets.map((command) => command.target.agentId)).toEqual(["coder-1", "reviewer-1"]);
    expect(roleTargets.some((command) => command.target.role === "TEST")).toBe(false);
    expect(plan.commands.some((command) => command.target.role === "CTRL")).toBe(false);
  });

  it("keeps every planned command allowlisted, workspace-scoped, and focus-neutral", () => {
    const plan = demoPlan();

    for (const command of plan.commands) {
      expect(() => assertValidCmuxLayoutCommand(command)).not.toThrow();
      expect(validateCmuxLayoutCommand(command)).toEqual([]);
      expect(command.args).toContain("--workspace");
      if (command.name === "markdown open" || command.name.startsWith("new-")) {
        expect(command.args).toContain("--focus");
        expect(command.args[command.args.indexOf("--focus") + 1]).toBe("false");
      }
    }
  });

  it("logs the final planned command count", () => {
    const plan = demoPlan();
    const log = plan.commands.find((command) => command.name === "log");

    expect(log?.args).toContain(`HOLP Team Layout planned commands=${plan.commands.length}`);
  });

  it("does not emit forbidden cmux commands or fake native role sessions", () => {
    const plan = demoPlan();
    const serialized = plan.commands.map((command) => formatCmuxCommand(command)).join("\n");
    const markdown = plan.views.map((view) => view.markdown).join("\n");

    expect(serialized).not.toMatch(/\b(?:focus-window|focus-pane|focus-panel|select-workspace|close-pane|move-surface|send-key|set-hook)\b/);
    expect(`${serialized}\n${markdown}`).not.toMatch(/\btmux\s+attach\b/);
    expect(`${serialized}\n${markdown}`).not.toContain("new-surface --provider");
    for (const command of plan.commands.filter((command) => command.target.kind === "role")) {
      expect(command.contentCommand).toContain("npm run harness:workspace");
      expect(command.contentCommand).toContain("--mode inspect");
    }
  });

  it("creates Evidence only when gate, failure, terminal, approval, or evidence refs exist", () => {
    const quietState = recordRunAccepted(
      recordDiscovery(createHarnessWorkspaceState(), harnessDiscoveryFixture),
      {
        run_id: "run_quiet",
        runtime: { agent_id: "coder-1", runtime_surface: "direct_user_session" },
      },
    );
    const quiet = planCmuxTeamLayout({
      caller: { workspaceId: "workspace:quiet" },
      model: deriveOverview(quietState),
      viewDir: "/tmp/quiet",
    });
    expect(quiet.views.some((view) => view.target.kind === "evidence")).toBe(false);

    const cases = [
      recordEvent(quietState, frame(1, "approval_requested", { approval_id: "ap_1" })),
      recordEvent(quietState, frame(1, "run_merged", { artifact_id: "art_terminal" })),
      recordEvent(quietState, frame(1, "consensus_degraded", { reason: "quorum_unsatisfiable" })),
      recordEvent(quietState, frame(1, "run_blocked", { reason: "gate_blocked" })),
    ];

    for (const [index, state] of cases.entries()) {
      const plan = planCmuxTeamLayout({
        caller: { workspaceId: `workspace:evidence-${index}` },
        model: deriveOverview(state),
        viewDir: `/tmp/evidence-${index}`,
      });
      expect(plan.views.some((view) => view.target.kind === "evidence")).toBe(true);
    }
  });

  it("degrades to a zero-command plan when workspace is missing", () => {
    for (const caller of [{}, { workspaceId: "--focus" }]) {
      const plan = planCmuxTeamLayout({
        caller,
        model: buildFocusShellDemoModel({ locale: "en-US", mode: "overview" }),
        viewDir: "/tmp/no-workspace",
      });

      expect(plan.executable).toBe(false);
      expect(plan.commands).toEqual([]);
      expect(plan.degradedReasons).toContain("missing_workspace");
    }
  });

  it("accepts only real cmux workspace values from env", () => {
    expect(cmuxWorkspaceFromEnv({ CMUX_WORKSPACE_ID: "workspace:2" })).toBe("workspace:2");
    expect(cmuxWorkspaceFromEnv({ CMUX_WORKSPACE_ID: "workspace:abc-def" })).toBe("workspace:abc-def");
    expect(cmuxWorkspaceFromEnv({ CMUX_WORKSPACE_ID: "--focus" })).toBeUndefined();
    expect(cmuxWorkspaceFromEnv({ CMUX_WORKSPACE_ID: "" })).toBeUndefined();
  });

  it("rejects non-allowlisted, non-workspace, focus-changing, provider, and tmux attach commands", () => {
    expect(validateCmuxLayoutCommand({
      name: "new-pane",
      args: ["--type", "terminal", "--direction", "right", "--focus", "false"],
      target: { kind: "mission-control", title: "bad" },
    })).toContain("missing_workspace");
    expect(validateCmuxLayoutCommand({
      name: "new-pane",
      args: ["--workspace", "--focus", "false", "--type", "terminal"],
      target: { kind: "mission-control", title: "bad" },
    })).toContain("missing_workspace");
    expect(validateCmuxLayoutCommand({
      name: "new-pane",
      args: ["--workspace", "", "--type", "terminal", "--focus", "false"],
      target: { kind: "mission-control", title: "bad" },
    })).toContain("missing_workspace");
    expect(validateCmuxLayoutCommand({
      name: "new-pane",
      args: ["--workspace", "workspace:1", "--type", "terminal"],
      target: { kind: "mission-control", title: "bad" },
    })).toContain("missing_focus_false");
    expect(validateCmuxLayoutCommand({
      name: "new-surface",
      args: ["--workspace", "workspace:1", "--provider", "codex", "--focus", "false"],
      target: { kind: "role", role: "CODE", agentId: "coder-1", title: "bad" },
    })).toContain("forbidden_provider_surface");
    expect(validateCmuxLayoutCommand({
      name: "markdown open",
      args: ["/tmp/view.md", "--workspace", "workspace:1", "--focus", "false", "tmux attach -t holp-x"],
      target: { kind: "role", role: "CODE", agentId: "coder-1", title: "bad" },
    })).toContain("forbidden_tmux_attach");
    expect(cmuxCommandArgs(demoPlan().commands[0] ?? (() => { throw new Error("missing command"); })()).slice(0, 2)).toEqual([
      "markdown",
      "open",
    ]);
  });
});
