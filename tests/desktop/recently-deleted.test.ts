import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Store, schemaVersion } from "../../src/service/store";
import { applyRecentlyDeleted } from "../../src/service/recently-deleted";
import { inspectProjectFolder } from "../../src/main/projects";
import { buildWidgetPackage } from "../../src/main/widget-package";
import { widgetFixture } from "../../src/main/widget-fixture";
import { retentionMs } from "../../src/shared/recently-deleted";
import type { Command, HostCommand, Reply } from "../../src/shared/protocol";
import { seedRetainedWidgets } from "./widget-generation-fixture";
import { setTimeout as wait } from "node:timers/promises";
import {
  WidgetGenerationRunner,
  type GenerationExecution,
} from "../../src/main/widget-generation";
import { compileWidget } from "../../src/main/widget-build";
import { widgetSubmitToolName } from "../../src/shared/widget-generation-tool";

function root(name: string) {
  mkdirSync(".test-data/disposable", { recursive: true });
  return mkdtempSync(
    resolve(`.test-data/disposable/recently-deleted-${name}-`),
  );
}
function ok(reply: Reply) {
  if (!reply.ok) throw new Error(reply.message);
  return reply;
}
const run = (store: Store, c: Command, surface: "main" | "panel" = "main") =>
  store.execute(c, surface);
const host = (store: Store, c: HostCommand) => store.execute(c, "main", "host");
const widgets = (store: Store) =>
  store.snapshot().widgetGeneration!.widgets.map((w) => w.name);
const trash = (store: Store) => store.snapshot().recentlyDeleted!;
function deleteWidget(store: Store, name: string, confirmed = true) {
  const w = store
    .snapshot()
    .widgetGeneration!.widgets.find((w) => w.name === name)!;
  return run(store, {
    type: "deleteWidget",
    id: w.id,
    revision: w.revision,
    confirmed,
  });
}
function restoreWidget(store: Store, name: string) {
  const d = trash(store).widgets.find((w) => w.name === name)!;
  return run(store, {
    type: "restoreDeleted",
    kind: "widget",
    id: d.id,
    revision: d.trashRevision,
  });
}
function searchWidgetIds(store: Store) {
  return (
    store.db
      .prepare(
        "SELECT DISTINCT object_id FROM search_documents WHERE kind='widget'",
      )
      .all() as { object_id: string }[]
  ).map((row) => row.object_id);
}
/** An edit candidate for one retained widget, produced by the offline generation commands (no model). */
function editCandidate(store: Store, widgetId: string, name: string) {
  const id = randomUUID();
  ok(run(store, { type: "createWidgetEditDraft", id, widgetIds: [widgetId] }));
  ok(
    run(store, {
      type: "saveWidgetDraft",
      id,
      revision: 0,
      name,
      input: "改成更大的字号",
    }),
  );
  ok(
    run(store, {
      type: "submitWidgetGeneration",
      draftId: id,
      requestId: randomUUID(),
      revision: 1,
      connectionId: store.snapshot().connections[0].id,
      model: "offline-only",
    }),
  );
  const t = store
    .snapshot()
    .widgetGeneration!.tasks.find((t) => t.draftId === id)!;
  ok(
    host(store, {
      type: "claimWidgetGeneration",
      taskId: t.id,
      executionId: t.executionId,
    }),
  );
  return { draftId: id, task: t };
}
function finishCandidate(
  store: Store,
  task: { id: string; executionId: string },
  name: string,
) {
  const source = JSON.parse(widgetFixture);
  source.name = name;
  source.view.css = `${source.view.css} body{font-size:20px}`;
  ok(
    host(store, {
      type: "receiveWidgetCandidate",
      taskId: task.id,
      executionId: task.executionId,
      build: buildWidgetPackage(JSON.stringify(source)),
    }),
  );
  ok(
    host(store, {
      type: "finishWidgetGeneration",
      taskId: task.id,
      executionId: task.executionId,
      state: "completed",
      error: null,
    }),
  );
  return store
    .snapshot()
    .widgetGeneration!.candidates.find((c) => c.taskId === task.id)!;
}
function retain(
  store: Store,
  c: { id: string; digest: string; requirementRevision: number },
) {
  return run(store, {
    type: "retainWidgetCandidate",
    candidateId: c.id,
    digest: c.digest,
    requirementRevision: c.requirementRevision,
  });
}

