import { createHash } from "node:crypto";
import type {
  AgentBackend,
  AgentBackendFactory,
  AgentMessageHandler,
  AgentBackendOptions,
  PermissionVerdict,
} from "../../adapters/agent-backend.js";
import type { RuntimeSelectionMetadata } from "../../adapters/harness-declaration.js";
import type { Clock } from "./clock.js";
import type { ConnectionContext } from "./context.js";
import {
  type ConsensusReviewerResult,
  type ConsensusReviewVerdict,
  type ConsensusSeverity,
} from "./consensus.js";
import { evidencePayload } from "./evidence.js";

const REVIEWER_VERDICTS = ["approve", "request_changes", "reject"] as const;
const REVIEWER_SEVERITIES = ["P0", "P1", "P2", "NONE"] as const;
const DEFAULT_REVIEWER_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_REVIEW_BUDGET_MS = 120_000;

export interface ReviewerExecutionAttestation {
  readonly enforced_read_only: boolean;
  readonly tool_policy: string;
  readonly deny_write_check: "passed" | "failed" | "not_run";
  readonly review_input_source: "artifact_snapshot" | "inline_diff" | "artifact_ref";
  readonly sandbox?: string;
  readonly details?: Record<string, unknown>;
}

export interface ParsedReviewerOutput {
  readonly verdict: ConsensusReviewVerdict;
  readonly max_severity: ConsensusSeverity;
  readonly findings: readonly unknown[];
}

export type ReviewerParseResult =
  | { readonly ok: true; readonly output: ParsedReviewerOutput }
  | { readonly ok: false; readonly reason: string };

export type ReviewerAgentExecutionConfig =
  | {
      readonly agent_id: string;
      readonly transport: string;
      readonly mode: "fake";
      readonly runtime?: RuntimeSelectionMetadata;
    }
  | {
      readonly agent_id: string;
      readonly transport: string;
      readonly mode: "backend";
      readonly runtime?: RuntimeSelectionMetadata;
      readonly backendFactory: AgentBackendFactory;
      readonly sandbox: "read-only";
      readonly backendOptions?: Pick<AgentBackendOptions, "env" | "modelId">;
    }
  | {
      readonly agent_id: string;
      readonly transport: string;
      readonly mode: "unsupported";
      readonly runtime?: RuntimeSelectionMetadata;
      readonly reason: string;
    };

export interface ReviewerExecutorArgs {
  readonly runId: string;
  readonly goal: string;
  readonly artifactId: string;
  readonly agents: readonly string[];
  readonly ctx: ConnectionContext;
  readonly clock: Clock;
}

export type ReviewerExecutor = (
  args: ReviewerExecutorArgs,
) => Promise<readonly ConsensusReviewerResult[]>;

export function parseReviewerJsonOutput(rawText: string): ReviewerParseResult {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty_reviewer_output" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "reviewer_output_not_strict_json" };
  }

  if (!isObject(parsed) || Array.isArray(parsed)) {
    return { ok: false, reason: "reviewer_output_not_json_object" };
  }

  const verdict = parsed.verdict;
  if (!isReviewerVerdict(verdict)) {
    return {
      ok: false,
      reason: verdict === undefined ? "missing_verdict" : "invalid_verdict",
    };
  }

  const maxSeverity = parsed.max_severity;
  if (!isReviewerSeverity(maxSeverity)) {
    return {
      ok: false,
      reason: maxSeverity === undefined ? "missing_max_severity" : "invalid_max_severity",
    };
  }

  if (!Array.isArray(parsed.findings)) {
    return {
      ok: false,
      reason: parsed.findings === undefined ? "missing_findings" : "invalid_findings",
    };
  }

  return {
    ok: true,
    output: {
      verdict,
      max_severity: maxSeverity,
      findings: parsed.findings,
    },
  };
}

