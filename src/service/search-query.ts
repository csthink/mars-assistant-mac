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
type Direction = 1 | -1;
/** Order of each kind: conversation documents, then projects and retained widgets by object. */
const directions: Record<SearchKind, Direction[]> = {
  // Titles before messages, newest conversation first, then identities.
  conversation: [1, -1, 1, 1],
  project: [-1, 1],
  widget: [1, 1],
};
function compare(a: Key, b: Key, order: Direction[]) {
  for (let i = 0; i < order.length; i++)
    if (a[i] !== b[i]) return (a[i] < b[i] ? -1 : 1) * order[i];
  return 0;
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

interface Match {
  kind: SearchKind;
  objectId: string;
  /** Conversation document identity; the object for projects and widgets. */
  documentId: string;
  key: Key;
}

/**
 * One query against the three-kind index, read in one read transaction so counts and hits come from the same
 * committed index. The matching documents are found by one pass (the trigram index for three characters or
 * more, one bounded scan for shorter text) with the sort keys of their objects; counts, order and the page are
 * taken from that pass, and only the hits of the page read their text. A page continues after the last key of the
 * previous page, so a write between pages neither repeats nor skips a hit already ordered before it. Only the
 * local database is read.
 */
export function querySearch(
  db: DatabaseSync,
  request: SearchRequest,
): SearchReply {
  const query = request.query.trim(),
    normalized = normalizeSearch(query);
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
      const matches = match(db, normalized);
      for (const kind of ["conversation", "project", "widget"] as const)
        counts[kind] = matches[kind].length;
      let chosen: Match[] = [];
      if (request.category === "all") {
        if (request.cursor !== null) throw new CursorError();
        chosen = (["conversation", "project", "widget"] as const).flatMap(
          (kind) => matches[kind].slice(0, groupSize),
        );
      } else {
        const kind = request.category;
        const key = decode(request.cursor, kind);
        if (key && key.length !== directions[kind].length)
          throw new CursorError();
        const rest = key
          ? matches[kind].filter(
              (m) => compare(m.key, key, directions[kind]) > 0,
            )
          : matches[kind];
        chosen = rest.slice(0, pageSize);
        if (rest.length > pageSize) next = encode(kind, chosen.at(-1)!.key);
      }
      hits = details(db, chosen, query);
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

/** Every matching document with the sort key of its object, ordered per kind; one object per project and widget. */
function match(db: DatabaseSync, normalized: string) {
  const fts = [...normalized].length >= 3;
  const rows = db
    .prepare(
      `SELECT d.kind,d.object_id AS objectId,d.id AS documentId,d.message_id AS messageId,c.updated_at AS conversationTime,p.updated_at AS projectTime,s.position
 FROM search_documents d
 LEFT JOIN conversations c ON d.kind='conversation' AND c.id=d.object_id
 LEFT JOIN projects p ON d.kind='project' AND p.id=d.object_id
 LEFT JOIN saved_widgets s ON d.kind='widget' AND s.id=d.object_id
 WHERE ${fts ? "d.rowid IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?)" : "instr(d.normalized,?)>0"}
 AND (d.kind<>'conversation' OR (c.id IS NOT NULL AND c.deleted_at IS NULL AND c.purged_at IS NULL))
 AND (d.kind<>'project' OR (p.id IS NOT NULL AND p.deleted_at IS NULL AND p.purged_at IS NULL)) AND (d.kind<>'widget' OR s.id IS NOT NULL)`,
    )
    .all(fts ? '"' + normalized.replace(/"/g, '""') + '"' : normalized) as {
    kind: SearchKind;
    objectId: string;
    documentId: string;
    messageId: string | null;
    conversationTime: string | null;
    projectTime: string | null;
    position: number | null;
  }[];
  const result: Record<SearchKind, Match[]> = {
    conversation: [],
    project: [],
    widget: [],
  };
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.kind === "conversation")
      result.conversation.push({
        kind: row.kind,
        objectId: row.objectId,
        documentId: row.documentId,
        key: [
          row.messageId === null ? 0 : 1,
          String(row.conversationTime),
          row.objectId,
          row.documentId,
        ],
      });
    else if (!seen.has(`${row.kind}:${row.objectId}`)) {
      seen.add(`${row.kind}:${row.objectId}`);
      result[row.kind].push({
        kind: row.kind,
        objectId: row.objectId,
        documentId: row.objectId,
        key:
          row.kind === "project"
            ? [String(row.projectTime), row.objectId]
            : [Number(row.position), row.objectId],
      });
    }
  }
  for (const kind of ["conversation", "project", "widget"] as const)
    result[kind].sort((a, b) => compare(a.key, b.key, directions[kind]));
  return result;
}

/** Text, highlights and places of the hits of one page, in the page's order. */
function details(db: DatabaseSync, chosen: Match[], query: string) {
  const ids = (kind: SearchKind) =>
    JSON.stringify(
      chosen.filter((m) => m.kind === kind).map((m) => m.documentId),
    );
  const conversations = new Map(
    db
      .prepare(
        `SELECT d.id,d.object_id AS conversationId,d.message_id AS messageId,d.body,c.title,c.archived_at AS archivedAt,c.updated_at AS updatedAt,p.name AS projectName
 FROM search_documents d JOIN conversations c ON c.id=d.object_id
 LEFT JOIN project_chats pc ON pc.conversation_id=c.id LEFT JOIN projects p ON p.id=pc.project_id AND p.deleted_at IS NULL AND p.purged_at IS NULL
 WHERE d.id IN (SELECT value FROM json_each(?))`,
      )
      .all(ids("conversation"))
      .map((row): [string, SearchHit] => [
        String(row.id),
        {
          kind: "conversation",
          objectId: String(row.conversationId),
          conversationId: String(row.conversationId),
          messageId: row.messageId === null ? null : String(row.messageId),
          archived: row.archivedAt !== null,
          title: String(row.title),
          titleRanges: matchRanges(String(row.title), query),
          ...searchSnippet(String(row.body), query),
          updatedAt: String(row.updatedAt),
          projectName:
            row.projectName === null ? null : String(row.projectName),
        },
      ]),
  );
  const projects = new Map(
    db
      .prepare(
        "SELECT id,name,goal,archived_at AS archivedAt,updated_at AS updatedAt FROM projects WHERE id IN (SELECT value FROM json_each(?))",
      )
      .all(ids("project"))
      .map((row): [string, SearchHit] => {
        const goal = String(row.goal);
        return [
          String(row.id),
          {
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
          },
        ];
      }),
  );
  const widgets = new Map(
    db
      .prepare(
        "SELECT s.id,s.name,(SELECT body FROM search_documents WHERE id='wt:'||s.id) AS content FROM saved_widgets s WHERE s.id IN (SELECT value FROM json_each(?))",
      )
      .all(ids("widget"))
      .map((row): [string, SearchHit] => {
        const content = row.content === null ? "" : String(row.content);
        return [
          String(row.id),
          {
            kind: "widget",
            objectId: String(row.id),
            conversationId: null,
            messageId: null,
            archived: false,
            title: String(row.name),
            titleRanges: matchRanges(String(row.name), query),
            ...(content
              ? searchSnippet(content, query)
              : { text: "", ranges: [] }),
            updatedAt: null,
            projectName: null,
          },
        ];
      }),
  );
  const read = {
    conversation: conversations,
    project: projects,
    widget: widgets,
  };
  return chosen.flatMap((m) => {
    const hit = read[m.kind].get(m.documentId);
    return hit ? [hit] : [];
  });
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
 LEFT JOIN project_chats pc ON pc.conversation_id=c.id LEFT JOIN projects p ON p.id=pc.project_id AND p.deleted_at IS NULL AND p.purged_at IS NULL
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
