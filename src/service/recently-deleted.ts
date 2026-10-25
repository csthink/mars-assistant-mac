import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { StoreError } from "./errors";
import { stopGenerationsForWidget } from "./widget-generation";
import { dropPinnedOrder } from "./conversation-order";
import { advanceWidgetOrder, renumberWidgetOrder } from "./widget-order";
import {
  extendedRetention,
  retentionMs,
  type DeletedProject,
  type DeletedWidget,
  type RecentlyDeletedCommand,
  type RecentlyDeletedSnapshot,
  type WidgetPlacement,
} from "../shared/recently-deleted";

/**
 * Version 36. A deleted retained widget leaves `saved_widgets` for `deleted_widgets` with the neighbours it had,
 * so the formal set, the panel projection, the order, the workbench tools and the generation target checks see it
 * gone without per-query filters; its candidate preview turns inactive and keeps configuration, data and usage
 * input for a restore. A deleted project keeps its row: only the organization record changes (PROJECT-03).
 */
export function migrateRecentlyDeleted(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS deleted_widgets(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, candidate_id TEXT NOT NULL REFERENCES generated_candidates(id),
 digest TEXT NOT NULL, revision INTEGER NOT NULL, deleted_at TEXT NOT NULL, retain_until TEXT NOT NULL,
 previous_id TEXT, next_id TEXT, trash_revision INTEGER NOT NULL DEFAULT 0, purged_at TEXT);`);
  // A database already carrying the columns (partly downgraded test data) keeps them as they are.
  const columns = (
    db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]
  ).map((column) => column.name);
  for (const column of ["deleted_at", "retain_until", "purged_at"])
    if (!columns.includes(column))
      db.exec(`ALTER TABLE projects ADD COLUMN ${column} TEXT`);
}

/** Condition on a projects row aliased `p` that is in the organization (not deleted, not purged). */
export const projectListed = "p.deleted_at IS NULL AND p.purged_at IS NULL";

function conflict(message: string): never {
  throw new StoreError("CONFLICT", message);
}
function missing(message: string): never {
  throw new StoreError("NOT_FOUND", message);
}
function unconfirmed(): never {
  throw new StoreError("INVALID_COMMAND", "删除需要单独确认，数据未改变。");
}

/** Generation tasks still running for a draft whose targets include the widget (or whose stop is unconfirmed). */
export function widgetGenerationsInFlight(db: DatabaseSync, widgetId: string) {
  return Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM widget_generation_tasks t JOIN widget_drafts d ON d.id=t.draft_id
         WHERE (t.state IN ('queued','running','stopping') OR t.stop_unconfirmed=1)
         AND (d.widget_id=? OR EXISTS(SELECT 1 FROM json_each(d.target_ids) WHERE value=?))`,
      )
      .get(widgetId, widgetId)!.n,
  );
}
function widgetProtection(db: DatabaseSync, widgetId: string): string | null {
  const n = widgetGenerationsInFlight(db, widgetId);
  return n
    ? `控件仍是 ${n} 个进行中的生成任务的目标。请先停止或等待生成结束，再永久删除。`
    : null;
}
/**
 * Work a project deletion must not hide: Runtime operations of the project's scope whose result is unknown block
 * both an ordinary and a permanent deletion; operations and executions still running block a permanent deletion,
 * because their records must stay reachable through the project for recovery (PROJECT-03).
 */
