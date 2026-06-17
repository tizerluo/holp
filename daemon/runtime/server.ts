/**
 * HOLP reference daemon entrypoint (M1b).
 *
 * Wires the stdio control plane: stdin NDJSON reader → dispatcher → stdout
 * NDJSON writer. Registers all 9 handlers (initialize, flock.declare,
 * flock.discover, orchestrate.run, events.subscribe, events.unsubscribe,
 * approval.resolve, task.cancel, artifact.get).
 *
 * spec §1 discipline: stdout carries ONLY protocol frames. All logging goes to
 * stderr (`log` below), so it never pollutes the NDJSON frame stream.
 *
 * LAUNCH (protocol transport): the canonical, banner-free launch is running the
 * entrypoint directly — `tsx daemon/runtime/server.ts` — or `npm run --silent start`.
 * NEVER use `npm run start` / `npm run dev` (without --silent) as the protocol
 * transport: `npm run` prints a banner (e.g. "> holp@0.1.4 start") to stdout
 * BEFORE this process emits anything, which corrupts the NDJSON frame stream.
 * The `dev` script is a human/debug convenience (stderr logs visible); it is NOT
 * for protocol I/O.
 *
 * Fake backend: M1b wires the fake adapter registry so the demo can run end-to-end
 * with a "fake" transport agent. Real adapters (native-claude/mcp-codex/acp) remain
 * stubs — no real agent is connected in M1b.
 */

import { NdjsonReader, createWriter } from "./ndjson.js";
import { Dispatcher } from "../core/dispatcher.js";
import { ConnectionContext } from "../core/context.js";
import { EventSink } from "../core/eventSink.js";
import { systemClock, type Clock } from "../core/clock.js";
import { handleInitialize } from "../handlers/initialize.js";
import { handleEventsSubscribe } from "../handlers/events_subscribe.js";
import { handleEventsUnsubscribe } from "../handlers/events_unsubscribe.js";
import { handleFlockDeclare } from "../handlers/flock_declare.js";
import { handleFlockDiscover } from "../handlers/flock_discover.js";
import { handleOrchestrateRun } from "../handlers/orchestrate_run.js";
import { handleApprovalResolve } from "../handlers/approval_resolve.js";
import { handleTaskCancel } from "../handlers/task_cancel.js";
import { handleArtifactGet } from "../handlers/artifact_get.js";
import { createFakeRegistry } from "../../adapters/registry.js";
import type {
  AgentBackendFactory,
  TransportClass,
} from "../../adapters/agent-backend.js";

/**
 * The seam by which later milestones can inject adapter resolution.
 * Typed against the frozen downward contract so the daemon ↔ adapters
 * wiring is type-checked.
 */
export type AdapterResolve = (transport: TransportClass) => AgentBackendFactory | undefined;

/** stderr-only logger — never write logs to stdout (would corrupt the frame stream). */
function log(...args: unknown[]): void {
  process.stderr.write(
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n",
  );
}

/**
 * Register all M1b handlers onto a dispatcher bound to a connection context.
 * Used both by main() and by in-process tests.
 *
 * sink is needed for events.subscribe to replay events to subscribers.
 * registry is the adapter registry (defaults to fake registry for M1b demo).
 * clock is injectable so tests can pin event timestamps and approval ids.
 */
export function buildDispatcher(
  ctx: ConnectionContext,
  sink?: EventSink,
  registry = createFakeRegistry(),
  clock: Clock = systemClock,
): Dispatcher {
  const dispatcher = new Dispatcher(ctx);
  dispatcher
    .register("initialize", handleInitialize)
    .register("events.subscribe", (req, c) => handleEventsSubscribe(req, c, sink))
    .register("events.unsubscribe", handleEventsUnsubscribe)
    .register("flock.declare", (req, c) => handleFlockDeclare(req, c, registry))
    .register("flock.discover", (req, c) => handleFlockDiscover(req, c, registry))
    .register("orchestrate.run", (req, c) => handleOrchestrateRun(req, c, registry, clock))
    .register("approval.resolve", handleApprovalResolve)
    .register("task.cancel", handleTaskCancel)
    .register("artifact.get", handleArtifactGet);
  return dispatcher;
}

