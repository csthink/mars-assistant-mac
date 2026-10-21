import type { DatabaseSync } from "node:sqlite";
import { normalizeSearch } from "../shared/search";

/** Strings of a retained widget's committed data, in document order, at most 64 KiB (SEARCH-01). */
export const widgetSearchTextLimit = 65_536;
export function widgetSearchText(data: string): string {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return "";
  }
  const parts: string[] = [];
  let size = 0;
  const walk = (node: unknown, depth: number) => {
    if (size >= widgetSearchTextLimit || depth > 16) return;
    if (typeof node === "string") {
      const text = node.trim();
      if (!text) return;
      parts.push(text);
      size += text.length + 1;
    } else if (Array.isArray(node))
      for (const item of node) walk(item, depth + 1);
    else if (node && typeof node === "object")
      for (const item of Object.values(node)) walk(item, depth + 1);
  };
  walk(value, 0);
  return parts.join("\n").slice(0, widgetSearchTextLimit);
}

export function registerSearchFunctions(db: DatabaseSync) {
  db.function("search_normalize", { deterministic: true }, (text) =>
    normalizeSearch(String(text ?? "")),
  );
  db.function("widget_search_text", { deterministic: true }, (data) =>
    widgetSearchText(String(data ?? "")),
  );
}

/**
 * Version 10: the conversation-only index. Kept as that version built it, so that a database migrating through
 * version 10 gets the same objects; version 36 replaces it with the three-kind index below.
 */
export function createSearchIndex(db: DatabaseSync) {
  db.exec(`CREATE TABLE search_documents (id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,message_id TEXT,body TEXT NOT NULL,normalized TEXT NOT NULL);
 CREATE INDEX search_documents_conversation ON search_documents(conversation_id);
 CREATE TRIGGER conversation_search_insert AFTER INSERT ON conversations BEGIN INSERT INTO search_documents VALUES('c:'||new.id,new.id,NULL,new.title,search_normalize(new.title)); END;
 CREATE TRIGGER conversation_search_update AFTER UPDATE OF title ON conversations WHEN old.title<>new.title BEGIN UPDATE search_documents SET body=new.title,normalized=search_normalize(new.title) WHERE id='c:'||new.id; END;
 CREATE TRIGGER conversation_search_delete AFTER DELETE ON conversations BEGIN DELETE FROM search_documents WHERE conversation_id=old.id; END;
 CREATE TRIGGER message_search_insert AFTER INSERT ON messages BEGIN DELETE FROM search_documents WHERE id='t:'||new.turn_id AND new.role='assistant'; INSERT INTO search_documents VALUES('m:'||new.id,new.conversation_id,new.id,new.content,search_normalize(new.content)); END;
 CREATE TRIGGER message_search_update AFTER UPDATE OF content ON messages BEGIN UPDATE search_documents SET body=new.content,normalized=search_normalize(new.content) WHERE id='m:'||new.id; END;
 CREATE TRIGGER message_search_delete AFTER DELETE ON messages BEGIN DELETE FROM search_documents WHERE id='m:'||old.id; END;
 CREATE TRIGGER turn_search_update AFTER UPDATE OF partial_text ON turns BEGIN
 DELETE FROM search_documents WHERE id='t:'||new.id;
 INSERT INTO search_documents SELECT 't:'||new.id,new.conversation_id,'turn-'||new.id,new.partial_text,search_normalize(new.partial_text) WHERE new.partial_text<>'' AND NOT EXISTS(SELECT 1 FROM messages WHERE turn_id=new.id AND role='assistant'); END;
 INSERT INTO search_documents SELECT 'c:'||id,id,NULL,title,search_normalize(title) FROM conversations;
 INSERT INTO search_documents SELECT 'm:'||id,conversation_id,id,content,search_normalize(content) FROM messages;
 INSERT INTO search_documents SELECT 't:'||t.id,t.conversation_id,'turn-'||t.id,t.partial_text,search_normalize(t.partial_text) FROM turns t WHERE t.partial_text<>'' AND NOT EXISTS(SELECT 1 FROM messages WHERE turn_id=t.id AND role='assistant');
 CREATE VIRTUAL TABLE search_fts USING fts5(normalized,content='search_documents',content_rowid='rowid',tokenize='trigram case_sensitive 1');
 CREATE TRIGGER search_insert AFTER INSERT ON search_documents BEGIN INSERT INTO search_fts(rowid,normalized) VALUES(new.rowid,new.normalized); END;
 CREATE TRIGGER search_delete AFTER DELETE ON search_documents BEGIN INSERT INTO search_fts(search_fts,rowid,normalized) VALUES('delete',old.rowid,old.normalized); END;
 CREATE TRIGGER search_update AFTER UPDATE ON search_documents BEGIN INSERT INTO search_fts(search_fts,rowid,normalized) VALUES('delete',old.rowid,old.normalized); INSERT INTO search_fts(rowid,normalized) VALUES(new.rowid,new.normalized); END;
 INSERT INTO search_fts(search_fts) VALUES('rebuild');`);
}

