import type {
  DirectChannelDeclaration,
  IsolationProfile,
  IsolationReadiness,
  RuntimeSurface,
  SurfaceSupport,
} from "../../adapters/harness-declaration.js";
import { ISOLATION_PROFILES } from "../../adapters/harness-declaration.js";
import type { EventCategory } from "./context.js";
import type { StoredEvent } from "./eventBus.js";
import type { FlockAgent } from "./stores.js";

export type DecisionType =
  | "run_accepted"
  | "runtime_selected"
  | "approval_requested"
  | "approval_resolved"
  | "approval_expired"
  | "approval_cancelled"
  | "reviewer_execution"
  | "consensus_verdict"
  | "consensus_degraded"
  | "run_terminal"
  | "workflow_selected"
  | "workflow_step_planned"
  | "workflow_step_started"
  | "workflow_step_completed"
  | "workflow_step_failed"
  | "dispatch_snapshot_recorded"
  | "training_sample_recorded"
  | "learned_router_shadow_prediction"
  | "learned_router_active_fallback"
  | "learned_router_active_selected"
  | "promotion_evidence_recorded"
  | "workflow_revised"
  | "workflow_revision_rejected";

export type RunLifecycleState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "merged"
  | "gave_up"
  | "cancelled"
  | "blocked";

export interface InternalEventRecord {
  readonly run_id: string;
  readonly seq: number;
  readonly ts: number;
  readonly category: EventCategory;
  readonly name: string;
  readonly payload: unknown;
}

export interface DecisionRecord {
  readonly decision_id: string;
  readonly kind: "decision_made";
  readonly decision_type: DecisionType;
  readonly run_id?: string;
  readonly agent_id?: string;
  readonly approval_id?: string;
  readonly reason?: string;
  readonly ts: number;
  readonly data?: unknown;
}

export interface HarnessRegistryRecord {
  readonly agent_id: string;
  readonly transport: string;
  readonly harness_id?: string;
  readonly vendor?: string;
  readonly transport_class?: string;
  readonly runtime_surface: RuntimeSurface;
  readonly runtime_kind: string;
  readonly surface_support: SurfaceSupport;
  readonly direct_channel?: DirectChannelDeclaration;
  readonly isolation_profile: IsolationProfile;
  readonly isolation_status: IsolationReadiness;
  readonly isolation_reason?: string;
  readonly isolation_missing?: readonly string[];
  readonly isolation_warnings?: readonly string[];
  readonly state_declaration_ref?: string;
  readonly global_mutation_required: boolean;
  readonly permission_surface: SurfaceSupport;
  readonly observability_surface: SurfaceSupport;
  readonly archived_at: number;
}

export interface RunStateTransition {
  readonly from: RunLifecycleState | null;
  readonly to: RunLifecycleState;
  readonly reason?: string;
  readonly ts: number;
}

export interface RunStateRecord {
  readonly run_id: string;
  state: RunLifecycleState;
  readonly history: RunStateTransition[];
  updated_at: number;
}

const RUNTIME_SURFACES: readonly RuntimeSurface[] = [
  "headless",
  "acp",
  "direct_user_session",
];

const ALLOWED_TRANSITIONS: Record<RunLifecycleState, readonly RunLifecycleState[]> = {
  queued: ["running"],
  running: ["waiting_approval", "merged", "gave_up", "blocked", "cancelling"],
  waiting_approval: ["running", "cancelling", "blocked", "merged", "gave_up"],
  cancelling: ["cancelled"],
  merged: [],
  gave_up: [],
  cancelled: [],
  blocked: [],
};

export class GovernanceStore {
  readonly events: InternalEventRecord[] = [];
  readonly decisions: DecisionRecord[] = [];
  readonly harnessRegistry: HarnessRegistryRecord[] = [];
  readonly runStates: Map<string, RunStateRecord> = new Map();

  private decisionCounter = 0;

  recordEvent(runId: string, event: StoredEvent): InternalEventRecord {
    const record: InternalEventRecord = {
      run_id: runId,
      seq: event.seq,
      ts: event.ts,
      category: event.category,
      name: event.name,
      payload: event.payload,
    };
    this.events.push(record);
    return record;
  }

