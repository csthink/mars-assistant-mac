import type { DatabaseSync } from "node:sqlite";
import type { CodexSettings } from "../shared/codex";
import { StoreError } from "./errors";
export const codexSettingsSchema = `ALTER TABLE settings ADD COLUMN codex_enabled INTEGER NOT NULL DEFAULT 1 CHECK(codex_enabled IN (0,1));
 ALTER TABLE settings ADD COLUMN codex_path TEXT;
 ALTER TABLE settings ADD COLUMN codex_revision INTEGER NOT NULL DEFAULT 0;
 UPDATE settings SET codex_enabled=0 WHERE EXISTS(SELECT 1 FROM connections WHERE provider='codex' AND enabled=0);`;
export function codexSettings(db: DatabaseSync): CodexSettings {
  const row = db
    .prepare(
      "SELECT codex_enabled AS enabled,codex_path AS path,codex_revision AS revision FROM settings WHERE id=1",
    )
    .get()!;
  return {
    enabled: row.enabled === 1,
    path: row.path == null ? null : String(row.path),
    revision: Number(row.revision),
  };
}
export function requireCodexEnabled(db: DatabaseSync) {
  if (!codexSettings(db).enabled)
    throw new StoreError("CONFLICT", "Codex 整合已关闭，请先在设置中启用。");
}
export function setCodexSettings(db: DatabaseSync, next: CodexSettings) {
  const previous = codexSettings(db);
  if (previous.revision !== next.revision)
    throw new StoreError("CONFLICT", "Codex 设置已变化，请重新核对。");
  if (previous.enabled === next.enabled && previous.path === next.path) return;
  if (
    db
      .prepare(
        "SELECT 1 FROM executions e JOIN connections c ON e.connection_id=c.id WHERE c.provider='codex' AND e.state NOT IN ('completed','stopped','failed','interrupted')",
      )
      .get()
  )
    throw new StoreError(
      "CONFLICT",
      "Codex 正在执行，请先停止回合或测试再修改设置。",
    );
  db.prepare(
    "UPDATE settings SET codex_enabled=?,codex_path=?,codex_revision=codex_revision+1 WHERE id=1",
  ).run(Number(next.enabled), next.path);
  db.prepare(
    "UPDATE connections SET enabled=?,revision=revision+1,models_json=NULL,models_fetched_at=NULL,models_error=NULL WHERE provider='codex'",
  ).run(Number(next.enabled));
  if (!next.enabled)
    db.exec(
      "UPDATE settings SET default_connection_id=NULL,default_model_id=NULL WHERE default_connection_id IN (SELECT id FROM connections WHERE provider='codex')",
    );
}
