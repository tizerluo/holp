import type { RuntimeSelectionMetadata } from "../../adapters/harness-declaration.js";
import type { ArtifactEnvelope } from "./stores.js";

export type ConsensusReviewStatus = "completed" | "timeout" | "error" | "abstain";
export type ConsensusReviewVerdict = "approve" | "request_changes" | "reject";
export type ConsensusOutcome = ConsensusReviewVerdict | "ask_human";
export type ConsensusDegradedOutcome = ConsensusOutcome | "degrade_quorum";
export type ConsensusSeverity = "P0" | "P1" | "P2" | "NONE";
export type AuthorProvenance = "produced_by_agent_id" | "commit_author" | "run_initiator";
export type OnQuorumUnsatisfiable = "ask_human" | "reject" | "degrade_quorum";

export interface ConsensusPolicy {
  readonly exclude_author: boolean;
  readonly author_provenance: AuthorProvenance;
  readonly on_quorum_unsatisfiable: OnQuorumUnsatisfiable;
}

export interface ConsensusReviewerSelection {
  readonly agent_id: string;
  readonly runtime?: RuntimeSelectionMetadata;
}

export interface ConsensusRunConfig {
  readonly panel: readonly ConsensusReviewerSelection[];
  readonly quorum: number;
  readonly policy: ConsensusPolicy;
  readonly producer_agent_id: string;
}

export interface ConsensusTarget {
  readonly artifact_id: string;
  readonly produced_by_agent_id: string;
}

export interface ConsensusFindingInline {
  readonly inline: true;
  readonly type: "findings";
  readonly mime: "application/json";
  readonly content: string;
  readonly truncated: boolean;
}

export type ConsensusFindingWire = ConsensusFindingInline | ArtifactEnvelope;

export interface ConsensusReviewerResult {
  readonly agent: string;
  readonly status: ConsensusReviewStatus;
  readonly verdict?: ConsensusReviewVerdict;
  readonly max_severity?: ConsensusSeverity;
  readonly findings?: ConsensusFindingWire;
  readonly reason?: string;
}

export interface ConsensusReviewWire {
  readonly agent: string;
  readonly eligible: boolean;
  readonly status: ConsensusReviewStatus;
  readonly verdict?: ConsensusReviewVerdict;
  readonly max_severity?: ConsensusSeverity;
  readonly findings?: ConsensusFindingWire;
}

export interface ConsensusErrorWire {
  readonly agent: string;
  readonly status: Exclude<ConsensusReviewStatus, "completed">;
  readonly reason?: string;
}

export interface ConsensusExcludedWire {
  readonly agent: string;
  readonly reason: string;
}

export interface ConsensusQuorumWire {
  readonly required: number;
  readonly eligible: number;
  readonly met: boolean;
}

export interface ConsensusVerdictPayload {
  readonly target: ConsensusTarget;
  readonly outcome: ConsensusOutcome;
  readonly max_severity: ConsensusSeverity;
  readonly quorum: ConsensusQuorumWire;
  readonly rule: "majority-non-author";
  readonly reviews: readonly ConsensusReviewWire[];
  readonly excluded: readonly ConsensusExcludedWire[];
  readonly errors: readonly ConsensusErrorWire[];
}

export interface ConsensusDegradedPayload extends Omit<ConsensusVerdictPayload, "outcome"> {
  readonly outcome: ConsensusDegradedOutcome;
  readonly reason: string;
  readonly policy_action?: OnQuorumUnsatisfiable;
}

const SEVERITY_RANK: Record<ConsensusSeverity, number> = {
  NONE: 0,
  P2: 1,
  P1: 2,
  P0: 3,
};

const OUTCOME_RANK: Record<ConsensusReviewVerdict, number> = {
  approve: 0,
  request_changes: 1,
  reject: 2,
};

