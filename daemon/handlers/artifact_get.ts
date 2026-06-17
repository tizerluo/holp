/**
 * `artifact.get` handler — spec §8.2.
 *
 * Always returns `content` (never `content_ref`).
 * Returns { artifact_id, envelope, content, truncated, truncated_at? }.
 * truncated_at only when truncated:true.
 *
 * Unknown id → artifact_not_found (-32014).
 * (artifact_expired and artifact_forbidden not triggered in M1b — no expiry logic yet.)
 */

import { holpError, invalidRequest } from "../core/errors.js";
import { HolpRpcError } from "../core/dispatcher.js";
import { isObject } from "../core/internal.js";
import type { JsonRpcRequest } from "../runtime/jsonrpc.js";
import type { ConnectionContext } from "../core/context.js";

/** Max content bytes returned before truncation. */
const MAX_CONTENT_BYTES = 64 * 1024; // 64 KiB

export function handleArtifactGet(req: JsonRpcRequest, ctx: ConnectionContext): unknown {
  const params = isObject(req.params) ? req.params : {};

  const artifactId = params.artifact_id;
  if (typeof artifactId !== "string" || !artifactId) {
    throw new HolpRpcError(
      invalidRequest("artifact.get: params.artifact_id (string) required"),
    );
  }

  const record = ctx.artifacts.get(artifactId);
  if (!record) {
    throw new HolpRpcError(
      holpError("artifact_not_found", `artifact '${artifactId}' not found`, {
        artifact_id: artifactId,
      }),
    );
  }

  const content = record.content;
  if (content.length > MAX_CONTENT_BYTES) {
    const truncatedContent = content.slice(0, MAX_CONTENT_BYTES);
    return {
      artifact_id: artifactId,
      envelope: record.envelope,
      content: truncatedContent,
      truncated: true,
      truncated_at: MAX_CONTENT_BYTES,
    };
  }

  return {
    artifact_id: artifactId,
    envelope: record.envelope,
    content,
    truncated: false,
  };
}
