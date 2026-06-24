import type { EventFrame } from "../cli/wire.js";

export const harnessDiscoveryFixture = {
  agents: [
    {
      id: "coder-1",
      status: "ready",
      role: "coder",
      runtime_surfaces: [
        {
          runtime_surface: "direct_user_session",
          runtime_kind: "tmux",
          surface_support: "experimental",
          direct_channel: {
            attach: "supported",
            observe: "supported",
            read: "supported",
            inject: "supported",
            interrupt: "supported",
            cancel: "supported",
            owner_scope: "supported",
            capability_bitmask: ["observe", "read", "inject", "cancel", "owner_verified"],
          },
        },
      ],
    },
    {
      id: "reviewer-1",
      status: "ready",
      role: "reviewer",
      runtime_surfaces: [
        {
          runtime_surface: "headless",
          runtime_kind: "process",
          surface_support: "ready",
        },
      ],
    },
  ],
};

export function frame(seq: number, name: string, payload: unknown, category = categoryFor(name)): EventFrame {
  return {
    run_id: "run_71",
    seq,
    category,
    name,
    payload,
  };
}

function categoryFor(name: string): string {
  if (name.startsWith("approval_")) return "approval";
  if (name.startsWith("consensus_")) return "consensus";
  if (name === "gate_report") return "gate";
  if (name === "step_started" || name === "model_output" || name === "agent_event") return "agent";
  return "run";
}
