/** csthink widget package version 1. No package-defined tooling or runtime dependencies. */
export interface WidgetField {
  id: string;
  label: string;
  type: "text" | "number" | "boolean";
  default: string | number | boolean;
}
export interface WidgetPackage {
  schemaVersion: 1;
  name: string;
  view: { html: string; css: string; js: string };
  config: WidgetField[];
  draftFields: string[];
  capabilities: ("data.read" | "data.write" | "draft.write" | "config.read")[];
  resources: { path: string; type: "image/png" | "image/jpeg"; data: string }[];
}
export interface BuiltWidget {
  format: "csthink-widget-build-1";
  digest: string;
  manifest: WidgetPackage;
  resources: Record<string, { type: string; data: string }>;
}
export const widgetLimits = {
  packageBytes: 1_048_576,
  fileBytes: 262_144,
  fields: 32,
  resources: 16,
  stateBytes: 65_536,
  buildMs: 3000,
} as const;
export function widgetKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z][a-z0-9_]{0,47}$/.test(value) &&
    !["constructor", "prototype", "__proto__"].includes(value)
  );
}

/** Freeze the structured clone returned by the fixed parser worker. */
export function freezeWidget<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeWidget(child);
  }
  return value;
}

export function validWidgetValue(field: WidgetField, value: unknown): boolean {
  if (field.type === "text")
    return (
      typeof value === "string" &&
      new TextEncoder().encode(value).length <= 4096 &&
      !value.includes("\u0000")
    );
  if (field.type === "number")
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER
    );
  return field.type === "boolean" && typeof value === "boolean";
}
