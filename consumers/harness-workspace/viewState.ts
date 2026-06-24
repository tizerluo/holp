export type FocusShellMode = "overview" | "inspect";

export interface FocusShellViewState {
  readonly mode: FocusShellMode;
  readonly selectedAgentId?: string;
}

export type FocusShellViewAction =
  | { readonly type: "select"; readonly agentId: string }
  | { readonly type: "enterInspect"; readonly agentId?: string }
  | { readonly type: "escapeToOverview" };

export function createFocusShellViewState(): FocusShellViewState {
  return { mode: "overview" };
}

export function select(agentId: string): FocusShellViewAction {
  return { type: "select", agentId };
}

export function enterInspect(agentId?: string): FocusShellViewAction {
  return { type: "enterInspect", agentId };
}

export function escapeToOverview(): FocusShellViewAction {
  return { type: "escapeToOverview" };
}

export function reduceFocusShellViewState(
  state: FocusShellViewState,
  action: FocusShellViewAction,
): FocusShellViewState {
  switch (action.type) {
    case "select":
      return { ...state, selectedAgentId: action.agentId };
    case "enterInspect":
      return {
        mode: "inspect",
        selectedAgentId: action.agentId ?? state.selectedAgentId,
      };
    case "escapeToOverview":
      return { ...state, mode: "overview" };
  }
}
