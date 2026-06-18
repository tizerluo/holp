/**
 * Shared isolation harness for the real-Codex approval/patch smokes.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Codex adapter spawns a real `codex app-server --stdio` child. By default that
 * child inherits the user-level `~/.codex/` (config.toml + auth.json + sessions + logs)
 * AND the global `notify` hook on config.toml line 1, which spawns orphan helper
 * processes in automation. Running an approval/patch smoke naively therefore produces
 * global, non-rollback-safe side effects.
 *
 * This harness makes the smoke ROLLBACK-SAFE by construction:
 *   - A temp CODEX_HOME (mkdtemp) holds a copied auth.json + a minimal config.toml
 *     with `notify = []`. The real `~/.codex/` is NEVER WRITTEN; it is only READ ONCE to
 *     copy auth.json as a login-credential seed. Codex honours $CODEX_HOME, so every
 *     session/log/sqlite/state file produced by the run lands in temp instead.
 *   - A temp git workspace (mkdtemp) seeded with a tracked SMOKE.txt bounds file edits.
 *   - Teardown (process-group kill + rm -rf) restores the machine even on crash. The real
 *     `~/.codex/` is left untouched (we never write it); residual leaks land only in temp.
 *
 * Isolation lever (no production code change): through the live daemon path the only
 * externally-controllable knobs are the daemon process's own cwd (-> Codex cwd) and its
 * environment (CODEX_HOME, inherited by the spawned Codex child + probe subprocesses).
 * Verified 2026-06-18: `CODEX_HOME=<temp> codex doctor` reports "auth is configured",
 * loads the temp config.toml, and redirects all state paths into temp.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Text seeded into SMOKE.txt; the approve scenario appends a marker line after this. */
export const SEED_LINE = "holp smoke seed line — do not edit by hand\n";
/** Marker the smoke task asks Codex to append; asserted on disk after approval. */
export const SMOKE_MARKER = "HOLP_SMOKE_OK";
/** Tracked file Codex is asked to patch. */
export const SMOKE_FILE = "SMOKE.txt";

/**
 * PATCH scenario prompt — deterministic file edit, NO approval.
 *
 * Empirically (Codex 0.140.0, adapter policy `approvalPolicy:on-request` +
 * `sandbox:workspace-write`): an in-workspace file edit is auto-applied and does NOT
 * trigger the approval bridge. So this prompt exercises the real patch path
 * (fs-edit + diff + on-disk change + run_merged) only — it does not test approval.
 */
export const PATCH_PROMPT = [
  `Append exactly one line containing the text ${SMOKE_MARKER} to the end of the file ${SMOKE_FILE}.`,
  "Make the change by editing the file directly (apply a patch).",
  "Do not run shell commands, do not create other files, do not run git.",
  "Make only this one change, then stop.",
].join(" ");

/**
 * APPROVAL scenario prompt — a sandbox-escape command that DOES trigger a real
 * `shell_command` approval.
 *
 * Empirically the only reliable real-approval trigger under the adapter's policy is a
 * command the sandbox blocks (the workspace sandbox has a restricted local-proxy network):
 * Codex runs it in-sandbox, the local proxy refuses the connection, and Codex escalates
 * with `item/commandExecution/requestApproval` ("...run the requested command outside the
 * sandbox?"). The explicit "if it fails inside the sandbox, ask for approval to run it
 * outside" instruction maximizes the escalation rate. File edits never escalate, so a
 * network command is used deliberately. NOTE: this remains subject to LLM non-determinism
 * — the scenario reports a clear INCONCLUSIVE if no approval is requested, rather than a
 * false pass or a spurious fail.
 */
/** The exact inner shell command the approval scenario asks Codex to run. */
export const EXPECTED_APPROVAL_COMMAND =
  "curl -sS -m 10 https://example.com -o /dev/null && echo REACHABLE";

export const APPROVAL_PROMPT = [
  "Check whether this machine can reach the internet by running exactly this shell command",
  "and nothing else:",
  `${EXPECTED_APPROVAL_COMMAND}.`,
  "Run it as a single shell command.",
  "If it fails inside the sandbox, request approval to run it outside the sandbox.",
].join(" ");

/**
 * Strict allowlist for the unattended approve sub-run. Returns true ONLY when the
 * requested command is exactly EXPECTED_APPROVAL_COMMAND (optionally wrapped in a single
 * `sh/bash/zsh -lc '<cmd>'` invocation, which is how Codex shells out). The compare is
 * anchored and exact after whitespace normalization, so a deviation like
 * `curl ... && rm -rf ~` does NOT match and is never auto-approved.
 */
