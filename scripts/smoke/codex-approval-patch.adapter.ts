#!/usr/bin/env tsx
/**
 * Layer 1 — adapter-direct real-Codex PATCH smoke.
 *
 * Drives `CodexAppServerBackend` directly (no daemon, no JSON-RPC) against a REAL
 * `codex app-server --stdio` under an isolated temp CODEX_HOME + temp git workspace,
 * and asserts the real provider:
 *   1. emits an `fs-edit` carrying a non-empty unified diff, and
 *   2. actually applies the patch on disk (SMOKE.txt gains the marker), and
 *   3. completes the turn cleanly (status idle).
 *
 * SCOPE / HONESTY: this is the patch path only. Empirically (Codex 0.140.0, adapter
 * policy on-request + workspace-write) a file edit is AUTO-APPLIED and does NOT trigger
 * the approval bridge — neither in-workspace nor out-of-workspace. The real approval
 * path is exercised separately by the e2e smoke via a sandbox-escape command. The
 * deterministic approval-resume *semantics* remain covered by the fake-server
 * integration test (daemon/handlers/codex_adapter_integration.test.ts).
 *
 * This is the lowest-flake floor: it proves "codex 0.140.0 emits the fileChange/patch
 * frames our adapter parses + our auth/CODEX_HOME plumbing works", independent of the
 * daemon orchestrate.run wiring (which the e2e smoke covers).
 *
 * Opt-in only: no-op exit 0 unless HOLP_REAL_CODEX_SMOKE=1. Consumes ChatGPT quota.
 * Run: HOLP_REAL_CODEX_SMOKE=1 npm run smoke:codex:adapter
 */

import { CodexAppServerBackend } from "../../adapters/codex-app-server.js";
import type {
  AgentMessage,
  PermissionVerdict,
} from "../../adapters/agent-backend.js";
import {
  createIsolatedEnv,
  PATCH_PROMPT,
  preflight,
  sleep,
  SMOKE_MARKER,
} from "./_codex-isolation.js";

/** Driver-side ceiling per turn — shorter than the adapter's 10-min TURN_TIMEOUT_MS. */
const TURN_DEADLINE_MS = 180_000;

async function main(): Promise<void> {
  const gate = preflight();
  if (!gate.ok) {
    console.log(`[smoke:codex:adapter] ${gate.reason}`);
    process.exit(0);
  }

  const env = createIsolatedEnv();
  console.log("=== HOLP adapter-direct Codex PATCH smoke ===");
  console.log(`  CODEX_HOME : ${env.codexHome}`);
  console.log(`  workspace  : ${env.workspace}`);

  const messages: AgentMessage[] = [];
  let fsEditDiff: string | undefined;
  let turnError: string | undefined;

  const backend = new CodexAppServerBackend(
    {
      cwd: env.workspace,
      // CODEX_HOME redirect is the whole isolation contract — the spawned codex
      // child merges {...process.env, ...env} (codex-app-server.ts:609).
      env: { ...process.env, CODEX_HOME: env.codexHome } as Record<string, string>,
      // A file edit should not request approval; if the provider ever does, approving
      // keeps the smoke moving rather than hanging. (Observed: never fires for edits.)
      permissionHandler: async (
        toolName: string,
        _input: unknown,
      ): Promise<PermissionVerdict> => {
        console.log(`  [unexpected approval] ${toolName} -> allow (file edit normally needs none)`);
        return { decision: "allow", reason: "smoke auto-approve" };
      },
    },
    {},
  );

  backend.onMessage((msg) => {
    messages.push(msg);
    if (msg.type === "fs-edit") {
      console.log(`  [fs-edit] path=${msg.path ?? "?"} diffBytes=${msg.diff?.length ?? 0}`);
      if (msg.diff && msg.diff.length > 0) fsEditDiff = msg.diff;
    } else if (msg.type === "status") {
      console.log(`  [status] ${msg.status}${msg.detail ? ` (${msg.detail})` : ""}`);
      if (msg.status === "error") turnError = msg.detail ?? "error";
    }
  });

  let ok = false;
  try {
    const { sessionId } = await backend.startSession();
    console.log(`  session=${sessionId}; sending patch prompt...`);

    await Promise.race([
      backend.sendPrompt(sessionId, PATCH_PROMPT),
      sleep(TURN_DEADLINE_MS).then(() => {
        throw new Error(`turn did not complete within ${TURN_DEADLINE_MS}ms`);
      }),
    ]);

    const fileChanged = env.smokeFileChanged();
    console.log("\n=== Assertions ===");
    report("fs-edit emitted with non-empty diff", Boolean(fsEditDiff));
    report(`SMOKE.txt now contains ${SMOKE_MARKER}`, fileChanged);
    report("turn completed without error", !turnError);

    // On-disk file is the primary truth; the diff frame is best-effort (a real run can
    // apply a patch whose frame lacks a `.diff`). Require: file changed, no turn error,
    // and the diff frame seen (the thing this layer specifically proves about parsing).
    ok = fileChanged && !turnError && Boolean(fsEditDiff);
  } catch (err) {
    console.error(`\n[smoke:codex:adapter] error: ${err instanceof Error ? err.message : String(err)}`);
    ok = false;
  } finally {
    await backend.dispose().catch(() => {});
    env.cleanup();
  }

  console.log(`\n=== Result: ${ok ? "PASS" : "FAIL"} ===`);
  process.exit(ok ? 0 : 1);
}

function report(label: string, pass: boolean): void {
  console.log(`  ${pass ? "PASS" : "FAIL"} ${label}`);
}

main().catch((err) => {
  console.error("smoke:codex:adapter fatal:", err);
  process.exit(1);
});
