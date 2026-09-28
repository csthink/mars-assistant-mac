import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Appearance } from "../shared/protocol";

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
