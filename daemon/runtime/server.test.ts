import { describe, it, expect } from "vitest";
import { NdjsonReader, createWriter } from "./ndjson.js";
import { buildDispatcher, makeFrameLoop } from "./server.js";
import { ConnectionContext } from "../core/context.js";

/**
 * These tests pin the stdin-"end" drain invariant from server.ts main():
 *
 *   reader.flush();
 *   void chain.finally(() => process.exit(0));
 *
 * i.e. on stdin close, every queued dispatch response MUST be written before the
 * process exits, in arrival order. The original code did `flush(); exit(0)`
 * immediately, which would drop the last response once async handlers land.
 *
 * We reconstruct main()'s exact wiring (NdjsonReader → serial chain → writer)
 * around an *async* dispatcher so the latent bug is observable, then assert the
 * drain pattern flushes everything before the exit sentinel runs.
 */
describe("server stdin-end drain invariant", () => {
  // Reconstruct the per-connection wiring from main(), but with an injectable
  // dispatch fn so we can make handlers genuinely async (the future-state that
  // the drain fix protects against).
  function wireConnection(dispatch: (frame: unknown) => Promise<unknown>) {
    const out: unknown[] = [];
    const write = createWriter((line) => out.push(line));

    let chain = Promise.resolve();
    const reader = new NdjsonReader((frame) => {
      chain = chain
        .then(() => dispatch(frame))
        .then((response) => {
          if (response !== undefined) write(response);
        })
        .catch(() => {
          /* mirror main(): errors are logged, chain survives */
        });
    });

    return {
      out,
      push: (chunk: string) => reader.push(chunk),
      // Mirror the fixed stdin "end" handler: flush (sync-enqueues trailing
      // frame) then await the chain to drain before running onExit.
      end: (onExit: () => void) => {
        reader.flush();
        return chain.finally(onExit);
      },
      // Snapshot of the chain for callers that need to await independently.
      chain: () => chain,
    };
  }

  it("writes ALL queued responses, in order, BEFORE the exit sentinel runs", async () => {
    const events: string[] = [];

    // A slow frame followed by a fast frame. Without draining, the exit sentinel
    // would run before either response is written.
    const conn = wireConnection(async (frame) => {
      const f = frame as { id: number };
      if (f.id === 1) {
        await new Promise((r) => setTimeout(r, 20)); // slow handler
        return { id: 1, result: "slow" };
      }
      return { id: 2, result: "fast" }; // resolves quickly, but is serialized
    });

    conn.push('{"id":1}\n{"id":2}\n');

    // At this instant nothing has been written yet (handler 1 is still awaiting).
    expect(conn.out).toEqual([]);

    await conn.end(() => events.push("exit"));

    // Both responses written, in arrival order, and the exit sentinel ran LAST.
    expect(conn.out).toEqual([
      '{"id":1,"result":"slow"}\n',
      '{"id":2,"result":"fast"}\n',
    ]);
    expect(events).toEqual(["exit"]);
  });

  it("drains a trailing unterminated frame enqueued by flush() before exit", async () => {
    const events: string[] = [];
    const conn = wireConnection(async (frame) => {
      const f = frame as { id: number };
      await new Promise((r) => setTimeout(r, 10));
      return { id: f.id, result: "ok" };
    });

    // Second frame has NO trailing newline — it is buffered, and only flush()
    // (inside end()) pushes it onto the chain. The drain must still wait for it.
    conn.push('{"id":1}\n{"id":2}');
    expect(conn.out).toEqual([]);

    await conn.end(() => events.push("exit"));

    expect(conn.out).toEqual([
      '{"id":1,"result":"ok"}\n',
      '{"id":2,"result":"ok"}\n',
    ]);
    expect(events).toEqual(["exit"]);
  });

  it("drives the invariant through the real buildDispatcher wiring", async () => {
    // End-to-end-ish: real dispatcher + real handlers (initialize), wired exactly
    // like main(). Proves the response frame is written before the exit sentinel.
    const ctx = new ConnectionContext();
    const dispatcher = buildDispatcher(ctx);
    const events: string[] = [];

    const conn = wireConnection((frame) => dispatcher.dispatch(frame));
    conn.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocol_version: "0.1.4", client: { name: "t", version: "0" } },
      }) + "\n",
    );

    await conn.end(() => events.push("exit"));

    expect(conn.out).toHaveLength(1);
    const frame = JSON.parse(conn.out[0] as string) as { id: number; result?: unknown };
    expect(frame.id).toBe(1);
    expect(frame.result).toBeDefined();
    expect(events).toEqual(["exit"]);
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — wire-order invariant: response precedes buffered events
// ---------------------------------------------------------------------------

