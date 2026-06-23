import { describe, it, expect } from "vitest";
import { negotiateCapabilities } from "./capabilities.js";
import type { CapabilityMap } from "./capabilities.js";
import { HOLP_ERROR_CODES } from "./errors.js";

describe("negotiateCapabilities (spec §2)", () => {
  it("effective = client.supported && server.supported", () => {
    const client: CapabilityMap = {
      consensus: { supported: true },
      approval: { supported: false },
      unattended_loop: { supported: true },
      artifact_refs: { supported: true },
      gate_report: { supported: true },
      dynamic_workflow: { supported: true },
    };
    const server: CapabilityMap = {
      consensus: { supported: true },
      approval: { supported: true },
      unattended_loop: { supported: false },
      artifact_refs: { supported: true },
      gate_report: { supported: true },
      dynamic_workflow: { supported: false },
    };
    const out = negotiateCapabilities(client, server);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.negotiated.consensus.supported).toBe(true); // true && true
    expect(out.negotiated.approval.supported).toBe(false); // false && true
    expect(out.negotiated.unattended_loop.supported).toBe(false); // true && false
    expect(out.negotiated.artifact_refs.supported).toBe(true);
    expect(out.negotiated.gate_report.supported).toBe(true);
    expect(out.negotiated.dynamic_workflow.supported).toBe(false);
  });

  it("absent descriptor is treated as { supported:false }", () => {
    const out = negotiateCapabilities({}, { consensus: { supported: true } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.negotiated.consensus.supported).toBe(false);
    expect(out.negotiated.gate_report.supported).toBe(false);
    expect(out.negotiated.dynamic_workflow.supported).toBe(false);
  });

  it("client required:true but server supported:false → capability_required_but_unsupported", () => {
    const out = negotiateCapabilities(
      { consensus: { supported: true, required: true } },
      { consensus: { supported: false } },
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe(HOLP_ERROR_CODES.capability_required_but_unsupported);
    expect(out.error.data).toMatchObject({ capability: "consensus", requiredBy: "client" });
  });

  it("server required:true but client supported:false → capability_required_but_unsupported", () => {
    const out = negotiateCapabilities(
      { unattended_loop: { supported: false } },
      { unattended_loop: { supported: true, required: true } },
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe(HOLP_ERROR_CODES.capability_required_but_unsupported);
    expect(out.error.data).toMatchObject({ capability: "unattended_loop", requiredBy: "server" });
  });

  it("approval.kinds is intersected", () => {
    const out = negotiateCapabilities(
      { approval: { supported: true, kinds: ["merge_approval", "budget_exceeded", "x"] } },
      { approval: { supported: true, kinds: ["merge_approval", "budget_exceeded"] } },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.negotiated.approval.kinds).toEqual(["merge_approval", "budget_exceeded"]);
  });

  it("approval required with empty kinds intersection → reject", () => {
    const out = negotiateCapabilities(
      { approval: { supported: true, required: true, kinds: ["semantic_decision"] } },
      { approval: { supported: true, kinds: ["merge_approval"] } },
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe(HOLP_ERROR_CODES.capability_required_but_unsupported);
    expect(out.error.data).toMatchObject({ reason: "empty_kinds_intersection" });
  });

  it("approval NOT required with empty kinds intersection → no reject, kinds:[]", () => {
    const out = negotiateCapabilities(
      { approval: { supported: true, kinds: ["semantic_decision"] } },
      { approval: { supported: true, kinds: ["merge_approval"] } },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.negotiated.approval.kinds).toEqual([]);
  });
});
