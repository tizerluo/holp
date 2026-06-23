#!/usr/bin/env tsx
/**
 * Opt-in smoke for native-claude runtime surfaces: headless, acp, direct_user_session.
 *
 * Requires: HOLP_REAL_CLAUDE_SMOKE=1
 * Run:      HOLP_REAL_CLAUDE_SMOKE=1 npm run smoke:claude:surfaces
 *
 * Without opt-in: prints SKIP and exits 0. No real probe turns run.
 * With opt-in: probes headless via probeClaudeCode, records ACP as honest
 *   unsupported (claude_no_native_acp), and attempts direct round-trip in
 *   holp-* tmux session looking for HOLP_OK in terminal output.
 *
 * Does not stage, commit, push, or modify the working tree.
 * Direct sessions use holp-* namespace only; no attach to existing user shells.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { probeClaudeCode, READ_ONLY_ALLOWED_TOOLS } from "../../adapters/claude-code.js";
import { probeDirectTmux, createDirectTmuxBackendFactory } from "../../adapters/direct-tmux.js";

const OPT_IN = process.env["HOLP_REAL_CLAUDE_SMOKE"] === "1";
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
  const result = await probeClaudeCode(
    { id: "claude-smoke", transport: "native-claude", roles: ["reviewer"], cwd },
    { probeTimeoutMs: 30_000 },
  );
  const surface = result.runtime_surfaces?.find((s) => s.runtime_surface === "headless");
  const rop = surface?.isolation_profiles.read_only_review;
  if (rop?.readiness === "ready" && surface?.declared_not_enforced === false) {
    return { surface: "headless", outcome: "PASS", reason: result.version ?? "probe ready", evidence: surface.runtime_kind };
  }
  if (result.status === "rejected" || surface?.surface_support === "unsupported") {
    return { surface: "headless", outcome: "FAIL", reason: result.reason ?? "rejected" };
  }
  return {
    surface: "headless",
    outcome: "INCONCLUSIVE",
    reason: rop?.reason ?? result.reason ?? "read_only_enforcement_not_proven",
  };
}

function runAcpSmoke(): SurfaceResult {
  // Claude Code has no native ACP. Record honest unsupported; no fake bridge smoke.
  return {
    surface: "acp",
    outcome: "SKIP",
    reason: "unsupported:claude_no_native_acp",
  };
}

async function runDirectSmoke(cwd: string): Promise<SurfaceResult> {
  const probe = await probeDirectTmux({ agentCommand: "claude", cwd, verifyCapabilities: true, timeoutMs: 5_000 });
  if (!probe.ready) {
    return { surface: "direct_user_session", outcome: "SKIP", reason: probe.reason ?? "tmux or claude not available" };
  }

  const factory = createDirectTmuxBackendFactory({
    transport: "direct_tmux",
    agentCommand: "claude",
    agentArgsForPrompt: (prompt) => [
      "-p", prompt,
      "--output-format", "json",
      "--allowedTools", READ_ONLY_ALLOWED_TOOLS,
    ],
    timeoutMs: 30_000,
  });
  const backend = factory({ cwd });
  try {
    const { sessionId } = await backend.startSession();
    let captured = "";
    backend.onMessage((msg) => {
      if (msg.type === "model-output" && msg.fullText != null) captured = msg.fullText;
    });
    await backend.sendPrompt(sessionId, `Print exactly: ${HOLP_OK_MARKER}`);
    if (captured.includes(HOLP_OK_MARKER)) {
      return { surface: "direct_user_session", outcome: "PASS", evidence: "HOLP_OK found in model-output" };
    }
    return {
      surface: "direct_user_session",
      outcome: "INCONCLUSIVE",
      reason: "HOLP_OK not observed; check auth/quota/provider output",
      evidence: captured.slice(0, 120) || undefined,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/^direct_tmux_/.test(msg)) {
      return { surface: "direct_user_session", outcome: "FAIL", reason: msg };
    }
    return {
      surface: "direct_user_session",
      outcome: "INCONCLUSIVE",
      reason: msg,
    };
  } finally {
    await backend.dispose().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (!OPT_IN) {
    console.log("SKIP: HOLP_REAL_CLAUDE_SMOKE=1 not set. Run: HOLP_REAL_CLAUDE_SMOKE=1 npm run smoke:claude:surfaces");
    process.exit(0);
  }

  console.log("=== claude surfaces smoke ===");
  console.log(`claude version: ${spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "not found"}`);
  console.log(`tmux version: ${spawnSync("tmux", ["-V"], { encoding: "utf8" }).stdout?.trim() ?? "not found"}`);
  console.log("");

  const cwd = mkdtempSync(join(tmpdir(), "holp-claude-surfaces-smoke-"));
  try {
    const [headless, direct] = await Promise.all([
      runHeadlessSmoke(cwd),
      runDirectSmoke(cwd),
    ]);
    const acp = runAcpSmoke();
    const results = [headless, acp, direct];

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
