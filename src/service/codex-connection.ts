import { requireCodexEnabled } from "./codex-settings";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { sameCodexOrigin, type CodexConnection } from "../shared/codex";
import type { EffortRecord } from "../shared/protocol";
import { StoreError } from "./errors";
/** Preserve every existing connection and reference while extending the provider constraint. */
export function migrateCodex(db: DatabaseSync) {
  const original = String(
    db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type='table' AND name='connections'",
      )
      .get()?.sql,
  );
  const providerColumn =
    /\bprovider\s+TEXT\s+NOT\s+NULL(?:\s+CHECK\s*\(provider\s+IN\s*\([^)]*\)\))?(?=\s*,)/i;
  if (!providerColumn.test(original))
    throw new Error("Unexpected connections schema");
  const sql = original
    .replace(
      /^CREATE TABLE ["`]?connections["`]?\s*\(/i,
      "CREATE TABLE connections_codex (",
    )
    .replace(
      providerColumn,
      "provider TEXT NOT NULL CHECK(provider IN ('zhipu','deepseek','openrouter','siliconflow','custom','codex'))",
    );
  if (!sql.startsWith("CREATE TABLE connections_codex"))
    throw new Error("Unexpected connections schema");
  const indexes = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='connections' AND sql IS NOT NULL",
    )
    .all()
    .map((row) => String(row.sql));
  db.exec(sql);
  db.exec(
    "INSERT INTO connections_codex SELECT * FROM connections; DROP TABLE connections; ALTER TABLE connections_codex RENAME TO connections;",
  );
  for (const index of indexes) db.exec(index);
  db.exec("ALTER TABLE connections ADD COLUMN codex_json TEXT;");
}
export function configureCodex(
  db: DatabaseSync,
  model: string,
  configuration: CodexConnection,
  effort: EffortRecord | null = null,
) {
  requireCodexEnabled(db);
  const old = db
    .prepare(
      "SELECT id,model,codex_json FROM connections WHERE provider='codex'",
    )
    .get();
  const json = JSON.stringify(configuration),
    id = old ? String(old.id) : randomUUID(),
    now = new Date().toISOString();
  const existing =
    old &&
    db
      .prepare(
        "SELECT enabled,codex_json FROM connection_models WHERE connection_id=? AND model_id=?",
      )
      .get(id, model);
  if (
    old?.model === model &&
    old.codex_json === json &&
    existing?.enabled === 1 &&
    existing.codex_json === json
  ) {
    db.prepare(
      "UPDATE connection_models SET effort_json=? WHERE connection_id=? AND model_id=?",
    ).run(effort ? JSON.stringify(effort) : null, id, model);
    return;
  }
  if (
    old &&
    db
      .prepare(
        "SELECT 1 FROM executions WHERE connection_id=? AND state NOT IN ('completed','stopped','failed','interrupted')",
      )
      .get(id)
  )
    throw new StoreError(
      "CONFLICT",
      "Codex 正在执行回合，请结束后再更新连接来源。",
    );
  db.prepare(
    `INSERT INTO connections(id,name,provider,base_url,model,secret_ref,enabled,revision,created_at,updated_at,codex_json) VALUES (?,'Codex','codex','',?,NULL,1,0,?,?,?) ON CONFLICT(id) DO UPDATE SET model=excluded.model,codex_json=excluded.codex_json,revision=connections.revision+1,updated_at=excluded.updated_at`,
  ).run(id, model, now, now, json);
  // Model-specific fingerprints differ, but a changed account/provider/rule scope
  // invalidates previously confirmed models rather than borrowing the new origin.
  const previous = old?.codex_json
    ? (JSON.parse(String(old.codex_json)) as CodexConnection)
    : undefined;
  const sameOrigin = previous && sameCodexOrigin(previous, configuration);
  if (!sameOrigin) {
    db.prepare(
      "UPDATE connection_models SET enabled=0,codex_json=NULL,effort_json=NULL,image_input='unknown',image_input_checked_at=NULL WHERE connection_id=?",
    ).run(id);
    db.prepare(
      "UPDATE settings SET default_connection_id=NULL,default_model_id=NULL WHERE default_connection_id=? AND default_model_id<>?",
    ).run(id, model);
  }
  db.prepare(
    "INSERT INTO connection_models(connection_id,model_id,enabled,image_input,codex_json,effort_json) VALUES (?,?,1,'unknown',?,?) ON CONFLICT(connection_id,model_id) DO UPDATE SET enabled=1,codex_json=excluded.codex_json,effort_json=excluded.effort_json",
  ).run(id, model, json, effort ? JSON.stringify(effort) : null);
}

export const codexRunSchema = `CREATE TABLE codex_runs (execution_id TEXT PRIMARY KEY REFERENCES executions(id),run_json TEXT NOT NULL);`;
