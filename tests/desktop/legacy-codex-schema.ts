import type { DatabaseSync } from "node:sqlite";
/** Test-only reverse fixture construction: restore the exact pre-Codex table shape before testing old migrations. */
export function restorePreCodexFixture(db: DatabaseSync) {
  restorePreClaudeFixture(db);
  db.exec(
    "PRAGMA foreign_keys=OFF; ALTER TABLE connection_models DROP COLUMN codex_json; ALTER TABLE settings DROP COLUMN codex_enabled; ALTER TABLE settings DROP COLUMN codex_path; ALTER TABLE settings DROP COLUMN codex_revision; DROP TABLE codex_runs; ALTER TABLE connections DROP COLUMN codex_json;",
  );
  const original = String(
    db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type='table' AND name='connections'",
      )
      .get()?.sql,
  );
  const indexes = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='connections' AND sql IS NOT NULL",
    )
    .all()
    .map((row) => String(row.sql));
  const sql = original
    .replace(
      /^CREATE TABLE ["`]?connections["`]?\s*\(/i,
      "CREATE TABLE connections_legacy (",
    )
    .replace(",'codex'", "")
    .replace(",'claude'", "");
  if (
    !sql.startsWith("CREATE TABLE connections_legacy") ||
    sql.includes("'codex'")
  )
    throw new Error("Invalid historical fixture");
  db.exec(sql);
  db.exec(
    "INSERT INTO connections_legacy SELECT * FROM connections; DROP TABLE connections; ALTER TABLE connections_legacy RENAME TO connections; PRAGMA user_version=14;",
  );
  for (const index of indexes) db.exec(index);
  db.exec("PRAGMA foreign_keys=ON");
}

/** Rebuild one table from its current definition with a CHECK member removed (reverse of a schema-23 rebuild). */
function narrowCheck(
  db: DatabaseSync,
  table: string,
  marker: string,
  indexes: string,
) {
  const original = String(
    db
      .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
      .get(table)?.sql,
  );
  const sql = original
    .replace(
      new RegExp('^CREATE TABLE ["`]?' + table + '["`]?\\s*\\(', "i"),
      "CREATE TABLE " + table + "_legacy (",
    )
    .replace(marker, "");
  if (
    !sql.startsWith("CREATE TABLE " + table + "_legacy") ||
    sql.includes(marker)
  )
    throw new Error("Invalid historical fixture");
  db.exec(sql);
  db.exec(
    `INSERT INTO ${table}_legacy SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_legacy RENAME TO ${table}; ${indexes}`,
  );
}
/** Restore the exact schema-22 boundary: schema 23 added physical executions, role selections and two CHECK members (feature-t30). */
export function restorePreExecutionFixture(db: DatabaseSync) {
  restorePreWidgetGenerationFixture(db);
  db.exec(
    "DROP TABLE project_turn_contexts; DROP TABLE project_chats; DROP TABLE project_runtime;",
  );
  // Remove schema-24 project organization before restoring the historical boundary.
  db.exec(
    "DROP TABLE project_events; DROP TABLE project_undo; DROP TABLE projects;",
  );
  db.exec(
    "PRAGMA foreign_keys=OFF; DROP TABLE runtime_role_bindings; DROP INDEX runtime_executions_resource; DROP INDEX runtime_executions_instance; DROP TABLE runtime_executions;",
  );
  narrowCheck(
    db,
    "executions",
    ",'agent_execution'",
    "CREATE INDEX executions_turn ON executions(turn_id, attempt);",
  );
  narrowCheck(db, "pending_items", ",'stop_unconfirmed'", "");
  db.exec("PRAGMA user_version=22; PRAGMA foreign_keys=ON");
}

/** Restore the exact schema-21 boundary: schema 22 added the Runtime Host tables (feature-t29). */
export function restorePreRuntimeFixture(db: DatabaseSync) {
  restorePreExecutionFixture(db);
  db.exec(
    [
      "DROP INDEX runtime_decisions_instance",
      "DROP TABLE runtime_decisions",
      "DROP TABLE runtime_context_snapshots",
      "DROP INDEX runtime_operations_key",
      "DROP INDEX runtime_operations_instance",
      "DROP TABLE runtime_operations",
      "DROP INDEX runtime_grants_scope",
      "DROP TABLE runtime_grants",
      "DROP TABLE runtime_events",
      "DROP TABLE runtime_projection_pending",
      "DROP TABLE runtime_projection_actions",
      "DROP TABLE runtime_projection_objects",
      "DROP TABLE runtime_scopes",
      "DROP TABLE runtime_resources",
      "DROP INDEX runtime_instances_installation",
      "DROP TABLE runtime_instances",
      "DROP INDEX runtime_installations_runtime",
      "DROP TABLE runtime_installations",
      "PRAGMA user_version=21",
    ].join("; ") + ";",
  );
}

/** Restore the exact schema-18 boundary without changing retained rows. */
export function restorePreClaudeFixture(db: DatabaseSync) {
  // Schema 21 predates the Runtime Host tables, schema 20 predates effort records and
  // schema 18 predates widgets; keep migration fixtures faithful to those boundaries.
  restorePreRuntimeFixture(db);
  db.exec(
    "ALTER TABLE connection_models DROP COLUMN effort_json; ALTER TABLE conversations DROP COLUMN effort;",
  );
  db.exec(
    "DROP TABLE widget_instances; DROP TABLE widget_view_state; DROP TABLE widget_config_drafts; DROP TABLE widget_previews;",
  );
  db.exec(
    "PRAGMA foreign_keys=OFF; DROP TABLE claude_runs; ALTER TABLE connections DROP COLUMN claude_json; ALTER TABLE connection_models DROP COLUMN claude_json; ALTER TABLE settings DROP COLUMN claude_enabled; ALTER TABLE settings DROP COLUMN claude_path; ALTER TABLE settings DROP COLUMN claude_revision;",
  );
  const original = String(
    db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type='table' AND name='connections'",
      )
      .get()?.sql,
  );
  const indexes = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='connections' AND sql IS NOT NULL",
    )
    .all()
    .map((row) => String(row.sql));
  const sql = original
    .replace(
      /^CREATE TABLE ["`]?connections["`]?\s*\(/i,
      "CREATE TABLE connections_preclaude (",
    )
    .replace(",'claude'", "");
  if (
    !sql.startsWith("CREATE TABLE connections_preclaude") ||
    sql.includes("'claude'")
  )
    throw Error("Invalid historical fixture");
  db.exec(sql);
  db.exec(
    "INSERT INTO connections_preclaude SELECT * FROM connections; DROP TABLE connections; ALTER TABLE connections_preclaude RENAME TO connections; PRAGMA user_version=18;",
  );
  for (const index of indexes) db.exec(index);
  db.exec("PRAGMA foreign_keys=ON");
}

/** Remove schemas 29 through 34 before reconstructing a real earlier schema boundary. */
export function restorePreWidgetGenerationFixture(db: DatabaseSync) {
  db.exec(
    "ALTER TABLE settings DROP COLUMN widget_generation_minutes; DROP TABLE widget_draft_undo; DROP TABLE widget_candidate_sets; DROP TABLE widget_layout; DROP TABLE widget_draft_selection; DROP TABLE saved_widgets; DROP TABLE generated_candidates; DROP TABLE widget_generation_attempts; DROP TABLE widget_generation_tasks; DROP TABLE widget_generation_events; DROP TABLE widget_drafts;",
  );
}