/*
 * Version 36: one index over three kinds (SEARCH-01). A document is one searchable field of one object:
 * kind conversation (title, saved message, saved partial answer), project (name, goal) or widget (name and the
 * strings of its committed data). object_id is the conversation, project or retained widget identity. Drafts,
 * unsent input, widget configuration, secrets, pending items and logs have no documents. Source triggers keep
 * the documents in the transaction of the change; `search_meta` counts committed index changes (revision) and
 * successful rebuilds (generation).
 */
const insertDocument =
  "INSERT INTO search_documents(id,kind,object_id,message_id,field,body,normalized)";
const widgetText = "widget_search_text(p.data)";
const kindSources = `
 ${insertDocument} SELECT 'c:'||id,'conversation',id,NULL,'title',title,search_normalize(title) FROM conversations;
 ${insertDocument} SELECT 'm:'||id,'conversation',conversation_id,id,'message',content,search_normalize(content) FROM messages;
 ${insertDocument} SELECT 't:'||t.id,'conversation',t.conversation_id,'turn-'||t.id,'message',t.partial_text,search_normalize(t.partial_text) FROM turns t WHERE t.partial_text<>'' AND NOT EXISTS(SELECT 1 FROM messages WHERE turn_id=t.id AND role='assistant');
 ${insertDocument} SELECT 'pn:'||id,'project',id,NULL,'name',name,search_normalize(name) FROM projects;
 ${insertDocument} SELECT 'pg:'||id,'project',id,NULL,'goal',goal,search_normalize(goal) FROM projects WHERE goal<>'';
 ${insertDocument} SELECT 'wn:'||id,'widget',id,NULL,'name',name,search_normalize(name) FROM saved_widgets;
 ${insertDocument} SELECT 'wt:'||s.id,'widget',s.id,NULL,'content',${widgetText},search_normalize(${widgetText}) FROM saved_widgets s JOIN widget_previews p ON p.candidate_id=s.candidate_id WHERE ${widgetText}<>'';`;
const ftsTable = `CREATE VIRTUAL TABLE search_fts USING fts5(normalized,content='search_documents',content_rowid='rowid',tokenize='trigram case_sensitive 1');
 CREATE TRIGGER search_insert AFTER INSERT ON search_documents BEGIN INSERT INTO search_fts(rowid,normalized) VALUES(new.rowid,new.normalized); UPDATE search_meta SET revision=revision+1 WHERE id=1; END;
 CREATE TRIGGER search_delete AFTER DELETE ON search_documents BEGIN INSERT INTO search_fts(search_fts,rowid,normalized) VALUES('delete',old.rowid,old.normalized); UPDATE search_meta SET revision=revision+1 WHERE id=1; END;
 CREATE TRIGGER search_update AFTER UPDATE ON search_documents BEGIN INSERT INTO search_fts(search_fts,rowid,normalized) VALUES('delete',old.rowid,old.normalized); INSERT INTO search_fts(rowid,normalized) VALUES(new.rowid,new.normalized); UPDATE search_meta SET revision=revision+1 WHERE id=1; END;`;
const widgetContent = (id: string) =>
  `DELETE FROM search_documents WHERE id='wt:'||${id};
 ${insertDocument} SELECT 'wt:'||s.id,'widget',s.id,NULL,'content',${widgetText},search_normalize(${widgetText}) FROM saved_widgets s JOIN widget_previews p ON p.candidate_id=s.candidate_id WHERE s.id=${id} AND ${widgetText}<>'';`;
const projectDocuments = `${insertDocument} VALUES('pn:'||new.id,'project',new.id,NULL,'name',new.name,search_normalize(new.name));
 ${insertDocument} SELECT 'pg:'||new.id,'project',new.id,NULL,'goal',new.goal,search_normalize(new.goal) WHERE new.goal<>'';`;

