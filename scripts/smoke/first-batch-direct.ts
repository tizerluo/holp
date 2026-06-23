import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createDefaultAdapterRegistry } from "../../adapters/registry.js";
import { FIRST_BATCH_TRANSPORTS } from "../../adapters/first-batch-harnesses.js";
import type { RuntimeSurfaceDeclaration } from "../../adapters/harness-declaration.js";

type SmokeStatus = "PASS" | "SKIP" | "INCONCLUSIVE" | "FAIL";

const execFileAsync = promisify(execFile);

if (process.env.HOLP_REAL_HARNESS_DIRECT_SMOKE !== "1") {
  console.log("SKIP HOLP_REAL_HARNESS_DIRECT_SMOKE=1 not set");
  process.exit(0);
}

const registry = createDefaultAdapterRegistry();
const smokeCwd = mkdtempSync(join(tmpdir(), "holp-first-batch-direct-"));
const tmuxVersion = await versionOf("tmux", ["-V"], smokeCwd);
const results: Array<{ transport: string; status: SmokeStatus; detail: string }> = [];

try {
  for (const transport of FIRST_BATCH_TRANSPORTS) {
    try {
      const probe = await registry.probe({
        id: `${transport}-direct-smoke`,
        transport,
        roles: ["coder", "reviewer", "tester", "architect"],
        cwd: smokeCwd,
        runtimeSurface: "direct_user_session",
        isolationProfile: "coder_worktree",
        runIntent: "smoke:first-batch:direct",
        workspaceId: smokeCwd,
        sessionRouteKey: `${transport}-direct-smoke`,
      });
      const direct = probe.runtime_surfaces?.find((surface) =>
        surface.runtime_surface === "direct_user_session"
      );
      const readiness = direct?.isolation_profiles.coder_worktree.readiness ?? "missing";
      const reason = direct?.isolation_profiles.coder_worktree.reason ?? probe.reason ?? "unknown";
      const agentVersion = probe.version ?? "version_not_reported";
      const status = statusForDirectSurface(direct);
      const evidence = readiness === "ready" ? "HOLP_OK verified" : reason;
      results.push({
        transport,
        status,
        detail: `${readiness}; agent=${agentVersion}; tmux=${tmuxVersion}; ${evidence}`,
      });
    } catch (error) {
      results.push({
        transport,
        status: "FAIL",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
} finally {
  rmSync(smokeCwd, { recursive: true, force: true });
}

for (const result of results) {
  console.log(`${result.status} ${result.transport} ${result.detail}`);
}

if (results.some((result) => result.status === "FAIL")) process.exit(1);

function statusForDirectSurface(surface: RuntimeSurfaceDeclaration | undefined): SmokeStatus {
  const profile = surface?.isolation_profiles.coder_worktree;
  if (!profile) return "FAIL";
  if (profile.readiness === "ready") return "PASS";
  const reason = profile.reason ?? "";
  const missing = profile.missing ?? [];
  if (
    missing.some((item) => item.startsWith("binary:")) ||
    reason === "direct_agent_unavailable"
  ) {
    return "SKIP";
  }
  if (
    reason === "tmux_create_probe_failed" ||
    reason === "tmux_inject_probe_failed" ||
    reason === "tmux_read_probe_failed" ||
    reason.startsWith("direct_tmux_")
  ) {
    return "FAIL";
  }
  return "INCONCLUSIVE";
}

async function versionOf(command: string, args: readonly string[], cwd: string): Promise<string> {
  try {
    const result = await execFileAsync(command, [...args], { cwd, timeout: 2_000 });
    return result.stdout.trim() || "version_empty";
  } catch {
    return "unavailable";
  }
}
