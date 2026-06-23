import { describe, expect, it } from "vitest";
import { chooseDecision, parseArgs } from "../../../consumers/cli/index.js";
import { formatRawFrame } from "../../../consumers/cli/wire.js";

describe("consumer CLI argument and approval handling", () => {
  it("parses a non-interactive consensus command with raw/debug controls", () => {
    expect(parseArgs([
      "run",
      "--scenario=consensus",
      "--registry=fake",
      "--artifact-refs=false",
      "--decision=rejected",
      "--report=json",
      "--raw",
      "--debug=false",
    ])).toMatchObject({
      scenario: "consensus",
      registry: "fake",
      artifactRefs: false,
      decision: "rejected",
      report: "json",
      raw: true,
      debug: false,
    });
  });

  it("defaults non-interactive approvals to approved for deterministic demos", async () => {
    await expect(chooseDecision(
      { interactive: false, decision: undefined },
      { approval_id: "ap_1", kind: "merge_approval" },
    )).resolves.toBe("approved");
  });

  it("uses the explicit non-interactive approval decision when provided", async () => {
    await expect(chooseDecision(
      { interactive: false, decision: "rejected" },
      { approval_id: "ap_1", kind: "merge_approval" },
    )).resolves.toBe("rejected");
  });

  it("delegates interactive approval prompting to the provided prompt function", async () => {
    const seen: Array<{ approval_id: string; kind?: string }> = [];
    const decision = await chooseDecision(
      { interactive: true, decision: undefined },
      { approval_id: "ap_2", kind: "merge_approval" },
      async (approval) => {
        seen.push(approval);
        return "rejected";
      },
    );

    expect(decision).toBe("rejected");
    expect(seen).toEqual([{ approval_id: "ap_2", kind: "merge_approval" }]);
  });

  it("formats raw/debug wire frames without dropping event fields", () => {
    const line = formatRawFrame("out", {
      jsonrpc: "2.0",
      method: "events.event",
      params: {
        seq: 7,
        category: "consensus",
        payload: { outcome: "approve" },
      },
    });

    expect(line).toContain("raw out:");
    expect(line).toContain("\"method\":\"events.event\"");
    expect(line).toContain("\"seq\":7");
    expect(line).toContain("\"category\":\"consensus\"");
    expect(line).toContain("\"payload\":{\"outcome\":\"approve\"}");
  });
});