export function projectOpenWork(
  db: DatabaseSync,
  projectId: string,
): { unknown: number; active: number } {
  const link = db
    .prepare(
      "SELECT instance_id AS instanceId,scope_ref AS scopeRef FROM project_runtime WHERE project_id=?",
    )
    .get(projectId) as { instanceId: string; scopeRef: string } | undefined;
  if (!link) return { unknown: 0, active: 0 };
  const count = (table: string, column: string, states: string[]) =>
    Number(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE instance_id=? AND scope_ref=? AND ${column} IN (SELECT value FROM json_each(?))`,
        )
        .get(link.instanceId, link.scopeRef, JSON.stringify(states))!.n,
    );
  const status = "json_extract(record,'$.status')";
  return {
    unknown:
      count("runtime_operations", status, ["unknown"]) +
      count("runtime_executions", "state", ["unknown"]),
    active:
      count("runtime_operations", status, ["accepted", "running"]) +
      count("runtime_executions", "state", [
        "queued",
        "reserved",
        "running",
        "stopping",
      ]),
  };
}
export function projectProtection(
  db: DatabaseSync,
  projectId: string,
  permanent: boolean,
): string | null {
  const work = projectOpenWork(db, projectId);
  if (work.unknown)
    return `项目有 ${work.unknown} 项工作结果未知。请先查询原请求并核实结果；删除不能成为隐藏未决事项的方式。`;
  if (permanent && work.active)
    return `项目仍有 ${work.active} 项执行中的工作。永久删除前请等待结束或先停止，恢复所需的记录才不会失去项目入口。`;
  return null;
}

export function recentlyDeletedSnapshot(
  db: DatabaseSync,
): RecentlyDeletedSnapshot {
  return {
    projects: (
      db
        .prepare(
          `SELECT p.id,p.name,p.deleted_at AS deletedAt,p.retain_until AS retainUntil,p.revision,
           (SELECT COUNT(*) FROM project_chats pc JOIN conversations c ON c.id=pc.conversation_id
            WHERE pc.project_id=p.id AND c.purged_at IS NULL) AS chatCount
           FROM projects p WHERE p.deleted_at IS NOT NULL AND p.purged_at IS NULL ORDER BY p.retain_until,p.id`,
        )
        .all() as unknown as Omit<DeletedProject, "protection">[]
    ).map((row) => ({
      ...row,
      chatCount: Number(row.chatCount),
      protection: projectProtection(db, row.id, true),
    })),
    widgets: (
      db
        .prepare(
          `SELECT id,name,deleted_at AS deletedAt,retain_until AS retainUntil,trash_revision AS trashRevision,
           previous_id AS previousId,next_id AS nextId FROM deleted_widgets WHERE purged_at IS NULL ORDER BY retain_until,id`,
        )
        .all() as unknown as Omit<DeletedWidget, "protection">[]
    ).map((row) => ({ ...row, protection: widgetProtection(db, row.id) })),
  };
}

function projectEvent(db: DatabaseSync, id: string, kind: string, at: string) {
  const p = db
    .prepare(
      "SELECT name,revision,archived_at AS archivedAt,deleted_at AS deletedAt,retain_until AS retainUntil FROM projects WHERE id=?",
    )
    .get(id)!;
  db.prepare(
    "INSERT INTO project_events(id,project_id,kind,at,snapshot_json) VALUES(?,?,?,?,?)",
  ).run(randomUUID(), id, kind, at, JSON.stringify(p));
}

function deleteWidget(
  db: DatabaseSync,
  c: Extract<RecentlyDeletedCommand, { type: "deleteWidget" }>,
  now: string,
) {
  const w = db.prepare("SELECT * FROM saved_widgets WHERE id=?").get(c.id);
  if (!w) missing("控件已不存在或已删除，未改变。");
  if (Number(w.revision) !== c.revision)
    conflict("控件已在另一入口或另一操作中更新，未删除。请核对后重试。");
  if (!c.confirmed) unconfirmed();
  deleteRetainedWidget(db, c.id, now);
}
/**
 * Moves one retained widget to recently deleted; the menu's confirmed command and the Agent tool both end here.
 * Caller owns the transaction and has resolved the widget.
 */
export function deleteRetainedWidget(
  db: DatabaseSync,
  id: string,
  now: string,
) {
  const c = { id };
  const w = db.prepare("SELECT * FROM saved_widgets WHERE id=?").get(id)!;
  const order = (
    db.prepare("SELECT id FROM saved_widgets ORDER BY position").all() as {
      id: string;
    }[]
  ).map((row) => row.id);
  const at = order.indexOf(c.id);
  // Generation tasks that target the widget are asked to stop; a candidate formed before the deletion, or a
  // late result after it, can never be retained into it.
  stopGenerationsForWidget(db, c.id, now);
  db.prepare(
    `INSERT INTO deleted_widgets(id,name,candidate_id,digest,revision,deleted_at,retain_until,previous_id,next_id)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    c.id,
    String(w.name),
    String(w.candidate_id),
    String(w.digest),
    Number(w.revision),
    now,
    new Date(Date.parse(now) + retentionMs).toISOString(),
    order[at - 1] ?? null,
    order[at + 1] ?? null,
  );
  db.prepare("DELETE FROM saved_widgets WHERE id=?").run(c.id);
  // Views of either entry stop being able to read or write: the instances go and the candidate turns inactive.
  db.prepare("DELETE FROM widget_instances WHERE candidate_id=?").run(
    String(w.candidate_id),
  );
  db.prepare("UPDATE widget_previews SET active=0 WHERE candidate_id=?").run(
    String(w.candidate_id),
  );
  renumberWidgetOrder(
    db,
    order.filter((id) => id !== c.id),
  );
  advanceWidgetOrder(db);
}

