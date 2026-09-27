import type { DatabaseSync } from "node:sqlite";
import {
  matchRanges,
  normalizeSearch,
  searchSnippet,
  type SearchRequest,
  type SearchReply,
} from "../shared/search";
const pageSize = 40;
export function querySearch(
  db: DatabaseSync,
  request: SearchRequest,
): SearchReply {
  const query = request.query.trim(),
    normalized = normalizeSearch(query);
  const useFts = [...normalized].length >= 3;
  const params = normalized
    ? [useFts ? '"' + normalized.replace(/"/g, '""') + '"' : normalized]
    : [];
  const rows = db
    .prepare(
      `SELECT d.conversation_id AS conversationId,d.message_id AS messageId,c.title,c.archived_at AS archivedAt,c.updated_at AS updatedAt,d.body
 FROM search_documents d JOIN conversations c ON c.id=d.conversation_id
 ${useFts ? "JOIN search_fts ON search_fts.rowid=d.rowid" : ""}
 WHERE c.deleted_at IS NULL AND c.purged_at IS NULL AND ${normalized ? "1" : "c.archived_at IS NULL"} AND ${normalized ? (useFts ? "search_fts MATCH ?" : "instr(d.normalized,?)>0") : "d.message_id IS NULL"}
 ORDER BY (d.message_id IS NOT NULL),${normalized ? "c.updated_at DESC,c.id" : "(c.pinned_at IS NOT NULL) DESC,c.pinned_at DESC,c.creation_order DESC"},d.id LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize + 1, request.offset);
  return {
    ok: true,
    sequence: request.sequence,
    query: request.query,
    hasMore: rows.length > pageSize,
    hits: rows.slice(0, pageSize).map((row) => ({
      archived: row.archivedAt !== null,
      conversationId: String(row.conversationId),
      messageId: row.messageId === null ? null : String(row.messageId),
      title: String(row.title),
      updatedAt: String(row.updatedAt),
      ...searchSnippet(String(row.body), query),
      titleRanges: matchRanges(String(row.title), query),
    })),
  };
}
