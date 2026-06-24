export interface FocusShellLayoutInput {
  readonly cols: number;
  readonly rows: number;
}

export interface FocusShellRegion {
  readonly name: "controller" | "sidecar" | "status";
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly external?: boolean;
}

export interface FocusShellLayout {
  readonly cols: number;
  readonly rows: number;
  readonly controllerRegion: FocusShellRegion & { readonly name: "controller"; readonly external: true };
  readonly sidecarRegion: FocusShellRegion & { readonly name: "sidecar" };
  readonly statusRegion: FocusShellRegion & { readonly name: "status" };
}

export function computeFocusShellLayout(input: FocusShellLayoutInput): FocusShellLayout {
  const cols = normalizeDimension(input.cols, 240);
  const rows = normalizeDimension(input.rows, 80);
  const statusHeight = 1;
  const contentHeight = Math.max(0, rows - statusHeight);
  const sidecarWidth = computeSidecarWidth(cols);
  const controllerWidth = Math.max(0, cols - sidecarWidth);

  return {
    cols,
    rows,
    controllerRegion: {
      name: "controller",
      left: 0,
      top: 0,
      width: controllerWidth,
      height: contentHeight,
      external: true,
    },
    sidecarRegion: {
      name: "sidecar",
      left: controllerWidth,
      top: 0,
      width: sidecarWidth,
      height: contentHeight,
    },
    statusRegion: {
      name: "status",
      left: 0,
      top: contentHeight,
      width: cols,
      height: statusHeight,
    },
  };
}

function computeSidecarWidth(cols: number): number {
  if (cols < 56) return cols;
  const target = Math.floor(cols * 0.72);
  return Math.min(Math.max(48, target), Math.max(48, cols - 20));
}

function normalizeDimension(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(max, Math.max(1, Math.floor(value)));
}
