import { hasCapability } from "./continuity.js";
import { t, type MessageKey } from "./messages.js";
import type {
  HarnessAffordanceState,
  HarnessOperatorAffordance,
  HarnessOperatorAffordanceId,
  HarnessSessionContinuity,
  HarnessWorkspaceLocale,
  HarnessWorkspaceState,
} from "./types.js";

export function deriveOperatorAffordances(
  state: HarnessWorkspaceState,
  continuity: HarnessSessionContinuity,
): readonly HarnessOperatorAffordance[] {
  const selected = state.run.selected_agent_id;
  const surfaces = selected ? state.agents[selected]?.runtime_surfaces : undefined;
  const canCancel = hasCapability(surfaces, "cancel");
  const canInterrupt = hasCapability(surfaces, "interrupt");
  const canCopyAttach = Boolean(state.workerAnchor?.attach_command) && !state.terminal;
  return [
    affordance(state.locale, "copy_attach_command", {
      state: canCopyAttach ? "enabled" : "disabled",
      reason_key: canCopyAttach
        ? "affordanceReasonCopySource"
        : state.terminal ? "affordanceReasonAttachEnded" : "affordanceReasonAttachMissing",
      command_text: canCopyAttach ? state.workerAnchor?.attach_command : undefined,
    }),
    affordance(state.locale, "copy_run_id", {
      state: state.run.run_id ? "enabled" : "disabled",
      reason_key: state.run.run_id ? "affordanceReasonCopySource" : "affordanceReasonRunMissing",
      command_text: state.run.run_id,
    }),
    affordance(state.locale, "open_team_layout", {
      state: state.run.run_id ? "needs_confirmation" : "unsupported",
      reason_key: state.run.run_id ? "affordanceReasonTeamLayoutDescriptor" : "affordanceReasonRunMissing",
      confirmation_required: true,
    }),
    affordance(state.locale, "replay_evidence", {
      state: state.rawEvidenceAnchors.length > 0 ? "enabled" : "disabled",
      reason_key: state.rawEvidenceAnchors.length > 0 ? "affordanceReasonEvidenceAvailable" : "affordanceReasonEvidenceMissing",
    }),
    affordance(state.locale, "rerun_goal", {
      state: continuity.can_rerun ? "needs_confirmation" : "disabled",
      reason_key: continuity.can_rerun ? "affordanceReasonRerunNeedsConfirmation" : "affordanceReasonRerunDeferred",
      confirmation_required: true,
      destructive: true,
      focus_changing: true,
    }),
    affordance(state.locale, "continue_run", {
      state: continuity.can_continue ? "needs_confirmation" : "disabled",
      reason_key: continuity.can_continue ? "affordanceReasonContinueNeedsConfirmation" : "affordanceReasonContinueUnavailable",
      confirmation_required: true,
      focus_changing: true,
    }),
    affordance(state.locale, "cancel_run", {
      state: canCancel ? "needs_confirmation" : "disabled",
      reason_key: canCancel ? "affordanceReasonCancelNeedsConfirmation" : "affordanceReasonCancelUnavailable",
      confirmation_required: true,
      destructive: true,
    }),
    affordance(state.locale, "interrupt_worker", {
      state: canInterrupt ? "needs_confirmation" : "disabled",
      reason_key: canInterrupt ? "affordanceReasonInterruptNeedsConfirmation" : "affordanceReasonInterruptUnavailable",
      confirmation_required: true,
      destructive: true,
      focus_changing: true,
    }),
  ];
}

function affordance(
  locale: HarnessWorkspaceLocale,
  id: HarnessOperatorAffordanceId,
  options: {
    readonly state: HarnessAffordanceState;
    readonly reason_key: string;
    readonly reason?: string;
    readonly confirmation_required?: boolean;
    readonly destructive?: boolean;
    readonly focus_changing?: boolean;
    readonly command_text?: string;
  },
): HarnessOperatorAffordance {
  const label_key = labelKey(id);
  return {
    id,
    label_key,
    label: t(locale, label_key as MessageKey),
    state: options.state,
    reason_key: options.reason_key,
    reason_label: t(locale, options.reason_key as MessageKey),
    ...(options.reason ? { reason: options.reason } : {}),
    confirmation_required: options.confirmation_required ?? false,
    destructive: options.destructive ?? false,
    focus_changing: options.focus_changing ?? false,
    ...(options.command_text ? { command_text: options.command_text } : {}),
  };
}

function labelKey(id: HarnessOperatorAffordanceId): string {
  switch (id) {
    case "copy_attach_command":
      return "affordanceCopyAttachCommand";
    case "copy_run_id":
      return "affordanceCopyRunId";
    case "open_team_layout":
      return "affordanceOpenTeamLayout";
    case "replay_evidence":
      return "affordanceReplayEvidence";
    case "rerun_goal":
      return "affordanceRerunGoal";
    case "continue_run":
      return "affordanceContinueRun";
    case "cancel_run":
      return "affordanceCancelRun";
    case "interrupt_worker":
      return "affordanceInterruptWorker";
  }
}
