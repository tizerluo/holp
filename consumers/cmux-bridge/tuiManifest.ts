import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CmuxCommandResult, CmuxDegradedReason, CmuxLayoutCommand } from "./types.js";
import { validateCmuxLayoutCommand } from "./commands.js";

export const HARNESS_WORKSPACE_TMP_ROOT = "/tmp/holp-harness-workspace";

export type CmuxTuiSurfaceRole = "tui" | "controller" | "worker_attach";

export interface CmuxOwnedSurfaceRecord {
  readonly surface_id: string;
  readonly pane_id?: string;
  readonly kind: CmuxTuiSurfaceRole;
  readonly agent?: string;
  readonly created_by: "harness-workspace-tui-cmux";
  readonly created_at: string;
  readonly last_command?: string;
}

export interface CmuxTuiSessionManifest {
  readonly schema_version: "HolpHarnessWorkspaceCmuxManifest.v1";
  readonly session_id: string;
  readonly workspace_id: string;
  readonly broker_socket: string;
  readonly created_at: string;
  readonly surfaces: Partial<Record<CmuxTuiSurfaceRole, CmuxOwnedSurfaceRecord>>;
  readonly degraded_reasons: readonly CmuxDegradedReason[];
  readonly command_results: readonly CmuxCommandResult[];
}

export function manifestPathForSession(sessionId: string, baseDir = HARNESS_WORKSPACE_TMP_ROOT): string {
  return path.join(baseDir, sessionId, "cmux-surfaces.json");
}

export function sessionDirForSession(sessionId: string, baseDir = HARNESS_WORKSPACE_TMP_ROOT): string {
  return path.join(baseDir, sessionId);
}

export function createCmuxTuiSessionManifest(options: {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly brokerSocket: string;
  readonly now?: string;
}): CmuxTuiSessionManifest {
  return {
    schema_version: "HolpHarnessWorkspaceCmuxManifest.v1",
    session_id: options.sessionId,
    workspace_id: options.workspaceId,
    broker_socket: options.brokerSocket,
    created_at: options.now ?? new Date().toISOString(),
    surfaces: {},
    degraded_reasons: [],
    command_results: [],
  };
}

export function addManifestSurface(
  manifest: CmuxTuiSessionManifest,
  role: CmuxTuiSurfaceRole,
  surface: Omit<CmuxOwnedSurfaceRecord, "kind" | "created_by" | "created_at"> & { readonly created_at?: string },
): CmuxTuiSessionManifest {
  return {
    ...manifest,
    surfaces: {
      ...manifest.surfaces,
      [role]: {
        ...surface,
        kind: role,
        created_by: "harness-workspace-tui-cmux",
        created_at: surface.created_at ?? new Date().toISOString(),
      },
    },
  };
}

export function recordManifestCommandResult(
  manifest: CmuxTuiSessionManifest,
  result: CmuxCommandResult,
): CmuxTuiSessionManifest {
  return {
    ...manifest,
    command_results: [...manifest.command_results, result].slice(-100),
  };
}

export function addManifestDegradedReason(
  manifest: CmuxTuiSessionManifest,
  reason: CmuxDegradedReason,
): CmuxTuiSessionManifest {
  return manifest.degraded_reasons.includes(reason)
    ? manifest
    : { ...manifest, degraded_reasons: [...manifest.degraded_reasons, reason] };
}

export function writeCmuxTuiSessionManifest(
  manifest: CmuxTuiSessionManifest,
  baseDir = HARNESS_WORKSPACE_TMP_ROOT,
): string {
  const manifestPath = manifestPathForSession(manifest.session_id, baseDir);
  mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return manifestPath;
}

export function readCmuxTuiSessionManifest(
  options: { readonly sessionId?: string; readonly brokerSocket?: string; readonly baseDir?: string },
): CmuxTuiSessionManifest {
  const sessionId = options.sessionId ?? sessionIdFromBrokerSocket(options.brokerSocket, options.baseDir);
  if (!sessionId) throw new Error("missing_session_selector");
  const raw = readFileSync(manifestPathForSession(sessionId, options.baseDir), "utf8");
  const manifest = JSON.parse(raw) as CmuxTuiSessionManifest;
  if (manifest.schema_version !== "HolpHarnessWorkspaceCmuxManifest.v1") {
    throw new Error("invalid_manifest_schema");
  }
  return manifest;
}

export function sessionIdFromBrokerSocket(
  brokerSocket: string | undefined,
  baseDir = HARNESS_WORKSPACE_TMP_ROOT,
): string | undefined {
  if (!brokerSocket) return undefined;
  const normalizedBase = path.resolve(baseDir);
  const normalizedSocket = path.resolve(brokerSocket);
  const relative = path.relative(normalizedBase, normalizedSocket);
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || parts[1] !== "broker.sock" || parts[0].startsWith("..") || parts[0] === "") {
    return undefined;
  }
  return parts[0];
}

export function assertOwnedSendCommand(
  manifest: CmuxTuiSessionManifest,
  command: CmuxLayoutCommand,
): readonly string[] {
  const errors = [...validateCmuxLayoutCommand(command)];
  if (command.name !== "send") errors.push("not_send_command");
  const targetSurface = optionValue(sendStructuralArgs(command.args), "--surface");
  const owned = Object.values(manifest.surfaces).some((surface) => surface?.surface_id === targetSurface);
  if (!owned) errors.push("surface_not_owned");
  return errors;
}

export function isHolpWorkerSession(value: string | undefined): value is string {
  return typeof value === "string" && /^holp-[A-Za-z0-9_.:-]+$/.test(value);
}

export function parseCmuxSurface(stdout: string): { readonly surfaceId?: string; readonly paneId?: string } {
  return {
    surfaceId: stdout.match(/\bsurface:[A-Za-z0-9_.:-]+/)?.[0],
    paneId: stdout.match(/\bpane:[A-Za-z0-9_.:-]+/)?.[0],
  };
}

function optionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

function sendStructuralArgs(args: readonly string[]): readonly string[] {
  const delimiter = args.indexOf("--");
  return delimiter === -1 ? args : args.slice(0, delimiter);
}
