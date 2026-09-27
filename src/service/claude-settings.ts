import type { DatabaseSync } from "node:sqlite";
import type { ClaudeSettings } from "../shared/claude";
import { StoreError } from "./errors";
export const claudeSettingsSchema = `ALTER TABLE settings ADD COLUMN claude_enabled INTEGER NOT NULL DEFAULT 1 CHECK(claude_enabled IN (0,1));
 ALTER TABLE settings ADD COLUMN claude_path TEXT;
 ALTER TABLE settings ADD COLUMN claude_revision INTEGER NOT NULL DEFAULT 0;`;
export function claudeSettings(db: DatabaseSync): ClaudeSettings {
  const row = db
    .prepare(
      "SELECT claude_enabled AS enabled,claude_path AS path,claude_revision AS revision FROM settings WHERE id=1",
    )
    .get()!;
  return {
    enabled: row.enabled === 1,
    path: row.path == null ? null : String(row.path),
    revision: Number(row.revision),
  };
}
export function setClaudeSettings(db: DatabaseSync, next: ClaudeSettings) {
  const previous = claudeSettings(db);
  if (previous.revision !== next.revision)
    throw new StoreError("CONFLICT", "Claude Code 设置已变化，请重新核对。");
  if (previous.enabled === next.enabled && previous.path === next.path) return;
  if (
    db
      .prepare(
        "SELECT 1 FROM executions e JOIN connections c ON e.connection_id=c.id WHERE c.provider='claude' AND e.state NOT IN ('completed','stopped','failed','interrupted')",
      )
      .get()
  )
    throw new StoreError(
      "CONFLICT",
      "Claude Code 正在执行，请先停止回合或测试再修改设置。",
    );
  db.prepare(
    "UPDATE settings SET claude_enabled=?,claude_path=?,claude_revision=claude_revision+1 WHERE id=1",
  ).run(Number(next.enabled), next.path);
  db.prepare(
    "UPDATE connections SET enabled=?,revision=revision+1,models_json=NULL,models_fetched_at=NULL,models_error=NULL WHERE provider='claude'",
  ).run(Number(next.enabled));
  if (!next.enabled)
    db.exec(
      "UPDATE settings SET default_connection_id=NULL,default_model_id=NULL WHERE default_connection_id IN (SELECT id FROM connections WHERE provider='claude')",
    );
}

export function requireClaudeEnabled(db: DatabaseSync) {
  if (!claudeSettings(db).enabled)
    throw new StoreError(
      "CONFLICT",
      "Claude Code 整合已关闭，请先在设置中启用。",
    );
}