/**
 * FIX 2 (wire ordering): extracted frame-loop unit — testable without process I/O.
 *
 * Wire-order invariant: a request's response MUST be written BEFORE the
 * events it triggers (spec §1 / §5 ordering). Without this, events published
 * synchronously during dispatch land on stdout before the response, which
 * violates spec §1 frame discipline.
 *
 * Mechanism: sinkWrite (returned for use with EventSink) buffers while the
 * dispatcher is processing a frame. After rawWrite(response), the buffer is
 * flushed in order. Any microtask continuations that fire during `await
 * dispatch(frame)` see buffering=true and land in the buffer — they are
 * flushed only after the response is written.
 *
 * @param rawWrite — the underlying frame writer (e.g. stdout NDJSON writer)
 * @param dispatch — async per-frame dispatch function (e.g. dispatcher.dispatch)
 * @returns onFrame: call for each parsed frame; sinkWrite: pass to EventSink;
 *          getChain: returns the current drain Promise (for stdin-end draining)
 */
export function makeFrameLoop({
  rawWrite,
  dispatch,
}: {
  rawWrite: (frame: unknown) => void;
  dispatch: (frame: unknown) => Promise<unknown>;
}): {
  onFrame: (frame: unknown) => void;
  sinkWrite: (frame: unknown) => void;
  getChain: () => Promise<void>;
} {
  let buffering = false;
  const buffer: unknown[] = [];

  // EventSink should use this write fn. Buffers writes while dispatch is in
  // progress; passes through directly otherwise (e.g. heartbeats between frames).
  const sinkWrite = (frame: unknown): void => {
    if (buffering) {
      buffer.push(frame);
    } else {
      rawWrite(frame);
    }
  };

  let chain: Promise<void> = Promise.resolve();

  const onFrame = (frame: unknown): void => {
    chain = chain
      .then(() => {
        buffering = true;
        return dispatch(frame);
      })
      .then((response) => {
        buffering = false;
        // Write response FIRST (spec §1 wire-order invariant).
        if (response !== undefined) rawWrite(response);
        // Then flush any events that were buffered during dispatch.
        const toFlush = buffer.splice(0);
        for (const f of toFlush) rawWrite(f);
      })
      .catch((err) => {
        buffering = false;
        buffer.length = 0; // discard buffered events on dispatch error
        log("dispatch error:", err instanceof Error ? err.message : String(err));
      });
  };

  return { onFrame, sinkWrite, getChain: () => chain };
}

export function main(): void {
  const ctx = new ConnectionContext();
  const write = createWriter((line) => process.stdout.write(line));
  const registry = createFakeRegistry();

  // FIX 2: forward-ref pattern — makeFrameLoop returns sinkWrite which is needed
  // to build the sink; the dispatcher is assigned before any frame can arrive.
  let dispatcher: Dispatcher;
  const { onFrame, sinkWrite, getChain } = makeFrameLoop({
    rawWrite: write,
    dispatch: (frame) => dispatcher.dispatch(frame),
  });
  const sink = new EventSink(sinkWrite);
  dispatcher = buildDispatcher(ctx, sink, registry);

  const reader = new NdjsonReader(
    (frame) => {
      onFrame(frame);
    },
    (rawLine, error) => {
      // Unparseable input line: log to stderr; do not emit a frame to stdout.
      log(
        "ndjson parse error:",
        error instanceof Error ? error.message : String(error),
        "line:",
        rawLine,
      );
    },
  );

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => reader.push(chunk));
  process.stdin.on("end", () => {
    // flush() synchronously emits any trailing buffered frame through the same
    // reader callback above, which chains its dispatch onto the chain. Awaiting
    // getChain() after flush therefore drains every queued response to stdout
    // before we exit.
    reader.flush();
    void getChain().finally(() => process.exit(0));
  });

  log("holp-reference-daemon M1b: listening on stdio");
}

// Run when invoked as the entrypoint (tsx daemon/runtime/server.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
