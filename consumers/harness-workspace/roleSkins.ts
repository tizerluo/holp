import type { RoleSkinId } from "./types.js";

export interface RoleSkin {
  readonly id: RoleSkinId;
  readonly accent: string;
  readonly badge: string;
  readonly description: string;
}

export const ROLE_SKINS: Record<RoleSkinId, RoleSkin> = {
  CTRL: { id: "CTRL", accent: "cyan", badge: "CTRL", description: "controller visual skin" },
  CODE: { id: "CODE", accent: "green", badge: "CODE", description: "coder visual skin" },
  TEST: { id: "TEST", accent: "amber", badge: "TEST", description: "tester visual skin" },
  REV: { id: "REV", accent: "purple", badge: "REV", description: "reviewer visual skin" },
  ARCH: { id: "ARCH", accent: "orange", badge: "ARCH", description: "architect visual skin" },
  GATE: { id: "GATE", accent: "gray", badge: "GATE", description: "gate visual skin" },
};

export function roleSkinFor(value: string | undefined): RoleSkinId {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("test")) return "TEST";
  if (normalized.includes("review")) return "REV";
  if (normalized.includes("arch")) return "ARCH";
  if (normalized.includes("gate")) return "GATE";
  if (normalized.includes("controller") || normalized.includes("ctrl")) return "CTRL";
  return "CODE";
}
