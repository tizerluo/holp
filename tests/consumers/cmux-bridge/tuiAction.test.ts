import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addManifestSurface,
  createCmuxTuiSessionManifest,
  runCmuxTuiAction,
  writeCmuxTuiSessionManifest,
  type CmuxCommandResult,
} from "../../../consumers/cmux-bridge/index.js";

function ok(command: string, args: readonly string[], stdout = ""): CmuxCommandResult {
  return { command: `${command} ${args.join(" ")}`, ok: true, stdout };
}

function createManifest(sessionId: string, controllerAgent = "codex") {
  const manifest = addManifestSurface(
    createCmuxTuiSessionManifest({
      sessionId,
      workspaceId: "workspace:action",
      brokerSocket: `/tmp/holp-harness-workspace/${sessionId}/broker.sock`,
      now: "2026-06-25T00:00:00.000Z",
    }),
    "controller",
    { surface_id: "surface:controller", agent: controllerAgent },
  );
  writeCmuxTuiSessionManifest(manifest);
  return manifest;
}

function sessionId(name: string): string {
  return `test-action-${name}-${process.pid}-${Date.now()}`;
}

describe("cmux TUI operator actions", () => {
  it("requires explicit session id or broker socket and never discovers latest manifest", async () => {
    const id = sessionId("selector");
    try {
      createManifest(id);
      const result = await runCmuxTuiAction({
        argv: ["copy_run_id", "--run-id", "run_1"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
      });

      expect(result.ok).toBe(false);
      expect(result.degraded_reasons).toContain("missing_session_selector");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("accepts a broker socket selector inside the bounded HOLP session namespace", async () => {
    const id = sessionId("broker-socket");
    try {
      createManifest(id);
      const result = await runCmuxTuiAction({
        argv: [
          "copy_run_id",
          "--broker-socket",
          `/tmp/holp-harness-workspace/${id}/broker.sock`,
          "--run-id",
          "run_1",
        ],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
      });

      expect(result.ok).toBe(true);
      expect(result.output).toBe("run_1");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("is disabled unless HOLP_HARNESS_WORKSPACE_TUI is explicitly enabled", async () => {
    const result = await runCmuxTuiAction({
      argv: ["copy_run_id", "--session-id", "anything", "--run-id", "run_1"],
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(result.degraded_reasons).toContain("execution_not_enabled");
  });

  it("sends controller boot prompt only to the owned controller surface", async () => {
    const id = sessionId("controller");
    const calls: string[][] = [];
    try {
      createManifest(id);
      const result = await runCmuxTuiAction({
        argv: ["send_controller_boot_prompt", "--session-id", id, "--goal", "demo goal", "--worker", "kimi-code"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        cmuxCommand: "/bin/cmux",
        runner: async (command, args) => {
          calls.push([...args]);
          return ok(command, args);
        },
      });

      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(expect.arrayContaining(["send", "--workspace", "workspace:action", "--surface", "surface:controller", "--"]));
      expect(calls[0]?.join(" ")).toContain("HOLP_HARNESS_BROKER_SOCKET=");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("defaults controller boot prompt to the manifest controller agent and allows CLI override", async () => {
    const id = sessionId("controller-agent");
    const calls: string[][] = [];
    try {
      createManifest(id, "kimi-code");
      const result = await runCmuxTuiAction({
        argv: ["send_controller_boot_prompt", "--session-id", id],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        cmuxCommand: "/bin/cmux",
        runner: async (command, args) => {
          calls.push([...args]);
          return ok(command, args);
        },
      });
      const override = await runCmuxTuiAction({
        argv: ["send_controller_boot_prompt", "--session-id", id, "--controller", "codex"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        cmuxCommand: "/bin/cmux",
        runner: async (command, args) => {
          calls.push([...args]);
          return ok(command, args);
        },
      });

      expect(result.ok).toBe(true);
      expect(override.ok).toBe(true);
      expect(calls[0]?.at(-1)).toContain("Controller CLI: kimi");
      expect(calls[1]?.at(-1)).toContain("Controller CLI: codex");
      expect(calls[0]?.at(-1)).not.toContain("exec kimi");
      expect(calls[1]?.at(-1)).not.toContain("exec codex");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("opens a worker attach pane only for holp-* sessions and sends tmux attach to that owned surface", async () => {
    const id = sessionId("worker");
    const calls: string[][] = [];
    try {
      createManifest(id);
      const result = await runCmuxTuiAction({
        argv: ["open_worker_attach_pane", "--session-id", id, "--worker-session", "holp-worker-123"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        cmuxCommand: "/bin/cmux",
        runner: async (command, args) => {
          calls.push([...args]);
          if (args[0] === "new-pane") return ok(command, args, "created pane:pane-worker surface:surface-worker");
          return ok(command, args);
        },
      });

      expect(result.ok).toBe(true);
      expect(result.manifest?.surfaces.worker_attach?.surface_id).toBe("surface:surface-worker");
      expect(calls[0]).toEqual(expect.arrayContaining(["new-pane", "--workspace", "workspace:action", "--focus", "false"]));
      expect(calls[1]).toEqual(expect.arrayContaining(["send", "--workspace", "workspace:action", "--surface", "surface:surface-worker", "--"]));
      expect(calls[1]?.at(-1)).toBe("tmux attach -t holp-worker-123\n");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("rejects non-HOLP worker sessions before creating a pane", async () => {
    const id = sessionId("non-holp");
    try {
      createManifest(id);
      const result = await runCmuxTuiAction({
        argv: ["open_worker_attach_pane", "--session-id", id, "--worker-session", "user-shell"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        runner: async () => {
          throw new Error("must not mutate for non-HOLP session");
        },
      });

      expect(result.ok).toBe(false);
      expect(result.degraded_reasons).toContain("non_holp_worker_session");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("keeps copy, cancel, follow, and unsupported interrupt behind explicit action semantics", async () => {
    const id = sessionId("operator");
    const brokerCommands: unknown[] = [];
    try {
      createManifest(id);
      const noConfirm = await runCmuxTuiAction({
        argv: ["cancel_run", "--session-id", id, "--run-id", "run_1"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
      });
      expect(noConfirm.ok).toBe(false);
      expect(noConfirm.degraded_reasons).toContain("confirmation_required");

      const cancel = await runCmuxTuiAction({
        argv: ["cancel_run", "--session-id", id, "--run-id", "run_1", "--confirm"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        brokerCommandSender: async (_socket, command) => {
          brokerCommands.push(command);
          return { ok: true };
        },
      });
      expect(cancel.ok).toBe(true);
      expect(brokerCommands).toEqual([{ type: "cancel", run_id: "run_1", reason: "operator action cancel" }]);

      const copy = await runCmuxTuiAction({
        argv: ["copy_attach_command", "--session-id", id, "--worker-session", "holp-worker-1"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
      });
      expect(copy.output).toBe("tmux attach -t holp-worker-1");

      const interrupt = await runCmuxTuiAction({
        argv: ["interrupt_worker", "--session-id", id],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
      });
      expect(interrupt.ok).toBe(false);
      expect(interrupt.degraded_reasons).toContain("unsupported_action");

      const missingWorker = await runCmuxTuiAction({
        argv: ["start_run_via_broker", "--session-id", id, "--goal", "demo"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
      });
      expect(missingWorker.ok).toBe(false);
      expect(missingWorker.degraded_reasons).toContain("invalid_command");

      const missingAgent = await runCmuxTuiAction({
        argv: ["follow_run_id", "--session-id", id],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
      });
      expect(missingAgent.ok).toBe(false);
      expect(missingAgent.degraded_reasons).toContain("invalid_command");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("returns structured degraded results when broker actions fail", async () => {
    const id = sessionId("broker-failure");
    try {
      createManifest(id);
      for (const argv of [
        ["start_run_via_broker", "--session-id", id, "--goal", "demo", "--worker", "fake-agent"],
        ["follow_run_id", "--session-id", id, "--agent", "coder-1"],
        ["cancel_run", "--session-id", id, "--run-id", "run_1", "--confirm"],
      ]) {
        const result = await runCmuxTuiAction({
          argv,
          env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
          brokerCommandSender: async () => {
            throw new Error("broker unavailable");
          },
        });

        expect(result.ok).toBe(false);
        expect(result.degraded_reasons).toContain("cmux_command_failed");
        expect(result.output).toContain("broker unavailable");
        expect(result.manifest?.session_id).toBe(id);
      }
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("ignores invalid timeout-ms values and uses the default broker action timeout", async () => {
    const id = sessionId("bad-timeout");
    const timeouts: Array<number | undefined> = [];
    try {
      createManifest(id);
      for (const timeout of ["NaN", "0", "-1"]) {
        const result = await runCmuxTuiAction({
          argv: ["start_run_via_broker", "--session-id", id, "--worker", "fake-agent", "--timeout-ms", timeout],
          env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
          brokerCommandSender: async (_socket, _command, timeoutMs) => {
            timeouts.push(timeoutMs);
            return { ok: true };
          },
        });
        expect(result.ok).toBe(true);
      }

      expect(timeouts).toEqual([120_000, 120_000, 120_000]);
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });
});