export function isExpectedApprovalCommand(rawCommand: string): boolean {
  const normalized = rawCommand.trim().replace(/\s+/g, " ");
  // Strip an optional `<path>sh -lc '<inner>'` / `-c "<inner>"` wrapper.
  const wrapper = /^(?:\S*\/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/.exec(normalized);
  const inner = (wrapper ? wrapper[2] : normalized).trim().replace(/\s+/g, " ");
  return inner === EXPECTED_APPROVAL_COMMAND;
}

/** Path to the real user auth.json the smoke copies into the temp CODEX_HOME. */
export function realAuthPath(): string {
  return join(homedir(), ".codex", "auth.json");
}

/**
 * Preflight gate. Returns true only when the smoke is explicitly opted into AND the
 * real auth file exists. Callers that get false should print the reason and exit 0
 * (so an accidental `npm run smoke:codex` is a no-op, never a failure).
 */
export function preflight(): { ok: true } | { ok: false; reason: string } {
  if (process.env.HOLP_REAL_CODEX_SMOKE !== "1") {
    return {
      ok: false,
      reason: "skipped: set HOLP_REAL_CODEX_SMOKE=1 to run the real-Codex smoke (consumes ChatGPT quota)",
    };
  }
  if (!existsSync(realAuthPath())) {
    return {
      ok: false,
      reason: `skipped: ${realAuthPath()} not found — run \`codex login\` first`,
    };
  }
  return { ok: true };
}

/** A fully isolated Codex environment: temp CODEX_HOME + temp git workspace. */
export interface IsolatedEnv {
  /** Temp CODEX_HOME with copied auth.json + notify=[] config.toml. */
  readonly codexHome: string;
  /** Temp git workspace (cwd for the run), seeded with a tracked SMOKE.txt. */
  readonly workspace: string;
  /** Absolute path to the seeded SMOKE.txt inside the workspace. */
  readonly smokeFile: string;
  /** Read SMOKE.txt's current on-disk contents (the primary assertion source). */
  readSmokeFile(): string;
  /** Whether SMOKE.txt now contains the smoke marker (i.e. the patch was applied). */
  smokeFileChanged(): boolean;
  /** rm -rf both temp dirs. Idempotent; safe to call in finally even after partial setup. */
  cleanup(): void;
}

/**
 * Build a temp CODEX_HOME (copied auth.json + notify=[] config.toml) and a temp git
 * workspace seeded with a tracked SMOKE.txt. The caller MUST call cleanup() in a finally.
 */
export function createIsolatedEnv(): IsolatedEnv {
  const codexHome = mkdtempSync(join(tmpdir(), "holp-smoke-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "holp-smoke-ws-"));
  const smokeFile = join(workspace, SMOKE_FILE);

  const cleanup = (): void => {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  };

  try {
    // --- Temp CODEX_HOME: copy auth, neutralize the global notify hook ---
    cpSync(realAuthPath(), join(codexHome, "auth.json"));
    // `notify = []` is the only load-bearing line: it overrides the user's global
    // notify hook. Session policy (approval/sandbox) is set per-session by the adapter,
    // so we deliberately keep this config minimal and add no trusted-projects entries.
    writeFileSync(join(codexHome, "config.toml"), "notify = []\n", "utf8");

    // --- Temp workspace: a real git repo with a tracked seed file (apply-patch path) ---
    writeFileSync(smokeFile, SEED_LINE, "utf8");
    git(workspace, ["init", "-q"]);
    git(workspace, ["add", "-A"]);
    // Pin identity via -c so the commit does not depend on (or touch) global git config.
    git(workspace, [
      "-c",
      "user.email=smoke@holp.local",
      "-c",
      "user.name=holp-smoke",
      "commit",
      "-q",
      "-m",
      "seed",
    ]);
  } catch (err) {
    cleanup();
    throw err;
  }

  return {
    codexHome,
    workspace,
    smokeFile,
    readSmokeFile: () => readFileSync(smokeFile, "utf8"),
    smokeFileChanged: () => readFileSync(smokeFile, "utf8").includes(SMOKE_MARKER),
    cleanup,
  };
}

/** Run a git command in `cwd`, throwing with captured output on failure. */
function git(cwd: string, args: readonly string[]): void {
  const res = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (status ${res.status}): ${res.stderr || res.stdout}`,
    );
  }
}

/** Sleep helper for polling loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