  recordDecision(input: {
    decision_type: DecisionType;
    ts: number;
    run_id?: string;
    agent_id?: string;
    approval_id?: string;
    reason?: string;
    data?: unknown;
  }): DecisionRecord {
    this.decisionCounter += 1;
    const decision: DecisionRecord = {
      decision_id: `dec_${this.decisionCounter}`,
      kind: "decision_made",
      decision_type: input.decision_type,
      ts: input.ts,
      run_id: input.run_id,
      agent_id: input.agent_id,
      approval_id: input.approval_id,
      reason: input.reason,
      data: input.data,
    };
    this.decisions.push(decision);
    return decision;
  }

  archiveHarnessAgent(agent: FlockAgent, ts: number): readonly HarnessRegistryRecord[] {
    removeInPlace(this.harnessRegistry, (record) => record.agent_id === agent.id);

    const records = agent.runtime_surfaces?.length
      ? agent.runtime_surfaces.flatMap((surface) =>
          ISOLATION_PROFILES.map((profileName) => {
            const profile = surface.isolation_profiles[profileName] ?? {
              readiness: "rejected" as const,
              reason: "isolation_declaration_missing",
              missing: [`isolation_profile:${profileName}`],
            };
            return {
              agent_id: agent.id,
              transport: agent.transport,
              harness_id: agent.harness_id,
              vendor: agent.vendor,
              transport_class: agent.transport_class,
              runtime_surface: surface.runtime_surface,
              runtime_kind: surface.runtime_kind,
              surface_support: surface.surface_support,
              direct_channel: surface.direct_channel,
              isolation_profile: profileName,
              isolation_status: profile.readiness,
              isolation_reason: profile.reason,
              isolation_missing: profile.missing,
              isolation_warnings: profile.warnings,
              state_declaration_ref: surface.state_declaration_ref ?? agent.state_declaration_ref,
              global_mutation_required:
                surface.global_mutation_required || agent.global_mutation_required === true,
              permission_surface: "unknown",
              observability_surface: "unknown",
              archived_at: ts,
            } satisfies HarnessRegistryRecord;
          }),
        )
      : missingRuntimeRecords(agent, ts);

    this.harnessRegistry.push(...records);
    return records;
  }

  ensureRunState(runId: string, state: RunLifecycleState, ts: number): RunStateRecord {
    const existing = this.runStates.get(runId);
    if (existing) return existing;
    const record: RunStateRecord = {
      run_id: runId,
      state,
      updated_at: ts,
      history: [{ from: null, to: state, reason: "initial", ts }],
    };
    this.runStates.set(runId, record);
    return record;
  }

  transitionRun(
    runId: string,
    to: RunLifecycleState,
    ts: number,
    reason?: string,
  ): RunStateRecord {
    const record = this.ensureRunState(runId, "queued", ts);
    if (record.state === to) return record;
    const allowed = ALLOWED_TRANSITIONS[record.state];
    if (!allowed.includes(to)) {
      throw new Error(`invalid run state transition ${record.state} -> ${to}`);
    }
    const from = record.state;
    record.state = to;
    record.updated_at = ts;
    record.history.push({ from, to, reason, ts });
    return record;
  }
}

function missingRuntimeRecords(agent: FlockAgent, ts: number): HarnessRegistryRecord[] {
  return RUNTIME_SURFACES.flatMap((runtimeSurface) =>
    ISOLATION_PROFILES.map((profile) => ({
      agent_id: agent.id,
      transport: agent.transport,
      harness_id: agent.harness_id,
      vendor: agent.vendor,
      transport_class: agent.transport_class,
      runtime_surface: runtimeSurface,
      runtime_kind: "missing_runtime_declaration",
      surface_support: "unknown",
      isolation_profile: profile,
      isolation_status: "rejected",
      isolation_reason: "isolation_declaration_missing",
      isolation_missing: [`runtime_surface:${runtimeSurface}`, `isolation_profile:${profile}`],
      state_declaration_ref: agent.state_declaration_ref,
      global_mutation_required: agent.global_mutation_required === true,
      permission_surface: "unknown",
      observability_surface: "unknown",
      archived_at: ts,
    })),
  );
}

function removeInPlace<T>(items: T[], predicate: (item: T) => boolean): void {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) items.splice(index, 1);
  }
}
