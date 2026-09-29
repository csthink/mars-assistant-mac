/**
 * Column widths of the main window, derived from four constants rather than device breakpoints: the rail is
 * always present, the sidebar is expanded unless the person folded it or an open right column leaves no room
 * for it, the centre keeps at least its minimum width and the right column lives between its minimum and
 * whatever the other columns leave.
 */
export const COLUMN = {
  rail: 56,
  sidebar: 248,
  centerMin: 480,
  rightMin: 320,
  rightDefault: 400,
  rightStep: 24,
} as const;

/** The width at which all four columns fit side by side. */
export const FOUR_COLUMNS =
  COLUMN.rail + COLUMN.sidebar + COLUMN.centerMin + COLUMN.rightMin;

export type SidebarState = "expanded" | "collapsed" | "auto-collapsed";

export interface ColumnInput {
  /** Content width of the window in CSS pixels. */
  width: number;
  /** The person folded the sidebar (a saved preference). */
  sidebarCollapsed: boolean;
  rightOpen: boolean;
  /** The saved right column width; null means the default. */
  rightWidth: number | null;
  takeover: boolean;
}

export interface ColumnLayout {
  rail: number;
  sidebar: SidebarState;
  /** Width the sidebar takes in the row; 0 when folded (an overlay does not take room). */
  sidebarWidth: number;
  center: number;
  right: number;
  rightMin: number;
  rightMax: number;
  /** The right column cannot sit next to the centre, so it only opens by taking over. */
  takeoverOnly: boolean;
  takeover: boolean;
}

export function columnLayout(input: ColumnInput): ColumnLayout {
  const { width, sidebarCollapsed, rightOpen } = input;
  const sidebar: SidebarState = sidebarCollapsed
    ? "collapsed"
    : rightOpen && width < FOUR_COLUMNS
      ? "auto-collapsed"
      : "expanded";
  const sidebarWidth = sidebar === "expanded" ? COLUMN.sidebar : 0;
  const rightMax = width - COLUMN.rail - sidebarWidth - COLUMN.centerMin;
  const takeoverOnly = rightOpen && rightMax < COLUMN.rightMin;
  const takeover = rightOpen && (input.takeover || takeoverOnly);
  const beside = Math.min(
    Math.max(input.rightWidth ?? COLUMN.rightDefault, COLUMN.rightMin),
    rightMax,
  );
  const available = width - COLUMN.rail - sidebarWidth;
  const right = !rightOpen ? 0 : takeover ? available : beside;
  return {
    rail: COLUMN.rail,
    sidebar,
    sidebarWidth,
    center: available - right,
    right,
    rightMin: COLUMN.rightMin,
    rightMax,
    takeoverOnly,
    takeover,
  };
}

/**
 * Whether expanding a folded sidebar has to float it over the centre: the columns cannot sit side by side
 * while the right column is open below the four-column width.
 */
export function expandsAsOverlay({
  width,
  rightOpen,
}: {
  width: number;
  rightOpen: boolean;
}) {
  return rightOpen && width < FOUR_COLUMNS;
}
