/**
 * `initialize` handler — spec §2 + §9.
 *
 * - protocol_version major mismatch → protocol_version_mismatch (-32001) (§9).
 * - capability negotiation = descriptor intersection (§2); required-but-
 *   unsupported (or required approval with empty kinds intersection) →
 *   capability_required_but_unsupported (-32002).
 * - On success: store negotiated state on the connection, return server
 *   identity + negotiated capabilities + protocol_version.
 *
 * Server self-report (§2 example): consensus/approval/unattended_loop/
 * artifact_refs all supported:true; approval.kinds = the full spec example set.
 */

import { negotiateCapabilities } from "../core/capabilities.js";
import type { CapabilityMap } from "../core/capabilities.js";
import { holpError } from "../core/errors.js";
import { HolpRpcError } from "../core/dispatcher.js";
import { isObject } from "../core/internal.js";
import type { JsonRpcRequest } from "../runtime/jsonrpc.js";
import type { ConnectionContext } from "../core/context.js";

/** Server identity returned in initialize result. */
export const SERVER_IDENTITY = {
  name: "holp-reference-daemon",
  version: "0.1.4",
} as const;

/** Protocol version this daemon speaks. */
export const SERVER_PROTOCOL_VERSION = "0.1.4";

/**
 * Server's self-reported capabilities (spec §2 Response example).
 * approval.kinds = full example set.
 */
export const SERVER_CAPABILITIES: CapabilityMap = {
  consensus: { supported: true },
  approval: {
    supported: true,
    kinds: ["merge_approval", "force_push_approval", "budget_exceeded"],
  },
  unattended_loop: { supported: true },
  artifact_refs: { supported: true },
};

/** Major version = the first dot-separated segment (§9: 兼容性只看 MAJOR.MINOR, major 必须同). */
function majorOf(version: string): string {
  return version.split(".")[0] ?? "";
}

export function handleInitialize(req: JsonRpcRequest, ctx: ConnectionContext): unknown {
  const params = req.params;
  if (!isObject(params)) {
    throw new HolpRpcError(holpError("internal_error", "initialize: params must be an object"));
  }

  const client = params.client;
  if (!isObject(client) || typeof client.name !== "string" || typeof client.version !== "string") {
    throw new HolpRpcError(
      holpError("internal_error", "initialize: params.client.{name,version} required"),
    );
  }

  const clientProtocol = params.protocol_version;
  if (typeof clientProtocol !== "string") {
    throw new HolpRpcError(
      holpError("internal_error", "initialize: params.protocol_version (string) required"),
    );
  }

  // §9: major mismatch → reject. draft 第三段不计入兼容性判定。
  if (majorOf(clientProtocol) !== majorOf(SERVER_PROTOCOL_VERSION)) {
    throw new HolpRpcError(
      holpError(
        "protocol_version_mismatch",
        `client protocol ${clientProtocol} major-incompatible with server ${SERVER_PROTOCOL_VERSION}`,
        { client: clientProtocol, server: SERVER_PROTOCOL_VERSION },
      ),
    );
  }

  const clientCaps: CapabilityMap = isObject(params.capabilities)
    ? (params.capabilities as CapabilityMap)
    : {};

  const outcome = negotiateCapabilities(clientCaps, SERVER_CAPABILITIES);
  if (!outcome.ok) {
    throw new HolpRpcError(outcome.error);
  }

  ctx.initialized = {
    protocolVersion: SERVER_PROTOCOL_VERSION,
    clientName: client.name,
    clientVersion: client.version,
    negotiated: outcome.negotiated,
  };

  return {
    server: { name: SERVER_IDENTITY.name, version: SERVER_IDENTITY.version },
    capabilities: outcome.negotiated,
    protocol_version: SERVER_PROTOCOL_VERSION,
  };
}
