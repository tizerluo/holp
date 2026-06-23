import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerBackend,
  probeCodexAppServer,
} from "./codex-app-server.js";
import type { AgentMessage, PermissionVerdict } from "./agent-backend.js";

const tempDirs: string[] = [];
const PROCESS_HEAVY_TEST_TIMEOUT_MS = 20_000;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CodexAppServerBackend", () => {
  it("maps app-server lifecycle, model output, approval, and patch events", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-codex-app-server.cjs");
    writeFileSync(serverPath, fakeAppServerScript(), "utf8");

    let resumeApproval: ((verdict: PermissionVerdict) => void) | undefined;
    const permissionCalls: Array<{ toolName: string; input: unknown }> = [];
    const messages: AgentMessage[] = [];
    const backend = new CodexAppServerBackend(
      {
        cwd: dir,
        permissionHandler: (toolName, input) => {
          permissionCalls.push({ toolName, input });
          return new Promise<PermissionVerdict>((resolve) => {
            resumeApproval = resolve;
          });
        },
      },
      { command: process.execPath, args: [serverPath] },
    );
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    let completed = false;
    const run = backend.sendPrompt(sessionId, "write a tiny patch").then(() => {
      completed = true;
    });

    await pollUntil(() => permissionCalls.length === 1);
    expect(completed).toBe(false);
    expect(permissionCalls[0].toolName).toBe("shell_command");
    expect(messages.some((message) => message.type === "permission-request")).toBe(true);

    resumeApproval?.({ decision: "allow", reason: "test" });
    await run;
    await backend.dispose();

    expect(completed).toBe(true);
    expect(messages).toContainEqual({ type: "status", status: "running", detail: "turn:turn-1" });
    expect(messages).toContainEqual({ type: "model-output", textDelta: "hello from codex" });
    expect(messages.some((message) => message.type === "event" && message.name === "item/commandExecution/outputDelta")).toBe(true);
    expect(messages.filter((message) => message.type === "fs-edit")).toHaveLength(1);
    expect(messages).toContainEqual({
      type: "fs-edit",
      description: "Codex updated src/app.ts",
      path: "src/app.ts",
      diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
    });
  });

  it("bridges app-server permission profile approval requests through permissionHandler", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-permission-app-server.cjs");
    writeFileSync(serverPath, fakePermissionAppServerScript("allow"), "utf8");

    let resumeApproval: ((verdict: PermissionVerdict) => void) | undefined;
    const permissionCalls: Array<{ toolName: string; input: unknown }> = [];
    const messages: AgentMessage[] = [];
    const backend = new CodexAppServerBackend(
      {
        cwd: dir,
        permissionHandler: (toolName, input) => {
          permissionCalls.push({ toolName, input });
          return new Promise<PermissionVerdict>((resolve) => {
            resumeApproval = resolve;
          });
        },
      },
      { command: process.execPath, args: [serverPath] },
    );
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    let completed = false;
    const run = backend.sendPrompt(sessionId, "request network permission").then(() => {
      completed = true;
    });

    await pollUntil(() => permissionCalls.length === 1);
    expect(completed).toBe(false);
    expect(permissionCalls[0].toolName).toBe("request_permissions");
    expect(messages).toContainEqual({
      type: "event",
      name: "item/started",
      payload: { item: { type: "unknownSideEffect", id: "unknown-1", effect: "side-effect-ish" } },
    });

    resumeApproval?.({ decision: "allow", reason: "test" });
    await run;
    await backend.dispose();

    expect(completed).toBe(true);
    expect(messages.some((message) => message.type === "permission-request" && message.toolName === "request_permissions")).toBe(true);
  });

  it("serializes approval requests before later app-server notifications", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-premature-completion-app-server.cjs");
    writeFileSync(serverPath, fakePermissionAppServerScript("allow", { prematureTurnCompleted: true }), "utf8");

    let resumeApproval: ((verdict: PermissionVerdict) => void) | undefined;
    const permissionCalls: Array<{ toolName: string; input: unknown }> = [];
    const backend = new CodexAppServerBackend(
      {
        cwd: dir,
        permissionHandler: (toolName, input) => {
          permissionCalls.push({ toolName, input });
          return new Promise<PermissionVerdict>((resolve) => {
            resumeApproval = resolve;
          });
        },
      },
      { command: process.execPath, args: [serverPath] },
    );

    const { sessionId } = await backend.startSession();
    let completed = false;
    const run = backend.sendPrompt(sessionId, "request network permission").then(() => {
      completed = true;
    });

    await pollUntil(() => permissionCalls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(completed).toBe(false);

    resumeApproval?.({ decision: "allow", reason: "test" });
    await run;
    await backend.dispose();

    expect(completed).toBe(true);
  });

  it("drains queued frames before completing from a turn/start completed response", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-completed-response-approval-app-server.cjs");
    writeFileSync(serverPath, fakeCompletedResponseApprovalServerScript(), "utf8");

    let resumeApproval: ((verdict: PermissionVerdict) => void) | undefined;
    const permissionCalls: Array<{ toolName: string; input: unknown }> = [];
    const backend = new CodexAppServerBackend(
      {
        cwd: dir,
        permissionHandler: (toolName, input) => {
          permissionCalls.push({ toolName, input });
          return new Promise<PermissionVerdict>((resolve) => {
            resumeApproval = resolve;
          });
        },
      },
      { command: process.execPath, args: [serverPath] },
    );

    const { sessionId } = await backend.startSession();
    let completed = false;
    const run = backend.sendPrompt(sessionId, "completed response still requires approval").then(() => {
      completed = true;
    });

    await pollUntil(() => permissionCalls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(completed).toBe(false);

    resumeApproval?.({ decision: "allow", reason: "test" });
    await run;
    await backend.dispose();

    expect(completed).toBe(true);
  });

  it("restarts the app-server and retries the original prompt after a transient exit before activity", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-transient-recovery-app-server.cjs");
    const statePath = join(dir, "transient-state.json");
    writeFileSync(serverPath, fakeRecoveringAppServerScript({ statePath, firstFailure: "exit-after-turn-start-response" }), "utf8");

    const sleeps: number[] = [];
    const messages: AgentMessage[] = [];
    const backend = new CodexAppServerBackend(
      { cwd: dir },
      {
        command: process.execPath,
        args: [serverPath],
        maxTurnRecoveryRetries: 1,
        turnRecoveryBackoffMs: 7,
        recoverySleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, "recover this turn");
    await backend.dispose();

    const state = JSON.parse(readFileUtf8(statePath)) as { prompts: string[]; threadStarts: Array<{ source: string; sandbox: string }> };
    expect(state.prompts).toEqual(["recover this turn", "recover this turn"]);
    expect(state.threadStarts).toEqual([
      { source: "startup", sandbox: "workspace-write" },
      { source: "recovery", sandbox: "workspace-write" },
    ]);
    expect(sleeps).toEqual([7]);
    expect(messages).toContainEqual({
      type: "event",
      name: "codex_recovery_waiting",
      payload: {
        kind: "transient",
        reason: "codex_transient_runtime_failure",
        attempt: 1,
        max_retries: 1,
        retry_after_ms: 7,
      },
    });
    expect(messages).toContainEqual({ type: "model-output", textDelta: "recovered" });
  });

  it("uses the usage-limit backoff path without switching provider accounts", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-usage-limit-recovery-app-server.cjs");
    const statePath = join(dir, "usage-limit-state.json");
    writeFileSync(serverPath, fakeRecoveringAppServerScript({ statePath, firstFailure: "usage-limit-before-turn-start-response" }), "utf8");

    const sleeps: number[] = [];
    const messages: AgentMessage[] = [];
    const backend = new CodexAppServerBackend(
      { cwd: dir },
      {
        command: process.execPath,
        args: [serverPath],
        maxTurnRecoveryRetries: 1,
        usageLimitBackoffMs: 11,
        recoverySleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, "wait for quota");
    await backend.dispose();

    const waiting = messages.find((message) => message.type === "event" && message.name === "codex_recovery_waiting");
    expect(waiting).toMatchObject({
      type: "event",
      name: "codex_recovery_waiting",
      payload: { kind: "usage_limit", reason: "codex_usage_limit", retry_after_ms: 11 },
    });
    expect(sleeps).toEqual([11]);
  });

  it("does not restart recovery when cancellation lands during backoff", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-cancel-during-recovery-app-server.cjs");
    const statePath = join(dir, "cancel-during-recovery-state.json");
    writeFileSync(serverPath, fakeRecoveringAppServerScript({ statePath, firstFailure: "exit-after-turn-start-response" }), "utf8");

    let sessionId = "";
    let backend: CodexAppServerBackend;
    const messages: AgentMessage[] = [];
    backend = new CodexAppServerBackend(
      { cwd: dir },
      {
        command: process.execPath,
        args: [serverPath],
        maxTurnRecoveryRetries: 1,
        turnRecoveryBackoffMs: 7,
        recoverySleep: async () => {
          await backend.cancel(sessionId);
        },
      },
    );
    backend.onMessage((message) => messages.push(message));

    ({ sessionId } = await backend.startSession());
    await backend.sendPrompt(sessionId, "cancel before recovery restarts");
    await backend.dispose();

    const state = JSON.parse(readFileUtf8(statePath)) as { processes: number; prompts: string[]; threadStarts: Array<{ source: string }> };
    expect(state.processes).toBe(1);
    expect(state.prompts).toEqual(["cancel before recovery restarts"]);
    expect(state.threadStarts.map((thread) => thread.source)).toEqual(["startup"]);
    expect(messages.some((message) => message.type === "event" && message.name === "codex_recovery_restarted")).toBe(false);
  });

  it("does not report cancellation as exhausted recovery", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-hanging-turn-app-server.cjs");
    writeFileSync(serverPath, fakeHangingTurnAppServerScript(), "utf8");

    const messages: AgentMessage[] = [];
    const backend = new CodexAppServerBackend(
      { cwd: dir },
      {
        command: process.execPath,
        args: [serverPath],
        maxTurnRecoveryRetries: 1,
      },
    );
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    const run = backend.sendPrompt(sessionId, "cancel active turn");
    await pollUntil(() => messages.some((message) => message.type === "model-output"));

    await backend.cancel(sessionId);
    await run;
    await backend.dispose();

    expect(messages.some((message) => message.type === "event" && message.name === "codex_recovery_exhausted")).toBe(false);
    expect(messages.some((message) => message.type === "event" && message.name === "codex_recovery_restarted")).toBe(false);
  });

  it("returns the recovered session id when the initial prompt recovers", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-initial-prompt-recovery-app-server.cjs");
    const statePath = join(dir, "initial-prompt-recovery-state.json");
    writeFileSync(serverPath, fakeRecoveringAppServerScript({ statePath, firstFailure: "exit-after-turn-start-response" }), "utf8");

    const backend = new CodexAppServerBackend(
      { cwd: dir },
      {
        command: process.execPath,
        args: [serverPath],
        maxTurnRecoveryRetries: 1,
        turnRecoveryBackoffMs: 1,
        recoverySleep: async () => {},
      },
    );

    const { sessionId } = await backend.startSession("recover initial prompt");
    expect(sessionId).toBe("thread-2");
    await backend.sendPrompt(sessionId, "follow-up on recovered session");
    await backend.dispose();

    const state = JSON.parse(readFileUtf8(statePath)) as { prompts: string[] };
    expect(state.prompts).toEqual([
      "recover initial prompt",
      "recover initial prompt",
      "follow-up on recovered session",
    ]);
  });

  it("does not retry a failed turn after meaningful activity", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-activity-failure-app-server.cjs");
    const statePath = join(dir, "activity-state.json");
    writeFileSync(serverPath, fakeRecoveringAppServerScript({ statePath, firstFailure: "exit-after-activity" }), "utf8");

    const messages: AgentMessage[] = [];
    const backend = new CodexAppServerBackend(
      { cwd: dir },
      {
        command: process.execPath,
        args: [serverPath],
        maxTurnRecoveryRetries: 1,
        turnRecoveryBackoffMs: 1,
      },
    );
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    await expect(backend.sendPrompt(sessionId, "do not duplicate")).rejects.toThrow("codex app-server exited");
    await backend.dispose();

    const state = JSON.parse(readFileUtf8(statePath)) as { prompts: string[] };
    expect(state.prompts).toEqual(["do not duplicate"]);
    expect(messages.some((message) => message.type === "event" && message.name === "codex_recovery_restarted")).toBe(false);
    expect(messages).toContainEqual({
      type: "event",
      name: "codex_recovery_exhausted",
      payload: {
        kind: "fatal",
        reason: "codex_turn_failed_after_activity",
        attempts: 0,
        max_retries: 1,
      },
    });
  });

  it("denies app-server permission profile approval requests with JSON-RPC error", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-permission-deny-app-server.cjs");
    writeFileSync(serverPath, fakePermissionAppServerScript("deny"), "utf8");

    const backend = new CodexAppServerBackend(
      {
        cwd: dir,
        permissionHandler: async () => ({ decision: "deny", reason: "test denied" }),
      },
      { command: process.execPath, args: [serverPath] },
    );

    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, "deny network permission");
    await backend.dispose();
  });

  it("stops the turn when command approval is denied", async () => {
    const dir = makeTempDir();
    const serverPath = join(dir, "fake-command-deny-app-server.cjs");
    writeFileSync(serverPath, fakeCommandApprovalServerScript(), "utf8");

    const messages: AgentMessage[] = [];
    const backend = new CodexAppServerBackend(
      {
        cwd: dir,
        permissionHandler: async () => ({ decision: "deny", reason: "test denied" }),
      },
      { command: process.execPath, args: [serverPath] },
    );
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, "deny command");
    await backend.dispose();

    expect(messages).toContainEqual({ type: "status", status: "stopped", detail: "shell_command denied" });
  });

  it("reports rejected when the codex binary is unavailable", async () => {
    const dir = makeTempDir();
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command: join(dir, "does-not-exist") },
    );

    expect(result.status).toBe("rejected");
    expect(result.missing).toContain("binary:codex");
    expect(result.reason).toBe("missing_binary_codex");
  });

  it("reports rejected when codex auth is not configured", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "auth-missing");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000 },
    );

    expect(result.status).toBe("rejected");
    expect(result.missing).toContain("auth:codex");
    expect(result.reason).toBe("codex_auth_not_configured");
  });

  it("reports degraded when codex doctor does not prove auth status", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "auth-unknown");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000 },
    );

    expect(result.status).toBe("degraded");
    expect(result.missing).toContain("auth:codex");
    expect(result.reason).toBe("codex_auth_status_unknown");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("reports degraded when app-server initialize fails after auth succeeds", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "init-fails");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000 },
    );

    expect(result.status).toBe("degraded");
    expect(result.version).toBe("Codex fake/1.0");
    expect(result.reason).toContain("exited code=42");
  });

  it("declares codex app-server headless as streaming controlled when ready", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "ready");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000 },
    );

    const headless = result.runtime_surfaces?.find((surface) =>
      surface.runtime_surface === "headless"
    );
    expect(result.status).toBe("ready");
    expect(headless?.runtime_kind).toBe("app_server");
    expect(headless?.actual_fidelity).toBe("streaming_controlled");
  });

  it("AC1: three independent surfaces declared even when headless is ready", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "ready");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000 },
    );

    const surfaces = result.runtime_surfaces ?? [];
    const headless = surfaces.find((s) => s.runtime_surface === "headless");
    const acp = surfaces.find((s) => s.runtime_surface === "acp");
    const direct = surfaces.find((s) => s.runtime_surface === "direct_user_session");

    expect(headless).toBeDefined();
    expect(acp).toBeDefined();
    expect(direct).toBeDefined();

    // Headless ready does NOT make ACP/direct ready
    expect(headless?.surface_support).toBe("supported");
    const acpWorktree = acp?.isolation_profiles?.["coder_worktree"];
    expect(acpWorktree?.readiness).toBe("degraded");
    expect(acpWorktree?.reason).toBe("codex_acp_smoke_not_enabled");
    const directWorktree = direct?.isolation_profiles?.["coder_worktree"];
    expect(directWorktree?.readiness).toBe("degraded");
    expect(directWorktree?.reason).toBe("codex_direct_smoke_not_enabled");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("AC1: acp surface declares codex_acp kind and direct declares codex_direct_tmux kind", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "ready");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000 },
    );

    const acp = result.runtime_surfaces?.find((s) => s.runtime_surface === "acp");
    const direct = result.runtime_surfaces?.find((s) => s.runtime_surface === "direct_user_session");

    expect(acp?.runtime_kind).toBe("codex_acp");
    expect(acp?.actual_fidelity).toBe("streaming_controlled");
    expect(direct?.runtime_kind).toBe("codex_direct_tmux");
    expect(direct?.actual_fidelity).toBe("streaming_controlled");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("AC4/AC5: direct surface declares supported attach/scope with holp_created origin and holp-* namespace", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "ready");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000 },
    );

    const direct = result.runtime_surfaces?.find((s) => s.runtime_surface === "direct_user_session");
    expect(direct?.direct_channel?.attach).toBe("supported");
    expect(direct?.direct_channel?.owner_scope).toBe("supported");
    expect(direct?.direct_channel?.session_origin).toBe("holp_created");
    expect(direct?.direct_channel?.session_id_namespace).toBe("holp-*");
    expect(direct?.direct_channel?.observe).toBe("supported");
    expect(direct?.direct_channel?.inject).toBe("supported");
    // capability_bitmask empty without smoke
    expect(direct?.direct_channel?.capability_bitmask).toEqual([]);
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("opt-in: default env (no HOLP_REAL_CODEX_SMOKE, no runners) keeps ACP/direct degraded", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "ready");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000 },
    );

    const acp = result.runtime_surfaces?.find((s) => s.runtime_surface === "acp");
    const direct = result.runtime_surfaces?.find((s) => s.runtime_surface === "direct_user_session");
    expect(acp?.isolation_profiles?.["coder_worktree"]?.readiness).toBe("degraded");
    expect(direct?.isolation_profiles?.["coder_worktree"]?.readiness).toBe("degraded");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("opt-in: fake ACP smoke returning ok promotes coder_worktree to ready", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "ready");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      {
        command, probeTimeoutMs: 10_000,
        acpSmokeRunner: async () => "ok",
      },
    );

    const acp = result.runtime_surfaces?.find((s) => s.runtime_surface === "acp");
    expect(acp?.isolation_profiles?.["coder_worktree"]?.readiness).toBe("ready");
    // read_only_review must stay degraded regardless
    expect(acp?.isolation_profiles?.["read_only_review"]?.readiness).toBe("degraded");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("opt-in: fake ACP smoke returning fail keeps coder_worktree degraded", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "ready");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      {
        command, probeTimeoutMs: 10_000,
        acpSmokeRunner: async () => "fail",
      },
    );

    const acp = result.runtime_surfaces?.find((s) => s.runtime_surface === "acp");
    expect(acp?.isolation_profiles?.["coder_worktree"]?.readiness).toBe("degraded");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("opt-in: fake direct smoke returning ok promotes coder_worktree to ready with capability_bitmask", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "ready");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      {
        command, probeTimeoutMs: 10_000,
        directSmokeRunner: async () => "ok",
      },
    );

    const direct = result.runtime_surfaces?.find((s) => s.runtime_surface === "direct_user_session");
    expect(direct?.isolation_profiles?.["coder_worktree"]?.readiness).toBe("ready");
    expect(direct?.direct_channel?.capability_bitmask).toContain("exec");
    // read_only_review must stay degraded
    expect(direct?.isolation_profiles?.["read_only_review"]?.readiness).toBe("degraded");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("opt-in: fake direct smoke returning fail keeps coder_worktree degraded", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "ready");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      {
        command, probeTimeoutMs: 10_000,
        directSmokeRunner: async () => "fail",
      },
    );

    const direct = result.runtime_surfaces?.find((s) => s.runtime_surface === "direct_user_session");
    expect(direct?.isolation_profiles?.["coder_worktree"]?.readiness).toBe("degraded");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("opt-in: fake ACP smoke returning fail reports smoke_failed reason, not smoke_not_enabled", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "ready");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000, acpSmokeRunner: async () => "fail" },
    );
    const acp = result.runtime_surfaces?.find((s) => s.runtime_surface === "acp");
    expect(acp?.isolation_profiles?.["coder_worktree"]?.readiness).toBe("degraded");
    expect(acp?.isolation_profiles?.["coder_worktree"]?.reason).toBe("codex_acp_smoke_failed");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("opt-in: fake direct smoke returning fail reports smoke_failed reason, not smoke_not_enabled", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "ready");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000, directSmokeRunner: async () => "fail" },
    );
    const direct = result.runtime_surfaces?.find((s) => s.runtime_surface === "direct_user_session");
    expect(direct?.isolation_profiles?.["coder_worktree"]?.readiness).toBe("degraded");
    expect(direct?.isolation_profiles?.["coder_worktree"]?.reason).toBe("codex_direct_smoke_failed");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("AC3: acp degraded lists missing env when headless rejected", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "auth-missing");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000 },
    );

    const acp = result.runtime_surfaces?.find((s) => s.runtime_surface === "acp");
    const acpWorktree = acp?.isolation_profiles?.["coder_worktree"];
    // ACP default is degraded regardless of headless status
    expect(acpWorktree?.readiness).toBe("degraded");
    expect(acpWorktree?.missing).toContain("env:HOLP_REAL_CODEX_SMOKE");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("AC7: read_only_review is not upgraded by headless readiness", async () => {
    const dir = makeTempDir();
    const command = fakeCodexCommand(dir, "ready");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["reviewer"], cwd: dir },
      { command, probeTimeoutMs: 10_000 },
    );

    const acp = result.runtime_surfaces?.find((s) => s.runtime_surface === "acp");
    const acpReviewer = acp?.isolation_profiles?.["read_only_review"];
    const direct = result.runtime_surfaces?.find((s) => s.runtime_surface === "direct_user_session");
    const directReviewer = direct?.isolation_profiles?.["read_only_review"];

    expect(acpReviewer?.readiness).toBe("degraded");
    expect(directReviewer?.readiness).toBe("degraded");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("P2: headless init failure + injected ACP smoke ok → top-level ready, headless degraded, ACP coder_worktree ready", async () => {
    const dir = makeTempDir();
    // init-fails: --version ok, doctor ok (auth configured), app-server exits non-zero
    const command = fakeCodexCommand(dir, "init-fails");
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command, probeTimeoutMs: 10_000, acpSmokeRunner: async () => "ok" },
    );

    expect(result.status).toBe("ready");
    const headless = result.runtime_surfaces?.find((s) => s.runtime_surface === "headless");
    expect(headless?.isolation_profiles?.["coder_worktree"]?.readiness).toBe("degraded");
    const acp = result.runtime_surfaces?.find((s) => s.runtime_surface === "acp");
    expect(acp?.isolation_profiles?.["coder_worktree"]?.readiness).toBe("ready");
    expect(result.resolved_roles).toContain("coder");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("P2: missing binary + injected ACP smoke ok → top-level ready, headless rejected/unsupported, ACP coder_worktree ready", async () => {
    const dir = makeTempDir();
    // nonexistent binary → --version returns code !== 0
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      { command: join(dir, "no-such-codex"), probeTimeoutMs: 10_000, acpSmokeRunner: async () => "ok" },
    );

    expect(result.status).toBe("ready");
    const headless = result.runtime_surfaces?.find((s) => s.runtime_surface === "headless");
    expect(headless?.surface_support).toBe("unsupported");
    const acp = result.runtime_surfaces?.find((s) => s.runtime_surface === "acp");
    expect(acp?.isolation_profiles?.["coder_worktree"]?.readiness).toBe("ready");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);

  it("P2: no-env/no-runner + missing binary → rejects, no smoke attempted", async () => {
    const dir = makeTempDir();
    const result = await probeCodexAppServer(
      { id: "codex-agent", transport: "mcp-codex", roles: ["coder"], cwd: dir },
      {
        command: join(dir, "no-such-codex"),
        probeTimeoutMs: 10_000,
        acpSmokeRunner: undefined,
        directSmokeRunner: undefined,
      },
    );

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("missing_binary_codex");
  }, PROCESS_HEAVY_TEST_TIMEOUT_MS);
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "holp-codex-adapter-"));
  tempDirs.push(dir);
  return dir;
}

function readFileUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

async function pollUntil(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}

function fakeAppServerScript(): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    send({ id: frame.id, result: { userAgent: "fake-codex-app-server" } });
    return;
  }
  if (frame.method === "initialized") return;
  if (frame.method === "thread/start") {
    send({ id: frame.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (frame.method === "turn/start") {
    send({ id: frame.id, result: { turn: { id: "turn-1", status: "running" } } });
    send({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    send({ method: "item/agentMessage/delta", params: { delta: "hello from codex" } });
    send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { itemId: "cmd-1", command: "printf hi", reason: "command needs approval" }
    });
    return;
  }
  if (frame.id === "approval-1") {
    if (!frame.result || frame.result.decision !== "accept") process.exit(2);
    send({ method: "item/commandExecution/outputDelta", params: { itemId: "cmd-1", stream: "stdout", delta: "hi" } });
    send({
      method: "item/completed",
      params: {
        item: {
          type: "fileChange",
          id: "file-1",
          changes: [{ path: "src/app.ts", diff: "--- a/src/app.ts\\n+++ b/src/app.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n" }]
        }
      }
    });
    send({
      method: "item/fileChange/patchUpdated",
      params: {
        changes: [{ path: "src/app.ts", diff: "--- a/src/app.ts\\n+++ b/src/app.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n" }]
      }
    });
    send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
  }
});
`;
}

function fakePermissionAppServerScript(mode: "allow" | "deny", opts: { prematureTurnCompleted?: boolean } = {}): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    send({ id: frame.id, result: { userAgent: "fake-codex-app-server" } });
    return;
  }
  if (frame.method === "initialized") return;
  if (frame.method === "thread/start") {
    send({ id: frame.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (frame.method === "turn/start") {
    send({ id: frame.id, result: { turn: { id: "turn-1", status: "running" } } });
    send({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    send({ method: "item/started", params: { item: { type: "unknownSideEffect", id: "unknown-1", effect: "side-effect-ish" } } });
    send({
      id: "permission-profile-1",
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-item-1",
        environmentId: null,
        cwd: "/tmp",
        reason: "network requested",
        permissions: { network: { enabled: true }, fileSystem: null }
      }
    });
    ${opts.prematureTurnCompleted ? 'send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });' : ""}
    return;
  }
  if (frame.id === "permission-profile-1") {
    if ("${mode}" === "allow") {
      if (!frame.result || frame.result.scope !== "turn" || !frame.result.permissions || frame.result.permissions.network.enabled !== true) {
        process.exit(2);
      }
    } else if (!frame.error || frame.error.code !== -32000) {
      process.exit(3);
    }
    ${opts.prematureTurnCompleted ? "" : 'send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });'}
  }
});
`;
}

