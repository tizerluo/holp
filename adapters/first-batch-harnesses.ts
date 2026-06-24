import type {
  AgentBackendFactory,
  AgentBackendProbe,
  AgentProbeInput,
  AgentProbeResult,
} from "./agent-backend.js";
import { createAcpBackendFactory, AcpClient, type AcpBackendDefinition } from "./acp-client.js";
import {
  createCliHarnessBackendFactory,
  probeCliBinary,
  runCliCommand,
  classifyCliResult,
  type CliHarnessDefinition,
} from "./cli-harness.js";
import {
  createDirectTmuxBackendFactory,
  probeDirectTmux,
  type DirectTmuxDefinition,
} from "./direct-tmux.js";
import {
  rejectedProfiles,
  withProfile,
  type DirectChannelDeclaration,
  type IsolationProfileReadiness,
  type RuntimeSurface,
  type RuntimeSurfaceDeclaration,
} from "./harness-declaration.js";

export const FIRST_BATCH_TRANSPORTS = [
  "cursor-agent",
  "kimi-code",
  "opencode",
  "pi",
  "reasonix",
] as const;

export type FirstBatchTransport = (typeof FIRST_BATCH_TRANSPORTS)[number];

export interface FirstBatchHarnessDefinition {
  readonly transport: FirstBatchTransport;
  readonly harnessId: string;
  readonly vendor: string;
  readonly headless: CliHarnessDefinition;
  readonly acp: AcpBackendDefinition;
  readonly direct: FirstBatchDirectSessionDeclaration;
  readonly readOnlyReviewEnforced?: boolean;
  readonly probeHeadlessSmoke?: boolean;
  readonly probeAcpSmoke?: boolean;
}

export type FirstBatchDirectSessionDeclaration =
  | FirstBatchDirectTmuxDeclaration
  | FirstBatchUnsupportedDirectDeclaration;

export interface FirstBatchDirectTmuxDeclaration {
  readonly state: "configured";
  readonly definition: DirectTmuxDefinition;
  readonly reason?: string;
  readonly missing?: readonly string[];
}

