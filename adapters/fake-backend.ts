/**
 * Fake AgentBackend + AgentBackendFactory — DEMO / TEST ONLY.
 *
 * This is NOT a real agent adapter. It replaces the *provider* (the agent),
 * not the *protocol path*. The fake is driven through the real
 * AgentBackendFactory → AgentBackend contract in agent-backend.ts exactly as
 * native-claude / mcp-codex / acp would be in production.
 *
 * What the fake does (one deterministic scenario):
 *   1. startSession() resolves immediately.
 *   2. sendPrompt() drives a scripted sequence of AgentMessages via onMessage:
 *        status:starting → status:running → tool-call (read_file) →
 *        tool-result (read_file) → permission-request (write_file) →
 *        [paused — awaits permissionHandler Promise]
 *        → (after resolve) tool-call (write_file) → tool-result (write_file) →
 *        fs-edit → status:idle
 *   3. permissionHandler is called for write_file. The daemon creates an
 *      approval record, emits approval_requested, and returns a pending Promise.
 *      The fake awaits it — genuinely paused. When approval.resolve is called,
 *      the daemon's resumeBackend closure resolves the Promise and the fake resumes.
 *
 * Resume path: approval.resolve → resumeBackend(decision) → Promise resolves → fake continues.
 * resolvePermission() is defined on the interface but is NOT used in the current flow;
 * the pendingPermissions map is not populated. The live resume goes through resumeBackend.
 *
 * Rule-4 discipline: this file always says FAKE/DEMO. No real spawning.
 * Rule-5 discipline: real transports stay as stubs in registry.ts.
 *
 * Transport class string: "fake" (demo-only, not a real HOLP transport).
 */

import type {
  AgentBackend,
  AgentBackendFactory,
  AgentBackendOptions,
  AgentMessage,
  AgentMessageHandler,
  PermissionVerdict,
} from "./agent-backend.js";

/** Minimal delay helper — keeps async flow but doesn't inject real timing. */
function tick(): Promise<void> {
  return Promise.resolve();
}

export function createFakeBackendFactory(): AgentBackendFactory {
  return (opts: AgentBackendOptions) => new FakeAgentBackend(opts);
}

class FakeAgentBackend implements AgentBackend {
  private handlers: AgentMessageHandler[] = [];
  private readonly permissionHandler: AgentBackendOptions["permissionHandler"];
  private cancelled = false;

  constructor(opts: AgentBackendOptions) {
    this.permissionHandler = opts.permissionHandler;
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  private emit(msg: AgentMessage): void {
    for (const h of this.handlers) h(msg);
  }

  async startSession(): Promise<{ sessionId: string }> {
    return { sessionId: "fake-session-1" };
  }

  /**
   * Drive the deterministic scenario. The permissionHandler is the real
   * daemon-injected handler — it creates an approval record, emits
   * approval_requested, and returns a pending Promise. We await it here,
   * genuinely pausing until the client calls approval.resolve.
   */
  async sendPrompt(_sessionId: string, _prompt: string): Promise<void> {
    if (this.cancelled) return;

    await tick();
    this.emit({ type: "status", status: "starting" });

    await tick();
    this.emit({ type: "status", status: "running" });

    if (this.cancelled) return;

    // Step 1: read a file (no permission needed)
    const readCallId = "call-read-1";
    this.emit({
      type: "tool-call",
      toolName: "read_file",
      args: { path: "src/foo.ts" },
      callId: readCallId,
    });

    await tick();

    if (this.cancelled) return;

    this.emit({
      type: "tool-result",
      toolName: "read_file",
      result: { content: "// src/foo.ts contents" },
      callId: readCallId,
    });

    await tick();

    if (this.cancelled) return;

    // Step 2: write a file (needs permission — triggers approval)
    const writeCallId = "call-write-1";
    const permRequestId = "perm-req-1";

    // First emit the permission-request message so the daemon sees it
    this.emit({
      type: "permission-request",
      id: permRequestId,
      toolName: "write_file",
      input: { path: "src/foo.ts", content: "// fixed" },
      reason: "write_file requires human approval",
    });

    // Now call the injected permissionHandler (daemon's approval bridge).
    // This call: creates approval record, emits approval_requested, returns pending Promise.
    let permVerdict: PermissionVerdict;
    if (this.permissionHandler) {
      permVerdict = await this.permissionHandler("write_file", {
        path: "src/foo.ts",
        content: "// fixed",
      });
    } else {
      // No handler: allow by default (degraded path).
      permVerdict = { decision: "allow", reason: "no permission handler (degraded)" };
    }

    if (this.cancelled) return;

    // Determine effective decision from verdict
    const allowed = permVerdict.decision === "allow" || permVerdict.decision === "ask_human";

    if (!allowed) {
      this.emit({ type: "status", status: "stopped", detail: "write_file denied" });
      return;
    }

    // Step 3: proceed with write (permission granted)
    this.emit({
      type: "tool-call",
      toolName: "write_file",
      args: { path: "src/foo.ts", content: "// fixed" },
      callId: writeCallId,
    });

    await tick();

    if (this.cancelled) return;

    this.emit({
      type: "tool-result",
      toolName: "write_file",
      result: { ok: true },
      callId: writeCallId,
    });

    await tick();

    if (this.cancelled) return;

    // Step 4: fs-edit (the actual diff)
    this.emit({
      type: "fs-edit",
      description: "Fix flaky test in src/foo.ts",
      diff: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-// old\n+// fixed\n",
      path: "src/foo.ts",
    });

    await tick();

    if (this.cancelled) return;

    this.emit({ type: "status", status: "idle" });
  }

  /**
   * resolvePermission is defined on the AgentBackend interface but is not used in
   * the current flow. The live resume path is: approval.resolve → resumeBackend(decision)
   * → the Promise in sendPrompt resolves. pendingPermissions is not populated.
   * This method is intentionally a no-op here; real adapters would implement it.
   */
  async resolvePermission(_request_id: string, _decision: "allow" | "deny"): Promise<void> {
    // No-op: resume is handled via the resumeBackend closure, not this method.
  }

  async cancel(_sessionId: string): Promise<void> {
    this.cancelled = true;
  }

  async dispose(): Promise<void> {
    this.cancelled = true;
    this.handlers = [];
  }
}
