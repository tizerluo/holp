import type { EventFrame } from "../cli/wire.js";
import { isKnownHarnessEvent } from "./knownEvents.js";
import { roleSkinFor } from "./roleSkins.js";
import type {
  ApprovalState,
  ChainNode,
  DiscoveredAgent,
  FailureKind,
  FailureState,
  GateState,
  HarnessWorkspaceOptions,
  HarnessWorkspaceState,
  RawEvidenceAnchor,
  RuntimeSurfaceRow,
  TerminalState,
  WorkerAnchor,
  WorkerPreview,
} from "./types.js";

const DEFAULT_PREVIEW_LIMIT = 4000;
const TRUNCATION_MARKER = "\n[truncated]";

export function createHarnessWorkspaceState(
  options: HarnessWorkspaceOptions = {},
): HarnessWorkspaceState {
  return {
    locale: options.locale ?? "en-US",
    provenance: options.provenance ?? "unknown",
    previewLimit: options.previewLimit ?? DEFAULT_PREVIEW_LIMIT,
    run: {},
    agents: {},
    chain: baseChain(undefined, {}),
    events: [],
    unknownEvents: [],
    rawEvidenceAnchors: [],
    seenEventKeys: [],
    workerPreview: emptyPreview(),
    artifactRefs: [],
    failures: [],
  };
}

export function recordInitialize(
  state: HarnessWorkspaceState,
  initializeResult: unknown,
): HarnessWorkspaceState {
  const payload = objectPayload(initializeResult);
  const client = objectPayload(payload.client);
  const controller = stringField(payload, "clientName")
    ?? stringField(payload, "client_name")
    ?? stringField(client, "name");
  return {
    ...state,
    run: { ...state.run, controller_agent_id: controller ?? state.run.controller_agent_id },
    chain: baseChain(controller ?? state.run.controller_agent_id, state.agents),
  };
}

export function recordDiscovery(
  state: HarnessWorkspaceState,
  discoveryResult: unknown,
  options: { readonly replace?: boolean } = {},
): HarnessWorkspaceState {
  const payload = objectPayload(discoveryResult);
  const agents = arrayPayload(payload.agents).reduce<Record<string, DiscoveredAgent>>((acc, value) => {
    const agent = objectPayload(value);
    const id = stringField(agent, "id");
    if (!id) return acc;
    acc[id] = {
      id,
      status: stringField(agent, "status"),
      role: stringField(agent, "role"),
      runtime_surfaces: runtimeSurfaces(agent.runtime_surfaces),
      raw: value,
    };
    return acc;
  }, options.replace ? {} : { ...state.agents });

  return {
    ...state,
    agents,
    chain: baseChain(state.run.controller_agent_id, agents),
  };
}

export function recordRunAccepted(
  state: HarnessWorkspaceState,
  runResult: unknown,
): HarnessWorkspaceState {
  const payload = objectPayload(runResult);
  const runtime = objectPayload(payload.runtime);
  const run_id = stringField(payload, "run_id") ?? state.run.run_id;
  const selected = stringField(payload, "agent_id")
    ?? stringField(payload, "selected_agent_id")
    ?? stringField(runtime, "agent_id")
    ?? state.run.selected_agent_id;
  const run = {
    ...state.run,
    run_id,
    selected_agent_id: selected,
    runtime_surface: stringField(payload, "runtime_surface")
      ?? stringField(runtime, "runtime_surface")
      ?? state.run.runtime_surface,
    runtime_kind: stringField(runtime, "runtime_kind") ?? state.run.runtime_kind,
    isolation_profile: stringField(payload, "isolation_profile")
      ?? stringField(runtime, "isolation_profile")
      ?? state.run.isolation_profile,
    goal: stringField(payload, "goal") ?? state.run.goal,
  };
  const next = {
    ...state,
    run,
  };
  return {
    ...next,
    chain: baseChain(run.controller_agent_id, next.agents, next),
  };
}

