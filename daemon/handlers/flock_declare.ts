/**
 * `flock.declare` handler — spec §3.1 / §3.3 / §10.1.
 *
 * Part-success semantics: NEVER throws JSON-RPC error for semantic/reference
 * issues. Unsupported transport / missing adapter / missing auth → that agent
 * gets status:"rejected" with a reason. Only a malformed request → -32600.
 *
 * Probes are delegated to the adapter registry so real transports can honestly
 * report ready/degraded/rejected without this handler hard-coding transport
 * details.
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
import type { IsolationProfile } from "../../adapters/harness-declaration.js";

/**
 * Probe a declared agent against the adapter registry.
 * Returns a FlockAgent with the appropriate status.
 *
 * Honest contract:
 *   - registry probes decide per-transport status and capabilities.
 *   - fake remains ready in createFakeRegistry(); mcp-codex can be ready/degraded/rejected
 *     in the default registry; native-claude/acp remain honest rejected stubs.
 */
async function probeAgent(
  declared: { id: string; transport: string; roles?: string[] },
  registry: AdapterRegistry,
): Promise<FlockAgent> {
  const roles = Array.isArray(declared.roles) ? declared.roles.map(String) : [];
  const result = await registry.probe({
    id: declared.id,
    transport: declared.transport,
    roles,
    cwd: process.cwd(),
    runtimeSurface: "headless",
    isolationProfile: defaultProbeIsolationProfile(roles),
    runIntent: "flock.declare",
    workspaceId: process.cwd(),
    sessionRouteKey: declared.id,
  });
  return {
    id: declared.id,
    transport: declared.transport,
    harness_id: result.harness_id,
    vendor: result.vendor,
    transport_class: result.transport_class,
    status: result.status,
    version: result.version,
    logged_in: result.logged_in,
    resolved_roles: result.resolved_roles ?? [],
    missing: result.missing,
    reason: result.reason,
    runtime_surfaces: result.runtime_surfaces,
    state_declaration_ref: result.state_declaration_ref,
    global_mutation_required: result.global_mutation_required,
  };
}

function defaultProbeIsolationProfile(roles: readonly string[]): IsolationProfile {
  return roles.includes("coder") ? "coder_worktree" : "read_only_review";
}

export async function handleFlockDeclare(
  req: JsonRpcRequest,
  ctx: ConnectionContext,
  registry: AdapterRegistry,
): Promise<unknown> {
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

    const resolved = await probeAgent(declared, registry);
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
  if (a.harness_id !== undefined) out.harness_id = a.harness_id;
  if (a.vendor !== undefined) out.vendor = a.vendor;
  if (a.transport_class !== undefined) out.transport_class = a.transport_class;
  if (a.resolved_roles.length > 0) out.resolved_roles = a.resolved_roles;
  if (a.missing !== undefined && a.missing.length > 0) out.missing = a.missing;
  if (a.reason !== undefined) out.reason = a.reason;
  if (a.runtime_surfaces !== undefined) out.runtime_surfaces = a.runtime_surfaces;
  if (a.state_declaration_ref !== undefined) out.state_declaration_ref = a.state_declaration_ref;
  if (a.global_mutation_required !== undefined) {
    out.global_mutation_required = a.global_mutation_required;
  }
  return out;
}
