import { describe, expect, it } from "vitest";
import { ConnectionContext } from "./context.js";
import { FakeClock } from "./clock.js";
import {
  createReviewerExecutor,
  parseReviewerJsonOutput,
  reviewerResultFromRawOutput,
  type ReviewerExecutionAttestation,
} from "./reviewer.js";
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
} from "../../adapters/agent-backend.js";
import type { RuntimeSelectionMetadata } from "../../adapters/harness-declaration.js";

const passingAttestation: ReviewerExecutionAttestation = {
  enforced_read_only: true,
  tool_policy: "deny_all_permission_requests",
  deny_write_check: "passed",
  review_input_source: "artifact_snapshot",
  sandbox: "read-only",
};

const readyRuntime: RuntimeSelectionMetadata = {
  agent_id: "realish",
  transport: "mcp-codex",
  runtime_surface: "headless",
  runtime_kind: "app_server",
  isolation_profile: "read_only_review",
  isolation_status: "ready",
  global_mutation_required: false,
  declared_not_enforced: false,
};

const degradedRuntime: RuntimeSelectionMetadata = {
  ...readyRuntime,
  isolation_status: "degraded",
  isolation_reason: "read_only_not_enforced",
  isolation_missing: ["read_only_enforcement"],
  isolation_warnings: ["declared_not_enforced"],
  declared_not_enforced: true,
};

describe("canonical reviewer output parser", () => {
  it("accepts strict JSON reviewer output with explicit verdict, severity, and findings", () => {
    expect(parseReviewerJsonOutput(JSON.stringify({
      verdict: "request_changes",
      max_severity: "P1",
      findings: [{ title: "Fix this" }],
    }))).toEqual({
      ok: true,
      output: {
        verdict: "request_changes",
        max_severity: "P1",
        findings: [{ title: "Fix this" }],
      },
    });
  });

  it.each([
    ["", "empty_reviewer_output"],
    ["No issues found.", "reviewer_output_not_strict_json"],
    [`Here:\n${JSON.stringify({ verdict: "approve", max_severity: "NONE", findings: [] })}`, "reviewer_output_not_strict_json"],
    [JSON.stringify([]), "reviewer_output_not_json_object"],
    [JSON.stringify({ max_severity: "NONE", findings: [] }), "missing_verdict"],
    [JSON.stringify({ verdict: "APPROVE", max_severity: "NONE", findings: [] }), "invalid_verdict"],
    [JSON.stringify({ verdict: "approve", findings: [] }), "missing_max_severity"],
    [JSON.stringify({ verdict: "approve", max_severity: "low", findings: [] }), "invalid_max_severity"],
    [JSON.stringify({ verdict: "approve", max_severity: "NONE" }), "missing_findings"],
    [JSON.stringify({ verdict: "approve", max_severity: "NONE", findings: {} }), "invalid_findings"],
  ])("fails closed for %s", (raw, reason) => {
    expect(parseReviewerJsonOutput(raw)).toEqual({ ok: false, reason });
  });
});

