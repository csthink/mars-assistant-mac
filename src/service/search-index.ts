import type { DatabaseSync } from "node:sqlite";
import { normalizeSearch } from "../shared/search";
export function registerSearchFunctions(db: DatabaseSync) {
  db.function("search_normalize", { deterministic: true }, (text) =>
    normalizeSearch(String(text ?? "")),
  );
}
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
 INSERT INTO search_documents SELECT 't:'||new.id,new.conversation_id,'turn-'||new.id,new.partial_text,search_normalize(new.partial_text) WHERE new.partial_text<>'' AND NOT EXISTS(SELECT 1 FROM messages WHERE turn_id=new.id AND role='assistant'); END;`);
  rebuildSearchIndex(db);
}
/** Caller owns the write transaction. Failure preserves the previous committed index. */
export function rebuildSearchIndex(db: DatabaseSync) {
  db.exec(`DROP TRIGGER IF EXISTS search_insert;
 DROP TRIGGER IF EXISTS search_delete;
 DROP TRIGGER IF EXISTS search_update;
 DROP TABLE IF EXISTS search_fts;
 DELETE FROM search_documents;
 INSERT INTO search_documents SELECT 'c:'||id,id,NULL,title,search_normalize(title) FROM conversations;
 INSERT INTO search_documents SELECT 'm:'||id,conversation_id,id,content,search_normalize(content) FROM messages;
 INSERT INTO search_documents SELECT 't:'||t.id,t.conversation_id,'turn-'||t.id,t.partial_text,search_normalize(t.partial_text) FROM turns t WHERE t.partial_text<>'' AND NOT EXISTS(SELECT 1 FROM messages WHERE turn_id=t.id AND role='assistant');
 CREATE VIRTUAL TABLE search_fts USING fts5(normalized,content='search_documents',content_rowid='rowid',tokenize='trigram case_sensitive 1');
 CREATE TRIGGER search_insert AFTER INSERT ON search_documents BEGIN INSERT INTO search_fts(rowid,normalized) VALUES(new.rowid,new.normalized); END;
 CREATE TRIGGER search_delete AFTER DELETE ON search_documents BEGIN INSERT INTO search_fts(search_fts,rowid,normalized) VALUES('delete',old.rowid,old.normalized); END;
 CREATE TRIGGER search_update AFTER UPDATE ON search_documents BEGIN INSERT INTO search_fts(search_fts,rowid,normalized) VALUES('delete',old.rowid,old.normalized); INSERT INTO search_fts(rowid,normalized) VALUES(new.rowid,new.normalized); END;
 INSERT INTO search_fts(search_fts) VALUES('rebuild');
 INSERT INTO search_fts(search_fts) VALUES('integrity-check');`);
}
