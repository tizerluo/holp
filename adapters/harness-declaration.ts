export const ISOLATION_PROFILES = [
  "read_only_review",
  "coder_worktree",
  "real_provider_smoke",
  "multi_agent_concurrent",
  "user_global_install",
  "high_isolation",
] as const;

export type RuntimeSurface = "headless" | "acp" | "direct_user_session";
export type SurfaceSupport = "supported" | "experimental" | "unsupported" | "unknown";
export type IsolationProfile = (typeof ISOLATION_PROFILES)[number];
export type IsolationReadiness = "ready" | "degraded" | "rejected";

export interface IsolationProfileReadiness {
  readonly readiness: IsolationReadiness;
  readonly reason?: string;
  readonly missing?: readonly string[];
  readonly warnings?: readonly string[];
}

export interface DirectChannelDeclaration {
  readonly channel_type: "product_session" | "pty" | "tmux" | "terminal_app" | (string & {});
  readonly attach: SurfaceSupport;
  readonly observe: SurfaceSupport;
  readonly read: SurfaceSupport;
  readonly inject: SurfaceSupport;
  readonly interrupt: SurfaceSupport;
  readonly cancel: SurfaceSupport;
  readonly owner_scope: SurfaceSupport;
}

export interface RuntimeSurfaceDeclaration {
  readonly runtime_surface: RuntimeSurface;
  readonly runtime_kind: string;
  readonly surface_support: SurfaceSupport;
  readonly isolation_profiles: Record<IsolationProfile, IsolationProfileReadiness>;
  readonly direct_channel?: DirectChannelDeclaration;
  readonly state_declaration_ref?: string;
  readonly global_mutation_required: boolean;
  /**
   * This PR records declared capability readiness only. It does not enforce OS,
   * provider-home, hook, or read-only isolation in the backend runtime.
   */
  readonly declared_not_enforced: boolean;
}

export interface HarnessDeclarationMetadata {
  readonly harness_id?: string;
  readonly vendor?: string;
  readonly transport_class?: string;
  readonly runtime_surfaces?: readonly RuntimeSurfaceDeclaration[];
  readonly state_declaration_ref?: string;
  readonly global_mutation_required?: boolean;
}

export interface RuntimeSelectionMetadata {
  readonly agent_id: string;
  readonly transport: string;
  readonly runtime_surface: RuntimeSurface;
  readonly runtime_kind: string;
  readonly isolation_profile: IsolationProfile;
  readonly isolation_status: IsolationReadiness;
  readonly isolation_reason?: string;
  readonly isolation_missing?: readonly string[];
  readonly isolation_warnings?: readonly string[];
  readonly state_declaration_ref?: string;
  readonly global_mutation_required: boolean;
  readonly declared_not_enforced: boolean;
}

export function rejectedProfiles(
  reason: string,
  missing: readonly string[] = [],
): Record<IsolationProfile, IsolationProfileReadiness> {
  return Object.fromEntries(
    ISOLATION_PROFILES.map((profile) => [
      profile,
      {
        readiness: "rejected",
        reason,
        ...(missing.length > 0 ? { missing } : {}),
      },
    ]),
  ) as Record<IsolationProfile, IsolationProfileReadiness>;
}

export function withProfile(
  base: Record<IsolationProfile, IsolationProfileReadiness>,
  profile: IsolationProfile,
  readiness: IsolationProfileReadiness,
): Record<IsolationProfile, IsolationProfileReadiness> {
  return { ...base, [profile]: readiness };
}

export function findRuntimeProfile(
  runtimeSurfaces: readonly RuntimeSurfaceDeclaration[] | undefined,
  runtimeSurface: RuntimeSurface,
  isolationProfile: IsolationProfile,
): { surface: RuntimeSurfaceDeclaration; profile: IsolationProfileReadiness } | undefined {
  const surface = runtimeSurfaces?.find((candidate) => candidate.runtime_surface === runtimeSurface);
  const profile = surface?.isolation_profiles[isolationProfile];
  if (!surface || !profile) return undefined;
  return { surface, profile };
}

export function runtimeSelectionFromDeclaration(args: {
  agentId: string;
  transport: string;
  runtimeSurface: RuntimeSurface;
  isolationProfile: IsolationProfile;
  declaration: RuntimeSurfaceDeclaration;
  profile: IsolationProfileReadiness;
}): RuntimeSelectionMetadata {
  return {
    agent_id: args.agentId,
    transport: args.transport,
    runtime_surface: args.runtimeSurface,
    runtime_kind: args.declaration.runtime_kind,
    isolation_profile: args.isolationProfile,
    isolation_status: args.profile.readiness,
    isolation_reason: args.profile.reason,
    isolation_missing: args.profile.missing,
    isolation_warnings: args.profile.warnings,
    state_declaration_ref: args.declaration.state_declaration_ref,
    global_mutation_required: args.declaration.global_mutation_required,
    declared_not_enforced: args.declaration.declared_not_enforced,
  };
}