export function recordEvent(
  state: HarnessWorkspaceState,
  event: EventFrame,
): HarnessWorkspaceState {
  const key = `${event.run_id}:${event.seq}`;
  if (state.seenEventKeys.includes(key)) return state;

  const isKnown = isKnownEvent(event);
  const rawAnchor: RawEvidenceAnchor = {
    source: isKnown ? "event" : "unknown_event",
    run_id: event.run_id,
    seq: event.seq,
    category: event.category,
    name: event.name,
    payload: event.payload,
  };

  let next: HarnessWorkspaceState = {
    ...state,
    run: { ...state.run, run_id: state.run.run_id ?? event.run_id },
    events: [...state.events, event],
    latestEvent: event,
    unknownEvents: isKnown ? state.unknownEvents : [...state.unknownEvents, event],
    rawEvidenceAnchors: [...state.rawEvidenceAnchors, rawAnchor],
    seenEventKeys: [...state.seenEventKeys, key],
  };

  if (!isKnown) return next;

  switch (event.name) {
    case "run_started":
      next = recordRunStarted(next, event);
      break;
    case "step_started":
      next = recordStepStarted(next, event);
      break;
    case "agent_event":
      next = recordAgentEvent(next, event);
      break;
    case "model_output":
      next = recordModelOutput(next, event);
      break;
    case "gate_report":
      next = recordGateReport(next, event);
      break;
    case "approval_requested":
      next = recordApproval(next, event, "requested");
      break;
    case "approval_resolved":
      next = recordApproval(next, event, "resolved");
      break;
    case "approval_expired":
      next = appendFailure(recordApproval(next, event, "expired"), event, "approval_expired", "failureApprovalExpired");
      break;
    case "approval_cancelled":
      next = appendFailure(recordApproval(next, event, "cancelled"), event, "approval_cancelled", "failureApprovalCancelled");
      break;
    case "run_blocked":
      next = recordTerminal(next, event, "blocked");
      next = appendFailure(next, event, "run_blocked", "failureRunBlocked", reasonFrom(event));
      break;
    case "run_gave_up": {
      const cancelled = reasonFrom(event) === "cancelled";
      next = recordTerminal(next, event, cancelled ? "cancelled" : "gave_up");
      next = appendFailure(
        next,
        event,
        cancelled ? "run_cancelled" : "run_gave_up",
        cancelled ? "failureRunCancelled" : "failureRunGaveUp",
        reasonFrom(event),
      );
      break;
    }
    case "run_merged":
      next = recordTerminal(next, event, "merged");
      break;
    case "consensus_degraded":
      next = appendFailure(next, event, "consensus_degraded", "failureConsensusDegraded", reasonFrom(event));
      break;
  }

  return {
    ...next,
    chain: baseChain(next.run.controller_agent_id, next.agents, next),
  };
}

function recordRunStarted(state: HarnessWorkspaceState, event: EventFrame): HarnessWorkspaceState {
  const payload = objectPayload(event.payload);
  const runtime = objectPayload(payload.runtime);
  return {
    ...state,
    run: {
      ...state.run,
      run_id: event.run_id,
      selected_agent_id: stringField(runtime, "agent_id") ?? state.run.selected_agent_id,
      runtime_surface: stringField(runtime, "runtime_surface") ?? state.run.runtime_surface,
      runtime_kind: stringField(runtime, "runtime_kind") ?? state.run.runtime_kind,
      isolation_profile: stringField(runtime, "isolation_profile") ?? state.run.isolation_profile,
    },
  };
}

function recordStepStarted(state: HarnessWorkspaceState, event: EventFrame): HarnessWorkspaceState {
  const payload = objectPayload(event.payload);
  const detail = stringField(payload, "detail");
  const selected = stringField(payload, "agent_id") ?? stringField(payload, "agent") ?? state.run.selected_agent_id;
  const anchor = detail && isHolpSessionName(detail)
    ? mergeAnchor(state.workerAnchor, {
        worker_session: detail,
        attach_command: `tmux attach -t ${detail}`,
        agent_id: selected,
        source: "step_started.detail" as const,
      })
    : state.workerAnchor;
  return {
    ...state,
    run: { ...state.run, selected_agent_id: selected },
    workerAnchor: anchor,
  };
}

function recordAgentEvent(state: HarnessWorkspaceState, event: EventFrame): HarnessWorkspaceState {
  const payload = objectPayload(event.payload);
  if (stringField(payload, "name") !== "attach_target") return state;
  const nested = objectPayload(payload.payload);
  const anchor: WorkerAnchor = {
    worker_session: stringField(nested, "worker_session")
      ?? stringField(nested, "session_id")
      ?? stringField(nested, "target"),
    attach_command: stringField(nested, "attach_command"),
    agent_id: stringField(nested, "agent_id") ?? stringField(nested, "target_agent_id") ?? state.run.selected_agent_id,
    source: "agent_event.attach_target",
  };
  return {
    ...state,
    run: { ...state.run, selected_agent_id: anchor.agent_id ?? state.run.selected_agent_id },
    workerAnchor: mergeAnchor(state.workerAnchor, anchor),
  };
}

