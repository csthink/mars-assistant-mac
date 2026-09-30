import type { DatabaseSync } from "node:sqlite";
import type { Command, PinnedRef, Surface } from "../shared/protocol";
import { StoreError } from "./errors";

/**
 * Schema version 27: the creation time of each conversation and the manual order of the pinned section.
 *
 * - conversations.created_at is written by an insert trigger for every new row, whichever path inserts it.
 *   Rows that existed before keep NULL: their creation time was never recorded and is not inferred from
 *   activity, so the recent list shows them under "date not available".
 * - pinned_order keeps the manual order of the pinned section. The section mixes projects and conversations,
 *   so one table holds the order of both kinds; pinned objects missing from it come first, newest pin first.
 *
 * Every step checks what already exists, so a partly migrated database (for example test data taken back to
 * an older version) migrates again without failing. The caller runs this inside the migration transaction.
 */
export function migrateConversationOrder(db: DatabaseSync) {
  const columns = db.prepare("PRAGMA table_info(conversations)").all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === "created_at"))
    db.exec("ALTER TABLE conversations ADD COLUMN created_at TEXT");
  db.exec(`CREATE TRIGGER IF NOT EXISTS conversation_created_at AFTER INSERT ON conversations
      WHEN NEW.created_at IS NULL
      BEGIN
        UPDATE conversations SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id;
      END;
    CREATE TABLE IF NOT EXISTS pinned_order (
      kind TEXT NOT NULL CHECK(kind IN ('conversation','project')),
      id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY(kind,id)
    );`);
}

/** Conversations shown in the pinned section: pinned, not archived and not deleted. */
const pinnedConversations =
  "SELECT id FROM conversations WHERE pinned_at IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL AND purged_at IS NULL";

/** The manual order as saved, first to last, limited to objects that are still in the pinned section. */
export function pinnedOrder(db: DatabaseSync): PinnedRef[] {
  return (
    db
      .prepare(
        `SELECT kind, id FROM pinned_order WHERE
          (kind='conversation' AND id IN (${pinnedConversations})) OR
          (kind='project' AND id IN (SELECT id FROM projects WHERE pinned_at IS NOT NULL AND archived_at IS NULL))
          ORDER BY position`,
      )
      .all() as unknown as PinnedRef[]
  ).map((row) => ({ kind: row.kind, id: row.id }));
}

/** Removes a conversation from the manual order (unpinned, archived, deleted or purged). */
export function dropPinnedOrder(
  db: DatabaseSync,
  kind: PinnedRef["kind"],
  id: string,
) {
  db.prepare("DELETE FROM pinned_order WHERE kind=? AND id=?").run(kind, id);
}

/**
 * The manual display order: objects missing from the saved order first, newest pin first, then the saved
 * order. The same rule the sidebar applies, so a move always starts from what the person sees.
 */
function displayedOrder(db: DatabaseSync): PinnedRef[] {
  const saved = pinnedOrder(db);
  const key = (ref: PinnedRef) => `${ref.kind}:${ref.id}`;
  const known = new Set(saved.map(key));
  const missing = (
    db
      .prepare(
        `SELECT kind,id FROM (
          SELECT 'conversation' AS kind,id,pinned_at AS pinnedAt FROM conversations WHERE id IN (${pinnedConversations})
          UNION ALL
          SELECT 'project' AS kind,id,pinned_at AS pinnedAt FROM projects WHERE pinned_at IS NOT NULL AND archived_at IS NULL
        ) ORDER BY pinnedAt DESC,kind,id`,
      )
      .all() as unknown as PinnedRef[]
  ).filter((ref) => !known.has(key(ref)));
  return [...missing, ...saved];
}

/**
 * Moves a pinned conversation before another pinned conversation, or to the end. Only the display order
 * changes: the pin time stays. The whole order is written again with consecutive positions.
 */