describe("FIX 2 — makeFrameLoop: response written before buffered sink events", () => {
  /**
   * Build a makeFrameLoop wired to an in-memory output array, with a fake
   * dispatch that synchronously calls sinkWrite to emit an events.event
   * notification DURING dispatch. Without buffering, the event would precede
   * the response in the output. With buffering, it must appear after.
   */
  it("events emitted synchronously during dispatch appear AFTER the response on the wire", async () => {
    const out: unknown[] = [];
    const write = createWriter((line) => out.push(line));

    // Forward ref for sinkWrite (assigned after makeFrameLoop returns, before
    // any frame is dispatched — so the closure captures the live reference).
    let sinkWriteRef: (frame: unknown) => void = () => {};

    const { onFrame, sinkWrite, getChain } = makeFrameLoop({
      rawWrite: write,
      dispatch: async (_frame) => {
        // Synchronously emit an events.event notification DURING dispatch.
        // Without FIX 2 buffering this would be written to `out` immediately,
        // before the response frame — violating spec §1 wire order.
        sinkWriteRef({
          jsonrpc: "2.0",
          method: "events.event",
          params: { subscription_id: "sub_1", seq: 1, name: "run_started", payload: {} },
        });
        // Return the JSON-RPC response for this request.
        return { jsonrpc: "2.0", id: 42, result: { ok: true } };
      },
    });

    // Wire the sinkWrite forward ref BEFORE any frame arrives.
    sinkWriteRef = sinkWrite;

    // Feed one frame.
    onFrame({ jsonrpc: "2.0", id: 42, method: "orchestrate.run", params: {} });

    // Drain.
    await getChain();

    // Must have exactly 2 lines: the response and the events.event notification.
    expect(out).toHaveLength(2);

    const responseLine = JSON.parse(out[0] as string) as { id?: number; method?: string };
    const eventLine = JSON.parse(out[1] as string) as { id?: number; method?: string };

    // Response (has "id") must come first.
    expect(responseLine.id).toBe(42);
    expect(responseLine.method).toBeUndefined();

    // Event notification (has "method", no "id") must come second.
    expect(eventLine.method).toBe("events.event");
    expect(eventLine.id).toBeUndefined();
  });

  it("without buffering (baseline): events emitted during dispatch would precede the response", async () => {
    // This test documents the BUG that FIX 2 corrects: if we bypass sinkWrite
    // and call rawWrite directly during dispatch, the event lands before the
    // response. This confirms the test setup is sensitive enough to catch
    // the ordering violation.
    const out: unknown[] = [];
    const write = createWriter((line) => out.push(line));

    const { onFrame, getChain } = makeFrameLoop({
      rawWrite: write,
      dispatch: async (_frame) => {
        // Bypass sinkWrite — call rawWrite directly, as if buffering were absent.
        write({
          jsonrpc: "2.0",
          method: "events.event",
          params: { subscription_id: "sub_1", seq: 1, name: "run_started", payload: {} },
        });
        return { jsonrpc: "2.0", id: 99, result: { ok: true } };
      },
    });

    onFrame({ jsonrpc: "2.0", id: 99, method: "orchestrate.run", params: {} });
    await getChain();

    expect(out).toHaveLength(2);
    const first = JSON.parse(out[0] as string) as { method?: string };
    // BUG: event came first (method = "events.event"), not the response.
    expect(first.method).toBe("events.event");
  });
});
