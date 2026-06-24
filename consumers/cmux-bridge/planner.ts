import path from "node:path";
import type { ChainNode } from "../harness-workspace/index.js";
import type {
  CmuxCallerContext,
  CmuxDegradedReason,
  CmuxLayoutCommand,
  CmuxLayoutModel,
  CmuxLayoutPlan,
  CmuxLayoutTarget,
  CmuxLayoutView,
} from "./types.js";
import { assertValidCmuxLayoutCommand, cmuxWorkspaceFromEnv, isRealCmuxWorkspaceValue } from "./commands.js";

export interface CmuxLayoutPlannerOptions {
  readonly caller: CmuxCallerContext;
  readonly model: CmuxLayoutModel;
  readonly viewDir?: string;
}

const ROLE_SKINS = new Set(["CODE", "TEST", "REV", "ARCH"]);

export function planCmuxTeamLayout(options: CmuxLayoutPlannerOptions): CmuxLayoutPlan {
  const explicitWorkspaceId = options.caller.workspaceId;
  const workspaceId = explicitWorkspaceId !== undefined
    ? isRealCmuxWorkspaceValue(explicitWorkspaceId) ? explicitWorkspaceId : undefined
    : cmuxWorkspaceFromEnv(options.caller.env ?? {});
  const callerSurfaceId = options.caller.surfaceId ?? options.caller.env?.CMUX_SURFACE_ID;
  const degradedReasons: CmuxDegradedReason[] = [];
  if (!workspaceId) degradedReasons.push("missing_workspace");

  if (!workspaceId) {
    return {
      workspaceId,
      callerSurfaceId,
      executable: false,
      degradedReasons,
      commands: [],
      views: [],
      summary: "cmux Team Layout degraded: missing workspace; dry-run only",
    };
  }

  const viewDir = options.viewDir ?? defaultViewDir(options.model, workspaceId);
  const commands: CmuxLayoutCommand[] = [];
  const views: CmuxLayoutView[] = [];

  const missionTarget: CmuxLayoutTarget = { kind: "mission-control", title: "HOLP Mission Control" };
  addMarkdownView(commands, views, {
    workspaceId,
    viewDir,
    target: missionTarget,
    fileName: "mission-control.md",
    markdown: missionControlMarkdown(options.model, callerSurfaceId),
    direction: "right",
  });

  for (const node of roleNodes(options.model.chain)) {
    const target: CmuxLayoutTarget = {
      kind: "role",
      role: node.skin,
      agentId: node.agentId,
      title: `HOLP ${node.skin} ${node.agentId}`,
    };
    const contentCommand = `npm run harness:workspace -- --mode inspect --agent ${node.agentId} --no-ansi --width 100 --height 28`;
    addMarkdownView(commands, views, {
      workspaceId,
      viewDir,
      target,
      fileName: `role-${node.skin.toLowerCase()}-${sanitizePathPart(node.agentId)}.md`,
      markdown: roleMarkdown(options.model, node, contentCommand),
      direction: "right",
      contentCommand,
    });
  }

  if (hasEvidencePaneContent(options.model)) {
    const target: CmuxLayoutTarget = { kind: "evidence", title: "HOLP Evidence" };
    addMarkdownView(commands, views, {
      workspaceId,
      viewDir,
      target,
      fileName: "evidence.md",
      markdown: evidenceMarkdown(options.model),
      direction: "down",
    });
  }

  commands.push({
    name: "set-status",
    args: ["holp-team-layout", "planned", "--workspace", workspaceId, "--color", "#34c759"],
    target: missionTarget,
  });
  commands.push({
    name: "set-progress",
    args: ["1.0", "--label", "HOLP Team Layout planned", "--workspace", workspaceId],
    target: missionTarget,
  });
  const finalCommandCount = commands.length + 1;
  commands.push({
    name: "log",
    args: ["--workspace", workspaceId, "--level", "info", "--", `HOLP Team Layout planned commands=${finalCommandCount}`],
    target: missionTarget,
  });

  for (const command of commands) assertValidCmuxLayoutCommand(command);

  return {
    workspaceId,
    callerSurfaceId,
    executable: true,
    degradedReasons,
    commands,
    views,
    summary: `cmux Team Layout plan: ${roleNodes(options.model.chain).length} role views, evidence=${hasEvidencePaneContent(options.model) ? "yes" : "no"}`,
  };
}

