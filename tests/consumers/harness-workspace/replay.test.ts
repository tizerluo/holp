import { describe, expect, it } from "vitest";
import {
  createHarnessWorkspaceState,
  createReplaySnapshot,
  exportReplaySnapshotJson,
  frame,
  harnessDiscoveryFixture,
  importReplaySnapshotJson,
  recordDiscovery,
  recordEvent,
  recordRunAccepted,
  renderFocusShell,
  restoreReplaySnapshot,
} from "../../../consumers/harness-workspace/index.js";

function seededState(goal?: string) {
  return recordRunAccepted(
    recordDiscovery(createHarnessWorkspaceState(), harnessDiscoveryFixture),
    {
      run_id: "run_75",
      ...(goal ? { goal } : {}),
      runtime: {
        agent_id: "coder-1",
        runtime_surface: "direct_user_session",
        runtime_kind: "tmux",
        isolation_profile: "coder_worktree",
      },
    },
  );
}

describe("harness workspace replay snapshots", () => {
  it("exports, imports, and restores a replay-only render model", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "run_started", {
      runtime: { agent_id: "coder-1", runtime_surface: "direct_user_session" },
    }));
    state = recordEvent(state, frame(2, "agent_event", {
      name: "attach_target",
      payload: {
        agent_id: "coder-1",
        session_id: "holp-direct-75",
        attach_command: "tmux attach -t holp-direct-75",
      },
    }, "agent"));
    state = recordEvent(state, frame(3, "model_output", {
      full_text: "safe replay summary",
      provider_blob: "secret_provider_blob_must_not_export",
    }, "agent"));
    state = recordEvent(state, frame(4, "gate_report", {
      decision_surface: { gate_disposition: "approved", review_outcome: "approve" },
    }));
    state = recordEvent(state, frame(5, "run_merged", { artifact_id: "art_replay" }));

    const snapshot = createReplaySnapshot(state, {
      createdAt: "2026-06-25T01:02:03.000Z",
      inspectAgentId: "coder-1",
    });
    const json = exportReplaySnapshotJson(snapshot);
    const imported = importReplaySnapshotJson(json);
    const restored = restoreReplaySnapshot(imported);
    const output = renderFocusShell(restored.overview, { width: 140, height: 34, noAnsi: true }).join("\n");

    expect(imported.schema_version).toBe("HarnessReplaySnapshot.v1");
    expect(restored.overview.replay).toMatchObject({ status: "replay", created_at: "2026-06-25T01:02:03.000Z" });
    expect(restored.timeline.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(output).toContain("Replay replay created_at=2026-06-25T01:02:03.000Z");
    expect(output).toContain("Timeline info agent.model_output#3 model output captured");
    expect(output).toContain("Continuity continue=false");
    expect(output).toContain("Affordance Copy attach command=disabled");
    expect(output).toContain("Affordance Cancel run=needs_confirmation");
    expect(json).not.toContain("secret_provider_blob_must_not_export");
  });

  it("bounds exported summaries, evidence anchors, logs, previews, and JSON size", () => {
    let state = seededState();
    for (let seq = 10; seq >= 1; seq -= 1) {
      state = recordEvent(state, frame(seq, "model_output", {
        full_text: `abcdefghijklmnopqrstuvwxyz-${seq}`,
      }, "agent"));
    }

    const snapshot = createReplaySnapshot(state, {
      createdAt: "2026-06-25T00:00:00.000Z",
      eventLimit: 3,
      evidenceLimit: 2,
      logLimit: 4,
      previewLimit: 12,
    });

    expect(snapshot.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.evidence).toHaveLength(2);
    expect(snapshot.logs.entries).toHaveLength(4);
    expect(snapshot.events_truncated).toMatchObject({ truncated: true, reason: "event_summary_cap" });
    expect(snapshot.evidence_truncated).toMatchObject({ truncated: true, reason: "evidence_anchor_cap" });
    expect(snapshot.logs.truncated).toMatchObject({ truncated: true, reason: "log_entry_cap" });
    expect(snapshot.events.every((event) => (event.payload_preview?.length ?? 0) <= 12)).toBe(true);
    expect(() => exportReplaySnapshotJson(snapshot, { maxJsonSize: 64 })).toThrow(/size guard/);
  });

  it("fails closed on unknown schema, raw payloads, malformed events, oversized previews, and oversized import", () => {
    const snapshot = createReplaySnapshot(seededState(), {
      createdAt: "2026-06-25T00:00:00.000Z",
    });
    const raw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;

    expect(() => importReplaySnapshotJson(JSON.stringify({ ...raw, schema_version: "bad" }))).toThrow(/schema_version/);

    const withPayload = structuredClone(raw) as Record<string, unknown>;
    (withPayload.events as Array<Record<string, unknown>>).push({
      run_id: "run_75",
      seq: 99,
      category: "agent",
      name: "model_output",
      payload: { raw: true },
      payload_truncated: false,
    });
    expect(() => importReplaySnapshotJson(JSON.stringify(withPayload))).toThrow(/unknown field payload|unbounded payload|exceed cap/);

    const malformed = structuredClone(raw) as Record<string, unknown>;
    (malformed.events as Array<Record<string, unknown>>).push({
      run_id: "run_75",
      seq: "99",
      category: "agent",
      name: "model_output",
      payload_truncated: false,
    });
    expect(() => importReplaySnapshotJson(JSON.stringify(malformed))).toThrow(/seq/);

    const oversizedPreview = structuredClone(raw) as Record<string, unknown>;
    (oversizedPreview.events as Array<Record<string, unknown>>).push({
      run_id: "run_75",
      seq: 100,
      category: "agent",
      name: "model_output",
      payload_preview: "x".repeat(513),
      payload_truncated: true,
    });
    expect(() => importReplaySnapshotJson(JSON.stringify(oversizedPreview))).toThrow(/preview exceeds cap/);
    expect(() => importReplaySnapshotJson(JSON.stringify(raw), { maxJsonSize: 10 })).toThrow(/size guard/);
  });

  it("rejects unsafe imported affordance command text", () => {
    const snapshot = createReplaySnapshot(seededState(), {
      createdAt: "2026-06-25T00:00:00.000Z",
    });
    const raw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;

    const maliciousNonCopy = structuredClone(raw) as Record<string, unknown>;
    (maliciousNonCopy.operator_affordances as Array<Record<string, unknown>>).push({
      id: "cancel_run",
      label_key: "affordanceCancelRun",
      label: "Cancel run",
      state: "needs_confirmation",
      reason_key: "affordanceReasonCancelNeedsConfirmation",
      reason_label: "Cancel requires explicit future confirmation",
      confirmation_required: true,
      destructive: true,
      focus_changing: false,
      command_text: "kill -9 1",
    });
    expect(() => importReplaySnapshotJson(JSON.stringify(maliciousNonCopy))).toThrow(/command_text is only allowed/);

    const oversizedCopy = structuredClone(raw) as Record<string, unknown>;
    (oversizedCopy.operator_affordances as Array<Record<string, unknown>>).push({
      id: "copy_run_id",
      label_key: "affordanceCopyRunId",
      label: "Copy run ID",
      state: "enabled",
      reason_key: "affordanceReasonCopySource",
      reason_label: "Source evidence is available",
      confirmation_required: false,
      destructive: false,
      focus_changing: false,
      command_text: "x".repeat(513),
    });
    expect(() => importReplaySnapshotJson(JSON.stringify(oversizedCopy))).toThrow(/command_text exceeds cap/);
  });

  it("exports bounded log summaries and rejects malformed imported log entries", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "run_blocked", { reason: "x".repeat(700) }));
    const snapshot = createReplaySnapshot(state, {
      createdAt: "2026-06-25T00:00:00.000Z",
    });

    expect(snapshot.logs.entries[0]).toMatchObject({
      summary_truncated: true,
    });
    expect(snapshot.logs.entries[0]?.summary.length).toBe(512);

    const raw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;
    const malicious = structuredClone(raw) as Record<string, unknown>;
    (malicious.logs as { entries: Array<Record<string, unknown>> }).entries.push({
      run_id: "run_75",
      seq: 99,
      label: "run.run_blocked#99",
      category: "run",
      name: "run_blocked",
      severity: "error",
      summary: "y".repeat(513),
      payload: { raw: true },
    });
    expect(() => importReplaySnapshotJson(JSON.stringify(malicious))).toThrow(/unknown field payload|log entry contains unbounded payload|log entry summary exceeds cap|log entries exceed cap/);
  });

  it("caps event summaries and overview failure lines with explicit truncation markers", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "run_blocked", { reason: "x".repeat(700) }));
    const snapshot = createReplaySnapshot(state, {
      createdAt: "2026-06-25T00:00:00.000Z",
    });

    expect(snapshot.events[0]).toMatchObject({
      summary_truncated: true,
    });
    expect(snapshot.events[0]?.summary?.length).toBe(512);
    expect(snapshot.overview.failures[0]?.length).toBe(512);
    expect(snapshot.overview.failures_truncated).toMatchObject({
      truncated: true,
      reason: "overview_failure_string_cap",
    });
  });

  it("rejects oversized imported event summaries and overview failure strings", () => {
    const snapshot = createReplaySnapshot(recordEvent(seededState(), frame(1, "run_started", {})), {
      createdAt: "2026-06-25T00:00:00.000Z",
    });
    const raw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;

    const oversizedSummary = structuredClone(raw) as Record<string, unknown>;
    (oversizedSummary.events as Array<Record<string, unknown>>)[0] = {
      ...((oversizedSummary.events as Array<Record<string, unknown>>)[0] ?? {}),
      summary: "x".repeat(513),
    };
    expect(() => importReplaySnapshotJson(JSON.stringify(oversizedSummary))).toThrow(/event summary exceeds cap/);

    const oversizedFailure = structuredClone(raw) as Record<string, unknown>;
    (oversizedFailure.overview as Record<string, unknown>).failures = ["x".repeat(513)];
    expect(() => importReplaySnapshotJson(JSON.stringify(oversizedFailure))).toThrow(/overview failure exceeds cap/);
  });

  it("rejects provider blobs on sanitized event and log entries", () => {
    const snapshot = createReplaySnapshot(recordEvent(seededState(), frame(1, "run_started", {})), {
      createdAt: "2026-06-25T00:00:00.000Z",
    });
    const raw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;

    const eventBlob = structuredClone(raw) as Record<string, unknown>;
    (eventBlob.events as Array<Record<string, unknown>>)[0] = {
      ...((eventBlob.events as Array<Record<string, unknown>>)[0] ?? {}),
      provider_blob: "secret",
    };
    expect(() => importReplaySnapshotJson(JSON.stringify(eventBlob))).toThrow(/unknown field provider_blob/);

    const logBlob = structuredClone(raw) as Record<string, unknown>;
    (logBlob.logs as { entries: Array<Record<string, unknown>> }).entries.push({
      run_id: "run_75",
      seq: 99,
      label: "run.run_started#99",
      category: "run",
      name: "run_started",
      severity: "info",
      summary: "ok",
      provider_blob: "secret",
    });
    expect(() => importReplaySnapshotJson(JSON.stringify(logBlob))).toThrow(/unknown field provider_blob/);
  });

  it("caps overview evidence terminal reason and rejects oversized imported evidence", () => {
    const longReason = "terminal_reason_".repeat(60);
    let state = seededState();
    state = recordEvent(state, frame(1, "run_blocked", { reason: longReason }));
    const snapshot = createReplaySnapshot(state, {
      createdAt: "2026-06-25T00:00:00.000Z",
    });
    const json = exportReplaySnapshotJson(snapshot);

    expect(snapshot.overview.evidence.terminal?.reason?.length).toBe(512);
    expect(snapshot.overview.evidence_truncated).toMatchObject({
      truncated: true,
      reason: "overview_evidence_string_cap",
    });
    expect(json).not.toContain(longReason.slice(0, 600));

    const raw = JSON.parse(json) as Record<string, unknown>;
    const oversized = structuredClone(raw) as Record<string, unknown>;
    (((oversized.overview as Record<string, unknown>).evidence as Record<string, unknown>).terminal as Record<string, unknown>).reason = "x".repeat(513);
    expect(() => importReplaySnapshotJson(JSON.stringify(oversized))).toThrow(/terminal.reason exceeds cap/);
  });

  it("rejects forged imported continuity that overclaims continue", () => {
    const snapshot = createReplaySnapshot(recordEvent(seededState(), frame(1, "run_started", {})), {
      createdAt: "2026-06-25T00:00:00.000Z",
    });
    const raw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;
    raw.continuity = {
      ...(raw.continuity as Record<string, unknown>),
      run_id: "run_75",
      runtime_surface: "direct_user_session",
      worker_session: "holp-direct-75",
      attach_command: "tmux attach -t holp-direct-75",
      owner_verified: "verified",
      can_continue: true,
    };

    expect(() => importReplaySnapshotJson(JSON.stringify(raw))).toThrow(/can_continue is unsupported/);
  });

  it("exports replay continuity as importable replay-only state", () => {
    let state = seededState();
    state = recordEvent(state, frame(1, "agent_event", {
      name: "attach_target",
      payload: {
        agent_id: "coder-1",
        session_id: "holp-direct-75",
        attach_command: "tmux attach -t holp-direct-75",
      },
    }, "agent"));
    const snapshot = createReplaySnapshot(state, {
      createdAt: "2026-06-25T00:00:00.000Z",
    });

    expect(snapshot.continuity.can_continue).toBe(false);
    expect(snapshot.continuity.reasons).toContain("continue_disabled_in_replay_snapshot");
    expect(() => importReplaySnapshotJson(exportReplaySnapshotJson(snapshot))).not.toThrow();
  });

  it("preserves rerun command while keeping replay continue disabled", () => {
    let state = seededState("rerun 'me'");
    state = recordEvent(state, frame(1, "agent_event", {
      name: "attach_target",
      payload: {
        agent_id: "coder-1",
        session_id: "holp-direct-75",
        attach_command: "tmux attach -t holp-direct-75",
      },
    }, "agent"));
    const snapshot = createReplaySnapshot(state, {
      createdAt: "2026-06-25T00:00:00.000Z",
    });
    const imported = importReplaySnapshotJson(exportReplaySnapshotJson(snapshot));

    expect(imported.continuity).toMatchObject({
      can_continue: false,
      can_rerun: true,
      rerun_command: "holp run 'rerun '\\''me'\\''' --worker 'coder-1'",
    });
    expect(imported.continuity.reasons).not.toContain("rerun_goal_not_exported");
  });

  it("omits oversized replay rerun command instead of exporting an invalid snapshot", () => {
    const snapshot = createReplaySnapshot(seededState("x".repeat(600)), {
      createdAt: "2026-06-25T00:00:00.000Z",
    });
    const imported = importReplaySnapshotJson(exportReplaySnapshotJson(snapshot));

    expect(imported.continuity.can_rerun).toBe(false);
    expect(imported.continuity.rerun_command).toBeUndefined();
    expect(imported.continuity.reasons).toContain("rerun_command_exceeds_replay_cap");
  });

  it("rejects oversized continuity strings and reason strings", () => {
    const snapshot = createReplaySnapshot(recordEvent(seededState(), frame(1, "run_started", {})), {
      createdAt: "2026-06-25T00:00:00.000Z",
    });
    const raw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;
    (raw.continuity as Record<string, unknown>).attach_command = "x".repeat(513);
    expect(() => importReplaySnapshotJson(JSON.stringify(raw))).toThrow(/continuity.attach_command exceeds cap/);

    const rerunRaw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;
    (rerunRaw.continuity as Record<string, unknown>).rerun_command = "x".repeat(513);
    expect(() => importReplaySnapshotJson(JSON.stringify(rerunRaw))).toThrow(/continuity.rerun_command exceeds cap/);

    const reasonRaw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;
    (reasonRaw.continuity as Record<string, unknown>).reasons = ["x".repeat(513)];
    expect(() => importReplaySnapshotJson(JSON.stringify(reasonRaw))).toThrow(/continuity.reasons\[\] exceeds cap/);
  });

  it("rejects unknown continuity and inspect fields", () => {
    const snapshot = createReplaySnapshot(recordEvent(seededState(), frame(1, "run_started", {})), {
      createdAt: "2026-06-25T00:00:00.000Z",
      inspectAgentId: "coder-1",
    });
    const raw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;
    (raw.continuity as Record<string, unknown>).provider_blob = "secret";
    expect(() => importReplaySnapshotJson(JSON.stringify(raw))).toThrow(/continuity contains unknown field provider_blob/);

    const inspectRaw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;
    (inspectRaw.inspect as Record<string, unknown>).provider_blob = "secret";
    expect(() => importReplaySnapshotJson(JSON.stringify(inspectRaw))).toThrow(/inspect contains unknown field provider_blob/);
  });

  it("rejects oversized overview title and worker preview", () => {
    const snapshot = createReplaySnapshot(recordEvent(seededState(), frame(1, "run_started", {})), {
      createdAt: "2026-06-25T00:00:00.000Z",
    });
    const raw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;
    (raw.overview as Record<string, unknown>).title = "x".repeat(513);
    expect(() => importReplaySnapshotJson(JSON.stringify(raw))).toThrow(/overview.title exceeds cap/);

    const previewRaw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;
    (previewRaw.overview as Record<string, unknown>).worker_preview = "x".repeat(513);
    expect(() => importReplaySnapshotJson(JSON.stringify(previewRaw))).toThrow(/overview.worker_preview exceeds cap/);
  });

  it("rejects invalid or unbounded chain node shape", () => {
    const snapshot = createReplaySnapshot(recordEvent(seededState(), frame(1, "run_started", {})), {
      createdAt: "2026-06-25T00:00:00.000Z",
    });
    const raw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;
    ((raw.overview as Record<string, unknown>).chain as Array<Record<string, unknown>>)[0] = {
      id: "human",
      label: "human",
      skin: "CTRL",
      state: "active",
      provider_blob: "secret",
    };
    expect(() => importReplaySnapshotJson(JSON.stringify(raw))).toThrow(/chain node contains unknown field provider_blob/);

    const longRaw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;
    ((longRaw.overview as Record<string, unknown>).chain as Array<Record<string, unknown>>)[0] = {
      id: "x".repeat(513),
      label: "human",
      skin: "CTRL",
      state: "active",
    };
    expect(() => importReplaySnapshotJson(JSON.stringify(longRaw))).toThrow(/overview.chain\[\].id exceeds cap/);
  });

  it("rejects unsafe truncation marker shape", () => {
    const snapshot = createReplaySnapshot(recordEvent(seededState(), frame(1, "run_started", {})), {
      createdAt: "2026-06-25T00:00:00.000Z",
      eventLimit: 0,
    });
    const raw = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;
    raw.events_truncated = {
      truncated: true,
      reason: "x".repeat(513),
    };
    expect(() => importReplaySnapshotJson(JSON.stringify(raw))).toThrow(/events_truncated reason exceeds cap/);

    const unknown = JSON.parse(exportReplaySnapshotJson(snapshot)) as Record<string, unknown>;
    unknown.events_truncated = {
      truncated: true,
      reason: "event_summary_cap",
      provider_blob: "secret",
    };
    expect(() => importReplaySnapshotJson(JSON.stringify(unknown))).toThrow(/events_truncated contains unknown field provider_blob/);
  });
});
