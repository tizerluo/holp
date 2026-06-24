import type { HarnessOverviewModel, RoleSkinId } from "../harness-workspace/index.js";

export type CmuxLayoutCommandName =
  | "new-pane"
  | "new-surface"
  | "new-split"
  | "markdown open"
  | "set-status"
  | "set-progress"
  | "log"
  | "notify";

export type CmuxDegradedReason =
  | "missing_workspace"
  | "execution_not_enabled"
  | "invalid_command"
  | "cmux_command_failed"
  | "missing_controller_binary"
  | "missing_controller_auth"
  | "missing_direct_worker_readiness"
  | "missing_live_run_attach"
  | "controller_manual_start_required"
  | "unsupported_controller"
  | "unsupported_controller_command"
  | "controller_pane_failed";

export interface CmuxCallerContext {
  readonly workspaceId?: string;
  readonly surfaceId?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type CmuxLayoutTargetKind = "mission-control" | "role" | "evidence" | "controller" | "sidecar" | "replay";

export interface CmuxLayoutTarget {
  readonly kind: CmuxLayoutTargetKind;
  readonly role?: Exclude<RoleSkinId, "CTRL" | "GATE">;
  readonly agentId?: string;
  readonly title: string;
}

export interface CmuxLayoutCommand {
  readonly name: CmuxLayoutCommandName;
  readonly args: readonly string[];
  readonly target: CmuxLayoutTarget;
  readonly contentCommand?: string;
}

export interface CmuxLayoutView {
  readonly path: string;
  readonly target: CmuxLayoutTarget;
  readonly markdown: string;
}

export interface CmuxLayoutPlan {
  readonly workspaceId?: string;
  readonly callerSurfaceId?: string;
  readonly executable: boolean;
  readonly degradedReasons: readonly CmuxDegradedReason[];
  readonly commands: readonly CmuxLayoutCommand[];
  readonly views: readonly CmuxLayoutView[];
  readonly summary: string;
}

export interface CmuxCommandResult {
  readonly command: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface CmuxExecutionResult {
  readonly mode: "dry-run" | "executed" | "degraded";
  readonly plan: CmuxLayoutPlan;
  readonly executed: readonly CmuxCommandResult[];
  readonly skipped: readonly CmuxLayoutCommand[];
  readonly degradedReasons: readonly CmuxDegradedReason[];
}

export type CmuxLayoutModel = HarnessOverviewModel;
