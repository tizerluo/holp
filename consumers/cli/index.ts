#!/usr/bin/env tsx
/**
 * HOLP M1b CLI demo — exercises the full M1b protocol loop over real stdio.
 *
 * Sequence:
 *   initialize → flock.declare → orchestrate.run → events.subscribe →
 *   approval.resolve (after approval_requested event) → artifact.get
 *
 * Observed events (must see all 5 kinds):
 *   1. run_started       (run-lifecycle)
 *   2. tool_called       (agent event)
 *   3. approval_requested (approval)
 *   4. approval_resolved  (approval)
 *   5. run_merged         (run-lifecycle)
 *
 * The daemon is spawned as a child process over stdio (JSON-RPC over NDJSON).
 * No test theater: approval_resolved arrives only after a real pending Promise
 * is resolved by sending approval.resolve on the wire.
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const serverEntry = path.join(repoRoot, "daemon", "runtime", "server.ts");

/** Serial request id counter. */
let reqIdCounter = 0;
function nextId(): number {
  return ++reqIdCounter;
}

/** Event notification shape from events.event. */
interface EventFrame {
  seq: number;
  category: string;
  name: string;
  run_id: string;
  payload: unknown;
}

/**
 * A simple message pump that reads all daemon output and routes to:
 *   - pending RPC response waiters (by id)
 *   - event listeners
 */
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

      // events.event notification
      if (f.method === "events.event") {
        const params = f.params as Record<string, unknown>;
        const ev: EventFrame = {
          seq: params.seq as number,
          category: params.category as string,
          name: params.name as string,
          run_id: params.run_id as string,
          payload: params.payload,
        };
        for (const listener of this.eventListeners) {
          listener(ev);
        }
        return;
      }

      // RPC response
      if (f.id !== undefined) {
        const id = f.id as number;
        const waiter = this.responseWaiters.get(id);
        if (waiter) {
          this.responseWaiters.delete(id);
          if (f.error) {
            waiter.reject(new Error(`RPC error: ${JSON.stringify(f.error)}`));
          } else {
            waiter.resolve(f.result);
          }
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

  /** Wait for a response with the given request id. */
  waitResponse(id: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.responseWaiters.set(id, { resolve, reject });
    });
  }

  /** Register an event listener. */
  onEvent(fn: (ev: EventFrame) => void): () => void {
    this.eventListeners.push(fn);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== fn);
    };
  }

  /** Wait for the first event matching the predicate. */
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

/** Send one JSON-RPC request to the daemon over stdin. Returns the request id. */
function send(proc: ChildProcess, method: string, params: unknown): number {
  const id = nextId();
  const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  proc.stdin!.write(frame);
  return id;
}

