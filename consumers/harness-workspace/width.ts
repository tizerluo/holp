const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const DEFAULT_TRUNCATION_MARKER = "...";

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function cellWidth(value: string): number {
  let width = 0;
  for (const char of stripAnsi(value)) {
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

export function truncateCell(
  value: string,
  maxCells: number,
  marker = DEFAULT_TRUNCATION_MARKER,
): string {
  if (maxCells <= 0) return "";
  if (cellWidth(value) <= maxCells) return value;

  const markerWidth = cellWidth(marker);
  const targetCells = Math.max(0, maxCells - markerWidth);
  let used = 0;
  let output = "";

  for (const char of stripAnsi(value)) {
    const width = codePointWidth(char.codePointAt(0) ?? 0);
    if (used + width > targetCells) break;
    output += char;
    used += width;
  }

  return `${output}${markerWidth <= maxCells ? marker : ""}`;
}

export function padEndCell(value: string, cells: number, fill = " "): string {
  const current = cellWidth(value);
  if (current >= cells) return value;
  return `${value}${fill.repeat(cells - current)}`;
}

export function padStartCell(value: string, cells: number, fill = " "): string {
  const current = cellWidth(value);
  if (current >= cells) return value;
  return `${fill.repeat(cells - current)}${value}`;
}

export function fitCell(value: string, cells: number): string {
  return padEndCell(truncateCell(value, cells), cells);
}

function codePointWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombining(codePoint)) return 0;
  if (isWide(codePoint)) return 2;
  return 1;
}

function isCombining(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
    || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
  );
}
