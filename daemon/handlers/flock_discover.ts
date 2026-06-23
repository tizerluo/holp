/**
 * `flock.discover` handler — spec §3.2 / §3.3 / §10.1.
 *
 * Pull: orchestrator probes local agents by transport. For each requested
 * transport, discover what's available.
 *
 * Known transports return one discovered candidate each. With probe:true the
 * adapter registry performs the lightweight availability check; without probe
 * the candidate is reported degraded/not_probed.
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
import {
  rejectedProfiles,
  type DirectChannelDeclaration,
  type IsolationProfile,
  type RuntimeSurfaceDeclaration,
} from "../../adapters/harness-declaration.js";
import type { Clock } from "../core/clock.js";

export async function handleFlockDiscover(
  req: JsonRpcRequest,
  ctx: ConnectionContext,
  registry: AdapterRegistry,
  clock: Clock,
): Promise<unknown> {
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
    if (!registry.hasTransport(transport)) {
      // No adapter for this transport — skip (discover silently omits unknowns).
      continue;
    }

    const id = discoveredAgentId(transport);
    const roles = discoveredRoles(transport);
    const agent: FlockAgent = probe
      ? toFlockAgent(
          id,
          transport,
          await registry.probe({
            id,
            transport,
            roles,
            cwd: process.cwd(),
            runtimeSurface: "headless",
            isolationProfile: defaultProbeIsolationProfile(roles),
            runIntent: "flock.discover",
            workspaceId: process.cwd(),
            sessionRouteKey: id,
          }),
        )
      : {
          id,
          transport,
          harness_id: id,
          transport_class: transport,
          status: "degraded",
          resolved_roles: roles,
          reason: "not_probed",
          missing: [],
          runtime_surfaces: notProbedRuntimeSurfaces(id),
          state_declaration_ref: `harness-state:${id}`,
          global_mutation_required: false,
        };

    ctx.flock.set(agent.id, agent);
    ctx.governance.archiveHarnessAgent(agent, clock.now());
    discovered.push(agent);
  }

  return {
    agents: discovered.map(serializeFlockAgent),
  };
}

function defaultProbeIsolationProfile(roles: readonly string[]): IsolationProfile {
  return roles.includes("coder") ? "coder_worktree" : "read_only_review";
}

function discoveredAgentId(transport: string): string {
  switch (transport) {
    case "fake":
      return "fake-agent";
    case "mcp-codex":
      return "codex-agent";
    case "native-claude":
      return "claude-agent";
    case "acp":
      return "acp-agent";
    case "learned-router":
      return "learned-router";
    default:
      return `${transport}-agent`;
  }
}

function discoveredRoles(transport: string): readonly string[] {
  return transport === "learned-router" ? ["work_planner"] : ["coder", "reviewer", "tester"];
}

function notProbedRuntimeSurfaces(id: string): readonly RuntimeSurfaceDeclaration[] {
  const common = {
    isolation_profiles: rejectedProfiles("not_probed"),
    global_mutation_required: false,
    declared_not_enforced: true,
  } as const;
  return [
    {
      runtime_surface: "headless",
      runtime_kind: "not_probed",
      actual_fidelity: "one_shot",
      surface_support: "unknown",
      state_declaration_ref: `harness-state:${id}:headless`,
      ...common,
    },
    {
      runtime_surface: "acp",
      runtime_kind: "not_probed_acp",
      actual_fidelity: "one_shot",
      surface_support: "unknown",
      state_declaration_ref: `harness-state:${id}:acp`,
      ...common,
    },
    {
      runtime_surface: "direct_user_session",
      runtime_kind: "not_probed_direct_session",
      actual_fidelity: "one_shot",
      surface_support: "unknown",
      direct_channel: unknownDirectChannel(),
      state_declaration_ref: `harness-state:${id}:direct_user_session`,
      ...common,
    },
  ];
}

function unknownDirectChannel(): DirectChannelDeclaration {
  return {
    channel_type: "terminal_app",
    attach: "unknown",
    observe: "unknown",
    read: "unknown",
    inject: "unknown",
    interrupt: "unknown",
    cancel: "unknown",
    owner_scope: "unknown",
  };
}

function toFlockAgent(
  id: string,
  transport: string,
  probeResult: Awaited<ReturnType<AdapterRegistry["probe"]>>,
): FlockAgent {
  return {
    id,
    transport,
    harness_id: probeResult.harness_id,
    vendor: probeResult.vendor,
    transport_class: probeResult.transport_class,
    status: probeResult.status,
    version: probeResult.version,
    logged_in: probeResult.logged_in,
    resolved_roles: probeResult.resolved_roles ?? [],
    missing: probeResult.missing,
    reason: probeResult.reason,
    runtime_surfaces: probeResult.runtime_surfaces,
    state_declaration_ref: probeResult.state_declaration_ref,
    global_mutation_required: probeResult.global_mutation_required,
  };
}
