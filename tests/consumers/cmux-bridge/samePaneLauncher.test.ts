import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPaneCommand,
  runHolpSamePaneLauncher,
  type SamePaneCommandRunner,
} from "../../../consumers/cmux-bridge/samePaneLauncher.js";
import type { CmuxCommandResult } from "../../../consumers/cmux-bridge/types.js";

function ok(command: string, args: readonly string[], stdout = ""): CmuxCommandResult {
  return { command: `${command} ${args.join(" ")}`, ok: true, stdout };
}

function fail(command: string, args: readonly string[], stderr = "boom"): CmuxCommandResult {
  return { command: `${command} ${args.join(" ")}`, ok: false, stderr };
}

function sessionId(name: string): string {
  return `same-pane-${name}-${process.pid}-${Date.now()}`;
}

describe("HOLP same-pane launcher", () => {
  it("degrades outside a cmux workspace without creating a pane", async () => {
    const id = sessionId("missing-workspace");
    const calls: string[][] = [];
    try {
      const result = await runHolpSamePaneLauncher({
        sessionId: id,
        env: {},
        isOnPath: () => true,
        runner: async (_command, args) => {
          calls.push([...args]);
          return ok("cmux", args);
        },
      });

      expect(result.mode).toBe("degraded");
      expect(result.degraded_reasons).toContain("missing_workspace");
      expect(calls).toEqual([]);
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("degrades readably when tmux is missing before creating a pane", async () => {
    const id = sessionId("missing-tmux");
    const calls: string[][] = [];
    try {
      const result = await runHolpSamePaneLauncher({
        sessionId: id,
        env: { CMUX_WORKSPACE_ID: "workspace:1" },
        isOnPath: (command) => command !== "tmux",
        runner: async (_command, args) => {
          calls.push([...args]);
          return ok("cmux", args);
        },
      });

      expect(result.mode).toBe("degraded");
      expect(result.degraded_reasons).toContain("missing_tmux_binary");
      expect(calls).toEqual([]);
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("degrades readably when Codex is missing before creating a pane", async () => {
    const id = sessionId("missing-codex");
    const calls: string[][] = [];
    try {
      const result = await runHolpSamePaneLauncher({
        sessionId: id,
        env: { CMUX_WORKSPACE_ID: "workspace:1" },
        isOnPath: (command) => command !== "codex",
        runner: async (_command, args) => {
          calls.push([...args]);
          return ok("cmux", args);
        },
      });

      expect(result.mode).toBe("degraded");
      expect(result.degraded_reasons).toContain("missing_controller_binary");
      expect(calls).toEqual([]);
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("records cmux_command_failed when creating the terminal pane fails", async () => {
    const id = sessionId("new-pane-fail");
    const calls: string[][] = [];
    try {
      const result = await runHolpSamePaneLauncher({
        sessionId: id,
        env: { CMUX_WORKSPACE_ID: "workspace:1" },
        isOnPath: () => true,
        runner: async (command, args) => {
          calls.push([...args]);
          return fail(command, args);
        },
      });

      expect(result.mode).toBe("degraded");
      expect(result.degraded_reasons).toContain("cmux_command_failed");
      expect(calls.map((args) => args[0])).toEqual(["new-pane"]);
      expect(result.manifest.command_results).toHaveLength(1);
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("records missing_surface_handle when cmux creates a pane without returning a surface id", async () => {
    const id = sessionId("missing-surface");
    const calls: string[][] = [];
    try {
      const result = await runHolpSamePaneLauncher({
        sessionId: id,
        env: { CMUX_WORKSPACE_ID: "workspace:1" },
        isOnPath: () => true,
        runner: async (command, args) => {
          calls.push([...args]);
          return ok(command, args, "created pane:pane-one");
        },
      });

      expect(result.mode).toBe("degraded");
      expect(result.degraded_reasons).toContain("missing_surface_handle");
      expect(calls.map((args) => args[0])).toEqual(["new-pane"]);
      expect(result.manifest.surfaces.controller).toBeUndefined();
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("records cmux_command_failed when sending the tmux startup script fails", async () => {
    const id = sessionId("send-fail");
    const calls: string[][] = [];
    try {
      const result = await runHolpSamePaneLauncher({
        sessionId: id,
        env: { CMUX_WORKSPACE_ID: "workspace:1" },
        isOnPath: () => true,
        runner: async (command, args) => {
          calls.push([...args]);
          return args[0] === "send" ? fail(command, args) : ok(command, args, "created pane:pane-one surface:surface-one");
        },
      });

      expect(result.mode).toBe("degraded");
      expect(result.degraded_reasons).toContain("cmux_command_failed");
      expect(calls.map((args) => args[0])).toEqual(["new-pane", "send"]);
      expect(result.manifest.surfaces.controller?.surface_id).toBe("surface:surface-one");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("creates one cmux terminal pane scoped to the workspace without focus, then sends the startup script", async () => {
    const id = sessionId("planned");
    const calls: string[][] = [];
    const runner: SamePaneCommandRunner = async (command, args) => {
      calls.push([...args]);
      return ok(command, args, "created pane:pane-one surface:surface-one");
    };
    try {
      const result = await runHolpSamePaneLauncher({
        sessionId: id,
        env: { CMUX_WORKSPACE_ID: "workspace:1" },
        isOnPath: () => true,
        runner,
      });

      expect(result.mode).toBe("planned");
      const newPaneCalls = calls.filter((args) => args[0] === "new-pane");
      expect(newPaneCalls).toHaveLength(1);
      const newPaneArgs = newPaneCalls[0] ?? [];
      expect(newPaneArgs).toContain("--workspace");
      expect(newPaneArgs[newPaneArgs.indexOf("--workspace") + 1]).toBe("workspace:1");
      expect(newPaneArgs).toContain("--focus");
      expect(newPaneArgs[newPaneArgs.indexOf("--focus") + 1]).toBe("false");
      expect(newPaneArgs).toContain("--type");
      expect(newPaneArgs[newPaneArgs.indexOf("--type") + 1]).toBe("terminal");
      expect(newPaneArgs).not.toContain("--");

      const sendCalls = calls.filter((args) => args[0] === "send");
      expect(sendCalls).toHaveLength(1);
      const sendArgs = sendCalls[0] ?? [];
      expect(sendArgs).toContain("--workspace");
      expect(sendArgs[sendArgs.indexOf("--workspace") + 1]).toBe("workspace:1");
      expect(sendArgs).toContain("--surface");
      expect(sendArgs[sendArgs.indexOf("--surface") + 1]).toBe("surface:surface-one");
      expect(sendArgs).toContain("--");
      const payload = sendArgs[sendArgs.indexOf("--") + 1] ?? "";
      expect(payload).toContain("tmux new-session");
      expect(payload).toContain("codex");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("builds a concrete HOLP tmux session with shared broker socket and real Codex", () => {
    const id = "session-abc";
    const brokerSocket = `/tmp/holp-harness-workspace/${id}/broker.sock`;
    const command = buildPaneCommand({ sessionId: id, brokerSocket, goal: "check tests" });

    expect(command).toContain("holp-harness-session-abc");
    expect(command).toContain("tmux kill-session -t holp-harness-session-abc");
    expect(command).toContain("trap cleanup EXIT INT TERM");
    expect(command).not.toContain("kill-session -t holp-harness-*");
    expect(command).toContain("codex -C ");
    expect(command).not.toContain("codex exec");
    expect(command).toContain(brokerSocket);
    expect(command).toContain("npm run harness:workspace:broker -- --session-id session-abc");
    expect(command).toContain("npm run harness:workspace:tui");
    expect(command).toContain("HOLP_HARNESS_CMUX_MANIFEST_PATH=");
    expect(command).toContain("/bin:$PATH");
    expect(command).toContain("holp workers");
    expect(command).toContain("holp status");
    expect(command).toContain("holp run");
    expect(command).toContain("holp reject");
    expect(command).not.toContain("HOLP_REGISTRY=fake");
    expect(command).not.toContain("fake-agent");
  });
});
