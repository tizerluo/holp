import type { EventFrame } from "../cli/wire.js";
import { t, type MessageKey } from "./messages.js";
import { roleSkinFor } from "./roleSkins.js";
import type {
  DiscoveredAgent,
  HarnessInspectModel,
  HarnessOverviewModel,
  HarnessWorkspaceState,
  InspectAgentDetail,
  InspectEvidenceRef,
  InspectRow,
  OwnerVerificationState,
  RenderEvidenceSummary,
  RuntimeSurfaceRow,
  WorkerAnchor,
} from "./types.js";

export function deriveOverview(state: HarnessWorkspaceState): HarnessOverviewModel {
  return {
    mode: "overview",
    title: t(state.locale, "titleOverview"),
    labels: labels(state),
    chain: state.chain,
    workerPreview: state.workerPreview,
    evidence: evidenceSummary(state, state.run.selected_agent_id),
    failures: state.failures.map((failure) => failureLine(state, failure.messageKey as MessageKey, failure.reason)),
    rawEvidenceAnchors: state.rawEvidenceAnchors,
  };
}

export function deriveInspect(
  state: HarnessWorkspaceState,
  selectedAgentId: string | undefined,
): HarnessInspectModel {
  const overview = deriveOverview(state);
  const agent = selectedAgentId ? state.agents[selectedAgentId] : undefined;
  return {
    ...overview,
    mode: "inspect",
    title: t(state.locale, "titleInspect"),
    selectedAgentId,
    selectedAgent: agent ? selectedAgent(state, agent) : undefined,
    inspect: agent ? inspectAgentDetail(state, agent) : undefined,
    empty: !agent,
  };
}

export function ownerVerificationForAgent(
  state: HarnessWorkspaceState,
  agentId: string | undefined,
): OwnerVerificationState {
  if (!agentId) return "unknown";
  const agent = state.agents[agentId];
  if (!agent?.runtime_surfaces) return "unknown";
  const direct = agent.runtime_surfaces
    .map((surface) => surface.direct_channel)
    .find((channel) => typeof channel === "object" && channel !== null);
  if (!direct) return "unknown";
  const bitmask = direct.capability_bitmask;
  if (!Array.isArray(bitmask)) return "unknown";
  return bitmask.includes("owner_verified") ? "verified" : "unverified";
}

function evidenceSummary(
  state: HarnessWorkspaceState,
  selectedAgentId: string | undefined,
): RenderEvidenceSummary {
  return {
    run_id: state.run.run_id,
    runtime_surface: state.run.runtime_surface,
    worker_session: state.workerAnchor?.worker_session,
    attach_command: state.workerAnchor?.attach_command,
    owner_verified: ownerVerificationForAgent(state, selectedAgentId),
    latest_event: state.latestEvent ? eventLabel(state.latestEvent) : undefined,
    gate: state.gate
      ? {
          gate_disposition: state.gate.gateDisposition,
          review_outcome: state.gate.reviewOutcome,
          blocking_reason: state.gate.blockingReason,
        }
      : undefined,
    artifact_refs: state.artifactRefs,
    approval: state.approval
      ? {
          state: state.approval.state,
          approval_id: state.approval.approval_id,
          decision: state.approval.decision,
        }
      : undefined,
    terminal: state.terminal
      ? {
          state: state.terminal.kind,
          reason: state.terminal.reason,
        }
      : undefined,
    provenance: state.provenance,
    provenance_caveat: t(
      state.locale,
      state.provenance === "smoke_script" ? "provenanceSmoke" : "provenanceUnknown",
    ),
  };
}

function selectedAgent(state: HarnessWorkspaceState, agent: DiscoveredAgent): NonNullable<HarnessInspectModel["selectedAgent"]> {
  return {
    id: agent.id,
    status: agent.status,
    roleSkin: roleSkinFor(agent.role ?? agent.id),
    owner_verified: ownerVerificationForAgent(state, agent.id),
    runtime_surfaces: agent.runtime_surfaces ?? [],
    latestEvent: latestEventForAgent(state, agent.id),
  };
}

