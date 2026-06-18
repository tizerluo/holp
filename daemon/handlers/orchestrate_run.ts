/**
 * `orchestrate.run` handler — spec §4 / §4.1 / §4.2 / §6.2.
 *
 * Validation order is FIXED (spec §6.2 / brief):
 *   1. agent_not_found (-32019): any agent id not in this connection's flock.
 *   2. role_unsupported (-32018): known agent but resolved_roles doesn't include the role.
 *   3. invalid_quorum (-32007): reviewer panel shape illegal.
 *   4. quorum_unsatisfiable (-32004): shape legal but reviewer-capable count < quorum.
 *   5. unsupported_execution_mode (-32013): kind != "Local".
 *   6. -32600 invalid_request for malformed params.
 *
 * On success: create run record, return { run_id, accepted:true } immediately,
 * and kick off the selected backend session asynchronously.
 */

import { holpError, invalidRequest } from "../core/errors.js";
import { HolpRpcError } from "../core/dispatcher.js";
import { isObject } from "../core/internal.js";
import type { JsonRpcRequest } from "../runtime/jsonrpc.js";
import type { ConnectionContext } from "../core/context.js";
import type { FlockAgent, RunRecord } from "../core/stores.js";
import { EventBus } from "../core/eventBus.js";
import type { AdapterRegistry } from "../../adapters/registry.js";
import type { Clock } from "../core/clock.js";
import { driveRun } from "../core/runEngine.js";

// M1b single-connection; per-connection run-id scoping deferred (see ConnectionContext.subscriptionCounter for the pattern).
let runCounter = 0;

function nextRunId(): string {
  runCounter += 1;
  return `run_${runCounter}`;
}

