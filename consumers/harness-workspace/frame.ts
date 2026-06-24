import { ROLE_SKINS } from "./roleSkins.js";
import { borderLine, createFocusShellTheme, roleBadge, type AnsiOptions, type FocusShellTheme } from "./theme.js";
import type { ChainNode, HarnessInspectModel, HarnessOverviewModel, RoleSkinId } from "./types.js";
import { cellWidth, fitCell, padEndCell, truncateCell } from "./width.js";
import { computeFocusShellLayout } from "./layout.js";

export type FocusShellRenderModel = HarnessOverviewModel | HarnessInspectModel;

export interface FocusShellRenderOptions extends AnsiOptions {
  readonly width?: number;
  readonly height?: number;
}

export function renderFocusShell(
  model: FocusShellRenderModel,
  options: FocusShellRenderOptions = {},
): string[] {
  const layout = computeFocusShellLayout({
    cols: options.width ?? 100,
    rows: options.height ?? 28,
  });
  const theme = createFocusShellTheme(options);
  const sidecar = renderSidecar(model, layout.sidecarRegion.width, layout.sidecarRegion.height, theme);
  const prefix = " ".repeat(layout.controllerRegion.width);
  const content = sidecar.map((line) => fitCell(`${prefix}${line}`, layout.cols));
  return [...content, renderStatus(model, layout.statusRegion.width, theme)];
}

function renderSidecar(
  model: FocusShellRenderModel,
  width: number,
  height: number,
  theme: FocusShellTheme,
): string[] {
  if (height <= 0 || width <= 0) return [];
  if (height === 1) return [fitCell(model.evidence.provenance_caveat, width)];
  if (height === 2) {
    return [
      fitCell(model.title, width),
      fitCell(model.evidence.provenance_caveat, width),
    ];
  }

  const innerWidth = Math.max(0, width - 4);
  const innerHeight = Math.max(0, height - 2);
  const body = prioritizedBody(model, innerWidth, theme);
  const selected = selectBodyLines(body, innerHeight);
  const padded = selected.map((line) => innerLine(theme, width, line));

  return [
    borderLine(theme, width, theme.box.topLeft, theme.box.topRight, `${model.title} ${model.mode}`),
    ...padded,
    borderLine(theme, width, theme.box.bottomLeft, theme.box.bottomRight),
  ];
}

interface BodyLine {
  readonly text: string;
  readonly priority: "required" | "normal" | "optional";
}

function prioritizedBody(
  model: FocusShellRenderModel,
  width: number,
  theme: FocusShellTheme,
): readonly BodyLine[] {
  const evidence = model.evidence;
  const latest = evidence.latest_event ?? "pending";
  const gate = evidence.gate;
  const gateLine = [
    gate?.gate_disposition ?? "pending",
    gate?.review_outcome,
    gate?.blocking_reason ? `blocking_reason=${gate.blocking_reason}` : undefined,
  ].filter(Boolean).join(" ");
  const failures = model.failures.length > 0 ? model.failures.join(" | ") : "none";
  const preview = model.workerPreview.renderedText.trim() || "no model_output.text_delta yet";

  return [
    { priority: "required", text: `${theme.chrome("Sidecar")} ${modeLabel(model)}` },
    { priority: "required", text: `${theme.chrome(model.labels.chain)} ${chainLine(model.chain, theme)}` },
    { priority: "required", text: `${theme.chrome(model.labels.workerPreview)} ${truncateCell(preview.replace(/\s+/g, " "), width - 16)}` },
    { priority: "required", text: `${theme.chrome(model.labels.evidence)} run_id=${evidence.run_id ?? "unknown"}` },
    { priority: "required", text: `Runtime ${evidence.runtime_surface ?? "unknown"} | latest_event=${latest}` },
    { priority: "required", text: `Gate gate_report ${gateLine}` },
    { priority: "required", text: `${theme.chrome(model.labels.failures)} ${failures}` },
    { priority: "required", text: `Provenance ${evidence.provenance}: ${evidence.provenance_caveat}` },
    { priority: "normal", text: `Worker session ${evidence.worker_session ?? "unknown"}` },
    { priority: "normal", text: `Attach command ${evidence.attach_command ?? "external"}` },
    { priority: "normal", text: `Owner ${evidence.owner_verified}` },
    { priority: "normal", text: `Artifacts ${evidence.artifact_refs.length > 0 ? evidence.artifact_refs.join(",") : "none"}` },
    { priority: "normal", text: `Terminal ${evidence.terminal?.state ?? "pending"}${evidence.terminal?.reason ? ` reason=${evidence.terminal.reason}` : ""}` },
    ...inspectLines(model),
    { priority: "optional", text: `Anchors run_id direct_user_session model_output.text_delta gate_report` },
    { priority: "optional", text: roleAccentLine(theme) },
    { priority: "optional", text: theme.muted("Controller region is external passthrough; no pane or CLI is spawned.") },
  ];
}

