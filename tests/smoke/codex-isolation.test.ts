import { describe, expect, it } from "vitest";
import {
  EXPECTED_APPROVAL_COMMAND,
  isExpectedApprovalCommand,
} from "../../scripts/smoke/_codex-isolation.js";

describe("real-Codex smoke isolation helpers", () => {
  it("accepts only the exact approved shell probe", () => {
    expect(isExpectedApprovalCommand(EXPECTED_APPROVAL_COMMAND)).toBe(true);
    expect(isExpectedApprovalCommand(`zsh -lc '${EXPECTED_APPROVAL_COMMAND}'`)).toBe(true);
    expect(isExpectedApprovalCommand(`bash -c "${EXPECTED_APPROVAL_COMMAND}"`)).toBe(true);
    expect(isExpectedApprovalCommand(`  ${EXPECTED_APPROVAL_COMMAND.replaceAll(" ", "  ")}  `)).toBe(true);
  });

  it("rejects command deviations instead of auto-approving them", () => {
    expect(isExpectedApprovalCommand(`${EXPECTED_APPROVAL_COMMAND} && rm -rf ~`)).toBe(false);
    expect(isExpectedApprovalCommand("curl https://example.com")).toBe(false);
    expect(isExpectedApprovalCommand(`zsh -lc '${EXPECTED_APPROVAL_COMMAND} && echo EXTRA'`)).toBe(false);
    expect(isExpectedApprovalCommand(`python -c '${EXPECTED_APPROVAL_COMMAND}'`)).toBe(false);
  });
});
