import type { DatabaseSync } from "node:sqlite";
import type {
  ProjectChat,
  ProjectChatContext,
  ProjectRequest,
  ProjectRuntimeLink,
  ProjectWork,
} from "../shared/project-work";
import { projectScopeProblem } from "../shared/project-work";
import { readProjection, runtimeSnapshot } from "./runtime-store";
import { applyRoleBindingUpsert, readRoleBinding } from "./runtime-executions";
import { selectedModel } from "./models";
import { StoreError } from "./errors";
import { assertConversationAvailable } from "./organization";
export const projectWorkSchema = `
CREATE TABLE project_runtime (project_id TEXT PRIMARY KEY REFERENCES projects(id), record TEXT NOT NULL, instance_id TEXT NOT NULL, scope_ref TEXT NOT NULL, UNIQUE(instance_id,scope_ref));
CREATE TABLE project_chats (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), project_id TEXT NOT NULL REFERENCES projects(id), context_json TEXT, revision INTEGER NOT NULL DEFAULT 0);
CREATE INDEX project_chats_project ON project_chats(project_id);
CREATE TABLE project_turn_contexts (turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id), context_json TEXT NOT NULL, text TEXT NOT NULL);
`;
export function projectWork(db: DatabaseSync, id: string): ProjectWork {
  const row = db
    .prepare("SELECT record FROM project_runtime WHERE project_id=?")
    .get(id);
  return {
    runtime: row ? JSON.parse(String(row.record)) : null,
    chats: db
      .prepare(
        "SELECT conversation_id AS conversationId,context_json,revision FROM project_chats WHERE project_id=? ORDER BY rowid",
      )
      .all(id)
      .map((r) => ({
        conversationId: String(r.conversationId),
        revision: Number(r.revision),
        context: r.context_json ? JSON.parse(String(r.context_json)) : null,
      })),
  };
}
function fail(message: string): never {
  throw new StoreError("CONFLICT", message);
}
function usable(db: DatabaseSync, link: ProjectRuntimeLink) {
  const reason = projectScopeProblem(runtimeSnapshot(db), link);
  if (reason) fail(reason);
}
export function applyProjectWork(
  db: DatabaseSync,
  c: Exclude<ProjectRequest, { type: "read" }>,
) {
  const project = db
    .prepare("SELECT name,goal,folder_json,revision FROM projects WHERE id=?")
    .get(c.projectId);
  if (!project) fail("项目已不存在。");
  const work = projectWork(db, c.projectId),
    at = new Date().toISOString();
  if (c.type === "chat") {
    const old = db
      .prepare("SELECT project_id FROM project_chats WHERE conversation_id=?")
      .get(c.conversationId);
    if (old) {
      if (old.project_id !== c.projectId) fail("对话属于另一项目。");
      assertConversationAvailable(db, c.conversationId);
      return;
    }
    if (
      db.prepare("SELECT 1 FROM conversations WHERE id=?").get(c.conversationId)
    )
      fail("已有对话不能被重新归属。");
    db.prepare(
      "INSERT INTO conversations(id,title,updated_at) VALUES(?,?,?)",
    ).run(c.conversationId, "项目对话", at);
    db.prepare(
      "INSERT INTO project_chats(conversation_id,project_id) VALUES(?,?)",
    ).run(c.conversationId, c.projectId);
    return;
  }
  if (c.type === "bind") {
    if (project.revision !== c.revision) fail("项目已变化，请重新核对关联。");
    const records = runtimeSnapshot(db),
      scope = records.runtimeScopes.find(
        (s) => s.instanceId === c.instanceId && s.scopeRef === c.scopeRef,
      );
    const folder = JSON.parse(String(project.folder_json));
    if (
      !scope ||
      records.runtimeResources.find((r) => r.handle === scope.resourceHandle)
        ?.path !== folder.canonicalPath
    )
      fail("该 Runtime scope 不属于项目文件夹。");
    const link: ProjectRuntimeLink = {
      instanceId: scope.instanceId,
      scopeRef: scope.scopeRef,
      bindingRef: scope.bindingRef,
      resourceHandle: scope.resourceHandle,
    };
    usable(db, link);
    if (work.runtime) {
      if (JSON.stringify(work.runtime) === JSON.stringify(link)) return;
      fail("项目已关联其他 Runtime，不能覆盖已有对话和执行归属。");
    }
    const used = db
      .prepare(
        "SELECT project_id FROM project_runtime WHERE instance_id=? AND scope_ref=?",
      )
      .get(c.instanceId, c.scopeRef);
    if (used) fail("该 Runtime scope 已关联另一项目。");
    db.prepare("INSERT INTO project_runtime VALUES(?,?,?,?)").run(
      c.projectId,
      JSON.stringify(link),
      c.instanceId,
      c.scopeRef,
    );
    db.prepare(
      "UPDATE projects SET revision=revision+1,updated_at=? WHERE id=?",
    ).run(at, c.projectId);
    return;
  }
  if (c.type === "role") {
    const link = work.runtime;
    if (!link) fail("请先关联项目 Runtime。");
    usable(db, link);
    const selected = selectedModel(db, c.connectionId, c.model);
    if (selected.provider !== (c.role === "implementer" ? "claude" : "codex"))
      fail("所选 Agent 不支持该角色。");
    if (c.effort !== null && !selected.effort?.levels.includes(c.effort))
      fail("所选模型未记录该推理强度。");
    const old = readRoleBinding(
      db,
      link.instanceId,
      link.scopeRef,
      `role:${c.role}`,
    );
    if ((old?.updatedAt ?? null) !== c.expectedUpdatedAt)
      fail("角色配置已变化，请重新读取后保存。");
    applyRoleBindingUpsert(db, {
      instanceId: link.instanceId,
      scopeRef: link.scopeRef,
      roleIntent: `role:${c.role}`,
      connectionId: c.connectionId,
      model: c.model,
      effort: c.effort,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(old?.updatedAt ?? "1970-01-01") + 1),
      ).toISOString(),
    });
    return;
  }
  const chat = work.chats.find((x) => x.conversationId === c.conversationId);
  if (!chat) fail("对话不属于当前项目。");
  assertConversationAvailable(db, c.conversationId);
  if (chat.revision !== c.revision) fail("讨论对象已变化，请重新核对。");
  if (
    db
      .prepare(
        "SELECT 1 FROM turns WHERE conversation_id=? AND state NOT IN ('completed','stopped','failed','interrupted')",
      )
      .get(c.conversationId)
  )
    fail("当前对话正在执行，请结束后再切换讨论对象。");
  let context: ProjectChatContext | null = null;
  if (c.objectRef) {
    const link = work.runtime;
    if (!link) fail("项目尚未关联 Runtime。");
    usable(db, link);
    const object = readProjection(
      db,
      link.instanceId,
      link.scopeRef,
    ).objects.find((o) => o.objectRef === c.objectRef);
    if (!object || object.revision !== c.objectRevision)
      fail("对象已变化，请重新选择讨论对象。");
    context = {
      ...link,
      objectRef: object.objectRef,
      revision: object.revision,
      title: object.title,
      stateLabel: object.stateLabel,
    };
  }
  db.prepare(
    "UPDATE project_chats SET context_json=?,revision=revision+1 WHERE conversation_id=?",
  ).run(context ? JSON.stringify(context) : null, c.conversationId);
}
/** Called within submitTurn's transaction. Renderer text cannot supply an authority or execution target. */
export function captureProjectTurn(
  db: DatabaseSync,
  conversationId: string,
  revision: number | undefined,
): {
  projectId: string;
  context: ProjectChatContext | null;
  text: string;
} | null {
  const row = db
    .prepare(
      "SELECT project_id,context_json,revision FROM project_chats WHERE conversation_id=?",
    )
    .get(conversationId);
  if (!row) return null;
  if (row.revision !== revision)
    fail("讨论对象选择已变化，请重新核对后发送；草稿已保留。");
  validateProjectHistory(db, conversationId);
  const project = db
    .prepare("SELECT name,goal FROM projects WHERE id=?")
    .get(row.project_id)!;
  const context: ProjectChatContext | null = row.context_json
    ? JSON.parse(String(row.context_json))
    : null;
  if (context) {
    usable(db, context);
    const object = readProjection(
      db,
      context.instanceId,
      context.scopeRef,
    ).objects.find((o) => o.objectRef === context.objectRef);
    if (!object || object.revision !== context.revision)
      fail("讨论对象的版本已变化，请明确重新选择；草稿已保留。");
  }
  return {
    projectId: String(row.project_id),
    context,
    text: JSON.stringify({
      project: { id: row.project_id, name: project.name, goal: project.goal },
      object: context
        ? {
            id: context.objectRef,
            revision: context.revision,
            title: context.title,
            state: context.stateLabel,
          }
        : null,
    }),
  };
}
function validateProjectHistory(db: DatabaseSync, conversationId: string) {
  for (const row of db
    .prepare(
      "SELECT p.context_json FROM project_turn_contexts p JOIN turns t ON t.id=p.turn_id WHERE t.conversation_id=?",
    )
    .all(conversationId)) {
    const context: ProjectChat["context"] = JSON.parse(
      String(row.context_json),
    );
    if (context) usable(db, context);
  }
}
export function validateProjectTurn(
  db: DatabaseSync,
  turnId: string,
): string | null {
  const turn = db
    .prepare("SELECT conversation_id FROM turns WHERE id=?")
    .get(turnId);
  if (turn) validateProjectHistory(db, String(turn.conversation_id));
  const row = db
    .prepare(
      "SELECT context_json,text FROM project_turn_contexts WHERE turn_id=?",
    )
    .get(turnId);
  if (!row) return null;
  const context: ProjectChat["context"] = JSON.parse(String(row.context_json));
  if (context) usable(db, context);
  return String(row.text);
}