export function reviewerResultFromRawOutput(args: {
  readonly agent: string;
  readonly rawText: string;
  readonly attestation?: ReviewerExecutionAttestation;
  readonly runId: string;
  readonly ctx: ConnectionContext;
  readonly clock: Clock;
  readonly generatedBy: string;
}): ConsensusReviewerResult {
  if (!attestationPasses(args.attestation)) {
    return {
      agent: args.agent,
      status: "error",
      reason: "read_only_attestation_failed",
    };
  }

  const parsed = parseReviewerJsonOutput(args.rawText);
  if (!parsed.ok) {
    return {
      agent: args.agent,
      status: "error",
      reason: parsed.reason,
    };
  }

  const content = JSON.stringify({
    agent: args.agent,
    verdict: parsed.output.verdict,
    max_severity: parsed.output.max_severity,
    findings: parsed.output.findings,
    generated_by: args.generatedBy,
  });

  return {
    agent: args.agent,
    status: "completed",
    verdict: parsed.output.verdict,
    max_severity: parsed.output.max_severity,
    findings: reviewerFindingsWire({
      agent: args.agent,
      runId: args.runId,
      ctx: args.ctx,
      clock: args.clock,
      content,
      createdBy: args.generatedBy,
    }),
  };
}

export function createReviewerExecutor(
  configs: readonly ReviewerAgentExecutionConfig[],
  options: {
    readonly reviewerTimeoutMs?: number;
    readonly totalBudgetMs?: number;
  } = {},
): ReviewerExecutor {
  const byAgent = new Map(configs.map((config) => [config.agent_id, config]));
  const reviewerTimeoutMs = options.reviewerTimeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS;
  const totalBudgetMs = options.totalBudgetMs ?? DEFAULT_TOTAL_REVIEW_BUDGET_MS;

  return async (args) => {
    const tasks = args.agents.map((agent) =>
      startReviewerTask({
        config: byAgent.get(agent) ?? {
          agent_id: agent,
          transport: "unknown",
          mode: "unsupported" as const,
          reason: "reviewer_execution_config_missing",
        },
        args,
        reviewerTimeoutMs,
      })
    );

    const settled = new Map<string, ConsensusReviewerResult>();
    const pending = new Map(tasks.map((task) => [task.agent, task]));
    const resultsPromise = Promise.all(
      tasks.map(async (task) => {
        const result = await task.promise;
        settled.set(task.agent, result);
        pending.delete(task.agent);
        return result;
      }),
    );

    let budgetTimer: NodeJS.Timeout | undefined;
    const budgetPromise = new Promise<readonly ConsensusReviewerResult[]>((resolve) => {
      budgetTimer = setTimeout(() => {
        for (const task of pending.values()) {
          void task.cancel();
          const result = {
            agent: task.agent,
            status: "timeout" as const,
            reason: "total_review_budget_exhausted",
          };
          settled.set(task.agent, result);
        }
        resolve([...settled.values()]);
      }, totalBudgetMs).unref?.();
    });

    const results = await Promise.race([resultsPromise, budgetPromise]);
    if (budgetTimer) clearTimeout(budgetTimer);
    for (const result of results) {
      args.ctx.governance.recordDecision({
        decision_type: "reviewer_execution",
        run_id: args.runId,
        agent_id: result.agent,
        reason: result.status === "completed" ? result.verdict : result.reason,
        ts: args.clock.now(),
        data: {
          status: result.status,
          verdict: result.verdict,
          max_severity: result.max_severity,
          reason: result.reason,
          runtime: byAgent.get(result.agent)?.runtime,
        },
      });
    }
    return results;
  };
}

