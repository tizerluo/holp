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
import { systemClock } from "../core/clock.js";
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
 */
export function buildDispatcher(
  ctx: ConnectionContext,
  sink?: EventSink,
  registry = createFakeRegistry(),
): Dispatcher {
  const clock = systemClock;

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

export function main(): void {
  const ctx = new ConnectionContext();
  const write = createWriter((line) => process.stdout.write(line));
  const sink = new EventSink(write);
  const registry = createFakeRegistry();
  const dispatcher = buildDispatcher(ctx, sink, registry);

  // Per-connection serial dispatch queue: each frame chains onto the previous so
  // responses are written to stdout in arrival order (spec §1 frame discipline).
  // A frame's failure is logged to stderr and does not break the chain.
  let chain = Promise.resolve();
  const reader = new NdjsonReader(
    (frame) => {
      chain = chain
        .then(() => dispatcher.dispatch(frame))
        .then((response) => {
          if (response !== undefined) write(response);
        })
        .catch((err) => {
          log("dispatch error:", err instanceof Error ? err.message : String(err));
        });
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
    // reader callback above, which chains its dispatch onto `chain`. Awaiting
    // `chain` after flush therefore drains every queued response to stdout before
    // we exit — without this, async handlers could lose their last response frame
    // on stdin close.
    reader.flush();
    void chain.finally(() => process.exit(0));
  });

  log("holp-reference-daemon M1b: listening on stdio");
}

// Run when invoked as the entrypoint (tsx daemon/runtime/server.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