function recordModelOutput(state: HarnessWorkspaceState, event: EventFrame): HarnessWorkspaceState {
  const payload = objectPayload(event.payload);
  const fullText = stringField(payload, "full_text");
  const delta = stringField(payload, "text_delta");
  if (fullText === undefined && delta === undefined) return state;
  const nextText = fullText !== undefined ? fullText : `${state.workerPreview.fullText}${delta ?? ""}`;
  const eventProducer = stringField(payload, "agent_id")
    ?? stringField(payload, "agent")
    ?? state.run.selected_agent_id;
  const attribution = previewAttribution(state.workerPreview, fullText !== undefined, eventProducer);
  return {
    ...state,
    workerPreview: renderPreview(
      nextText,
      state.previewLimit,
      fullText !== undefined || state.workerPreview.authoritativeSnapshot,
      attribution.producer_attribution,
      attribution.producer_agent_id,
    ),
  };
}

function previewAttribution(
  previous: WorkerPreview,
  isFullText: boolean,
  eventProducer: string | undefined,
): Pick<WorkerPreview, "producer_attribution" | "producer_agent_id"> {
  if (isFullText) {
    return eventProducer
      ? { producer_attribution: "single", producer_agent_id: eventProducer }
      : { producer_attribution: "none" };
  }
  if (previous.producer_attribution === "mixed") {
    return { producer_attribution: "mixed" };
  }
  if (previous.producer_attribution === "none" && previous.fullText.length === 0) {
    return eventProducer
      ? { producer_attribution: "single", producer_agent_id: eventProducer }
      : { producer_attribution: "none" };
  }
  if (
    previous.producer_attribution === "single"
    && previous.producer_agent_id
    && previous.producer_agent_id === eventProducer
  ) {
    return { producer_attribution: "single", producer_agent_id: previous.producer_agent_id };
  }
  return { producer_attribution: "mixed" };
}

function recordGateReport(state: HarnessWorkspaceState, event: EventFrame): HarnessWorkspaceState {
  const payload = objectPayload(event.payload);
  const decision = objectOrUndefined(payload.decision_surface);
  const gate: GateState = {
    event,
    decisionSurface: decision,
    gateDisposition: decision ? stringField(decision, "gate_disposition") : undefined,
    reviewOutcome: decision ? stringField(decision, "review_outcome") : undefined,
    blockingReason: stringField(payload, "blocking_reason"),
  };
  const withGate = {
    ...state,
    gate,
    artifactRefs: mergeStrings(state.artifactRefs, artifactRefsFrom(payload)),
  };
  if (!gate.blockingReason) return withGate;
  return appendFailure(withGate, event, "gate_blocking", "failureGateBlocking", gate.blockingReason);
}

function recordApproval(
  state: HarnessWorkspaceState,
  event: EventFrame,
  approvalState: ApprovalState["state"],
): HarnessWorkspaceState {
  const payload = objectPayload(event.payload);
  return {
    ...state,
    approval: {
      state: approvalState,
      approval_id: stringField(payload, "approval_id"),
      decision: stringField(payload, "decision"),
      event,
    },
  };
}

function recordTerminal(
  state: HarnessWorkspaceState,
  event: EventFrame,
  kind: TerminalState["kind"],
): HarnessWorkspaceState {
  const payload = objectPayload(event.payload);
  const artifactRefs = artifactRefsFrom(payload);
  return {
    ...state,
    terminal: {
      kind,
      event,
      reason: reasonFrom(event),
      artifactRefs,
    },
    artifactRefs: mergeStrings(state.artifactRefs, artifactRefs),
  };
}

function appendFailure(
  state: HarnessWorkspaceState,
  event: EventFrame,
  kind: FailureKind,
  messageKey: string,
  reason?: string,
): HarnessWorkspaceState {
  const duplicate = state.failures.some((failure) =>
    failure.kind === kind && failure.event.run_id === event.run_id && failure.event.seq === event.seq
  );
  if (duplicate) return state;
  const failure: FailureState = { kind, messageKey, reason, event };
  return { ...state, failures: [...state.failures, failure] };
}

