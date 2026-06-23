import { describe, expect, it } from "vitest";
import { ConnectionContext } from "./context.js";
import { EventBus } from "./eventBus.js";
import { FakeClock } from "./clock.js";
import { FakeScheduler } from "./scheduler.js";
import { driveRun } from "./runEngine.js";
import { claimTerminal } from "./terminalRun.js";
import { reviewerResultFromRawOutput } from "./reviewer.js";
import type { RunRecord } from "./stores.js";
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
} from "../../adapters/agent-backend.js";

describe("claimTerminal", () => {
  it("lets the first same-tick terminal claim win and makes later claims no-ops", () => {
    const clock = new FakeClock();
    const ctx = new ConnectionContext();
    const bus = new EventBus("run_terminal_claim", clock);
    const run = makeRun("run_terminal_claim", "terminal helper", bus);
    ctx.governance.ensureRunState(run.run_id, "queued", clock.now());
    ctx.governance.transitionRun(run.run_id, "running", clock.now(), "test_start");

    const firstClaim = claimTerminal(run, ctx, clock, {
      state: "merged",
      reason: "first",
      eventName: "run_merged",
      payload: { reason: "first" },
    });
    const secondClaim = claimTerminal(run, ctx, clock, {
      state: "blocked",
      reason: "second",
      eventName: "run_blocked",
      payload: { reason: "second" },
    });

    expect(firstClaim).toBe(true);
    expect(secondClaim).toBe(false);
    expect(run.status).toBe("merged");
    expect(bus.latestSeq).toBe(1);
    expect(bus.allEvents().map((event) => event.name)).toEqual(["run_merged"]);
    expect(
      ctx.governance.decisions.filter((decision) => decision.decision_type === "run_terminal"),
    ).toHaveLength(1);
  });
});

describe("driveRun real-backend event forwarding", () => {
  it("forwards model/generic events and does not synthesize a fake artifact without fs-edit diff", async () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const ctx = new ConnectionContext();
    const bus = new EventBus("run_real", clock);
    const run: RunRecord = {
      run_id: "run_real",
      goal: "say hello",
      trigger: "manual",
      status: "active",
      bus,
      pendingApprovals: new Set(),
      approvalSeq: 0,
    };
    const backend = new MessageBackend([
      { type: "status", status: "running" },
      { type: "model-output", textDelta: "hello" },
      { type: "event", name: "item/commandExecution/outputDelta", payload: { delta: "stdout" } },
      { type: "status", status: "idle" },
    ]);

    await driveRun(run, backend, ctx, clock, scheduler);

    const events = bus.allEvents();
    expect(events.map((event) => event.name)).toEqual([
      "run_started",
      "step_started",
      "model_output",
      "agent_event",
      "run_merged",
    ]);
    const merged = events.find((event) => event.name === "run_merged");
    expect(merged?.payload).toEqual({ reason: "run completed" });
    expect(ctx.artifacts.size).toBe(0);
  });

  it("emits run_gave_up when the backend rejects while waiting for approval", async () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const ctx = new ConnectionContext();
    const bus = new EventBus("run_waiting_reject", clock);
    const run = makeRun("run_waiting_reject", "approval then crash", bus);
    const backend = new LifecycleBackend(async () => {
      ctx.governance.transitionRun(run.run_id, "waiting_approval", clock.now(), "approval_requested");
      throw new Error("provider crashed while approval was pending");
    });

    await expect(driveRun(run, backend, ctx, clock, scheduler)).resolves.toBeUndefined();

    expect(run.status).toBe("gave_up");
    expect(bus.allEvents().map((event) => event.name)).toEqual(["run_started", "run_gave_up"]);
    expect(ctx.governance.runStates.get(run.run_id)?.history.map((entry) => entry.to)).toEqual([
      "queued",
      "running",
      "waiting_approval",
      "gave_up",
    ]);
  });

  it("emits run_merged when the backend completes while governance is waiting for approval", async () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const ctx = new ConnectionContext();
    const bus = new EventBus("run_waiting_complete", clock);
    const run = makeRun("run_waiting_complete", "approval then complete", bus);
    const backend = new LifecycleBackend(async () => {
      ctx.governance.transitionRun(run.run_id, "waiting_approval", clock.now(), "approval_requested");
    });

    await expect(driveRun(run, backend, ctx, clock, scheduler)).resolves.toBeUndefined();

    expect(run.status).toBe("merged");
    expect(bus.allEvents().map((event) => event.name)).toEqual(["run_started", "run_merged"]);
    expect(ctx.governance.runStates.get(run.run_id)?.history.map((entry) => entry.to)).toEqual([
      "queued",
      "running",
      "waiting_approval",
      "merged",
    ]);
  });

  it("does not emit run_merged when an external terminal claim wins while sendPrompt is pending", async () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const ctx = new ConnectionContext();
    const bus = new EventBus("run_late_completion", clock);
    const run = makeRun("run_late_completion", "late backend completion", bus);
    const backend = new PendingPromptBackend();

    const drive = driveRun(run, backend, ctx, clock, scheduler);
    await backend.waitForPrompt();

    expect(claimTerminal(run, ctx, clock, {
      state: "blocked",
      reason: "approval_timeout_auto_reject",
      eventName: "run_blocked",
      payload: { reason: "approval_timeout_auto_reject" },
    })).toBe(true);

    backend.completePrompt();
    await expect(drive).resolves.toBeUndefined();

    expect(run.status).toBe("blocked");
    expect(bus.allEvents().map((event) => event.name)).toEqual(["run_started", "run_blocked"]);
    expect(bus.latestSeq).toBe(2);
    expect(
      ctx.governance.decisions.filter((decision) => decision.decision_type === "run_terminal"),
    ).toHaveLength(1);
    expect(
      ctx.governance.decisions.find((decision) => decision.decision_type === "run_terminal")?.reason,
    ).toBe("approval_timeout_auto_reject");
  });

  it("executes reviewer votes only after author exclusion", async () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler();
    const ctx = new ConnectionContext();
    ctx.initialized = {
      protocolVersion: "0.1.4",
      clientName: "run-engine-test",
      clientVersion: "0",
      negotiated: {
        consensus: { supported: true },
        approval: { supported: true, kinds: ["merge_approval"] },
        artifact_refs: { supported: false },
        unattended_loop: { supported: false },
      },
    };
    const bus = new EventBus("run_consensus", clock);
    const calledAgents: string[] = [];
    const run: RunRecord = {
      run_id: "run_consensus",
      goal: "produce a diff",
      trigger: "manual",
      status: "active",
      bus,
      consensus: {
        panel: [{ agent_id: "author" }, { agent_id: "r1" }],
        quorum: 1,
        policy: {
          exclude_author: true,
          author_provenance: "produced_by_agent_id",
          on_quorum_unsatisfiable: "reject",
        },
        producer_agent_id: "author",
      },
      reviewerExecutor: async (args) => {
        calledAgents.push(...args.agents);
        return args.agents.map((agent) =>
          reviewerResultFromRawOutput({
            agent,
            rawText: JSON.stringify({
              verdict: "approve",
              max_severity: "NONE",
              findings: [],
            }),
            attestation: {
              enforced_read_only: true,
              tool_policy: "test",
              deny_write_check: "passed",
              review_input_source: "artifact_snapshot",
            },
            runId: args.runId,
            ctx: args.ctx,
            clock: args.clock,
            generatedBy: "test",
          })
        );
      },
      pendingApprovals: new Set(),
      approvalSeq: 0,
    };
    const backend = new MessageBackend([
      {
        type: "fs-edit",
        description: "diff",
        diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
      },
    ]);

    await driveRun(run, backend, ctx, clock, scheduler);

    expect(calledAgents).toEqual(["r1"]);
    const verdict = bus.allEvents().find((event) => event.name === "consensus_verdict");
    expect(verdict?.payload).toMatchObject({
      excluded: [{ agent: "author", reason: "produced_by_agent_id (author)" }],
      reviews: [{ agent: "r1", status: "completed" }],
      quorum: { required: 1, eligible: 1, met: true },
    });
  });
});

