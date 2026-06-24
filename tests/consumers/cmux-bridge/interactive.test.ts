import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  assertValidInteractiveHarnessCommand,
  cmuxCommandArgs,
  executeInteractiveHarnessWorkspacePlan,
  formatCmuxCommand,
  planInteractiveHarnessWorkspace,
  validateInteractiveHarnessCommand,
} from "../../../consumers/cmux-bridge/index.js";
import { frame } from "../../../consumers/harness-workspace/index.js";

function available(command: string): boolean {
  return command === "codex" || command === "kimi";
}

function plan(controller = "codex") {
  return planInteractiveHarnessWorkspace({
    caller: {
      workspaceId: "workspace:85",
      surfaceId: "surface:caller",
      cwd: "/repo/holp",
      env: { PATH: "/bin" },
    },
    controller,
    viewDir: "/tmp/holp-interactive-test",
    predicates: { isOnPath: available },
  });
}

describe("interactive Harness Workspace launcher", () => {
  it("defaults to dry-run and executes zero cmux mutations", async () => {
    const planned = plan();
    const calls: { command: string; args: readonly string[] }[] = [];
    const result = await executeInteractiveHarnessWorkspacePlan(planned, {
      env: {},
      runner: async (command, args) => {
        calls.push({ command, args });
        return { command: `${command} ${args.join(" ")}`, ok: true };
      },
      writeView: () => {
        throw new Error("dry-run must not write views");
      },
    });

    expect(result.mode).toBe("dry-run");
    expect(result.executed).toEqual([]);
    expect(result.skipped).toHaveLength(planned.commands.length);
    expect(calls).toEqual([]);
    expect(result.degradedReasons).toContain("execution_not_enabled");
  });

  it("degrades to zero commands when workspace is missing", () => {
    const missing = planInteractiveHarnessWorkspace({
      caller: { env: { PATH: "/bin" }, cwd: "/repo/holp" },
      predicates: { isOnPath: available },
    });

    expect(missing.executable).toBe(false);
    expect(missing.commands).toEqual([]);
    expect(missing.degradedReasons).toContain("missing_workspace");
  });

  it("shows missing controller binary as degraded while still creating the manual terminal pane", () => {
    const missing = planInteractiveHarnessWorkspace({
      caller: { workspaceId: "workspace:85", env: { PATH: "/bin" }, cwd: "/repo/holp" },
      viewDir: "/tmp/holp-interactive-test",
      predicates: { isOnPath: () => false },
    });

    expect(missing.executable).toBe(true);
    expect(missing.degradedReasons).toContain("missing_controller_binary");
    expect(missing.commands.some((command) => command.target.kind === "controller")).toBe(true);
    expect(missing.views.find((view) => view.target.kind === "sidecar")?.markdown).toContain("missing_controller_binary");
    expect(missing.views.find((view) => view.target.kind === "sidecar")?.markdown).toContain("type `cd /repo/holp && codex`");
  });

  it("allowlists codex and kimi-code labels while rejecting claude-code and arbitrary commands", () => {
    expect(plan("codex").controller).toMatchObject({ label: "codex", startupCommand: "codex" });
    expect(plan("kimi-code").controller).toMatchObject({ label: "kimi-code", startupCommand: "kimi" });

    const rejected = plan("claude-code");
    expect(rejected.controller).toMatchObject({ label: "unsupported", requested: "claude-code" });
    expect(rejected.degradedReasons).toContain("unsupported_controller");
    expect(rejected.commands.some((command) => command.target.kind === "controller")).toBe(false);

    const codexExec = validateInteractiveHarnessCommand({
      name: "new-pane",
      args: ["--workspace", "workspace:85", "--focus", "false", "--command", "codex exec"],
      target: { kind: "controller", title: "bad" },
    });
    expect(codexExec).toContain("unsupported_controller_command");
    expect(codexExec).toContain("headless_controller_command");

    const kimiPrompt = validateInteractiveHarnessCommand({
      name: "new-pane",
      args: ["--workspace", "workspace:85", "--focus", "false", "--command", "kimi -p"],
      target: { kind: "controller", title: "bad" },
    });
    expect(kimiPrompt).toContain("unsupported_controller_command");
    expect(kimiPrompt).toContain("headless_controller_command");

    const outputFormat = validateInteractiveHarnessCommand({
      name: "new-pane",
      args: ["--workspace", "workspace:85", "--focus", "false", "--command", "kimi --output-format text"],
      target: { kind: "controller", title: "bad" },
    });
    expect(outputFormat).toContain("unsupported_controller_command");
    expect(outputFormat).toContain("headless_controller_command");

    expect(validateInteractiveHarnessCommand({
      name: "new-pane",
      args: ["--workspace", "workspace:85", "--focus", "false", "--type", "terminal", "--command", "codex"],
      target: { kind: "controller", title: "bad" },
    })).toContain("unsupported_controller_command");
  });

  it("creates a real terminal controller pane and leaves startup manual", () => {
    const planned = plan();
    const controller = planned.commands.find((command) => command.target.kind === "controller");

    expect(controller).toBeDefined();
    expect(controller?.name).toBe("new-pane");
    expect(controller?.args).toContain("--workspace");
    expect(controller?.args[controller.args.indexOf("--workspace") + 1]).toBe("workspace:85");
    expect(controller?.args).toContain("--focus");
    expect(controller?.args[controller.args.indexOf("--focus") + 1]).toBe("false");
    expect(controller?.args).toContain("--type");
    expect(controller?.args[controller.args.indexOf("--type") + 1]).toBe("terminal");
    expect(controller?.args).not.toContain("--command");
    expect(controller?.args).not.toContain("--title");
    expect(controller?.args).not.toContain("--cwd");
    expect(controller?.args).toEqual([
      "--workspace",
      "workspace:85",
      "--direction",
      "right",
      "--focus",
      "false",
      "--type",
      "terminal",
    ]);
    expect(controller?.contentCommand).toBe("codex");
    expect(formatCmuxCommand(controller!)).toContain("cmux new-pane");
    expect(formatCmuxCommand(controller!)).not.toMatch(/\b(exec|-p|--output-format|claude-code)\b/);
    expect(() => assertValidInteractiveHarnessCommand(controller!)).not.toThrow();
    expect(planned.degradedReasons).toContain("controller_manual_start_required");
    expect(planned.views.find((view) => view.target.kind === "sidecar")?.markdown).toContain("type `cd /repo/holp && codex`");
  });

  it("keeps every cmux command allowlisted, workspace-scoped, and focus-neutral", () => {
    const planned = plan("kimi-code");

    for (const command of planned.commands) {
      expect(() => assertValidInteractiveHarnessCommand(command)).not.toThrow();
      expect(command.args).toContain("--workspace");
      if (command.name === "markdown open" || command.name.startsWith("new-")) {
        expect(command.args).toContain("--focus");
        expect(command.args[command.args.indexOf("--focus") + 1]).toBe("false");
      }
    }
    const serialized = planned.commands.map((command) => formatCmuxCommand(command)).join("\n");
    expect(serialized).not.toMatch(/\b(?:close-pane|move-surface|focus-pane|send-key|send)\b/);
    expect(planned.commands.map((command) => cmuxCommandArgs(command)[0])).toContain("new-pane");
  });

  it("executes only after HOLP_HARNESS_WORKSPACE_INTERACTIVE opt-in", async () => {
    const planned = plan();
    const calls: readonly string[][] = [];
    const mutableCalls: string[][] = [];
    const result = await executeInteractiveHarnessWorkspacePlan(planned, {
      env: { HOLP_HARNESS_WORKSPACE_INTERACTIVE: "1" },
      cwd: "/repo/holp",
      cmuxCommand: "/bin/cmux",
      writeView: () => undefined,
      runner: async (command, args) => {
        mutableCalls.push([command, ...args]);
        return { command: `${command} ${args.join(" ")}`, ok: true };
      },
    });

    expect(result.mode).toBe("executed");
    expect(result.executed).toHaveLength(planned.commands.length);
    expect(calls.length).toBe(0);
    expect(mutableCalls.every((call) => call[0] === "/bin/cmux")).toBe(true);
    expect(mutableCalls.map((call) => call.slice(1))).toEqual(planned.commands.map((command) => cmuxCommandArgs(command)));
  });

  it("does not blame the controller pane when a non-controller cmux command fails", async () => {
    const planned = plan();
    const result = await executeInteractiveHarnessWorkspacePlan(planned, {
      env: { HOLP_HARNESS_WORKSPACE_INTERACTIVE: "1" },
      cwd: "/repo/holp",
      cmuxCommand: "/bin/cmux",
      writeView: () => undefined,
      runner: async (command, args) => {
        const failed = args[0] === "set-status";
        return {
          command: `${command} ${args.join(" ")}`,
          ok: !failed,
          error: failed ? "set-status failed" : undefined,
        };
      },
    });

    expect(result.mode).toBe("executed");
    expect(result.degradedReasons).toContain("cmux_command_failed");
    expect(result.degradedReasons).not.toContain("controller_pane_failed");
  });

  it("reports controller_pane_failed only when the controller pane command fails", async () => {
    const planned = plan();
    const result = await executeInteractiveHarnessWorkspacePlan(planned, {
      env: { HOLP_HARNESS_WORKSPACE_INTERACTIVE: "1" },
      cwd: "/repo/holp",
      cmuxCommand: "/bin/cmux",
      writeView: () => undefined,
      runner: async (command, args) => {
        const failed = args[0] === "new-pane";
        return {
          command: `${command} ${args.join(" ")}`,
          ok: !failed,
          error: failed ? "new-pane failed" : undefined,
        };
      },
    });

    expect(result.mode).toBe("executed");
    expect(result.degradedReasons).toContain("cmux_command_failed");
    expect(result.degradedReasons).toContain("controller_pane_failed");
  });

  it("degrades invalid command plans before running cmux", async () => {
    const planned = {
      ...plan(),
      commands: [
        {
          name: "new-pane" as const,
          args: ["--workspace", "workspace:85", "--focus", "false", "--type", "terminal", "--command", "codex"],
          target: { kind: "controller" as const, title: "bad" },
        },
      ],
    };
    const result = await executeInteractiveHarnessWorkspacePlan(planned, {
      env: { HOLP_HARNESS_WORKSPACE_INTERACTIVE: "1" },
      runner: async () => {
        throw new Error("invalid plan must not execute");
      },
    });

    expect(result.mode).toBe("degraded");
    expect(result.executed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.degradedReasons).toContain("invalid_command");
  });

  it("renders waiting_for_run_id and live_follow_degraded honestly with direct session expectations", () => {
    const planned = plan();
    const sidecar = planned.views.find((view) => view.target.kind === "sidecar")?.markdown ?? "";
    const evidence = planned.views.find((view) => view.target.kind === "evidence")?.markdown ?? "";
    const replay = planned.views.find((view) => view.target.kind === "replay")?.markdown ?? "";

    expect(planned.runFollowState).toBe("waiting_for_run_id");
    expect(planned.expectedWorkerSurface).toBe("direct_user_session");
    expect(planned.degradedReasons).toContain("controller_manual_start_required");
    expect(planned.degradedReasons).toContain("missing_live_run_attach");
    expect(planned.degradedReasons).toContain("missing_direct_worker_readiness");
    expect(`${sidecar}\n${evidence}\n${replay}`).toContain("waiting_for_run_id");
    expect(`${sidecar}\n${evidence}\n${replay}`).toContain("direct_user_session");
    expect(`${sidecar}\n${evidence}\n${replay}`).not.toContain("headless readiness");
  });

  it("keeps explicit run-id follow degraded until public run attach exists", () => {
    const planned = planInteractiveHarnessWorkspace({
      caller: { workspaceId: "workspace:85", env: { PATH: "/bin" }, cwd: "/repo/holp" },
      viewDir: "/tmp/holp-interactive-test",
      predicates: { isOnPath: available },
      runId: "run_known",
    });

    expect(planned.runFollowState).toBe("live_follow_degraded");
    expect(planned.degradedReasons).toContain("missing_live_run_attach");
    expect(planned.views.find((view) => view.target.kind === "sidecar")?.markdown).toContain("live_follow_degraded");
  });

  it("labels synthetic event projection as fixture-only rather than live human-run evidence", () => {
    const projected = planInteractiveHarnessWorkspace({
      caller: { workspaceId: "workspace:85", env: { PATH: "/bin" }, cwd: "/repo/holp" },
      viewDir: "/tmp/holp-interactive-test",
      predicates: { isOnPath: available },
      events: [
        frame(1, "run_started", {
          runtime: {
            agent_id: "coder-1",
            runtime_surface: "direct_user_session",
          },
        }),
        frame(2, "agent_event", {
          name: "attach_target",
          payload: {
            agent_id: "coder-1",
            session_id: "holp-direct-85",
            attach_command: "tmux attach -t holp-direct-85",
          },
        }, "agent"),
        frame(3, "gate_report", {
          decision_surface: { gate_disposition: "approved", review_outcome: "approve" },
        }),
        frame(4, "run_merged", { artifact_id: "art_terminal" }),
      ],
    });

    expect(projected.runFollowState).toBe("fixture_projection");
    expect(projected.degradedReasons).not.toContain("missing_direct_worker_readiness");
    expect(projected.views.find((view) => view.target.kind === "evidence")?.markdown).toContain("holp-direct-85");
    expect(projected.views.find((view) => view.target.kind === "evidence")?.markdown).toContain("approved approve");
    expect(projected.views.find((view) => view.target.kind === "replay")?.markdown).toContain("Synthetic event projection is test-only");
  });

  it("demo script is dry-run by default", () => {
    const output = execFileSync("npm", ["run", "harness:workspace:interactive", "--", "--workspace", "workspace:dry"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOLP_HARNESS_WORKSPACE_INTERACTIVE: "", PATH: process.env.PATH ?? "" },
    });

    expect(output).toContain("HOLP Interactive Harness Workspace");
    expect(output).toContain("mode=dry-run");
    expect(output).toContain("workspace=workspace:dry");
    expect(output).toContain("run_follow=waiting_for_run_id");
  });
});
