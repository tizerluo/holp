import path from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import type {
  AgentBackend,
  AgentBackendFactory,
  AgentBackendOptions,
  AgentBackendProbe,
  AgentMessageHandler,
} from "./agent-backend.js";
import { runCliCommand, probeCliBinary, type CliCommandResult } from "./cli-harness.js";
import { probeDirectTmux } from "./direct-tmux.js";
import {
  rejectedProfiles,
  withProfile,
  type DirectChannelDeclaration,
  type IsolationProfile,
  type RuntimeSurfaceDeclaration,
} from "./harness-declaration.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const ZCODE_SMOKE_MISSING = ["env:HOLP_REAL_ZCODE_SMOKE", "zcode_headless_smoke"] as const;
const ZCODE_DIRECT_SMOKE_MISSING = ["env:HOLP_REAL_ZCODE_SMOKE"] as const;
const ZCODE_CREDENTIAL_REASON = "zcode_missing_credential_config";
const ZCODE_RESOLVED_ROLES = ["coder"] as const;

export interface ZcodeHeadlessOptions {
  readonly command?: string;
  readonly configPath?: string;
  readonly tmuxCommand?: string;
  readonly timeoutMs?: number;
}

interface ZcodeCredentials {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
}

interface ZcodeJsonResponse {
  readonly response?: unknown;
}

export function zcodeModeForProfile(profile?: IsolationProfile): "build" | "plan" {
  return profile === "read_only_review" ? "plan" : "build";
}

export function zcodeArgsForPrompt(
  prompt: string,
  cwd: string,
  profile?: IsolationProfile,
): readonly string[] {
  return ["--prompt", prompt, "--mode", zcodeModeForProfile(profile), "--json", "--cwd", cwd];
}

export function zcodeDirectAgentArgsForPrompt(prompt: string): readonly string[] {
  return ["--prompt", prompt, "--mode", zcodeModeForProfile(), "--json"];
}

export function parseZcodeJsonOutput(stdout: string): ZcodeJsonResponse {
  let last: ZcodeJsonResponse | undefined;
  for (const start of jsonObjectStartOffsets(stdout)) {
    const candidate = extractBalancedJsonObject(stdout, start);
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as ZcodeJsonResponse;
      if (isRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, "response")) {
        last = parsed;
      }
    } catch {
      // Keep looking for a later legal JSON block.
    }
  }
  if (!last) throw new Error("zcode_json_response_missing");
  return last;
}

export function createZcodeHeadlessBackendFactory(
  options: ZcodeHeadlessOptions = {},
): AgentBackendFactory {
  return (opts) => new ZcodeHeadlessBackend(options, opts);
}

