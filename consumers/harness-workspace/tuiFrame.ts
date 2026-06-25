import { deriveOperatorAffordances } from "./affordances.js";
import { deriveContinuity } from "./continuity.js";
import { deriveTimeline } from "./logs.js";
import { deriveInspect, deriveOverview } from "./renderModel.js";
import { roleSkinFor } from "./roleSkins.js";
import type {
  DiscoveredAgent,
  HarnessInspectModel,
  HarnessOperatorAffordance,
  HarnessOverviewModel,
  HarnessSessionContinuity,
  HarnessTimelineModel,
  HarnessWorkspaceState,
  RoleSkinId,
  RenderEvidenceSummary,
  WorkerPreview,
} from "./types.js";

export type WorkspaceTuiMode = "overview" | "inspect" | "replay" | "help";
export type WorkspaceTuiLocale = HarnessWorkspaceState["locale"];
export type WorkspaceTuiAgent = DiscoveredAgent & { readonly role_skin?: RoleSkinId };

export interface WorkspaceTuiFrameV1 {
  readonly schema_version: "WorkspaceTuiFrame.v1";
  readonly locale?: WorkspaceTuiLocale;
  readonly mode: WorkspaceTuiMode;
  readonly selected_agent?: string;
  readonly agents: readonly WorkspaceTuiAgent[];
  readonly run_id?: string;
  readonly worker_session?: string;
  readonly attach_command?: string;
  readonly timeline: HarnessTimelineModel;
  readonly gate?: RenderEvidenceSummary["gate"];
  readonly approval?: RenderEvidenceSummary["approval"];
  readonly terminal?: RenderEvidenceSummary["terminal"];
  readonly failures: readonly string[];
  readonly affordances: readonly HarnessOperatorAffordance[];
  readonly degraded_reasons: readonly string[];
  readonly replay_path?: string;
  readonly replay_written_at?: string;
  readonly overview: {
    readonly title: string;
    readonly chain: HarnessOverviewModel["chain"];
    readonly worker_preview: WorkerPreview;
    readonly evidence: RenderEvidenceSummary;
  };
  readonly inspect?: Pick<HarnessInspectModel, "selectedAgentId" | "selectedAgent" | "inspect" | "empty">;
  readonly continuity: HarnessSessionContinuity;
}

export interface WorkspaceTuiFrameOptions {
  readonly mode?: WorkspaceTuiMode;
  readonly selectedAgentId?: string;
  readonly replayPath?: string;
  readonly replayWrittenAt?: string;
}

export function createWorkspaceTuiFrame(
  state: HarnessWorkspaceState,
  options: WorkspaceTuiFrameOptions = {},
): WorkspaceTuiFrameV1 {
  const selectedAgentId = options.selectedAgentId ?? state.run.selected_agent_id ?? Object.keys(state.agents).sort()[0];
  const overview = deriveOverview(state);
  const inspect = deriveInspect(state, selectedAgentId);
  const timeline = deriveTimeline(state.events);
  const continuity = deriveContinuity(state, { replayCreatedAt: options.replayWrittenAt });
  const affordances = deriveOperatorAffordances(state, continuity);
  const evidence = overview.evidence;

  return {
    schema_version: "WorkspaceTuiFrame.v1",
    mode: options.mode ?? "overview",
    selected_agent: selectedAgentId,
    locale: state.locale,
    agents: Object.values(state.agents)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((agent) => ({
        ...agent,
        role_skin: roleSkinFor(agent.role ?? agent.id),
      })),
    run_id: evidence.run_id,
    worker_session: evidence.worker_session,
    attach_command: evidence.attach_command,
    timeline,
    gate: evidence.gate,
    approval: evidence.approval,
    terminal: evidence.terminal,
    failures: overview.failures,
    affordances,
    degraded_reasons: continuity.reasons,
    replay_path: options.replayPath,
    replay_written_at: options.replayWrittenAt,
    overview: {
      title: overview.title,
      chain: overview.chain,
      worker_preview: overview.workerPreview,
      evidence,
    },
    inspect: {
      selectedAgentId: inspect.selectedAgentId,
      selectedAgent: inspect.selectedAgent,
      inspect: inspect.inspect,
      empty: inspect.empty,
    },
    continuity,
  };
}

export function isWorkspaceTuiFrameV1(value: unknown): value is WorkspaceTuiFrameV1 {
  return (
    typeof value === "object"
    && value !== null
    && (value as { schema_version?: unknown }).schema_version === "WorkspaceTuiFrame.v1"
  );
}
