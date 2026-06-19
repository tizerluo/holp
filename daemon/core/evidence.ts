import { createHash } from "node:crypto";
import type { Clock } from "./clock.js";
import type { ConnectionContext } from "./context.js";
import type { ArtifactEnvelope } from "./stores.js";

export interface InlineEvidence {
  readonly inline: true;
  readonly type: string;
  readonly mime: "application/json";
  readonly content: string;
  readonly truncated: false;
}

export type EvidencePayload = InlineEvidence | ArtifactEnvelope;

export function evidencePayload(args: {
  readonly ctx: ConnectionContext;
  readonly clock: Clock;
  readonly artifactId: string;
  readonly type: string;
  readonly content: string;
  readonly createdBy: string;
}): EvidencePayload {
  if (args.ctx.initialized?.negotiated.artifact_refs.supported !== true) {
    return {
      inline: true,
      type: args.type,
      mime: "application/json",
      content: args.content,
      truncated: false,
    };
  }

  const envelope = {
    artifact_id: args.artifactId,
    type: args.type,
    mime: "application/json",
    size: Buffer.byteLength(args.content),
    sha256: createHash("sha256").update(args.content).digest("hex"),
    created_by: args.createdBy,
    created_at: args.clock.now(),
  };
  args.ctx.artifacts.set(args.artifactId, { envelope, content: args.content });
  return envelope;
}
