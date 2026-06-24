import { describe, expect, it } from "vitest";
import type { DaemonClient, EventFrame } from "../../consumers/cli/wire.js";
import {
  failureTransportFor,
  normalizeRuntimeSurface,
  runtimeSurfaceFromRunStarted,
  selectReadyAgent,
  successMarkers,
  terminalConsumerSmokeEnabled,
  waitForEventFromEvents,
} from "../../scripts/smoke/terminal-consumer.js";

describe("terminal consumer smoke helpers", () => {
  it("skips unless the real terminal consumer smoke opt-in is set", () => {
    expect(terminalConsumerSmokeEnabled({})).toBe(false);
    expect(terminalConsumerSmokeEnabled({ HOLP_TERMINAL_CONSUMER_SMOKE: "0" })).toBe(false);
    expect(terminalConsumerSmokeEnabled({ HOLP_TERMINAL_CONSUMER_SMOKE: "1" })).toBe(true);
  });

  it("normalizes runtime surface and rejects unknown values", () => {
    expect(normalizeRuntimeSurface(undefined)).toBe("acp");
    expect(normalizeRuntimeSurface("headless")).toBe("headless");
    expect(normalizeRuntimeSurface("acp")).toBe("acp");
    expect(normalizeRuntimeSurface("direct_user_session")).toBe("direct_user_session");
    expect(() => normalizeRuntimeSurface("websocket")).toThrow(/invalid HOLP_TERMINAL_CONSUMER_SURFACE/);
  });

  it("selects only a matching ready surface from flock.discover data", () => {
    const selection = selectReadyAgent([
      {
        id: "kimi-code-agent",
        status: "ready",
        runtime_surfaces: [
          {
            runtime_surface: "headless",
            isolation_profiles: { coder_worktree: { readiness: "ready" } },
          },
          {
            runtime_surface: "acp",
            state_declaration_ref: "harness-state:kimi-code-agent:acp",
            isolation_profiles: { coder_worktree: { readiness: "ready" } },
          },
        ],
      },
    ], "acp");

    expect(selection.agent.id).toBe("kimi-code-agent");
    expect(selection.surface.state_declaration_ref).toBe("harness-state:kimi-code-agent:acp");
  });

  it("does not treat another surface readiness as requested-surface readiness", () => {
    expect(() =>
      selectReadyAgent([
        {
          id: "kimi-code-agent",
          status: "ready",
          runtime_surfaces: [
            {
              runtime_surface: "headless",
              isolation_profiles: { coder_worktree: { readiness: "ready" } },
            },
            {
              runtime_surface: "acp",
              isolation_profiles: { coder_worktree: { readiness: "rejected", reason: "not_probed" } },
            },
          ],
        },
      ], "acp")
    ).toThrow(/no ready acp surface/);
  });

  it("reads surface match from the public run_started event payload", () => {
    const event: EventFrame = {
      run_id: "run_1",
      seq: 1,
      category: "run",
      name: "run_started",
      payload: { runtime: { runtime_surface: "acp" } },
    };
    expect(runtimeSurfaceFromRunStarted(event)).toBe("acp");
  });

  it("does not emit cmux-ready unless explicitly requested", () => {
    expect(successMarkers(false)).toContain("INFO cmux_status=cmux-pending-user-validation");
    expect(successMarkers(false).join("\n")).not.toContain("cmux-ready");
    expect(successMarkers(true)).toContain("INFO cmux_status=cmux-ready");
  });

  it("uses a deterministic non-selected failure transport", () => {
    expect(failureTransportFor("kimi-code")).toBe("cursor-agent");
    expect(failureTransportFor("cursor-agent")).toBe("reasonix");
    expect(failureTransportFor("kimi-code", "opencode")).toBe("opencode");
    expect(failureTransportFor("kimi-code", "kimi-code")).toBe("cursor-agent");
  });

  it("returns a matching event already collected before waiting", async () => {
    const runStarted: EventFrame = {
      run_id: "run_1",
      seq: 1,
      category: "run",
      name: "run_started",
      payload: {},
    };
    const fakeClient = {
      waitForEvent: () => Promise.reject(new Error("should not wait")),
    } as unknown as DaemonClient;

    const event = await waitForEventFromEvents(
      fakeClient,
      [runStarted],
      (e) => e.run_id === "run_1" && e.name === "run_started",
      "run_started",
    );
    expect(event).toBe(runStarted);
  });

  it("waits for a future event when no existing event matches", async () => {
    const terminal: EventFrame = {
      run_id: "run_2",
      seq: 3,
      category: "run",
      name: "run_cancelled",
      payload: {},
    };
    const fakeClient = {
      waitForEvent: (predicate: (event: EventFrame) => boolean) =>
        Promise.resolve(terminal).then((event) => {
          if (!predicate(event)) throw new Error("predicate mismatch");
          return event;
        }),
    } as unknown as DaemonClient;

    const event = await waitForEventFromEvents(
      fakeClient,
      [],
      (e) => e.run_id === "run_2" && e.name === "run_cancelled",
      "terminal event",
    );
    expect(event).toBe(terminal);
  });
});
