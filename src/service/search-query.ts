import type { DatabaseSync } from "node:sqlite";
import {
  matchRanges,
  normalizeSearch,
  searchSnippet,
  type SearchCounts,
  type SearchHit,
  type SearchKind,
  type SearchRequest,
  type SearchReply,
} from "../shared/search";

/** Hits per page of one category; 全部 shows the first `groupSize` of every kind and links to its category. */
export const pageSize = 40;
export const groupSize = 10;

class CursorError extends Error {}
type Key = (string | number)[];
/** Lexicographic "after this key" over columns with their own directions; parameters follow the column order. */
function after(columns: [string, "asc" | "desc"][], key: Key) {
  if (key.length !== columns.length) throw new CursorError();
  const parts: string[] = [];
  const params: (string | number)[] = [];
  columns.forEach(([column, direction], index) => {
    const equal = columns
      .slice(0, index)
      .map(([c]) => `${c}=?`)
      .join(" AND ");
    parts.push(
      `(${equal ? equal + " AND " : ""}${column}${direction === "asc" ? ">" : "<"}?)`,
    );
    params.push(...key.slice(0, index + 1));
  });
  return { sql: `(${parts.join(" OR ")})`, params };
}
function decode(cursor: string | null, kind: SearchKind): Key | null {
  if (cursor === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    throw new CursorError();
  }
  if (
    !Array.isArray(value) ||
    value[0] !== kind ||
    !value
      .slice(1)
      .every((v) => typeof v === "string" || Number.isSafeInteger(v))
  )
    throw new CursorError();
  return value.slice(1) as Key;
}
const encode = (kind: SearchKind, key: Key) => JSON.stringify([kind, ...key]);
const noCursor = { sql: "1", params: [] as (string | number)[] };

/**
 * One query against the three-kind index. Counts and hits are read inside one read transaction, so they come from
 * the same committed index; pages continue after the last key of the previous page, so a write between pages
 * neither repeats nor skips a hit already ordered before it. Only the local database is read.
 */
