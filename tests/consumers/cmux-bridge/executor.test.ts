import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cmuxCommandArgs,
  executeCmuxLayoutPlan,
  planCmuxTeamLayout,
} from "../../../consumers/cmux-bridge/index.js";
import { buildFocusShellDemoModel } from "../../../consumers/harness-workspace/demo.js";

function plan(workspaceId = "workspace:74") {
  return planCmuxTeamLayout({
    caller: { workspaceId, surfaceId: "surface:ctrl" },
    model: buildFocusShellDemoModel({ locale: "en-US", mode: "overview" }),
    viewDir: "/tmp/holp-test-layout",
  });
}

describe("cmux Team Layout executor", () => {
  it("defaults to dry-run and executes zero commands", async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const result = await executeCmuxLayoutPlan(plan(), {
      env: {},
      runner: async (command, args) => {
        calls.push({ command, args });
        return { command: `${command} ${args.join(" ")}`, ok: true };
      },
      writeView: () => {
        throw new Error("dry-run must not write markdown views");
      },
    });

    expect(result.mode).toBe("dry-run");
    expect(result.executed).toEqual([]);
    expect(result.skipped).toHaveLength(result.plan.commands.length);
    expect(calls).toEqual([]);
    expect(result.degradedReasons).toContain("execution_not_enabled");
  });

  it("missing workspace is degraded and executes zero commands even when opt-in is set", async () => {
    const missing = planCmuxTeamLayout({
      caller: {},
      model: buildFocusShellDemoModel({ locale: "en-US", mode: "overview" }),
    });
    const result = await executeCmuxLayoutPlan(missing, {
      env: { HOLP_CMUX_TEAM_LAYOUT: "1" },
      runner: async () => {
        throw new Error("degraded plan must not execute");
      },
    });

    expect(result.mode).toBe("degraded");
    expect(result.executed).toEqual([]);
    expect(result.degradedReasons).toContain("missing_workspace");
  });

  it("opt-in execution sends exactly the planned cmux argv to the runner", async () => {
    const planned = plan();
    const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
    const written: string[] = [];
    const result = await executeCmuxLayoutPlan(planned, {
      env: { HOLP_CMUX_TEAM_LAYOUT: "1" },
      cwd: "/repo",
      cmuxCommand: "/bin/cmux",
      writeView: (view) => {
        written.push(view.path);
      },
      runner: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return { command: `${command} ${args.join(" ")}`, ok: true };
      },
    });

    expect(result.mode).toBe("executed");
    expect(written).toEqual(planned.views.map((view) => view.path));
    expect(calls.map((call) => call.args)).toEqual(planned.commands.map((command) => cmuxCommandArgs(command)));
    expect(calls.every((call) => call.command === "/bin/cmux" && call.cwd === "/repo")).toBe(true);
  });

  it("materializes markdown views without group or other permissions", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "holp-cmux-layout-test-"));
    try {
      const viewDir = path.join(root, "views");
      const planned = planCmuxTeamLayout({
        caller: { workspaceId: "workspace:74", surfaceId: "surface:ctrl" },
        model: buildFocusShellDemoModel({ locale: "en-US", mode: "overview" }),
        viewDir,
      });

      await executeCmuxLayoutPlan(planned, {
        env: { HOLP_CMUX_TEAM_LAYOUT: "1" },
        cwd: "/repo",
        cmuxCommand: "/bin/cmux",
        runner: async (command, args) => ({ command: `${command} ${args.join(" ")}`, ok: true }),
      });

      if (process.platform !== "win32") {
        expect(statSync(viewDir).mode & 0o077).toBe(0);
        for (const view of planned.views) {
          expect(statSync(view.path).mode & 0o077).toBe(0);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("demo script is dry-run by default", () => {
    const output = execFileSync("npm", ["run", "harness:workspace:cmux-layout", "--", "--workspace", "workspace:dry"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOLP_CMUX_TEAM_LAYOUT: "" },
    });

    expect(output).toContain("HOLP cmux Team Layout");
    expect(output).toContain("mode=dry-run");
    expect(output).toContain("workspace=workspace:dry");
    expect(output).toContain("cmux markdown open");
  });
});
