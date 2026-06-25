import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  addManifestSurface,
  assertOwnedSendCommand,
  createCmuxTuiSessionManifest,
  isHolpWorkerSession,
  manifestPathForSession,
  readCmuxTuiSessionManifest,
  sessionIdFromBrokerSocket,
  writeCmuxTuiSessionManifest,
} from "../../../consumers/cmux-bridge/index.js";

function manifest() {
  return addManifestSurface(
    createCmuxTuiSessionManifest({
      sessionId: "session-owned",
      workspaceId: "workspace:owned",
      brokerSocket: "/tmp/holp-harness-workspace/session-owned/broker.sock",
      now: "2026-06-25T00:00:00.000Z",
    }),
    "controller",
    { surface_id: "surface:controller" },
  );
}

describe("cmux TUI manifest ownership", () => {
  it("accepts sends only to manifest-owned surfaces", () => {
    const ownedSend = {
      name: "send" as const,
      args: ["--workspace", "workspace:owned", "--surface", "surface:controller", "--", "echo ok\n"],
      target: { kind: "mission-control" as const, title: "controller" },
    };
    const foreignSend = {
      ...ownedSend,
      args: ["--workspace", "workspace:owned", "--surface", "surface:foreign", "--", "echo no\n"],
    };

    expect(assertOwnedSendCommand(manifest(), ownedSend)).toEqual([]);
    expect(assertOwnedSendCommand(manifest(), foreignSend)).toContain("surface_not_owned");
  });

  it("uses only the structural --surface for ownership even when payload contains another --surface", () => {
    const payloadOnlySurface = {
      name: "send" as const,
      args: ["--workspace", "workspace:owned", "--", "--surface", "surface:controller", "echo hi\n"],
      target: { kind: "mission-control" as const, title: "payload bypass" },
    };
    const structuralOwnedWithPayloadForeign = {
      name: "send" as const,
      args: [
        "--workspace",
        "workspace:owned",
        "--surface",
        "surface:controller",
        "--",
        "--surface surface:foreign echo hi\n",
      ],
      target: { kind: "mission-control" as const, title: "owned structure" },
    };

    expect(assertOwnedSendCommand(manifest(), payloadOnlySurface)).toEqual(expect.arrayContaining([
      "missing_surface",
      "surface_not_owned",
    ]));
    expect(assertOwnedSendCommand(manifest(), structuralOwnedWithPayloadForeign)).toEqual([]);
  });

  it("requires an explicit session selector and never falls back to newest manifest", () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "holp-cmux-manifest-test-"));
    try {
      writeCmuxTuiSessionManifest(manifest(), baseDir);
      expect(manifestPathForSession("session-owned", baseDir)).toContain("session-owned");
      expect(() => readCmuxTuiSessionManifest({ baseDir })).toThrow("missing_session_selector");
      expect(readCmuxTuiSessionManifest({ sessionId: "session-owned", baseDir }).session_id).toBe("session-owned");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("derives session id only from the bounded broker socket namespace", () => {
    expect(sessionIdFromBrokerSocket("/tmp/holp-harness-workspace/session-a/broker.sock")).toBe("session-a");
    expect(sessionIdFromBrokerSocket("/tmp/holp-harness-workspace/session-a/other.sock")).toBeUndefined();
    expect(sessionIdFromBrokerSocket("/tmp/not-holp/session-a/broker.sock")).toBeUndefined();
  });

  it("recognizes only HOLP-owned worker tmux sessions", () => {
    expect(isHolpWorkerSession("holp-worker-1")).toBe(true);
    expect(isHolpWorkerSession("user-shell")).toBe(false);
    expect(isHolpWorkerSession("tmux:holp-worker")).toBe(false);
    expect(isHolpWorkerSession(undefined)).toBe(false);
  });
});