function fakeCommandApprovalServerScript(): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    send({ id: frame.id, result: { userAgent: "fake-codex-app-server" } });
    return;
  }
  if (frame.method === "initialized") return;
  if (frame.method === "thread/start") {
    send({ id: frame.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (frame.method === "turn/start") {
    send({ id: frame.id, result: { turn: { id: "turn-1", status: "running" } } });
    send({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { itemId: "cmd-1", command: "printf hi", reason: "command needs approval" }
    });
    return;
  }
  if (frame.id === "approval-1") {
    if (!frame.result || frame.result.decision !== "decline") process.exit(2);
  }
});
`;
}

function fakeCompletedResponseApprovalServerScript(): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    send({ id: frame.id, result: { userAgent: "fake-codex-app-server" } });
    return;
  }
  if (frame.method === "initialized") return;
  if (frame.method === "thread/start") {
    send({ id: frame.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (frame.method === "turn/start") {
    send({ id: frame.id, result: { turn: { id: "turn-1", status: "completed" } } });
    send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { itemId: "cmd-1", command: "printf hi", reason: "command needs approval" }
    });
    return;
  }
  if (frame.id === "approval-1") {
    if (!frame.result || frame.result.decision !== "accept") process.exit(2);
  }
});
`;
}

function fakeHangingTurnAppServerScript(): string {
  return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    send({ id: frame.id, result: { userAgent: "fake-codex-app-server" } });
    return;
  }
  if (frame.method === "initialized") return;
  if (frame.method === "thread/start") {
    send({ id: frame.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (frame.method === "turn/start") {
    send({ id: frame.id, result: { turn: { id: "turn-1", status: "running" } } });
    send({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    send({ method: "item/agentMessage/delta", params: { delta: "working" } });
    return;
  }
  if (frame.method === "turn/interrupt") {
    send({ id: frame.id, result: {} });
  }
});
`;
}

function fakeRecoveringAppServerScript(opts: {
  statePath: string;
  firstFailure: "exit-after-turn-start-response" | "usage-limit-before-turn-start-response" | "exit-after-activity";
}): string {
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const statePath = ${JSON.stringify(opts.statePath)};
function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { return { processes: 0, prompts: [], threadStarts: [] }; }
}
function writeState(state) { fs.writeFileSync(statePath, JSON.stringify(state)); }
const state = readState();
state.processes += 1;
const processNo = state.processes;
writeState(state);
const rl = readline.createInterface({ input: process.stdin });
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    send({ id: frame.id, result: { userAgent: "fake-codex-app-server" } });
    return;
  }
  if (frame.method === "initialized") return;
  if (frame.method === "thread/start") {
    const next = readState();
    next.threadStarts.push({ source: frame.params.sessionStartSource, sandbox: frame.params.sandbox });
    writeState(next);
    send({ id: frame.id, result: { thread: { id: "thread-" + processNo } } });
    return;
  }
  if (frame.method === "turn/start") {
    const next = readState();
    next.prompts.push(frame.params.input[0].text);
    writeState(next);
    if (processNo === 1 && ${JSON.stringify(opts.firstFailure)} === "usage-limit-before-turn-start-response") {
      console.error("usage limit reached; retry after reset");
      process.exit(1);
    }
    send({ id: frame.id, result: { turn: { id: "turn-" + processNo, status: "running" } } });
    if (processNo === 1 && ${JSON.stringify(opts.firstFailure)} === "exit-after-turn-start-response") {
      console.error("simulated transient app-server exit");
      process.exit(1);
    }
    if (processNo === 1 && ${JSON.stringify(opts.firstFailure)} === "exit-after-activity") {
      send({ method: "item/agentMessage/delta", params: { delta: "partial" } });
      console.error("simulated exit after activity");
      process.exit(1);
    }
    send({ method: "turn/started", params: { turn: { id: "turn-" + processNo } } });
    send({ method: "item/agentMessage/delta", params: { delta: "recovered" } });
    send({ method: "turn/completed", params: { turn: { id: "turn-" + processNo, status: "completed" } } });
  }
});
`;
}

function fakeCodexCommand(
  dir: string,
  mode: "auth-missing" | "auth-unknown" | "init-fails" | "ready",
): string {
  const command = join(dir, `fake-codex-${mode}.mjs`);
  const doctor = mode === "auth-missing"
    ? "auth is not configured"
    : mode === "auth-unknown"
      ? "doctor passed"
      : "auth is configured";
  const appServerExit = mode === "auth-missing" ? 0 : 42;
  writeFileSync(
    command,
    `#!/usr/bin/env node
import readline from "node:readline";
const arg = process.argv[2];
if (arg === "--version") {
  console.log("Codex fake/1.0");
  process.exit(0);
}
if (arg === "doctor") {
  console.log("${doctor}");
  process.exit(0);
}
if (arg === "app-server") {
  if (${JSON.stringify(mode)} === "ready") {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: frame.id, result: { userAgent: "Codex fake/ready" } }) + "\\n");
      }
    });
  } else {
    process.exit(${appServerExit});
  }
} else {
  process.exit(64);
}
`,
    "utf8",
  );
  chmodSync(command, 0o755);
  return command;
}
