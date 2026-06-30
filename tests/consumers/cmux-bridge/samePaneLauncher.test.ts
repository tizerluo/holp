import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
    const workspace = `workspace:${id}`;
    const calls: string[][] = [];
    try {
      const result = await runHolpSamePaneLauncher({
        sessionId: id,
        env: { CMUX_WORKSPACE_ID: workspace },
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
    const workspace = `workspace:${id}`;
    const calls: string[][] = [];
    try {
      const result = await runHolpSamePaneLauncher({
        sessionId: id,
        env: { CMUX_WORKSPACE_ID: workspace },
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
    const workspace = `workspace:${id}`;
    const calls: string[][] = [];
    try {
      const result = await runHolpSamePaneLauncher({
        sessionId: id,
        env: { CMUX_WORKSPACE_ID: workspace },
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
    const workspace = `workspace:${id}`;
    const calls: string[][] = [];
    const runner: SamePaneCommandRunner = async (command, args) => {
      calls.push([...args]);
      return ok(command, args, "created pane:pane-one surface:surface-one");
    };
    try {
      const result = await runHolpSamePaneLauncher({
        sessionId: id,
        env: { CMUX_WORKSPACE_ID: workspace },
        isOnPath: () => true,
        runner,
      });

      expect(result.mode).toBe("planned");
      const newPaneCalls = calls.filter((args) => args[0] === "new-pane");
      expect(newPaneCalls).toHaveLength(1);
      const newPaneArgs = newPaneCalls[0] ?? [];
      expect(newPaneArgs).toContain("--workspace");
      expect(newPaneArgs[newPaneArgs.indexOf("--workspace") + 1]).toBe(workspace);
      expect(newPaneArgs).toContain("--focus");
      expect(newPaneArgs[newPaneArgs.indexOf("--focus") + 1]).toBe("false");
      expect(newPaneArgs).toContain("--type");
      expect(newPaneArgs[newPaneArgs.indexOf("--type") + 1]).toBe("terminal");
      expect(newPaneArgs).not.toContain("--");

      const sendCalls = calls.filter((args) => args[0] === "send");
      expect(sendCalls).toHaveLength(1);
      const sendArgs = sendCalls[0] ?? [];
      expect(sendArgs).toContain("--workspace");
      expect(sendArgs[sendArgs.indexOf("--workspace") + 1]).toBe(workspace);
      expect(sendArgs).toContain("--surface");
      expect(sendArgs[sendArgs.indexOf("--surface") + 1]).toBe("surface:surface-one");
      expect(sendArgs).toContain("--");
      const payload = sendArgs[sendArgs.indexOf("--") + 1] ?? "";
      expect(payload).toContain("tmux new-session");
      expect(payload).toContain("codex");
      expect(payload).not.toContain("HOLP_REAL_CODEX_SMOKE");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("reuses an existing healthy HOLP controller surface in the same workspace", async () => {
    const oldId = sessionId("old-reusable");
    const id = sessionId("reuse");
    const workspace = `workspace:${id}`;
    const calls: string[][] = [];
    mkdirSync(`/tmp/holp-harness-workspace/${oldId}`, { recursive: true });
    writeFileSync(
      `/tmp/holp-harness-workspace/${oldId}/cmux-surfaces.json`,
      JSON.stringify({
        schema_version: "HolpHarnessWorkspaceCmuxManifest.v1",
        session_id: oldId,
        workspace_id: workspace,
        broker_socket: `/tmp/holp-harness-workspace/${oldId}/broker.sock`,
        created_at: "2026-01-01T00:00:00.000Z",
        surfaces: {
          controller: {
            surface_id: "surface:old",
            pane_id: "pane:old",
            kind: "controller",
            agent: "codex",
            created_by: "harness-workspace-tui-cmux",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        },
        degraded_reasons: [],
        command_results: [],
      }),
    );
    try {
      const result = await runHolpSamePaneLauncher({
        sessionId: id,
        env: { CMUX_WORKSPACE_ID: workspace },
        isOnPath: () => true,
        runner: async (command, args) => {
          calls.push([...args]);
          return ok(command, args);
        },
      });

      expect(result.mode).toBe("planned");
      expect(calls.map((args) => args[0])).toEqual(["send"]);
      const sendArgs = calls[0] ?? [];
      expect(sendArgs[sendArgs.indexOf("--surface") + 1]).toBe("surface:old");
      expect(result.manifest.surfaces.controller?.surface_id).toBe("surface:old");
      expect(result.manifest.surfaces.controller?.last_command).toBe("reuse existing HOLP controller surface surface:old");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${oldId}`, { recursive: true, force: true });
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("does not reuse a HOLP controller surface from another workspace", async () => {
    const oldId = sessionId("old-other-workspace");
    const id = sessionId("reuse-mismatch");
    const workspace = `workspace:${id}`;
    const calls: string[][] = [];
    mkdirSync(`/tmp/holp-harness-workspace/${oldId}`, { recursive: true });
    writeFileSync(
      `/tmp/holp-harness-workspace/${oldId}/cmux-surfaces.json`,
      JSON.stringify({
        schema_version: "HolpHarnessWorkspaceCmuxManifest.v1",
        session_id: oldId,
        workspace_id: "workspace:other",
        broker_socket: `/tmp/holp-harness-workspace/${oldId}/broker.sock`,
        created_at: "2026-01-01T00:00:00.000Z",
        surfaces: {
          controller: {
            surface_id: "surface:old",
            pane_id: "pane:old",
            kind: "controller",
            agent: "codex",
            created_by: "harness-workspace-tui-cmux",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        },
        degraded_reasons: [],
        command_results: [],
      }),
    );
    try {
      await runHolpSamePaneLauncher({
        sessionId: id,
        env: { CMUX_WORKSPACE_ID: workspace },
        isOnPath: () => true,
        runner: async (command, args) => {
          calls.push([...args]);
          return ok(command, args, "created pane:pane-one surface:surface-one");
        },
      });

      expect(calls.map((args) => args[0])).toEqual(["new-pane", "send"]);
      const sendArgs = calls.find((args) => args[0] === "send") ?? [];
      expect(sendArgs[sendArgs.indexOf("--surface") + 1]).toBe("surface:surface-one");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${oldId}`, { recursive: true, force: true });
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("falls back to a new pane when a reused HOLP controller surface is stale", async () => {
    const oldId = sessionId("old-stale");
    const id = sessionId("reuse-stale");
    const workspace = `workspace:${id}`;
    const calls: string[][] = [];
    mkdirSync(`/tmp/holp-harness-workspace/${oldId}`, { recursive: true });
    writeFileSync(
      `/tmp/holp-harness-workspace/${oldId}/cmux-surfaces.json`,
      JSON.stringify({
        schema_version: "HolpHarnessWorkspaceCmuxManifest.v1",
        session_id: oldId,
        workspace_id: workspace,
        broker_socket: `/tmp/holp-harness-workspace/${oldId}/broker.sock`,
        created_at: "2026-01-01T00:00:00.000Z",
        surfaces: {
          controller: {
            surface_id: "surface:stale",
            pane_id: "pane:stale",
            kind: "controller",
            agent: "codex",
            created_by: "harness-workspace-tui-cmux",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        },
        degraded_reasons: [],
        command_results: [],
      }),
    );
    try {
      const result = await runHolpSamePaneLauncher({
        sessionId: id,
        env: { CMUX_WORKSPACE_ID: workspace },
        isOnPath: () => true,
        runner: async (command, args) => {
          calls.push([...args]);
          if (args[0] === "send" && args.includes("surface:stale")) return fail(command, args);
          return ok(command, args, "created pane:pane-new surface:surface-new");
        },
      });

      expect(result.mode).toBe("planned");
      expect(calls.map((args) => args[0])).toEqual(["send", "new-pane", "send"]);
      const retrySend = calls[2] ?? [];
      expect(retrySend[retrySend.indexOf("--surface") + 1]).toBe("surface:surface-new");
      expect(result.manifest.surfaces.controller?.surface_id).toBe("surface:surface-new");
      expect(JSON.stringify(result.manifest.command_results)).not.toContain("surface:stale");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${oldId}`, { recursive: true, force: true });
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("forwards explicit Codex smoke opt-in to the tmux startup script", async () => {
    const id = sessionId("smoke-env");
    const workspace = `workspace:${id}`;
    const calls: string[][] = [];
    const runner: SamePaneCommandRunner = async (command, args) => {
      calls.push([...args]);
      return ok(command, args, "created pane:pane-one surface:surface-one");
    };
    try {
      await runHolpSamePaneLauncher({
        sessionId: id,
        env: { CMUX_WORKSPACE_ID: workspace, HOLP_REAL_CODEX_SMOKE: "1" },
        isOnPath: () => true,
        runner,
      });

      const sendArgs = calls.find((args) => args[0] === "send") ?? [];
      const payload = sendArgs[sendArgs.indexOf("--") + 1] ?? "";
      expect(payload).toContain("export HOLP_REAL_CODEX_SMOKE=1");
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
    expect(command).toMatch(/split-window -h -t holp-harness-session-abc:0 .*\\; select-pane -L/);
    expect(command).not.toContain(":0.0");
    expect(command).toContain("HOLP_HARNESS_CMUX_MANIFEST_PATH=");
    expect(command).toContain("/bin:$PATH");
    expect(command).toContain("holp workers");
    expect(command).toContain("holp status");
    expect(command).toContain("holp run");
    expect(command).toContain("holp reject");
    expect(command).not.toContain("HOLP_REGISTRY=fake");
    expect(command).not.toContain("fake-agent");
    expect(command).not.toContain("HOLP_REAL_CODEX_SMOKE");
  });

  it("only includes Codex smoke opt-in when explicitly enabled", () => {
    const id = "session-smoke-env";
    const brokerSocket = `/tmp/holp-harness-workspace/${id}/broker.sock`;
    const command = buildPaneCommand({
      sessionId: id,
      brokerSocket,
      env: { HOLP_REAL_CODEX_SMOKE: "1" },
    });
    const disabled = buildPaneCommand({
      sessionId: id,
      brokerSocket,
      env: { HOLP_REAL_CODEX_SMOKE: "true" },
    });

    expect(command).toContain("export HOLP_REAL_CODEX_SMOKE=1");
    expect(disabled).not.toContain("HOLP_REAL_CODEX_SMOKE");
  });
});
