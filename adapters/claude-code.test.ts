import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeCodeBackend,
  createClaudeCodeBackendFactory,
  probeClaudeCode,
} from "./claude-code.js";
import type { AgentMessage } from "./agent-backend.js";
import { ConnectionContext } from "../daemon/core/context.js";
import { FakeClock } from "../daemon/core/clock.js";
import { createReviewerExecutor } from "../daemon/core/reviewer.js";
import type { RuntimeSelectionMetadata } from "./harness-declaration.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ClaudeCodeBackend", () => {
  it("maps Claude Code json result to model output through AgentBackend", async () => {
    const script = makeFakeClaudeScript();
    const messages: AgentMessage[] = [];
    const backend = new ClaudeCodeBackend(
      { cwd: process.cwd() },
      { command: process.execPath, argsPrefix: [script], model: "fake-claude" },
    );
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, "review the artifact");
    await backend.dispose();

    expect(messages).toContainEqual({ type: "status", status: "starting" });
    expect(messages).toContainEqual({ type: "status", status: "running" });
    expect(messages).toContainEqual({
      type: "model-output",
      fullText: JSON.stringify({
        verdict: "approve",
        max_severity: "NONE",
        findings: [],
      }),
    });
    expect(messages).toContainEqual({ type: "status", status: "idle" });
  });

  it("fails closed when Claude Code outer json is malformed", async () => {
    const script = makeFakeClaudeScript("malformed");
    const backend = new ClaudeCodeBackend(
      { cwd: process.cwd() },
      { command: process.execPath, argsPrefix: [script], model: "fake-claude" },
    );

    const { sessionId } = await backend.startSession();
    await expect(backend.sendPrompt(sessionId, "review the artifact"))
      .rejects.toThrow("claude_outer_json_parse_failed");
    await backend.dispose();
  });
});

describe("probeClaudeCode", () => {
  it("declares native-claude headless read_only_review ready only with deny-write evidence", async () => {
    const script = makeFakeClaudeScript();
    const result = await probeClaudeCode({
      id: "claude-reviewer",
      transport: "native-claude",
      roles: ["reviewer"],
      cwd: process.cwd(),
    }, {
      command: process.execPath,
      argsPrefix: [script],
      model: "fake-claude",
      probeTimeoutMs: 1_000,
    });

    expect(result.status).toBe("ready");
    expect(result.resolved_roles).toEqual(["reviewer"]);
    const headless = result.runtime_surfaces?.find((surface) => surface.runtime_surface === "headless");
    expect(headless?.runtime_kind).toBe("claude_code_print_json");
    expect(headless?.actual_fidelity).toBe("one_shot");
    expect(headless?.surface_support).toBe("supported");
    expect(headless?.declared_not_enforced).toBe(false);
    expect(headless?.isolation_profiles.read_only_review.readiness).toBe("ready");
    expect(result.runtime_surfaces?.find((surface) => surface.runtime_surface === "acp")?.surface_support)
      .toBe("unsupported");
    expect(result.runtime_surfaces?.find((surface) => surface.runtime_surface === "direct_user_session")?.surface_support)
      .toBe("unknown");
  });

  it("keeps read_only_review degraded when deny-write evidence is missing", async () => {
    const script = makeFakeClaudeScript("no-denial");
    const result = await probeClaudeCode({
      id: "claude-reviewer",
      transport: "native-claude",
      roles: ["reviewer"],
      cwd: process.cwd(),
    }, {
      command: process.execPath,
      argsPrefix: [script],
      model: "fake-claude",
      probeTimeoutMs: 1_000,
    });

    const headless = result.runtime_surfaces?.find((surface) => surface.runtime_surface === "headless");
    expect(result.status).toBe("degraded");
    expect(result.reason).toBe("read_only_enforcement_not_proven");
    expect(headless?.declared_not_enforced).toBe(true);
    expect(headless?.isolation_profiles.read_only_review).toMatchObject({
      readiness: "degraded",
      missing: ["read_only_enforcement"],
    });
  });

  it("marks global mutation required when user/local settings are opted in", async () => {
    const script = makeFakeClaudeScript();
    const result = await probeClaudeCode({
      id: "claude-reviewer",
      transport: "native-claude",
      roles: ["reviewer"],
      cwd: process.cwd(),
    }, {
      command: process.execPath,
      argsPrefix: [script],
      model: "fake-claude",
      probeTimeoutMs: 1_000,
      settingSources: "project,user",
    });

    const headless = result.runtime_surfaces?.find((surface) => surface.runtime_surface === "headless");
    expect(result.global_mutation_required).toBe(true);
    expect(headless?.global_mutation_required).toBe(true);
  });

  it("fails closed when capability probe returns outer cli error json", async () => {
    const script = makeFakeClaudeScript("outer-error");
    const result = await probeClaudeCode({
      id: "claude-reviewer",
      transport: "native-claude",
      roles: ["reviewer"],
      cwd: process.cwd(),
    }, {
      command: process.execPath,
      argsPrefix: [script],
      model: "fake-claude",
      probeTimeoutMs: 1_000,
    });

    expect(result.status).toBe("degraded");
    expect(result.reason).toBe("claude_cli_auth_unavailable");
    expect(result.missing).toContain("capability_probe");
  });

  it("classifies Claude CLI rate limit errors for honest smoke diagnostics", async () => {
    const script = makeFakeClaudeScript("rate-limit");
    const result = await probeClaudeCode({
      id: "claude-reviewer",
      transport: "native-claude",
      roles: ["reviewer"],
      cwd: process.cwd(),
    }, {
      command: process.execPath,
      argsPrefix: [script],
      model: "fake-claude",
      probeTimeoutMs: 1_000,
    });

    expect(result.status).toBe("degraded");
    expect(result.reason).toBe("claude_cli_rate_limited");
  });
});