export function aggregateMaxSeverity(
  results: readonly ConsensusReviewerResult[],
): ConsensusSeverity {
  return results.reduce<ConsensusSeverity>((max, result) => {
    if (!isCompleteVote(result)) return max;
    const severity = result.max_severity;
    return SEVERITY_RANK[severity] > SEVERITY_RANK[max] ? severity : max;
  }, "NONE");
}

export function aggregateOutcome(
  results: readonly ConsensusReviewerResult[],
): ConsensusReviewVerdict {
  return results.reduce<ConsensusReviewVerdict>((max, result) => {
    if (!isCompleteVote(result)) return max;
    const verdict = result.verdict;
    return OUTCOME_RANK[verdict] > OUTCOME_RANK[max] ? verdict : max;
  }, "approve");
}

export function buildConsensusVerdict(args: {
  readonly target: ConsensusTarget;
  readonly panel: readonly string[];
  readonly quorum: number;
  readonly producedByAgentId: string;
  readonly excludeAuthor: boolean;
  readonly results: readonly ConsensusReviewerResult[];
}): ConsensusVerdictPayload {
  const excluded = args.excludeAuthor
    ? args.panel
        .filter((agent) => agent === args.producedByAgentId)
        .map((agent) => ({
          agent,
          reason: "produced_by_agent_id (author)",
        }))
    : [];
  const excludedAgents = new Set(excluded.map((entry) => entry.agent));
  const eligibleAgents = args.panel.filter((agent) => !excludedAgents.has(agent));
  const eligibleSet = new Set(eligibleAgents);
  const resultByAgent = new Map(args.results.map((result) => [result.agent, result]));

  const reviews: ConsensusReviewWire[] = [];
  const errors: ConsensusErrorWire[] = [];
  for (const agent of eligibleAgents) {
    const result = resultByAgent.get(agent) ?? {
      agent,
      status: "abstain" as const,
      reason: "missing_review_result",
    };
    if (isCompleteVote(result)) {
      reviews.push({
        agent,
        eligible: true,
        status: "completed",
        verdict: result.verdict,
        max_severity: result.max_severity,
        ...(result.findings ? { findings: result.findings } : {}),
      });
    } else {
      errors.push({
        agent,
        status: result.status === "completed" ? "error" : result.status,
        reason: incompleteReason(result),
      });
    }
  }

  const completedEligibleResults = args.results.filter(
    (result) => eligibleSet.has(result.agent) && isCompleteVote(result),
  );
  const met = eligibleAgents.length >= args.quorum &&
    completedEligibleResults.length >= args.quorum;

  return {
    target: args.target,
    outcome: aggregateOutcome(completedEligibleResults),
    max_severity: aggregateMaxSeverity(completedEligibleResults),
    quorum: {
      required: args.quorum,
      eligible: eligibleAgents.length,
      met,
    },
    rule: "majority-non-author",
    reviews,
    excluded,
    errors,
  };
}

function isCompleteVote(
  result: ConsensusReviewerResult,
): result is ConsensusReviewerResult & {
  readonly status: "completed";
  readonly verdict: ConsensusReviewVerdict;
  readonly max_severity: ConsensusSeverity;
} {
  return result.status === "completed" &&
    result.verdict !== undefined &&
    result.max_severity !== undefined;
}

function incompleteReason(result: ConsensusReviewerResult): string | undefined {
  if (result.status !== "completed") return result.reason;
  const missing = [
    result.verdict === undefined ? "verdict" : undefined,
    result.max_severity === undefined ? "max_severity" : undefined,
  ].filter((value): value is string => value !== undefined);
  return missing.length > 0
    ? `completed_review_missing_${missing.join("_and_")}`
    : result.reason;
}

export function inlineFindings(agent: string, verdict: ConsensusReviewVerdict): ConsensusFindingInline {
  return {
    inline: true,
    type: "findings",
    mime: "application/json",
    content: JSON.stringify({
      agent,
      verdict,
      findings: [],
      generated_by: "holp-fake-consensus-kernel",
    }),
    truncated: false,
  };
}