function addMarkdownView(
  commands: CmuxLayoutCommand[],
  views: CmuxLayoutView[],
  options: {
    readonly workspaceId: string;
    readonly viewDir: string;
    readonly target: CmuxLayoutTarget;
    readonly fileName: string;
    readonly markdown: string;
    readonly direction: "right" | "down";
    readonly contentCommand?: string;
  },
): void {
  const viewPath = path.join(options.viewDir, options.fileName);
  views.push({ path: viewPath, target: options.target, markdown: options.markdown });
  commands.push({
    name: "markdown open",
    args: [viewPath, "--workspace", options.workspaceId, "--direction", options.direction, "--focus", "false"],
    target: options.target,
    contentCommand: options.contentCommand,
  });
}

function roleNodes(chain: readonly ChainNode[]): readonly (ChainNode & { agentId: string; skin: "CODE" | "TEST" | "REV" | "ARCH" })[] {
  return chain.filter((node): node is ChainNode & { agentId: string; skin: "CODE" | "TEST" | "REV" | "ARCH" } => {
    return Boolean(node.agentId) && ROLE_SKINS.has(node.skin);
  });
}

function hasEvidencePaneContent(model: CmuxLayoutModel): boolean {
  return Boolean(
    model.evidence.gate
      || model.evidence.approval
      || model.evidence.terminal
      || model.evidence.artifact_refs.length > 0
      || model.rawEvidenceAnchors.length > 0
      || model.failures.length > 0,
  );
}

function missionControlMarkdown(model: CmuxLayoutModel, callerSurfaceId: string | undefined): string {
  const lines = [
    "# HOLP Mission Control",
    "",
    "- View: public-wire consumer summary",
    "- Controller: existing caller surface, not recreated",
    `- Caller surface: ${callerSurfaceId ?? "unknown"}`,
    `- Run ID: ${model.evidence.run_id ?? "unknown"}`,
    `- Runtime surface: ${model.evidence.runtime_surface ?? "unknown"}`,
    "- cmux status: cmux-pending-user-validation",
    "",
    "## Chain",
    "",
  ];
  for (const node of model.chain) {
    lines.push(`- ${node.skin} ${node.label}: ${node.state}${node.agentId ? ` agent_id=${node.agentId}` : ""}`);
  }
  lines.push("");
  lines.push(model.evidence.provenance_caveat);
  lines.push("");
  return lines.join("\n");
}

function roleMarkdown(model: CmuxLayoutModel, node: ChainNode & { agentId: string }, contentCommand: string): string {
  const lines = [
    `# HOLP ${node.skin} Consumer View`,
    "",
    "- Pane type: HOLP public-wire consumer view",
    "- Native CLI claim: none",
    `- Agent ID: ${node.agentId}`,
    `- Role skin: ${node.skin}`,
    `- Chain state: ${node.state}`,
    `- Run ID: ${model.evidence.run_id ?? "unknown"}`,
    `- Consumer command: \`${contentCommand}\``,
    "",
    "This view is intentionally not a native tmux session or cmux-owned provider agent.",
    "",
  ];
  return lines.join("\n");
}

function evidenceMarkdown(model: CmuxLayoutModel): string {
  const lines = [
    "# HOLP Evidence",
    "",
    "- View: bounded public-wire evidence",
    `- Run ID: ${model.evidence.run_id ?? "unknown"}`,
  ];
  if (model.evidence.gate) {
    lines.push(`- Gate: ${[
      model.evidence.gate.gate_disposition,
      model.evidence.gate.review_outcome,
      model.evidence.gate.blocking_reason ? `blocking_reason=${model.evidence.gate.blocking_reason}` : undefined,
    ].filter(Boolean).join(" ")}`);
  }
  if (model.evidence.approval) {
    lines.push(`- Approval: ${model.evidence.approval.state}${model.evidence.approval.approval_id ? ` approval_id=${model.evidence.approval.approval_id}` : ""}`);
  }
  if (model.evidence.terminal) {
    lines.push(`- Terminal: ${model.evidence.terminal.state}${model.evidence.terminal.reason ? ` reason=${model.evidence.terminal.reason}` : ""}`);
  }
  for (const failure of model.failures) lines.push(`- Failure: ${failure}`);
  for (const ref of model.rawEvidenceAnchors) {
    lines.push(`- Evidence ref: ${ref.category}.${ref.name}#${ref.seq} run_id=${ref.run_id}`);
  }
  lines.push("");
  lines.push(model.evidence.provenance_caveat);
  lines.push("");
  return lines.join("\n");
}

function defaultViewDir(model: CmuxLayoutModel, workspaceId: string): string {
  const runPart = sanitizePathPart(model.evidence.run_id ?? workspaceId);
  return path.join("/tmp", "holp-cmux-team-layout", runPart);
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "unknown";
}