function restoreWidget(
  db: DatabaseSync,
  c: { id: string; revision: number },
): WidgetPlacement {
  const d = deletedWidget(db, c.id, c.revision);
  const order = (
    db.prepare("SELECT id FROM saved_widgets ORDER BY position").all() as {
      id: string;
    }[]
  ).map((row) => row.id);
  const previous = d.previous_id ? order.indexOf(String(d.previous_id)) : -1;
  const next = d.next_id ? order.indexOf(String(d.next_id)) : -1;
  const placement: WidgetPlacement =
    previous >= 0 ? "after" : next >= 0 ? "before" : "end";
  const index =
    placement === "after"
      ? previous + 1
      : placement === "before"
        ? next
        : order.length;
  // The revision moves on, so a candidate formed against the widget before its deletion stays refused.
  db.prepare(
    "INSERT INTO saved_widgets(id,name,candidate_id,digest,revision,position) VALUES(?,?,?,?,?,?)",
  ).run(
    c.id,
    String(d.name),
    String(d.candidate_id),
    String(d.digest),
    Number(d.revision) + 1,
    order.length + 1,
  );
  db.prepare("UPDATE widget_previews SET active=1 WHERE candidate_id=?").run(
    String(d.candidate_id),
  );
  db.prepare("DELETE FROM deleted_widgets WHERE id=?").run(c.id);
  order.splice(index, 0, c.id);
  renumberWidgetOrder(db, order);
  advanceWidgetOrder(db);
  return placement;
}
function deletedWidget(db: DatabaseSync, id: string, revision: number) {
  const d = db
    .prepare("SELECT * FROM deleted_widgets WHERE id=? AND purged_at IS NULL")
    .get(id);
  if (!d) missing("最近删除中已没有这个控件。");
  if (Number(d.trash_revision) !== revision)
    conflict("这个控件在最近删除中的状态已变化，请核对后重试。");
  return d;
}
function purgeWidget(
  db: DatabaseSync,
  c: { id: string; revision: number; confirmed: boolean },
  now: string,
) {
  const d = deletedWidget(db, c.id, c.revision);
  if (!c.confirmed) unconfirmed();
  const protection = widgetProtection(db, c.id);
  if (protection) conflict(protection);
  const candidate = String(d.candidate_id);
  // Configuration, data and usage input go; the candidate history, drafts and conversations stay. The row stays
  // as a tombstone so references from drafts and append-only records still resolve to "permanently deleted".
  db.prepare("DELETE FROM widget_config_drafts WHERE candidate_id=?").run(
    candidate,
  );
  db.prepare("DELETE FROM widget_view_state WHERE candidate_id=?").run(
    candidate,
  );
  db.prepare(
    "UPDATE widget_previews SET active=0,config='{}',data='{}',drafts='{}' WHERE candidate_id=?",
  ).run(candidate);
  db.prepare(
    "UPDATE deleted_widgets SET purged_at=?,name='已永久删除的控件',trash_revision=trash_revision+1 WHERE id=?",
  ).run(now, c.id);
}

