import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildControllerBootPrompt,
  buildTuiStartupCommand,
  runCmuxTuiLauncher,
  type CmuxCommandResult,
} from "../../../consumers/cmux-bridge/index.js";

function ok(command: string, args: readonly string[], stdout = ""): CmuxCommandResult {
  return { command: `${command} ${args.join(" ")}`, ok: true, stdout };
}

function sessionId(name: string): string {
  return `test-${name}-${process.pid}-${Date.now()}`;
}

describe("cmux TUI launcher", () => {
  it("is a no-op degraded plan unless explicitly enabled", async () => {
    const calls: readonly string[][] = [];
    const id = sessionId("disabled");
    const sessionDir = `/tmp/holp-harness-workspace/${id}`;
    try {
      const result = await runCmuxTuiLauncher({
        argv: ["--session-id", id, "--workspace", "workspace:1"],
        env: {},
        runner: async (_command, args) => {
          (calls as string[][]).push([...args]);
          return ok("cmux", args);
        },
        isOnPath: () => true,
      });

      expect(result.mode).toBe("degraded");
      expect(result.degraded_reasons).toContain("execution_not_enabled");
      expect(result.manifest_path).toBe("");
      expect(calls).toEqual([]);
      expect(existsSync(sessionDir)).toBe(false);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("degrades before mutation when workspace is missing", async () => {
    const id = sessionId("missing-workspace");
    try {
      const result = await runCmuxTuiLauncher({
        argv: ["--session-id", id],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        runner: async () => {
          throw new Error("must not mutate without workspace");
        },
        isOnPath: () => true,
      });

      expect(result.mode).toBe("degraded");
      expect(result.degraded_reasons).toContain("missing_workspace");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("degrades when the requested controller binary is missing", async () => {
    for (const [controller, binary] of [["codex", "codex"], ["kimi-code", "kimi"]] as const) {
      const id = sessionId(`missing-${controller}`);
      try {
        const result = await runCmuxTuiLauncher({
          argv: ["--session-id", id, "--workspace", "workspace:1", "--controller", controller],
          env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
          isOnPath: (command) => command !== binary,
          runner: async () => {
            throw new Error("must not probe cmux when controller binary is missing");
          },
        });

        expect(result.mode).toBe("degraded");
        expect(result.degraded_reasons).toContain("missing_controller_binary");
      } finally {
        rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
      }
    }
  });

  it("degrades when cmux capability probe does not expose required pane/send support", async () => {
    const id = sessionId("bad-capability");
    const calls: string[][] = [];
    try {
      const result = await runCmuxTuiLauncher({
        argv: ["--session-id", id, "--workspace", "workspace:1"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        isOnPath: () => true,
        runner: async (command, args) => {
          calls.push([...args]);
          return ok(command, args, "Usage: cmux new-pane\n");
        },
      });

      expect(result.mode).toBe("degraded");
      expect(result.degraded_reasons).toContain("missing_cmux_capability");
      expect(calls).toEqual([["new-pane", "--help"], ["send", "--help"]]);
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("creates HOLP-owned TUI and controller terminal panes with workspace scope and focus false", async () => {
    const id = sessionId("planned");
    const calls: string[][] = [];
    try {
      const result = await runCmuxTuiLauncher({
        argv: ["--session-id", id, "--workspace", "workspace:1", "--controller", "kimi-code", "--worker", "opencode"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        isOnPath: (command) => command === "kimi",
        runner: async (command, args) => {
          calls.push([...args]);
          if (args[0] === "new-pane" && args.includes("--direction") && args.includes("right")) {
            return ok(command, args, "created pane:pane-tui surface:surface-tui");
          }
          if (args[0] === "new-pane" && args.includes("--direction") && args.includes("down")) {
            return ok(command, args, "created pane:pane-controller surface:surface-controller");
          }
          if (args[0] === "new-pane" || args[0] === "send") {
            return ok(command, args, "Usage: cmux new-pane --workspace --focus --type <terminal|browser>\nUsage: cmux send --workspace --surface");
          }
          return ok(command, args);
        },
      });

      expect(result.mode).toBe("planned");
      expect(result.manifest.surfaces.tui?.surface_id).toBe("surface:surface-tui");
      expect(result.manifest.surfaces.controller?.surface_id).toBe("surface:surface-controller");
      const newPaneCalls = calls.filter((args) => args[0] === "new-pane" && !args.includes("--help"));
      expect(newPaneCalls).toHaveLength(2);
      for (const args of newPaneCalls) {
        expect(args).toContain("--workspace");
        expect(args).toContain("workspace:1");
        expect(args).toContain("--focus");
        expect(args[args.indexOf("--focus") + 1]).toBe("false");
        expect(args).toContain("--type");
        expect(args[args.indexOf("--type") + 1]).toBe("terminal");
      }
      const sends = calls.filter((args) => args[0] === "send" && !args.includes("--help"));
      expect(sends).toHaveLength(2);
      expect(sends.every((args) => args.includes("--workspace") && args.includes("--surface"))).toBe(true);
      expect(sends.some((args) => args.join(" ").includes("harness:workspace:client"))).toBe(true);
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("builds a shell-parseable TUI startup payload that backgrounds broker before launching TUI", () => {
    const script = buildTuiStartupCommand({
      sessionId: "session-shell",
      brokerSocket: "/tmp/holp-harness-workspace/session-shell/broker.sock",
    });

    expect(script).not.toContain("& &&");
    expect(script).toContain("npm run harness:workspace:broker -- --session-id session-shell");
    expect(script).toContain("> /tmp/holp-harness-workspace/session-shell/broker.log 2>&1 &");
    expect(script).toContain("for i in $(seq 1 80); do [ -S /tmp/holp-harness-workspace/session-shell/broker.sock ] && break; sleep 0.25; done");
    expect(script).toContain("HOLP_HARNESS_BROKER_SOCKET=/tmp/holp-harness-workspace/session-shell/broker.sock npm run harness:workspace:tui");

    const zsh = spawnSync("zsh", ["-n"], { input: script, encoding: "utf8" });
    if (zsh.error && "code" in zsh.error && zsh.error.code === "ENOENT") return;
    expect(`${zsh.stderr}${zsh.stdout}`).toBe("");
    expect(zsh.status).toBe(0);
  });

  it("prints broker instructions and then launches the real controller CLI", () => {
    const codex = buildControllerBootPrompt({
      brokerSocket: "/tmp/holp-harness-workspace/session-controller/broker.sock",
      goal: "demo goal",
      worker: "kimi-code",
      controller: "codex",
    });
    const kimi = buildControllerBootPrompt({
      brokerSocket: "/tmp/holp-harness-workspace/session-controller/broker.sock",
      goal: "demo goal",
      worker: "opencode",
      controller: "kimi-code",
    });

    expect(codex).toContain("harness:workspace:client");
    expect(codex).toContain("HOLP_HARNESS_BROKER_SOCKET=/tmp/holp-harness-workspace/session-controller/broker.sock");
    expect(codex).toMatch(/&& exec codex$/);
    expect(kimi).toMatch(/&& exec kimi$/);
    for (const script of [codex, kimi]) {
      const zsh = spawnSync("zsh", ["-n"], { input: script, encoding: "utf8" });
      if (zsh.error && "code" in zsh.error && zsh.error.code === "ENOENT") continue;
      expect(`${zsh.stderr}${zsh.stdout}`).toBe("");
      expect(zsh.status).toBe(0);
    }
  });

  it("builds an existing-broker startup payload without starting a second broker", () => {
    const script = buildTuiStartupCommand({
      sessionId: "session-existing",
      brokerSocket: "/tmp/holp-harness-workspace/session-existing/broker.sock",
      startBroker: false,
    });

    expect(script).not.toContain("harness:workspace:broker");
    expect(script).toContain("for i in $(seq 1 80); do [ -S /tmp/holp-harness-workspace/session-existing/broker.sock ] && break; sleep 0.25; done");
    expect(script).toContain("HOLP_HARNESS_BROKER_SOCKET=/tmp/holp-harness-workspace/session-existing/broker.sock npm run harness:workspace:tui");
    const zsh = spawnSync("zsh", ["-n"], { input: script, encoding: "utf8" });
    if (zsh.error && "code" in zsh.error && zsh.error.code === "ENOENT") return;
    expect(`${zsh.stderr}${zsh.stdout}`).toBe("");
    expect(zsh.status).toBe(0);
  });

  it("honors --broker-socket by wiring the TUI pane to the existing broker without starting one", async () => {
    const id = sessionId("existing-broker");
    const brokerSocket = `/tmp/holp-harness-workspace/${id}/broker.sock`;
    const calls: string[][] = [];
    try {
      const result = await runCmuxTuiLauncher({
        argv: ["--broker-socket", brokerSocket, "--workspace", "workspace:1"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        isOnPath: (command) => command === "codex",
        runner: async (command, args) => {
          calls.push([...args]);
          if (args[0] === "new-pane" && args.includes("--direction") && args.includes("right")) {
            return ok(command, args, "created pane:pane-tui surface:surface-tui");
          }
          if (args[0] === "new-pane" && args.includes("--direction") && args.includes("down")) {
            return ok(command, args, "created pane:pane-controller surface:surface-controller");
          }
          if (args[0] === "new-pane" || args[0] === "send") {
            return ok(command, args, "Usage: cmux new-pane --workspace --focus --type <terminal|browser>\nUsage: cmux send --workspace --surface");
          }
          return ok(command, args);
        },
      });

      expect(result.mode).toBe("planned");
      const tuiSend = calls.find((args) => args[0] === "send" && args.includes("surface:surface-tui"));
      const payload = tuiSend?.at(-1) ?? "";
      expect(payload).not.toContain("harness:workspace:broker");
      expect(payload).toContain(`HOLP_HARNESS_BROKER_SOCKET=${brokerSocket} npm run harness:workspace:tui`);
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("records cmux command failure as degraded instead of pretending the layout is ready", async () => {
    const id = sessionId("send-failure");
    try {
      const result = await runCmuxTuiLauncher({
        argv: ["--session-id", id, "--workspace", "workspace:1"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        isOnPath: (command) => command === "codex",
        runner: async (command, args) => {
          if (args[0] === "new-pane" && args.includes("--direction") && args.includes("right")) {
            return ok(command, args, "created pane:pane-tui surface:surface-tui");
          }
          if (args[0] === "new-pane" && args.includes("--direction") && args.includes("down")) {
            return ok(command, args, "created pane:pane-controller surface:surface-controller");
          }
          if (args[0] === "new-pane" || (args[0] === "send" && args.includes("--help"))) {
            return ok(command, args, "Usage: cmux new-pane --workspace --focus --type <terminal|browser>\nUsage: cmux send --workspace --surface");
          }
          if (args[0] === "send") {
            return { command: `${command} ${args.join(" ")}`, ok: false, error: "send failed" };
          }
          return ok(command, args);
        },
      });

      expect(result.mode).toBe("degraded");
      expect(result.degraded_reasons).toContain("cmux_command_failed");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });
});