test("recently deleted: deleting a retained widget needs confirmation and its revision, keeps its neighbours and drops it from the order, the panel and search", () => {
  const dir = root("widget");
  seedRetainedWidgets(dir, ["甲", "乙", "丙", "丁"]);
  const store = new Store(dir);
  try {
    const before = store.snapshot();
    const second = before.widgetGeneration!.widgets[1];
    const unconfirmed = deleteWidget(store, "乙", false);
    assert.equal(!unconfirmed.ok && unconfirmed.code, "INVALID_COMMAND");
    const stale = run(store, {
      type: "deleteWidget",
      id: second.id,
      revision: second.revision + 1,
      confirmed: true,
    });
    assert.equal(!stale.ok && stale.code, "CONFLICT");
    const panel = run(
      store,
      {
        type: "deleteWidget",
        id: second.id,
        revision: second.revision,
        confirmed: true,
      },
      "panel",
    );
    // The business service accepts the command from either surface; the panel's IPC refuses it before it gets here.
    assert(panel.ok);
    assert.deepEqual(widgets(store), ["甲", "丙", "丁"]);
    const after = store.snapshot().widgetGeneration!;
    assert.deepEqual(
      after.widgets.map((w) => w.position),
      [1, 2, 3],
    );
    assert.equal(
      after.orderRevision,
      before.widgetGeneration!.orderRevision + 1,
    );
    const [entry] = trash(store).widgets;
    assert.equal(entry.id, second.id);
    assert.equal(entry.name, "乙");
    assert.equal(entry.previousId, before.widgetGeneration!.widgets[0].id);
    assert.equal(entry.nextId, before.widgetGeneration!.widgets[2].id);
    assert.equal(
      Date.parse(entry.retainUntil) - Date.parse(entry.deletedAt),
      retentionMs,
    );
    assert.equal(entry.protection, null);
    assert(!searchWidgetIds(store).includes(second.id));
    const again = run(store, {
      type: "deleteWidget",
      id: second.id,
      revision: second.revision,
      confirmed: true,
    });
    assert.equal(!again.ok && again.code, "NOT_FOUND");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recently deleted: views of a deleted widget lose their instances; a late write is refused and its data stays", () => {
  const dir = root("late");
  seedRetainedWidgets(dir, ["便笺", "计时"]);
  const store = new Store(dir);
  try {
    const w = store.snapshot().widgetGeneration!.widgets[0];
    const preview = store.db
      .prepare(
        "SELECT widget_id,version,data,data_revision FROM widget_previews WHERE candidate_id=?",
      )
      .get(w.candidateId)!;
    const identity = {
      widgetId: String(preview.widget_id),
      candidateId: w.candidateId,
      version: String(preview.version),
      surface: "main" as const,
      generation: randomUUID(),
    };
    ok(host(store, { type: "widgetBind", identity }));
    const panelIdentity = {
      ...identity,
      surface: "panel" as const,
      generation: randomUUID(),
    };
    assert(
      store.execute(
        { type: "widgetBind", identity: panelIdentity },
        "panel",
        "host",
      ).ok,
    );
    ok(deleteWidget(store, "便笺"));
    const late = host(store, {
      type: "widgetRequest",
      identity,
      request: {
        method: "writeData",
        revision: Number(preview.data_revision),
        value: { text: "迟到" },
      },
    } as HostCommand);
    assert.equal(late.ok, false);
    const latePanel = store.execute(
      {
        type: "widgetRequest",
        identity: panelIdentity,
        request: {
          method: "writeData",
          revision: Number(preview.data_revision),
          value: { text: "迟到" },
        },
      } as HostCommand,
      "panel",
      "host",
    );
    assert.equal(latePanel.ok, false);
    // A new view cannot bind to the deleted widget either.
    assert.equal(
      host(store, {
        type: "widgetBind",
        identity: { ...identity, generation: randomUUID() },
      }).ok,
      false,
    );
    const now = store.db
      .prepare(
        "SELECT data,data_revision,active FROM widget_previews WHERE candidate_id=?",
      )
      .get(w.candidateId)!;
    assert.equal(now.data, preview.data);
    assert.equal(now.data_revision, preview.data_revision);
    assert.equal(now.active, 0);
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM widget_instances WHERE candidate_id=?",
        )
        .get(w.candidateId)!.n,
      0,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recently deleted: a candidate formed before the widget's deletion is refused, also after a restore", () => {
  const dir = root("candidate");
  seedRetainedWidgets(dir, ["汇率"]);
  const store = new Store(dir);
  try {
    const w = store.snapshot().widgetGeneration!.widgets[0];
    const { task } = editCandidate(store, w.id, "汇率");
    const candidate = finishCandidate(store, task, "汇率");
    ok(deleteWidget(store, "汇率"));
    const refused = retain(store, candidate);
    assert.equal(refused.ok, false);
    assert.deepEqual(widgets(store), []);
    ok(restoreWidget(store, "汇率"));
    assert.deepEqual(widgets(store), ["汇率"]);
    const stillRefused = retain(store, candidate);
    assert.equal(stillRefused.ok, false);
    const restored = store.snapshot().widgetGeneration!.widgets[0];
    assert.equal(restored.id, w.id);
    assert.equal(restored.candidateId, w.candidateId);
    assert.equal(restored.digest, w.digest);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recently deleted: a restored widget keeps its identity and data and goes back next to its former neighbours", () => {
  const dir = root("restore");
  seedRetainedWidgets(dir, ["甲", "乙", "丙", "丁"]);
  let store = new Store(dir);
  try {
    const original = store.snapshot().widgetGeneration!.widgets;
    store.db
      .prepare(
        "UPDATE widget_previews SET data=?,data_revision=data_revision+1 WHERE candidate_id=?",
      )
      .run(JSON.stringify({ text: "乙的便笺" }), original[1].candidateId);
    ok(deleteWidget(store, "乙"));
    // The order changes after the deletion: 丁 moves to the front.
    const order = store.snapshot().widgetGeneration!;
    ok(
      run(store, {
        type: "moveWidget",
        widgetId: original[3].id,
        toIndex: 0,
        orderRevision: order.orderRevision,
      }),
    );
    assert.deepEqual(widgets(store), ["丁", "甲", "丙"]);
    // Across a restart of the business service.
    store.close();
    store = new Store(dir);
    const reply = ok(restoreWidget(store, "乙"));
    assert.deepEqual(reply.restoredWidget, {
      id: original[1].id,
      placement: "after",
    });
    assert.deepEqual(widgets(store), ["丁", "甲", "乙", "丙"]);
    assert.equal(trash(store).widgets.length, 0);
    const back = store
      .snapshot()
      .widgetGeneration!.widgets.find((w) => w.name === "乙")!;
    assert.equal(back.id, original[1].id);
    assert.equal(
      store.db
        .prepare("SELECT data,active FROM widget_previews WHERE candidate_id=?")
        .get(back.candidateId)!.data,
      JSON.stringify({ text: "乙的便笺" }),
    );
    assert(searchWidgetIds(store).includes(back.id));
    // The previous neighbour is gone, the next one is still there: before it.
    ok(deleteWidget(store, "乙"));
    ok(deleteWidget(store, "甲"));
    const second = ok(restoreWidget(store, "乙"));
    assert.equal(second.restoredWidget!.placement, "before");
    assert.deepEqual(widgets(store), ["丁", "乙", "丙"]);
    // Neither neighbour remains: the end of the order.
    ok(deleteWidget(store, "乙"));
    ok(deleteWidget(store, "丁"));
    ok(deleteWidget(store, "丙"));
    ok(restoreWidget(store, "甲"));
    const third = ok(restoreWidget(store, "乙"));
    assert.equal(third.restoredWidget!.placement, "end");
    assert.deepEqual(widgets(store), ["甲", "乙"]);
    // A restore does not start any work.
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM widget_generation_tasks WHERE state IN ('queued','running')",
        )
        .get()!.n,
      0,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recently deleted: extension adds 30 days to the later of the retention end and now; stale revisions are refused", () => {
  const dir = root("extend");
  seedRetainedWidgets(dir, ["甲"]);
  const store = new Store(dir);
  try {
    ok(deleteWidget(store, "甲"));
    const entry = trash(store).widgets[0];
    const now = new Date().toISOString();
    store.db.exec("BEGIN");
    applyRecentlyDeleted(
      store.db,
      {
        type: "extendDeleted",
        kind: "widget",
        id: entry.id,
        revision: entry.trashRevision,
      },
      now,
    );
    store.db.exec("COMMIT");
    const once = trash(store).widgets[0];
    assert.equal(
      Date.parse(once.retainUntil),
      Date.parse(entry.retainUntil) + retentionMs,
    );
    // An expired entry stays (no silent permanent deletion) and extends from now.
    store.db
      .prepare("UPDATE deleted_widgets SET retain_until=? WHERE id=?")
      .run("2026-01-01T00:00:00.000Z", entry.id);
    const later = "2026-03-01T00:00:00.000Z";
    store.db.exec("BEGIN");
    applyRecentlyDeleted(
      store.db,
      {
        type: "extendDeleted",
        kind: "widget",
        id: entry.id,
        revision: once.trashRevision,
      },
      later,
    );
    store.db.exec("COMMIT");
    assert.equal(
      trash(store).widgets[0].retainUntil,
      new Date(Date.parse(later) + retentionMs).toISOString(),
    );
    const stale = run(store, {
      type: "extendDeleted",
      kind: "widget",
      id: entry.id,
      revision: once.trashRevision,
    });
    assert.equal(!stale.ok && stale.code, "CONFLICT");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recently deleted: a permanent deletion needs its own confirmation, rechecks generation targets when it commits and keeps conversations", () => {
  const dir = root("purge");
  seedRetainedWidgets(dir, ["甲", "乙"]);
  const store = new Store(dir);
  try {
    const conversation = randomUUID();
    ok(run(store, { type: "create", id: conversation }));
    const [first] = store.snapshot().widgetGeneration!.widgets;
    // A generation that targets 甲 is still running when 甲 goes to recently deleted: it is asked to stop.
    const { task } = editCandidate(store, first.id, "甲");
    ok(deleteWidget(store, "甲"));
    let entry = trash(store).widgets[0];
    assert.match(entry.protection ?? "", /进行中的生成任务/);
    const purge = (confirmed: boolean) =>
      run(store, {
        type: "purgeDeleted",
        kind: "widget",
        id: entry.id,
        revision: entry.trashRevision,
        confirmed,
      });
    const unconfirmed = purge(false);
    assert.equal(!unconfirmed.ok && unconfirmed.code, "INVALID_COMMAND");
    const protectedReply = purge(true);
    assert.equal(!protectedReply.ok && protectedReply.code, "CONFLICT");
    assert.equal(trash(store).widgets.length, 1);
    ok(
      host(store, {
        type: "finishWidgetGeneration",
        taskId: task.id,
        executionId: task.executionId,
        state: "stopped",
        error: null,
      }),
    );
    entry = trash(store).widgets[0];
    assert.equal(entry.protection, null);
    ok(purge(true));
    assert.equal(trash(store).widgets.length, 0);
    const tomb = store.db
      .prepare(
        "SELECT d.purged_at,p.data,p.config,p.drafts,p.active FROM deleted_widgets d JOIN widget_previews p ON p.candidate_id=d.candidate_id WHERE d.id=?",
      )
      .get(first.id)!;
    assert(tomb.purged_at);
    assert.equal(tomb.data, "{}");
    assert.equal(tomb.drafts, "{}");
    assert.equal(tomb.active, 0);
    // A permanently deleted widget cannot come back; its conversations and the other widget stay.
    const restore = run(store, {
      type: "restoreDeleted",
      kind: "widget",
      id: first.id,
      revision: entry.trashRevision + 1,
    });
    assert.equal(!restore.ok && restore.code, "NOT_FOUND");
    assert(store.snapshot().conversations.some((c) => c.id === conversation));
    assert.deepEqual(widgets(store), ["乙"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function projectFixture(name: string) {
  const dir = root(name);
  const folder = join(dir, "repository");
  mkdirSync(join(folder, "src"), { recursive: true });
  writeFileSync(join(folder, "README.md"), "外部仓库\n");
  writeFileSync(join(folder, "src", "main.txt"), "源码\n");
  const data = join(dir, "data");
  mkdirSync(data);
  const info = await inspectProjectFolder(folder);
  const f = {
    dir,
    folder,
    data,
    store: new Store(data),
    create(projectName: string) {
      const id = randomUUID();
      ok(
        host(f.store, {
          type: "projectCreate",
          id,
          name: projectName,
          goal: `${projectName}的目标`,
          folder: info,
        }),
      );
      return id;
    },
  };
  return f;
}
function digest(folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        out[full.slice(folder.length)] = createHash("sha256")
          .update(readFileSync(full))
          .digest("hex");
    }
  };
  walk(folder);
  return out;
}
const project = (store: Store, id: string) =>
  store.snapshot().projects.find((p) => p.id === id);
function deleteProject(store: Store, id: string, confirmed = true) {
  const p = project(store, id)!;
  return run(store, {
    type: "deleteProject",
    id,
    revision: p.revision,
    confirmed,
  });
}

test("recently deleted: deleting a project only removes its organization record; conversations, events and the folder stay, same-name projects are separate", async () => {
  const f = await projectFixture("project");
  try {
    const before = digest(f.folder);
    const first = f.create("同名项目");
    const second = f.create("同名项目");
    const chat = randomUUID();
    ok(
      f.store.execute(
        {
          type: "projectWork",
          request: { type: "chat", projectId: first, conversationId: chat },
        } as HostCommand,
        "main",
        "host",
      ),
    );
    ok(
      run(f.store, {
        type: "projectPin",
        id: first,
        pinned: true,
        revision: project(f.store, first)!.revision,
      }),
    );
    const unconfirmed = deleteProject(f.store, first, false);
    assert.equal(!unconfirmed.ok && unconfirmed.code, "INVALID_COMMAND");
    const stale = run(f.store, {
      type: "deleteProject",
      id: first,
      revision: 0,
      confirmed: true,
    });
    assert.equal(!stale.ok && stale.code, "CONFLICT");
    ok(deleteProject(f.store, first));
    const snapshot = f.store.snapshot();
    assert.deepEqual(
      snapshot.projects.map((p) => p.id),
      [second],
    );
    assert.equal(
      snapshot.pinnedOrder.some((r) => r.kind === "project" && r.id === first),
      false,
    );
    const [entry] = snapshot.recentlyDeleted!.projects;
    assert.equal(entry.id, first);
    assert.equal(entry.name, "同名项目");
    assert.equal(entry.chatCount, 1);
    // The conversation stays in the recent list as an ordinary conversation.
    const c = snapshot.conversations.find((c) => c.id === chat)!;
    assert.equal(c.deletedAt, null);
    assert.equal(
      f.store.db
        .prepare("SELECT project_id FROM project_chats WHERE conversation_id=?")
        .get(chat)!.project_id,
      first,
    );
    // Project commands and project work refuse a deleted project.
    const edit = run(f.store, {
      type: "projectEdit",
      id: first,
      name: "改名",
      goal: "",
      revision: entry.revision,
    });
    assert.equal(!edit.ok && edit.code, "NOT_FOUND");
    // Search no longer finds it; the other same-name project stays findable.
    const projectHits = f.store.db
      .prepare(
        "SELECT DISTINCT d.object_id FROM search_documents d JOIN projects p ON p.id=d.object_id WHERE d.kind='project' AND p.deleted_at IS NULL",
      )
      .all()
      .map((row) => row.object_id);
    assert.deepEqual(projectHits, [second]);
    assert.deepEqual(
      f.store.db
        .prepare(
          "SELECT kind FROM project_events WHERE project_id=? ORDER BY rowid",
        )
        .all(first)
        .map((r) => r.kind)
        .slice(-1),
      ["deleted"],
    );
    // Restore across a restart: back in the list, not pinned again, the conversation still belongs to it.
    f.store.close();
    f.store = new Store(f.data);
    const back = f.store.snapshot().recentlyDeleted!.projects[0];
    ok(
      run(f.store, {
        type: "restoreDeleted",
        kind: "project",
        id: first,
        revision: back.revision,
      }),
    );
    const restored = project(f.store, first)!;
    assert.equal(restored.pinnedAt, null);
    assert.deepEqual(
      restored.chats.map((c) => c.conversationId),
      [chat],
    );
    assert.deepEqual(digest(f.folder), before);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("recently deleted: a conversation purged while its project was deleted is not brought back by the restore", async () => {
  const f = await projectFixture("relation");
  try {
    const id = f.create("项目");
    const kept = randomUUID();
    const purged = randomUUID();
    for (const chat of [kept, purged])
      ok(
        f.store.execute(
          {
            type: "projectWork",
            request: { type: "chat", projectId: id, conversationId: chat },
          } as HostCommand,
          "main",
          "host",
        ),
      );
    ok(deleteProject(f.store, id));
    const organize = (action: "delete" | "purge") => {
      const c = f.store.snapshot().conversations.find((c) => c.id === purged)!;
      ok(
        run(f.store, {
          type: "organizeConversation",
          id: purged,
          action,
          revision: c.organizationRevision,
          confirmed: true,
        }),
      );
    };
    organize("delete");
    organize("purge");
    const entry = f.store.snapshot().recentlyDeleted!.projects[0];
    assert.equal(entry.chatCount, 1);
    ok(
      run(f.store, {
        type: "restoreDeleted",
        kind: "project",
        id,
        revision: entry.revision,
      }),
    );
    assert.deepEqual(
      project(f.store, id)!.chats.map((c) => c.conversationId),
      [kept],
    );
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

function linkRuntime(
  store: Store,
  projectId: string,
  operationStatus: string | null,
  executionState: string | null,
) {
  const instance = randomUUID();
  const scope = "scope-1";
  store.db.exec("PRAGMA foreign_keys=OFF");
  store.db
    .prepare(
      "INSERT INTO project_runtime(project_id,record,instance_id,scope_ref) VALUES(?,?,?,?)",
    )
    .run(
      projectId,
      JSON.stringify({ instanceId: instance, scopeRef: scope }),
      instance,
      scope,
    );
  if (operationStatus)
    store.db
      .prepare(
        "INSERT INTO runtime_operations(operation_id,instance_id,scope_ref,method,idempotency_key,record,created_at,updated_at,touched) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        instance,
        scope,
        "task.publish",
        null,
        JSON.stringify({ status: operationStatus }),
        "2026-10-25T00:00:00.000Z",
        "2026-10-25T00:00:00.000Z",
        1,
      );
  if (executionState)
    store.db
      .prepare(
        "INSERT INTO runtime_executions(execution_ref,instance_id,scope_ref,operation_id,resource_handle,execution_id,state,record,created_at,updated_at,touched) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        instance,
        scope,
        randomUUID(),
        "resource",
        randomUUID(),
        executionState,
        "{}",
        "2026-10-25T00:00:00.000Z",
        "2026-10-25T00:00:00.000Z",
        1,
      );
  store.db.exec("PRAGMA foreign_keys=ON");
  return { instance, scope };
}

test("recently deleted: unknown results block a project deletion; running work blocks only the permanent one, rechecked when it commits", async () => {
  const f = await projectFixture("protect");
  try {
    const unknown = f.create("结果未知");
    linkRuntime(f.store, unknown, "unknown", null);
    const refused = deleteProject(f.store, unknown);
    assert.equal(!refused.ok && refused.code, "CONFLICT");
    assert.match(!refused.ok ? refused.message : "", /结果未知/);
    assert(project(f.store, unknown));
    const running = f.create("执行中");
    const link = linkRuntime(f.store, running, null, "running");
    ok(deleteProject(f.store, running));
    let entry = f.store.snapshot().recentlyDeleted!.projects[0];
    assert.match(entry.protection ?? "", /执行中的工作/);
    const purge = () =>
      run(f.store, {
        type: "purgeDeleted",
        kind: "project",
        id: running,
        revision: entry.revision,
        confirmed: true,
      });
    const blocked = purge();
    assert.equal(!blocked.ok && blocked.code, "CONFLICT");
    f.store.db
      .prepare(
        "UPDATE runtime_executions SET state='completed' WHERE instance_id=?",
      )
      .run(link.instance);
    entry = f.store.snapshot().recentlyDeleted!.projects[0];
    assert.equal(entry.protection, null);
    // The protection is checked again when the purge commits: new unknown work after the page was drawn refuses it.
    f.store.db.exec("PRAGMA foreign_keys=OFF");
    f.store.db
      .prepare(
        "INSERT INTO runtime_operations(operation_id,instance_id,scope_ref,method,idempotency_key,record,created_at,updated_at,touched) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        link.instance,
        link.scope,
        "task.publish",
        null,
        JSON.stringify({ status: "accepted" }),
        "2026-10-25T00:00:00.000Z",
        "2026-10-25T00:00:00.000Z",
        2,
      );
    f.store.db.exec("PRAGMA foreign_keys=ON");
    assert.equal(purge().ok, false);
    f.store.db
      .prepare("DELETE FROM runtime_operations WHERE instance_id=?")
      .run(link.instance);
    ok(purge());
    assert.equal(f.store.snapshot().recentlyDeleted!.projects.length, 0);
    const row = f.store.db
      .prepare("SELECT purged_at,name FROM projects WHERE id=?")
      .get(running)!;
    assert(row.purged_at);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM runtime_executions WHERE instance_id=?",
        )
        .get(link.instance)!.n,
      1,
    );
    assert.deepEqual(
      f.store.db
        .prepare(
          "SELECT kind FROM project_events WHERE project_id=? ORDER BY rowid",
        )
        .all(running)
        .map((r) => r.kind),
      ["projectCreate", "deleted", "purged"],
    );
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("recently deleted: schema 35 data upgrades to 36 with every object kept and one verified backup", async () => {
  const f = await projectFixture("upgrade");
  try {
    f.store.close();
    seedRetainedWidgets(f.data, ["甲", "乙"]);
    f.store = new Store(f.data);
    const id = f.create("升级项目");
    const before = f.store.snapshot();
    // Back to the version 0.2.4 wrote: no deleted widgets table and no project deletion columns.
    f.store.db.exec(`DROP TABLE deleted_widgets;
      ALTER TABLE projects DROP COLUMN deleted_at;
      ALTER TABLE projects DROP COLUMN retain_until;
      ALTER TABLE projects DROP COLUMN purged_at;
      PRAGMA user_version=35;`);
    f.store.close();
    f.store = new Store(f.data);
    assert.equal(
      (
        f.store.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
      schemaVersion,
    );
    assert.equal(schemaVersion, 36);
    const after = f.store.snapshot();
    assert.deepEqual(
      after.projects.map((p) => p.id),
      [id],
    );
    assert.deepEqual(
      after.widgetGeneration!.widgets.map((w) => [w.id, w.position]),
      before.widgetGeneration!.widgets.map((w) => [w.id, w.position]),
    );
    assert.deepEqual(after.recentlyDeleted, { projects: [], widgets: [] });
    const backups = readdirSync(dirname(f.data)).filter((name) =>
      name.startsWith(`${basename(f.data)}-schema-35-backup-`),
    );
    assert.equal(backups.length, 1);
    ok(deleteProject(f.store, id));
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("recently deleted: a generation running for a widget is asked to stop by its deletion, shows stopping until the executor confirms and forms no candidate", async () => {
  const dir = root("stop");
  seedRetainedWidgets(dir, ["汇率", "天气"]);
  const store = new Store(dir);
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>((r) => (release = r));
  const runner = new WidgetGenerationRunner(
    async (c: HostCommand) => store.execute(c, "main", "host"),
    async (o: GenerationExecution) => {
      entered = true;
      o.onDelta("改到一半");
      await gate;
      if (o.signal.aborted) throw o.signal.reason;
      await o.invoke({
        id: "late",
        type: "function",
        function: {
          name: widgetSubmitToolName,
          arguments: JSON.stringify({ package: widgetFixture }),
        },
      });
    },
    () => {},
    (s) => compileWidget(s, resolve("dist/widget-build-worker.cjs")),
  );
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("condition timed out");
      await wait(5);
    }
  };
  try {
    const [target, other] = store.snapshot().widgetGeneration!.widgets;
    // One edit draft targets the widget that goes; another one targets the widget that stays.
    const first = editCandidate(store, target.id, "汇率");
    const kept = randomUUID();
    ok(
      run(store, {
        type: "createWidgetEditDraft",
        id: kept,
        widgetIds: [other.id],
      }),
    );
    ok(
      run(store, {
        type: "saveWidgetDraft",
        id: kept,
        revision: 0,
        name: "天气",
        input: "换个配色",
      }),
    );
    ok(
      run(store, {
        type: "submitWidgetGeneration",
        draftId: kept,
        requestId: randomUUID(),
        revision: 1,
        connectionId: store.snapshot().connections[0].id,
        model: "offline-only",
      }),
    );
    // The first task was claimed by the fixture; give it back to the runner as a running execution.
    const task = () =>
      store
        .snapshot()
        .widgetGeneration!.tasks.find((t) => t.id === first.task.id)!;
    const queued = () =>
      store.snapshot().widgetGeneration!.tasks.find((t) => t.draftId === kept)!;
    store.db
      .prepare("UPDATE widget_generation_tasks SET state='queued' WHERE id=?")
      .run(first.task.id);
    runner.adopt(store.snapshot(), 0);
    await until(() => entered);
    assert.equal(task().state, "running");
    ok(deleteWidget(store, "汇率"));
    // Asked to stop: stopping until the executor confirms; the draft and its input stay.
    assert.equal(task().state, "stopping");
    assert.equal(queued().state, "queued");
    assert(
      store
        .snapshot()
        .widgetGeneration!.drafts.some(
          (d) => d.id === first.draftId && !d.deleted,
        ),
    );
    runner.adopt(store.snapshot(), 1);
    release();
    await until(() => task().state === "stopped");
    assert.equal(task().stopUnconfirmed, false);
    assert.equal(
      store
        .snapshot()
        .widgetGeneration!.candidates.filter((c) => c.taskId === first.task.id)
        .length,
      0,
    );
    assert.deepEqual(widgets(store), ["天气"]);
  } finally {
    release();
    await runner.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
