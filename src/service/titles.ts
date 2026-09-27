import type { DatabaseSync } from "node:sqlite";
import { StoreError } from "./errors";

/** Local text extraction only. The saved first user message is the sole input. */
export function automaticTitle(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean) ?? "";
  const cleaned = line
    .replace(/^#{1,6}\s+|^[-*>]\s+/g, "")
    .replace(/\s+/g, " ");
  const sentence = cleaned.split(/[。！？!?]/u)[0].trim() || cleaned;
  return [...sentence].slice(0, 28).join("");
}
export function migrateTitles(db: DatabaseSync) {
  db.exec(`ALTER TABLE conversations ADD COLUMN manual_title TEXT;
    ALTER TABLE conversations ADD COLUMN auto_title TEXT;
    ALTER TABLE conversations ADD COLUMN title_revision INTEGER NOT NULL DEFAULT 0;
    UPDATE conversations SET manual_title=title WHERE title <> '新对话';`);
  for (const row of db.prepare("SELECT id FROM conversations").all())
    updateAutomaticTitle(db, String(row.id));
}
export function updateAutomaticTitle(db: DatabaseSync, id: string) {
  const first = db
    .prepare(
      "SELECT content FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_at,rowid LIMIT 1",
    )
    .get(id);
  if (!first) return;
  const title =
    automaticTitle(String(first.content)) ||
    [...String(first.content).split(/\r?\n/)[0].trim()].slice(0, 28).join("") ||
    "新对话";
  db.prepare(
    "UPDATE conversations SET auto_title=?,title=COALESCE(manual_title,?) WHERE id=? AND auto_title IS NULL",
  ).run(title, title, id);
}
export function renameConversation(
  db: DatabaseSync,
  id: string,
  title: string,
  revision: number,
) {
  const row = db
    .prepare("SELECT title_revision FROM conversations WHERE id=?")
    .get(id);
  if (!row) throw new StoreError("NOT_FOUND", "原对话已不存在，标题未保存。");
  if (row.title_revision !== revision)
    throw new StoreError(
      "CONFLICT",
      "标题已在另一入口修改。当前输入已保留，请核对最新标题后重试。",
    );
  db.prepare(
    "UPDATE conversations SET title=?,manual_title=?,title_revision=title_revision+1,updated_at=? WHERE id=?",
  ).run(title.trim(), title.trim(), new Date().toISOString(), id);
}