function makeRun(runId: string, goal: string, bus: EventBus): RunRecord {
  return {
    run_id: runId,
    goal,
    trigger: "manual",
    status: "active",
    bus,
    pendingApprovals: new Set(),
    approvalSeq: 0,
  };
}

class MessageBackend implements AgentBackend {
  private handlers: AgentMessageHandler[] = [];

  constructor(private readonly messages: readonly AgentMessage[]) {}

  async startSession(): Promise<{ sessionId: string }> {
    return { sessionId: "real-session" };
  }

  async sendPrompt(): Promise<void> {
    for (const message of this.messages) {
      for (const handler of this.handlers) handler(message);
    }
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers = this.handlers.filter((candidate) => candidate !== handler);
  }

  async cancel(): Promise<void> {}

  async dispose(): Promise<void> {}
}

class LifecycleBackend implements AgentBackend {
  private handlers: AgentMessageHandler[] = [];

  constructor(private readonly onSendPrompt: () => Promise<void> | void) {}

  async startSession(): Promise<{ sessionId: string }> {
    return { sessionId: "lifecycle-session" };
  }

  async sendPrompt(): Promise<void> {
    await this.onSendPrompt();
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers = this.handlers.filter((candidate) => candidate !== handler);
  }

  async cancel(): Promise<void> {}

  async dispose(): Promise<void> {}
}

class PendingPromptBackend implements AgentBackend {
  private handlers: AgentMessageHandler[] = [];
  private promptStartedResolve!: () => void;
  private promptCompleteResolve!: () => void;
  private readonly promptStarted = new Promise<void>((resolve) => {
    this.promptStartedResolve = resolve;
  });
  private readonly promptComplete = new Promise<void>((resolve) => {
    this.promptCompleteResolve = resolve;
  });

  async startSession(): Promise<{ sessionId: string }> {
    return { sessionId: "pending-session" };
  }

  async sendPrompt(): Promise<void> {
    this.promptStartedResolve();
    await this.promptComplete;
  }

  waitForPrompt(): Promise<void> {
    return this.promptStarted;
  }

  completePrompt(): void {
    this.promptCompleteResolve();
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers = this.handlers.filter((candidate) => candidate !== handler);
  }

  async cancel(): Promise<void> {}

  async dispose(): Promise<void> {}
}
