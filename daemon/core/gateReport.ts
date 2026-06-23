import type { RuntimeSelectionMetadata } from "../../adapters/harness-declaration.js";
import type {
  ConsensusDegradedPayload,
  ConsensusOutcome,
  ConsensusPolicy,
  ConsensusReviewVerdict,
  ConsensusReviewerSelection,
  ConsensusReviewWire,
  ConsensusVerdictPayload,
} from "./consensus.js";
import type { ConnectionContext } from "./context.js";
import type { Clock } from "./clock.js";
import type { StoredEvent } from "./eventBus.js";
import type { DecisionRecord } from "./governance.js";
import type { ApprovalRecord, RunRecord, RunStatus } from "./stores.js";

export type ReviewOutcome = ConsensusReviewVerdict | "none";
export type GateDisposition =
  | "approved"
  | "waiting_approval"
  | "blocked"
  | "overridden"
  | "degraded"
  | "no_gate";

export interface GateReportV1 {
  readonly version: "GateReport.v1";
  readonly run_id: string;
  readonly generated_at: number;
  readonly target?: ConsensusVerdictPayload["target"];
  readonly policy?: ConsensusPolicy;
  readonly quorum?: ConsensusVerdictPayload["quorum"];
  readonly runtime: {
    readonly coder?: RuntimeSelectionMetadata;
    readonly reviewers: readonly ConsensusReviewerSelection[];
  };
  readonly decision_surface: {
    readonly review_outcome: ReviewOutcome;
    readonly gate_disposition: GateDisposition;
  };
  readonly consensus_snapshot?: ConsensusVerdictPayload | ConsensusDegradedPayload;
  readonly reviews: readonly ConsensusReviewWire[];
  readonly findings: readonly GateFindingSummary[];
  readonly pending_approval?: GateApprovalSummary;
  readonly override?: GateOverrideSummary;
  readonly blocking_reason?: string;
  readonly terminal?: {
    readonly state: RunStatus;
    readonly event: string;
    readonly reason?: string;
  };
  readonly audit_refs: readonly GateAuditRef[];
}

export interface GateFindingSummary {
  readonly agent: string;
  readonly carrier: "inline" | "artifact";
  readonly artifact_id?: string;
  readonly preview?: string;
  readonly truncated: boolean;
  readonly truncated_reason?: "content_limit";
}

export interface GateApprovalSummary {
  readonly approval_id: string;
  readonly kind: string;
  readonly reason: string;
}

export interface GateOverrideSummary {
  readonly approval_id: string;
  readonly decision: "approved" | "rejected";
  readonly by?: string;
  readonly reason?: string;
  readonly previous_gate_outcome?: string;
  readonly new_gate_outcome?: string;
  readonly artifact_refs?: readonly string[];
}

export interface GateAuditRef {
  readonly kind: "event" | "decision";
  readonly ref: string;
  readonly name: string;
}

export interface GateReportBuilderInput {
  readonly run: {
    readonly run_id: string;
    readonly status: RunStatus;
    readonly runtime?: RuntimeSelectionMetadata;
    readonly consensus?: {
      readonly panel: readonly ConsensusReviewerSelection[];
      readonly quorum: number;
      readonly policy: ConsensusPolicy;
      readonly producer_agent_id: string;
    };
  };
  readonly generated_at: number;
  readonly events: readonly StoredEvent[];
  readonly approvals: readonly ApprovalRecord[];
  readonly decisions: readonly DecisionRecord[];
}

const FINDING_PREVIEW_LIMIT = 240;

