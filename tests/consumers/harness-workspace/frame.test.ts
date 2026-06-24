import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ROLE_SKINS,
  cellWidth,
  computeFocusShellLayout,
  createHarnessWorkspaceState,
  createFocusShellViewState,
  deriveInspect,
  enterInspect,
  escapeToOverview,
  frame,
  harnessDiscoveryFixture,
  padEndCell,
  recordDiscovery,
  recordEvent,
  recordRunAccepted,
  reduceFocusShellViewState,
  renderFocusShell,
  select,
  stripAnsi,
  truncateCell,
  visibleFrameWidth,
} from "../../../consumers/harness-workspace/index.js";
import { buildFocusShellDemoModel } from "../../../consumers/harness-workspace/demo.js";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/;

describe("harness workspace focus shell frame", () => {
  it("renders deterministic non-empty overview output", () => {
    const model = buildFocusShellDemoModel({ locale: "en-US", mode: "overview" });
    const first = renderFocusShell(model, { width: 100, height: 28, noAnsi: true }).join("\n");
    const second = renderFocusShell(model, { width: 100, height: 28, noAnsi: true }).join("\n");

    expect(first).toBe(second);
    expect(first).toContain("HOLP Harness Workspace");
    expect(first).toContain("Sidecar Overview");
    expect(first).toContain("Worker preview");
    expect(first).toContain("Provenance smoke_script");
    expect(first.trim().length).toBeGreaterThan(0);
  });

  it("renders inspect through the same shell and tolerates unknown selected agent", () => {
    const model = buildFocusShellDemoModel({ locale: "en-US", mode: "inspect", agent: "missing-agent" });
    const output = renderFocusShell(model, { width: 96, height: 24, noAnsi: true }).join("\n");

    expect(output).toContain("Inspect missing-agent");
    expect(output).toContain("No selected agent evidence");
    expect(output).toContain("Sidecar");
    expect(output).toContain("Provenance smoke_script");
  });

  it("renders selected-worker inspect output without showing it under another agent", () => {
    const worker = renderFocusShell(buildFocusShellDemoModel({ locale: "en-US", mode: "inspect", agent: "coder-1" }), {
      width: 100,
      height: 28,
      noAnsi: true,
    }).join("\n");
    const reviewer = renderFocusShell(buildFocusShellDemoModel({ locale: "en-US", mode: "inspect", agent: "reviewer-1" }), {
      width: 100,
      height: 28,
      noAnsi: true,
    }).join("\n");

    expect(worker).toContain("Output model_output.*=Rendering Focus Shell");
    expect(reviewer).toContain("Output model_output.*=no model_output captured for this agent");
    expect(reviewer).not.toContain("Rendering Focus Shell");
  });

  it("renders cancel capability as a token without a runnable kill command", () => {
    const supported = renderFocusShell(buildFocusShellDemoModel({ locale: "en-US", mode: "inspect", agent: "coder-1" }), {
      width: 100,
      height: 28,
      noAnsi: true,
    }).join("\n");
    const unavailable = renderFocusShell(buildFocusShellDemoModel({ locale: "en-US", mode: "inspect", agent: "reviewer-1" }), {
      width: 100,
      height: 28,
      noAnsi: true,
    }).join("\n");

    expect(supported).toContain("cancel=cancel: supported");
    expect(unavailable).toContain("cancel=cancel: unavailable");
    expect(`${supported}\n${unavailable}`).not.toMatch(/\b(?:kill|pkill|killall)\b/);
  });

  it("computes controller, sidecar, and status regions with external controller passthrough", () => {
    const layout = computeFocusShellLayout({ cols: 100, rows: 28 });

    expect(layout.controllerRegion).toMatchObject({
      name: "controller",
      left: 0,
      top: 0,
      external: true,
    });
    expect(layout.sidecarRegion.name).toBe("sidecar");
    expect(layout.statusRegion).toMatchObject({
      name: "status",
      top: 27,
      width: 100,
      height: 1,
    });
  });

  it("supports NO_COLOR and no-ansi plain output while ANSI mode includes SGR codes", () => {
    const model = buildFocusShellDemoModel({ locale: "en-US", mode: "overview" });

    expect(renderFocusShell(model, { width: 80, height: 20, noAnsi: true }).join("\n")).not.toMatch(ANSI_PATTERN);
    expect(renderFocusShell(model, { width: 80, height: 20, env: { NO_COLOR: "1" }, ansi: true }).join("\n")).not.toMatch(ANSI_PATTERN);
    expect(renderFocusShell(model, { width: 80, height: 20, isTTY: false }).join("\n")).not.toMatch(ANSI_PATTERN);
    expect(renderFocusShell(model, { width: 80, height: 20, ansi: true }).join("\n")).toMatch(ANSI_PATTERN);
  });

  it("truncates and pads CJK labels by terminal cells", () => {
    expect(cellWidth("证据ab")).toBe(6);
    expect(padEndCell("证据", 6)).toBe("证据  ");

    const truncated = truncateCell("证据abcdef", 6);
    expect(cellWidth(truncated)).toBeLessThanOrEqual(6);
    expect(truncated).toBe("证...");
  });

  it("degrades gracefully at narrow width and short height", () => {
    const model = buildFocusShellDemoModel({ locale: "zh-CN", mode: "overview" });
    const lines = renderFocusShell(model, { width: 32, height: 6, noAnsi: true });

    expect(lines).toHaveLength(6);
    expect(visibleFrameWidth(lines)).toBeLessThanOrEqual(32);
    expect(lines.join("\n")).toContain("Provenance");
  });

  it("does not exceed tiny caller-provided dimensions", () => {
    const model = buildFocusShellDemoModel({ locale: "en-US", mode: "overview" });
    const lines = renderFocusShell(model, { width: 10, height: 2, noAnsi: true });

    expect(lines.length).toBeLessThanOrEqual(2);
    expect(visibleFrameWidth(lines)).toBeLessThanOrEqual(10);
  });

  it("keeps zh-CN inspect title border within constrained width", () => {
    const model = buildFocusShellDemoModel({ locale: "zh-CN", mode: "inspect", agent: "coder-1" });
    const lines = renderFocusShell(model, { width: 36, height: 8, noAnsi: true });
    const topBorder = stripAnsi(lines[0] ?? "");

    expect(cellWidth(topBorder)).toBeLessThanOrEqual(36);
    expect(topBorder).toContain("┐");
    expect(topBorder.endsWith("...")).toBe(false);
  });

  it("keeps role accents visually distinct for each shell role", () => {
    const model = buildFocusShellDemoModel({ locale: "en-US", mode: "overview" });
    const output = renderFocusShell(model, { width: 100, height: 28, ansi: true }).join("\n");

    for (const role of ["CTRL", "CODE", "TEST", "REV", "ARCH", "GATE"] as const) {
      expect(output).toContain(role);
      expect(ROLE_SKINS[role].accent).toBeTruthy();
    }

    const sgrCodes = [...output.matchAll(/\x1b\[([0-9;]+)m/g)].map((match) => match[1]);
    expect(new Set(sgrCodes).size).toBeGreaterThanOrEqual(6);
  });

  it("shows status bar run identity, runtime surface, mode, and safe hints", () => {
    const model = buildFocusShellDemoModel({ locale: "en-US", mode: "inspect", agent: "coder-1" });
    const lines = renderFocusShell(model, { width: 100, height: 28, noAnsi: true });
    const status = lines.at(-1) ?? "";

    expect(status).toContain("run_id=run_72_demo");
    expect(status).toContain("runtime=direct_user_session");
    expect(status).toContain("mode=inspect");
    expect(status).toContain("hints=q/esc safe");
    expect(status).toContain("controller=external");
  });

  it("renders evidence, gate, failure, worker preview, and provenance rows in every default frame", () => {
    const model = buildFocusShellDemoModel({ locale: "en-US", mode: "overview" });
    const output = renderFocusShell(model, { width: 100, height: 28, noAnsi: true }).join("\n");

    expect(output).toContain("Evidence run_id=run_72_demo");
    expect(output).toContain("Gate gate_report approved approve");
    expect(output).toContain("Failures none");
    expect(output).toContain("Worker preview");
    expect(output).toContain("Provenance smoke_script");
  });

  it("renders approval states and bounded evidence refs in inspect frames", () => {
    const states = [
      ["approval_requested", "approval_requested approval_id=ap_1"],
      ["approval_resolved", "approval_resolved approval_id=ap_1 decision=approve"],
      ["approval_expired", "approval_expired approval_id=ap_1"],
      ["approval_cancelled", "approval_cancelled approval_id=ap_1"],
    ] as const;

    for (const [eventName, expected] of states) {
      let state = recordRunAccepted(
        recordDiscovery(createHarnessWorkspaceState(), harnessDiscoveryFixture),
        {
          run_id: "run_71",
          runtime: { agent_id: "coder-1", runtime_surface: "direct_user_session" },
        },
      );
      state = recordEvent(state, frame(1, eventName, {
        approval_id: "ap_1",
        decision: eventName === "approval_resolved" ? "approve" : undefined,
      }));
      const output = renderFocusShell(deriveInspect(state, "coder-1"), { width: 110, height: 28, noAnsi: true }).join("\n");

      expect(output).toContain(expected);
      expect(output).toContain(`approval.${eventName}#1`);
      expect(output).not.toContain("\"approval_id\"");
    }
  });

  it("renders zh-CN gate and terminal failure explanations with raw reason tokens preserved", () => {
    let state = recordRunAccepted(
      recordDiscovery(createHarnessWorkspaceState({ locale: "zh-CN" }), harnessDiscoveryFixture),
      {
        run_id: "run_71",
        runtime: { agent_id: "coder-1", runtime_surface: "direct_user_session" },
      },
    );
    state = recordEvent(state, frame(1, "gate_report", {
      decision_surface: { gate_disposition: "blocked", review_outcome: "reject" },
      blocking_reason: "consensus_reject",
    }));
    state = recordEvent(state, frame(2, "run_blocked", { reason: "gate_blocked" }));

    const output = renderFocusShell(deriveInspect(state, "coder-1"), { width: 110, height: 28, noAnsi: true }).join("\n");

    expect(output).toContain("Gate 阻塞: consensus_reject");
    expect(output).toContain("运行被阻塞: gate_blocked");
    expect(output).toContain("run_id=run_71");
    expect(output).toContain("gate_report");
  });

  it("keeps selected-agent identity, failure reason, and provenance in constrained inspect frames", () => {
    let state = recordRunAccepted(
      recordDiscovery(createHarnessWorkspaceState(), harnessDiscoveryFixture),
      {
        run_id: "run_71",
        runtime: { agent_id: "coder-1", runtime_surface: "direct_user_session" },
      },
    );
    state = recordEvent(state, frame(1, "run_blocked", { reason: "gate_blocked" }));

    const output = renderFocusShell(deriveInspect(state, "coder-1"), { width: 72, height: 8, noAnsi: true }).join("\n");

    expect(output).toContain("Agent agent_id=coder-1");
    expect(output).toContain("Failure");
    expect(output).toContain("gate_blocked");
    expect(output).toContain("Provenance");
  });

  it("keeps zh-CN selected-agent identity, failure reason, and provenance in constrained inspect frames", () => {
    let state = recordRunAccepted(
      recordDiscovery(createHarnessWorkspaceState({ locale: "zh-CN" }), harnessDiscoveryFixture),
      {
        run_id: "run_71",
        runtime: { agent_id: "coder-1", runtime_surface: "direct_user_session" },
      },
    );
    state = recordEvent(state, frame(1, "run_blocked", { reason: "gate_blocked" }));

    const output = renderFocusShell(deriveInspect(state, "coder-1"), { width: 90, height: 8, noAnsi: true }).join("\n");

    expect(output).toContain("Agent agent_id=coder-1");
    expect(output).toContain("原因=运行被阻塞: gate_blocked");
    expect(output).toContain("Provenance");
  });

  it("uses compact survival rows for very tight inspect frames", () => {
    let state = recordRunAccepted(
      recordDiscovery(createHarnessWorkspaceState({ locale: "zh-CN" }), harnessDiscoveryFixture),
      {
        run_id: "run_71",
        runtime: { agent_id: "coder-1", runtime_surface: "direct_user_session" },
      },
    );
    state = recordEvent(state, frame(1, "run_blocked", { reason: "gate_blocked" }));

    const output = renderFocusShell(deriveInspect(state, "coder-1"), { width: 120, height: 5, noAnsi: true }).join("\n");

    expect(output).toContain("agent_id=coder-1");
    expect(output).toContain("gate_blocked");
    expect(output).toContain("Provenance");
  });

  it("keeps protocol anchors untranslated in zh-CN rendering", () => {
    const model = buildFocusShellDemoModel({ locale: "zh-CN", mode: "overview" });
    const output = renderFocusShell(model, { width: 100, height: 28, noAnsi: true }).join("\n");

    expect(output).toContain("run_id=run_72_demo");
    expect(output).toContain("direct_user_session");
    expect(output).toContain("model_output.text_delta");
    expect(output).toContain("gate_report");
    expect(output).toContain("链路");
  });

  it("round-trips view-state select, enterInspect, and escapeToOverview", () => {
    let state = createFocusShellViewState();
    state = reduceFocusShellViewState(state, select("coder-1"));
    state = reduceFocusShellViewState(state, enterInspect());

    expect(state).toEqual({ mode: "inspect", selectedAgentId: "coder-1" });

    state = reduceFocusShellViewState(state, escapeToOverview());
    expect(state).toEqual({ mode: "overview", selectedAgentId: "coder-1" });
  });

  it("demo command produces deterministic non-empty output and does not spawn daemon or controller CLI", () => {
    const first = execFileSync("npm", ["run", "harness:workspace", "--", "--no-ansi", "--width", "100", "--height", "28"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const second = execFileSync("npm", ["run", "harness:workspace", "--", "--no-ansi", "--width", "100", "--height", "28"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(first).toBe(second);
    expect(first).toContain("run_id=run_72_demo");
    expect(first).not.toMatch(ANSI_PATTERN);
    expect(stripAnsi(first).trim().length).toBeGreaterThan(0);

    const demoSource = readFileSync("consumers/harness-workspace/demo.ts", "utf8");
    expect(demoSource).not.toMatch(/\bspawn(?:Sync)?\b|\bexec(?:File|Sync)?\b|daemon\/runtime|consumers\/cmux-bridge/);
  });
});
