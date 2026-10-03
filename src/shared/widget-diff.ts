import type { BuiltWidget } from "./widget";
import type { GeneratedCandidate } from "./widget-generation";
/** Compare actual immutable artifacts with the formal version, never model prose. */
export function widgetDifferences(
  before: BuiltWidget | null,
  after: BuiltWidget,
): GeneratedCandidate["differences"] {
  const differences: GeneratedCandidate["differences"] = [];
  if (
    !before ||
    JSON.stringify(before.manifest) !== JSON.stringify(after.manifest)
  )
    differences.push({
      path: "manifest.json",
      before: before ? JSON.stringify(before.manifest, null, 2) : null,
      after: JSON.stringify(after.manifest, null, 2),
      encoding: "utf8",
    });
  const paths = new Set([
    ...Object.keys(before?.resources ?? {}),
    ...Object.keys(after.resources),
  ]);
  for (const path of [...paths].sort()) {
    const a = before?.resources[path],
      b = after.resources[path];
    if (JSON.stringify(a) !== JSON.stringify(b))
      differences.push({
        path,
        before: a?.data ?? null,
        after: b?.data ?? null,
        encoding: "base64",
      });
  }
  return differences;
}
