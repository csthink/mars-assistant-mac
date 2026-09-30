import { projectWork, applyProjectWork } from "./project-work";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { StoreError } from "./errors";
import { dropPinnedOrder } from "./conversation-order";
import type {
  Project,
  ProjectCommand,
  ProjectHostCommand,
  ProjectUndo,
} from "../shared/projects";
export const projectSchema = `CREATE TABLE projects (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL, folder_json TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
);
CREATE TABLE project_undo (token TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL, archived_at TEXT, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE project_events (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, at TEXT NOT NULL, snapshot_json TEXT NOT NULL);`;
/** Version 28 adds project pin times and an independent, durable project order. */
export function migrateProjectOrganization(db: DatabaseSync) {
  const columns = db.prepare("PRAGMA table_info(projects)").all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === "pinned_at"))
    db.exec("ALTER TABLE projects ADD COLUMN pinned_at TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS project_order (
    project_id TEXT PRIMARY KEY REFERENCES projects(id), position INTEGER NOT NULL
  );`);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO project_order(project_id,position) VALUES(?,?)",
  );
  const rows = db
    .prepare("SELECT id FROM projects ORDER BY created_at DESC,id")
    .all() as { id: string }[];
  rows.forEach((row, position) => insert.run(row.id, position));
}
export function projectSnapshot(db: DatabaseSync): Project[] {
  return db
    .prepare(
      "SELECT p.id,p.name,p.goal,p.folder_json AS folderJson,p.revision,p.created_at AS createdAt,p.updated_at AS updatedAt,p.archived_at AS archivedAt,p.pinned_at AS pinnedAt,o.position AS manualPosition FROM projects p LEFT JOIN project_order o ON o.project_id=p.id ORDER BY p.created_at DESC,p.id",
    )
    .all()
    .map((row) => {
      const { folderJson, ...rest } = row;
      return {
        ...rest,
        folder: JSON.parse(String(folderJson)),
        ...projectWork(db, String(row.id)),
      } as unknown as Project;
    });
}
export function applyProject(
  db: DatabaseSync,
  c: ProjectCommand | ProjectHostCommand,
): { projectId?: string; projectUndo?: ProjectUndo } {
  if (c.type === "projectWork") {
    applyProjectWork(db, c.request);
    return { projectId: c.request.projectId };
  }
  const at = new Date().toISOString();
  const old = projectSnapshot(db).find((p) => p.id === c.id);
  if (c.type === "projectCreate") {
    if (old) {
      if (
        old.folder.identity !== c.folder.identity ||
        old.name !== c.name.trim() ||
        old.goal !== c.goal.trim()
      )
        throw new StoreError(
          "CONFLICT",
          "同一创建请求的内容已变化，请重新选择文件夹。",
        );
      return { projectId: old.id };
    }
    db.prepare(
      "INSERT INTO projects(id,name,goal,folder_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(c.id, c.name.trim(), c.goal.trim(), JSON.stringify(c.folder), at, at);
    const front = db
      .prepare("SELECT MIN(position) AS position FROM project_order")
      .get() as { position: number | null };
    db.prepare(
      "INSERT INTO project_order(project_id,position) VALUES(?,?)",
    ).run(c.id, (front.position ?? 1) - 1);
  } else {
    if (!old) throw new StoreError("NOT_FOUND", "项目已不存在。");
    if (c.type === "projectUndo") {
      const undo = db
        .prepare("SELECT * FROM project_undo WHERE token=? AND project_id=?")
        .get(c.token, c.id);
      if (
        !undo ||
        undo.used ||
        String(undo.expires_at) <= at ||
        undo.revision !== old.revision
      )
        throw new StoreError("CONFLICT", "撤销已失效，项目未被覆盖。");
      db.prepare(
        "UPDATE projects SET archived_at=?,pinned_at=NULL,revision=revision+1,updated_at=? WHERE id=?",
      ).run(undo.archived_at, at, c.id);
      dropPinnedOrder(db, "project", c.id);
      db.prepare("UPDATE project_undo SET used=1 WHERE token=?").run(c.token);
    } else {
      if (old.revision !== c.revision)
        throw new StoreError("CONFLICT", "项目已变化，请重新核对后保存。");
      if (c.type === "projectPin") {
        if (old.archivedAt)
          throw new StoreError("CONFLICT", "归档项目不能置顶。");
        if (c.pinned === !!old.pinnedAt)
          throw new StoreError("CONFLICT", "项目置顶状态已变化，请重新核对。");
        const times = db
          .prepare(
            `SELECT MAX(at) AS at FROM (
          SELECT pinned_at AS at FROM projects UNION ALL SELECT pinned_at AS at FROM conversations
        )`,
          )
          .get() as { at: string | null };
        const pinnedAt = c.pinned
          ? new Date(
              Math.max(Date.now(), Date.parse(times.at ?? "1970-01-01") + 1),
            ).toISOString()
          : null;
        db.prepare(
          "UPDATE projects SET pinned_at=?,revision=revision+1 WHERE id=?",
        ).run(pinnedAt, c.id);
        if (!c.pinned) dropPinnedOrder(db, "project", c.id);
      } else if (c.type === "moveProject") {
        if (old.archivedAt || old.pinnedAt)
          throw new StoreError(
            "CONFLICT",
            "项目已不在侧栏项目区，顺序未改变。",
          );
        const rows = db
          .prepare(
            `SELECT p.id,p.archived_at AS archivedAt,p.pinned_at AS pinnedAt
          FROM project_order o JOIN projects p ON p.id=o.project_id
          ORDER BY o.position,p.id`,
          )
          .all() as {
          id: string;
          archivedAt: string | null;
          pinnedAt: string | null;
        }[];
        const visible = rows
          .filter((row) => !row.archivedAt && !row.pinnedAt)
          .map((row) => row.id);
        if (c.before !== null && !visible.includes(c.before))
          throw new StoreError(
            "CONFLICT",
            "目标项目已不在侧栏项目区，顺序未改变。",
          );
        const ordered = rows.map((row) => row.id).filter((id) => id !== c.id);
        const lastVisible = visible.filter((id) => id !== c.id).at(-1);
        const index =
          c.before === null
            ? lastVisible
              ? ordered.indexOf(lastVisible) + 1
              : 0
            : ordered.indexOf(c.before);
        ordered.splice(index, 0, c.id);
        const update = db.prepare(
          "UPDATE project_order SET position=? WHERE project_id=?",
        );
        ordered.forEach((id, position) => update.run(position, id));
        db.prepare("UPDATE projects SET revision=revision+1 WHERE id=?").run(
          c.id,
        );
      } else if (c.type === "projectEdit")
        db.prepare(
          "UPDATE projects SET name=?,goal=?,revision=revision+1,updated_at=? WHERE id=?",
        ).run(c.name.trim(), c.goal.trim(), at, c.id);
      else {
        if (c.archived === !!old.archivedAt)
          throw new StoreError("CONFLICT", "项目归档状态已变化，请重新核对。");
        db.prepare(
          "UPDATE projects SET archived_at=?,pinned_at=NULL,revision=revision+1,updated_at=? WHERE id=?",
        ).run(c.archived ? at : null, at, c.id);
        if (c.archived) dropPinnedOrder(db, "project", c.id);
        const undo = {
          id: c.id,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 5000).toISOString(),
        };
        db.prepare(
          "INSERT INTO project_undo(token,project_id,revision,archived_at,expires_at) VALUES(?,?,?,?,?)",
        ).run(
          undo.token,
          c.id,
          old.revision + 1,
          old.archivedAt,
          undo.expiresAt,
        );
        record(db, c.id, c.archived ? "archived" : "unarchived", at);
        return { projectUndo: undo };
      }
    }
  }
  record(db, c.id, c.type, at);
  return { projectId: c.id };
}
function record(db: DatabaseSync, id: string, kind: string, at: string) {
  const project = projectSnapshot(db).find((p) => p.id === id)!;
  db.prepare(
    "INSERT INTO project_events(id,project_id,kind,at,snapshot_json) VALUES(?,?,?,?,?)",
  ).run(
    randomUUID(),
    id,
    kind,
    at,
    JSON.stringify({
      name: project.name,
      revision: project.revision,
      archivedAt: project.archivedAt,
    }),
  );
}
