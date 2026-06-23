#!/usr/bin/env tsx
/**
 * Opt-in smoke for all three mcp-codex runtime surfaces: headless, acp, direct_user_session.
 *
 * Requires: HOLP_REAL_CODEX_SMOKE=1
 * Run:      HOLP_REAL_CODEX_SMOKE=1 npm run smoke:codex:surfaces
 *
 * Without opt-in: prints SKIP and exits 0.
 * With opt-in: probes each surface via probeCodexAppServer, then attempts ACP
 *   and direct round-trips looking for HOLP_OK in terminal output.
 *   Records PASS / INCONCLUSIVE / FAIL per surface with reason.
 *
 * Does not stage, commit, push, or modify the working tree.
 * Direct sessions use holp-* namespace only; no attach to existing user shells.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCodexAppServer } from "../../adapters/codex-app-server.js";
import { AcpClient } from "../../adapters/acp-client.js";
import { probeDirectTmux } from "../../adapters/direct-tmux.js";
import { spawnSync } from "node:child_process";

const OPT_IN = process.env["HOLP_REAL_CODEX_SMOKE"] === "1";
const HOLP_OK_MARKER = "HOLP_OK";

type Outcome = "PASS" | "INCONCLUSIVE" | "FAIL" | "SKIP";

interface SurfaceResult {
  surface: string;
  outcome: Outcome;
  reason?: string;
  evidence?: string;
}

function printResult(r: SurfaceResult): void {
  const tag = r.outcome.padEnd(12);
  const detail = r.reason ? ` | ${r.reason}` : "";
  const evidence = r.evidence ? ` | evidence: ${r.evidence.slice(0, 120)}` : "";
  console.log(`  ${tag} ${r.surface}${detail}${evidence}`);
}

async function runHeadlessSmoke(cwd: string): Promise<SurfaceResult> {
  const result = await probeCodexAppServer(
    { id: "codex-smoke", transport: "mcp-codex", roles: ["coder"], cwd },
    { command: "codex", probeTimeoutMs: 30_000, acpSmokeRunner: async () => "skip", directSmokeRunner: async () => "skip" },
  );
  const surface = result.runtime_surfaces?.find((s) => s.runtime_surface === "headless");
  if (result.status === "ready") {
    return { surface: "headless", outcome: "PASS", reason: result.version ?? "probe ready", evidence: surface?.runtime_kind };
  }
  if (result.status === "degraded") {
    return { surface: "headless", outcome: "INCONCLUSIVE", reason: result.reason ?? "degraded" };
  }
  return { surface: "headless", outcome: "FAIL", reason: result.reason ?? "rejected" };
}

async function runAcpSmoke(cwd: string): Promise<SurfaceResult> {
  // skip only when binary is absent (ENOENT); codex-acp has no --version
  const helpCheck = spawnSync("codex-acp", ["--help"], { encoding: "utf8", timeout: 10_000 });
  if ((helpCheck.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return { surface: "acp", outcome: "SKIP", reason: "codex-acp not installed" };
  }

  let sessionOutput = "";
  let sessionErr: string | undefined;
  const client = new AcpClient({ command: "codex-acp", cwd, requestTimeoutMs: 30_000, terminalTimeoutMs: 30_000 });
  try {
    const { sessionId } = await client.startSession();
    sessionOutput = await client.sendPrompt(sessionId, `Print exactly: ${HOLP_OK_MARKER}`);
  } catch (err: unknown) {
    sessionErr = err instanceof Error ? err.message : String(err);
  } finally {
    await client.dispose();
  }

  if (sessionErr !== undefined) {
    return { surface: "acp", outcome: "FAIL", reason: sessionErr };
  }
  if (sessionOutput.includes(HOLP_OK_MARKER)) {
    return { surface: "acp", outcome: "PASS", evidence: sessionOutput.slice(0, 80) };
  }
  return { surface: "acp", outcome: "FAIL", reason: "HOLP_OK not found in terminal output", evidence: sessionOutput.slice(0, 80) };
}

async function runDirectSmoke(cwd: string): Promise<SurfaceResult> {
  // Probe: tmux + codex binary must be available and capable
  const probe = await probeDirectTmux({ agentCommand: "codex", cwd, verifyCapabilities: true });
  if (!probe.ready) {
    return { surface: "direct_user_session", outcome: "SKIP", reason: probe.reason ?? "tmux or codex not available" };
  }

  // Create holp-owned throwaway session; spawnSync array avoids shell injection
  const sessionName = `holp-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const prompt = `Print exactly: ${HOLP_OK_MARKER}`;
  try {
    // array form — prompt passed as a literal arg, not interpolated into shell
    const newSession = spawnSync(
      "tmux",
      [
        "new-session", "-d", "-s", sessionName, "-x", "220", "-y", "50",
        "--",
        "codex", "exec", "--sandbox", "workspace-write",
        "-c", 'approval_policy="never"',
        "--skip-git-repo-check",
        "-c", "notify=[]",
        prompt,
      ],
      { cwd, timeout: 60_000 },
    );
    if (newSession.error || newSession.status !== 0) {
      return {
        surface: "direct_user_session",
        outcome: "FAIL",
        reason: newSession.error?.message ?? `tmux new-session exited ${newSession.status}`,
      };
    }

    // Poll for HOLP_OK in pane output (up to 30s)
    const deadline = Date.now() + 30_000;
    let found = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const capture = spawnSync("tmux", ["capture-pane", "-t", sessionName, "-p", "-S", "-200"], { encoding: "utf8", timeout: 5_000 });
        if (capture.stdout?.includes(HOLP_OK_MARKER)) { found = true; break; }
        // stop polling if pane is gone (session exited)
        const alive = spawnSync("tmux", ["has-session", "-t", sessionName], { timeout: 2_000 });
        if (alive.status !== 0) { break; }
      } catch { break; }
    }

    // Kill session unconditionally
    spawnSync("tmux", ["kill-session", "-t", sessionName], { timeout: 5_000 });

    if (found) {
      return { surface: "direct_user_session", outcome: "PASS", evidence: "HOLP_OK found in pane capture" };
    }
    return { surface: "direct_user_session", outcome: "FAIL", reason: "HOLP_OK not found within 30s; check quota/auth", evidence: "pane capture timeout" };
  } catch (err: unknown) {
    spawnSync("tmux", ["kill-session", "-t", sessionName], { timeout: 5_000 });
    const msg = err instanceof Error ? err.message : String(err);
    return { surface: "direct_user_session", outcome: "FAIL", reason: msg };
  }
}

async function main(): Promise<void> {
  if (!OPT_IN) {
    console.log("SKIP: HOLP_REAL_CODEX_SMOKE=1 not set. Run: HOLP_REAL_CODEX_SMOKE=1 npm run smoke:codex:surfaces");
    process.exit(0);
  }

  console.log("=== codex surfaces smoke ===");
  console.log(`codex version: ${spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "not found"}`);
  const acpHelp = spawnSync("codex-acp", ["--help"], { encoding: "utf8", timeout: 10_000 });
  const acpPresent = (acpHelp.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
  console.log(`codex-acp: ${acpPresent ? "present" : "not found"}`);
  console.log(`tmux version: ${spawnSync("tmux", ["-V"], { encoding: "utf8" }).stdout?.trim() ?? "not found"}`);
  console.log("");

  const cwd = mkdtempSync(join(tmpdir(), "holp-codex-surfaces-smoke-"));
  try {
    const results = await Promise.all([
      runHeadlessSmoke(cwd),
      runAcpSmoke(cwd),
      runDirectSmoke(cwd),
    ]);

    console.log("Results:");
    for (const r of results) printResult(r);
    console.log("");

    const failed = results.filter((r) => r.outcome === "FAIL");
    if (failed.length > 0) {
      console.error(`FAIL: ${failed.length} surface(s) failed`);
      process.exit(1);
    }
    console.log("All surfaces: PASS or SKIP/INCONCLUSIVE (no FAIL)");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("smoke error:", err);
  process.exit(1);
});
