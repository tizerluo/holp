/**
 * Capability negotiation — spec §2 + catalog (d).
 *
 * Each capability is a descriptor { supported, required?, kinds? }. Negotiation
 * is the intersection of both sides' descriptors:
 *   effective.cap = client.cap.supported && server.cap.supported
 *
 * Rejection rules (→ initialize fails):
 *   - Either side required:true but the other supported:false →
 *     capability_required_but_unsupported (-32002).
 *   - approval.kinds: intersection; either side approval.required:true with an
 *     empty kinds intersection → reject. Both non-required + empty intersection
 *     → do NOT reject the connection (run-time degrade per §7/§11).
 *
 * 缺省 capability (descriptor absent) = { supported:false } (§2).
 */

import { holpError } from "./errors.js";
import type { JsonRpcError } from "../runtime/jsonrpc.js";

/** Negotiated capabilities (§2 / catalog (d)). */
export const CAPABILITY_NAMES = [
  "consensus",
  "approval",
  "unattended_loop",
  "artifact_refs",
  "gate_report",
  "dynamic_workflow",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/** A capability descriptor as it appears on the wire. */
export interface CapabilityDescriptor {
  supported: boolean;
  required?: boolean;
  /** approval only. */
  kinds?: string[];
}

export type CapabilityMap = Partial<Record<CapabilityName, CapabilityDescriptor>>;

/** Negotiated effective capability (post-intersection). */
export interface NegotiatedCapability {
  supported: boolean;
  /** approval only: intersection of both sides' kinds. */
  kinds?: string[];
}

export type NegotiatedCapabilities = Record<CapabilityName, NegotiatedCapability>;

/** Either a successful negotiation result or a JSON-RPC error to return. */
export type NegotiationOutcome =
  | { ok: true; negotiated: NegotiatedCapabilities }
  | { ok: false; error: JsonRpcError };

/** Treat an absent descriptor as { supported:false }. */
function descriptor(map: CapabilityMap, name: CapabilityName): CapabilityDescriptor {
  return map[name] ?? { supported: false };
}

/**
 * Negotiate client vs server capability maps. `approval.kinds` is intersected;
 * required-but-unsupported (or required approval with empty kinds intersection)
 * yields a JSON-RPC error.
 */
export function negotiateCapabilities(
  client: CapabilityMap,
  server: CapabilityMap,
): NegotiationOutcome {
  const negotiated = {} as NegotiatedCapabilities;

  for (const name of CAPABILITY_NAMES) {
    const c = descriptor(client, name);
    const s = descriptor(server, name);

    // Required-but-unsupported is connection-level (§2): either side requires
    // the capability but the other does not support it → reject initialize.
    if (c.required === true && s.supported !== true) {
      return {
        ok: false,
        error: holpError(
          "capability_required_but_unsupported",
          `client requires capability "${name}" but server does not support it`,
          { capability: name, requiredBy: "client" },
        ),
      };
    }
    if (s.required === true && c.supported !== true) {
      return {
        ok: false,
        error: holpError(
          "capability_required_but_unsupported",
          `server requires capability "${name}" but client does not support it`,
          { capability: name, requiredBy: "server" },
        ),
      };
    }

    const supported = c.supported === true && s.supported === true;

    if (name === "approval") {
      const intersection = intersectKinds(c.kinds, s.kinds);
      // Either side requires approval with an empty kinds intersection → reject.
      const eitherRequired = c.required === true || s.required === true;
      if (eitherRequired && intersection.length === 0) {
        return {
          ok: false,
          error: holpError(
            "capability_required_but_unsupported",
            "approval is required but the approval.kinds intersection is empty",
            { capability: "approval", reason: "empty_kinds_intersection" },
          ),
        };
      }
      negotiated[name] = { supported, kinds: intersection };
    } else {
      negotiated[name] = { supported };
    }
  }

  return { ok: true, negotiated };
}

/** Intersection of two optional kind lists (order follows the client list). */
function intersectKinds(a: string[] | undefined, b: string[] | undefined): string[] {
  if (!a || !b) return [];
  const bSet = new Set(b);
  return a.filter((k) => bSet.has(k));
}