export interface FirstBatchUnsupportedDirectDeclaration {
  readonly state: "unsupported" | "rejected" | "degraded";
  readonly runtimeKind: string;
  readonly surfaceSupport: "unsupported" | "unknown" | "experimental";
  readonly reason: string;
  readonly missing?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 60_000;
const FIRST_BATCH_DIRECT_SMOKE_MISSING = [
  "HOLP_REAL_HARNESS_DIRECT_SMOKE",
  "agent_in_tmux_smoke",
  "owner_verified",
] as const;
const FIRST_BATCH_ACP_SMOKE_MISSING = ["HOLP_REAL_HARNESS_SMOKE", "acp_protocol_smoke"] as const;
// Grounded in the local drive-opencode skill's known usable model examples.
const OPENCODE_DIRECT_MODEL = "opencode/deepseek-v4-flash-free";

export const FIRST_BATCH_HARNESSES: readonly FirstBatchHarnessDefinition[] = [
  {
    transport: "cursor-agent",
    harnessId: "cursor-agent",
    vendor: "Cursor",
    headless: {
      transport: "cursor-agent",
      command: "cursor-agent",
      versionArgs: ["--version"],
      argsForPrompt: (prompt) => ["-p", prompt, "--output-format", "text", "--force"],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    acp: { transport: "cursor-agent", command: "cursor-agent", args: ["acp"] },
    direct: configuredDirect({
      transport: "cursor-agent",
      command: "cursor-agent",
      argsForPrompt: (prompt) => ["-p", prompt, "--output-format", "text", "--force"],
    }),
  },
  {
    transport: "kimi-code",
    harnessId: "kimi-code",
    vendor: "Moonshot AI",
    headless: {
      transport: "kimi-code",
      command: "kimi",
      versionArgs: ["--version"],
      argsForPrompt: (prompt) => [
        "-p",
        prompt,
        "-m",
        "kimi-code/kimi-for-coding",
        "--output-format",
        "text",
      ],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    acp: { transport: "kimi-code", command: "kimi", args: ["acp"] },
    direct: {
      state: "configured",
      definition: {
        transport: "kimi-code",
        agentCommand: "kimi",
        agentArgsForPrompt: (prompt) => [
          "-p",
          prompt,
          "-m",
          "kimi-code/kimi-for-coding",
          "--output-format",
          "text",
        ],
      },
      reason: "first_batch_direct_smoke_not_enabled",
      missing: FIRST_BATCH_DIRECT_SMOKE_MISSING,
    },
  },
  {
    transport: "opencode",
    harnessId: "opencode",
    vendor: "OpenCode",
    headless: {
      transport: "opencode",
      command: "opencode",
      versionArgs: ["--version"],
      argsForPrompt: (prompt) => ["run", "--pure", prompt, "-m", OPENCODE_DIRECT_MODEL],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    acp: { transport: "opencode", command: "opencode", args: ["acp", "--pure"] },
    direct: configuredDirect({
      transport: "opencode",
      command: "opencode",
      argsForPrompt: (prompt) => [
        "run",
        "--pure",
        prompt,
        "-m",
        OPENCODE_DIRECT_MODEL,
      ],
    }),
  },
  {
    transport: "pi",
    harnessId: "pi",
    vendor: "Pi",
    headless: {
      transport: "pi",
      command: "pi",
      versionArgs: ["--version"],
      argsForPrompt: (prompt) => ["-p", prompt],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    acp: { transport: "pi", command: "pi-acp" },
    direct: configuredDirect({
      transport: "pi",
      command: "pi",
      argsForPrompt: (prompt) => [
        "-p",
        prompt,
        "--mode",
        "text",
        "--provider",
        "xiaomi-token-plan-sgp",
        "--model",
        "mimo-v2.5-pro",
      ],
    }),
  },
  {
    transport: "reasonix",
    harnessId: "reasonix",
    vendor: "Reasonix",
    headless: {
      transport: "reasonix",
      command: "reasonix",
      versionArgs: ["--version"],
      argsForPrompt: (prompt) => ["run", "--model", "deepseek-flash", prompt],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    acp: {
      transport: "reasonix",
      command: "reasonix",
      args: ["acp", "--model", "deepseek-flash"],
      sessionNewShape: "cwd_only",
    },
    direct: configuredDirect({
      transport: "reasonix",
      command: "reasonix",
      argsForPrompt: (prompt) => ["run", "--model", "deepseek-flash", prompt],
    }),
  },
];

export function firstBatchAdapterFactories(
  definitions: readonly FirstBatchHarnessDefinition[] = FIRST_BATCH_HARNESSES,
): Partial<Record<string, Partial<Record<RuntimeSurface, AgentBackendFactory>>>> {
  return Object.fromEntries(definitions.map((definition) => [
    definition.transport,
    {
      headless: createCliHarnessBackendFactory(definition.headless),
      acp: createAcpBackendFactory(definition.acp),
      ...(definition.direct.state === "configured"
        ? { direct_user_session: createDirectTmuxBackendFactory(definition.direct.definition) }
        : {}),
    },
  ]));
}

export function firstBatchAdapterProbes(
  definitions: readonly FirstBatchHarnessDefinition[] = FIRST_BATCH_HARNESSES,
): Partial<Record<string, AgentBackendProbe>> {
  return Object.fromEntries(definitions.map((definition) => [
    definition.transport,
    (input: AgentProbeInput) => probeFirstBatchHarness(definition, input),
  ]));
}

export function isFirstBatchTransport(transport: string): transport is FirstBatchTransport {
  return FIRST_BATCH_TRANSPORTS.includes(transport as FirstBatchTransport);
}

export function firstBatchHeadlessFactoryForTransport(
  transport: string,
): AgentBackendFactory | undefined {
  const definition = FIRST_BATCH_HARNESSES.find((candidate) => candidate.transport === transport);
  return definition ? createCliHarnessBackendFactory(definition.headless) : undefined;
}

async function probeFirstBatchHarness(
  definition: FirstBatchHarnessDefinition,
  input: AgentProbeInput,
): Promise<AgentProbeResult> {
  const realSmokeEnabled = process.env.HOLP_REAL_HARNESS_SMOKE === "1";
  const directSmokeEnabled = process.env.HOLP_REAL_HARNESS_DIRECT_SMOKE === "1";
  const headlessVersion = await probeCliBinary({
    command: definition.headless.command,
    versionArgs: definition.headless.versionArgs,
    cwd: input.cwd,
  });
  const headlessReady = headlessVersion.ok &&
    (definition.probeHeadlessSmoke || realSmokeEnabled) &&
    await headlessSmokeReady(definition, input.cwd);
  const headlessReason = headlessVersion.ok
    ? headlessReady ? undefined : "headless_smoke_not_enabled_or_failed"
    : headlessVersion.reason ?? "headless_unavailable";

  const acpProbe = definition.transport === "reasonix"
    ? await reasonixAcpDegradedReason(definition, input.cwd, definition.probeAcpSmoke || realSmokeEnabled)
    : await acpSmokeReady(definition, input.cwd, definition.probeAcpSmoke || realSmokeEnabled);
  const acpReady = definition.transport !== "reasonix" && acpProbe.ready;
  const acpReason = definition.transport === "reasonix"
    ? acpProbe.reason
    : acpReady ? undefined : acpProbe.reason;

  const directProbe = await directProbeResult(definition, input.cwd, directSmokeEnabled);
  const directReady = directProbe.ready;
  const directReason = directProbe.reason;
  const directMissing = directProbe.missing;

  const runtimeSurfaces = [
    runtimeSurface({
      surface: "headless",
      kind: `${definition.transport}_headless_cli`,
      fidelity: "one_shot",
      support: headlessVersion.ok ? "supported" : "unsupported",
      ready: headlessReady,
      reason: headlessReason,
      readOnlyEnforced: definition.readOnlyReviewEnforced === true,
      stateRef: `harness-state:${definition.transport}:headless`,
    }),
    runtimeSurface({
      surface: "acp",
      kind: `${definition.transport}_acp`,
      fidelity: "streaming_controlled",
      support: definition.transport === "reasonix" ? "experimental" : "supported",
      ready: acpReady,
      reason: acpReason,
      missing: acpProbe.missing,
      readOnlyEnforced: false,
      stateRef: `harness-state:${definition.transport}:acp`,
    }),
    runtimeSurface({
      surface: "direct_user_session",
      kind: directRuntimeKind(definition),
      fidelity: definition.direct.state === "configured" ? "streaming_controlled" : "one_shot",
      support: directSurfaceSupport(definition),
      ready: directReady,
      reason: directReason,
      missing: directMissing,
      readOnlyEnforced: false,
      stateRef: `harness-state:${definition.transport}:direct_user_session`,
      directChannel: directChannel(directReady),
    }),
  ] as const;

  const anyReady = headlessReady || acpReady || directReady;
  const anyPresent = headlessVersion.ok ||
    (definition.transport !== "reasonix" && acpProbe.present) ||
    hasDirectPresenceEvidence(directReady, directReason, directSmokeEnabled);
  return {
    status: anyReady ? "ready" : anyPresent ? "degraded" : "rejected",
    harness_id: definition.harnessId,
    vendor: definition.vendor,
    transport_class: input.transport,
    runtime_surfaces: runtimeSurfaces,
    state_declaration_ref: `harness-state:${definition.transport}`,
    global_mutation_required: false,
    version: headlessVersion.output,
    logged_in: anyReady || undefined,
    resolved_roles: anyReady || anyPresent
      ? (input.roles.length > 0 ? input.roles : ["coder", "tester", "architect", "reviewer"])
      : [],
    missing: anyReady ? undefined : missingFor(headlessVersion, acpReason, directReason),
    reason: anyReady ? undefined : headlessReason,
  };
}

async function headlessSmokeReady(
  definition: FirstBatchHarnessDefinition,
  cwd: string,
): Promise<boolean> {
  const result = await runCliCommand({
    command: definition.headless.command,
    args: definition.headless.argsForPrompt("HOLP harness smoke. Reply with HOLP_OK."),
    cwd,
    timeoutMs: Math.min(definition.headless.timeoutMs ?? DEFAULT_TIMEOUT_MS, 20_000),
  });
  return classifyCliResult(result, definition.headless.classify).ok &&
    result.stdout.includes("HOLP_OK");
}

async function acpSmokeReady(
  definition: FirstBatchHarnessDefinition,
  cwd: string,
  runSmoke: boolean,
): Promise<AcpProbeResult> {
  if (!runSmoke) {
    return {
      ready: false,
      present: false,
      reason: "acp_smoke_not_enabled",
      missing: FIRST_BATCH_ACP_SMOKE_MISSING,
    };
  }
  let client: AcpClient | undefined;
  try {
    client = new AcpClient({
      command: definition.acp.command,
      args: definition.acp.args,
      cwd,
      sessionNewShape: definition.acp.sessionNewShape,
      requestTimeoutMs: definition.acp.requestTimeoutMs ?? 5_000,
      terminalTimeoutMs: definition.acp.terminalTimeoutMs ?? 20_000,
    });
    const session = await client.startSession();
    const output = await client.sendPrompt(session.sessionId, "HOLP ACP smoke. Reply with HOLP_OK.");
    return output.includes("HOLP_OK")
      ? { ready: true, present: true }
      : {
          ready: false,
          present: true,
          reason: "acp_prompt_missing_holp_ok",
          missing: ["acp_protocol_smoke:HOLP_OK"],
        };
  } catch (error) {
    const reason = classifyAcpFailure(definition.transport, error);
    return {
      ready: false,
      present: reason !== "acp_missing_binary",
      reason,
      missing: [`acp_protocol_smoke:${reason}`],
    };
  } finally {
    await client?.dispose().catch(() => undefined);
  }
}

async function reasonixAcpDegradedReason(
  definition: FirstBatchHarnessDefinition,
  cwd: string,
  runSmoke: boolean,
): Promise<AcpProbeResult> {
  if (!runSmoke) {
    return {
      ready: false,
      present: false,
      reason: "reasonix_acp_session_new_not_stable",
      missing: FIRST_BATCH_ACP_SMOKE_MISSING,
    };
  }
  const client = new AcpClient({
    command: definition.acp.command,
    args: definition.acp.args,
    cwd,
    sessionNewShape: definition.acp.sessionNewShape,
    requestTimeoutMs: definition.acp.requestTimeoutMs ?? 5_000,
    terminalTimeoutMs: definition.acp.terminalTimeoutMs ?? 10_000,
  });
  let stage: "session_new" | "prompt_terminal" = "session_new";
  try {
    const session = await client.startSession();
    stage = "prompt_terminal";
    const output = await client.sendPrompt(session.sessionId, "HOLP Reasonix ACP smoke. Reply with HOLP_OK.");
    return output.includes("HOLP_OK")
      ? {
          ready: false,
          present: true,
          reason: "reasonix_acp_observed_ok_but_not_certified_this_pr",
          missing: ["reasonix_acp_certification"],
        }
      : {
          ready: false,
          present: true,
          reason: "reasonix_acp_session_new_succeeded_prompt_terminal_without_holp_ok",
          missing: ["acp_protocol_smoke:HOLP_OK"],
        };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = stage === "session_new"
      ? `reasonix_acp_session_new_failed:${message}`
      : `reasonix_acp_session_new_succeeded_prompt_terminal_not_verified:${message}`;
    return {
      ready: false,
      present: classifyAcpFailure(definition.transport, error) !== "acp_missing_binary",
      reason,
      missing: [`acp_protocol_smoke:${stage}`],
    };
  } finally {
    await client.dispose().catch(() => undefined);
  }
}

interface AcpProbeResult {
  readonly ready: boolean;
  readonly present: boolean;
  readonly reason?: string;
  readonly missing?: readonly string[];
}

function classifyAcpFailure(transport: FirstBatchTransport, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ENOENT")) return "acp_missing_binary";
  if (message.includes("acp_malformed_json")) return "acp_malformed_json";
  if (message.includes("acp_terminal_timeout")) return "acp_prompt_terminal_missing";
  if (message.includes("acp_request_timeout:initialize")) return "acp_initialize_timeout";
  if (message.includes("acp_request_timeout:session/new")) return "acp_session_new_timeout";
  if (message.includes("acp_request_timeout:session/prompt")) return "acp_prompt_timeout";
  if (message.includes("acp_missing_final_result")) return "acp_prompt_terminal_missing";
  if (message.includes("acp_process_exit")) return "acp_process_exit";
  if (message.includes("auth") || message.includes("Authentication") || message.includes("unauthorized")) {
    return transport === "cursor-agent" ? "cursor_acp_auth_required" : "acp_auth_required";
  }
  if (message.includes("session/new")) return "acp_session_new_failed";
  if (message.includes("initialize")) return "acp_initialize_failed";
  return `acp_smoke_failed:${message}`;
}

async function directProbeResult(
  definition: FirstBatchHarnessDefinition,
  cwd: string,
  directSmokeEnabled: boolean,
): Promise<{ ready: boolean; reason?: string; missing?: readonly string[] }> {
  if (definition.direct.state !== "configured") {
    return {
      ready: false,
      reason: definition.direct.reason,
      missing: definition.direct.missing,
    };
  }
  if (!directSmokeEnabled) {
    return {
      ready: false,
      reason: definition.direct.reason ?? "first_batch_direct_smoke_not_enabled",
      missing: definition.direct.missing ?? FIRST_BATCH_DIRECT_SMOKE_MISSING,
    };
  }
  const direct = definition.direct.definition;
  const result = await probeDirectTmux({
    tmuxCommand: direct.tmuxCommand,
    agentCommand: direct.agentCommand,
    cwd,
    verifyCapabilities: true,
  });
  if (!result.ready) {
    return {
      ready: false,
      reason: result.reason ?? "direct_tmux_capability_not_proven",
      missing: result.missing,
    };
  }
  const backend = createDirectTmuxBackendFactory(direct)({ cwd });
  const output: string[] = [];
  backend.onMessage((message) => {
    if (message.type === "model-output" && typeof message.fullText === "string") {
      output.push(message.fullText);
    }
  });
  try {
    const session = await backend.startSession();
    await backend.sendPrompt(session.sessionId, "HOLP direct tmux smoke. Reply with HOLP_OK.");
    return output.some((text) => text.includes("HOLP_OK"))
      ? { ready: true }
      : {
          ready: false,
          reason: "direct_agent_smoke_missing_holp_ok",
          missing: ["agent_in_tmux_smoke:HOLP_OK"],
        };
  } catch (error) {
    return {
      ready: false,
      reason: error instanceof Error ? error.message : String(error),
      missing: ["direct_tmux_backend_smoke"],
    };
  } finally {
    await backend.dispose().catch(() => undefined);
  }
}

function runtimeSurface(args: {
  readonly surface: RuntimeSurface;
  readonly kind: string;
  readonly fidelity: "one_shot" | "streaming_controlled";
  readonly support: "supported" | "experimental" | "unsupported" | "unknown";
  readonly ready: boolean;
  readonly reason?: string;
  readonly missing?: readonly string[];
  readonly readOnlyEnforced: boolean;
  readonly stateRef: string;
  readonly directChannel?: DirectChannelDeclaration;
}): RuntimeSurfaceDeclaration {
  return {
    runtime_surface: args.surface,
    runtime_kind: args.kind,
    actual_fidelity: args.fidelity,
    surface_support: args.support,
    isolation_profiles: profilesFor(args.ready, args.reason, args.readOnlyEnforced, args.missing),
    ...(args.directChannel ? { direct_channel: args.directChannel } : {}),
    state_declaration_ref: args.stateRef,
    global_mutation_required: false,
    declared_not_enforced: !args.readOnlyEnforced,
  };
}

function profilesFor(
  ready: boolean,
  reason = "runtime_surface_not_ready",
  readOnlyEnforced: boolean,
  missing: readonly string[] = [reason],
) {
  const base = rejectedProfiles("unsupported_isolation_profile");
  const execution: IsolationProfileReadiness = ready
    ? { readiness: "ready" }
    : { readiness: "degraded", reason, missing };
  const readOnly: IsolationProfileReadiness = ready && readOnlyEnforced
    ? { readiness: "ready" }
    : {
        readiness: ready ? "degraded" : "rejected",
        reason: readOnlyEnforced ? reason : "read_only_enforcement_not_proven",
        missing: readOnlyEnforced ? missing : ["read_only_enforcement"],
        warnings: readOnlyEnforced ? undefined : ["declared_not_enforced"],
      };
  return withProfile(
    withProfile(
      withProfile(base, "coder_worktree", execution),
      "real_provider_smoke",
      execution,
    ),
    "read_only_review",
    readOnly,
  );
}

function directChannel(ready: boolean): DirectChannelDeclaration {
  const support = ready ? "supported" : "unknown";
  return {
    channel_type: "tmux",
    attach: support,
    observe: support,
    read: support,
    inject: support,
    interrupt: support,
    cancel: support,
    owner_scope: ready ? "supported" : "unknown",
    session_origin: "holp_created",
    session_id_namespace: "holp-*",
    capability_bitmask: ready
      ? ["observe", "read", "inject", "interrupt", "cancel", "owner_verified"]
      : [],
  };
}

function missingFor(
  headlessVersion: { readonly ok: boolean; readonly reason?: string },
  acpReason?: string,
  directReason?: string,
): readonly string[] | undefined {
  const missing = [
    ...(headlessVersion.ok ? [] : [`headless:${headlessVersion.reason ?? "unavailable"}`]),
    ...(acpReason ? [`acp:${acpReason}`] : []),
    ...(directReason ? [`direct_user_session:${directReason}`] : []),
  ];
  return missing.length > 0 ? missing : undefined;
}

function hasDirectPresenceEvidence(
  ready: boolean,
  reason: string | undefined,
  directSmokeEnabled: boolean,
): boolean {
  if (ready) return true;
  if (!directSmokeEnabled) return false;
  return reason !== undefined &&
    reason !== "first_batch_direct_smoke_not_enabled" &&
    reason !== "tmux_unavailable" &&
    reason !== "direct_agent_unavailable";
}

function configuredDirect(args: {
  readonly transport: FirstBatchTransport;
  readonly command: string;
  readonly argsForPrompt: (prompt: string) => readonly string[];
}): FirstBatchDirectTmuxDeclaration {
  return {
    state: "configured",
    definition: {
      transport: args.transport,
      agentCommand: args.command,
      agentArgsForPrompt: args.argsForPrompt,
    },
    reason: "first_batch_direct_smoke_not_enabled",
    missing: FIRST_BATCH_DIRECT_SMOKE_MISSING,
  };
}

function directRuntimeKind(definition: FirstBatchHarnessDefinition): string {
  return definition.direct.state === "configured" ? "tmux" : definition.direct.runtimeKind;
}

function directSurfaceSupport(
  definition: FirstBatchHarnessDefinition,
): "supported" | "experimental" | "unsupported" | "unknown" {
  return definition.direct.state === "configured" ? "experimental" : definition.direct.surfaceSupport;
}
