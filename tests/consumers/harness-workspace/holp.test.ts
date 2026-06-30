import { execFileSync } from "node:child_process";
import { symlinkSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHolpArgs, runHolpCli } from "../../../consumers/harness-workspace/holp.js";
import type { SamePaneLauncherOptions, SamePaneLauncherResult } from "../../../consumers/cmux-bridge/samePaneLauncher.js";

describe("holp CLI facade", () => {
  it("routes native launch forms to the same-pane Codex entry", async () => {
    const launched: SamePaneLauncherOptions[] = [];
    const launchSamePane = async (options: SamePaneLauncherOptions): Promise<SamePaneLauncherResult> => {
      launched.push(options);
      return {
        mode: "planned",
        manifest_path: "/tmp/manifest.json",
        degraded_reasons: [],
        manifest: {
          schema_version: "HolpHarnessWorkspaceCmuxManifest.v1",
          session_id: "s",
          workspace_id: "w",
          broker_socket: "/tmp/broker.sock",
          created_at: "now",
          surfaces: {},
          degraded_reasons: [],
          command_results: [],
        },
      };
    };

    await runHolpCli([], { launchSamePane, stdout: sink });
    await runHolpCli(["codex"], { launchSamePane, stdout: sink });
    await runHolpCli(["ship", "it"], { launchSamePane, stdout: sink });
    await runHolpCli(["codex", "ship", "it"], { launchSamePane, stdout: sink });

    expect(launched.map((item) => item.goal)).toEqual([undefined, undefined, "ship it", "ship it"]);
  });

  it("maps broker commands to existing client argv", async () => {
    const calls: readonly string[][] = [];
    const runClient = async (argv: readonly string[]): Promise<number> => {
      (calls as string[][]).push([...argv]);
      return 0;
    };

    await runHolpCli(["workers"], { runClient });
    await runHolpCli(["status"], { runClient });
    await runHolpCli(["run", "ship", "it", "--worker", "auto"], { runClient });
    await runHolpCli(["approve", "looks", "safe"], { runClient });
    await runHolpCli(["reject", "needs", "more"], { runClient });

    expect(calls).toEqual([
      ["workers"],
      ["status"],
      ["run", "--goal", "ship it", "--worker", "auto"],
      ["approve", "--decision", "approved", "--reason", "looks safe"],
      ["approve", "--decision", "rejected", "--reason", "needs more"],
    ]);
  });

  it("maps explicit run worker and --goal forms to existing client argv", async () => {
    const calls: readonly string[][] = [];
    const runClient = async (argv: readonly string[]): Promise<number> => {
      (calls as string[][]).push([...argv]);
      return 0;
    };

    await runHolpCli(["run", "ship", "it", "--worker", "kimi-code"], { runClient });
    await runHolpCli(["run", "--goal", "ship it", "--worker", "opencode"], { runClient });

    expect(calls).toEqual([
      ["run", "--goal", "ship it", "--worker", "kimi-code"],
      ["run", "--goal", "ship it", "--worker", "opencode"],
    ]);
  });

  it("returns non-zero when the same-pane launcher degrades", async () => {
    const code = await runHolpCli(["codex"], {
      launchSamePane: async () => ({
        mode: "degraded",
        manifest_path: "/tmp/manifest.json",
        degraded_reasons: ["missing_controller_binary"],
        manifest: {
          schema_version: "HolpHarnessWorkspaceCmuxManifest.v1",
          session_id: "s",
          workspace_id: "w",
          broker_socket: "/tmp/broker.sock",
          created_at: "now",
          surfaces: {},
          degraded_reasons: ["missing_controller_binary"],
          command_results: [],
        },
      }),
      stdout: sink,
    });

    expect(code).toBe(1);
  });

  it("rejects demo as a user-facing entry", () => {
    expect(() => parseHolpArgs(["demo"])).toThrow(/demo is not available/);
  });

  it("bin/holp resolves relative symlink targets correctly", () => {
    const binHolp = new URL("../../../bin/holp", import.meta.url).pathname;
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "holp-symlink-")));
    const linkPath = join(tmpDir, "holp-link");
    // Use a relative target (relative from tmpDir to binHolp) — this is the scenario the fix handles.
    // Without the fix, `self=$(readlink "$self")` returns a relative path which then gets resolved
    // against caller cwd instead of `dirname "$self"`, breaking repo_root derivation.
    const relTarget = relative(tmpDir, binHolp);
    symlinkSync(relTarget, linkPath);

    let stderr = "";
    try {
      // Invoke via `sh` explicitly: macOS Node execFileSync can't exec a shebang script via symlink.
      execFileSync("sh", [linkPath, "demo"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: string };
      stderr = e.stderr ?? "";
      expect(e.status).not.toBe(127); // must not fail with "tsx not found"
    }
    expect(stderr).toMatch(/demo is not available/);
  });
});

const sink = { write: () => true };