async function main(): Promise<void> {
  const proc = spawn("tsx", [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
    cwd: repoRoot,
    env: { ...process.env, HOLP_REGISTRY: "fake" },
  });

  proc.on("error", (err) => {
    console.error("Failed to spawn daemon:", err.message);
    process.exit(1);
  });

  const pump = new DaemonPump(proc);

  // Collect all events for summary/assertions.
  const collectedEvents: EventFrame[] = [];
  pump.onEvent((ev) => {
    collectedEvents.push(ev);
    console.log(
      `  [event] seq=${ev.seq} [${ev.category}] ${ev.name}`,
      JSON.stringify(ev.payload).slice(0, 120),
    );
  });

  console.log("\n=== HOLP M1b CLI demo ===\n");

  // 1. initialize
  console.log("[1] initialize");
  {
    const id = send(proc, "initialize", {
      protocol_version: "0.1.4",
      client: { name: "holp-cli-demo", version: "0.1.0" },
      capabilities: { approval: { supported: true, kinds: ["merge_approval"] } },
    });
    const result = await pump.waitResponse(id) as { server: { name: string }; protocol_version: string };
    console.log(`    OK: server=${JSON.stringify(result.server?.name)} protocol=${result.protocol_version}`);
  }

  // 2. flock.declare
  console.log("[2] flock.declare (fake agent)");
  {
    const id = send(proc, "flock.declare", {
      agents: [{ id: "fake-agent-1", transport: "fake", roles: ["coder"] }],
    });
    const result = await pump.waitResponse(id) as {
      agents: Array<{ id: string; status: string }>;
    };
    const agentStatus = result.agents[0].status;
    console.log(`    OK: agent status=${agentStatus}`);
    if (agentStatus !== "ready") {
      console.error("ERROR: expected agent status=ready");
      proc.kill();
      process.exit(1);
    }
  }

  // 3. orchestrate.run
  console.log("[3] orchestrate.run");
  let runId: string;
  {
    const id = send(proc, "orchestrate.run", {
      goal: "Fix the flaky test",
      roles: { coder: { agent: "fake-agent-1" } },
    });
    const result = await pump.waitResponse(id) as { run_id: string; accepted: boolean };
    runId = result.run_id;
    console.log(`    OK: run_id=${runId} accepted=${result.accepted}`);
  }

  // 4. events.subscribe (replay from seq=0)
  console.log("[4] events.subscribe");
  {
    const id = send(proc, "events.subscribe", { run_id: runId, after_seq: 0 });
    const result = await pump.waitResponse(id) as {
      subscription_id: string;
      latest_seq: number;
    };
    console.log(
      `    OK: subscription_id=${result.subscription_id} latest_seq=${result.latest_seq}`,
    );
  }

  // Wait for approval_requested event (the fake backend pauses here).
  // It may have already been replayed before we registered the listener,
  // so check collectedEvents first.
  console.log("[5] waiting for approval_requested event...");
  const alreadyApproval = collectedEvents.find((ev) => ev.name === "approval_requested");
  const approvalEvent = alreadyApproval ?? await pump.waitEvent((ev) => ev.name === "approval_requested");
  const approvalId = (approvalEvent.payload as Record<string, unknown>).approval_id as string;
  console.log(`    approval_id=${approvalId}`);

  // 5. approval.resolve
  console.log("[5] approval.resolve (decision=approved)");
  {
    const id = send(proc, "approval.resolve", {
      approval_id: approvalId,
      decision: "approved",
      by: "user:demo",
    });
    const result = await pump.waitResponse(id) as { approval_id: string; accepted: boolean };
    console.log(`    OK: approval_id=${result.approval_id} accepted=${result.accepted}`);
  }

  // Wait for run_merged event (may already be in collectedEvents).
  console.log("[6] waiting for run_merged event...");
  const alreadyMerged = collectedEvents.find((ev) => ev.name === "run_merged");
  const mergedEvent = alreadyMerged ?? await pump.waitEvent((ev) => ev.name === "run_merged");
  const artifactId = (mergedEvent.payload as Record<string, unknown>).artifact_id as string;
  console.log(`    run_merged: artifact_id=${artifactId}`);

  // 6. artifact.get
  console.log("[6] artifact.get");
  {
    const id = send(proc, "artifact.get", { artifact_id: artifactId });
    const result = await pump.waitResponse(id) as {
      artifact_id: string;
      content: string;
      truncated: boolean;
    };
    console.log(`    OK: artifact_id=${result.artifact_id} truncated=${result.truncated}`);
    console.log(`    content preview: ${result.content.split("\n")[0]}`);
  }

  // === Print summary ===
  console.log("\n=== Event summary ===");
  for (const ev of collectedEvents) {
    console.log(`  seq=${ev.seq} [${ev.category}] ${ev.name}`);
  }

  // === Verify required event kinds ===
  const eventNames = collectedEvents.map((e) => e.name);
  const required = [
    "run_started",        // run-lifecycle
    "tool_called",        // agent event
    "approval_requested", // approval
    "approval_resolved",  // approval
    "run_merged",         // run-lifecycle
  ];

  console.log("\n=== Required event check ===");
  let allOk = true;
  for (const name of required) {
    const ok = eventNames.includes(name);
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}`);
    if (!ok) allOk = false;
  }

  // Verify seq starts at 1 and is contiguous.
  const seqs = collectedEvents.map((e) => e.seq).sort((a, b) => a - b);
  const seqOk =
    seqs.length > 0 &&
    seqs[0] === 1 &&
    seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1);
  console.log(
    `\n  ${seqOk ? "PASS" : "FAIL"} seq starts at 1, contiguous (first=${seqs[0]}, last=${seqs[seqs.length - 1]})`,
  );
  if (!seqOk) allOk = false;

  console.log(`\n=== Result: ${allOk ? "PASS — all checks OK" : "FAIL — see above"} ===\n`);

  proc.kill();
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("CLI demo error:", err);
  process.exit(1);
});
