import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
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
    const id = sessionId("missing-codex");
    try {
      const result = await runCmuxTuiLauncher({
        argv: ["--session-id", id, "--workspace", "workspace:1", "--controller", "codex"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        isOnPath: (command) => command !== "codex",
        runner: async () => {
          throw new Error("must not probe cmux when controller binary is missing");
        },
      });

      expect(result.mode).toBe("degraded");
      expect(result.degraded_reasons).toContain("missing_controller_binary");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
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
    let manifestAtTuiSend: { surfaces?: Record<string, { surface_id?: string }> } | undefined;
    try {
      const result = await runCmuxTuiLauncher({
        argv: ["--session-id", id, "--workspace", "workspace:1", "--controller", "codex", "--worker", "opencode"],
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
            if (args[0] === "send" && args.includes("surface:surface-tui")) {
              manifestAtTuiSend = JSON.parse(readFileSync(`/tmp/holp-harness-workspace/${id}/cmux-surfaces.json`, "utf8"));
            }
            return ok(command, args, "Usage: cmux new-pane --workspace --focus --type <terminal|browser>\nUsage: cmux send --workspace --surface");
          }
          return ok(command, args);
        },
      });

      expect(result.mode).toBe("planned");
      expect(result.manifest.surfaces.tui?.surface_id).toBe("surface:surface-tui");
      expect(result.manifest.surfaces.controller?.surface_id).toBe("surface:surface-controller");
      expect(manifestAtTuiSend?.surfaces?.controller?.surface_id).toBe("surface:surface-controller");
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
      const tuiPayload = sends.find((args) => args.includes("surface:surface-tui"))?.at(-1) ?? "";
      expect(tuiPayload).toContain(`HOLP_HARNESS_CMUX_MANIFEST_PATH=/tmp/holp-harness-workspace/${id}/cmux-surfaces.json`);
      const controllerPayload = sends.find((args) => args.includes("surface:surface-controller"))?.at(-1) ?? "";
      expect(controllerPayload).toContain("export HOLP_HARNESS_BROKER_SOCKET=");
      expect(controllerPayload).toContain("codex -C ");
      expect(controllerPayload).not.toContain("codex exec");
      expect(controllerPayload).not.toContain("node -e");
      expect(controllerPayload).not.toContain("Use HOLP through the broker and report the worker result marker");
      expect(calls.every((args) => !(args[0] === "new-surface" && args.includes("--provider")))).toBe(true);
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("starts the TUI with a degraded manifest when the controller pane handle is missing", async () => {
    const id = sessionId("missing-controller-handle");
    const calls: string[][] = [];
    let manifestAtTuiSend: { degraded_reasons?: string[]; surfaces?: Record<string, unknown> } | undefined;
    try {
      const result = await runCmuxTuiLauncher({
        argv: ["--session-id", id, "--workspace", "workspace:1"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        isOnPath: (command) => command === "codex",
        runner: async (command, args) => {
          calls.push([...args]);
          if (args[0] === "new-pane" && args.includes("--direction") && args.includes("right")) {
            return ok(command, args, "created pane:pane-tui surface:surface-tui");
          }
          if (args[0] === "new-pane" && args.includes("--direction") && args.includes("down")) {
            return ok(command, args, "created pane:pane-controller");
          }
          if (args[0] === "send" && args.includes("surface:surface-tui")) {
            manifestAtTuiSend = JSON.parse(readFileSync(`/tmp/holp-harness-workspace/${id}/cmux-surfaces.json`, "utf8"));
          }
          if (args[0] === "new-pane" || args[0] === "send") {
            return ok(command, args, "Usage: cmux new-pane --workspace --focus --type <terminal|browser>\nUsage: cmux send --workspace --surface");
          }
          return ok(command, args);
        },
      });

      expect(result.mode).toBe("degraded");
      expect(result.degraded_reasons).toContain("missing_surface_handle");
      expect(result.manifest.surfaces.tui?.surface_id).toBe("surface:surface-tui");
      expect(result.manifest.surfaces.controller).toBeUndefined();
      expect(manifestAtTuiSend?.degraded_reasons).toContain("missing_surface_handle");
      expect(manifestAtTuiSend?.surfaces?.controller).toBeUndefined();
      expect(calls.some((args) => args[0] === "send" && args.includes("surface:surface-tui"))).toBe(true);
      expect(calls.some((args) => args[0] === "send" && args.includes("surface:surface-controller"))).toBe(false);
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("degrades non-demo kimi-code instead of sending an unverifiable interactive launch", async () => {
    const id = sessionId("kimi-degraded");
    const calls: string[][] = [];
    try {
      const result = await runCmuxTuiLauncher({
        argv: ["--session-id", id, "--workspace", "workspace:1", "--controller", "kimi-code"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        isOnPath: () => true,
        runner: async (_command, args) => {
          calls.push([...args]);
          throw new Error("must not probe or mutate cmux for unsupported kimi controller");
        },
      });

      expect(result.mode).toBe("degraded");
      expect(result.degraded_reasons).toContain("unsupported_controller_interactive_path");
      expect(calls).toEqual([]);
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("builds a shell-parseable TUI startup payload that backgrounds broker before launching TUI", () => {
    const script = buildTuiStartupCommand({
      sessionId: "session-shell",
      brokerSocket: "/tmp/holp-harness-workspace/session-shell/broker.sock",
      manifestPath: "/tmp/holp-harness-workspace/session-shell/cmux-surfaces.json",
    });

    expect(script).not.toContain("& &&");
    expect(script).toContain("npm run harness:workspace:broker -- --session-id session-shell");
    expect(script).toContain("> /tmp/holp-harness-workspace/session-shell/broker.log 2>&1 &");
    expect(script).toContain("for i in $(seq 1 80); do [ -S /tmp/holp-harness-workspace/session-shell/broker.sock ] && break; sleep 0.25; done");
    expect(script).toContain("HOLP_HARNESS_BROKER_SOCKET=/tmp/holp-harness-workspace/session-shell/broker.sock HOLP_HARNESS_CMUX_MANIFEST_PATH=/tmp/holp-harness-workspace/session-shell/cmux-surfaces.json npm run harness:workspace:tui");

    const zsh = spawnSync("zsh", ["-n"], { input: script, encoding: "utf8" });
    if (zsh.error && "code" in zsh.error && zsh.error.code === "ENOENT") return;
    expect(`${zsh.stderr}${zsh.stdout}`).toBe("");
    expect(zsh.status).toBe(0);
  });

  it("builds a cmux-safe real controller launch payload with the boot prompt as agent instruction", () => {
    const codex = buildControllerBootPrompt({
      brokerSocket: "/tmp/holp-harness-workspace/session-controller/broker.sock",
      controller: "codex",
      locale: "zh-CN",
    });
    const unsupportedKimi = buildControllerBootPrompt({
      brokerSocket: "/tmp/holp-harness-workspace/session-controller/broker.sock",
      controller: "kimi-code",
    });
    expect(codex).toContain("export HOLP_HARNESS_BROKER_SOCKET=/tmp/holp-harness-workspace/session-controller/broker.sock");
    expect(codex).toContain("export HOLP_HARNESS_LOCALE=zh-CN");
    expect(codex).toContain("codex -C ");
    expect(codex.indexOf("export HOLP_HARNESS_BROKER_SOCKET=")).toBeLessThan(codex.indexOf("codex -C "));
    expect(codex).toContain("The human will interact with you in natural language");
    expect(codex).toContain("npm run harness:workspace:client -- status");
    expect(codex).toContain("workers");
    expect(codex).toContain("--worker auto");
    expect(codex).toContain("<human goal>");
    expect(codex).not.toMatch(/\\[nrt]/);
    expect(codex).not.toContain("exec codex");
    expect(codex).not.toContain("exec kimi");
    expect(codex).not.toContain("codex exec");
    expect(codex).not.toContain("node -e");
    expect(codex).not.toContain("console.log");
    expect(codex).not.toMatch(/echo .*&& codex/);
    expect(unsupportedKimi).toContain("kimi-code interactive controller path is unsupported");
    expect(unsupportedKimi).not.toContain("kimi ");
    expect(codex.endsWith("\n")).toBe(true);
    expect([...codex.matchAll(/\n/g)]).toHaveLength(1);
    const zsh = spawnSync("zsh", ["-n"], { input: codex, encoding: "utf8" });
    if (!(zsh.error && "code" in zsh.error && zsh.error.code === "ENOENT")) {
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
      expect(payload).toContain(`HOLP_HARNESS_BROKER_SOCKET=${brokerSocket}`);
      expect(payload).toContain(`HOLP_HARNESS_CMUX_MANIFEST_PATH=/tmp/holp-harness-workspace/${id}/cmux-surfaces.json`);
      expect(payload).toContain("npm run harness:workspace:tui");
    } finally {
      rmSync(`/tmp/holp-harness-workspace/${id}`, { recursive: true, force: true });
    }
  });

  it("demo mode starts a fake broker, uses fake-agent, and bypasses the controller binary gate", async () => {
    const id = sessionId("demo");
    const calls: string[][] = [];
    try {
      const result = await runCmuxTuiLauncher({
        argv: ["--session-id", id, "--workspace", "workspace:1", "--demo"],
        env: { HOLP_HARNESS_WORKSPACE_TUI: "1" },
        isOnPath: () => false,
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
      expect(result.degraded_reasons).not.toContain("missing_controller_binary");
      const sends = calls.filter((args) => args[0] === "send" && !args.includes("--help"));
      const tuiPayload = sends.find((args) => args.includes("surface:surface-tui"))?.at(-1) ?? "";
      const controllerPayload = sends.find((args) => args.includes("surface:surface-controller"))?.at(-1) ?? "";
      expect(tuiPayload).toContain("HOLP_REGISTRY=fake npm run harness:workspace:broker -- --session-id");
      expect(tuiPayload).toContain("--transport fake");
      expect(controllerPayload).toContain("--worker fake-agent");
      expect(controllerPayload).not.toContain("exec codex");
      expect(controllerPayload).toContain("codex -C ");
      expect(calls.every((args) => args.includes("--help") || args.includes("--workspace"))).toBe(true);
      expect(calls.every((args) => args[0] !== "new-surface" || !args.includes("--provider"))).toBe(true);
      const newPaneCalls = calls.filter((args) => args[0] === "new-pane" && !args.includes("--help"));
      expect(newPaneCalls.every((args) => args.includes("--focus") && args[args.indexOf("--focus") + 1] === "false")).toBe(true);
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