function selectBodyLines(lines: readonly BodyLine[], height: number): readonly string[] {
  if (height <= 0) return [];
  const required = lines.filter((line) => line.priority === "required");
  const normal = lines.filter((line) => line.priority === "normal");
  const optional = lines.filter((line) => line.priority === "optional");
  const selected = [...required, ...normal, ...optional].slice(0, height).map((line) => line.text);

  const provenance = required.find((line) => line.text.startsWith("Provenance "));
  if (provenance && !selected.some((line) => line.startsWith("Provenance "))) {
    selected[Math.max(0, selected.length - 1)] = provenance.text;
  }

  return selected;
}

function inspectLines(model: FocusShellRenderModel): readonly BodyLine[] {
  if (model.mode !== "inspect") return [];
  if (model.empty || !model.selectedAgent) {
    return [{ priority: "normal", text: `${model.labels.inspectEmpty}: Inspect ${model.selectedAgentId ?? "unknown"}` }];
  }
  return [
    { priority: "normal", text: `Inspect agent=${model.selectedAgent.id} role=${model.selectedAgent.roleSkin}` },
    { priority: "normal", text: `Inspect status=${model.selectedAgent.status ?? "unknown"} owner=${model.selectedAgent.owner_verified}` },
  ];
}

function innerLine(theme: FocusShellTheme, width: number, text: string): string {
  const innerWidth = Math.max(0, width - 4);
  const fitted = padEndCell(truncateCell(text, innerWidth), innerWidth);
  return `${theme.chrome(theme.box.vertical)} ${fitted} ${theme.chrome(theme.box.vertical)}`;
}

function renderStatus(
  model: FocusShellRenderModel,
  width: number,
  theme: FocusShellTheme,
): string {
  const status = [
    `run_id=${model.evidence.run_id ?? "unknown"}`,
    `runtime=${model.evidence.runtime_surface ?? "unknown"}`,
    `mode=${model.mode}`,
    "hints=q/esc safe",
    "controller=external",
  ].join("|");
  return theme.status(fitCell(status, width));
}

function modeLabel(model: FocusShellRenderModel): string {
  if (model.mode === "overview") return "Overview";
  return `Inspect ${model.selectedAgentId ?? "unknown"}`;
}

function chainLine(chain: readonly ChainNode[], theme: FocusShellTheme): string {
  return chain
    .map((node) => `${roleBadge(theme, node.skin)} ${node.label}:${node.state}`)
    .join(" -> ");
}

function roleAccentLine(theme: FocusShellTheme): string {
  return (Object.keys(ROLE_SKINS) as RoleSkinId[])
    .map((role) => theme.role(role, role))
    .join(" ");
}

export function visibleFrameWidth(lines: readonly string[]): number {
  return lines.reduce((max, line) => Math.max(max, cellWidth(line)), 0);
}
