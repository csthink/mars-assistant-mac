import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

/** Runs inside Store's migration transaction; never reads or deletes vault secrets. */
export function migrateModels(db: DatabaseSync) {
  db.exec(`ALTER TABLE connections ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1));
    ALTER TABLE settings ADD COLUMN default_model_id TEXT;
    ALTER TABLE conversations ADD COLUMN model_id TEXT;
    ALTER TABLE conversations ADD COLUMN granted_connections TEXT NOT NULL DEFAULT '[]';
    CREATE TABLE connection_models (
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      image_input TEXT NOT NULL DEFAULT 'unknown' CHECK(image_input IN ('unknown','declared','verified','unsupported')),
      image_input_checked_at TEXT,
      context_chars INTEGER,
      PRIMARY KEY(connection_id,model_id)
    );
    INSERT INTO connection_models (connection_id,model_id,image_input,image_input_checked_at,context_chars)
      SELECT id,model,image_input,image_input_checked_at,context_chars FROM connections WHERE model<>'';
    UPDATE settings SET default_model_id=(SELECT NULLIF(model,'') FROM connections WHERE id=default_connection_id);
    UPDATE conversations SET model_id=(SELECT NULLIF(model,'') FROM connections WHERE id=connection_id);
    ALTER TABLE connections DROP COLUMN image_input;
    ALTER TABLE connections DROP COLUMN image_input_checked_at;
    ALTER TABLE connections DROP COLUMN context_chars;
  `);
  const original = db
    .prepare(
      `SELECT c.id,c.name,c.provider,
    c.id=(SELECT default_connection_id FROM settings WHERE id=1) AS is_default,
    COALESCE((SELECT MAX(created_at) FROM executions WHERE connection_id=c.id),c.updated_at) AS last_used
    FROM connections c ORDER BY is_default DESC,last_used DESC,c.created_at DESC,c.id`,
    )
    .all();
  const kept = new Set<string>();
  const converted: { id: string; name: string; provider: string }[] = [];
  for (const row of original) {
    if (row.provider === "custom") continue;
    const provider = String(row.provider);
    if (!kept.has(provider)) {
      kept.add(provider);
      continue;
    }
    db.prepare(
      "UPDATE connections SET provider='custom',revision=revision+1 WHERE id=?",
    ).run(row.id);
    converted.push({ id: String(row.id), name: String(row.name), provider });
  }
  db.exec(
    "CREATE UNIQUE INDEX connections_unique_preset ON connections(provider) WHERE provider<>'custom'",
  );
  // Migration is a completed system execution, separate from provider network checks.
  db.exec(`CREATE TABLE executions_v10 (
    id TEXT PRIMARY KEY, turn_id TEXT REFERENCES turns(id),
    kind TEXT NOT NULL CHECK(kind IN ('turn','connection_test','model_list','image_probe','data_migration')),
    connection_id TEXT, attempt INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0, stop_requested_at TEXT, created_at TEXT NOT NULL,
    ended_at TEXT, error_class TEXT, error_message TEXT, partial_text TEXT NOT NULL DEFAULT ''
  );
  INSERT INTO executions_v10 SELECT * FROM executions;
  DROP TABLE executions;
  ALTER TABLE executions_v10 RENAME TO executions;
  CREATE INDEX executions_turn ON executions(turn_id,attempt);`);
  if (original.length) {
    const id = randomUUID(),
      at = new Date().toISOString();
    db.prepare(
      "INSERT INTO executions (id,kind,state,created_at,ended_at) VALUES (?,'data_migration','completed',?,?)",
    ).run(id, at, at);
    db.prepare(
      "INSERT INTO run_events (id,execution_id,kind,at,payload) VALUES (?,?,'data_migrated',?,?)",
    ).run(
      randomUUID(),
      id,
      at,
      JSON.stringify({
        fromVersion: 9,
        toVersion: 10,
        connections: original.length,
        converted,
      }),
    );
  }
}