function baseChain(
  controllerAgentId: string | undefined,
  agents: Readonly<Record<string, DiscoveredAgent>>,
  state?: HarnessWorkspaceState,
): readonly ChainNode[] {
  const nodes: ChainNode[] = [
    { id: "human", label: "human", skin: "CTRL", state: "active" },
    { id: "controller", label: controllerAgentId ?? "controller", skin: "CTRL", state: "active", agentId: controllerAgentId },
    { id: "holp", label: "HOLP public wire", skin: "GATE", state: "active" },
  ];
  for (const agent of Object.values(agents)) {
    nodes.push({
      id: `agent:${agent.id}`,
      label: agent.id,
      skin: roleSkinFor(agent.role ?? agent.id),
      state: stateForAgent(agent, state),
      agentId: agent.id,
    });
  }
  nodes.push({
    id: "gate",
    label: "gate",
    skin: "GATE",
    state: state?.gate ? "active" : "unknown",
  });
  return nodes;
}

function stateForAgent(agent: DiscoveredAgent, state?: HarnessWorkspaceState): ChainNode["state"] {
  if (!state) return "unknown";
  if (state.terminal?.kind === "merged") return "done";
  if (state.failures.length > 0 && state.run.selected_agent_id === agent.id) return "failed";
  if (state.run.selected_agent_id === agent.id) return "active";
  return agent.status === "ready" ? "idle" : "unknown";
}

function isKnownEvent(event: EventFrame): boolean {
  return isKnownHarnessEvent(event.category, event.name);
}

function emptyPreview(): WorkerPreview {
  return {
    fullText: "",
    renderedText: "",
    truncated: false,
    authoritativeSnapshot: false,
    producer_attribution: "none",
  };
}

function renderPreview(
  text: string,
  limit: number,
  authoritativeSnapshot: boolean,
  producerAttribution: WorkerPreview["producer_attribution"],
  producerAgentId: string | undefined,
): WorkerPreview {
  if (text.length <= limit) {
    return {
      fullText: text,
      renderedText: text,
      truncated: false,
      authoritativeSnapshot,
      producer_attribution: producerAttribution,
      producer_agent_id: producerAgentId,
    };
  }
  const sliceLength = Math.max(0, limit - TRUNCATION_MARKER.length);
  return {
    fullText: text,
    renderedText: `${text.slice(0, sliceLength)}${TRUNCATION_MARKER}`,
    truncated: true,
    authoritativeSnapshot,
    producer_attribution: producerAttribution,
    producer_agent_id: producerAgentId,
  };
}

function mergeAnchor(previous: WorkerAnchor | undefined, next: WorkerAnchor): WorkerAnchor {
  if (previous?.source === "agent_event.attach_target" && previous.attach_command && next.source === "step_started.detail") {
    return previous;
  }
  return {
    worker_session: next.worker_session ?? previous?.worker_session,
    attach_command: next.attach_command ?? previous?.attach_command,
    agent_id: next.agent_id ?? previous?.agent_id,
    source: next.source,
  };
}

function isHolpSessionName(value: string): boolean {
  return /^holp-[A-Za-z0-9_.:-]+$/.test(value);
}

function runtimeSurfaces(value: unknown): readonly RuntimeSurfaceRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    const object = objectOrUndefined(entry);
    return object ? [object as RuntimeSurfaceRow] : [];
  });
}

function artifactRefsFrom(payload: Record<string, unknown>): readonly string[] {
  const refs: string[] = [];
  for (const key of ["artifact_id", "artifact_ref"]) {
    const value = stringField(payload, key);
    if (value) refs.push(value);
  }
  for (const key of ["artifact_refs", "artifacts"]) {
    for (const item of arrayPayload(payload[key])) {
      if (typeof item === "string") refs.push(item);
      const object = objectOrUndefined(item);
      const id = object ? stringField(object, "artifact_id") ?? stringField(object, "id") : undefined;
      if (id) refs.push(id);
    }
  }
  return refs;
}

function mergeStrings(left: readonly string[], right: readonly string[]): readonly string[] {
  return [...new Set([...left, ...right])];
}

function reasonFrom(event: EventFrame): string | undefined {
  return stringField(objectPayload(event.payload), "reason");
}

export function objectPayload(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function arrayPayload(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringField(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

export function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}
