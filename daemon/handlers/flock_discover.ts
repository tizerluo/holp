/**
 * `flock.discover` handler — spec §3.2 / §3.3 / §10.1.
 *
 * Pull: orchestrator probes local agents by transport. For each requested
 * transport, discover what's available.
 *
 * "fake" transport with probe:true → returns a ready/degraded fake agent
 * so the discover path is exercised (demo/test only).
 * Real transports → no agents discovered (stubs have no real backend to probe).
 *
 * Same part-success semantics as flock.declare: never throws for semantic
 * failures; only malformed request → -32600.
 *
 * Discovered agents are stored into the connection flock (§4.2).
 */

import { invalidRequest } from "../core/errors.js";
import { HolpRpcError } from "../core/dispatcher.js";
import { isObject } from "../core/internal.js";
import type { JsonRpcRequest } from "../runtime/jsonrpc.js";
import type { ConnectionContext } from "../core/context.js";
import type { FlockAgent } from "../core/stores.js";
import { serializeFlockAgent } from "./flock_declare.js";
import type { AdapterRegistry } from "../../adapters/registry.js";

export function handleFlockDiscover(
  req: JsonRpcRequest,
  ctx: ConnectionContext,
  registry: AdapterRegistry,
): unknown {
  const params = isObject(req.params) ? req.params : {};

  // transports must be an array of strings.
  if (!Array.isArray(params.transports)) {
    throw new HolpRpcError(
      invalidRequest("flock.discover: params.transports (array of strings) required"),
    );
  }

  const transports = (params.transports as unknown[]).map((t) => {
    if (typeof t !== "string") {
      throw new HolpRpcError(
        invalidRequest("flock.discover: each transport must be a string"),
      );
    }
    return t;
  });

  const probe = params.probe === true;
  const discovered: FlockAgent[] = [];

  for (const transport of transports) {
    const factory = registry.resolve(transport);
    if (!factory) {
      // No adapter for this transport — skip (discover silently omits unknowns).
      continue;
    }

    if (transport === "fake") {
      // DEMO ONLY: fake transport discovers a "fake-agent" with full roles.
      // probe:true → status:"ready"; probe:false → status:"degraded" (not probed).
      const agent: FlockAgent = probe
        ? {
            id: "fake-agent",
            transport: "fake",
            status: "ready",
            version: "0.0.1-fake",
            logged_in: true,
            resolved_roles: ["coder", "reviewer", "tester"],
          }
        : {
            id: "fake-agent",
            transport: "fake",
            status: "degraded",
            resolved_roles: ["coder", "reviewer", "tester"],
            missing: [],
          };

      ctx.flock.set(agent.id, agent);
      discovered.push(agent);
    }
    // Real transports: no agents discovered (stubs have no probe logic).
    // Silently skip — consistent with "no agent found" for that transport.
  }

  return {
    agents: discovered.map(serializeFlockAgent),
  };
}