export function movePinned(
  db: DatabaseSync,
  command: Extract<Command, { type: "movePinned" }>,
) {
  const row = db
    .prepare(
      command.kind === "conversation"
        ? "SELECT organization_revision AS revision, pinned_at AS pinnedAt, archived_at AS archivedAt, deleted_at AS deletedAt, purged_at AS purgedAt FROM conversations WHERE id=?"
        : "SELECT revision,pinned_at AS pinnedAt,archived_at AS archivedAt,NULL AS deletedAt,NULL AS purgedAt FROM projects WHERE id=?",
    )
    .get(command.id) as
    | {
        revision: number;
        pinnedAt: string | null;
        archivedAt: string | null;
        deletedAt: string | null;
        purgedAt: string | null;
      }
    | undefined;
  if (!row || row.purgedAt || row.deletedAt)
    throw new StoreError("NOT_FOUND", "对象不存在或已删除，顺序未改变。");
  if (row.revision !== command.revision)
    throw new StoreError(
      "CONFLICT",
      "另一入口已更新对象，请核对最新状态后重试。顺序未改变。",
    );
  if (!row.pinnedAt || row.archivedAt)
    throw new StoreError("CONFLICT", "对象已不在已置顶中，顺序未改变。");
  const order = displayedOrder(db).filter(
    (ref) => ref.id !== command.id || ref.kind !== command.kind,
  );
  let index = order.length;
  if (command.before) {
    index = order.findIndex(
      (ref) =>
        ref.id === command.before!.id && ref.kind === command.before!.kind,
    );
    if (index < 0)
      throw new StoreError("CONFLICT", "目标对象已不在已置顶中，顺序未改变。");
  }
  order.splice(index, 0, { kind: command.kind, id: command.id });
  db.exec("DELETE FROM pinned_order");
  const insert = db.prepare(
    "INSERT INTO pinned_order(kind,id,position) VALUES(?,?,?)",
  );
  order.forEach((ref, position) => insert.run(ref.kind, ref.id, position));
  db.prepare(
    command.kind === "conversation"
      ? "UPDATE conversations SET organization_revision=organization_revision+1 WHERE id=?"
      : "UPDATE projects SET revision=revision+1 WHERE id=?",
  ).run(command.id);
}

/**
 * A conversation not yet used: no messages or turns, no draft text, no draft attachments, no project, no own
 * name, not pinned, not archived and not deleted. It stands for the new-conversation page.
 */
export const unusedCondition = `c.archived_at IS NULL AND c.deleted_at IS NULL AND c.purged_at IS NULL
  AND c.pinned_at IS NULL AND c.manual_title IS NULL AND trim(c.draft)=''
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id)
  AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.conversation_id=c.id)
  AND NOT EXISTS (SELECT 1 FROM draft_attachments d WHERE d.conversation_id=c.id)
  AND NOT EXISTS (SELECT 1 FROM project_chats p WHERE p.conversation_id=c.id)`;

/**
 * Starts a new conversation: an unused conversation that the other surface is not showing is selected again;
 * only when there is none is a new one created with the requested identity.
 */
export function newConversation(
  db: DatabaseSync,
  id: string,
  surface: Surface,
  now: string,
) {
  const reuse = db
    .prepare(
      `SELECT c.id FROM conversations c WHERE ${unusedCondition}
        AND c.id NOT IN (SELECT conversation_id FROM selections WHERE surface<>? AND conversation_id IS NOT NULL)
        ORDER BY c.creation_order DESC LIMIT 1`,
    )
    .get(surface) as { id: string } | undefined;
  if (!reuse) {
    if (db.prepare("SELECT 1 FROM conversations WHERE id=?").get(id))
      throw new StoreError("CONFLICT", "对话身份已被使用，请重试。");
    db.prepare(
      "INSERT INTO conversations (id,title,updated_at,created_at) VALUES (?,'新对话',?,?)",
    ).run(id, now, now);
  }
  db.prepare("UPDATE selections SET conversation_id=? WHERE surface=?").run(
    reuse?.id ?? id,
    surface,
  );
}
