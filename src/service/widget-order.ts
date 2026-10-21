import type { DatabaseSync } from "node:sqlite";
import { StoreError } from "./errors";

/**
 * The workbench order of retained widgets (WB-02). `saved_widgets.position` holds the order; the single row of
 * `widget_order` holds its revision. Every order commit rewrites the positions as 1..N in one short transaction and
 * raises the revision, so a request carrying an older revision (a late Agent result, the other entry's stale view)
 * is refused instead of overwriting an order committed after it.
 */
export const widgetOrderSchema = `CREATE TABLE IF NOT EXISTS widget_order(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO widget_order(id,revision) VALUES(1,0);`;

/** Version 35: the order revision; existing positions are renumbered 1..N in their current order. A database that
 * already carries the table (partly downgraded test data) keeps its revision. */
export function migrateWidgetOrder(db: DatabaseSync) {
  db.exec(widgetOrderSchema);
  renumber(
    db,
    (
      db
        .prepare("SELECT id FROM saved_widgets ORDER BY position,rowid")
        .all() as { id: string }[]
    ).map((row) => row.id),
  );
}

export function widgetOrderRevision(db: DatabaseSync): number {
  return Number(
    (
      db.prepare("SELECT revision FROM widget_order WHERE id=1").get() as {
        revision: number;
      }
    ).revision,
  );
}

/** A retained widget joined the end of the order; the order changed. Caller owns the transaction. */
export function advanceWidgetOrder(db: DatabaseSync) {
  db.prepare("UPDATE widget_order SET revision=revision+1 WHERE id=1").run();
}

function renumber(db: DatabaseSync, ids: string[]) {
  const update = db.prepare("UPDATE saved_widgets SET position=? WHERE id=?");
  // Two passes keep any future uniqueness constraint on position satisfied during the rewrite.
  ids.forEach((id, index) => update.run(-(index + 1), id));
  ids.forEach((id, index) => update.run(index + 1, id));
}

/** Moves one retained widget to `toIndex` (0-based) of the current order. Caller owns the transaction. */
export function moveWidget(
  db: DatabaseSync,
  c: { widgetId: string; toIndex: number; orderRevision: number },
) {
  if (widgetOrderRevision(db) !== c.orderRevision)
    throw new StoreError(
      "CONFLICT",
      "控件顺序已在另一入口或另一操作中更新，本次移动未应用，已显示最新顺序。",
    );
  const ids = (
    db.prepare("SELECT id FROM saved_widgets ORDER BY position").all() as {
      id: string;
    }[]
  ).map((row) => row.id);
  const from = ids.indexOf(c.widgetId);
  if (from < 0) throw new StoreError("NOT_FOUND", "控件已不存在，顺序未改变。");
  if (c.toIndex >= ids.length)
    throw new StoreError(
      "INVALID_COMMAND",
      "目标位置超出控件数量，顺序未改变。",
    );
  if (from === c.toIndex) return;
  ids.splice(from, 1);
  ids.splice(c.toIndex, 0, c.widgetId);
  renumber(db, ids);
  advanceWidgetOrder(db);
}
