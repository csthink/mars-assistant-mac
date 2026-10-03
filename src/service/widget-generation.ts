import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { StoreError } from "./errors";
import { selectedModel } from "./models";
import { applyWidgetHost } from "./widgets";
import { widgetDifferences } from "../shared/widget-diff";
import { verifyBuiltWidget } from "../main/widget-package";
import type { BuiltWidget } from "../shared/widget";
import type { ConnectionSnapshot, Message } from "../shared/protocol";
import {
  generationLimits,
  type WidgetDraft,
  type GenerationTask,
  type GeneratedCandidate,
  type GenerationContext,
  type WidgetGenerationSnapshot,
  type WidgetGenerationCommand,
  type WidgetGenerationHostCommand,
} from "../shared/widget-generation";

export const widgetGenerationSchema = `
CREATE TABLE widget_drafts(id TEXT PRIMARY KEY,name TEXT NOT NULL,input TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 0,requirement_revision INTEGER NOT NULL DEFAULT 0,source_conversation_id TEXT REFERENCES conversations(id),widget_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE widget_generation_tasks(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES widget_drafts(id),request_id TEXT NOT NULL UNIQUE,execution_id TEXT NOT NULL UNIQUE,attempt INTEGER NOT NULL DEFAULT 1,requirement TEXT NOT NULL,requirement_revision INTEGER NOT NULL,state TEXT NOT NULL,connection TEXT NOT NULL,context TEXT NOT NULL,partial_text TEXT NOT NULL DEFAULT '',error TEXT,candidate_id TEXT,created_at TEXT NOT NULL,ended_at TEXT);
CREATE TABLE widget_generation_attempts(execution_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES widget_generation_tasks(id),attempt INTEGER NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,ended_at TEXT);
CREATE TABLE generated_candidates(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES widget_generation_tasks(id),draft_id TEXT NOT NULL REFERENCES widget_drafts(id),digest TEXT NOT NULL,name TEXT NOT NULL,requirement_revision INTEGER NOT NULL,state TEXT NOT NULL,build TEXT NOT NULL,differences TEXT NOT NULL,widget_id TEXT);
CREATE TABLE saved_widgets(id TEXT PRIMARY KEY,name TEXT NOT NULL,candidate_id TEXT NOT NULL UNIQUE REFERENCES generated_candidates(id),digest TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,position INTEGER NOT NULL);
CREATE TABLE widget_generation_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,execution_id TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL,detail TEXT NOT NULL);
CREATE TRIGGER widget_events_no_update BEFORE UPDATE ON widget_generation_events BEGIN SELECT RAISE(ABORT,'widget events are append-only'); END;
CREATE TRIGGER widget_events_no_delete BEFORE DELETE ON widget_generation_events BEGIN SELECT RAISE(ABORT,'widget events are append-only'); END;
`;
const terminal = (s: string) =>
  ["completed", "stopped", "failed", "interrupted"].includes(s);
function refuse(message: string): never {
  throw new StoreError("CONFLICT", message);
}
const draftColumns =
  "id,name,input,revision,requirement_revision AS requirementRevision,source_conversation_id AS sourceConversationId,widget_id AS widgetId,created_at AS createdAt,updated_at AS updatedAt";
const taskColumns =
  "id,draft_id AS draftId,request_id AS requestId,execution_id AS executionId,attempt,requirement,requirement_revision AS requirementRevision,state,connection,partial_text AS partialText,error,candidate_id AS candidateId,created_at AS createdAt,ended_at AS endedAt";
const candidateColumns =
  "id,task_id AS taskId,draft_id AS draftId,digest,name,requirement_revision AS requirementRevision,state,differences,widget_id AS widgetId";
