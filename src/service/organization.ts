import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Command } from "../shared/protocol";
import { StoreError } from "./errors";
import { dropPinnedOrder } from "./conversation-order";

export const conversationActionLabels = {
  pin: "置顶",
  unpin: "取消置顶",
  unread: "标记未读",
  read: "标记已读",
  archive: "归档",
  unarchive: "取消归档",
  delete: "删除",
  restore: "恢复",
  extend: "延长保留",
  purge: "永久删除",
};
export function migrateOrganization(db: DatabaseSync) {
  db.exec(`ALTER TABLE settings ADD COLUMN appearance TEXT NOT NULL DEFAULT 'light' CHECK(appearance IN ('light','dark','auto'));
    ALTER TABLE conversations ADD COLUMN organization_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE conversations ADD COLUMN pinned_at TEXT;
    ALTER TABLE conversations ADD COLUMN unread INTEGER NOT NULL DEFAULT 0 CHECK(unread IN (0,1));
    ALTER TABLE conversations ADD COLUMN archived_at TEXT;
    ALTER TABLE conversations ADD COLUMN deleted_at TEXT;
    ALTER TABLE conversations ADD COLUMN retain_until TEXT;
    ALTER TABLE conversations ADD COLUMN purged_at TEXT;`);
  // Preserve execution identities so append-only events retain their foreign keys.
  const schema = String(
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='executions'",
      )
      .get()!.sql,
  );
  db.exec(
    schema
      .replace(
        /CREATE TABLE ["`]?executions["`]?/,
        "CREATE TABLE executions_v13",
      )
      .replace("'data_migration'", "'data_migration','conversation_action'"),
  );
  db.exec(`INSERT INTO executions_v13 SELECT * FROM executions;
    DROP TABLE executions; ALTER TABLE executions_v13 RENAME TO executions;
    CREATE INDEX executions_turn ON executions(turn_id, attempt);`);
}
export function assertConversationAvailable(db: DatabaseSync, id: string) {
  const row = db
    .prepare("SELECT deleted_at,purged_at FROM conversations WHERE id=?")
    .get(id);
  if (!row || row.deleted_at || row.purged_at)
    throw new StoreError(
      "NOT_FOUND",
      "对话不存在或已删除，请从最近删除恢复后再操作。",
    );
}
function recordAction(
  db: DatabaseSync,
  id: string,
  action: string,
  now: string,
) {
  const execution = randomUUID();
  db.prepare(
    "INSERT INTO executions(id,kind,state,created_at,ended_at) VALUES(?,'conversation_action','completed',?,?)",
  ).run(execution, now, now);
  db.prepare(
    "INSERT INTO run_events(id,execution_id,kind,at,payload) VALUES(?,?,'conversation_changed',?,?)",
  ).run(
    randomUUID(),
    execution,
    now,
    JSON.stringify({ conversationId: id, action }),
  );
}
export function readConversation(db: DatabaseSync, id: string, now: string) {
  const changed = db
    .prepare(
      "UPDATE conversations SET unread=0,organization_revision=organization_revision+1 WHERE id=? AND unread=1 AND deleted_at IS NULL AND purged_at IS NULL",
    )
    .run(id);
  if (changed.changes) recordAction(db, id, "read", now);
}
export function unarchiveOnSubmit(db: DatabaseSync, id: string, now: string) {
  const changed = db
    .prepare(
      // Leaving the archive never pins again: a pin kept from before the archive is cleared as well.
      "UPDATE conversations SET archived_at=NULL,pinned_at=NULL,organization_revision=organization_revision+1 WHERE id=? AND archived_at IS NOT NULL",
    )
    .run(id);
  if (changed.changes) recordAction(db, id, "unarchive", now);
  readConversation(db, id, now);
}
export function organizeConversation(
  db: DatabaseSync,
  command: Extract<Command, { type: "organizeConversation" }>,
  now: string,
) {
  const { id, action, revision, confirmed } = command;
  const row = db
    .prepare(
      "SELECT organization_revision,deleted_at,purged_at,retain_until FROM conversations WHERE id=?",
    )
    .get(id);
  if (!row || row.purged_at)
    throw new StoreError("NOT_FOUND", "对话已不存在。");
  if (row.organization_revision !== revision)
    throw new StoreError(
      "CONFLICT",
      "另一入口已更新对话，请核对最新状态后重试。",
    );
  const trashAction = ["restore", "extend", "purge"].includes(action);
  if (!!row.deleted_at !== trashAction)
    throw new StoreError("CONFLICT", "对话状态已变化，请重新选择操作。");
  if (["delete", "purge"].includes(action) && !confirmed)
    throw new StoreError("INVALID_COMMAND", "删除需要单独确认，数据未改变。");
  if (
    ["delete", "purge"].includes(action) &&
    db
      .prepare(
        "SELECT 1 FROM turns WHERE conversation_id=? AND state NOT IN ('completed','stopped','failed','interrupted')",
      )
      .get(id)
  )
    throw new StoreError(
      "CONFLICT",
      "对话仍有执行中的回合，请先停止并等待确认。",
    );
  const update = (sql: string, ...values: (string | number | null)[]) =>
    db
      .prepare(
        `UPDATE conversations SET ${sql},organization_revision=organization_revision+1 WHERE id=?`,
      )
      .run(...values, id);
  switch (action) {
    case "pin":
      update("pinned_at=?", now);
      break;
    case "unpin":
      update("pinned_at=NULL");
      dropPinnedOrder(db, id);
      break;
    case "unread":
      update("unread=1");
      break;
    case "read":
      update("unread=0");
      break;
    // Archiving or deleting leaves the pinned section; leaving the archive or the trash never pins again.
    case "archive":
      update("archived_at=?,pinned_at=NULL", now);
      dropPinnedOrder(db, id);
      break;
    case "unarchive":
      update("archived_at=NULL,pinned_at=NULL");
      break;
    case "delete": {
      const until = new Date(Date.parse(now) + 30 * 86400000).toISOString();
      update("deleted_at=?,retain_until=?,pinned_at=NULL", now, until);
      dropPinnedOrder(db, id);
      db.prepare(
        "UPDATE selections SET conversation_id=NULL WHERE conversation_id=?",
      ).run(id);
      break;
    }
    case "restore":
      update(
        "deleted_at=NULL,retain_until=NULL,archived_at=NULL,pinned_at=NULL",
      );
      break;
    case "extend":
      update(
        "retain_until=?",
        new Date(
          Math.max(Date.parse(String(row.retain_until)), Date.parse(now)) +
            30 * 86400000,
        ).toISOString(),
      );
      break;
    case "purge": {
      db.prepare(
        "DELETE FROM project_turn_contexts WHERE turn_id IN (SELECT id FROM turns WHERE conversation_id=?)",
      ).run(id);
      db.prepare("DELETE FROM project_chats WHERE conversation_id=?").run(id);
      // Executions and turn identities are retained only to preserve append-only events.
      db.prepare(
        "DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)",
      ).run(id);
      db.prepare("DELETE FROM draft_attachments WHERE conversation_id=?").run(
        id,
      );
      db.prepare("DELETE FROM messages WHERE conversation_id=?").run(id);
      db.prepare(
        "UPDATE turns SET partial_text='' WHERE conversation_id=?",
      ).run(id);
      db.prepare(
        "UPDATE executions SET partial_text='' WHERE turn_id IN (SELECT id FROM turns WHERE conversation_id=?)",
      ).run(id);
      db.prepare(
        "UPDATE pending_items SET state='resolved',resolved_at=? WHERE state='open' AND execution_id IN (SELECT e.id FROM executions e JOIN turns t ON t.id=e.turn_id WHERE t.conversation_id=?)",
      ).run(now, id);
      update(
        "purged_at=?,title='已删除对话',manual_title=NULL,auto_title=NULL,draft='',revision=revision+1,connection_id=NULL,model_id=NULL,granted_connections='[]',granted_providers='[]'",
        now,
      );
      db.prepare("DELETE FROM search_documents WHERE conversation_id=?").run(
        id,
      );
      break;
    }
  }
  recordAction(db, id, action, now);
}