describe("Claude Code reviewer executor integration", () => {
  it("passes native-claude backend output through outer parse and PR9 reviewer validation", async () => {
    const script = makeFakeClaudeScript();
    const ctx = new ConnectionContext();
    const clock = new FakeClock();
    ctx.initialized = {
      protocolVersion: "0.1.4",
      clientName: "claude-reviewer-test",
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
    const runtime: RuntimeSelectionMetadata = {
      agent_id: "claude-reviewer",
      transport: "native-claude",
      runtime_surface: "headless",
      runtime_kind: "claude_code_print_json",
      actual_fidelity: "one_shot",
      isolation_profile: "read_only_review",
      isolation_status: "ready",
      global_mutation_required: false,
      declared_not_enforced: false,
    };
    const executor = createReviewerExecutor([
      {
        agent_id: "claude-reviewer",
        transport: "native-claude",
        mode: "backend",
        runtime,
        backendFactory: createClaudeCodeBackendFactory({
          command: process.execPath,
          argsPrefix: [script],
          model: "fake-claude",
        }),
        sandbox: "read-only",
      },
    ]);

    const results = await executor({
      runId: "run_1",
      goal: "review it",
      artifactId: "art_diff_run_1",
      agents: ["claude-reviewer"],
      ctx,
      clock,
    });

    expect(results).toEqual([
      expect.objectContaining({
        agent: "claude-reviewer",
        status: "completed",
        verdict: "approve",
        max_severity: "NONE",
      }),
    ]);
  });
});

function makeFakeClaudeScript(mode = "ok"): string {
  const dir = mkdtempSync(join(tmpdir(), "holp-fake-claude-"));
  tempDirs.push(dir);
  const script = join(dir, "fake-claude.cjs");
  writeFileSync(script, `
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.fake (Claude Code)");
  process.exit(0);
}
if (mode === "malformed") {
  process.stdout.write("not json");
  process.exit(0);
}
if (mode === "outer-error") {
  console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "auth failed" }));
  process.exit(0);
}
if (mode === "rate-limit") {
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "You've hit your session limit" }));
  process.exit(0);
}
const prompt = args[args.indexOf("-p") + 1] || "";
if (prompt.includes("capability probe")) {
  console.log(JSON.stringify({ type: "result", subtype: "success", result: "{\\"holp_probe\\":\\"ok\\"}", session_id: "probe-session", total_cost_usd: 0 }));
  process.exit(0);
}
if (prompt.includes("read-only enforcement probe")) {
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    result: "{\\"holp_read_only_probe\\":\\"done\\"}",
    permission_denials: mode === "no-denial" ? [] : [{ tool_name: "Write", reason: "not allowed" }]
  }));
  process.exit(0);
}
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  result: JSON.stringify({ verdict: "approve", max_severity: "NONE", findings: [] }),
  session_id: "review-session",
  total_cost_usd: 0
}));
`, "utf8");
  chmodSync(script, 0o755);
  return script;
}
