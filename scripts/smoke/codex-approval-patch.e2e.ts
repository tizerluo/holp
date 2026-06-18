#!/usr/bin/env tsx
/**
 * Layer 2 — end-to-end daemon real-Codex smoke (patch + approval, two independent paths).
 *
 * Spawns the real HOLP daemon (`tsx daemon/runtime/server.ts`) with the real `mcp-codex`
 * registry, pointed at an isolated temp CODEX_HOME + temp git workspace, and drives the
 * live protocol over NDJSON JSON-RPC:
 *
 *   initialize -> flock.declare -> events.subscribe -> orchestrate.run ->
 *   [maybe approval_requested -> approval.resolve] -> terminal event -> [artifact.get]
 *
 * Two SEPARATE scenarios, each on a FRESH daemon + workspace (the daemon's cwd is fixed
 * at launch, so a per-scenario workspace requires a per-scenario daemon):
 *
 *   1. PATCH — a file edit. Empirically auto-applied with NO approval under the adapter's
 *      on-request + workspace-write policy. Asserts: run_merged AND SMOKE.txt gains the
 *      marker on disk. (Proves the live orchestrate.run patch path with a real provider —
 *      the thing the PR5/M3 safe-prompt smoke never covered.)
 *
 *   2. APPROVAL — a sandbox-escape (network) command, the only reliable real-approval
 *      trigger. Runs the SAME prompt twice:
 *        a. approve -> assert run_merged (command allowed to proceed).
 *        b. reject  -> assert run_blocked (adapter denies, emits stopped -> run_blocked).
 *      Because the LLM may decline to run the command at all, each sub-run reports
 *      INCONCLUSIVE (not FAIL) if no approval_requested arrives before the terminal event.
 *
 * Opt-in only: no-op exit 0 unless HOLP_REAL_CODEX_SMOKE=1. Consumes ChatGPT quota
 * (up to 3 real turns). Run: HOLP_REAL_CODEX_SMOKE=1 npm run smoke:codex
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  APPROVAL_PROMPT,
  createIsolatedEnv,
  type IsolatedEnv,
  PATCH_PROMPT,
  preflight,
  sleep,
  SMOKE_MARKER,
} from "./_codex-isolation.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverEntry = join(repoRoot, "daemon", "runtime", "server.ts");

/** Driver-side per-phase ceilings, shorter than the adapter's 10-min turn timeout. */
const APPROVAL_WAIT_MS = 90_000;
const TERMINAL_DEADLINE_MS = 180_000;

interface EventFrame {
  seq: number;
  category: string;
  name: string;
  run_id: string;
  payload: Record<string, unknown>;
}

/** Minimal NDJSON JSON-RPC pump over a spawned daemon's stdio. */
class Daemon {
  private readonly proc: ChildProcess;
  private idCounter = 0;
  private readonly waiters = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly events: EventFrame[] = [];
  readonly stderr: string[] = [];

