import type { HarnessWorkspaceLocale } from "./types.js";

const CATALOG = {
  "en-US": {
    titleOverview: "HOLP Harness Workspace",
    titleInspect: "Inspect agent",
    chain: "Chain",
    workerPreview: "Worker preview",
    evidence: "Evidence",
    failures: "Failures",
    unknown: "unknown",
    ownerVerified: "owner verified",
    ownerUnverified: "owner unverified",
    provenanceUnknown: "Provenance unknown; no real-usage or runtime-readiness claim is inferred.",
    provenanceSmoke: "Smoke-script provenance; treat as scripted evidence, not user validation.",
    failureRunBlocked: "Run blocked",
    failureRunGaveUp: "Run gave up",
    failureRunCancelled: "Run cancelled",
    failureConsensusDegraded: "Consensus degraded",
    failureGateBlocking: "Gate blocking",
    failureApprovalExpired: "Approval expired",
    failureApprovalCancelled: "Approval cancelled",
    inspectEmpty: "No selected agent evidence",
  },
  "zh-CN": {
    titleOverview: "HOLP Harness Workspace",
    titleInspect: "检查 agent",
    chain: "链路",
    workerPreview: "Worker 预览",
    evidence: "证据",
    failures: "失败",
    unknown: "unknown",
    ownerVerified: "owner verified",
    ownerUnverified: "owner unverified",
    provenanceUnknown: "来源 unknown；不推断真实使用或运行就绪声明。",
    provenanceSmoke: "来源 smoke_script；这是脚本证据，不是用户验证。",
    failureRunBlocked: "Run blocked",
    failureRunGaveUp: "Run gave up",
    failureRunCancelled: "Run cancelled",
    failureConsensusDegraded: "Consensus degraded",
    failureGateBlocking: "Gate blocking",
    failureApprovalExpired: "Approval expired",
    failureApprovalCancelled: "Approval cancelled",
    inspectEmpty: "没有选中 agent 证据",
  },
} as const satisfies Record<HarnessWorkspaceLocale, Record<string, string>>;

export type MessageKey = keyof (typeof CATALOG)["en-US"];

export function t(locale: HarnessWorkspaceLocale, key: MessageKey): string {
  return CATALOG[locale]?.[key] ?? CATALOG["en-US"][key];
}
