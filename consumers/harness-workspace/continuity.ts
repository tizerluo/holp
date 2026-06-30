import { ownerVerificationForAgent } from "./renderModel.js";
import type {
  HarnessSessionContinuity,
  HarnessWorkspaceState,
  RuntimeSurfaceRow,
} from "./types.js";

export interface ContinuityOptions {
  readonly replayCreatedAt?: string;
}

export function deriveContinuity(
  state: HarnessWorkspaceState,
  options: ContinuityOptions = {},
): HarnessSessionContinuity {
  const selected = state.run.selected_agent_id;
  const owner = ownerVerificationForAgent(state, selected);
  const surfaces = selected ? state.agents[selected]?.runtime_surfaces : undefined;
  const hasRunIdentity = Boolean(state.run.run_id);
  const hasRuntimeSurface = Boolean(state.run.runtime_surface);
  const hasAttach = Boolean(state.workerAnchor?.attach_command);
  const hasWorkerSession = Boolean(state.workerAnchor?.worker_session);
  const hasStoredGoal = Boolean(state.run.goal);
  const hasTerminal = Boolean(state.terminal);
  const canInspect = state.events.length > 0 || state.rawEvidenceAnchors.length > 0;
  const canCopy = Boolean(state.run.run_id || state.workerAnchor?.attach_command);
  const canContinue = owner === "verified"
    && !hasTerminal
    && hasRunIdentity
    && hasRuntimeSurface
    && hasAttach
    && hasWorkerSession
    && hasCapability(surfaces, "inject");
  const canRerun = owner === "verified"
    && hasRunIdentity
    && Boolean(selected)
    && hasRuntimeSurface
    && hasStoredGoal;
  const rerunCommand = canRerun && selected && state.run.goal
    ? `holp run ${shellQuote(state.run.goal)} --worker ${shellQuote(selected)}`
    : undefined;
  const reasons = continuityReasons({
    owner,
    hasRunIdentity,
    hasRuntimeSurface,
    hasSelectedWorker: Boolean(selected),
    hasAttach,
    hasWorkerSession,
    hasStoredGoal,
    canInspect,
    canCopy,
    canContinue,
    canRerun,
  });

  return {
    run_id: state.run.run_id,
    observed_agent_ids: Object.keys(state.agents).sort(),
    selected_agent_id: selected,
    runtime_surface: state.run.runtime_surface,
    worker_session: state.workerAnchor?.worker_session,
    attach_command: state.workerAnchor?.attach_command,
    rerun_command: rerunCommand,
    terminal_state: state.terminal?.kind,
    owner_verified: owner,
    replay_created_at: options.replayCreatedAt,
    can_continue: canContinue,
    can_rerun: canRerun,
    can_inspect: canInspect,
    can_copy: canCopy,
    replay_only: !canContinue && !canRerun,
    reasons,
  };
}

export function hasCapability(
  surfaces: readonly RuntimeSurfaceRow[] | undefined,
  capability: string,
): boolean {
  return surfaces?.some((surface) => {
    const direct = surface.direct_channel;
    if (typeof direct !== "object" || direct === null) return false;
    const bitmask = direct.capability_bitmask;
    return Array.isArray(bitmask) && bitmask.includes(capability);
  }) ?? false;
}

function continuityReasons(options: {
  readonly owner: string;
  readonly hasRunIdentity: boolean;
  readonly hasRuntimeSurface: boolean;
  readonly hasSelectedWorker: boolean;
  readonly hasAttach: boolean;
  readonly hasWorkerSession: boolean;
  readonly hasStoredGoal: boolean;
  readonly canInspect: boolean;
  readonly canCopy: boolean;
  readonly canContinue: boolean;
  readonly canRerun: boolean;
}): readonly string[] {
  const reasons: string[] = [];
  if (!options.canInspect) reasons.push("no_public_wire_events");
  if (!options.canCopy) reasons.push("no_copy_source");
  if (options.owner !== "verified") reasons.push("owner_not_verified");
  if (!options.hasRunIdentity) reasons.push("run_id_missing");
  if (!options.hasRuntimeSurface) reasons.push("runtime_surface_missing");
  if (!options.hasSelectedWorker) reasons.push("selected_worker_missing");
  if (!options.hasWorkerSession) reasons.push("worker_session_missing");
  if (!options.hasAttach) reasons.push("attach_command_missing");
  if (
    !options.canRerun
    && options.owner === "verified"
    && options.hasRunIdentity
    && options.hasSelectedWorker
    && options.hasRuntimeSurface
    && !options.hasStoredGoal
  ) {
    reasons.push("rerun_goal_not_exported");
  }
  return [...new Set(reasons)];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
