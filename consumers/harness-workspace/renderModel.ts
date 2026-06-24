import type { EventFrame } from "../cli/wire.js";
import { t, type MessageKey } from "./messages.js";
import { roleSkinFor } from "./roleSkins.js";
import type {
  DiscoveredAgent,
  HarnessInspectModel,
  HarnessOverviewModel,
  HarnessWorkspaceState,
  OwnerVerificationState,
  RenderEvidenceSummary,
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