export function upgradeSearchIndex(db: DatabaseSync) {
  for (const row of db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%search%'",
    )
    .all() as { name: string }[])
    db.exec(`DROP TRIGGER "${row.name}"`);
  db.exec(`DROP TABLE IF EXISTS search_fts;
 DROP TABLE IF EXISTS search_documents;
 CREATE TABLE search_documents (id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('conversation','project','widget')),object_id TEXT NOT NULL,message_id TEXT,field TEXT NOT NULL,body TEXT NOT NULL,normalized TEXT NOT NULL);
 CREATE INDEX search_documents_object ON search_documents(kind,object_id);
 CREATE TABLE IF NOT EXISTS search_meta (id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0);
 INSERT OR IGNORE INTO search_meta(id) VALUES(1);
 CREATE TRIGGER conversation_search_insert AFTER INSERT ON conversations BEGIN ${insertDocument} VALUES('c:'||new.id,'conversation',new.id,NULL,'title',new.title,search_normalize(new.title)); END;
 CREATE TRIGGER conversation_search_update AFTER UPDATE OF title ON conversations WHEN old.title<>new.title BEGIN UPDATE search_documents SET body=new.title,normalized=search_normalize(new.title) WHERE id='c:'||new.id; END;
 CREATE TRIGGER conversation_search_delete AFTER DELETE ON conversations BEGIN DELETE FROM search_documents WHERE kind='conversation' AND object_id=old.id; END;
 CREATE TRIGGER message_search_insert AFTER INSERT ON messages BEGIN DELETE FROM search_documents WHERE id='t:'||new.turn_id AND new.role='assistant'; ${insertDocument} VALUES('m:'||new.id,'conversation',new.conversation_id,new.id,'message',new.content,search_normalize(new.content)); END;
 CREATE TRIGGER message_search_update AFTER UPDATE OF content ON messages BEGIN UPDATE search_documents SET body=new.content,normalized=search_normalize(new.content) WHERE id='m:'||new.id; END;
 CREATE TRIGGER message_search_delete AFTER DELETE ON messages BEGIN DELETE FROM search_documents WHERE id='m:'||old.id; END;
 CREATE TRIGGER turn_search_update AFTER UPDATE OF partial_text ON turns BEGIN
 DELETE FROM search_documents WHERE id='t:'||new.id;
 ${insertDocument} SELECT 't:'||new.id,'conversation',new.conversation_id,'turn-'||new.id,'message',new.partial_text,search_normalize(new.partial_text) WHERE new.partial_text<>'' AND NOT EXISTS(SELECT 1 FROM messages WHERE turn_id=new.id AND role='assistant'); END;
 CREATE TRIGGER project_search_insert AFTER INSERT ON projects BEGIN ${projectDocuments} END;
 CREATE TRIGGER project_search_update AFTER UPDATE OF name,goal ON projects WHEN old.name<>new.name OR old.goal<>new.goal BEGIN
 DELETE FROM search_documents WHERE kind='project' AND object_id=new.id;
 ${projectDocuments} END;
 CREATE TRIGGER project_search_delete AFTER DELETE ON projects BEGIN DELETE FROM search_documents WHERE kind='project' AND object_id=old.id; END;
 CREATE TRIGGER widget_search_insert AFTER INSERT ON saved_widgets BEGIN
 ${insertDocument} VALUES('wn:'||new.id,'widget',new.id,NULL,'name',new.name,search_normalize(new.name));
 ${widgetContent("new.id")} END;
 CREATE TRIGGER widget_search_update AFTER UPDATE OF name,candidate_id ON saved_widgets BEGIN
 UPDATE search_documents SET body=new.name,normalized=search_normalize(new.name) WHERE id='wn:'||new.id AND body<>new.name;
 ${widgetContent("new.id")} END;
 CREATE TRIGGER widget_search_delete AFTER DELETE ON saved_widgets BEGIN DELETE FROM search_documents WHERE kind='widget' AND object_id=old.id; END;
 CREATE TRIGGER widget_data_search_update AFTER UPDATE OF data ON widget_previews WHEN EXISTS(SELECT 1 FROM saved_widgets WHERE candidate_id=new.candidate_id) BEGIN
 ${widgetContent("(SELECT id FROM saved_widgets WHERE candidate_id=new.candidate_id)")} END;
 ${kindSources}
 ${ftsTable}
 INSERT INTO search_fts(search_fts) VALUES('rebuild');`);
}

/**
 * Rebuilds the documents and the FTS table from the source tables. Caller owns the write transaction: readers keep
 * the previous committed index until it commits, and a failed check rolls the whole rebuild back. The rebuilt
 * index is checked (FTS integrity and the document count of every source) before the generation advances.
 */
export function rebuildSearchIndex(db: DatabaseSync) {
  db.exec(`DROP TRIGGER IF EXISTS search_insert;
 DROP TRIGGER IF EXISTS search_delete;
 DROP TRIGGER IF EXISTS search_update;
 DROP TABLE IF EXISTS search_fts;
 DELETE FROM search_documents;
 ${kindSources}
 ${ftsTable}
 INSERT INTO search_fts(search_fts) VALUES('rebuild');
 INSERT INTO search_fts(search_fts) VALUES('integrity-check');`);
  const count = (sql: string) =>
    Number((db.prepare(sql).get() as { n: number }).n);
  const expected =
    count("SELECT COUNT(*) AS n FROM conversations") +
    count("SELECT COUNT(*) AS n FROM messages") +
    count(
      "SELECT COUNT(*) AS n FROM turns t WHERE t.partial_text<>'' AND NOT EXISTS(SELECT 1 FROM messages WHERE turn_id=t.id AND role='assistant')",
    ) +
    count("SELECT COUNT(*) AS n FROM projects") +
    count("SELECT COUNT(*) AS n FROM projects WHERE goal<>''") +
    count("SELECT COUNT(*) AS n FROM saved_widgets") +
    count(
      `SELECT COUNT(*) AS n FROM saved_widgets s JOIN widget_previews p ON p.candidate_id=s.candidate_id WHERE ${widgetText}<>''`,
    );
  if (count("SELECT COUNT(*) AS n FROM search_documents") !== expected)
    throw new Error("search index rebuild does not cover its sources");
  db.prepare(
    "UPDATE search_meta SET generation=generation+1,revision=revision+1 WHERE id=1",
  ).run();
}
