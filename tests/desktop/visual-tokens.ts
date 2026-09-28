/**
 * The expected colour table of the user interface, shared by the static token check
 * (visual-tokens.test.ts) and the page probes (visual-tokens.spec.ts).
 *
 * Source: the colour and type table of the accepted four-column prototype (light and dark), with
 * the four contrast adjustments below. The prototype's stage colour only frames its demo outside
 * the window and has no product use, so it is not part of the table.
 */
export type Appearance = "light" | "dark";
export type ColorTable = Record<string, string>;

const prototypeLight: ColorTable = {
  "--c-canvas": "#f8f7f4",
  "--c-sidebar": "#ffffff",
  "--c-surface": "#ffffff",
  "--c-panel": "#ffffff",
  "--c-raised": "#f3f2ee",
  "--c-line": "#e3e2dc",
  "--c-line-soft": "#eeede8",
  "--c-line-strong": "#d6d5ce",
  "--c-hover": "#1c1d1a0a",
  "--c-selected": "#e4efe8",
  "--c-text": "#1c1d1b",
  "--c-muted": "#6c706a",
  "--c-accent": "#1e6b4e",
  "--c-accent-strong": "#175a41",
  "--c-accent-soft": "#e4efe8",
  "--c-accent-edge": "#b8d4c4",
  "--c-on-accent": "#ffffff",
  "--c-primary-bg": "#1e6b4e",
  "--c-primary-border": "#1e6b4e",
  "--c-secondary-bg": "#ffffff",
  "--c-green": "#2c7a55",
  "--c-green-bg": "#e4f0e9",
  "--c-amber": "#8f5d0c",
  "--c-amber-bg": "#f6ecd7",
  "--c-amber-edge": "#dcb872",
  "--c-amber-badge": "#efc16a",
  "--c-on-amber": "#2f2104",
  "--c-red": "#b83a2a",
  "--c-red-bg": "#f7e2dd",
  "--c-on-danger": "#ffffff",
  "--c-ink": "#171917",
  "--c-on-ink": "#ffffff",
  "--c-dots": "#d7d6cf",
  "--c-scrim": "#1c1d1b33",
  "--c-shadow": "0 18px 60px #1c1d1b1f",
  "--c-shadow-sm": "0 6px 24px #1c1d1b14",
  "--c-shadow-card": "0 1px 2px #1c1d1b0d, 0 2px 10px #1c1d1b08",
};

const prototypeDark: ColorTable = {
  "--c-canvas": "#111311",
  "--c-sidebar": "#161816",
  "--c-surface": "#1b1e1b",
  "--c-panel": "#181a18",
  "--c-raised": "#232723",
  "--c-line": "#2e322e",
  "--c-line-soft": "#262926",
  "--c-line-strong": "#3a3f3a",
  "--c-hover": "#ffffff0d",
  "--c-selected": "#1f3a2d",
  "--c-text": "#e7e9e5",
  "--c-muted": "#9aa099",
  "--c-accent": "#62c095",
  "--c-accent-strong": "#7fd0aa",
  "--c-accent-soft": "#1f3a2d",
  "--c-accent-edge": "#2f5f47",
  "--c-on-accent": "#ffffff",
  "--c-primary-bg": "#2a7d58",
  "--c-primary-border": "#2a7d58",
  "--c-secondary-bg": "#1b1e1b",
  "--c-green": "#6cc79a",
  "--c-green-bg": "#1b3326",
  "--c-amber": "#e2b45c",
  "--c-amber-bg": "#3a2e17",
  "--c-amber-edge": "#7b5d22",
  "--c-amber-badge": "#e2b45c",
  "--c-on-amber": "#1f1604",
  "--c-red": "#f0806f",
  "--c-red-bg": "#3e221d",
  "--c-on-danger": "#ffffff",
  "--c-ink": "#e7e9e5",
  "--c-on-ink": "#111311",
  "--c-dots": "#2a2e2a",
  "--c-scrim": "#000000a6",
  "--c-shadow": "0 18px 60px #0009",
  "--c-shadow-sm": "0 6px 24px #0006",
  "--c-shadow-card": "0 1px 2px #0006",
};

/**
 * The only departures from the prototype table: text on these colours stays at or above 4.5:1
 * (WCAG 2 relative luminance). Dark: white on the primary hover colour 4.52:1, dark text on the
 * solid danger colour 7.13:1. Light: success text on its tint 4.58:1 and on the selection tint
 * 4.55:1, secondary text on the selection tint 4.53:1.
 */
export const contrastAdjustments: Record<Appearance, ColorTable> = {
  light: { "--c-green": "#2b7854", "--c-muted": "#686c67" },
  dark: { "--c-accent-strong": "#31855e", "--c-on-danger": "#111311" },
};

export const expectedColors: Record<Appearance, ColorTable> = {
  light: { ...prototypeLight, ...contrastAdjustments.light },
  dark: { ...prototypeDark, ...contrastAdjustments.dark },
};

/** The type of the prototype: 14px/1.6 in the system font with PingFang SC for Chinese. */
export const expectedFont = {
  size: "14px",
  lineHeight: "1.6",
  family: [
    "-apple-system",
    "BlinkMacSystemFont",
    '"PingFang SC"',
    "sans-serif",
  ],
};

/** "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa" to the rgb()/rgba() string getComputedStyle returns. */
export function computedColor(hex: string) {
  const digits = hex.slice(1);
  const full =
    digits.length <= 4
      ? [...digits].map((d) => d + d).join("")
      : digits.padEnd(6, "0");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  if (full.length === 6) return `rgb(${r}, ${g}, ${b})`;
  const alpha = parseInt(full.slice(6, 8), 16) / 255;
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
}
