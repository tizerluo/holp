import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createHarnessWorkspaceState,
  recordDiscovery,
  recordEvent,
  recordRunAccepted,
} from "./state.js";
import { deriveInspect, deriveOverview } from "./renderModel.js";
import { harnessDiscoveryFixture } from "./fixtures.js";
import { renderFocusShell, type FocusShellRenderModel } from "./frame.js";
import type { HarnessWorkspaceLocale } from "./types.js";
import type { EventFrame } from "../cli/wire.js";

interface DemoOptions {
  readonly locale: HarnessWorkspaceLocale;
  readonly width: number;
  readonly height: number;
  readonly noAnsi: boolean;
  readonly mode: "overview" | "inspect";
  readonly agent?: string;
}

export function buildFocusShellDemoModel(options: Pick<DemoOptions, "locale" | "mode" | "agent">): FocusShellRenderModel {
  let state = createHarnessWorkspaceState({ locale: options.locale, provenance: "smoke_script" });
  state = recordDiscovery(state, harnessDiscoveryFixture);
  state = recordRunAccepted(state, {
    run_id: "run_72_demo",
    runtime: {
      agent_id: "coder-1",
      runtime_surface: "direct_user_session",
      runtime_kind: "tmux",
      isolation_profile: "coder_worktree",
    },
  });
  state = recordEvent(state, demoFrame(1, "run_started", {
    runtime: {
      agent_id: "coder-1",
      runtime_surface: "direct_user_session",
      runtime_kind: "tmux",
      isolation_profile: "coder_worktree",
    },
  }));
  state = recordEvent(state, demoFrame(2, "step_started", {
    agent_id: "coder-1",
    detail: "holp-worker-demo",
  }, "agent"));
  state = recordEvent(state, demoFrame(3, "agent_event", {
    name: "attach_target",
    payload: {
      agent_id: "coder-1",
      session_id: "holp-direct-demo",
      attach_command: "tmux attach -t holp-direct-demo",
    },
  }, "agent"));
  state = recordEvent(state, demoFrame(4, "model_output", {
    full_text: "Rendering Focus Shell from model_output.text_delta evidence while the Controller CLI remains native.",
  }, "agent"));
  state = recordEvent(state, demoFrame(5, "gate_report", {
    decision_surface: {
      gate_disposition: "approved",
      review_outcome: "approve",
    },
    artifact_refs: ["art_focus_shell_demo"],
  }));
  state = recordEvent(state, demoFrame(6, "run_merged", {
    artifact_id: "art_terminal_demo",
  }));

  return options.mode === "inspect"
    ? deriveInspect(state, options.agent ?? "coder-1")
    : deriveOverview(state);
}

export function runFocusShellDemo(argv: readonly string[] = process.argv.slice(2)): string {
  const options = parseDemoOptions(argv);
  const model = buildFocusShellDemoModel(options);
  return renderFocusShell(model, {
    width: options.width,
    height: options.height,
    noAnsi: options.noAnsi,
    isTTY: process.stdout.isTTY,
    env: process.env,
  }).join("\n");
}

function parseDemoOptions(argv: readonly string[]): DemoOptions {
  const options: DemoOptions = {
    locale: "en-US",
    width: 100,
    height: 28,
    noAnsi: false,
    mode: "overview",
  };
  const mutable: {
    locale: HarnessWorkspaceLocale;
    width: number;
    height: number;
    noAnsi: boolean;
    mode: "overview" | "inspect";
    agent?: string;
  } = { ...options };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--no-ansi") {
      mutable.noAnsi = true;
    } else if (arg === "--locale" && isLocale(next)) {
      mutable.locale = next;
      index += 1;
    } else if (arg === "--width" && next) {
      mutable.width = parsePositiveInteger(next, mutable.width);
      index += 1;
    } else if (arg === "--height" && next) {
      mutable.height = parsePositiveInteger(next, mutable.height);
      index += 1;
    } else if (arg === "--mode" && (next === "overview" || next === "inspect")) {
      mutable.mode = next;
      index += 1;
    } else if (arg === "--agent" && next) {
      mutable.agent = next;
      index += 1;
    }
  }

  return mutable;
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isLocale(value: string | undefined): value is HarnessWorkspaceLocale {
  return value === "en-US" || value === "zh-CN";
}

function demoFrame(seq: number, name: string, payload: unknown, category = categoryFor(name)): EventFrame {
  return {
    run_id: "run_72_demo",
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

function isMain(): boolean {
  return process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

if (isMain()) {
  process.stdout.write(`${runFocusShellDemo()}\n`);
}
