import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BANNED_AFFIRMATIVE_CLAIMS = [
  { label: "cmux-ready: true", pattern: /\bcmux-ready\s*[:=]\s*true\b/i },
  { label: "cmux ready: true", pattern: /\bcmux\s+ready\s*[:=]\s*true\b/i },
  { label: "claims cmux-ready", pattern: /\bclaims\s+cmux-ready\b/i },
  { label: "cmux ready ✅", pattern: /\bcmux\s+ready\s*✅/i },
  { label: "#41 data sufficiency: allowed", pattern: /#41\s+data\s+sufficiency\s*:\s*allowed\b/i },
  { label: "#41 is sufficient", pattern: /#41\s+is\s+sufficient\b/i },
  { label: "#36 ready", pattern: /#36\s+ready\b/i },
  { label: "learned model readiness: ready", pattern: /\blearned\s+model\s+readiness\s*:\s*ready\b/i },
] as const;

const HONEST_NEGATION_PATTERNS = [
  /does not claim cmux-ready/i,
  /must not claim cmux-ready/i,
  /cmux-ready remains false/i,
  /cmux-pending-user-validation/i,
] as const;

function readinessClaimViolations(text: string): string[] {
  return BANNED_AFFIRMATIVE_CLAIMS.flatMap((claim) => {
    const match = claim.pattern.exec(text);
    const index = match?.index ?? -1;
    if (index === -1) return [];
    const lineStart = text.lastIndexOf("\n", index) + 1;
    const lineEnd = text.indexOf("\n", index);
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    return HONEST_NEGATION_PATTERNS.some((pattern) => pattern.test(line)) ? [] : [claim.label];
  });
}

describe("Harness Workspace readiness claim guard", () => {
  it("fails affirmative readiness claim fixtures", () => {
    expect(readinessClaimViolations("cmux-ready: true")).toEqual(["cmux-ready: true"]);
    expect(readinessClaimViolations("cmux-ready=true")).toEqual(["cmux-ready: true"]);
    expect(readinessClaimViolations("cmux ready: true")).toEqual(["cmux ready: true"]);
    expect(readinessClaimViolations("#41 is sufficient")).toEqual(["#41 is sufficient"]);
    expect(readinessClaimViolations("learned model readiness: ready")).toEqual(["learned model readiness: ready"]);
  });

  it("allows honest negations and pending validation language", () => {
    expect(readinessClaimViolations("This does not claim cmux-ready.")).toEqual([]);
    expect(readinessClaimViolations("cmux-ready remains false until human validation.")).toEqual([]);
    expect(readinessClaimViolations("cmux product readiness: cmux-pending-user-validation")).toEqual([]);
  });

  it("keeps the human validation record pending until explicit human acceptance", () => {
    const text = readFileSync("docs/harness-workspace-user-validation.md", "utf8");
    const finalState = text.slice(text.indexOf("## Current Final State"));

    expect(readinessClaimViolations(text)).toEqual([]);
    expect(finalState).toContain("usable-ui-real-usage-data-collection: pending-user-validation");
    expect(finalState).not.toContain("usable-ui-real-usage-data-collection: allowed");
  });
});
