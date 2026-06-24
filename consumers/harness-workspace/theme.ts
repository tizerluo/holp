import type { RoleSkinId } from "./types.js";
import { cellWidth, fitCell, truncateCell } from "./width.js";

export interface AnsiOptions {
  readonly ansi?: boolean;
  readonly noAnsi?: boolean;
  readonly isTTY?: boolean;
  readonly env?: Record<string, string | undefined>;
}

export interface FocusShellTheme {
  readonly ansi: boolean;
  readonly box: {
    readonly topLeft: string;
    readonly topRight: string;
    readonly bottomLeft: string;
    readonly bottomRight: string;
    readonly horizontal: string;
    readonly vertical: string;
  };
  readonly role: (role: RoleSkinId, value: string) => string;
  readonly chrome: (value: string) => string;
  readonly muted: (value: string) => string;
  readonly danger: (value: string) => string;
  readonly status: (value: string) => string;
}

const ROLE_SGR: Record<RoleSkinId, string> = {
  CTRL: "36",
  CODE: "32",
  TEST: "33",
  REV: "35",
  ARCH: "38;5;208",
  GATE: "90",
};

export function resolveAnsi(options: AnsiOptions = {}): boolean {
  if (options.noAnsi) return false;
  if (options.env?.NO_COLOR) return false;
  if (typeof options.ansi === "boolean") return options.ansi;
  if (options.isTTY === false) return false;
  return true;
}

export function createFocusShellTheme(options: AnsiOptions = {}): FocusShellTheme {
  const ansi = resolveAnsi(options);
  const style = (code: string, value: string) => ansi ? `\x1b[${code}m${value}\x1b[0m` : value;

  return {
    ansi,
    box: {
      topLeft: "┌",
      topRight: "┐",
      bottomLeft: "└",
      bottomRight: "┘",
      horizontal: "─",
      vertical: "│",
    },
    role: (role, value) => style(ROLE_SGR[role], value),
    chrome: (value) => style("1;37", value),
    muted: (value) => style("2", value),
    danger: (value) => style("31", value),
    status: (value) => style("7", value),
  };
}

export function roleBadge(theme: FocusShellTheme, role: RoleSkinId): string {
  return theme.role(role, `[${role}]`);
}

export function borderLine(
  theme: FocusShellTheme,
  width: number,
  left: string,
  right: string,
  label?: string,
): string {
  if (width <= 0) return "";
  if (width === 1) return fitCell(left, 1);
  const innerWidth = Math.max(0, width - 2);
  const title = label ? truncateCell(` ${label} `, innerWidth, "") : "";
  const titleWidth = Math.min(innerWidth, cellWidth(title));
  const rest = Math.max(0, innerWidth - titleWidth);
  const line = `${left}${title}${theme.box.horizontal.repeat(rest)}${right}`;
  return theme.chrome(fitCell(line, width));
}