export function querySearch(
  db: DatabaseSync,
  request: SearchRequest,
): SearchReply {
  const query = request.query.trim(),
    normalized = normalizeSearch(query);
  const useFts = [...normalized].length >= 3;
  const match = useFts
    ? "SELECT rowid FROM search_fts WHERE search_fts MATCH ?"
    : "SELECT rowid FROM search_documents WHERE instr(normalized,?)>0";
  const term = useFts ? '"' + normalized.replace(/"/g, '""') + '"' : normalized;
  db.exec("BEGIN");
  try {
    const meta = db
      .prepare("SELECT generation,revision FROM search_meta WHERE id=1")
      .get() as { generation: number; revision: number };
    const counts: SearchCounts = { conversation: 0, project: 0, widget: 0 };
    let hits: SearchHit[] = [];
    let next: string | null = null;
    if (!normalized) {
      if (request.category === "all" || request.category === "conversation") {
        const recent = recentConversations(db, request.cursor);
        hits = recent.hits;
        next = recent.next;
      }
    } else {
      counts.conversation = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM search_documents d JOIN conversations c ON c.id=d.object_id WHERE d.kind='conversation' AND c.deleted_at IS NULL AND c.purged_at IS NULL AND d.rowid IN (${match})`,
            )
            .get(term) as { n: number }
        ).n,
      );
      for (const kind of ["project", "widget"] as const)
        counts[kind] = Number(
          (
            db
              .prepare(
                `SELECT COUNT(DISTINCT object_id) AS n FROM search_documents WHERE kind=? AND rowid IN (${match})`,
              )
              .get(kind, term) as { n: number }
          ).n,
        );
      const read = { conversation, project, widget };
      if (request.category === "all") {
        if (request.cursor !== null) throw new CursorError();
        for (const kind of ["conversation", "project", "widget"] as const)
          if (counts[kind])
            hits.push(
              ...read[kind](db, match, term, query, null, groupSize).hits,
            );
      } else {
        const page = read[request.category](
          db,
          match,
          term,
          query,
          decode(request.cursor, request.category),
          pageSize,
        );
        hits = page.hits;
        next = page.next;
      }
    }
    return {
      ok: true,
      sequence: request.sequence,
      query: request.query,
      category: request.category,
      counts,
      hits,
      next,
      hasMore: next !== null,
      snapshot: {
        generation: Number(meta.generation),
        revision: Number(meta.revision),
      },
    };
  } catch (error) {
    if (error instanceof CursorError)
      return {
        ok: false,
        code: "INVALID_QUERY",
        message: "翻页位置无效，请重新搜索。",
      };
    throw error;
  } finally {
    db.exec("COMMIT");
  }
}

function recentConversations(db: DatabaseSync, cursor: string | null) {
  // The no-keyword list is the recent conversations entry, not a result set; it pages by position.
  const offset =
    cursor === null ? 0 : (decode(cursor, "conversation")?.[0] ?? -1);
  if (typeof offset !== "number" || offset < 0 || offset > 20000)
    throw new CursorError();
  const rows = db
    .prepare(
      `SELECT c.id,c.title,c.archived_at AS archivedAt,c.updated_at AS updatedAt,p.name AS projectName FROM conversations c
 LEFT JOIN project_chats pc ON pc.conversation_id=c.id LEFT JOIN projects p ON p.id=pc.project_id
 WHERE c.deleted_at IS NULL AND c.purged_at IS NULL AND c.archived_at IS NULL
 ORDER BY (c.pinned_at IS NOT NULL) DESC,c.pinned_at DESC,c.creation_order DESC LIMIT ? OFFSET ?`,
    )
    .all(pageSize + 1, offset);
  return {
    hits: rows.slice(0, pageSize).map((row): SearchHit => ({
      kind: "conversation",
      objectId: String(row.id),
      conversationId: String(row.id),
      messageId: null,
      archived: row.archivedAt !== null,
      title: String(row.title),
      titleRanges: [],
      text: String(row.title),
      ranges: [],
      updatedAt: String(row.updatedAt),
      projectName: row.projectName === null ? null : String(row.projectName),
    })),
    next:
      rows.length > pageSize
        ? encode("conversation", [offset + pageSize])
        : null,
  };
}

function conversation(
  db: DatabaseSync,
  match: string,
  term: string,
  query: string,
  key: Key | null,
  limit: number,
) {
  const cursor = key
    ? after(
        [
          ["(d.message_id IS NOT NULL)", "asc"],
          ["c.updated_at", "desc"],
          ["c.id", "asc"],
          ["d.id", "asc"],
        ],
        key,
      )
    : noCursor;
  const rows = db
    .prepare(
      `SELECT d.id AS docId,d.object_id AS conversationId,d.message_id AS messageId,c.title,c.archived_at AS archivedAt,c.updated_at AS updatedAt,d.body,p.name AS projectName
 FROM search_documents d JOIN conversations c ON c.id=d.object_id
 LEFT JOIN project_chats pc ON pc.conversation_id=c.id LEFT JOIN projects p ON p.id=pc.project_id
 WHERE d.kind='conversation' AND c.deleted_at IS NULL AND c.purged_at IS NULL AND d.rowid IN (${match}) AND ${cursor.sql}
 ORDER BY (d.message_id IS NOT NULL),c.updated_at DESC,c.id,d.id LIMIT ?`,
    )
    .all(term, ...cursor.params, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    hits: page.map((row): SearchHit => ({
      kind: "conversation",
      objectId: String(row.conversationId),
      conversationId: String(row.conversationId),
      messageId: row.messageId === null ? null : String(row.messageId),
      archived: row.archivedAt !== null,
      title: String(row.title),
      titleRanges: matchRanges(String(row.title), query),
      ...searchSnippet(String(row.body), query),
      updatedAt: String(row.updatedAt),
      projectName: row.projectName === null ? null : String(row.projectName),
    })),
    next:
      rows.length > limit && last
        ? encode("conversation", [
            last.messageId === null ? 0 : 1,
            String(last.updatedAt),
            String(last.conversationId),
            String(last.docId),
          ])
        : null,
  };
}

function project(
  db: DatabaseSync,
  match: string,
  term: string,
  query: string,
  key: Key | null,
  limit: number,
) {
  const cursor = key
    ? after(
        [
          ["p.updated_at", "desc"],
          ["p.id", "asc"],
        ],
        key,
      )
    : noCursor;
  const rows = db
    .prepare(
      `SELECT p.id,p.name,p.goal,p.archived_at AS archivedAt,p.updated_at AS updatedAt FROM projects p
 WHERE p.id IN (SELECT object_id FROM search_documents WHERE kind='project' AND rowid IN (${match})) AND ${cursor.sql}
 ORDER BY p.updated_at DESC,p.id LIMIT ?`,
    )
    .all(term, ...cursor.params, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    hits: page.map((row): SearchHit => {
      const goal = String(row.goal);
      return {
        kind: "project",
        objectId: String(row.id),
        conversationId: null,
        messageId: null,
        archived: row.archivedAt !== null,
        title: String(row.name),
        titleRanges: matchRanges(String(row.name), query),
        ...(goal ? searchSnippet(goal, query) : { text: "", ranges: [] }),
        updatedAt: String(row.updatedAt),
        projectName: null,
      };
    }),
    next:
      rows.length > limit && last
        ? encode("project", [String(last.updatedAt), String(last.id)])
        : null,
  };
}

function widget(
  db: DatabaseSync,
  match: string,
  term: string,
  query: string,
  key: Key | null,
  limit: number,
) {
  const cursor = key
    ? after(
        [
          ["s.position", "asc"],
          ["s.id", "asc"],
        ],
        key,
      )
    : noCursor;
  const rows = db
    .prepare(
      `SELECT s.id,s.name,s.position,(SELECT body FROM search_documents WHERE id='wt:'||s.id) AS content FROM saved_widgets s
 WHERE s.id IN (SELECT object_id FROM search_documents WHERE kind='widget' AND rowid IN (${match})) AND ${cursor.sql}
 ORDER BY s.position,s.id LIMIT ?`,
    )
    .all(term, ...cursor.params, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    hits: page.map((row): SearchHit => {
      const content = row.content === null ? "" : String(row.content);
      return {
        kind: "widget",
        objectId: String(row.id),
        conversationId: null,
        messageId: null,
        archived: false,
        title: String(row.name),
        titleRanges: matchRanges(String(row.name), query),
        ...(content ? searchSnippet(content, query) : { text: "", ranges: [] }),
        updatedAt: null,
        projectName: null,
      };
    }),
    next:
      rows.length > limit && last
        ? encode("widget", [Number(last.position), String(last.id)])
        : null,
  };
}
