import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EventFrame } from "../../consumers/cli/wire.js";
import {
  assertSuccessGate,
  attachCommandForSession,
  buildClientCommand,
  buildControllerSpec,
  buildDaemonCommand,
  buildDashboardMarkdown,
  buildResultBlock,
  cmuxStatusLine,
  cmuxVisibleAgentChainEnabled,
  cmuxWorkspaceFromEnv,
  dashboardPathForMarker,
  DISABLED_CONTROLLER_REASON,
  DISABLED_CONTROLLERS,
  ENABLED_CONTROLLERS,
  evaluateMarkerGate,
  extractWorkerSessionFromStepStarted,
  isEnabledController,
  markerInControllerOutput,
  parseResultBlock,
  PASS_MARKER,
  resolveCmuxCommand,
  selectDirectReadyAgent,
  tsxLoaderPathForRepo,
  updateDashboardForMarker,
  visibleAgentChainSmokeEnabled,
  workerForController,
} from "../../scripts/smoke/visible-agent-chain.js";

describe("visible agent chain smoke helpers", () => {
  it("skips unless HOLP_VISIBLE_AGENT_CHAIN_SMOKE=1", () => {
    expect(visibleAgentChainSmokeEnabled({})).toBe(false);
    expect(visibleAgentChainSmokeEnabled({ HOLP_VISIBLE_AGENT_CHAIN_SMOKE: "0" })).toBe(false);
    expect(visibleAgentChainSmokeEnabled({ HOLP_VISIBLE_AGENT_CHAIN_SMOKE: "1" })).toBe(true);
  });

  it("extracts holp- session id from step_started detail", () => {
    const event: EventFrame = {
      run_id: "run_1",
      seq: 2,
      category: "agent",
      name: "step_started",
      payload: { status: "starting", detail: "holp-1234567890-abc" },
    };
    expect(extractWorkerSessionFromStepStarted(event)).toBe("holp-1234567890-abc");
  });

  it("returns undefined for non-holp- detail in step_started", () => {
    const event: EventFrame = {
      run_id: "run_1",
      seq: 2,
      category: "agent",
      name: "step_started",
      payload: { status: "running", detail: "other-session" },
    };
    expect(extractWorkerSessionFromStepStarted(event)).toBeUndefined();
  });

  it("returns undefined when step_started detail is missing", () => {
    const event: EventFrame = {
      run_id: "run_1",
      seq: 2,
      category: "agent",
      name: "step_started",
      payload: { status: "starting" },
    };
    expect(extractWorkerSessionFromStepStarted(event)).toBeUndefined();
  });

  it("formats attach_command correctly from session name", () => {
    expect(attachCommandForSession("holp-1234-abc")).toBe("tmux attach -t holp-1234-abc");
  });

  it("selects agent with ready direct_user_session surface", () => {
    const { agent } = selectDirectReadyAgent([
      {
        id: "kimi-code-agent",
        runtime_surfaces: [
          {
            runtime_surface: "direct_user_session",
            isolation_profiles: { coder_worktree: { readiness: "ready" } },
          },
        ],
      },
    ]);
    expect(agent.id).toBe("kimi-code-agent");
  });

  it("does not select agent when direct_user_session surface is degraded", () => {
    expect(() =>
      selectDirectReadyAgent([
        {
          id: "kimi-code-agent",
          runtime_surfaces: [
            {
              runtime_surface: "direct_user_session",
              isolation_profiles: { coder_worktree: { readiness: "degraded" } },
            },
          ],
        },
      ])
    ).toThrow(/no ready direct_user_session/);
  });

  it("does not confuse a ready acp surface with direct_user_session readiness", () => {
    expect(() =>
      selectDirectReadyAgent([
        {
          id: "kimi-code-agent",
          runtime_surfaces: [
            {
              runtime_surface: "acp",
              isolation_profiles: { coder_worktree: { readiness: "ready" } },
            },
            {
              runtime_surface: "direct_user_session",
              isolation_profiles: { coder_worktree: { readiness: "degraded" } },
            },
          ],
        },
      ])
    ).toThrow(/no ready direct_user_session/);
  });

  it("passes the strict success gate for a fully valid block", () => {
    expect(() =>
      assertSuccessGate({
        terminal: "run_merged",
        surface: "direct_user_session",
        worker_session: "holp-1234-abc",
        model_output_marker: "found",
      })
    ).not.toThrow();
  });

  it("rejects success gate when terminal is not run_merged", () => {
    expect(() =>
      assertSuccessGate({
        terminal: "run_cancelled",
        surface: "direct_user_session",
        worker_session: "holp-123",
        model_output_marker: "found",
      })
    ).toThrow(/terminal=run_cancelled/);
  });

  it("rejects success gate when surface is not direct_user_session", () => {
    expect(() =>
      assertSuccessGate({
        terminal: "run_merged",
        surface: "acp",
        worker_session: "holp-123",
        model_output_marker: "found",
      })
    ).toThrow(/surface=acp/);
  });

  it("rejects success gate when worker_session does not match /^holp-/", () => {
    expect(() =>
      assertSuccessGate({
        terminal: "run_merged",
        surface: "direct_user_session",
        worker_session: "other-session-xyz",
        model_output_marker: "found",
      })
    ).toThrow(/worker_session=other-session-xyz/);
  });

  it("rejects success gate when model_output_marker is not found", () => {
    expect(() =>
      assertSuccessGate({
        terminal: "run_merged",
        surface: "direct_user_session",
        worker_session: "holp-123",
        model_output_marker: "not_found",
      })
    ).toThrow(/model_output_marker=not_found/);
  });

  it("detects marker present in controller output (triangulation)", () => {
    expect(
      markerInControllerOutput("some text HOLP_CHAIN_MARKER_123 more text", "HOLP_CHAIN_MARKER_123")
    ).toBe(true);
  });

  it("returns false when marker is absent from controller output", () => {
    expect(markerInControllerOutput("no marker here", "HOLP_CHAIN_MARKER_123")).toBe(false);
  });

  it("flags marker gate failure when result block is present but marker is absent from controller output", () => {
    const block = parseResultBlock(
      buildResultBlock({
        marker: "HOLP_CHAIN_MARKER_123",
        surface: "direct_user_session",
        worker_session: "holp-123-abc",
        terminal: "run_merged",
        model_output_marker: "found",
      }),
    );
    expect(block).toBeDefined();
    expect(
      evaluateMarkerGate(block, "result block present but marker missing", "HOLP_CHAIN_MARKER_123"),
    ).toBe(true);
  });

  it("passes marker gate when marker appears in controller output", () => {
    const block = parseResultBlock(
      buildResultBlock({
        marker: "HOLP_CHAIN_MARKER_123",
        surface: "direct_user_session",
        worker_session: "holp-123-abc",
        terminal: "run_merged",
        model_output_marker: "found",
      }),
    );
    expect(
      evaluateMarkerGate(block, "output contains HOLP_CHAIN_MARKER_123 end", "HOLP_CHAIN_MARKER_123"),
    ).toBe(false);
  });

  it("does not flag marker gate failure when result block is missing", () => {
    expect(evaluateMarkerGate(undefined, "", "HOLP_CHAIN_MARKER_123")).toBe(false);
  });

  it("recognizes codex and kimi-code as enabled controllers", () => {
    expect(isEnabledController("codex")).toBe(true);
    expect(isEnabledController("kimi-code")).toBe(true);
    expect(ENABLED_CONTROLLERS).toContain("codex");
    expect(ENABLED_CONTROLLERS).toContain("kimi-code");
  });

  it("reports known disabled controllers with consistent reason", () => {
    for (const name of ["claude-code", "cursor-agent", "opencode", "pi", "reasonix"]) {
      expect(isEnabledController(name)).toBe(false);
      expect(DISABLED_CONTROLLERS[name]).toBe(DISABLED_CONTROLLER_REASON);
    }
  });

  it("cmux status line contains cmux-pending-user-validation and never cmux-ready", () => {
    const line = cmuxStatusLine();
    expect(line).toContain("cmux-pending-user-validation");
    expect(line).not.toContain("cmux-ready");
  });

  it("round-trips result block through build and parse", () => {
    const fields = {
      marker: "HOLP_CHAIN_MARKER_1234",
      surface: "direct_user_session",
      worker_session: "holp-999-xyz",
      terminal: "run_merged",
      model_output_marker: "found",
    };
    const block = buildResultBlock(fields);
    const parsed = parseResultBlock(block);
    expect(parsed).toMatchObject(fields);
  });

  it("returns undefined when result block boundary markers are missing", () => {
    expect(parseResultBlock("no result block here")).toBeUndefined();
    expect(parseResultBlock("HOLP_CHAIN_RESULT_BEGIN\nonly begin")).toBeUndefined();
  });

  it("maps controller to default worker transport", () => {
    expect(workerForController("codex")).toBe("kimi-code");
    expect(workerForController("kimi-code")).toBe("opencode");
  });

  it("builds codex controller spec with correct flags and stdin ignored", () => {
    const spec = buildControllerSpec("codex", "test prompt", "/repo");
    expect(spec.command).toBe("codex");
    expect(spec.args[0]).toBe("--disable");
    expect(spec.args[1]).toBe("code_mode");
    expect(spec.args[2]).toBe("exec");
    expect(spec.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(spec.args).not.toContain("--sandbox");
    expect(spec.args).not.toContain("workspace-write");
    expect(spec.args).toContain("--skip-git-repo-check");
    expect(spec.args).toContain("-C");
    expect(spec.args).toContain("/repo");
    expect(spec.args).toContain("test prompt");
    expect(spec.ignoreStdin).toBe(true);
  });

  it("builds kimi-code controller spec with -p prompt flag and stdin ignored", () => {
    const spec = buildControllerSpec("kimi-code", "test prompt", "/repo");
    expect(spec.command).toBe("kimi");
    expect(spec.args).toContain("-p");
    expect(spec.args).toContain("test prompt");
    expect(spec.args).toContain("--output-format");
    expect(spec.args).toContain("text");
    expect(spec.ignoreStdin).toBe(true);
  });

  it("builds client command using node --import tsx (no tsx CLI)", () => {
    const cmd = buildClientCommand({
      workerTransport: "kimi-code",
      marker: "HOLP_CHAIN_MARKER_123",
      controller: "codex",
    });
    expect(cmd).toMatch(/^node --import tsx /);
    expect(cmd).not.toContain("npm exec");
    expect(cmd).not.toMatch(/^tsx /);
    expect(cmd).toContain("--client");
    expect(cmd).toContain("--worker kimi-code");
    expect(cmd).toContain("--marker HOLP_CHAIN_MARKER_123");
    expect(cmd).toContain("--controller codex");
    expect(cmd).toContain("scripts/smoke/visible-agent-chain.ts");
  });

  it("builds client command with custom script path", () => {
    const cmd = buildClientCommand({
      workerTransport: "opencode",
      marker: "HOLP_CHAIN_MARKER_456",
      controller: "kimi-code",
      scriptPath: "custom/script.ts",
    });
    expect(cmd).toMatch(/^node --import tsx custom\/script\.ts/);
    expect(cmd).toContain("--worker opencode");
    expect(cmd).toContain("--controller kimi-code");
  });

  it("resolves absolute tsx loader path under repo node_modules", () => {
    const loader = tsxLoaderPathForRepo("/repo");
    expect(loader).toBe("/repo/node_modules/tsx/dist/loader.mjs");
  });

  it("builds daemon command with absolute tsx loader and server entry", () => {
    const { command, args } = buildDaemonCommand("/repo", "/repo/daemon/runtime/server.ts");
    expect(command).toBe("node");
    expect(args).toHaveLength(3);
    expect(args[0]).toBe("--import");
    expect(args[1]).toBe("/repo/node_modules/tsx/dist/loader.mjs");
    expect(args[1]).toMatch(/node_modules\/tsx\/dist\/loader\.mjs$/);
    expect(args[2]).toBe("/repo/daemon/runtime/server.ts");
  });

  it("PASS marker includes canonical PASS visible-agent-chain", () => {
    expect(PASS_MARKER).toBe("PASS visible-agent-chain");
  });

  it("detects cmux visibility when HOLP_VISIBLE_AGENT_CHAIN_CMUX=1", () => {
    expect(cmuxVisibleAgentChainEnabled({})).toBe(false);
    expect(cmuxVisibleAgentChainEnabled({ HOLP_VISIBLE_AGENT_CHAIN_CMUX: "0" })).toBe(false);
    expect(cmuxVisibleAgentChainEnabled({ HOLP_VISIBLE_AGENT_CHAIN_CMUX: "1" })).toBe(true);
  });

  it("detects cmux visibility when CMUX_WORKSPACE_ID is present", () => {
    expect(cmuxVisibleAgentChainEnabled({ CMUX_WORKSPACE_ID: "workspace:1" })).toBe(true);
    expect(cmuxVisibleAgentChainEnabled({ CMUX_WORKSPACE_ID: "" })).toBe(false);
  });

  it("reads CMUX_WORKSPACE_ID from env", () => {
    expect(cmuxWorkspaceFromEnv({})).toBeUndefined();
    expect(cmuxWorkspaceFromEnv({ CMUX_WORKSPACE_ID: "workspace:2" })).toBe("workspace:2");
  });

  it("resolves cmux command from env override", () => {
    expect(
      resolveCmuxCommand(
        { HOLP_VISIBLE_AGENT_CHAIN_CMUX_BIN: "/custom/cmux" },
        { isOnPath: () => false, isExecutableFile: () => false },
      ),
    ).toBe("/custom/cmux");
  });

  it("resolves cmux command from PATH when available", () => {
    expect(
      resolveCmuxCommand(
        { PATH: "/usr/local/bin" },
        { isOnPath: (cmd) => cmd === "cmux", isExecutableFile: () => false },
      ),
    ).toBe("cmux");
  });

  it("falls back to app binary when not in PATH but app executable exists", () => {
    expect(
      resolveCmuxCommand(
        {},
        {
          isOnPath: () => false,
          isExecutableFile: (p) => p === "/Applications/cmux.app/Contents/Resources/bin/cmux",
        },
      ),
    ).toBe("/Applications/cmux.app/Contents/Resources/bin/cmux");
  });

  it("falls back to cmux when no override, PATH, or app executable", () => {
    expect(
      resolveCmuxCommand(
        {},
        { isOnPath: () => false, isExecutableFile: () => false },
      ),
    ).toBe("cmux");
  });

  it("computes dashboard path from marker", () => {
    expect(dashboardPathForMarker("HOLP_CHAIN_MARKER_123")).toBe(
      "/tmp/holp-visible-agent-chain/HOLP_CHAIN_MARKER_123/dashboard.md",
    );
  });

  it("builds dashboard markdown with all required fields", () => {
    const markdown = buildDashboardMarkdown({
      controller: "codex",
      worker: "kimi-code",
      marker: "HOLP_CHAIN_MARKER_123",
      runId: "run_1",
      workerSession: "holp-123-abc",
      attachCommand: "tmux attach -t holp-123-abc",
      timeline: ["run_started (seq=1)", "step_started (seq=2)", "run_merged (seq=3)"],
      finalResult: "pass",
      cmuxStatus: "INFO cmux_status=cmux-pending-user-validation",
      updatedAt: "2026-06-24T00:00:00.000Z",
    });
    expect(markdown).toContain("HOLP Visible Agent Chain — HOLP_CHAIN_MARKER_123");
    expect(markdown).toContain("**Controller:** codex");
    expect(markdown).toContain("**Worker:** kimi-code");
    expect(markdown).toContain("**Marker:** HOLP_CHAIN_MARKER_123");
    expect(markdown).toContain("**Run ID:** run_1");
    expect(markdown).toContain("**Worker Session:** holp-123-abc");
    expect(markdown).toContain("tmux attach -t holp-123-abc");
    expect(markdown).toContain("**Final Result:** pass");
    expect(markdown).toContain("cmux-pending-user-validation");
    expect(markdown).toContain("run_started (seq=1)");
    expect(markdown).toContain("step_started (seq=2)");
    expect(markdown).toContain("run_merged (seq=3)");
  });

  it("writes dashboard markdown to disk for a marker", () => {
    const marker = `HOLP_CHAIN_MARKER_TEST_${Date.now()}`;
    const dashboardPath = updateDashboardForMarker(marker, {
      controller: "kimi-code",
      worker: "opencode",
      marker,
      runId: "run_test",
      workerSession: "holp-test-session",
      attachCommand: "tmux attach -t holp-test-session",
      timeline: ["run_started (seq=1)"],
      finalResult: "pass",
      cmuxStatus: "INFO cmux_status=cmux-pending-user-validation",
    });
    expect(dashboardPath).toBe(dashboardPathForMarker(marker));
    const content = readFileSync(dashboardPath, "utf-8");
    expect(content).toContain(marker);
    expect(content).toContain("kimi-code");
    expect(content).toContain("opencode");
    expect(content).toContain("holp-test-session");
    rmSync(dashboardPathForMarker(marker), { recursive: true, force: true });
  });
});