export function buildGateReport(input: GateReportBuilderInput): GateReportV1 {
  const consensusEvent = latestConsensusEvent(input.events);
  const consensus = consensusPayload(consensusEvent);
  const terminal = terminalEvent(input.run.status, input.events);
  const pendingApproval = latestPendingSemanticApproval(input.approvals);
  const override = latestSemanticOverride(input.events);
  const reviewOutcome = reviewOutcomeFrom(consensus);
  const gateDisposition = dispositionFrom({
    hasGate: input.run.consensus !== undefined || consensus !== undefined,
    runStatus: input.run.status,
    terminal,
    pendingApproval,
    override,
    consensus,
    reviewOutcome,
  });

  return {
    version: "GateReport.v1",
    run_id: input.run.run_id,
    generated_at: input.generated_at,
    ...(consensus?.target ? { target: consensus.target } : {}),
    ...(input.run.consensus ? { policy: input.run.consensus.policy } : {}),
    ...(consensus?.quorum ? { quorum: consensus.quorum } : {}),
    runtime: {
      ...(input.run.runtime ? { coder: input.run.runtime } : {}),
      reviewers: stableReviewers(input.run.consensus?.panel ?? []),
    },
    decision_surface: {
      review_outcome: reviewOutcome,
      gate_disposition: gateDisposition,
    },
    ...(consensus ? { consensus_snapshot: consensus } : {}),
    reviews: stableReviews(consensus?.reviews ?? []),
    findings: findingSummaries(consensus?.reviews ?? []),
    ...(pendingApproval ? { pending_approval: pendingApproval } : {}),
    ...(override ? { override } : {}),
    ...(blockingReason(terminal, consensus) ? { blocking_reason: blockingReason(terminal, consensus) } : {}),
    ...(terminal ? { terminal } : {}),
    audit_refs: auditRefs(input.events, input.decisions),
  };
}

export function emitGateReport(
  run: RunRecord,
  ctx: ConnectionContext,
  clock: Clock,
): void {
  if (ctx.initialized?.negotiated.gate_report.supported !== true) return;
  const report = buildGateReport({
    run,
    generated_at: clock.now(),
    events: run.bus.allEvents(),
    approvals: [...ctx.approvals.values()].filter((approval) => approval.run_id === run.run_id),
    decisions: ctx.governance.decisions.filter((decision) => decision.run_id === run.run_id),
  });
  run.bus.publish("gate", "gate_report", report);
}

function latestConsensusEvent(
  events: readonly StoredEvent[],
): StoredEvent | undefined {
  return [...events].reverse().find((event) =>
    event.category === "consensus" &&
    (event.name === "consensus_verdict" || event.name === "consensus_degraded")
  );
}

function consensusPayload(
  event: StoredEvent | undefined,
): ConsensusVerdictPayload | ConsensusDegradedPayload | undefined {
  if (!event || !isObject(event.payload)) return undefined;
  return event.payload as unknown as ConsensusVerdictPayload | ConsensusDegradedPayload;
}

function terminalEvent(
  status: RunStatus,
  events: readonly StoredEvent[],
): GateReportV1["terminal"] | undefined {
  const event = [...events].reverse().find((candidate) =>
    candidate.category === "run" &&
    (candidate.name === "run_merged" ||
      candidate.name === "run_blocked" ||
      candidate.name === "run_gave_up")
  );
  if (!event) return undefined;
  const payload = isObject(event.payload) ? event.payload : {};
  return {
    state: status,
    event: event.name,
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
  };
}

function latestPendingSemanticApproval(
  approvals: readonly ApprovalRecord[],
): GateApprovalSummary | undefined {
  const approval = [...approvals]
    .filter((candidate) => candidate.kind === "semantic_decision" && candidate.state === "pending")
    .sort((a, b) => a.approval_id.localeCompare(b.approval_id))
    .at(-1);
  if (!approval) return undefined;
  return {
    approval_id: approval.approval_id,
    kind: approval.kind,
    reason: approval.reason,
  };
}

function latestSemanticOverride(events: readonly StoredEvent[]): GateOverrideSummary | undefined {
  const event = [...events].reverse().find((candidate) => {
    if (candidate.category !== "approval" || candidate.name !== "approval_resolved") return false;
    const payload = isObject(candidate.payload) ? candidate.payload : {};
    return payload.kind === "semantic_decision" && payload.decision === "approved";
  });
  if (!event || !isObject(event.payload)) return undefined;
  const payload = event.payload;
  return {
    approval_id: String(payload.approval_id),
    decision: "approved",
    ...(typeof payload.by === "string" ? { by: payload.by } : {}),
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    ...(typeof payload.previous_gate_outcome === "string"
      ? { previous_gate_outcome: payload.previous_gate_outcome }
      : {}),
    ...(typeof payload.new_gate_outcome === "string"
      ? { new_gate_outcome: payload.new_gate_outcome }
      : {}),
    ...(Array.isArray(payload.artifact_refs)
      ? { artifact_refs: payload.artifact_refs.filter((item): item is string => typeof item === "string").sort() }
      : {}),
  };
}

function reviewOutcomeFrom(
  consensus: ConsensusVerdictPayload | ConsensusDegradedPayload | undefined,
): ReviewOutcome {
  if (!consensus) return "none";
  if ("reason" in consensus) return "none";
  return isReviewVerdict(consensus.outcome) ? consensus.outcome : "none";
}