describe("reviewer result validation", () => {
  it("requires read-only execution attestation before returning a completed vote", () => {
    const ctx = new ConnectionContext();
    const clock = new FakeClock();
    const result = reviewerResultFromRawOutput({
      agent: "codex-reviewer",
      rawText: JSON.stringify({
        verdict: "approve",
        max_severity: "NONE",
        findings: [],
      }),
      attestation: { ...passingAttestation, enforced_read_only: false },
      runId: "run_1",
      ctx,
      clock,
      generatedBy: "test",
    });

    expect(result).toEqual({
      agent: "codex-reviewer",
      status: "error",
      reason: "read_only_attestation_failed",
    });
  });

  it("uses the same parser for backend reviewer execution and records reviewer decisions", async () => {
    const ctx = new ConnectionContext();
    const clock = new FakeClock();
    ctx.initialized = {
      protocolVersion: "0.1.4",
      clientName: "reviewer-test",
      clientVersion: "0",
      negotiated: {
        consensus: { supported: true },
        approval: { supported: true, kinds: ["merge_approval"] },
        artifact_refs: { supported: false },
        unattended_loop: { supported: false },
      },
    };
    ctx.artifacts.set("art_diff_run_1", {
      envelope: {
        artifact_id: "art_diff_run_1",
        type: "diff",
        mime: "text/x-diff",
        size: 8,
        sha256: "hash",
        created_by: "test",
        created_at: clock.now(),
      },
      content: "diff --x",
    });

    const executor = createReviewerExecutor([
      {
        agent_id: "realish",
        transport: "mcp-codex",
        mode: "backend",
        runtime: readyRuntime,
        backendFactory: () => new OutputBackend([
          {
            type: "model-output",
            fullText: JSON.stringify({
              verdict: "reject",
              max_severity: "P0",
              findings: [{ title: "broken" }],
            }),
          },
        ]),
        sandbox: "read-only",
      },
    ]);

    const results = await executor({
      runId: "run_1",
      goal: "review it",
      artifactId: "art_diff_run_1",
      agents: ["realish"],
      ctx,
      clock,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      agent: "realish",
      status: "completed",
      verdict: "reject",
      max_severity: "P0",
    });
    expect(ctx.governance.decisions).toContainEqual(expect.objectContaining({
      decision_type: "reviewer_execution",
      agent_id: "realish",
      reason: "reject",
    }));
  });

  it("fails closed when backend reviewer runtime is degraded/not enforced", async () => {
    const ctx = contextWithArtifact(clockNow());
    const executor = createReviewerExecutor([
      {
        agent_id: "degraded",
        transport: "mcp-codex",
        mode: "backend",
        runtime: { ...degradedRuntime, agent_id: "degraded" },
        backendFactory: () => new OutputBackend([
          {
            type: "model-output",
            fullText: JSON.stringify({
              verdict: "approve",
              max_severity: "NONE",
              findings: [],
            }),
          },
        ]),
        sandbox: "read-only",
      },
    ]);

    const results = await executor({
      runId: "run_1",
      goal: "review it",
      artifactId: "art_diff_run_1",
      agents: ["degraded"],
      ctx: ctx.ctx,
      clock: ctx.clock,
    });

    expect(results).toEqual([
      { agent: "degraded", status: "error", reason: "read_only_attestation_failed" },
    ]);
  });

  it("fails closed when backend reviewer emits non-JSON prose", async () => {
    const ctx = contextWithArtifact(clockNow());
    const executor = createReviewerExecutor([
      {
        agent_id: "realish",
        transport: "mcp-codex",
        mode: "backend",
        runtime: readyRuntime,
        backendFactory: () => new OutputBackend([
          { type: "model-output", fullText: "Looks good to me." },
        ]),
        sandbox: "read-only",
      },
    ]);

    const results = await executor({
      runId: "run_1",
      goal: "review it",
      artifactId: "art_diff_run_1",
      agents: ["realish"],
      ctx: ctx.ctx,
      clock: ctx.clock,
    });

    expect(results).toEqual([
      { agent: "realish", status: "error", reason: "reviewer_output_not_strict_json" },
    ]);
  });

  it("maps backend reviewer timeout to a non-completed reviewer result", async () => {
    const ctx = new ConnectionContext();
    const clock = new FakeClock();
    ctx.artifacts.set("art_diff_run_1", {
      envelope: {
        artifact_id: "art_diff_run_1",
        type: "diff",
        mime: "text/x-diff",
        size: 8,
        sha256: "hash",
        created_by: "test",
        created_at: clock.now(),
      },
      content: "diff --x",
    });

    const executor = createReviewerExecutor([
      {
        agent_id: "slow",
        transport: "mcp-codex",
        mode: "backend",
        runtime: { ...readyRuntime, agent_id: "slow" },
        backendFactory: () => new HangingBackend(),
        sandbox: "read-only",
      },
    ], { reviewerTimeoutMs: 1, totalBudgetMs: 100 });

    const results = await executor({
      runId: "run_1",
      goal: "review it",
      artifactId: "art_diff_run_1",
      agents: ["slow"],
      ctx,
      clock,
    });

    expect(results).toEqual([
      { agent: "slow", status: "timeout", reason: "reviewer_timeout" },
    ]);
  });

  it("preserves completed reviews when total review budget times out pending reviewers", async () => {
    const ctx = contextWithArtifact(clockNow());
    const executor = createReviewerExecutor([
      {
        agent_id: "fast",
        transport: "mcp-codex",
        mode: "backend",
        runtime: { ...readyRuntime, agent_id: "fast" },
        backendFactory: () => new OutputBackend([
          {
            type: "model-output",
            fullText: JSON.stringify({
              verdict: "approve",
              max_severity: "NONE",
              findings: [],
            }),
          },
        ]),
        sandbox: "read-only",
      },
      {
        agent_id: "slow",
        transport: "mcp-codex",
        mode: "backend",
        runtime: { ...readyRuntime, agent_id: "slow" },
        backendFactory: () => new HangingBackend(),
        sandbox: "read-only",
      },
    ], { reviewerTimeoutMs: 100, totalBudgetMs: 1 });

    const results = await executor({
      runId: "run_1",
      goal: "review it",
      artifactId: "art_diff_run_1",
      agents: ["fast", "slow"],
      ctx: ctx.ctx,
      clock: ctx.clock,
    });

    expect(results).toEqual([
      expect.objectContaining({
        agent: "fast",
        status: "completed",
        verdict: "approve",
      }),
      { agent: "slow", status: "timeout", reason: "total_review_budget_exhausted" },
    ]);
  });
});

function clockNow(): FakeClock {
  return new FakeClock();
}

function contextWithArtifact(clock: FakeClock): { ctx: ConnectionContext; clock: FakeClock } {
  const ctx = new ConnectionContext();
  ctx.artifacts.set("art_diff_run_1", {
    envelope: {
      artifact_id: "art_diff_run_1",
      type: "diff",
      mime: "text/x-diff",
      size: 8,
      sha256: "hash",
      created_by: "test",
      created_at: clock.now(),
    },
    content: "diff --x",
  });
  return { ctx, clock };
}

class OutputBackend implements AgentBackend {
  private handlers: AgentMessageHandler[] = [];

  constructor(private readonly messages: readonly AgentMessage[]) {}

  async startSession(): Promise<{ sessionId: string }> {
    return { sessionId: "review-session" };
  }

  async sendPrompt(): Promise<void> {
    for (const message of this.messages) {
      for (const handler of this.handlers) handler(message);
    }
  }

  async cancel(): Promise<void> {}

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers = this.handlers.filter((candidate) => candidate !== handler);
  }

  async dispose(): Promise<void> {}
}

class HangingBackend implements AgentBackend {
  private resolvePrompt: (() => void) | undefined;

  async startSession(): Promise<{ sessionId: string }> {
    return { sessionId: "slow-session" };
  }

  async sendPrompt(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.resolvePrompt = resolve;
    });
  }

  async cancel(): Promise<void> {
    this.resolvePrompt?.();
  }

  onMessage(): void {}

  async dispose(): Promise<void> {
    this.resolvePrompt?.();
  }
}