function startReviewerTask(args: {
  readonly config: ReviewerAgentExecutionConfig;
  readonly args: ReviewerExecutorArgs;
  readonly reviewerTimeoutMs: number;
}): {
  readonly agent: string;
  readonly promise: Promise<ConsensusReviewerResult>;
  readonly cancel: () => Promise<void>;
} {
  const { config } = args;
  if (config.mode === "fake") {
    return {
      agent: config.agent_id,
      promise: Promise.resolve(fakeReviewerResult(config.agent_id, args.args)),
      async cancel() {},
    };
  }

  if (config.mode === "unsupported") {
    return {
      agent: config.agent_id,
      promise: Promise.resolve({
        agent: config.agent_id,
        status: "error",
        reason: config.reason,
      }),
      async cancel() {},
    };
  }

  return startBackendReviewerTask(config, args.args, args.reviewerTimeoutMs);
}

function startBackendReviewerTask(
  config: Extract<ReviewerAgentExecutionConfig, { mode: "backend" }>,
  args: ReviewerExecutorArgs,
  reviewerTimeoutMs: number,
): {
  readonly agent: string;
  readonly promise: Promise<ConsensusReviewerResult>;
  readonly cancel: () => Promise<void>;
} {
  const backend = config.backendFactory({
    cwd: process.cwd(),
    env: config.backendOptions?.env,
    modelId: config.backendOptions?.modelId,
    permissionHandler: denyAllReviewerPermissionRequests,
  });
  let sessionId: string | undefined;
  let rawText = "";
  const handler: AgentMessageHandler = (msg) => {
    if (msg.type !== "model-output") return;
    if (typeof msg.fullText === "string") rawText = msg.fullText;
    else if (typeof msg.textDelta === "string") rawText += msg.textDelta;
  };
  backend.onMessage(handler);

  const runPromise = (async (): Promise<ConsensusReviewerResult> => {
    const artifact = args.ctx.artifacts.get(args.artifactId);
    if (!artifact) {
      return { agent: config.agent_id, status: "error", reason: "review_artifact_missing" };
    }

    try {
      const session = await backend.startSession();
      sessionId = session.sessionId;
      await backend.sendPrompt(sessionId, buildReviewerPrompt({
        agent: config.agent_id,
        goal: args.goal,
        artifactId: args.artifactId,
        artifactContent: artifact.content,
      }));
      return reviewerResultFromRawOutput({
        agent: config.agent_id,
        rawText,
        attestation: backendReadOnlyAttestation(config),
        runId: args.runId,
        ctx: args.ctx,
        clock: args.clock,
        generatedBy: "holp-real-reviewer-pilot",
      });
    } catch (err) {
      return {
        agent: config.agent_id,
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      backend.offMessage?.(handler);
      await backend.dispose().catch(() => {});
    }
  })();

  return {
    agent: config.agent_id,
    promise: withTimeout(runPromise, reviewerTimeoutMs, {
      agent: config.agent_id,
      status: "timeout",
      reason: "reviewer_timeout",
    }, backend, () => sessionId),
    async cancel() {
      await cancelBackend(backend, sessionId);
    },
  };
}

function backendReadOnlyAttestation(
  config: Extract<ReviewerAgentExecutionConfig, { mode: "backend" }>,
): ReviewerExecutionAttestation {
  const missing = config.runtime?.isolation_missing ?? [];
  const enforced = config.runtime?.isolation_status === "ready" &&
    config.runtime.declared_not_enforced !== true &&
    !missing.includes("read_only_enforcement");
  return {
    enforced_read_only: enforced,
    sandbox: config.sandbox,
    tool_policy: "deny_all_permission_requests",
    deny_write_check: enforced ? "passed" : "not_run",
    review_input_source: "artifact_snapshot",
    details: {
      runtime_surface: config.runtime?.runtime_surface,
      isolation_profile: config.runtime?.isolation_profile,
      isolation_status: config.runtime?.isolation_status,
      isolation_reason: config.runtime?.isolation_reason,
      isolation_missing: config.runtime?.isolation_missing,
      declared_not_enforced: config.runtime?.declared_not_enforced,
    },
  };
}

function fakeReviewerResult(
  agent: string,
  args: ReviewerExecutorArgs,
): ConsensusReviewerResult {
  return reviewerResultFromRawOutput({
    agent,
    rawText: JSON.stringify({
      verdict: "approve",
      max_severity: "NONE",
      findings: [],
    }),
    attestation: {
      enforced_read_only: true,
      tool_policy: "fake_read_only_review_fixture",
      deny_write_check: "passed",
      review_input_source: "artifact_snapshot",
      details: { fake: true },
    },
    runId: args.runId,
    ctx: args.ctx,
    clock: args.clock,
    generatedBy: "holp-fake-consensus-kernel",
  });
}

function buildReviewerPrompt(args: {
  readonly agent: string;
  readonly goal: string;
  readonly artifactId: string;
  readonly artifactContent: string;
}): string {
  return [
    "You are a HOLP read-only reviewer. Review only the artifact snapshot below.",
    "Do not edit files, run write commands, or rely on any workspace state outside the artifact snapshot.",
    "Return exactly one JSON object and no prose before or after it.",
    'Schema: {"verdict":"approve|request_changes|reject","max_severity":"P0|P1|P2|NONE","findings":[]}.',
    "Use max_severity NONE only when there are no P0/P1/P2 findings.",
    "",
    `Reviewer agent: ${args.agent}`,
    `Goal: ${args.goal}`,
    `Artifact: ${args.artifactId}`,
    "Artifact snapshot:",
    "```diff",
    args.artifactContent,
    "```",
  ].join("\n");
}

async function withTimeout(
  promise: Promise<ConsensusReviewerResult>,
  timeoutMs: number,
  timeoutResult: ConsensusReviewerResult,
  backend: AgentBackend,
  sessionId: () => string | undefined,
): Promise<ConsensusReviewerResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ConsensusReviewerResult>((resolve) => {
    timer = setTimeout(() => {
      void cancelBackend(backend, sessionId());
      resolve(timeoutResult);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cancelBackend(backend: AgentBackend, sessionId: string | undefined): Promise<void> {
  if (sessionId) await backend.cancel(sessionId).catch(() => {});
  await backend.dispose().catch(() => {});
}

async function denyAllReviewerPermissionRequests(
  toolName: string,
  _input: unknown,
): Promise<PermissionVerdict> {
  return {
    decision: "deny",
    reason: `read_only_reviewer_denied_permission:${toolName}`,
  };
}

function reviewerFindingsWire(args: {
  readonly agent: string;
  readonly runId: string;
  readonly ctx: ConnectionContext;
  readonly clock: Clock;
  readonly content: string;
  readonly createdBy: string;
}): ConsensusReviewerResult["findings"] {
  if (args.ctx.initialized?.negotiated.artifact_refs.supported !== true) {
    return {
      inline: true,
      type: "findings",
      mime: "application/json",
      content: args.content,
      truncated: false,
    };
  }

  const artifactId = `art_findings_${args.runId}_${safeArtifactPart(args.agent)}_${shortHash(args.agent)}`;
  return evidencePayload({
    ctx: args.ctx,
    clock: args.clock,
    artifactId,
    type: "findings",
    content: args.content,
    createdBy: args.createdBy,
  }) as ConsensusReviewerResult["findings"];
}

function attestationPasses(attestation: ReviewerExecutionAttestation | undefined): boolean {
  return attestation?.enforced_read_only === true &&
    attestation.deny_write_check === "passed" &&
    attestation.review_input_source === "artifact_snapshot" &&
    attestation.tool_policy.trim().length > 0;
}

function isReviewerVerdict(value: unknown): value is ConsensusReviewVerdict {
  return typeof value === "string" && (REVIEWER_VERDICTS as readonly string[]).includes(value);
}

function isReviewerSeverity(value: unknown): value is ConsensusSeverity {
  return typeof value === "string" && (REVIEWER_SEVERITIES as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeArtifactPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