function dispositionFrom(args: {
  readonly hasGate: boolean;
  readonly runStatus: RunStatus;
  readonly terminal?: GateReportV1["terminal"];
  readonly pendingApproval?: GateApprovalSummary;
  readonly override?: GateOverrideSummary;
  readonly consensus?: ConsensusVerdictPayload | ConsensusDegradedPayload;
  readonly reviewOutcome: ReviewOutcome;
}): GateDisposition {
  if (!args.hasGate) return "no_gate";
  if (args.pendingApproval) return "waiting_approval";
  if (args.override && args.runStatus !== "cancelled") return "overridden";
  if (args.runStatus === "blocked" || args.terminal?.event === "run_blocked") return "blocked";
  if (args.consensus && "reason" in args.consensus && args.reviewOutcome === "none") return "degraded";
  if (args.reviewOutcome === "approve" && args.runStatus !== "cancelled") return "approved";
  if (args.reviewOutcome === "request_changes" || args.reviewOutcome === "reject") return "blocked";
  return "degraded";
}

function stableReviewers(
  reviewers: readonly ConsensusReviewerSelection[],
): readonly ConsensusReviewerSelection[] {
  return [...reviewers].sort((a, b) => a.agent_id.localeCompare(b.agent_id));
}

function stableReviews(reviews: readonly ConsensusReviewWire[]): readonly ConsensusReviewWire[] {
  return [...reviews].sort((a, b) => a.agent.localeCompare(b.agent));
}

function findingSummaries(reviews: readonly ConsensusReviewWire[]): readonly GateFindingSummary[] {
  return stableReviews(reviews)
    .filter((review) => review.findings !== undefined)
    .map((review) => {
      const findings = review.findings!;
      if ("inline" in findings && findings.inline === true) {
        const truncated = findings.content.length > FINDING_PREVIEW_LIMIT || findings.truncated;
        return {
          agent: review.agent,
          carrier: "inline",
          preview: findings.content.slice(0, FINDING_PREVIEW_LIMIT),
          truncated,
          ...(truncated ? { truncated_reason: "content_limit" as const } : {}),
        };
      }
      if ("artifact_id" in findings) {
        return {
          agent: review.agent,
          carrier: "artifact",
          artifact_id: findings.artifact_id,
          truncated: false,
        };
      }
      return {
        agent: review.agent,
        carrier: "artifact",
        truncated: false,
      };
    });
}

function blockingReason(
  terminal: GateReportV1["terminal"] | undefined,
  consensus: ConsensusVerdictPayload | ConsensusDegradedPayload | undefined,
): string | undefined {
  if (terminal?.event === "run_blocked" && terminal.reason) return terminal.reason;
  if (consensus && "reason" in consensus) return consensus.reason;
  if (consensus?.outcome === "request_changes" || consensus?.outcome === "reject") {
    return `consensus_${consensus.outcome}`;
  }
  return undefined;
}

function auditRefs(
  events: readonly StoredEvent[],
  decisions: readonly DecisionRecord[],
): readonly GateAuditRef[] {
  const eventRefs = events
    .filter((event) =>
      event.category === "consensus" ||
      event.category === "approval" ||
      (event.category === "run" &&
        (event.name === "run_merged" ||
          event.name === "run_blocked" ||
          event.name === "run_gave_up"))
    )
    .map((event) => ({
      kind: "event" as const,
      ref: `seq:${event.seq}`,
      name: event.name,
    }));
  const decisionRefs = decisions
    .filter((decision) =>
      decision.decision_type === "consensus_verdict" ||
      decision.decision_type === "consensus_degraded" ||
      decision.decision_type === "approval_requested" ||
      decision.decision_type === "approval_resolved" ||
      decision.decision_type === "approval_expired" ||
      decision.decision_type === "approval_cancelled" ||
      decision.decision_type === "run_terminal"
    )
    .map((decision) => ({
      kind: "decision" as const,
      ref: decision.decision_id,
      name: decision.decision_type,
    }));
  return [...eventRefs, ...decisionRefs].sort((a, b) =>
    a.kind === b.kind ? a.ref.localeCompare(b.ref) : a.kind.localeCompare(b.kind)
  );
}

function isReviewVerdict(value: ConsensusOutcome | string): value is ConsensusReviewVerdict {
  return value === "approve" || value === "request_changes" || value === "reject";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