  constructor(codexHome: string, workspace: string) {
    const env = { ...process.env, CODEX_HOME: codexHome };
    // Real registry: HOLP_REGISTRY must NOT be "fake". Delete it outright so an
    // ambient export in the caller's shell can't silently downgrade to the fake path.
    delete (env as Record<string, string | undefined>).HOLP_REGISTRY;

    this.proc = spawn("npx", ["tsx", serverEntry], {
      cwd: workspace, // -> becomes Codex cwd via process.cwd() in orchestrate_run.ts.
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group, so teardown can kill the whole tree.
    });

    const rl = createInterface({ input: this.proc.stdout!, terminal: false });
    rl.on("line", (line) => this.onLine(line));
    const errRl = createInterface({ input: this.proc.stderr!, terminal: false });
    errRl.on("line", (line) => this.stderr.push(line));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.method === "events.event") {
      const p = frame.params as Record<string, unknown>;
      this.events.push({
        seq: p.seq as number,
        category: p.category as string,
        name: p.name as string,
        run_id: p.run_id as string,
        payload: (p.payload ?? {}) as Record<string, unknown>,
      });
      return;
    }
    if (frame.id !== undefined) {
      const waiter = this.waiters.get(frame.id as number);
      if (!waiter) return;
      this.waiters.delete(frame.id as number);
      if (frame.error) waiter.reject(new Error(`RPC error: ${JSON.stringify(frame.error)}`));
      else waiter.resolve(frame.result);
    }
  }

  call(method: string, params: unknown): Promise<unknown> {
    const id = ++this.idCounter;
    return new Promise((resolveP, rejectP) => {
      this.waiters.set(id, { resolve: resolveP, reject: rejectP });
      this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** First event matching `pred`, or undefined if `deadlineMs` elapses. */
  async waitEventOrNull(pred: (e: EventFrame) => boolean, deadlineMs: number): Promise<EventFrame | undefined> {
    const stop = Date.now() + deadlineMs;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() > stop) return undefined;
      await sleep(150);
    }
  }

  /** Crash-safe teardown: graceful stdin close -> SIGTERM group -> SIGKILL group. */
  async shutdown(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    try {
      this.proc.stdin?.end();
    } catch {
      /* ignore */
    }
    if (await this.waitExit(3_000)) return;
    this.killGroup("SIGTERM");
    if (await this.waitExit(2_000)) return;
    this.killGroup("SIGKILL");
    await this.waitExit(1_000);
  }

  private waitExit(ms: number): Promise<boolean> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolveP) => {
      const timer = setTimeout(() => resolveP(false), ms);
      this.proc.once("exit", () => {
        clearTimeout(timer);
        resolveP(true);
      });
    });
  }

  private killGroup(signal: NodeJS.Signals): void {
    if (this.proc.pid === undefined) return;
    try {
      process.kill(-this.proc.pid, signal); // negative pid = process group
    } catch {
      try {
        this.proc.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
}

type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";
interface ScenarioResult {
  name: string;
  verdict: Verdict;
  detail: string;
}

/** Shared setup: spawn daemon, initialize, declare mcp-codex coder (ready), subscribe, run. */
async function startRun(
  daemon: Daemon,
  goal: string,
): Promise<{ runId: string }> {
  await daemon.call("initialize", {
    protocol_version: "0.1.4",
    client: { name: "holp-codex-smoke", version: "0.1.0" },
    capabilities: { approval: { supported: true, kinds: ["merge_approval"] } },
  });

  const declared = (await daemon.call("flock.declare", {
    agents: [{ id: "coder", transport: "mcp-codex", roles: ["coder"] }],
  })) as { agents: Array<{ status: string; resolved_roles?: string[]; reason?: string }> };
  const agent = declared.agents[0];
  console.log(`  flock.declare: status=${agent.status} roles=${JSON.stringify(agent.resolved_roles)}`);
  if (agent.status !== "ready" || !agent.resolved_roles?.includes("coder")) {
    throw new Error(
      `mcp-codex not ready under temp CODEX_HOME (status=${agent.status}, reason=${agent.reason ?? "n/a"}). ` +
        "Auth/probe failed — verify `CODEX_HOME=<temp> codex doctor` reports 'auth is configured'.",
    );
  }

  const run = (await daemon.call("orchestrate.run", {
    goal,
    roles: { coder: { agent: "coder" } },
  })) as { run_id: string; accepted: boolean };
  console.log(`  orchestrate.run: run_id=${run.run_id} accepted=${run.accepted}`);
  await daemon.call("events.subscribe", { run_id: run.run_id, after_seq: 0 });
  return { runId: run.run_id };
}

const isTerminal = (runId: string) => (e: EventFrame): boolean =>
  e.run_id === runId &&
  (e.name === "run_merged" || e.name === "run_blocked" || e.name === "run_gave_up");

/** Scenario 1: file edit -> run_merged + file changed (no approval expected). */
async function runPatchScenario(): Promise<ScenarioResult> {
  const name = "patch: edit -> run_merged + file changed";
  const env: IsolatedEnv = createIsolatedEnv();
  const daemon = new Daemon(env.codexHome, env.workspace);
  console.log(`\n--- scenario: ${name} ---`);
  console.log(`  CODEX_HOME=${env.codexHome}\n  workspace =${env.workspace}`);

  try {
    const { runId } = await startRun(daemon, PATCH_PROMPT);
    const terminal = await daemon.waitEventOrNull(isTerminal(runId), TERMINAL_DEADLINE_MS);
    if (!terminal) return { name, verdict: "FAIL", detail: "no terminal event before deadline" };
    console.log(`  terminal: ${terminal.name} ${JSON.stringify(terminal.payload).slice(0, 140)}`);

    const merged = terminal.name === "run_merged";
    const changed = env.smokeFileChanged();
    const artifactId = terminal.payload.artifact_id as string | undefined;
    if (merged && artifactId) {
      const art = (await daemon.call("artifact.get", { artifact_id: artifactId })) as { content: string };
      console.log(`  artifact.get: ${artifactId} (${art.content.length} bytes)`);
    }
    return {
      name,
      verdict: merged && changed ? "PASS" : "FAIL",
      detail: `run_merged=${merged}, contains ${SMOKE_MARKER}=${changed}, artifact=${artifactId ?? "none"}`,
    };
  } catch (err) {
    return { name, verdict: "FAIL", detail: errDetail(err, daemon) };
  } finally {
    await daemon.shutdown();
    env.cleanup();
  }
}

/** Scenario 2: network command -> real approval; approve->run_merged, reject->run_blocked. */
async function runApprovalScenario(decision: "approved" | "rejected"): Promise<ScenarioResult> {
  const name = `approval: ${decision} -> ${decision === "approved" ? "run_merged" : "run_blocked"}`;
  const env: IsolatedEnv = createIsolatedEnv();
  const daemon = new Daemon(env.codexHome, env.workspace);
  console.log(`\n--- scenario: ${name} ---`);
  console.log(`  CODEX_HOME=${env.codexHome}\n  workspace =${env.workspace}`);

  try {
    const { runId } = await startRun(daemon, APPROVAL_PROMPT);

    // Race the approval request against the terminal event: the LLM may finish the turn
    // (e.g. decide not to run the command) without ever asking for approval.
    const approval = await Promise.race([
      daemon.waitEventOrNull(
        (e) => e.name === "approval_requested" && e.run_id === runId,
        APPROVAL_WAIT_MS,
      ),
      daemon.waitEventOrNull(isTerminal(runId), APPROVAL_WAIT_MS),
    ]);

    if (!approval || approval.name !== "approval_requested") {
      // No approval was requested — the real-approval trigger is LLM-dependent.
      const terminal = await daemon.waitEventOrNull(isTerminal(runId), TERMINAL_DEADLINE_MS);
      return {
        name,
        verdict: "INCONCLUSIVE",
        detail: `provider did not request approval this run (terminal=${terminal?.name ?? "none"}); real-approval trigger is non-deterministic`,
      };
    }

    const approvalId = approval.payload.approval_id as string;
    console.log(`  approval_requested: ${approvalId} -> ${decision}`);
    await daemon.call("approval.resolve", { approval_id: approvalId, decision, by: "user:smoke" });

    const terminal = await daemon.waitEventOrNull(isTerminal(runId), TERMINAL_DEADLINE_MS);
    if (!terminal) return { name, verdict: "FAIL", detail: "no terminal event after approval.resolve" };
    console.log(`  terminal: ${terminal.name} ${JSON.stringify(terminal.payload).slice(0, 140)}`);

    const expected = decision === "approved" ? "run_merged" : "run_blocked";
    return {
      name,
      verdict: terminal.name === expected ? "PASS" : "FAIL",
      detail: `expected ${expected}, got ${terminal.name}`,
    };
  } catch (err) {
    return { name, verdict: "FAIL", detail: errDetail(err, daemon) };
  } finally {
    await daemon.shutdown();
    env.cleanup();
  }
}

function errDetail(err: unknown, daemon: Daemon): string {
  const tail = daemon.stderr.slice(-5).join(" | ");
  return `error: ${err instanceof Error ? err.message : String(err)}${tail ? ` | stderr: ${tail}` : ""}`;
}

async function main(): Promise<void> {
  const gate = preflight();
  if (!gate.ok) {
    console.log(`[smoke:codex] ${gate.reason}`);
    process.exit(0);
  }

  console.log("=== HOLP end-to-end Codex smoke (patch + approval) ===");
  const results: ScenarioResult[] = [];
  results.push(await runPatchScenario());
  results.push(await runApprovalScenario("approved"));
  results.push(await runApprovalScenario("rejected"));

  console.log("\n=== Results ===");
  let anyFail = false;
  for (const r of results) {
    console.log(`  ${r.verdict.padEnd(12)} ${r.name} — ${r.detail}`);
    if (r.verdict === "FAIL") anyFail = true;
  }
  // INCONCLUSIVE approval runs do not fail the smoke (the trigger is provider-dependent),
  // but a FAIL (wrong terminal event, probe failure, etc.) does.
  console.log(`\n=== Result: ${anyFail ? "FAIL" : "PASS"} ===`);
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke:codex fatal:", err);
  process.exit(1);
});