export function createZcodeProbe(options: ZcodeHeadlessOptions = {}): AgentBackendProbe {
  return async (input) => {
    const command = options.command ?? "zcode";
    const version = await probeCliBinary({
      command,
      versionArgs: ["--version"],
      cwd: input.cwd,
    });
    const credential = readZcodeCredentials({
      configPath: options.configPath,
      perRunEnv: undefined,
    });
    const headlessPresent = version.ok;
    const credentialReady = credential.ok;
    const smokeEnabled = process.env.HOLP_REAL_ZCODE_SMOKE === "1";
    let smokeReady = false;
    let smokeReason: string | undefined;
    if (headlessPresent && credentialReady && smokeEnabled) {
      const result = await runCliCommand({
        command,
        args: zcodeArgsForPrompt("HOLP ZCode smoke. Reply with HOLP_OK.", input.cwd),
        cwd: input.cwd,
        env: credential.env,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      const classified = classifyZcodeResult(result);
      smokeReady = classified.ok && classified.response.includes("HOLP_OK");
      smokeReason = smokeReady ? undefined : classified.ok ? "zcode_smoke_missing_holp_ok" : classified.reason;
    }

    const headlessReady = headlessPresent && credentialReady && smokeEnabled && smokeReady;
    const headlessReason = zcodeHeadlessReason({
      headlessPresent,
      credentialReady,
      headlessReady,
      credentialReason: credential.ok ? undefined : credential.reason,
      smokeReason,
      versionReason: version.reason,
    });
    const direct = await zcodeDirectReadiness({
      command,
      tmuxCommand: options.tmuxCommand,
      cwd: input.cwd,
      smokeEnabled,
      timeoutMs: options.timeoutMs,
    });
    const runtimeSurfaces = zcodeRuntimeSurfaces({
      headlessSupported: headlessPresent,
      headlessReady,
      headlessReason,
      headlessMissing: zcodeHeadlessMissing(version.ok, credentialReady, smokeEnabled, smokeReason),
      directReady: direct.ready,
      directReason: direct.reason,
      directMissing: direct.missing,
    });
    const anyPresent = headlessPresent || credentialReady;
    const anyReady = headlessReady || direct.ready;
    return {
      status: anyReady ? "ready" : anyPresent ? "degraded" : "rejected",
      harness_id: "zcode",
      vendor: "ZCode",
      transport_class: input.transport,
      runtime_surfaces: runtimeSurfaces,
      state_declaration_ref: "harness-state:zcode",
      global_mutation_required: false,
      version: version.output,
      logged_in: anyReady || undefined,
      resolved_roles: anyReady || anyPresent
        ? zcodeResolvedRoles(input.roles)
        : [],
      reason: anyReady ? undefined : headlessReason,
      missing: anyReady ? undefined : zcodeHeadlessMissing(version.ok, credentialReady, smokeEnabled, smokeReason),
    };
  };
}

async function zcodeDirectReadiness(args: {
  readonly command: string;
  readonly tmuxCommand?: string;
  readonly cwd: string;
  readonly smokeEnabled: boolean;
  readonly timeoutMs?: number;
}): Promise<{ readonly ready: boolean; readonly reason?: string; readonly missing?: readonly string[] }> {
  if (!args.smokeEnabled) {
    return {
      ready: false,
      reason: "zcode_direct_smoke_not_enabled",
      missing: ZCODE_DIRECT_SMOKE_MISSING,
    };
  }
  const result = await probeDirectTmux({
    tmuxCommand: args.tmuxCommand,
    agentCommand: args.command,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    verifyCapabilities: true,
  });
  if (result.ready) return { ready: true };
  return {
    ready: false,
    reason: result.reason ?? "zcode_direct_smoke_failed",
    missing: result.missing ?? ["direct_tmux_backend_smoke"],
  };
}

function zcodeResolvedRoles(roles: readonly string[]): readonly string[] {
  if (roles.length === 0) return ZCODE_RESOLVED_ROLES;
  return roles.filter((role) => ZCODE_RESOLVED_ROLES.includes(role as (typeof ZCODE_RESOLVED_ROLES)[number]));
}

function zcodeHeadlessReason(args: {
  readonly headlessPresent: boolean;
  readonly credentialReady: boolean;
  readonly headlessReady: boolean;
  readonly credentialReason?: string;
  readonly smokeReason?: string;
  readonly versionReason?: string;
}): string | undefined {
  if (!args.headlessPresent) return args.versionReason ?? "missing_binary";
  if (!args.credentialReady) return args.credentialReason;
  if (args.headlessReady) return undefined;
  return args.smokeReason ?? "zcode_headless_smoke_not_enabled";
}

class ZcodeHeadlessBackend implements AgentBackend {
  private readonly handlers: AgentMessageHandler[] = [];
  private sessionId: string | undefined;

  constructor(
    private readonly definition: ZcodeHeadlessOptions,
    private readonly opts: AgentBackendOptions,
  ) {}

  async startSession(): Promise<{ sessionId: string }> {
    this.sessionId = `zcode-cli-${Date.now()}`;
    this.emit({ type: "status", status: "starting" });
    return { sessionId: this.sessionId };
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    if (sessionId !== this.sessionId) throw new Error(`unknown zcode session '${sessionId}'`);
    const credentials = readZcodeCredentials({
      configPath: this.definition.configPath,
      perRunEnv: this.opts.env,
    });
    if (!credentials.ok) throw new Error(credentials.reason);
    this.emit({ type: "status", status: "running" });
    const result = await runCliCommand({
      command: this.definition.command ?? "zcode",
      args: zcodeArgsForPrompt(prompt, this.opts.cwd),
      cwd: this.opts.cwd,
      env: credentials.env,
      timeoutMs: this.definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const classified = classifyZcodeResult(result);
    if (!classified.ok) throw new Error(classified.reason);
    this.emit({ type: "model-output", fullText: classified.response });
    this.emit({ type: "status", status: "idle" });
  }

  async cancel(): Promise<void> {}

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    const index = this.handlers.indexOf(handler);
    if (index >= 0) this.handlers.splice(index, 1);
  }

  async dispose(): Promise<void> {}

  private emit(message: Parameters<AgentMessageHandler>[0]): void {
    for (const handler of this.handlers) handler(message);
  }
}

function classifyZcodeResult(result: CliCommandResult): { ok: true; response: string } | { ok: false; reason: string } {
  if (result.timedOut) return { ok: false, reason: "zcode_cli_timeout" };
  if (result.code !== 0) return { ok: false, reason: `zcode_cli_exit_${result.code ?? "signal"}` };
  let parsed: ZcodeJsonResponse;
  try {
    parsed = parseZcodeJsonOutput(result.stdout);
  } catch {
    return { ok: false, reason: "zcode_json_response_missing" };
  }
  return typeof parsed.response === "string"
    ? { ok: true, response: parsed.response }
    : { ok: false, reason: "zcode_response_missing" };
}

function readZcodeCredentials(args: {
  readonly configPath?: string;
  readonly perRunEnv: Readonly<Record<string, string>> | undefined;
}): { ok: true; env: Readonly<Record<string, string>> } | { ok: false; reason: string } {
  const configPath = args.configPath ?? path.join(homedir(), ".zcode", "v2", "config.json");
  if (!existsSync(configPath)) return { ok: false, reason: ZCODE_CREDENTIAL_REASON };
  let credentials: ZcodeCredentials | undefined;
  try {
    credentials = credentialsFromConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
  } catch {
    return { ok: false, reason: ZCODE_CREDENTIAL_REASON };
  }
  if (!credentials?.apiKey) return { ok: false, reason: ZCODE_CREDENTIAL_REASON };
  return {
    ok: true,
    env: {
      ANTHROPIC_API_KEY: credentials.apiKey,
      ...(credentials.baseUrl ? { ZCODE_BASE_URL: credentials.baseUrl } : {}),
      ...(credentials.model ? { ZCODE_MODEL: credentials.model } : {}),
      ...zcodePerRunEnv(args.perRunEnv),
    },
  };
}

function credentialsFromConfig(config: unknown): ZcodeCredentials | undefined {
  if (!isRecord(config)) return undefined;
  const provider = config.provider;
  if (!isRecord(provider)) return undefined;
  for (const value of Object.values(provider)) {
    if (!isRecord(value) || value.enabled !== true) continue;
    const options = isRecord(value.options) ? value.options : {};
    const models = isRecord(value.models) ? value.models : {};
    return {
      apiKey: stringValue(options.apiKey),
      baseUrl: stringValue(options.baseURL),
      model: canonicalModelId(models),
    };
  }
  return undefined;
}

function canonicalModelId(models: Record<string, unknown>): string | undefined {
  if (Object.prototype.hasOwnProperty.call(models, "GLM-5.2")) return "GLM-5.2";
  return Object.keys(models)[0];
}

function zcodePerRunEnv(env: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (!env) return {};
  const allowed: Record<string, string> = {};
  for (const key of ["ZCODE_MODEL", "ZCODE_BASE_URL"]) {
    if (typeof env[key] === "string" && env[key] !== "") allowed[key] = env[key];
  }
  return allowed;
}

function degradedReadiness(
  reason: string,
  missing?: readonly string[],
): { readonly readiness: "degraded"; readonly reason: string; readonly missing?: readonly string[] } {
  return {
    readiness: "degraded",
    reason,
    ...(missing ? { missing } : {}),
  };
}

function zcodeRuntimeSurfaces(args: {
  readonly headlessSupported: boolean;
  readonly headlessReady: boolean;
  readonly headlessReason?: string;
  readonly headlessMissing?: readonly string[];
  readonly directReady: boolean;
  readonly directReason?: string;
  readonly directMissing?: readonly string[];
}): readonly RuntimeSurfaceDeclaration[] {
  return [
    {
      runtime_surface: "headless",
      runtime_kind: "zcode_headless_cli",
      actual_fidelity: "one_shot",
      surface_support: args.headlessSupported ? "supported" : "unsupported",
      isolation_profiles: withProfile(
        withProfile(
          rejectedProfiles("unsupported_isolation_profile"),
          "coder_worktree",
          args.headlessReady
            ? { readiness: "ready" }
            : degradedReadiness(
                args.headlessReason ?? "zcode_headless_smoke_not_enabled",
                args.headlessMissing ?? ZCODE_SMOKE_MISSING,
              ),
        ),
        "real_provider_smoke",
        args.headlessReady
          ? { readiness: "ready" }
          : degradedReadiness(
              args.headlessReason ?? "zcode_headless_smoke_not_enabled",
              args.headlessMissing ?? ZCODE_SMOKE_MISSING,
            ),
      ),
      state_declaration_ref: "harness-state:zcode:headless",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
    {
      runtime_surface: "acp",
      runtime_kind: "zcode_acp_bridge_unwired",
      actual_fidelity: "one_shot",
      surface_support: "unsupported",
      isolation_profiles: rejectedProfiles("zcode_acp_bridge_not_certified", [
        "zcode_acp_bridge_not_certified",
      ]),
      state_declaration_ref: "harness-state:zcode:acp",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
    {
      runtime_surface: "direct_user_session",
      runtime_kind: "tmux",
      actual_fidelity: "streaming_controlled",
      surface_support: "experimental",
      isolation_profiles: withProfile(
        rejectedProfiles("unsupported_isolation_profile"),
        "coder_worktree",
        args.directReady
          ? { readiness: "ready", warnings: ["declared_not_enforced"] }
          : degradedReadiness(
              args.directReason ?? "zcode_direct_smoke_not_enabled",
              args.directMissing ?? ZCODE_DIRECT_SMOKE_MISSING,
            ),
      ),
      direct_channel: zcodeDirectChannel(args.directReady),
      state_declaration_ref: "harness-state:zcode:direct_user_session",
      global_mutation_required: false,
      declared_not_enforced: true,
    },
  ];
}

function zcodeDirectChannel(smokeProven = false): DirectChannelDeclaration {
  return {
    channel_type: "tmux",
    attach: smokeProven ? "supported" : "unknown",
    observe: smokeProven ? "supported" : "unknown",
    read: smokeProven ? "supported" : "unknown",
    inject: smokeProven ? "supported" : "unknown",
    interrupt: smokeProven ? "supported" : "unknown",
    cancel: smokeProven ? "supported" : "unknown",
    owner_scope: smokeProven ? "supported" : "unknown",
    session_origin: "holp_created",
    session_id_namespace: "holp-*",
    capability_bitmask: smokeProven
      ? ["exec", "observe", "read", "inject", "interrupt", "cancel", "owner_verified"]
      : [],
  };
}

function zcodeHeadlessMissing(
  binaryReady: boolean,
  credentialReady: boolean,
  smokeEnabled: boolean,
  smokeReason?: string,
): readonly string[] | undefined {
  const missing = [
    ...(binaryReady ? [] : ["binary:zcode"]),
    ...(credentialReady ? [] : [ZCODE_CREDENTIAL_REASON]),
    ...(smokeEnabled ? [] : [...ZCODE_SMOKE_MISSING]),
    ...(smokeReason ? [`zcode_headless_smoke:${smokeReason}`] : []),
  ];
  return missing.length > 0 ? missing : undefined;
}

function jsonObjectStartOffsets(raw: string): number[] {
  // This intentionally only scans line-leading JSON objects; warning text and JSON on the same line is out of scope.
  const offsets: number[] = [];
  let lineStart = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== "\n") continue;
    const line = raw.slice(lineStart, index);
    const trimmed = line.trimStart();
    if (trimmed.startsWith("{")) offsets.push(lineStart + line.length - trimmed.length);
    lineStart = index + 1;
  }
  return offsets;
}

function extractBalancedJsonObject(raw: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
