import { describe, expect, it } from "vitest";
import { GovernanceStore } from "./governance.js";
import type { FlockAgent } from "./stores.js";
import { rejectedProfiles, withProfile } from "../../adapters/harness-declaration.js";

describe("GovernanceStore", () => {
  it("records internal events and decision_made records", () => {
    const store = new GovernanceStore();

    store.recordEvent("run_1", {
      seq: 1,
      ts: 100,
      category: "run",
      name: "run_started",
      payload: { ok: true },
    });
    store.recordDecision({
      decision_type: "run_accepted",
      run_id: "run_1",
      ts: 101,
      reason: "test",
    });

    expect(store.events).toEqual([
      {
        run_id: "run_1",
        seq: 1,
        ts: 100,
        category: "run",
        name: "run_started",
        payload: { ok: true },
      },
    ]);
    expect(store.decisions).toMatchObject([
      {
        decision_id: "dec_1",
        kind: "decision_made",
        decision_type: "run_accepted",
        run_id: "run_1",
        reason: "test",
      },
    ]);
  });

  it("accepts legal run state transitions and rejects illegal transitions", () => {
    const store = new GovernanceStore();

    store.ensureRunState("run_1", "queued", 1);
    store.transitionRun("run_1", "running", 2, "start");
    store.transitionRun("run_1", "waiting_approval", 3, "approval");
    store.transitionRun("run_1", "running", 4, "resolved");
    store.transitionRun("run_1", "merged", 5, "done");

    expect(store.runStates.get("run_1")?.state).toBe("merged");
    expect(store.runStates.get("run_1")?.history.map((entry) => entry.to)).toEqual([
      "queued",
      "running",
      "waiting_approval",
      "running",
      "merged",
    ]);
    expect(() => store.transitionRun("run_1", "running", 6, "too_late")).toThrow(
      "invalid run state transition merged -> running",
    );
  });

  it("flattens runtime surfaces and isolation profiles into harness registry records", () => {
    const profiles = withProfile(
      withProfile(rejectedProfiles("unsupported"), "coder_worktree", { readiness: "ready" }),
      "read_only_review",
      { readiness: "degraded", reason: "readonly_gap", warnings: ["declared_not_enforced"] },
    );
    const agent: FlockAgent = {
      id: "agent-1",
      transport: "fake",
      harness_id: "fake-harness",
      vendor: "Fake",
      transport_class: "fake",
      status: "ready",
      resolved_roles: ["coder", "reviewer"],
      runtime_surfaces: [
        {
          runtime_surface: "headless",
          runtime_kind: "fake-headless",
          actual_fidelity: "streaming_controlled",
          surface_support: "supported",
          isolation_profiles: profiles,
          state_declaration_ref: "harness-state:fake",
          global_mutation_required: false,
          declared_not_enforced: true,
        },
      ],
    };
    const store = new GovernanceStore();

    store.archiveHarnessAgent(agent, 10);

    expect(store.harnessRegistry).toHaveLength(6);
    expect(
      store.harnessRegistry.find((record) => record.isolation_profile === "coder_worktree"),
    ).toMatchObject({
      agent_id: "agent-1",
      runtime_surface: "headless",
      runtime_kind: "fake-headless",
      isolation_status: "ready",
      state_declaration_ref: "harness-state:fake",
    });
    expect(
      store.harnessRegistry.find((record) => record.isolation_profile === "read_only_review"),
    ).toMatchObject({
      isolation_status: "degraded",
      isolation_reason: "readonly_gap",
      isolation_warnings: ["declared_not_enforced"],
    });
  });

  it("archives missing runtime matrices as rejected missing declarations", () => {
    const store = new GovernanceStore();
    const agent: FlockAgent = {
      id: "agent-1",
      transport: "fake",
      status: "ready",
      resolved_roles: ["coder"],
    };

    store.archiveHarnessAgent(agent, 10);

    expect(store.harnessRegistry).toHaveLength(18);
    expect(store.harnessRegistry.every((record) => record.isolation_status === "rejected")).toBe(true);
    expect(store.harnessRegistry[0]).toMatchObject({
      runtime_kind: "missing_runtime_declaration",
      surface_support: "unknown",
      isolation_reason: "isolation_declaration_missing",
    });
  });
});