export function handleOrchestrateRun(
  req: JsonRpcRequest,
  ctx: ConnectionContext,
  registry: AdapterRegistry,
  clock: Clock,
): unknown {
  const params = isObject(req.params) ? req.params : {};

  // Malformed: no goal or no roles.
  if (typeof params.goal !== "string" || !params.goal) {
    throw new HolpRpcError(invalidRequest("orchestrate.run: params.goal (string) required"));
  }
  if (!isObject(params.roles)) {
    throw new HolpRpcError(invalidRequest("orchestrate.run: params.roles (object) required"));
  }

  const goal = params.goal;
  const trigger = typeof params.trigger === "string" ? params.trigger : "manual";
  const roles = params.roles as Record<string, unknown>;

  // Collect all agent ids referenced.
  const agentRefs: Array<{ agentId: string; role: string; isPanel: boolean }> = [];

  // Collect non-reviewer single-agent roles.
  for (const [roleName, roleSpec] of Object.entries(roles)) {
    if (roleName === "reviewer") continue;
    if (!isObject(roleSpec)) continue;
    if (typeof roleSpec.agent === "string") {
      agentRefs.push({ agentId: roleSpec.agent, role: roleName, isPanel: false });
    }
  }

  // Collect reviewer panel.
  let reviewerPanel: string[] = [];
  let quorum = 0;
  if (isObject(roles.reviewer)) {
    const rv = roles.reviewer as Record<string, unknown>;
    if (Array.isArray(rv.panel)) {
      reviewerPanel = (rv.panel as unknown[]).filter((x) => typeof x === "string") as string[];
      quorum = typeof rv.quorum === "number" ? rv.quorum : 0;
    }
    for (const agentId of reviewerPanel) {
      agentRefs.push({ agentId, role: "reviewer", isPanel: true });
    }
  }

  // --- Validation step 1: agent_not_found ---
  for (const ref of agentRefs) {
    if (!ctx.flock.has(ref.agentId)) {
      throw new HolpRpcError(
        holpError("agent_not_found", `agent '${ref.agentId}' not in this connection's flock`, {
          agent_id: ref.agentId,
        }),
      );
    }
  }

  // --- Validation step 2: role_unsupported (+ unsupported_transport for rejected) ---
  // Single-point roles first.
  // Per spec §4.2 / §10.1: a known-but-rejected agent in a single-point role yields
  // unsupported_transport (-32005), NOT role_unsupported. Rejected agents have
  // resolved_roles:[] so we must check status BEFORE the resolved_roles check.
  for (const ref of agentRefs) {
    if (ref.isPanel) continue;
    const agent = ctx.flock.get(ref.agentId) as FlockAgent;
    if (agent.status === "rejected") {
      throw new HolpRpcError(
        holpError(
          "unsupported_transport",
          `agent '${ref.agentId}' was rejected (transport unavailable) and cannot be used as '${ref.role}'`,
          { agent_id: ref.agentId, transport: agent.transport, reason: agent.reason },
        ),
      );
    }
    if (!agent.resolved_roles.includes(ref.role)) {
      throw new HolpRpcError(
        holpError(
          "role_unsupported",
          `agent '${ref.agentId}' does not have role '${ref.role}' in resolved_roles`,
          { agent_id: ref.agentId, role: ref.role, resolved_roles: agent.resolved_roles },
        ),
      );
    }
  }

  // --- Validation step 2b / step 3: reviewer panel checks ---
  // Per spec §6.2 and §10.1, the fine-grained order for panel members is:
  //   (a) rejected-in-panel → invalid_quorum (spec §10.1: "reviewer panel 含 rejected agent
  //       不走这里，走 §6.2 的 invalid_quorum"). This check MUST precede role_unsupported
  //       because rejected agents have resolved_roles:[] and would otherwise fire role_unsupported.
  //   (b) role_unsupported: non-rejected agent whose resolved_roles lacks 'reviewer'.
  //   (c) quorum shape (<=0 / >panel size) → invalid_quorum. This comes AFTER role_unsupported
  //       per spec §6.2 ordering (role check = step 2; shape check = step 3).
  if (reviewerPanel.length > 0) {
    // (a) Rejected agents in panel → invalid_quorum before role check.
    for (const agentId of reviewerPanel) {
      const agent = ctx.flock.get(agentId) as FlockAgent;
      if (agent.status === "rejected") {
        throw new HolpRpcError(
          holpError("invalid_quorum", `reviewer panel contains rejected agent '${agentId}'`, {
            agent_id: agentId,
          }),
        );
      }
    }
  }

  // (b) Reviewer panel role check (non-rejected agents — rejected already caught above).
  for (const agentId of reviewerPanel) {
    const agent = ctx.flock.get(agentId) as FlockAgent;
    if (!agent.resolved_roles.includes("reviewer")) {
      throw new HolpRpcError(
        holpError(
          "role_unsupported",
          `agent '${agentId}' does not have role 'reviewer' in resolved_roles`,
          { agent_id: agentId, role: "reviewer", resolved_roles: agent.resolved_roles },
        ),
      );
    }
  }

  // (c) Quorum shape checks (after role checks, per §6.2 ordering).
  if (reviewerPanel.length > 0) {
    if (quorum <= 0) {
      throw new HolpRpcError(holpError("invalid_quorum", "quorum must be > 0"));
    }
    if (quorum > reviewerPanel.length) {
      throw new HolpRpcError(holpError("invalid_quorum", "quorum > panel size"));
    }
  }

  // --- Validation step 4: quorum_unsatisfiable ---
  if (reviewerPanel.length > 0) {
    // Count reviewer-capable agents (resolved_roles includes reviewer, not rejected).
    const reviewerCapable = reviewerPanel.filter((id) => {
      const a = ctx.flock.get(id) as FlockAgent;
      return a.status !== "rejected" && a.resolved_roles.includes("reviewer");
    });
    if (reviewerCapable.length < quorum) {
      throw new HolpRpcError(
        holpError(
          "quorum_unsatisfiable",
          `only ${reviewerCapable.length} reviewer-capable agents but quorum=${quorum}`,
          { available: reviewerCapable.length, quorum },
        ),
      );
    }
  }

  // --- Validation step 5: unsupported_execution_mode ---
  const execMode = isObject(params.execution_mode) ? params.execution_mode : {};
  if (
    params.execution_mode !== undefined &&
    (execMode as Record<string, unknown>).kind !== "Local"
  ) {
    throw new HolpRpcError(
      holpError(
        "unsupported_execution_mode",
        `execution_mode.kind must be "Local", got "${String((execMode as Record<string, unknown>).kind)}"`,
        { kind: (execMode as Record<string, unknown>).kind },
      ),
    );
  }

  // --- Validation step 6: approval_required_but_unsupported ---
  // Current run path may trigger provider permission requests; per §7 the daemon must
  // reject at accept-time if the client did not negotiate approval support.
  // Generic gate/policy-driven approval detection is M4.
  // This check is LAST in accept-time order (after agent_not_found, role_unsupported,
  // invalid_quorum, quorum_unsatisfiable, unsupported_execution_mode) so it never
  // masks an earlier-stage error.
  if (ctx.initialized?.negotiated.approval.supported !== true) {
    throw new HolpRpcError(
      holpError(
        "approval_required_but_unsupported",
        "this run requires merge_approval but the client did not negotiate approval.supported:true",
      ),
    );
  }

  // --- Determine coder agent (required for the current single-backend run) ---
  let coderAgentId: string | undefined;
  if (isObject(roles.coder) && typeof (roles.coder as Record<string, unknown>).agent === "string") {
    coderAgentId = (roles.coder as Record<string, unknown>).agent as string;
  }

  // We need a coder agent for the run engine.
  // If none specified, pick the first non-reviewer role agent, or any ready agent.
  if (!coderAgentId) {
    // Fallback: find any ready agent in the flock.
    for (const [id, agent] of ctx.flock) {
      if (agent.status === "ready") {
        coderAgentId = id;
        break;
      }
    }
  }

  if (!coderAgentId) {
    throw new HolpRpcError(
      holpError(
        "unsupported_transport",
        "no ready coder agent available; declare a ready coder transport agent first",
      ),
    );
  }

  const coderAgent = ctx.flock.get(coderAgentId) as FlockAgent;
  const factory = registry.resolve(coderAgent.transport);
  if (!factory) {
    throw new HolpRpcError(
      holpError("unsupported_transport", `no adapter for transport '${coderAgent.transport}'`),
    );
  }

  // --- Create run record ---
  const runId = nextRunId();
  const bus = new EventBus(runId, clock);

  const run: RunRecord = {
    run_id: runId,
    goal,
    trigger,
    status: "active",
    bus,
    pendingApprovals: new Set(),
    approvalSeq: 0,
  };
  ctx.runs.set(runId, run);

  // --- Create backend and wire it ---
  const backend = factory({
    cwd: process.cwd(),
    permissionHandler: async (toolName: string, input: unknown) => {
      // The permissionHandler creates an approval record, emits approval_requested,
      // and returns a PENDING Promise. The backend awaits it (genuinely paused).
      // Resolved by approval.resolve calling resumeBackend(decision).
      return new Promise((resolveVerdict) => {
        run.approvalSeq += 1;
        const approvalId = `ap_${runId}_${clock.now()}_${run.approvalSeq}`;
        const expiresAt = clock.now() + 300;

        const resumeBackend = (decision: "allow" | "deny"): void => {
          resolveVerdict(
            decision === "allow"
              ? { decision: "allow" as const, reason: "user_decision" }
              : { decision: "deny" as const, reason: "user_rejected" },
          );
        };

        ctx.approvals.set(approvalId, {
          approval_id: approvalId,
          run_id: runId,
          kind: "merge_approval",
          reason: `${toolName} requires human approval`,
          expires_at: expiresAt,
          state: "pending",
          resumeBackend,
        });
        run.pendingApprovals.add(approvalId);

        bus.publish("approval", "approval_requested", {
          approval_id: approvalId,
          kind: "merge_approval",
          reason: `${toolName} requires human approval`,
          expires_at: expiresAt,
          provenance: { step_id: "step_coder", artifact_id: null },
          // M1b: inline details form (clients negotiate artifact_refs:false). Envelope form for artifact_refs:true deferred to M2/M5 conformance.
          details: {
            inline: true,
            type: "approval_details",
            mime: "application/json",
            content: JSON.stringify({ tool: toolName, input }),
            truncated: false,
          },
        });
        // Promise is NOT resolved here — the backend awaits until approval.resolve is called.
      });
    },
  });
  run.backend = backend;

  // --- Kick off the run asynchronously ---
  // Fire-and-forget; backend.dispose in driveRun handles spawned adapter processes when the turn ends.
  void driveRun(run, backend, ctx, clock);

  return { run_id: runId, accepted: true };
}
