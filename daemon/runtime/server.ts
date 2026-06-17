/**
 * HOLP reference daemon entrypoint (M1a).
 *
 * Wires the stdio control plane: stdin NDJSON reader → dispatcher → stdout
 * NDJSON writer. Registers the three M1a handlers (initialize, events.subscribe,
 * events.unsubscribe). orchestrate.run and friends are out of scope — unknown
 * methods hit -32601 in the dispatcher.
 *
 * spec §1 discipline: stdout carries ONLY protocol frames. All logging goes to
 * stderr (`log` below), so it never pollutes the NDJSON frame stream.
 *
 * Adapter wiring: the daemon names the frozen downward contract type
 * (AgentBackendFactory) to prove daemon ↔ adapters type-checks under NodeNext.
 * The stub adapter *registry* (adapters/registry.ts) is NOT statically imported
 * in M1a — see the note at AdapterResolve below.
 */

import { NdjsonReader, createWriter } from "./ndjson.js";
import { Dispatcher } from "../core/dispatcher.js";
import { ConnectionContext } from "../core/context.js";
import { EventSink } from "../core/eventSink.js";
import { handleInitialize } from "../handlers/initialize.js";
import { handleEventsSubscribe } from "../handlers/events_subscribe.js";
import { handleEventsUnsubscribe } from "../handlers/events_unsubscribe.js";
import type {
  AgentBackendFactory,
  TransportClass,
} from "../../adapters/agent-backend.js";

/**
 * The seam by which later milestones (PR3+) inject adapter resolution. Typed
 * against the frozen downward contract so the daemon ↔ adapters wiring is
 * type-checked today even though no agent is driven in M1a.
 *
 * NOTE: adapters/registry.ts (`createDefaultAdapterRegistry`) has a pre-existing
 * extensionless relative import (`from "./agent-backend"`) that NodeNext tsc
 * rejects (TS2835). The adapter contract is frozen (import only, do not modify),
 * so the daemon does not statically import registry.ts. tsx/esbuild tolerates
 * that import at runtime, so once the specifier is corrected the registry can be
 * wired in via this resolver type without any daemon-side change.
 */
export type AdapterResolve = (transport: TransportClass) => AgentBackendFactory | undefined;

/** stderr-only logger — never write logs to stdout (would corrupt the frame stream). */
function log(...args: unknown[]): void {
  process.stderr.write(
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n",
  );
}

/** Register the M1a handlers onto a dispatcher bound to a connection context. */
export function buildDispatcher(ctx: ConnectionContext): Dispatcher {
  const dispatcher = new Dispatcher(ctx);
  dispatcher
    .register("initialize", handleInitialize)
    .register("events.subscribe", handleEventsSubscribe)
    .register("events.unsubscribe", handleEventsUnsubscribe);
  return dispatcher;
}

export function main(): void {
  const ctx = new ConnectionContext();
  const dispatcher = buildDispatcher(ctx);
  const write = createWriter((line) => process.stdout.write(line));
  // Event sink is available for server→client notifications (no source pushes in M1a).
  const sink = new EventSink(write);
  void sink;

  const reader = new NdjsonReader(
    (frame) => {
      void dispatcher.dispatch(frame).then((response) => {
        if (response !== undefined) write(response);
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
    reader.flush();
    process.exit(0);
  });

  log("holp-reference-daemon M1a: listening on stdio");
}

// Run when invoked as the entrypoint (tsx daemon/runtime/server.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
