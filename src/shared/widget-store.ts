import type { WidgetField } from "./widget";
import { widgetKey, validWidgetValue } from "./widget";
import {
  parseWidgetRequest,
  widgetJSON,
  type WidgetIdentity,
  type WidgetRequest,
} from "./widget-runtime";
export interface WidgetDefinition {
  name: string;
  config: WidgetField[];
  draftFields: string[];
  capabilities: string[];
}
export interface WidgetPreview {
  candidateId: string;
  widgetId: string;
  version: string;
  definition: WidgetDefinition;
  config: Record<string, string | number | boolean>;
  configRevision: number;
  configDrafts: Record<
    string,
    { text: string; revision: number; unconfirmed?: boolean }
  >;
  data: Record<string, unknown>;
  dataRevision: number;
  drafts: Record<string, { text: string; revision: number }>;
}
export type WidgetHostCommand =
  | {
      type: "widgetConfigDraft";
      candidateId: string;
      field: string;
      revision: number;
      value: string;
    }
  | {
      type: "widgetCreate";
      candidateId: string;
      widgetId: string;
      version: string;
      definition: WidgetDefinition;
    }
  | { type: "widgetInspect"; candidateId: string }
  | { type: "widgetDiscard"; candidateId: string }
  | { type: "widgetBind"; identity: WidgetIdentity }
  | { type: "widgetRevoke"; generation: string }
  | { type: "widgetRequest"; identity: WidgetIdentity; request: WidgetRequest }
  | {
      type: "widgetConfigure";
      draftRevisions: Record<string, number>;
      candidateId: string;
      revision: number;
      value: Record<string, unknown>;
    };
const id = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const digest = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
function validDefinition(value: unknown): value is WidgetDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value as WidgetDefinition;
  return (
    exact(d as unknown as Record<string, unknown>, [
      "name",
      "config",
      "draftFields",
      "capabilities",
    ]) &&
    typeof d.name === "string" &&
    d.name.length > 0 &&
    d.name.length <= 160 &&
    Array.isArray(d.config) &&
    d.config.length <= 32 &&
    new Set(d.config.map((f) => f?.id)).size === d.config.length &&
    d.config.every(
      (f) =>
        f &&
        exact(f as unknown as Record<string, unknown>, [
          "id",
          "label",
          "type",
          "default",
        ]) &&
        widgetKey(f.id) &&
        typeof f.label === "string" &&
        f.label.length <= 160 &&
        validWidgetValue(f, f.default),
    ) &&
    Array.isArray(d.draftFields) &&
    d.draftFields.length <= 32 &&
    new Set(d.draftFields).size === d.draftFields.length &&
    d.draftFields.every(widgetKey) &&
    Array.isArray(d.capabilities) &&
    d.capabilities.length <= 4 &&
    new Set(d.capabilities).size === d.capabilities.length &&
    d.capabilities.every((c) =>
      ["data.read", "data.write", "draft.write", "config.read"].includes(c),
    )
  );
}
function validIdentity(value: unknown): value is WidgetIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const i = value as WidgetIdentity;
  return (
    exact(i as unknown as Record<string, unknown>, [
      "widgetId",
      "candidateId",
      "version",
      "surface",
      "generation",
    ]) &&
    id(i.widgetId) &&
    id(i.candidateId) &&
    id(i.generation) &&
    digest(i.version) &&
    ["main", "panel"].includes(i.surface)
  );
}
export function validWidgetHostCommand(
  value: unknown,
): value is WidgetHostCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  switch (c.type) {
    case "widgetCreate":
      return (
        exact(c, [
          "type",
          "candidateId",
          "widgetId",
          "version",
          "definition",
        ]) &&
        id(c.candidateId) &&
        id(c.widgetId) &&
        digest(c.version) &&
        validDefinition(c.definition)
      );
    case "widgetInspect":
    case "widgetDiscard":
      return exact(c, ["type", "candidateId"]) && id(c.candidateId);
    case "widgetBind":
      return exact(c, ["type", "identity"]) && validIdentity(c.identity);
    case "widgetRevoke":
      return exact(c, ["type", "generation"]) && id(c.generation);
    case "widgetRequest": {
      if (
        !exact(c, ["type", "identity", "request"]) ||
        !validIdentity(c.identity)
      )
        return false;
      try {
        return !!parseWidgetRequest(JSON.stringify(c.request));
      } catch {
        return false;
      }
    }
    case "widgetConfigDraft":
      return (
        exact(c, ["type", "candidateId", "field", "revision", "value"]) &&
        id(c.candidateId) &&
        widgetKey(c.field) &&
        Number.isSafeInteger(c.revision) &&
        (c.revision as number) >= 0 &&
        typeof c.value === "string" &&
        new TextEncoder().encode(c.value).length <= 4096
      );
    case "widgetConfigure":
      return (
        exact(c, [
          "type",
          "candidateId",
          "revision",
          "value",
          "draftRevisions",
        ]) &&
        !!c.draftRevisions &&
        typeof c.draftRevisions === "object" &&
        !Array.isArray(c.draftRevisions) &&
        Object.entries(c.draftRevisions).every(
          ([key, value]) =>
            widgetKey(key) && Number.isSafeInteger(value) && value >= 0,
        ) &&
        id(c.candidateId) &&
        Number.isSafeInteger(c.revision) &&
        (c.revision as number) >= 0 &&
        !!c.value &&
        typeof c.value === "object" &&
        !Array.isArray(c.value) &&
        widgetJSON(c.value)
      );
    default:
      return false;
  }
}
