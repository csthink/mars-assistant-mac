import { isAbsolute } from "node:path";

export const widgetRealProviders = [
  "codex",
  "claude",
  "zhipu",
  "deepseek",
  "openrouter",
  "siliconflow",
] as const;
type Provider = (typeof widgetRealProviders)[number];
export interface WidgetRealAuthorization {
  task: "mac-feature-t9";
  authorized: true;
  maxTurns: number;
  root: string;
  evidence: string;
  selections: Array<{
    provider: Provider;
    connectionId: string;
    model: string;
  }>;
  deferredProviders: Provider[];
}
/** Validate a complete classification before any client, model input or evidence write. */
export function widgetRealAuthorization(
  value: unknown,
  executionEnabled: string | undefined,
): WidgetRealAuthorization {
  const fail = () => {
    throw new Error(
      "NOT RUN: invalid explicit provider scope or exact turn budget",
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const a = value as Partial<WidgetRealAuthorization>;
  if (
    executionEnabled !== "1" ||
    a.task !== "mac-feature-t9" ||
    a.authorized !== true ||
    typeof a.root !== "string" ||
    !isAbsolute(a.root) ||
    typeof a.evidence !== "string" ||
    !isAbsolute(a.evidence) ||
    a.root === a.evidence ||
    !Array.isArray(a.selections) ||
    !a.selections.length ||
    !Array.isArray(a.deferredProviders) ||
    a.maxTurns !== a.selections.length * 6 ||
    a.selections.some(
      (s) =>
        !s ||
        typeof s !== "object" ||
        !widgetRealProviders.includes(s.provider) ||
        typeof s.connectionId !== "string" ||
        !s.connectionId.trim() ||
        typeof s.model !== "string" ||
        !s.model.trim(),
    )
  )
    return fail();
  const all = [...a.selections.map((s) => s.provider), ...a.deferredProviders];
  if (
    all.length !== widgetRealProviders.length ||
    new Set(all).size !== all.length ||
    all.some((p) => !widgetRealProviders.includes(p))
  )
    return fail();
  return a as WidgetRealAuthorization;
}
