import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  validInterfacePreferences,
  type Appearance,
  type InterfacePreferences,
} from "../shared/protocol";

const choices: readonly string[] = ["light", "dark", "auto"];

/**
 * The saved appearance as last applied, kept by the shell next to its other local state so that the next
 * start knows it before any window exists and before the business service answers. It only mirrors
 * settings.appearance; the business snapshot stays the authority. A missing, unreadable or unknown value
 * reads as unknown.
 */
export function readAppearanceCache(path: string): Appearance | undefined {
  try {
    const value = readFileSync(path, "utf8").trim();
    return choices.includes(value) ? (value as Appearance) : undefined;
  } catch {
    return undefined;
  }
}

/** Replaces the cached appearance in one step, so a reader never sees a partial value. */
export function writeAppearanceCache(path: string, appearance: Appearance) {
  const next = `${path}.next`;
  writeFileSync(next, appearance, { mode: 0o600 });
  renameSync(next, path);
}

/**
 * The saved interface preferences as last applied, kept next to the appearance so that a new window lays out
 * its columns before the business service answers. Like the appearance it only mirrors the business settings;
 * a missing, unreadable or not exactly valid file reads as unknown.
 */
export function readInterfaceCache(
  path: string,
): InterfacePreferences | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return validInterfacePreferences(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Replaces the cached preferences in one step, so a reader never sees a partial value. */
export function writeInterfaceCache(
  path: string,
  preferences: InterfacePreferences,
) {
  const next = `${path}.next`;
  writeFileSync(
    next,
    JSON.stringify({
      sidebarCollapsed: preferences.sidebarCollapsed,
      rightPanelWidth: preferences.rightPanelWidth,
      pinnedSort: preferences.pinnedSort,
      projectSort: preferences.projectSort,
      pinnedFolded: preferences.pinnedFolded,
      projectsFolded: preferences.projectsFolded,
      recentFolded: preferences.recentFolded,
    }),
    { mode: 0o600 },
  );
  renameSync(next, path);
}
