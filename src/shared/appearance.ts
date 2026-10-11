/**
 * The native window background of each appearance: the page canvas of the colour tokens
 * (src/renderer/tokens.css), so a window shows the page colour before and while it draws.
 */
export const windowBackground = { light: "#f8f7f4", dark: "#111311" } as const;

/** Isolated widget defaults mirror the semantic card tokens, without changing package CSS. */
export const widgetAppearance = {
  light: {
    surface: "#ffffff",
    text: "#1c1d1b",
    line: "#e3e2dc",
    raised: "#f3f2ee",
    muted: "#686c67",
    accent: "#1e6b4e",
  },
  dark: {
    surface: "#1b1e1b",
    text: "#e7e9e5",
    line: "#2e322e",
    raised: "#232723",
    muted: "#9aa099",
    accent: "#62c095",
  },
} as const;