function inspectAgentDetail(state: HarnessWorkspaceState, agent: DiscoveredAgent): InspectAgentDetail {
  const latestEvent = latestEventForAgent(state, agent.id);
  const owner = ownerVerificationForAgent(state, agent.id);
  const roleSkin = roleSkinFor(agent.role ?? agent.id);
  const anchor = workerAnchorForAgent(state, agent.id);
  const output = outputForAgent(state, agent.id);
  const gate = state.gate;
  const approval = state.approval;
  const terminal = state.terminal;
  const refs = evidenceRefs(state);
  const failures = state.failures.length > 0
    ? state.failures.map((failure) => failureLine(state, failure.messageKey as MessageKey, failure.reason)).join(" | ")
    : t(state.locale, "inspectFailureNone");

  return {
    agent_id: agent.id,
    output,
    evidenceRefs: refs,
    sections: [
      {
        title: t(state.locale, "inspectIdentity"),
        rows: [
          row("agent_id", agent.id, "identity", "identity"),
          row(t(state.locale, "inspectStatus"), agent.status ?? t(state.locale, "unknown"), "identity", "identity"),
          row(t(state.locale, "inspectRole"), roleSkin, "identity", "identity"),
          row(t(state.locale, "inspectOwner"), owner, "identity", "identity"),
          row(t(state.locale, "inspectLatestEvent"), latestEvent ? eventLabel(latestEvent) : "pending", "critical"),
        ],
      },
      {
        title: t(state.locale, "inspectRuntime"),
        rows: [
          row("runtime_surface", runtimeSurfaceForAgent(agent.runtime_surfaces), "normal"),
          row(t(state.locale, "inspectDirectSession"), anchor?.worker_session ?? t(state.locale, "inspectNoDirectSession"), "normal"),
          row(t(state.locale, "inspectAttachCommand"), anchor?.attach_command ?? t(state.locale, "inspectNoAttachCommand"), "normal"),
          row(t(state.locale, "inspectCancelCapability"), cancelCapabilityForAgent(agent.runtime_surfaces, state.locale), "critical"),
        ],
      },
      {
        title: t(state.locale, "inspectOutput"),
        rows: [
          row("model_output.*", output.text, output.state === "unavailable" ? "critical" : "normal", "content"),
        ],
      },
      {
        title: t(state.locale, "inspectDecision"),
        rows: [
          row(t(state.locale, "inspectGate"), gateLine(gate), gate?.blockingReason ? "critical" : "normal"),
          row(t(state.locale, "inspectApproval"), approvalLine(state, approval), approval?.state === "expired" || approval?.state === "cancelled" ? "critical" : "normal"),
          row(t(state.locale, "inspectTerminal"), terminalLine(terminal), terminal && terminal.kind !== "merged" ? "critical" : "normal"),
        ],
      },
      {
        title: t(state.locale, "inspectFailure"),
        rows: [
          row(t(state.locale, "inspectReason"), failures, state.failures.length > 0 ? "critical" : "normal", "failure"),
        ],
      },
      {
        title: t(state.locale, "inspectEvidenceRefs"),
        rows: refs.map((ref) => row(ref.ref, `run_id=${ref.run_id} seq=${ref.seq}`, "optional")),
      },
    ],
  };
}

function row(
  label: string,
  value: string,
  priority: InspectRow["priority"],
  kind?: InspectRow["kind"],
): InspectRow {
  return kind ? { label, value, priority, kind } : { label, value, priority };
}

function outputForAgent(state: HarnessWorkspaceState, agentId: string): InspectAgentDetail["output"] {
  if (state.workerPreview.producer_attribution !== "single" || agentId !== state.workerPreview.producer_agent_id) {
    return {
      state: "unavailable",
      text: t(state.locale, "inspectNoOutputForAgent"),
    };
  }
  const text = state.workerPreview.renderedText.trim() || "no model_output.text_delta yet";
  return {
    state: state.workerPreview.renderedText.trim() ? "captured" : "pending",
    text,
    truncated: state.workerPreview.truncated,
  };
}