function deleteProject(
  db: DatabaseSync,
  c: Extract<RecentlyDeletedCommand, { type: "deleteProject" }>,
  now: string,
) {
  const p = db
    .prepare("SELECT revision,deleted_at,purged_at FROM projects WHERE id=?")
    .get(c.id);
  if (!p || p.deleted_at || p.purged_at)
    missing("项目已不存在或已删除，未改变。");
  if (Number(p.revision) !== c.revision)
    conflict("项目已在另一入口更新，未删除。请核对后重试。");
  if (!c.confirmed) unconfirmed();
  const protection = projectProtection(db, c.id, false);
  if (protection) conflict(protection);
  db.prepare(
    "UPDATE projects SET deleted_at=?,retain_until=?,pinned_at=NULL,revision=revision+1,updated_at=? WHERE id=?",
  ).run(now, new Date(Date.parse(now) + retentionMs).toISOString(), now, c.id);
  dropPinnedOrder(db, "project", c.id);
  projectEvent(db, c.id, "deleted", now);
}
function deletedProject(db: DatabaseSync, id: string, revision: number) {
  const p = db
    .prepare(
      "SELECT revision,retain_until FROM projects WHERE id=? AND deleted_at IS NOT NULL AND purged_at IS NULL",
    )
    .get(id);
  if (!p) missing("最近删除中已没有这个项目。");
  if (Number(p.revision) !== revision)
    conflict("这个项目在最近删除中的状态已变化，请核对后重试。");
  return p;
}

/** Applies one command of recently deleted. Caller owns the transaction. */
export function applyRecentlyDeleted(
  db: DatabaseSync,
  c: RecentlyDeletedCommand,
  now: string,
): { restoredWidget?: { id: string; placement: WidgetPlacement } } {
  if (c.type === "deleteWidget") deleteWidget(db, c, now);
  else if (c.type === "deleteProject") deleteProject(db, c, now);
  else if (c.kind === "widget") {
    if (c.type === "restoreDeleted")
      return { restoredWidget: { id: c.id, placement: restoreWidget(db, c) } };
    if (c.type === "extendDeleted") {
      const d = deletedWidget(db, c.id, c.revision);
      db.prepare(
        "UPDATE deleted_widgets SET retain_until=?,trash_revision=trash_revision+1 WHERE id=?",
      ).run(extendedRetention(String(d.retain_until), now), c.id);
    } else purgeWidget(db, c, now);
  } else {
    const p = deletedProject(db, c.id, c.revision);
    if (c.type === "restoreDeleted") {
      // Not pinned again; conversations moved or purged since the deletion are not moved back.
      db.prepare(
        "UPDATE projects SET deleted_at=NULL,retain_until=NULL,revision=revision+1,updated_at=? WHERE id=?",
      ).run(now, c.id);
      projectEvent(db, c.id, "restored", now);
    } else if (c.type === "extendDeleted") {
      db.prepare(
        "UPDATE projects SET retain_until=?,revision=revision+1 WHERE id=?",
      ).run(extendedRetention(String(p.retain_until), now), c.id);
      projectEvent(db, c.id, "retention-extended", now);
    } else {
      if (!c.confirmed) unconfirmed();
      const protection = projectProtection(db, c.id, true);
      if (protection) conflict(protection);
      // Only the organization record goes: conversations, Runtime records, pending items, events, the repository
      // and its files stay. The row remains as a tombstone for the references of append-only records.
      projectEvent(db, c.id, "purged", now);
      db.prepare("DELETE FROM project_runtime WHERE project_id=?").run(c.id);
      db.prepare("DELETE FROM project_order WHERE project_id=?").run(c.id);
      db.prepare("DELETE FROM project_undo WHERE project_id=?").run(c.id);
      db.prepare(
        "UPDATE projects SET purged_at=?,name='已永久删除的项目',goal='',folder_json='null',revision=revision+1,updated_at=? WHERE id=?",
      ).run(now, now, c.id);
    }
  }
  return {};
}
