import { widgetKey, widgetLimits } from "./widget";

/** Identity is assigned by the host, never accepted from the widget bridge. */
export interface WidgetIdentity {
  widgetId: string;
  candidateId: string;
  version: string;
  surface: "main" | "panel";
  generation: string;
}
export interface WidgetViewState {
  scrollX: number;
  scrollY: number;
  expanded: string[];
  focus: string | null;
}
export function validWidgetViewState(value: unknown): value is WidgetViewState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as WidgetViewState;
  return (
    Object.keys(v).sort().join(",") === "expanded,focus,scrollX,scrollY" &&
    [v.scrollX, v.scrollY].every(
      (n) =>
        typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1_000_000,
    ) &&
    Array.isArray(v.expanded) &&
    v.expanded.length <= 32 &&
    new Set(v.expanded).size === v.expanded.length &&
    v.expanded.every(widgetKey) &&
    (v.focus === null || widgetKey(v.focus))
  );
}
export type WidgetRequest =
  | { method: "readView" }
  | { method: "writeView"; revision: number; value: WidgetViewState }
  | { method: "readData" | "readConfig" | "readDraft" }
  | { method: "writeData"; revision: number; value: Record<string, unknown> }
  | { method: "writeDraft"; revision: number; field: string; value: string };
export type WidgetReply =
  | { ok: true; revision: number; value: Record<string, unknown> }
  | { ok: false; message: string };
export interface WidgetBridge {
  readData(): Promise<WidgetReply>;
  readConfig(): Promise<WidgetReply>;
  readDraft(): Promise<WidgetReply>;
  writeData(
    revision: number,
    value: Record<string, unknown>,
  ): Promise<WidgetReply>;
  writeDraft(
    revision: number,
    field: string,
    value: string,
  ): Promise<WidgetReply>;
}
export const widgetChannel = "widget:request";
export const widgetFailure: WidgetReply = {
  ok: false,
  message: "控件请求已拒绝或实例已关闭。",
};
export const widgetCapabilities = {
  readView: undefined,
  writeView: undefined,
  readData: "data.read",
  writeData: "data.write",
  readConfig: "config.read",
  readDraft: "draft.write",
  writeDraft: "draft.write",
} as const;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Bounded JSON tree; no prototype keys, non-finite numbers or unbounded nesting. */
export function widgetJSON(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 128 &&
    entries.every(
      ([key, child]) =>
        !["__proto__", "prototype", "constructor"].includes(key) &&
        widgetJSON(child, depth + 1),
    )
  );
}
export function parseWidgetRequest(raw: unknown): WidgetRequest | null {
  if (typeof raw !== "string" || raw.length > widgetLimits.stateBytes + 512)
    return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value)) return null;
    const { method } = value;
    if (
      typeof method === "string" &&
      ["readData", "readConfig", "readDraft", "readView"].includes(method)
    )
      return Object.keys(value).length === 1 ? (value as WidgetRequest) : null;
    if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0)
      return null;
    if (
      method === "writeView" &&
      Object.keys(value).length === 3 &&
      validWidgetViewState(value.value)
    )
      return value as WidgetRequest;
    if (
      method === "writeData" &&
      Object.keys(value).length === 3 &&
      record(value.value) &&
      widgetJSON(value.value)
    )
      return value as WidgetRequest;
    if (
      method === "writeDraft" &&
      Object.keys(value).length === 4 &&
      widgetKey(value.field) &&
      typeof value.value === "string" &&
      value.value.length <= 4096
    )
      return value as WidgetRequest;
  } catch {
    /* Invalid serialization is a refusal. */
  }
  return null;
}
export function validWidgetReply(value: unknown): value is WidgetReply {
  if (!record(value)) return false;
  if (value.ok === false)
    return (
      Object.keys(value).length === 2 &&
      typeof value.message === "string" &&
      value.message.length <= 512
    );
  return (
    value.ok === true &&
    Object.keys(value).length === 3 &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    record(value.value) &&
    widgetJSON(value.value) &&
    JSON.stringify(value).length <= widgetLimits.stateBytes
  );
}