function workerAnchorForAgent(state: HarnessWorkspaceState, agentId: string): WorkerAnchor | undefined {
  const anchor = state.workerAnchor;
  if (!anchor) return undefined;
  if (anchor.agent_id === agentId) return anchor;
  if (!anchor.agent_id && state.run.selected_agent_id === agentId) return anchor;
  return undefined;
}

function runtimeSurfaceForAgent(surfaces: readonly RuntimeSurfaceRow[] | undefined): string {
  return surfaces?.map((surface) => surface.runtime_surface).filter(Boolean).join(",") || "unknown";
}

function cancelCapabilityForAgent(
  surfaces: readonly RuntimeSurfaceRow[] | undefined,
  locale: HarnessWorkspaceState["locale"],
): string {
  const supported = surfaces?.some((surface) => {
    const direct = surface.direct_channel;
    if (typeof direct !== "object" || direct === null) return false;
    const bitmask = direct.capability_bitmask;
    return Array.isArray(bitmask) && bitmask.includes("cancel");
  }) ?? false;
  return t(locale, supported ? "cancelSupported" : "cancelUnavailable");
}

function gateLine(gate: HarnessWorkspaceState["gate"]): string {
  if (!gate) return "pending";
  return [
    gate.gateDisposition ?? "pending",
    gate.reviewOutcome,
    gate.blockingReason ? `blocking_reason=${gate.blockingReason}` : undefined,
  ].filter(Boolean).join(" ");
}

function approvalLine(state: HarnessWorkspaceState, approval: HarnessWorkspaceState["approval"]): string {
  if (!approval) return "pending";
  const key = approval.state === "requested"
    ? "approvalRequested"
    : approval.state === "resolved"
      ? "approvalResolved"
      : approval.state === "expired"
        ? "approvalExpired"
        : "approvalCancelled";
  return [
    t(state.locale, key),
    approval.approval_id ? `approval_id=${approval.approval_id}` : undefined,
    approval.decision ? `decision=${approval.decision}` : undefined,
  ].filter(Boolean).join(" ");
}

function terminalLine(terminal: HarnessWorkspaceState["terminal"]): string {
  if (!terminal) return "pending";
  return terminal.reason ? `${terminal.kind} reason=${terminal.reason}` : terminal.kind;
}

function evidenceRefs(state: HarnessWorkspaceState): readonly InspectEvidenceRef[] {
  return state.rawEvidenceAnchors.slice(-8).map((anchor) => ({
    ref: `${anchor.category}.${anchor.name}#${anchor.seq}`,
    run_id: anchor.run_id,
    seq: anchor.seq,
  }));
}

function latestEventForAgent(state: HarnessWorkspaceState, agentId: string): EventFrame | undefined {
  return [...state.events].reverse().find((event) => {
    const payload = typeof event.payload === "object" && event.payload !== null
      ? event.payload as Record<string, unknown>
      : {};
    if (payload.agent_id === agentId || payload.agent === agentId) return true;
    if (event.name !== "agent_event" || payload.name !== "attach_target") return false;
    const nested = typeof payload.payload === "object" && payload.payload !== null
      ? payload.payload as Record<string, unknown>
      : {};
    return nested.agent_id === agentId || nested.target_agent_id === agentId;
  });
}

function labels(state: HarnessWorkspaceState): Record<string, string> {
  return {
    chain: t(state.locale, "chain"),
    workerPreview: t(state.locale, "workerPreview"),
    evidence: t(state.locale, "evidence"),
    failures: t(state.locale, "failures"),
    unknown: t(state.locale, "unknown"),
    inspectEmpty: t(state.locale, "inspectEmpty"),
  };
}

function failureLine(state: HarnessWorkspaceState, key: MessageKey, reason: string | undefined): string {
  const prefix = t(state.locale, key);
  return reason ? `${prefix}: ${reason}` : prefix;
}

function eventLabel(event: EventFrame): string {
  return `${event.category}.${event.name}#${event.seq}`;
}
