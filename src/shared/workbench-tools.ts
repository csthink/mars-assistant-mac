/**
 * Workbench ordering tools of a main-window conversation (WB-02, mac-feature-t11 S-05). The model sees the retained
 * widgets with their identities and the order revision, and moves one widget per call. The product resolves the
 * target: a name matching several widgets is refused with the candidates, an order revision older than the current
 * one is refused, and the result the conversation shows is the business service's committed result.
 */
export const listWidgetsToolName = "list_workbench_widgets";
export const moveWidgetToolName = "move_workbench_widget";
export const deleteWidgetToolName = "delete_workbench_widget";
export const workbenchToolNames = [
  listWidgetsToolName,
  moveWidgetToolName,
  deleteWidgetToolName,
];
export const workbenchTools = [
  {
    name: listWidgetsToolName,
    description:
      "List the retained widgets of the user's workbench in their current order: widgetId, name, 1-based position, a same-name number when several widgets share a name, and the orderRevision a move must quote. Reading changes nothing.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: moveWidgetToolName,
    description:
      "Move one retained widget to a 1-based position, only when the user explicitly asked to reorder that widget. Identify it by widgetId from list_workbench_widgets, or by its exact name. If the user's reference could mean more than one widget, or the target position is unclear, ask the user first; never choose by order. Quote the orderRevision you listed; a stale revision is refused and the user's newer order stays.",
    parameters: {
      type: "object",
      properties: {
        widgetId: { type: "string" },
        name: { type: "string" },
        toPosition: { type: "integer", minimum: 1 },
        orderRevision: { type: "integer", minimum: 0 },
      },
      required: ["toPosition", "orderRevision"],
      additionalProperties: false,
    },
  },
  {
    name: deleteWidgetToolName,
    description:
      "Move one retained widget to Recently Deleted, only when the user explicitly asked to delete that widget. Identify it by widgetId from list_workbench_widgets, or by its exact name. If the user's reference could mean more than one widget, ask the user first; never choose by order. Quote the orderRevision you listed; a stale revision is refused. The user can undo the deletion or restore the widget from Recently Deleted; this never deletes permanently.",
    parameters: {
      type: "object",
      properties: {
        widgetId: { type: "string" },
        name: { type: "string" },
        orderRevision: { type: "integer", minimum: 0 },
      },
      required: ["orderRevision"],
      additionalProperties: false,
    },
  },
] as const;

export type WorkbenchToolArguments =
  | { tool: typeof listWidgetsToolName }
  | {
      tool: typeof deleteWidgetToolName;
      widgetId?: string;
      name?: string;
      orderRevision: number;
    }
  | {
      tool: typeof moveWidgetToolName;
      widgetId?: string;
      name?: string;
      toPosition: number;
      orderRevision: number;
    };
/** Parses a tool call's JSON arguments; anything beyond the declared shape is refused. */
export function parseWorkbenchArguments(
  tool: string,
  text: string,
): WorkbenchToolArguments | null {
  let value: unknown;
  try {
    value = JSON.parse(text || "{}");
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (tool === listWidgetsToolName)
    return Object.keys(v).length === 0 ? { tool } : null;
  const keys = Object.keys(v);
  const reference =
    (v.widgetId === undefined) !== (v.name === undefined) &&
    (v.widgetId === undefined ||
      (typeof v.widgetId === "string" &&
        /^[a-zA-Z0-9-]{1,80}$/.test(v.widgetId))) &&
    (v.name === undefined ||
      (typeof v.name === "string" && !!v.name.trim() && v.name.length <= 160));
  const orderRevision =
    Number.isSafeInteger(v.orderRevision) && Number(v.orderRevision) >= 0;
  if (tool === deleteWidgetToolName)
    return keys.every((k) =>
      ["widgetId", "name", "orderRevision"].includes(k),
    ) &&
      reference &&
      orderRevision
      ? {
          tool,
          ...(v.widgetId !== undefined ? { widgetId: String(v.widgetId) } : {}),
          ...(v.name !== undefined ? { name: String(v.name) } : {}),
          orderRevision: Number(v.orderRevision),
        }
      : null;
  if (tool !== moveWidgetToolName) return null;
  if (
    keys.some(
      (k) => !["widgetId", "name", "toPosition", "orderRevision"].includes(k),
    ) ||
    (v.widgetId === undefined) === (v.name === undefined) ||
    (v.widgetId !== undefined &&
      (typeof v.widgetId !== "string" ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(v.widgetId))) ||
    (v.name !== undefined &&
      (typeof v.name !== "string" || !v.name.trim() || v.name.length > 160)) ||
    !Number.isSafeInteger(v.toPosition) ||
    Number(v.toPosition) < 1 ||
    !Number.isSafeInteger(v.orderRevision) ||
    Number(v.orderRevision) < 0
  )
    return null;
  return {
    tool,
    ...(v.widgetId !== undefined ? { widgetId: String(v.widgetId) } : {}),
    ...(v.name !== undefined ? { name: String(v.name) } : {}),
    toPosition: Number(v.toPosition),
    orderRevision: Number(v.orderRevision),
  };
}

/** One move or deletion an Agent asked for in a conversation turn, as the business service settled it. */
export interface WorkbenchAction {
  id: string;
  conversationId: string;
  turnId: string;
  /** Which tool the Agent called. */
  tool: "move" | "delete";
  status:
    | "moved"
    | "unchanged"
    | "deleted"
    | "ambiguous"
    | "not_found"
    | "stale"
    | "invalid";
  /** The resolved widget, or null when no single widget was resolved. */
  widgetId: string | null;
  widgetName: string | null;
  /** The widget's 1-based position after the move (moved, unchanged). */
  position: number | null;
  /** The name the Agent referred to, when it used a name. */
  reference: string | null;
  /** Widgets the reference could mean (ambiguous). */
  candidates: { widgetId: string; name: string; position: number }[];
  createdAt: string;
}

/** Host command: one workbench tool call of a running conversation turn, sent by the main process. */
export interface WorkbenchToolCommand {
  type: "runWorkbenchTool";
  executionId: string;
  callId: string;
  tool: string;
  arguments: string;
}
export function validWorkbenchToolCommand(
  value: unknown,
): value is WorkbenchToolCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return (
    c.type === "runWorkbenchTool" &&
    Object.keys(c).sort().join(",") ===
      "arguments,callId,executionId,tool,type" &&
    typeof c.executionId === "string" &&
    /^[a-zA-Z0-9-]{1,80}$/.test(c.executionId) &&
    typeof c.callId === "string" &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(c.callId) &&
    typeof c.tool === "string" &&
    c.tool.length <= 80 &&
    typeof c.arguments === "string" &&
    c.arguments.length <= 4096
  );
}
