/**
 * M1b smoke test: in-process closed-loop protocol run.
 *
 * Honesty contract:
 *   - This test goes through the REAL dispatcher and handler chain, not
 *     bypassing any protocol path. The fake backend replaces the provider;
 *     everything else is the real M1b implementation.
 *   - The approval bridge IS a real state transition: approval.resolve resolves
 *     the pending Promise the fake backend is awaiting (genuine block).
 *   - All 7 event field checks per spec §5 are asserted on real events.
 *   - seq starts at 1 (asserted explicitly).
 *
 * The test drives: initialize → flock.declare → orchestrate.run →
 *   events.subscribe (replay) → approval.resolve → artifact.get.
 *
 * It uses FakeClock for determinism (no Date.now() coupling).
 */

import { describe, it, expect } from "vitest";
import { buildDispatcher } from "../runtime/server.js";
import { ConnectionContext } from "../core/context.js";
import { EventSink } from "../core/eventSink.js";
import { FakeClock } from "../core/clock.js";
import { createFakeRegistry } from "../../adapters/registry.js";
import type { EventNotificationParams } from "../core/eventSink.js";

/** Collect emitted event notification frames synchronously during the test. */
function makeCollectingSink(): { sink: EventSink; events: EventNotificationParams[] } {
  const events: EventNotificationParams[] = [];
  // We construct an EventSink with a writer that captures event frames.
  const sink = new EventSink((frame) => {
    // FrameWriter receives the full JsonRpcNotification.
    // We extract params from events.event notifications only.
    const f = frame as { method?: string; params?: unknown };
    if (f.method === "events.event" && f.params) {
      events.push(f.params as EventNotificationParams);
    }
  });
  return { sink, events };
}

