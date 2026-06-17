/**
 * `flock.declare` handler — spec §3.1 / §3.3 / §10.1.
 *
 * Part-success semantics: NEVER throws JSON-RPC error for semantic/reference
 * issues. Unsupported transport / missing adapter / missing auth → that agent
 * gets status:"rejected" with a reason. Only a malformed request → -32600.
 *
 * "fake" transport: resolves to status:"ready" (demo-only; see adapters/fake-backend.ts).
 * All real transports (native-claude/mcp-codex/acp): resolved to "rejected"
 * because their factories are stubs (no real agent available).
 *
 * Resolved agents are stored into the connection flock so orchestrate.run
 * can validate agent references (§4.2).
 */

import { invalidRequest } from "../core/errors.js";
import { HolpRpcError } from "../core/dispatcher.js";
import { isObject } from "../core/internal.js";
import type { JsonRpcRequest } from "../runtime/jsonrpc.js";
import type { ConnectionContext } from "../core/context.js";
import type { FlockAgent } from "../core/stores.js";
import type { AdapterRegistry } from "../../adapters/registry.js";

/**
 * Probe a declared agent against the adapter registry.
 * Returns a FlockAgent with the appropriate status.
 *
 * Honest contract:
 *   - "fake" transport → status:"ready", all declared roles available.
 *   - real transports → status:"rejected", reason:"unsupported_transport"
 *     (their factories are stubs that will throw on startSession).
 */
function probeAgent(
  declared: { id: string; transport: string; roles?: string[] },
  registry: AdapterRegistry,
): FlockAgent {
  const factory = registry.resolve(declared.transport);
  const roles = Array.isArray(declared.roles) ? declared.roles.map(String) : [];

  if (!factory) {
    // No adapter registered for this transport.
    return {
      id: declared.id,
      transport: declared.transport,
      status: "rejected",
      resolved_roles: [],
      reason: "unsupported_transport",
      missing: roles.map((r) => `role:${r}`),
    };
  }

  // "fake" transport factory exists → treat as ready (DEMO ONLY).
  // Real transports also have stubs — detect by trying to check if it's the fake.
  // We identify fake by transport name, not by factory identity, to keep it simple.
  if (declared.transport === "fake") {
    return {
      id: declared.id,
      transport: declared.transport,
      status: "ready",
      version: "0.0.1-fake",
      logged_in: true,
      resolved_roles: roles.length > 0 ? roles : ["coder", "reviewer"],
    };
  }

  // Real transport stub: it has a factory but startSession will throw.
  // Return rejected with the reason.
  return {
    id: declared.id,
    transport: declared.transport,
    status: "rejected",
    resolved_roles: [],
    reason: "unsupported_transport",
    missing: roles.map((r) => `role:${r}`),
  };
}

export function handleFlockDeclare(
  req: JsonRpcRequest,
  ctx: ConnectionContext,
  registry: AdapterRegistry,
): unknown {
  const params = isObject(req.params) ? req.params : {};

  // Malformed: no agents field → -32600.
  if (!Array.isArray(params.agents)) {
    throw new HolpRpcError(invalidRequest("flock.declare: params.agents (array) required"));
  }

  const agents = params.agents as unknown[];
  const results: FlockAgent[] = [];

  for (const raw of agents) {
    if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.transport !== "string") {
      throw new HolpRpcError(
        invalidRequest("flock.declare: each agent must have id (string) and transport (string)"),
      );
    }

    const declared = {
      id: raw.id,
      transport: raw.transport,
      roles: Array.isArray(raw.roles) ? (raw.roles as unknown[]).map(String) : [],
    };

    const resolved = probeAgent(declared, registry);
    // Store into connection flock — even rejected agents are "known" (§4.2).
    ctx.flock.set(resolved.id, resolved);
    results.push(resolved);
  }

  // Serialize per spec §3.3 — include only defined fields.
  return {
    agents: results.map(serializeFlockAgent),
  };
}

export function serializeFlockAgent(a: FlockAgent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: a.id,
    transport: a.transport,
    status: a.status,
  };
  if (a.version !== undefined) out.version = a.version;
  if (a.logged_in !== undefined) out.logged_in = a.logged_in;
  if (a.resolved_roles.length > 0) out.resolved_roles = a.resolved_roles;
  if (a.missing !== undefined && a.missing.length > 0) out.missing = a.missing;
  if (a.reason !== undefined) out.reason = a.reason;
  return out;
}
