#!/usr/bin/env tsx
/**
 * HOLP M5 multi-agent consensus demo over the real stdio daemon.
 *
 * Scenarios:
 *   1. artifact_refs:true  -> consensus review findings are artifact envelopes.
 *   2. artifact_refs:false -> consensus review findings fall back inline.
 *
 * Both scenarios drive:
 *   initialize -> flock.declare -> orchestrate.run -> events.subscribe ->
 *   approval.resolve -> consensus_verdict -> artifact.get -> run_merged.
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const serverEntry = path.join(repoRoot, "daemon", "runtime", "server.ts");

let reqIdCounter = 0;
function nextId(): number {
  reqIdCounter += 1;
  return reqIdCounter;
}

interface EventFrame {
  seq: number;
  category: string;
  name: string;
  run_id: string;
  payload: unknown;
}

class DaemonPump {
  private responseWaiters = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private eventListeners: Array<(ev: EventFrame) => void> = [];

  constructor(proc: ChildProcess) {
    const rl = createInterface({ input: proc.stdout!, terminal: false });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      const f = frame as Record<string, unknown>;
      if (f.method === "events.event") {
        const params = f.params as Record<string, unknown>;
        const ev: EventFrame = {
          seq: params.seq as number,
          category: params.category as string,
          name: params.name as string,
          run_id: params.run_id as string,
          payload: params.payload,
        };
        for (const listener of this.eventListeners) listener(ev);
        return;
      }
      if (f.id !== undefined) {
        const waiter = this.responseWaiters.get(f.id as number);
        if (!waiter) return;
        this.responseWaiters.delete(f.id as number);
        if (f.error) {
          waiter.reject(new Error(`RPC error: ${JSON.stringify(f.error)}`));
        } else {
          waiter.resolve(f.result);
        }
      }
    });
    rl.on("close", () => {
      for (const [, waiter] of this.responseWaiters) {
        waiter.reject(new Error("Daemon stdout closed before response"));
      }
      this.responseWaiters.clear();
    });
  }

  waitResponse(id: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.responseWaiters.set(id, { resolve, reject });
    });
  }

  onEvent(fn: (ev: EventFrame) => void): () => void {
    this.eventListeners.push(fn);
    return () => {
      this.eventListeners = this.eventListeners.filter((listener) => listener !== fn);
    };
  }

  waitEvent(predicate: (ev: EventFrame) => boolean): Promise<EventFrame> {
    return new Promise((resolve) => {
      const off = this.onEvent((ev) => {
        if (predicate(ev)) {
          off();
          resolve(ev);
        }
      });
    });
  }
}

function send(proc: ChildProcess, method: string, params: unknown): number {
  const id = nextId();
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return id;
}

async function call<T>(proc: ChildProcess, pump: DaemonPump, method: string, params: unknown): Promise<T> {
  const id = send(proc, method, params);
  return withTimeout(pump.waitResponse(id), `response:${method}`) as Promise<T>;
}

async function withTimeout<T>(promise: Promise<T>, label: string, ms = 15000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function eventPreview(ev: EventFrame): string {
  const payload = JSON.stringify(ev.payload);
  return payload.length > 140 ? `${payload.slice(0, 137)}...` : payload;
}

async function runScenario(name: string, artifactRefs: boolean): Promise<boolean> {
  const proc = spawn("tsx", [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
    cwd: repoRoot,
    detached: true,
    env: { ...process.env, HOLP_REGISTRY: "fake" },
  });
  proc.on("error", (err) => {
    console.error(`failed to spawn daemon: ${err.message}`);
    process.exit(1);
  });
  const pump = new DaemonPump(proc);
  const events: EventFrame[] = [];
  pump.onEvent((ev) => {
    events.push(ev);
    console.log(`  [event] seq=${ev.seq} [${ev.category}] ${ev.name} ${eventPreview(ev)}`);
  });

  try {
    console.log(`\n=== ${name} (artifact_refs:${String(artifactRefs)}) ===`);
    const initialized = await withTimeout(call<{
      protocol_version: string;
      capabilities: Record<string, { supported: boolean } | undefined>;
    }>(
      proc,
      pump,
      "initialize",
      {
        protocol_version: "0.1.4",
        client: { name: "holp-m5-demo", version: "0.1.0" },
        capabilities: {
          approval: { supported: true, kinds: ["merge_approval"] },
          consensus: { supported: true },
          ...(artifactRefs ? { artifact_refs: { supported: true } } : {}),
        },
      },
    ), "response:initialize", 15000);
    console.log(`  initialized protocol=${initialized.protocol_version}`);
    console.log(`  negotiated artifact_refs=${initialized.capabilities.artifact_refs?.supported ?? false}`);

    const declared = await call<{
      agents: Array<{ id: string; status: string; runtime_surfaces: Array<Record<string, unknown>> }>;
    }>(proc, pump, "flock.declare", {
      agents: [
        { id: "producer", transport: "fake", roles: ["coder", "reviewer"] },
        { id: "r1", transport: "fake", roles: ["reviewer"] },
        { id: "r2", transport: "fake", roles: ["reviewer"] },
      ],
    });
    verifyFakeRegistryDeclarations(declared.agents);
    printRuntimeDeclarations(declared.agents);

    const run = await call<{ run_id: string; accepted: boolean }>(proc, pump, "orchestrate.run", {
      goal: `M5 deterministic consensus demo (${name})`,
      roles: {
        coder: { agent: "producer" },
        reviewer: { panel: ["producer", "r1", "r2"], quorum: 2 },
      },
    });
    console.log(`  run accepted=${run.accepted} run_id=${run.run_id}`);

    await call(proc, pump, "events.subscribe", { run_id: run.run_id, after_seq: 0 });
    const approval =
      events.find((ev) => ev.name === "approval_requested") ??
      await withTimeout(pump.waitEvent((ev) => ev.name === "approval_requested"), "approval_requested");
    const approvalId = (approval.payload as Record<string, unknown>).approval_id as string;
    await call(proc, pump, "approval.resolve", {
      approval_id: approvalId,
      decision: "approved",
      by: "user:demo",
    });

    const verdict =
      events.find((ev) => ev.name === "consensus_verdict") ??
      await withTimeout(pump.waitEvent((ev) => ev.name === "consensus_verdict"), "consensus_verdict");
    const verdictPayload = verdict.payload as Record<string, unknown>;
    console.log(`  consensus outcome=${verdictPayload.outcome}`);
    console.log(`  quorum=${JSON.stringify(verdictPayload.quorum)}`);
    console.log(`  excluded=${JSON.stringify(verdictPayload.excluded)}`);

    const reviews = verdictPayload.reviews as Array<Record<string, unknown>>;
    for (const review of reviews) {
      const findings = review.findings as Record<string, unknown>;
      if (artifactRefs) {
        console.log(`  review ${review.agent}: findings artifact=${findings.artifact_id}`);
        const artifact = await call<{ content: string; truncated: boolean }>(proc, pump, "artifact.get", {
          artifact_id: findings.artifact_id,
        });
        console.log(`    artifact.get truncated=${artifact.truncated} content=${artifact.content}`);
      } else {
        console.log(`  review ${review.agent}: inline findings=${findings.content}`);
      }
    }

    const merged =
      events.find((ev) => ev.name === "run_merged") ??
      await withTimeout(pump.waitEvent((ev) => ev.name === "run_merged"), "run_merged");
    const artifactId = (merged.payload as Record<string, unknown>).artifact_id as string;
    const diff = await call<{ content: string; truncated: boolean }>(proc, pump, "artifact.get", {
      artifact_id: artifactId,
    });
    console.log(`  run_merged artifact=${artifactId} diff_truncated=${diff.truncated}`);

    const pass = verifyScenario(events, artifactRefs);
    console.log(`  result=${pass ? "PASS" : "FAIL"}`);
    return pass;
  } finally {
    await stopDaemon(proc);
  }
}

async function stopDaemon(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  sendSignal(proc, "SIGTERM");
  const exited = new Promise<"exited">((resolve) => {
    proc.once("exit", () => resolve("exited"));
  });
  const first = await Promise.race([exited, sleep(750).then(() => "timeout" as const)]);
  if (first === "exited") return;

  sendSignal(proc, "SIGKILL");
  await Promise.race([exited, sleep(750)]);
}

function sendSignal(proc: ChildProcess, signal: NodeJS.Signals): void {
  const target = proc.pid ? -proc.pid : undefined;
  try {
    if (target !== undefined) {
      process.kill(target, signal);
    } else {
      proc.kill(signal);
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ESRCH") return;
    try {
      proc.kill(signal);
    } catch {
      // Ignore cleanup races: the demo process is already exiting.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function verifyFakeRegistryDeclarations(
  agents: Array<{ id: string; status: string; runtime_surfaces: Array<Record<string, unknown>> }>,
): void {
  for (const agent of agents) {
    const headless = agent.runtime_surfaces.find((surface) => surface.runtime_surface === "headless");
    const acp = agent.runtime_surfaces.find((surface) => surface.runtime_surface === "acp");
    const direct = agent.runtime_surfaces.find((surface) => surface.runtime_surface === "direct_user_session");
    if (
      agent.status !== "ready" ||
      headless?.runtime_kind !== "fake" ||
      headless?.surface_support !== "supported" ||
      acp?.surface_support !== "unsupported" ||
      direct?.surface_support !== "unknown"
    ) {
      throw new Error(`fake registry declaration check failed for ${agent.id}`);
    }
  }
}

function verifyScenario(events: readonly EventFrame[], artifactRefs: boolean): boolean {
  const verdict = events.find((ev) => ev.name === "consensus_verdict");
  const merged = events.find((ev) => ev.name === "run_merged");
  if (!verdict || verdict.category !== "consensus" || !merged) return false;
  const payload = verdict.payload as Record<string, unknown>;
  const quorum = payload.quorum as Record<string, unknown>;
  const excluded = payload.excluded as Array<Record<string, unknown>>;
  const reviews = payload.reviews as Array<Record<string, unknown>>;
  const findingsShapeOk = reviews.every((review) => {
    const findings = review.findings as Record<string, unknown>;
    return artifactRefs
      ? typeof findings.artifact_id === "string" && findings.inline === undefined
      : findings.inline === true && findings.artifact_id === undefined;
  });
  return payload.outcome === "approve" &&
    quorum.required === 2 &&
    quorum.eligible === 2 &&
    quorum.met === true &&
    excluded.some((entry) => entry.agent === "producer") &&
    reviews.map((review) => review.agent).join(",") === "r1,r2" &&
    findingsShapeOk;
}

function printRuntimeDeclarations(
  agents: Array<{ id: string; status: string; runtime_surfaces: Array<Record<string, unknown>> }>,
): void {
  for (const agent of agents) {
    console.log(`  declared ${agent.id} status=${agent.status}`);
    const headless = agent.runtime_surfaces.find((surface) => surface.runtime_surface === "headless");
    const acp = agent.runtime_surfaces.find((surface) => surface.runtime_surface === "acp");
    const direct = agent.runtime_surfaces.find((surface) => surface.runtime_surface === "direct_user_session");
    const headlessProfiles = headless?.isolation_profiles as Record<string, { readiness?: string }> | undefined;
    if (agent.id === "r1" || agent.id === "r2") {
      console.log(
        `    selected reviewer runtime surface=${headless?.runtime_surface}` +
          ` kind=${headless?.runtime_kind} isolation_profile=read_only_review` +
          ` readiness=${headlessProfiles?.read_only_review?.readiness}`,
      );
    }
    console.log(
      `    runtime declaration headless=${headless?.surface_support}` +
        ` acp=${acp?.surface_support}` +
        ` direct_user_session=${direct?.surface_support}`,
    );
  }
}

async function main(): Promise<void> {
  console.log("\n=== HOLP M5 Deterministic Unanimous-Approve Consensus Demo ===");
  const artifactRefsPass = await runScenario("scenario 1: findings artifacts", true);
  const inlinePass = await runScenario("scenario 2: inline fallback", false);
  const allOk = artifactRefsPass && inlinePass;
  console.log(`\n=== M5 demo result: ${allOk ? "PASS" : "FAIL"} ===\n`);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("M5 demo error:", err);
  process.exit(1);
});