describe("M1b closed-loop protocol smoke test", () => {
  it("drives initialize → flock.declare → orchestrate.run → events.subscribe → approval.resolve → artifact.get with all required events", async () => {
    const clock = new FakeClock(1718600000);
    const registry = createFakeRegistry();
    const ctx = new ConnectionContext();
    const { sink, events } = makeCollectingSink();
    const dispatcher = buildDispatcher(ctx, sink, registry, clock);

    // Helper: unwrap dispatcher response (which wraps result in JsonRpcResponse).
    function result<T>(res: unknown): T {
      return (res as { result: T }).result;
    }

    // 1. initialize
    const initResult = result<{ server: { name: string }; protocol_version: string }>(
      await dispatcher.dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocol_version: "0.1.4",
          client: { name: "test", version: "0.0.1" },
          capabilities: { approval: { supported: true, kinds: ["merge_approval"] } },
        },
      }),
    );
    expect(initResult.server.name).toBe("holp-reference-daemon");
    expect(initResult.protocol_version).toBe("0.1.4");

    // 2. flock.declare — declare one fake agent
    const flockResult = result<{ agents: Array<Record<string, unknown>> }>(
      await dispatcher.dispatch({
        jsonrpc: "2.0",
        id: 2,
        method: "flock.declare",
        params: {
          agents: [
            { id: "agent-1", transport: "fake", roles: ["coder", "reviewer"] },
          ],
        },
      }),
    );
    const declared = flockResult.agents[0];
    expect(declared.status).toBe("ready");
    expect(declared.id).toBe("agent-1");

    // 3. orchestrate.run — kicks off async run; returns immediately
    const runResult = result<{ run_id: string; accepted: boolean }>(
      await dispatcher.dispatch({
        jsonrpc: "2.0",
        id: 3,
        method: "orchestrate.run",
        params: {
          goal: "Fix the flaky test",
          roles: { coder: { agent: "agent-1" } },
        },
      }),
    );
    expect(runResult.accepted).toBe(true);
    const runId = runResult.run_id;
    expect(typeof runId).toBe("string");

    // 4. events.subscribe — subscribe to all events; replay any already emitted
    const subResult = result<{ subscription_id: string; latest_seq: number }>(
      await dispatcher.dispatch({
        jsonrpc: "2.0",
        id: 4,
        method: "events.subscribe",
        params: { run_id: runId, after_seq: 0 },
      }),
    );
    expect(typeof subResult.subscription_id).toBe("string");
    const subscriptionId = subResult.subscription_id;

    // The run is async — we need to let it advance to the approval pause.
    // Yield until the approval appears (poll for up to 200 ticks).
    let approval_id: string | undefined;
    for (let i = 0; i < 200; i++) {
      await Promise.resolve();
      // Check if approval_requested event arrived.
      const approvalEvent = events.find((e) => e.name === "approval_requested");
      if (approvalEvent) {
        approval_id = (approvalEvent.payload as Record<string, unknown>)
          .approval_id as string;
        break;
      }
    }
    expect(approval_id).toBeDefined();
    expect(approval_id).toContain("_1718600000_");

    // 5. approval.resolve — resolve the pending approval
    const resolveResult = result<{ approval_id: string; accepted: boolean }>(
      await dispatcher.dispatch({
        jsonrpc: "2.0",
        id: 5,
        method: "approval.resolve",
        params: { approval_id, decision: "approved", by: "user:tester" },
      }),
    );
    expect(resolveResult.accepted).toBe(true);

    // Wait for the run to complete (poll for run_merged event).
    for (let i = 0; i < 500; i++) {
      await Promise.resolve();
      const merged = events.find((e) => e.name === "run_merged");
      if (merged) break;
    }

    // 6. artifact.get — fetch the diff artifact
    const mergedEvent = events.find((e) => e.name === "run_merged");
    expect(mergedEvent).toBeDefined();
    const artifactId = (mergedEvent!.payload as Record<string, unknown>).artifact_id as string;
    expect(typeof artifactId).toBe("string");

    const artResult = result<Record<string, unknown>>(
      await dispatcher.dispatch({
        jsonrpc: "2.0",
        id: 6,
        method: "artifact.get",
        params: { artifact_id: artifactId },
      }),
    );
    expect(artResult.truncated).toBe(false);
    expect(typeof artResult.content).toBe("string");
    expect((artResult.content as string).length).toBeGreaterThan(0);

    // === Assertions on required event kinds ===
    const eventNames = events.map((e) => e.name);

    // run-lifecycle: run_started, run_merged
    expect(eventNames).toContain("run_started");
    expect(eventNames).toContain("run_merged");

    // agent event: at least one tool_called
    expect(eventNames).toContain("tool_called");

    // approval events: approval_requested, approval_resolved
    expect(eventNames).toContain("approval_requested");
    expect(eventNames).toContain("approval_resolved");

    // === Assert 7-field event shape (spec §5) ===
    for (const ev of events) {
      expect(typeof ev.subscription_id).toBe("string");
      expect(ev.subscription_id).toBe(subscriptionId);
      expect(typeof ev.seq).toBe("number");
      expect(typeof ev.ts).toBe("number");
      expect(typeof ev.category).toBe("string");
      expect(typeof ev.name).toBe("string");
      expect(ev.run_id).toBe(runId);
      // payload is allowed to be any object (incl. null for some events)
      expect(ev).toHaveProperty("payload");
    }

    // === Assert seq starts at 1 and is monotonic ===
    const seqs = events.map((e) => e.seq);
    // Filter to only this run's events and verify monotonic sequence.
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted); // monotonic order
    expect(seqs[0]).toBe(1); // first event seq = 1
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1); // contiguous
    }

    // === Replay guarantee: subscribing with after_seq=0 got all events from start ===
    // The subscription was set up after orchestrate.run — run_started (seq=1) must
    // be in the replay because after_seq=0 means replay everything.
    const runStartedEvent = events.find((e) => e.name === "run_started");
    expect(runStartedEvent).toBeDefined();
    expect(runStartedEvent!.seq).toBe(1);
  });
});
