import { ROLE_SKINS } from "./roleSkins.js";
import { borderLine, createFocusShellTheme, roleBadge, type AnsiOptions, type FocusShellTheme } from "./theme.js";
import type { ChainNode, HarnessInspectModel, HarnessOverviewModel, InspectRow, RoleSkinId } from "./types.js";
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
  readonly kind?: "identity" | "failure" | "provenance" | "content";
}

function prioritizedBody(
  model: FocusShellRenderModel,
  width: number,
  theme: FocusShellTheme,
): readonly BodyLine[] {
  if (model.mode === "inspect") {
    return prioritizedInspectBody(model, width, theme);
  }

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
    { priority: "required", kind: "failure", text: `${theme.chrome(model.labels.failures)} ${failures}` },
    { priority: "required", kind: "provenance", text: `Provenance ${evidence.provenance}: ${evidence.provenance_caveat}` },
    { priority: "normal", text: `Worker session ${evidence.worker_session ?? "unknown"}` },
    { priority: "normal", text: `Attach command ${evidence.attach_command ?? "external"}` },
    { priority: "normal", text: `Owner ${evidence.owner_verified}` },
    { priority: "normal", text: `Artifacts ${evidence.artifact_refs.length > 0 ? evidence.artifact_refs.join(",") : "none"}` },
    { priority: "normal", text: `Terminal ${evidence.terminal?.state ?? "pending"}${evidence.terminal?.reason ? ` reason=${evidence.terminal.reason}` : ""}` },
    { priority: "optional", text: `Anchors run_id direct_user_session model_output.text_delta gate_report` },
    { priority: "optional", text: roleAccentLine(theme) },
    { priority: "optional", text: theme.muted("Controller region is external passthrough; no pane or CLI is spawned.") },
  ];
}

function prioritizedInspectBody(
  model: HarnessInspectModel,
  width: number,
  theme: FocusShellTheme,
): readonly BodyLine[] {
  return [
    { priority: "required", text: `${theme.chrome("Sidecar")} ${modeLabel(model)}` },
    ...inspectLines(model, width),
    { priority: "normal", text: `${theme.chrome(model.labels.chain)} ${chainLine(model.chain, theme)}` },
    { priority: "required", kind: "provenance", text: `Provenance ${model.evidence.provenance}: ${model.evidence.provenance_caveat}` },
    { priority: "optional", text: `Anchors run_id direct_user_session model_output.text_delta gate_report approval_requested approval_resolved approval_expired approval_cancelled attach_command` },
    { priority: "optional", text: roleAccentLine(theme) },
    { priority: "optional", text: theme.muted("Controller region is external passthrough; no pane or CLI is spawned.") },
  ];
}

function selectBodyLines(lines: readonly BodyLine[], height: number): readonly string[] {
  if (height <= 0) return [];
  const required = lines.filter((line) => line.priority === "required");
  const normal = lines.filter((line) => line.priority === "normal");
  const optional = lines.filter((line) => line.priority === "optional");
  const selected = [...required, ...normal, ...optional].slice(0, height);

  const identity = required.find((line) => line.kind === "identity");
  const failure = required.find((line) => line.kind === "failure");
  const provenance = required.find((line) => line.kind === "provenance");
  if (identity && failure && provenance && height <= 3) {
    if (height === 1) return [`${identity.text} | ${failure.text} | ${provenance.text}`];
    if (height === 2) return [`${identity.text} | ${failure.text}`, provenance.text];
    return [identity.text, failure.text, provenance.text];
  }

  preserveKind(selected, identity, "identity", Math.max(0, selected.length - 3));
  preserveKind(selected, failure, "failure", Math.max(0, selected.length - 2));
  preserveKind(selected, provenance, "provenance", Math.max(0, selected.length - 1));

  return selected.map((line) => line.text);
}

function preserveKind(
  selected: BodyLine[],
  requiredLine: BodyLine | undefined,
  kind: NonNullable<BodyLine["kind"]>,
  index: number,
): void {
  if (!requiredLine || selected.some((line) => line.kind === kind)) return;
  if (selected.length === 0) return;
  selected[Math.min(index, selected.length - 1)] = requiredLine;
}

function lineKind(row: InspectRow): BodyLine["kind"] {
  if (row.kind) return row.kind;
  if (row.priority === "identity") return "identity";
  if (row.priority === "critical") return "content";
  return undefined;
}

function bodyLine(
  text: string,
  priority: BodyLine["priority"],
  kind?: BodyLine["kind"],
): BodyLine {
  if (kind) {
    return { text, priority, kind };
  }
  return { text, priority };
}

function inspectLines(model: HarnessInspectModel, width: number): readonly BodyLine[] {
  if (model.empty || !model.selectedAgent) {
    return [bodyLine(`${model.labels.inspectEmpty}: Inspect ${model.selectedAgentId ?? "unknown"}`, "required", "identity")];
  }
  const detail = model.inspect;
  if (!detail) {
    return [
      bodyLine(`Inspect agent=${model.selectedAgent.id} role=${model.selectedAgent.roleSkin}`, "required", "identity"),
      bodyLine(`Inspect status=${model.selectedAgent.status ?? "unknown"} owner=${model.selectedAgent.owner_verified}`, "required", "identity"),
    ];
  }
  return detail.sections.flatMap((section) =>
    section.rows.map((inspectRow) => inspectBodyLine(section.title, inspectRow, width))
  );
}

function inspectBodyLine(sectionTitle: string, row: InspectRow, width: number): BodyLine {
  const value = truncateCell(row.value.replace(/\s+/g, " "), Math.max(8, width - sectionTitle.length - row.label.length - 5));
  return bodyLine(`${sectionTitle} ${row.label}=${value}`, rowPriority(row.priority), lineKind(row));
}

function rowPriority(priority: InspectRow["priority"]): BodyLine["priority"] {
  if (priority === "identity" || priority === "critical") return "required";
  if (priority === "optional") return "optional";
  return "normal";
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