function draft(db: DatabaseSync, id: string): WidgetDraft {
  const d = db
    .prepare(`SELECT ${draftColumns} FROM widget_drafts WHERE id=?`)
    .get(id) as unknown as WidgetDraft;
  if (!d) refuse("草稿不存在，请重新选择。");
  return d;
}
function task(db: DatabaseSync, id: string): GenerationTask {
  const t = db
    .prepare(`SELECT ${taskColumns} FROM widget_generation_tasks WHERE id=?`)
    .get(id);
  if (!t) refuse("生成任务不存在。");
  return {
    ...t,
    connection: JSON.parse(String(t.connection)),
  } as unknown as GenerationTask;
}
function event(
  db: DatabaseSync,
  t: GenerationTask,
  kind: string,
  now: string,
  detail: unknown = {},
) {
  db.prepare(
    "INSERT INTO widget_generation_events(task_id,execution_id,kind,at,detail) VALUES(?,?,?,?,?)",
  ).run(t.id, t.executionId, kind, now, JSON.stringify(detail));
}
function state(
  db: DatabaseSync,
  t: GenerationTask,
  next: string,
  now: string,
  error: string | null = null,
) {
  const ended = terminal(next) ? now : null;
  db.prepare(
    "UPDATE widget_generation_tasks SET state=?,error=?,ended_at=? WHERE id=?",
  ).run(next, error, ended, t.id);
  db.prepare(
    "UPDATE widget_generation_attempts SET state=?,ended_at=? WHERE execution_id=?",
  ).run(next, ended, t.executionId);
  event(db, t, next, now, { from: t.state, error });
}
export function waitingCount(db: DatabaseSync) {
  return Number(
    db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM widget_generation_tasks WHERE state='queued') + (SELECT COUNT(*) FROM executions WHERE state='queued' AND id NOT IN (SELECT execution_id FROM runtime_executions WHERE state='reserved')) AS n",
      )
      .get()!.n,
  );
}
export function assertQueueSpace(db: DatabaseSync) {
  if (waitingCount(db) >= generationLimits.waiting)
    refuse("等待队列已满，请稍后重试。输入已保留，尚未接收。");
}
export function activeModelCount(db: DatabaseSync) {
  return Number(
    db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM widget_generation_tasks WHERE state IN ('running','stopping')) + (SELECT COUNT(*) FROM executions WHERE state IN ('running','awaiting_authorization','stopping')) + (SELECT COUNT(*) FROM runtime_executions WHERE state='reserved') AS n",
      )
      .get()!.n,
  );
}
function capture(
  db: DatabaseSync,
  d: WidgetDraft,
  connection: ConnectionSnapshot,
): GenerationContext {
  if (!d.sourceConversationId)
    return {
      messages: [],
      attachments: [],
      access: { grantedConnections: [], permissionRevision: 0 },
    };
  const c = db
    .prepare(
      "SELECT granted_connections,revision,deleted_at,purged_at FROM conversations WHERE id=?",
    )
    .get(d.sourceConversationId);
  if (!c || c.deleted_at || c.purged_at)
    refuse("来源对话已不可用，任务未接收。");
  const grants = JSON.parse(String(c.granted_connections)) as string[];
  const prior = db
    .prepare(
      "SELECT connection_snapshot FROM turns WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(d.sourceConversationId);
  if (prior) {
    const p = JSON.parse(
      String(prior.connection_snapshot),
    ) as ConnectionSnapshot;
    const dest = `${connection.connectionId}|${connection.baseUrl}`;
    if (`${p.connectionId}|${p.baseUrl}` !== dest && !grants.includes(dest))
      refuse("向另一提供方发送历史前需要确认范围，任务未接收。");
  }
  const messages = db
    .prepare(
      "SELECT id,conversation_id AS conversationId,turn_id AS turnId,role,content,created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY created_at,rowid",
    )
    .all(d.sourceConversationId) as unknown as Message[];
  const attachments = db
    .prepare(
      "SELECT a.id AS attachmentId,a.sha256,m.message_id AS messageId,m.position FROM message_attachments m JOIN attachments a ON a.id=m.attachment_id JOIN messages x ON x.id=m.message_id WHERE x.conversation_id=? ORDER BY x.rowid,m.position",
    )
    .all(d.sourceConversationId) as unknown as GenerationContext["attachments"];
  return {
    messages,
    attachments,
    access: {
      grantedConnections: grants,
      permissionRevision: Number(c.revision),
    },
  };
}
export function widgetGenerationSnapshot(
  db: DatabaseSync,
): WidgetGenerationSnapshot {
  return {
    drafts: db
      .prepare(
        `SELECT ${draftColumns} FROM widget_drafts ORDER BY updated_at DESC,rowid DESC`,
      )
      .all() as unknown as WidgetDraft[],
    tasks: db
      .prepare(
        `SELECT ${taskColumns} FROM widget_generation_tasks ORDER BY created_at,rowid`,
      )
      .all()
      .map((t) => ({
        ...t,
        connection: JSON.parse(String(t.connection)),
      })) as unknown as GenerationTask[],
    candidates: db
      .prepare(
        `SELECT ${candidateColumns} FROM generated_candidates ORDER BY rowid`,
      )
      .all()
      .map((c) => ({
        ...c,
        differences: JSON.parse(String(c.differences)),
      })) as unknown as GeneratedCandidate[],
    selected: Object.fromEntries(
      ["main", "panel"].map((surface) => [
        surface,
        db
          .prepare(
            "SELECT draft_id FROM widget_draft_selection WHERE surface=?",
          )
          .get(surface)?.draft_id ?? null,
      ]),
    ) as { main: string | null; panel: string | null },
    widgets: db
      .prepare(
        "SELECT id,name,candidate_id AS candidateId,digest,revision,position FROM saved_widgets ORDER BY position",
      )
      .all() as unknown as WidgetGenerationSnapshot["widgets"],
  };
}
export function recoverWidgetGeneration(db: DatabaseSync, now: string) {
  const tasks = db
    .prepare(
      "SELECT id FROM widget_generation_tasks WHERE state IN ('queued','running','stopping')",
    )
    .all();
  for (const row of tasks)
    state(
      db,
      task(db, String(row.id)),
      "interrupted",
      now,
      "应用已重新启动。任务未自动重发，请核对后重试。",
    );
  return tasks.length;
}
export function applyWidgetGeneration(
  db: DatabaseSync,
  c: WidgetGenerationCommand,
  now: string,
  surface: "main" | "panel" = "main",
) {
  if (c.type === "selectWidgetDraft") {
    if (c.id) draft(db, c.id);
    db.prepare(
      "INSERT INTO widget_draft_selection(surface,draft_id) VALUES(?,?) ON CONFLICT(surface) DO UPDATE SET draft_id=excluded.draft_id",
    ).run(surface, c.id);
    return;
  }
  if (c.type === "createWidgetDraft") {
    if (db.prepare("SELECT 1 FROM widget_drafts WHERE id=?").get(c.id)) return;
    if (
      c.sourceConversationId &&
      !db
        .prepare(
          "SELECT 1 FROM conversations WHERE id=? AND deleted_at IS NULL AND purged_at IS NULL",
        )
        .get(c.sourceConversationId)
    )
      refuse("来源对话不存在，草稿未创建。");
    db.prepare(
      "INSERT INTO widget_drafts(id,name,source_conversation_id,created_at,updated_at) VALUES(?,?,?,?,?)",
    ).run(c.id, c.name, c.sourceConversationId, now, now);
    return;
  }
  if (c.type === "saveWidgetDraft") {
    const d = draft(db, c.id);
    if (d.revision !== c.revision)
      refuse("草稿已在另一入口改变，当前输入未保存，请核对。");
    db.prepare(
      "UPDATE widget_drafts SET name=?,input=?,revision=revision+1,updated_at=? WHERE id=?",
    ).run(c.name, c.input, now, c.id);
    return;
  }
  if (c.type === "submitWidgetGeneration") {
    const old = db
      .prepare(
        "SELECT draft_id FROM widget_generation_tasks WHERE request_id=?",
      )
      .get(c.requestId);
    if (old) {
      if (old.draft_id !== c.draftId) refuse("提交身份已被另一草稿使用。");
      return;
    }
    const d = draft(db, c.draftId);
    if (d.revision !== c.revision)
      refuse("草稿修订已改变，生成未接收，输入已保留。");
    if (d.widgetId) refuse("此控件已保留；正式控件持续修改尚未开放。");
    if (!d.input.trim()) refuse("请输入控件需求。");
    if (
      db
        .prepare(
          "SELECT 1 FROM widget_generation_tasks WHERE draft_id=? AND state NOT IN ('completed','stopped','failed','interrupted')",
        )
        .get(d.id)
    )
      refuse("此草稿还有生成任务，请先停止再提交新需求。");
    assertQueueSpace(db);
    const model = selectedModel(db, c.connectionId, c.model);
    const {
      imageInput: _imageInput,
      contextChars,
      effort,
      ...connection
    } = model;
    void _imageInput;
    const fixed = {
      ...connection,
      effort: effort?.defaultLevel ?? null,
    } as ConnectionSnapshot;
    const context = capture(db, d, fixed);
    if (
      JSON.stringify(context).length + d.input.length >
      (contextChars ?? 64000)
    )
      refuse("相关历史与需求超过模型上下文预算，任务未接收。");
    const id = randomUUID(),
      executionId = randomUUID();
    db.prepare(
      "INSERT INTO widget_generation_tasks(id,draft_id,request_id,execution_id,requirement,requirement_revision,state,connection,context,created_at) VALUES(?,?,?,?,?,?,'queued',?,?,?)",
    ).run(
      id,
      d.id,
      c.requestId,
      executionId,
      d.input,
      d.requirementRevision + 1,
      JSON.stringify(fixed),
      JSON.stringify(context),
      now,
    );
    db.prepare(
      "INSERT INTO widget_generation_attempts(execution_id,task_id,attempt,state,created_at) VALUES(?,?,1,'queued',?)",
    ).run(executionId, id, now);
    db.prepare(
      "UPDATE widget_drafts SET input='',revision=revision+1,requirement_revision=requirement_revision+1,updated_at=? WHERE id=?",
    ).run(now, d.id);
    event(db, task(db, id), "accepted", now);
    return;
  }
  if (c.type === "stopWidgetGeneration") {
    const t = task(db, c.taskId);
    if (terminal(t.state) || t.state === "stopping") return;
    state(db, t, t.state === "queued" ? "stopped" : "stopping", now);
    return;
  }
  if (c.type === "retryWidgetGeneration") {
    const t = task(db, c.taskId),
      d = draft(db, t.draftId);
    if (c.attempt < t.attempt) return;
    if (
      c.attempt !== t.attempt ||
      !["failed", "stopped", "interrupted"].includes(t.state)
    )
      refuse("任务不能重试，请核对当前状态。");
    if (t.requirementRevision !== d.requirementRevision || d.widgetId)
      refuse("该需求已过期，请重新提交当前需求。");
    if (t.attempt >= generationLimits.attempts)
      refuse("已达到三次尝试上限，请检查原因后提交新需求。");
    const live = selectedModel(
      db,
      t.connection.connectionId,
      t.connection.model,
    );
    if (live.revision !== t.connection.revision)
      refuse("连接已改变，请核对并重新提交需求。");
    assertQueueSpace(db);
    const executionId = randomUUID();
    db.prepare(
      "UPDATE widget_generation_tasks SET state='queued',attempt=attempt+1,execution_id=?,candidate_id=NULL,partial_text='',error=NULL,ended_at=NULL WHERE id=?",
    ).run(executionId, t.id);
    db.prepare(
      "INSERT INTO widget_generation_attempts(execution_id,task_id,attempt,state,created_at) VALUES(?,?,?,'queued',?)",
    ).run(executionId, t.id, t.attempt + 1, now);
    event(db, task(db, t.id), "retry", now);
    return;
  }
  const row = db
    .prepare("SELECT * FROM generated_candidates WHERE id=?")
    .get(c.candidateId);
  if (
    !row ||
    row.digest !== c.digest ||
    row.requirement_revision !== c.requirementRevision
  )
    refuse("候选身份或版本已改变，请重新核对。");
  if (c.type === "retainWidgetCandidate" && row.state === "retained") return;
  if (c.type === "discardWidgetCandidate" && row.state === "discarded") return;
  if (row.state !== "preview") refuse("候选已处理或没有变化，不能执行此操作。");
  if (
    c.type === "retainWidgetCandidate" &&
    !JSON.parse(String(row.differences)).length
  )
    refuse("没有实际变化，无需保留。");
  const d = draft(db, String(row.draft_id));
  if (c.type === "discardWidgetCandidate") {
    db.prepare(
      "UPDATE generated_candidates SET state='discarded' WHERE id=?",
    ).run(c.candidateId);
    db.prepare("DELETE FROM widget_instances WHERE candidate_id=?").run(
      c.candidateId,
    );
    db.prepare("UPDATE widget_previews SET active=0 WHERE candidate_id=?").run(
      c.candidateId,
    );
    event(db, task(db, String(row.task_id)), "discarded", now, {
      candidateId: c.candidateId,
    });
    return;
  }
  if (d.requirementRevision !== c.requirementRevision || d.widgetId)
    refuse("需求或正式版本已变化，候选未保留。");
  const t = task(db, String(row.task_id));
  if (t.state !== "completed" || t.candidateId !== c.candidateId)
    refuse("生成尚未成功结束或候选尝试已过期，候选未保留。");
  const widgetId = randomUUID();
  db.prepare(
    "INSERT INTO saved_widgets(id,name,candidate_id,digest,position) VALUES(?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM saved_widgets))",
  ).run(widgetId, row.name, c.candidateId, c.digest);
  db.prepare(
    "UPDATE widget_drafts SET widget_id=?,updated_at=? WHERE id=?",
  ).run(widgetId, now, d.id);
  db.prepare(
    "UPDATE generated_candidates SET state='retained',widget_id=? WHERE id=?",
  ).run(widgetId, c.candidateId);
  // Publish the confirmed configuration/data together with the stable identity.
  // Revoke preview instance grants so late messages cannot write the formal widget.
  db.prepare("UPDATE widget_previews SET widget_id=? WHERE candidate_id=?").run(
    widgetId,
    c.candidateId,
  );
  db.prepare(
    "DELETE FROM widget_instances WHERE candidate_id IN (SELECT id FROM generated_candidates WHERE draft_id=?)",
  ).run(d.id);
  db.prepare(
    "UPDATE widget_previews SET active=0 WHERE candidate_id IN (SELECT id FROM generated_candidates WHERE draft_id=? AND state='preview')",
  ).run(d.id);
  db.prepare(
    "UPDATE generated_candidates SET state='discarded' WHERE draft_id=? AND state='preview'",
  ).run(d.id);
  event(db, t, "retained", now, { candidateId: c.candidateId, widgetId });
}
export function applyWidgetGenerationHost(
  db: DatabaseSync,
  c: WidgetGenerationHostCommand,
  now: string,
): {
  generationContext?: GenerationContext;
  generationTask?: GenerationTask;
  generatedBuild?: BuiltWidget;
} {
  if (c.type === "loadGeneratedWidget") {
    const row = db
      .prepare(
        "SELECT build FROM generated_candidates WHERE id=? AND state IN ('preview','retained')",
      )
      .get(c.candidateId);
    if (!row) refuse("候选已失效或已撤销。");
    return { generatedBuild: JSON.parse(String(row.build)) as BuiltWidget };
  }
  const t = task(db, c.taskId);
  if (t.executionId !== c.executionId)
    refuse("执行尝试已过期，迟到结果未应用。");
  if (c.type === "loadWidgetGeneration") {
    if (t.state !== "running") refuse("生成尚未领取或已结束。");
    return {
      generationTask: t,
      generationContext: JSON.parse(
        String(
          db
            .prepare("SELECT context FROM widget_generation_tasks WHERE id=?")
            .get(t.id)!.context,
        ),
      ),
    };
  }
  if (c.type === "claimWidgetGeneration") {
    if (t.state !== "queued") refuse("生成任务不可重复领取。");
    if (
      activeModelCount(db) >= generationLimits.active ||
      db
        .prepare(
          "SELECT 1 FROM widget_generation_tasks WHERE state IN ('running','stopping')",
        )
        .get()
    )
      refuse("生成容量已占用，任务继续等待。");
    state(db, t, "running", now);
    return {};
  }
  if (c.type === "finishWidgetGeneration") {
    if (terminal(t.state)) return {};
    if (t.state === "stopping" && !["stopped", "interrupted"].includes(c.state))
      refuse("停止已先提交，迟到完成结果未应用。");
    if (c.state === "completed" && !t.candidateId)
      refuse("没有通过校验的候选，不能标记生成完成。");
    state(db, t, c.state, now, c.error);
    return {};
  }
  if (c.type === "widgetGenerationDelta") {
    if (!["running", "stopping"].includes(t.state))
      refuse("任务已结束，迟到内容未应用。");
    if (t.partialText.length + c.text.length > 1_000_000)
      refuse("生成输出超过预算。");
    db.prepare(
      "UPDATE widget_generation_tasks SET partial_text=partial_text||? WHERE id=?",
    ).run(c.text, t.id);
    return {};
  }
  if (t.state !== "running") refuse("任务已停止或结束，迟到内容未应用。");
  if (t.requirementRevision !== draft(db, t.draftId).requirementRevision)
    refuse("候选采用旧需求，未进入预览。");
  if (t.candidateId) {
    const old = db
      .prepare("SELECT digest FROM generated_candidates WHERE id=?")
      .get(t.candidateId);
    if (old?.digest === c.build.digest) return {};
    refuse("该尝试已提交候选，不能替换用户看到的版本。");
  }
  if (!verifyBuiltWidget(c.build)) refuse("候选产物摘要或包规范无效。");
  const id = randomUUID(),
    build = c.build;
  const old = db
    .prepare(
      "SELECT c.build FROM widget_drafts d JOIN saved_widgets w ON w.id=d.widget_id JOIN generated_candidates c ON c.id=w.candidate_id WHERE d.id=?",
    )
    .get(t.draftId);
  const prior = old ? (JSON.parse(String(old.build)) as BuiltWidget) : null;
  const differences = widgetDifferences(prior, build);
  const unchanged = differences.length === 0;
  db.prepare(
    "INSERT INTO generated_candidates(id,task_id,draft_id,digest,name,requirement_revision,state,build,differences) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    t.id,
    t.draftId,
    build.digest,
    build.manifest.name,
    t.requirementRevision,
    unchanged ? "unchanged" : "preview",
    JSON.stringify(build),
    JSON.stringify(differences),
  );
  db.prepare(
    "UPDATE widget_generation_tasks SET candidate_id=? WHERE id=?",
  ).run(id, t.id);
  if (!unchanged)
    applyWidgetHost(db, {
      type: "widgetCreate",
      candidateId: id,
      widgetId: t.draftId,
      version: build.digest,
      definition: {
        name: build.manifest.name,
        config: build.manifest.config,
        draftFields: build.manifest.draftFields,
        capabilities: build.manifest.capabilities,
      },
    });
  event(db, t, unchanged ? "unchanged" : "candidate", now, {
    candidateId: id,
    digest: build.digest,
  });
  return {};
}
