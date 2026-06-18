import { describe, expect, it } from "vitest";
import { ConnectionContext } from "./context.js";
import { EventBus } from "./eventBus.js";
import { FakeClock } from "./clock.js";
import { driveRun } from "./runEngine.js";
import type { RunRecord } from "./stores.js";
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
} from "../../adapters/agent-backend.js";

describe("driveRun real-backend event forwarding", () => {
  it("forwards model/generic events and does not synthesize a fake artifact without fs-edit diff", async () => {
    const clock = new FakeClock();
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

    await driveRun(run, backend, ctx, clock);

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
});

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
