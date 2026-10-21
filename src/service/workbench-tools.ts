import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { StoreError } from "./errors";
import { moveWidget, widgetOrderRevision } from "./widget-order";
import { normalizeSearch } from "../shared/search";
import {
  listWidgetsToolName,
  moveWidgetToolName,
  parseWorkbenchArguments,
  type WorkbenchAction,
  type WorkbenchToolCommand,
} from "../shared/workbench-tools";

/** Version 35: the moves an Agent asked for, with the result the business service committed or refused. */
export const workbenchActionSchema = `CREATE TABLE IF NOT EXISTS workbench_actions (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, call_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 turn_id TEXT NOT NULL, status TEXT NOT NULL, widget_id TEXT, widget_name TEXT, position INTEGER,
 reference TEXT, candidates TEXT NOT NULL DEFAULT '[]', result TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(execution_id, call_id));`;

function refuse(message: string): never {
  throw new StoreError("CONFLICT", message);
}

/** The running turn of a non-project conversation the call belongs to. */
function subject(db: DatabaseSync, executionId: string) {
  const row = db
    .prepare(
      `SELECT e.state,t.id AS turnId,t.conversation_id AS conversationId,c.deleted_at AS deletedAt,c.purged_at AS purgedAt,
 (SELECT 1 FROM project_chats WHERE conversation_id=t.conversation_id) AS project
 FROM executions e JOIN turns t ON t.id=e.turn_id JOIN conversations c ON c.id=t.conversation_id
 WHERE e.id=? AND e.kind='turn' AND e.attempt=(SELECT MAX(attempt) FROM executions WHERE turn_id=t.id)`,
    )
    .get(executionId) as
    | {
        state: string;
        turnId: string;
        conversationId: string;
        deletedAt: string | null;
        purgedAt: string | null;
        project: number | null;
      }
    | undefined;
  if (!row || row.state !== "running" || row.deletedAt || row.purgedAt)
    refuse("该回合已结束或已被新的尝试替代，工作台未改变。");
  if (row.project) refuse("项目对话不提供工作台操作，工作台未改变。");
  return row;
}

function widgets(db: DatabaseSync) {
  const rows = db
    .prepare("SELECT id,name FROM saved_widgets ORDER BY position")
    .all() as { id: string; name: string }[];
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const row of rows) {
    const key = normalizeSearch(row.name.trim());
    total.set(key, (total.get(key) ?? 0) + 1);
  }
  return rows.map((row, index) => {
    const key = normalizeSearch(row.name.trim());
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return {
      widgetId: row.id,
      name: row.name,
      position: index + 1,
      sameName: (total.get(key) ?? 0) > 1 ? n : null,
    };
  });
}

/**
 * Runs one workbench tool call of a running conversation turn and returns the text for the model. Moves commit
 * through the same order command as the user's own moves; a refusal (several widgets for one name, no such
 * widget, a stale order revision, a position outside the list) changes nothing and is recorded with its reason.
 * A repeated call identity returns the recorded result without acting again.
 */
export function runWorkbenchTool(
  db: DatabaseSync,
  c: WorkbenchToolCommand,
  now: string,
): { toolText: string } {
  const s = subject(db, c.executionId);
  const args = parseWorkbenchArguments(c.tool, c.arguments);
  if (!args) refuse("工作台工具参数无效，工作台未改变。");
  if (args.tool === listWidgetsToolName)
    return {
      toolText: JSON.stringify({
        status: "listed",
        orderRevision: widgetOrderRevision(db),
        widgets: widgets(db),
      }),
    };
  if (args.tool !== moveWidgetToolName) refuse("未知工具未执行。");
  const prior = db
    .prepare(
      "SELECT result FROM workbench_actions WHERE execution_id=? AND call_id=?",
    )
    .get(c.executionId, c.callId) as { result: string } | undefined;
  if (prior) return { toolText: prior.result };
  const list = widgets(db);
  const reference = args.name ?? null;
  const matches = args.widgetId
    ? list.filter((w) => w.widgetId === args.widgetId)
    : list.filter(
        (w) =>
          normalizeSearch(w.name.trim()) === normalizeSearch(args.name!.trim()),
      );
  let action: Omit<
    WorkbenchAction,
    "id" | "conversationId" | "turnId" | "createdAt"
  >;
  let result: Record<string, unknown>;
  const current = widgetOrderRevision(db);
  if (matches.length > 1) {
    action = {
      status: "ambiguous",
      widgetId: null,
      widgetName: null,
      position: null,
      reference,
      candidates: matches.map(({ widgetId, name, position }) => ({
        widgetId,
        name,
        position,
      })),
    };
    result = {
      status: "ambiguous",
      message:
        "Several widgets have this name. Nothing moved. Ask the user which one they mean; do not choose by order.",
      candidates: action.candidates,
    };
  } else if (!matches.length) {
    action = {
      status: "not_found",
      widgetId: null,
      widgetName: null,
      position: null,
      reference,
      candidates: [],
    };
    result = {
      status: "not_found",
      message: "No retained widget matches. Nothing moved.",
      orderRevision: current,
      widgets: list,
    };
  } else if (args.toPosition > list.length) {
    action = {
      status: "invalid",
      widgetId: matches[0].widgetId,
      widgetName: matches[0].name,
      position: matches[0].position,
      reference,
      candidates: [],
    };
    result = {
      status: "invalid",
      message: `The workbench has ${list.length} widgets; position ${args.toPosition} does not exist. Nothing moved.`,
    };
  } else if (args.orderRevision !== current) {
    action = {
      status: "stale",
      widgetId: matches[0].widgetId,
      widgetName: matches[0].name,
      position: matches[0].position,
      reference,
      candidates: [],
    };
    result = {
      status: "stale",
      message:
        "The order changed after you listed it. Nothing moved. Confirm the move with the user against the current order.",
      orderRevision: current,
      widgets: list,
    };
  } else {
    const target = matches[0];
    moveWidget(db, {
      widgetId: target.widgetId,
      toIndex: args.toPosition - 1,
      orderRevision: current,
    });
    action = {
      status: target.position === args.toPosition ? "unchanged" : "moved",
      widgetId: target.widgetId,
      widgetName: target.name,
      position: args.toPosition,
      reference,
      candidates: [],
    };
    result = {
      status: action.status,
      widgetId: target.widgetId,
      name: target.name,
      position: args.toPosition,
      orderRevision: widgetOrderRevision(db),
    };
  }
  const toolText = JSON.stringify(result);
  db.prepare(
    "INSERT INTO workbench_actions(id,execution_id,call_id,conversation_id,turn_id,status,widget_id,widget_name,position,reference,candidates,result,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    randomUUID(),
    c.executionId,
    c.callId,
    s.conversationId,
    s.turnId,
    action.status,
    action.widgetId,
    action.widgetName,
    action.position,
    action.reference,
    JSON.stringify(action.candidates),
    toolText,
    now,
  );
  return { toolText };
}

export function workbenchActions(db: DatabaseSync): WorkbenchAction[] {
  return db
    .prepare(
      "SELECT id,conversation_id AS conversationId,turn_id AS turnId,status,widget_id AS widgetId,widget_name AS widgetName,position,reference,candidates,created_at AS createdAt FROM workbench_actions ORDER BY created_at,rowid",
    )
    .all()
    .map(
      (row) =>
        ({
          ...row,
          candidates: JSON.parse(String(row.candidates)),
        }) as unknown as WorkbenchAction,
    );
}
