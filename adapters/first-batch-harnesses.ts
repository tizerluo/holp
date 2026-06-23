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
  readonly direct?: DirectTmuxDefinition;
  readonly readOnlyReviewEnforced?: boolean;
  readonly probeHeadlessSmoke?: boolean;
  readonly probeAcpSmoke?: boolean;
  readonly probeDirectReady?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;

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
  },
  {
    transport: "opencode",
    harnessId: "opencode",
    vendor: "OpenCode",
    headless: {
      transport: "opencode",
      command: "opencode",
      versionArgs: ["--version"],
      argsForPrompt: (prompt) => ["run", prompt],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    acp: { transport: "opencode", command: "opencode", args: ["acp"] },
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
  },
  {
    transport: "reasonix",
    harnessId: "reasonix",
    vendor: "Reasonix",
    headless: {
      transport: "reasonix",
      command: "reasonix",
      versionArgs: ["--version"],
      argsForPrompt: (prompt) => ["run", prompt],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    acp: { transport: "reasonix", command: "reasonix", args: ["acp"] },
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
      ...(definition.direct
        ? { direct_user_session: createDirectTmuxBackendFactory(definition.direct) }
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

  const acpReady = definition.transport !== "reasonix" &&
    (definition.probeAcpSmoke || realSmokeEnabled) &&
    await acpSmokeReady(definition, input.cwd);
  const acpReason = definition.transport === "reasonix"
    ? await reasonixAcpDegradedReason(definition, input.cwd, definition.probeAcpSmoke || realSmokeEnabled)
    : acpReady ? undefined : "acp_smoke_not_enabled_or_failed";

  const directReady = definition.direct
    ? await directProbeReady(definition, input.cwd, realSmokeEnabled)
    : false;
  const directReason = definition.direct
    ? directReady ? undefined : "direct_tmux_capability_not_proven"
    : "direct_user_session_not_declared";

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
      readOnlyEnforced: false,
      stateRef: `harness-state:${definition.transport}:acp`,
    }),
    runtimeSurface({
      surface: "direct_user_session",
      kind: definition.direct ? "tmux" : `${definition.transport}_direct_unwired`,
      fidelity: definition.direct ? "streaming_controlled" : "one_shot",
      support: definition.direct ? "experimental" : "unknown",
      ready: directReady,
      reason: directReason,
      readOnlyEnforced: false,
      stateRef: `harness-state:${definition.transport}:direct_user_session`,
      directChannel: directChannel(directReady),
    }),
  ] as const;

  const anyReady = headlessReady || acpReady || directReady;
  const anyPresent = headlessVersion.ok || acpReason !== "acp_smoke_not_enabled_or_failed" || definition.direct;
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
    missing: anyReady ? undefined : missingFor(headlessVersion, acpReason),
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
  return classifyCliResult(result, definition.headless.classify).ok;
}

async function acpSmokeReady(
  definition: FirstBatchHarnessDefinition,
  cwd: string,
): Promise<boolean> {
  let client: AcpClient | undefined;
  try {
    client = new AcpClient({
      command: definition.acp.command,
      args: definition.acp.args,
      cwd,
      requestTimeoutMs: definition.acp.requestTimeoutMs ?? 5_000,
      terminalTimeoutMs: definition.acp.terminalTimeoutMs ?? 20_000,
    });
    const session = await client.startSession();
    await client.sendPrompt(session.sessionId, "HOLP ACP smoke. Reply with HOLP_OK.");
    return true;
  } catch {
    return false;
  } finally {
    await client?.dispose().catch(() => undefined);
  }
}

async function reasonixAcpDegradedReason(
  definition: FirstBatchHarnessDefinition,
  cwd: string,
  runSmoke: boolean,
): Promise<string> {
  if (!runSmoke) return "reasonix_acp_session_new_not_stable";
  const client = new AcpClient({
    command: definition.acp.command,
    args: definition.acp.args,
    cwd,
    requestTimeoutMs: definition.acp.requestTimeoutMs ?? 5_000,
    terminalTimeoutMs: definition.acp.terminalTimeoutMs ?? 10_000,
  });
  let stage: "session_new" | "prompt_terminal" = "session_new";
  try {
    const session = await client.startSession();
    stage = "prompt_terminal";
    await client.sendPrompt(session.sessionId, "HOLP Reasonix ACP smoke. Reply with HOLP_OK.");
    return "reasonix_acp_prompt_terminal_verified_policy_degraded";
  } catch (error) {
    return stage === "session_new"
      ? `reasonix_acp_session_new_failed:${error instanceof Error ? error.message : String(error)}`
      : `reasonix_acp_session_new_succeeded_prompt_terminal_not_verified:${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await client.dispose().catch(() => undefined);
  }
}

async function directProbeReady(
  definition: FirstBatchHarnessDefinition,
  cwd: string,
  realSmokeEnabled: boolean,
): Promise<boolean> {
  if (!definition.direct || (!definition.probeDirectReady && !realSmokeEnabled)) return false;
  const result = await probeDirectTmux({
    tmuxCommand: definition.direct.tmuxCommand,
    agentCommand: definition.direct.agentCommand,
    cwd,
    verifyCapabilities: true,
  });
  return result.ready;
}

function runtimeSurface(args: {
  readonly surface: RuntimeSurface;
  readonly kind: string;
  readonly fidelity: "one_shot" | "streaming_controlled";
  readonly support: "supported" | "experimental" | "unsupported" | "unknown";
  readonly ready: boolean;
  readonly reason?: string;
  readonly readOnlyEnforced: boolean;
  readonly stateRef: string;
  readonly directChannel?: DirectChannelDeclaration;
}): RuntimeSurfaceDeclaration {
  return {
    runtime_surface: args.surface,
    runtime_kind: args.kind,
    actual_fidelity: args.fidelity,
    surface_support: args.support,
    isolation_profiles: profilesFor(args.ready, args.reason, args.readOnlyEnforced),
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
) {
  const base = rejectedProfiles("unsupported_isolation_profile");
  const execution: IsolationProfileReadiness = ready
    ? { readiness: "ready" }
    : { readiness: "degraded", reason, missing: [reason] };
  const readOnly: IsolationProfileReadiness = ready && readOnlyEnforced
    ? { readiness: "ready" }
    : {
        readiness: ready ? "degraded" : "rejected",
        reason: readOnlyEnforced ? reason : "read_only_enforcement_not_proven",
        missing: readOnlyEnforced ? [reason] : ["read_only_enforcement"],
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
): readonly string[] | undefined {
  const missing = [
    ...(headlessVersion.ok ? [] : [`headless:${headlessVersion.reason ?? "unavailable"}`]),
    ...(acpReason ? [`acp:${acpReason}`] : []),
  ];
  return missing.length > 0 ? missing : undefined;
}
