import { claudeSettingsSchema, requireClaudeEnabled } from "./claude-settings";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { sameClaudeOrigin, type ClaudeConnection } from "../shared/claude";
import { StoreError } from "./errors";
import type { EffortRecord } from "../shared/protocol";
/** Preserve every existing connection and reference while extending the provider constraint. */
export function migrateClaude(db: DatabaseSync) {
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
      "CREATE TABLE connections_claude (",
    )
    .replace(
      providerColumn,
      "provider TEXT NOT NULL CHECK(provider IN ('zhipu','deepseek','openrouter','siliconflow','custom','codex','claude'))",
    );
  if (!sql.startsWith("CREATE TABLE connections_claude"))
    throw new Error("Unexpected connections schema");
  const indexes = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='connections' AND sql IS NOT NULL",
    )
    .all()
    .map((row) => String(row.sql));
  db.exec(sql);
  db.exec(
    "INSERT INTO connections_claude SELECT * FROM connections; DROP TABLE connections; ALTER TABLE connections_claude RENAME TO connections;",
  );
  for (const index of indexes) db.exec(index);
  db.exec(
    "ALTER TABLE connections ADD COLUMN claude_json TEXT; ALTER TABLE connection_models ADD COLUMN claude_json TEXT;",
  );
  db.exec(claudeSettingsSchema);
  db.exec(claudeRunSchema);
}
export function configureClaude(
  db: DatabaseSync,
  model: string,
  configuration: ClaudeConnection,
  effort: EffortRecord | null = null,
) {
  requireClaudeEnabled(db);
  const old = db
    .prepare(
      "SELECT id,model,claude_json FROM connections WHERE provider='claude'",
    )
    .get();
  const json = JSON.stringify(configuration),
    id = old ? String(old.id) : randomUUID(),
    now = new Date().toISOString();
  const existing =
    old &&
    db
      .prepare(
        "SELECT enabled,claude_json FROM connection_models WHERE connection_id=? AND model_id=?",
      )
      .get(id, model);
  if (
    old?.model === model &&
    old.claude_json === json &&
    existing?.enabled === 1 &&
    existing.claude_json === json
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
      "Claude 正在执行回合，请结束后再更新连接来源。",
    );
  db.prepare(
    `INSERT INTO connections(id,name,provider,base_url,model,secret_ref,enabled,revision,created_at,updated_at,claude_json) VALUES (?,'Claude Code','claude','',?,NULL,1,0,?,?,?) ON CONFLICT(id) DO UPDATE SET model=excluded.model,claude_json=excluded.claude_json,revision=connections.revision+1,updated_at=excluded.updated_at`,
  ).run(id, model, now, now, json);
  // Model-specific fingerprints differ, but a changed account/provider/rule scope
  // invalidates previously confirmed models rather than borrowing the new origin.
  const previous = old?.claude_json
    ? (JSON.parse(String(old.claude_json)) as ClaudeConnection)
    : undefined;
  const sameOrigin = previous && sameClaudeOrigin(previous, configuration);
  if (!sameOrigin) {
    db.prepare(
      "UPDATE connection_models SET enabled=0,claude_json=NULL,effort_json=NULL,image_input='unknown',image_input_checked_at=NULL WHERE connection_id=?",
    ).run(id);
    db.prepare(
      "UPDATE settings SET default_connection_id=NULL,default_model_id=NULL WHERE default_connection_id=? AND default_model_id<>?",
    ).run(id, model);
  }
  db.prepare(
    "INSERT INTO connection_models(connection_id,model_id,enabled,image_input,claude_json,effort_json) VALUES (?,?,1,'unknown',?,?) ON CONFLICT(connection_id,model_id) DO UPDATE SET enabled=1,claude_json=excluded.claude_json,effort_json=excluded.effort_json",
  ).run(id, model, json, effort ? JSON.stringify(effort) : null);
}

export const claudeRunSchema = `CREATE TABLE claude_runs (execution_id TEXT PRIMARY KEY REFERENCES executions(id),run_json TEXT NOT NULL);`;
