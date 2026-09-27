import { projectWork, applyProjectWork } from "./project-work";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { StoreError } from "./errors";
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
export function projectSnapshot(db: DatabaseSync): Project[] {
  return db
    .prepare(
      "SELECT id,name,goal,folder_json AS folderJson,revision,created_at AS createdAt,updated_at AS updatedAt,archived_at AS archivedAt FROM projects ORDER BY created_at DESC,id",
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
        "UPDATE projects SET archived_at=?,revision=revision+1,updated_at=? WHERE id=?",
      ).run(undo.archived_at, at, c.id);
      db.prepare("UPDATE project_undo SET used=1 WHERE token=?").run(c.token);
    } else {
      if (old.revision !== c.revision)
        throw new StoreError("CONFLICT", "项目已变化，请重新核对后保存。");
      if (c.type === "projectEdit")
        db.prepare(
          "UPDATE projects SET name=?,goal=?,revision=revision+1,updated_at=? WHERE id=?",
        ).run(c.name.trim(), c.goal.trim(), at, c.id);
      else {
        if (c.archived === !!old.archivedAt)
          throw new StoreError("CONFLICT", "项目归档状态已变化，请重新核对。");
        db.prepare(
          "UPDATE projects SET archived_at=?,revision=revision+1,updated_at=? WHERE id=?",
        ).run(c.archived ? at : null, at, c.id);
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
