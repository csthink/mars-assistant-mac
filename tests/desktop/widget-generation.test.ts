import { test } from "node:test";
import { WidgetGenerationRunner } from "../../src/main/widget-generation";
import {
  widgetRealAuthorization,
  runWidgetProviderChecks,
} from "./real-widget-authorization";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/service/store";
import { buildWidgetPackage } from "../../src/main/widget-package";
import type { Command, HostCommand } from "../../src/shared/protocol";
import type { GenerationTask } from "../../src/shared/widget-generation";
function setup() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/widget-generation-"));
  const store = new Store(root),
    connectionId = randomUUID(),
    conversationId = randomUUID();
  const command = (c: Command) => store.execute(c, "main");
  assert(command({ type: "create", id: conversationId }).ok);
  assert(
    command({
      type: "upsertConnection",
      id: connectionId,
      name: "Offline generator",
      provider: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      secretRef: randomUUID(),
      imageInput: "unknown",
      contextChars: null,
      revision: 0,
    }).ok,
  );
  return {
    store,
    root,
    connectionId,
    conversationId,
    close() {
      this.store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function draft(
  s: ReturnType<typeof setup>,
  input = "Make an abacus",
  source: string | null = null,
) {
  const id = randomUUID();
  assert(
    s.store.execute(
      {
        type: "createWidgetDraft",
        id,
        name: "同名草稿",
        sourceConversationId: source,
      },
      "main",
    ).ok,
  );
  assert(
    s.store.execute(
      { type: "saveWidgetDraft", id, name: "同名草稿", input, revision: 0 },
      "main",
    ).ok,
  );
  return id;
}
function submit(
  s: ReturnType<typeof setup>,
  draftId: string,
  requestId = randomUUID(),
  revision = 1,
) {
  const c: Command = {
    type: "submitWidgetGeneration",
    draftId,
    requestId,
    revision,
    connectionId: s.connectionId,
    model: "test-model",
  };
  return {
    command: c,
    reply: s.store.execute(c, "main"),
    task: s.store
      .snapshot()
      .widgetGeneration!.tasks.find((t) => t.requestId === requestId)!,
  };
}
const host = (store: Store, c: HostCommand) => store.execute(c, "main", "host");
function claim(s: ReturnType<typeof setup>, t: GenerationTask) {
  return host(s.store, {
    type: "claimWidgetGeneration",
    taskId: t.id,
    executionId: t.executionId,
  });
}
const built = () =>
  buildWidgetPackage(
    JSON.stringify({
      schemaVersion: 1,
      name: "Abacus",
      view: { html: "<p>0</p>", css: "p{color:navy}", js: "" },
      config: [],
      draftFields: [],
      capabilities: [],
      resources: [],
    }),
  );
function candidate(s: ReturnType<typeof setup>, t: GenerationTask) {
  assert(claim(s, t).ok);
  assert(
    host(s.store, {
      type: "receiveWidgetCandidate",
      taskId: t.id,
      executionId: t.executionId,
      build: built(),
    }).ok,
  );
  assert(
    host(s.store, {
      type: "finishWidgetGeneration",
      taskId: t.id,
      executionId: t.executionId,
      state: "completed",
      error: null,
    }).ok,
  );
  return s.store.snapshot().widgetGeneration!.candidates.at(-1)!;
}
test("widget generation: independent same-name drafts, exact revisions and failed writes preserve confirmed input", () => {
  const s = setup();
  try {
    const a = draft(s, "first"),
      b = draft(s, "second"),
      before = s.store.snapshot();
    assert.equal(before.widgetGeneration!.drafts.length, 2);
    assert.equal(
      s.store.execute(
        {
          type: "saveWidgetDraft",
          id: a,
          name: "changed",
          input: "old",
          revision: 0,
        },
        "panel",
      ).ok,
      false,
    );
    assert.deepEqual(s.store.snapshot(), before);
    s.store.db.exec("PRAGMA query_only=ON");
    assert.equal(
      s.store.execute(
        {
          type: "saveWidgetDraft",
          id: b,
          name: "changed",
          input: "failed",
          revision: 1,
        },
        "main",
      ).ok,
      false,
    );
    s.store.db.exec("PRAGMA query_only=OFF");
    assert.deepEqual(s.store.snapshot(), before);
  } finally {
    s.close();
  }
});
test("widget generation: durable acceptance deduplicates, freezes context and connection and clears only confirmed draft", () => {
  const s = setup();
  try {
    s.store.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user',?,?)",
      )
      .run(
        randomUUID(),
        s.conversationId,
        "fixed context",
        new Date().toISOString(),
      );
    const id = draft(s, "Create an abacus", s.conversationId),
      accepted = submit(s, id);
    assert(accepted.reply.ok, JSON.stringify(accepted.reply));
    assert(s.store.execute(accepted.command, "panel").ok);
    assert.equal(s.store.snapshot().widgetGeneration!.tasks.length, 1);
    assert.equal(s.store.snapshot().widgetGeneration!.drafts[0].input, "");
    s.store.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user',?,?)",
      )
      .run(
        randomUUID(),
        s.conversationId,
        "later unrelated context",
        new Date().toISOString(),
      );
    assert(claim(s, accepted.task).ok);
    const result = host(s.store, {
      type: "loadWidgetGeneration",
      taskId: accepted.task.id,
      executionId: accepted.task.executionId,
    });
    assert(result.ok);
    assert.deepEqual(
      result.generationContext!.messages.map((m) => m.content),
      ["fixed context"],
    );
    assert.deepEqual(result.generationContext!.attachments, []);
    assert.equal(result.generationTask!.connection.model, "test-model");
    assert.equal(
      s.store.execute({ type: "deleteConnection", id: s.connectionId }, "main")
        .ok,
      false,
    );
    assert.equal(
      s.store.execute(
        {
          type: "claimWidgetGeneration",
          taskId: accepted.task.id,
          executionId: accepted.task.executionId,
        },
        "main",
      ).ok,
      false,
    );
  } finally {
    s.close();
  }
});
test("widget generation: twenty waiting requests are bounded and rejected submissions keep their input", () => {
  const s = setup();
  try {
    for (let n = 0; n < 20; n++) {
      const a = submit(s, draft(s));
      assert(a.reply.ok, JSON.stringify(a.reply));
    }
    const id = draft(s, "keep this input"),
      before = s.store.snapshot();
    const denied = submit(s, id);
    assert.equal(denied.reply.ok, false);
    assert.deepEqual(s.store.snapshot(), before);
    assert.equal(
      s.store.execute(
        {
          type: "submitTurn",
          conversationId: s.conversationId,
          connectionId: s.connectionId,
          requestId: randomUUID(),
          text: "foreground",
        },
        "main",
      ).ok,
      false,
    );
    assert.equal(
      s.store.snapshot().widgetGeneration!.drafts.find((d) => d.id === id)!
        .input,
      "keep this input",
    );
  } finally {
    s.close();
  }
});
test("widget generation: generation reserves foreground capacity and cancellation never changes foreground state", () => {
  const s = setup();
  try {
    const first = submit(s, draft(s)).task,
      second = submit(s, draft(s)).task;
    assert(claim(s, first).ok);
    assert.equal(claim(s, second).ok, false);
    assert(
      s.store.execute(
        {
          type: "submitTurn",
          conversationId: s.conversationId,
          connectionId: s.connectionId,
          requestId: randomUUID(),
          text: "unrelated question",
        },
        "main",
      ).ok,
    );
    const foreground = s.store.snapshot().activeTurns[0];
    assert(
      host(s.store, {
        type: "beginExecution",
        executionId: foreground.executionId,
      }).ok,
    );
    assert(
      s.store.execute(
        { type: "stopWidgetGeneration", taskId: first.id },
        "main",
      ).ok,
    );
    assert.equal(
      host(s.store, {
        type: "receiveWidgetCandidate",
        taskId: first.id,
        executionId: first.executionId,
        build: built(),
      }).ok,
      false,
    );
    assert.equal(
      host(s.store, {
        type: "finishWidgetGeneration",
        taskId: first.id,
        executionId: first.executionId,
        state: "completed",
        error: null,
      }).ok,
      false,
    );
    assert.equal(s.store.snapshot().activeTurns[0].state, "running");
    assert(
      host(s.store, {
        type: "finishWidgetGeneration",
        taskId: first.id,
        executionId: first.executionId,
        state: "stopped",
        error: null,
      }).ok,
    );
    assert(claim(s, second).ok);
    assert(
      s.store.execute(
        { type: "stopExecution", executionId: foreground.executionId },
        "main",
      ).ok,
    );
    assert.equal(
      s.store
        .snapshot()
        .widgetGeneration!.tasks.find((t) => t.id === second.id)!.state,
      "running",
    );
  } finally {
    s.close();
  }
});
test("widget generation: restart interrupts queued and running attempts without replay; explicit retry rejects old results", () => {
  const s = setup();
  try {
    const a = submit(s, draft(s)).task,
      b = submit(s, draft(s)).task;
    assert(claim(s, a).ok);
    s.store.close();
    s.store = new Store(s.root);
    assert.deepEqual(
      s.store.snapshot().widgetGeneration!.tasks.map((t) => t.state),
      ["interrupted", "interrupted"],
    );
    assert.equal(claim(s, b).ok, false);
    assert(
      s.store.execute(
        { type: "retryWidgetGeneration", taskId: a.id, attempt: 1 },
        "main",
      ).ok,
    );
    assert(
      s.store.execute(
        { type: "retryWidgetGeneration", taskId: a.id, attempt: 1 },
        "main",
      ).ok,
    );
    const retry = s.store
      .snapshot()
      .widgetGeneration!.tasks.find((t) => t.id === a.id)!;
    assert.equal(retry.attempt, 2);
    assert.notEqual(retry.executionId, a.executionId);
    assert.equal(
      host(s.store, {
        type: "receiveWidgetCandidate",
        taskId: a.id,
        executionId: a.executionId,
        build: built(),
      }).ok,
      false,
    );
    assert.equal(
      s.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM widget_generation_attempts WHERE task_id=?",
        )
        .get(a.id)!.n,
      2,
    );
  } finally {
    s.close();
  }
});
test("widget generation: candidate retain is atomic and idempotent; discard never rolls back a saved widget", () => {
  const s = setup();
  try {
    const a = submit(s, draft(s)).task,
      c = candidate(s, a),
      before = s.store.snapshot();
    assert.equal(before.widgetGeneration!.widgets.length, 0);
    const retain: Command = {
      type: "retainWidgetCandidate",
      candidateId: c.id,
      digest: c.digest,
      requirementRevision: c.requirementRevision,
    };
    s.store.db.exec(
      "CREATE TRIGGER fail_saved_draft BEFORE UPDATE OF widget_id ON widget_drafts BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    assert.equal(s.store.execute(retain, "main").ok, false);
    assert.deepEqual(s.store.snapshot(), before);
    s.store.db.exec("DROP TRIGGER fail_saved_draft");
    assert(s.store.execute(retain, "main").ok);
    assert(s.store.execute(retain, "panel").ok);
    assert.equal(s.store.snapshot().widgetGeneration!.widgets.length, 1);
    assert.equal(
      s.store.execute({ ...retain, type: "discardWidgetCandidate" }, "main").ok,
      false,
    );
    assert.equal(s.store.snapshot().widgetGeneration!.drafts.length, 1);
    const b = submit(s, draft(s)).task,
      other = candidate(s, b);
    assert(
      s.store.execute(
        {
          type: "discardWidgetCandidate",
          candidateId: other.id,
          digest: other.digest,
          requirementRevision: other.requirementRevision,
        },
        "main",
      ).ok,
    );
    assert.equal(s.store.snapshot().widgetGeneration!.widgets.length, 1);
    assert.equal(s.store.snapshot().widgetGeneration!.tasks.length, 2);
  } finally {
    s.close();
  }
});
test("widget generation: changed requirement and forged artifact cannot become a retained candidate", () => {
  const s = setup();
  try {
    const id = draft(s),
      a = submit(s, id).task,
      c = candidate(s, a);
    assert(
      s.store.execute(
        {
          type: "saveWidgetDraft",
          id,
          name: "同名草稿",
          input: "new requirement",
          revision: 2,
        },
        "main",
      ).ok,
    );
    const next = submit(s, id, randomUUID(), 3);
    assert(next.reply.ok);
    assert.equal(
      s.store.execute(
        {
          type: "retainWidgetCandidate",
          candidateId: c.id,
          digest: c.digest,
          requirementRevision: c.requirementRevision,
        },
        "main",
      ).ok,
      false,
    );
    assert(claim(s, next.task).ok);
    const tampered = structuredClone(built());
    tampered.resources["view.js"].data = "Zm9yZ2Vk";
    assert.equal(
      host(s.store, {
        type: "receiveWidgetCandidate",
        taskId: next.task.id,
        executionId: next.task.executionId,
        build: tampered,
      }).ok,
      false,
    );
    assert.equal(s.store.snapshot().widgetGeneration!.widgets.length, 0);
  } finally {
    s.close();
  }
});

test("widget generation: editor selections persist independently by surface and reject missing identities", () => {
  const s = setup();
  try {
    const a = draft(s),
      b = draft(s);
    assert(s.store.execute({ type: "selectWidgetDraft", id: a }, "main").ok);
    assert(s.store.execute({ type: "selectWidgetDraft", id: b }, "panel").ok);
    assert.equal(
      s.store.execute({ type: "selectWidgetDraft", id: randomUUID() }, "main")
        .ok,
      false,
    );
    s.store.close();
    s.store = new Store(s.root);
    assert.deepEqual(s.store.snapshot().widgetGeneration!.selected, {
      main: a,
      panel: b,
    });
    assert.equal(s.store.snapshot().widgetGeneration!.tasks.length, 0);
  } finally {
    s.close();
  }
});

test("widget generation: identical unretained history does not block a legitimate first addition", () => {
  const s = setup();
  try {
    const id = draft(s),
      first = submit(s, id).task,
      old = candidate(s, first);
    assert(
      s.store.execute(
        {
          type: "saveWidgetDraft",
          id,
          name: "same",
          input: "updated requirement",
          revision: 2,
        },
        "main",
      ).ok,
    );
    const next = submit(s, id, randomUUID(), 3).task;
    assert(claim(s, next).ok);
    const receive: HostCommand = {
      type: "receiveWidgetCandidate",
      taskId: next.id,
      executionId: next.executionId,
      build: built(),
    };
    assert(host(s.store, receive).ok);
    assert(host(s.store, receive).ok);
    assert.equal(s.store.snapshot().widgetGeneration!.candidates.length, 2);
    const c = s.store.snapshot().widgetGeneration!.candidates.at(-1)!;
    assert.equal(c.state, "preview");
    assert(c.differences.every((d) => d.before === null));
    assert(
      host(s.store, {
        type: "finishWidgetGeneration",
        taskId: next.id,
        executionId: next.executionId,
        state: "completed",
        error: null,
      }).ok,
    );
    assert(
      s.store.execute(
        {
          type: "retainWidgetCandidate",
          candidateId: c.id,
          digest: c.digest,
          requirementRevision: c.requirementRevision,
        },
        "main",
      ).ok,
    );
    assert.equal(
      s.store
        .snapshot()
        .widgetGeneration!.candidates.find((c) => c.id === old.id)!.state,
      "discarded",
    );
    assert.equal(s.store.snapshot().widgetGeneration!.widgets.length, 1);
  } finally {
    s.close();
  }
});
test("widget generation: empty actual differences are explained and cannot create a version", () => {
  const s = setup();
  try {
    const first = submit(s, draft(s)).task,
      c = candidate(s, first);
    assert(
      s.store.execute(
        {
          type: "retainWidgetCandidate",
          candidateId: c.id,
          digest: c.digest,
          requirementRevision: c.requirementRevision,
        },
        "main",
      ).ok,
    );
    const formal = s.store.snapshot().widgetGeneration!.widgets[0];
    const other = randomUUID();
    assert(
      s.store.execute(
        { type: "createWidgetEditDraft", id: other, widgetIds: [formal.id] },
        "main",
      ).ok,
    );
    assert(
      s.store.execute(
        {
          type: "saveWidgetDraft",
          id: other,
          name: formal.name,
          input: "Keep identical content",
          revision: 0,
        },
        "main",
      ).ok,
    );
    const next = submit(s, other).task;
    const unchanged = candidate(s, next);
    assert.equal(unchanged.state, "unchanged");
    assert.deepEqual(unchanged.differences, []);
    const reply = s.store.execute(
      {
        type: "retainWidgetCandidate",
        candidateId: unchanged.id,
        digest: unchanged.digest,
        requirementRevision: unchanged.requirementRevision,
      },
      "main",
    );
    assert(!reply.ok);
    assert.match(reply.message, /没有变化/);
    assert.equal(s.store.snapshot().widgetGeneration!.widgets.length, 1);
    assert.equal(s.store.snapshot().widgetGeneration!.widgets[0].revision, 1);
  } finally {
    s.close();
  }
});
test("widget generation: first retain promotes confirmed configuration and revokes stale preview writes atomically", () => {
  const s = setup();
  try {
    const t = submit(s, draft(s)).task,
      c = candidate(s, t);
    const identity = {
      widgetId: t.draftId,
      candidateId: c.id,
      version: c.digest,
      generation: randomUUID(),
      surface: "main" as const,
    };
    assert(host(s.store, { type: "widgetBind", identity }).ok);
    s.store.db
      .prepare(
        "UPDATE widget_previews SET data=?,data_revision=1 WHERE candidate_id=?",
      )
      .run(JSON.stringify({ confirmed: "value" }), c.id);
    const retain: Command = {
      type: "retainWidgetCandidate",
      candidateId: c.id,
      digest: c.digest,
      requirementRevision: c.requirementRevision,
    };
    s.store.db.exec(
      "CREATE TRIGGER fail_promotion BEFORE UPDATE OF widget_id ON widget_previews BEGIN SELECT RAISE(ABORT,'fail promotion'); END",
    );
    assert(!s.store.execute(retain, "main").ok);
    assert.equal(s.store.snapshot().widgetGeneration!.widgets.length, 0);
    assert.equal(
      s.store.db.prepare("SELECT COUNT(*) AS n FROM widget_instances").get()!.n,
      1,
    );
    s.store.db.exec("DROP TRIGGER fail_promotion");
    assert(s.store.execute(retain, "main").ok);
    const reply = host(s.store, { type: "widgetInspect", candidateId: c.id });
    assert(reply.ok);
    assert.equal(
      reply.widgetPreview!.widgetId,
      s.store.snapshot().widgetGeneration!.widgets[0].id,
    );
    assert.deepEqual(reply.widgetPreview!.data, { confirmed: "value" });
    assert.equal(
      s.store.db.prepare("SELECT COUNT(*) AS n FROM widget_instances").get()!.n,
      0,
    );
    assert(
      !host(s.store, {
        type: "widgetRequest",
        identity,
        request: { method: "readData" },
      }).ok,
    );
  } finally {
    s.close();
  }
});
test("widget generation: a failed attempt candidate cannot be retained after a later attempt completes", () => {
  const s = setup();
  try {
    const t = submit(s, draft(s)).task;
    assert(claim(s, t).ok);
    assert(
      host(s.store, {
        type: "receiveWidgetCandidate",
        taskId: t.id,
        executionId: t.executionId,
        build: built(),
      }).ok,
    );
    const previous = s.store.snapshot().widgetGeneration!.candidates.at(-1)!;
    assert(
      host(s.store, {
        type: "finishWidgetGeneration",
        taskId: t.id,
        executionId: t.executionId,
        state: "failed",
        error: "process exit not confirmed",
      }).ok,
    );
    assert(
      s.store.execute(
        { type: "retryWidgetGeneration", taskId: t.id, attempt: 1 },
        "main",
      ).ok,
    );
    const retry = s.store
      .snapshot()
      .widgetGeneration!.tasks.find((task) => task.id === t.id)!;
    const current = candidate(s, retry);
    assert.notEqual(current.id, previous.id);
    const rejected = s.store.execute(
      {
        type: "retainWidgetCandidate",
        candidateId: previous.id,
        digest: previous.digest,
        requirementRevision: previous.requirementRevision,
      },
      "main",
    );
    assert(!rejected.ok);
    assert.match(rejected.message, /尝试已过期/);
    assert.equal(s.store.snapshot().widgetGeneration!.widgets.length, 0);
    assert(
      s.store.execute(
        {
          type: "retainWidgetCandidate",
          candidateId: current.id,
          digest: current.digest,
          requirementRevision: current.requirementRevision,
        },
        "main",
      ).ok,
    );
    const snapshot = s.store.snapshot().widgetGeneration!;
    assert.equal(snapshot.widgets.length, 1);
    assert.equal(snapshot.widgets[0].candidateId, current.id);
    assert.equal(
      snapshot.candidates.find((c) => c.id === previous.id)!.state,
      "discarded",
    );
  } finally {
    s.close();
  }
});

test("widget generation real authorization accepts explicit subsets and rejects missing, duplicate or excess scope before execution", () => {
  const a = {
    task: "mac-feature-t9",
    authorized: true,
    maxTurns: 18,
    root: resolve(".test-data/disposable/authorized-root"),
    evidence: resolve(".test-data/disposable/authorized-evidence"),
    selections: [
      { provider: "codex", connectionId: "local-codex", model: "gpt-5.6-luna" },
      {
        provider: "claude",
        connectionId: "local-claude",
        model: "claude-sonnet-5-5",
      },
      {
        provider: "deepseek",
        connectionId: "local-api",
        model: "deepseek-flash",
      },
    ],
    deferredProviders: ["zhipu", "openrouter", "siliconflow"],
  };
  assert.equal(widgetRealAuthorization(a, "1"), a);
  for (const changed of [
    null,
    {},
    { ...a, authorized: false },
    { ...a, task: "other" },
    { ...a, maxTurns: 36 },
    { ...a, maxTurns: 17 },
    { ...a, root: "relative" },
    { ...a, evidence: a.root },
    { ...a, selections: [] },
    { ...a, selections: [...a.selections.slice(0, 2), a.selections[0]] },
    { ...a, selections: a.selections.map((s) => ({ ...s, model: "" })) },
    { ...a, deferredProviders: [] },
    { ...a, deferredProviders: ["zhipu", "openrouter", "codex"] },
    { ...a, deferredProviders: ["zhipu", "openrouter", "unknown"] },
  ])
    assert.throws(() => widgetRealAuthorization(changed, "1"), /NOT RUN/);
  assert.throws(() => widgetRealAuthorization(a, undefined), /NOT RUN/);
  assert.throws(() => widgetRealAuthorization(a, "0"), /NOT RUN/);
  const full = {
    ...a,
    maxTurns: 36,
    deferredProviders: [],
    selections: [
      ...a.selections,
      ...a.deferredProviders.map((provider) => ({
        provider,
        connectionId: provider,
        model: "explicit-model",
      })),
    ],
  };
  assert.equal(widgetRealAuthorization(full, "1"), full);
});

test("widget generation real validation preserves each failed path and continues independent providers without retry", async () => {
  const visited: string[] = [],
    failures: string[] = [],
    completed: string[] = [];
  await runWidgetProviderChecks(
    ["codex", "claude", "deepseek"],
    async (provider) => {
      visited.push(provider);
      if (provider !== "claude") throw new Error("unavailable configuration");
      completed.push(provider);
    },
    async (provider, error) => {
      assert.match((error as Error).message, /unavailable configuration/);
      failures.push(provider);
    },
  );
  assert.deepEqual(visited, ["codex", "claude", "deepseek"]);
  assert.deepEqual(completed, ["claude"]);
  assert.deepEqual(failures, ["codex", "deepseek"]);
});

test("widget editing: revision-bound continuation preserves identity, position and formal data", () => {
  const s = setup();
  try {
    const id = draft(s),
      first = candidate(s, submit(s, id).task);
    assert(
      s.store.execute(
        {
          type: "retainWidgetCandidate",
          candidateId: first.id,
          digest: first.digest,
          requirementRevision: first.requirementRevision,
        },
        "main",
      ).ok,
    );
    const original = s.store.snapshot().widgetGeneration!.widgets[0];
    const editId = randomUUID();
    assert(
      s.store.execute(
        {
          type: "createWidgetEditDraft",
          id: editId,
          widgetIds: [original.id],
        } as Command,
        "main",
      ).ok,
    );
    assert(
      s.store.execute(
        {
          type: "saveWidgetDraft",
          id: editId,
          name: original.name,
          input: "Add subtraction",
          revision: 0,
        },
        "main",
      ).ok,
    );
    const t = submit(s, editId).task;
    assert(claim(s, t).ok);
    const context = host(s.store, {
      type: "loadWidgetGeneration",
      taskId: t.id,
      executionId: t.executionId,
    });
    assert(context.ok);
    assert.equal(context.generationContext?.widgets?.[0].id, original.id);
    const build = buildWidgetPackage(
      JSON.stringify({
        schemaVersion: 1,
        name: "Subtraction",
        view: { html: "<button>Subtract</button>", css: "", js: "" },
        config: [],
        draftFields: [],
        capabilities: [],
        resources: [],
      }),
    );
    assert(
      host(s.store, {
        type: "receiveWidgetCandidate",
        taskId: t.id,
        executionId: t.executionId,
        build,
      }).ok,
    );
    assert(
      host(s.store, {
        type: "finishWidgetGeneration",
        taskId: t.id,
        executionId: t.executionId,
        state: "completed",
        error: null,
      }).ok,
    );
    const next = s.store.snapshot().widgetGeneration!.candidates.at(-1)!;
    assert(
      s.store.execute(
        {
          type: "retainWidgetCandidate",
          candidateId: next.id,
          digest: next.digest,
          requirementRevision: next.requirementRevision,
        },
        "main",
      ).ok,
    );
    const widgets = s.store.snapshot().widgetGeneration!.widgets;
    assert.equal(widgets.length, 1);
    assert.equal(widgets[0].id, original.id);
    assert.equal(widgets[0].position, original.position);
    assert.equal(widgets[0].revision, 2);
  } finally {
    s.close();
  }
});

test("widget editing: explicit supplement cancels old eligibility and freezes the new adopted revision", () => {
  const s = setup();
  try {
    const id = draft(s),
      old = submit(s, id).task;
    assert(claim(s, old).ok);
    assert(
      s.store.execute(
        {
          type: "saveWidgetDraft",
          id,
          revision: 2,
          name: "同名草稿",
          input: "Use step nine",
        },
        "main",
      ).ok,
    );
    assert(
      s.store.execute(
        {
          type: "supplementWidgetGeneration",
          draftId: id,
          revision: 3,
          requestId: randomUUID(),
          connectionId: s.connectionId,
          model: "test-model",
        },
        "main",
      ).ok,
    );
    const snapshot = s.store.snapshot().widgetGeneration!;
    assert.equal(snapshot.tasks[0].state, "stopping");
    assert.equal(snapshot.tasks[1].state, "queued");
    assert.equal(snapshot.tasks[1].requirementRevision, 2);
    assert.match(
      snapshot.tasks[1].requirement,
      /Make an abacus[\s\S]*Use step nine/,
    );
    assert(
      !host(s.store, {
        type: "receiveWidgetCandidate",
        taskId: old.id,
        executionId: old.executionId,
        build: built(),
      }).ok,
    );
    assert(!claim(s, snapshot.tasks[1]).ok);
    assert(
      host(s.store, {
        type: "finishWidgetGeneration",
        taskId: old.id,
        executionId: old.executionId,
        state: "stopped",
        error: null,
      }).ok,
    );
    assert(claim(s, snapshot.tasks[1]).ok);
  } finally {
    s.close();
  }
});

test("widget editing: concurrent formal revision or data changes reject retention without partial mutation", () => {
  const s = setup();
  try {
    const first = candidate(s, submit(s, draft(s)).task);
    assert(
      s.store.execute(
        {
          type: "retainWidgetCandidate",
          candidateId: first.id,
          digest: first.digest,
          requirementRevision: 1,
        },
        "main",
      ).ok,
    );
    const formal = s.store.snapshot().widgetGeneration!.widgets[0];
    const id = randomUUID();
    assert(
      s.store.execute(
        { type: "createWidgetEditDraft", id, widgetIds: [formal.id] },
        "main",
      ).ok,
    );
    assert(
      s.store.execute(
        {
          type: "saveWidgetDraft",
          id,
          revision: 0,
          name: formal.name,
          input: "Add subtraction",
        },
        "main",
      ).ok,
    );
    const t = submit(s, id).task;
    assert(claim(s, t).ok);
    const build = buildWidgetPackage(
      JSON.stringify({
        ...built().manifest,
        view: { html: "<button>Subtract</button>", css: "", js: "" },
      }),
    );
    assert(
      host(s.store, {
        type: "receiveWidgetCandidate",
        taskId: t.id,
        executionId: t.executionId,
        build,
      }).ok,
    );
    assert(
      host(s.store, {
        type: "finishWidgetGeneration",
        taskId: t.id,
        executionId: t.executionId,
        state: "completed",
        error: null,
      }).ok,
    );
    const c = s.store.snapshot().widgetGeneration!.candidates.at(-1)!;
    s.store.db
      .prepare(
        "UPDATE widget_previews SET data_revision=data_revision+1,data=? WHERE candidate_id=?",
      )
      .run(JSON.stringify({ newValue: 7 }), formal.candidateId);
    const before = s.store.snapshot();
    assert(
      !s.store.execute(
        {
          type: "retainWidgetCandidate",
          candidateId: c.id,
          digest: c.digest,
          requirementRevision: c.requirementRevision,
        },
        "main",
      ).ok,
    );
    assert.deepEqual(s.store.snapshot(), before);
    assert.deepEqual(
      JSON.parse(
        String(
          s.store.db
            .prepare("SELECT data FROM widget_previews WHERE candidate_id=?")
            .get(formal.candidateId)!.data,
        ),
      ),
      { newValue: 7 },
    );
  } finally {
    s.close();
  }
});

test("widget editing: selected target set is atomic, rejects one conflict, and preserves newer positions", () => {
  const s = setup();
  try {
    for (let i = 0; i < 2; i++) {
      const c = candidate(s, submit(s, draft(s)).task);
      assert(
        s.store.execute(
          {
            type: "retainWidgetCandidate",
            candidateId: c.id,
            digest: c.digest,
            requirementRevision: 1,
          },
          "main",
        ).ok,
      );
    }
    const targets = s.store.snapshot().widgetGeneration!.widgets;
    const id = randomUUID();
    assert(
      s.store.execute(
        {
          type: "createWidgetEditDraft",
          id,
          widgetIds: targets.map((w) => w.id),
        },
        "main",
      ).ok,
    );
    assert(
      s.store.execute(
        {
          type: "saveWidgetDraft",
          id,
          revision: 0,
          name: "Pair",
          input: "Modify both",
        },
        "main",
      ).ok,
    );
    const t = submit(s, id).task;
    assert(claim(s, t).ok);
    const builds = targets.map((w, n) => ({
      widgetId: w.id,
      build: buildWidgetPackage(
        JSON.stringify({
          ...built().manifest,
          name: `Changed ${n}`,
          view: { html: `<button>${n}</button>`, css: "", js: "" },
        }),
      ),
    }));
    const beforeCandidate = s.store.snapshot();
    for (const invalid of [
      builds.slice(0, 1),
      [builds[0], builds[0]],
      [builds[0], { ...builds[1], widgetId: randomUUID() }],
    ]) {
      assert(
        !host(s.store, {
          type: "receiveWidgetCandidateSet",
          taskId: t.id,
          executionId: t.executionId,
          builds: invalid,
          layout: null,
        }).ok,
      );
      assert.deepEqual(s.store.snapshot(), beforeCandidate);
    }
    assert(
      !host(s.store, {
        type: "receiveWidgetCandidateSet",
        taskId: t.id,
        executionId: t.executionId,
        builds,
        layout: { minWidth: 0, gap: 12, density: "compact" },
      }).ok,
    );
    assert.deepEqual(s.store.snapshot(), beforeCandidate);
    assert(
      host(s.store, {
        type: "receiveWidgetCandidateSet",
        taskId: t.id,
        executionId: t.executionId,
        builds,
        layout: { minWidth: 300, gap: 12, density: "compact" },
      } as HostCommand).ok,
    );
    assert(
      host(s.store, {
        type: "finishWidgetGeneration",
        taskId: t.id,
        executionId: t.executionId,
        state: "completed",
        error: null,
      }).ok,
    );
    const c = s.store.snapshot().widgetGeneration!.candidates.at(-1)!;
    const retain: Command = {
      type: "retainWidgetCandidate",
      candidateId: c.id,
      digest: c.digest,
      requirementRevision: c.requirementRevision,
    };
    s.store.db
      .prepare("UPDATE saved_widgets SET revision=revision+1 WHERE id=?")
      .run(targets[1].id);
    const conflicted = s.store.snapshot();
    assert(!s.store.execute(retain, "main").ok);
    assert.deepEqual(s.store.snapshot(), conflicted);
    s.store.db
      .prepare("UPDATE saved_widgets SET revision=revision-1 WHERE id=?")
      .run(targets[1].id);
    s.store.db
      .prepare("UPDATE saved_widgets SET position=position+10 WHERE id=?")
      .run(targets[0].id);
    // A failure during the second update must roll back the first member and all preview revocations.
    s.store.db.exec(
      `CREATE TRIGGER reject_second_widget BEFORE UPDATE ON saved_widgets WHEN OLD.id='${targets[1].id}' BEGIN SELECT RAISE(ABORT,'synthetic second write failure'); END`,
    );
    const beforeWriteFailure = s.store.snapshot();
    assert(!s.store.execute(retain, "main").ok);
    assert.deepEqual(s.store.snapshot(), beforeWriteFailure);
    s.store.db.exec("DROP TRIGGER reject_second_widget");
    s.store.db.exec("UPDATE widget_layout SET revision=revision+1 WHERE id=1");
    const beforeLayoutConflict = s.store.snapshot();
    assert(!s.store.execute(retain, "main").ok);
    assert.deepEqual(s.store.snapshot(), beforeLayoutConflict);
    s.store.db.exec("UPDATE widget_layout SET revision=revision-1 WHERE id=1");
    assert(s.store.execute(retain, "main").ok);
    const after = s.store.snapshot().widgetGeneration!;
    assert.equal(after.widgets.length, 2);
    assert(after.widgets.every((w) => w.revision === 2));
    assert.equal(
      after.widgets.find((w) => w.id === targets[0].id)!.position,
      targets[0].position + 10,
    );
    assert(s.store.execute(retain, "panel").ok);
    assert(
      s.store
        .snapshot()
        .widgetGeneration!.widgets.every((w) => w.revision === 2),
    );
    assert.deepEqual(after.layout?.value, {
      minWidth: 300,
      gap: 12,
      density: "compact",
    });
    assert.equal(after.candidates.at(-1)?.members?.length, 2);
    s.store.db.exec("UPDATE widget_layout SET value='invalid' WHERE id=1");
    const fallback = s.store.snapshot().widgetGeneration!;
    assert(fallback.layout?.fallback);
    assert.deepEqual(fallback.layout?.value, {
      minWidth: 320,
      gap: 16,
      density: "comfortable",
    });
    assert.deepEqual(fallback.widgets, after.widgets);
  } finally {
    s.close();
  }
});

test("widget draft deletion: stopped-only atomic removal and one-shot undo restore candidates and input without restarting", () => {
  const s = setup();
  try {
    const id = draft(s),
      t = submit(s, id).task;
    assert(claim(s, t).ok);
    const token = randomUUID(),
      remove: Command = {
        type: "deleteWidgetDraft",
        id,
        revision: 2,
        name: "同名草稿",
        input: "unsaved supplement",
        undoToken: token,
      };
    const before = s.store.snapshot();
    assert.equal(s.store.execute(remove, "main").ok, false);
    assert.deepEqual(s.store.snapshot(), before);
    assert(
      s.store.execute({ type: "stopWidgetGeneration", taskId: t.id }, "main")
        .ok,
    );
    assert.equal(s.store.execute(remove, "main").ok, false);
    assert(
      host(s.store, {
        type: "finishWidgetGeneration",
        taskId: t.id,
        executionId: t.executionId,
        state: "stopped",
        error: null,
      }).ok,
    );
    assert(s.store.execute(remove, "main").ok);
    assert.equal(s.store.snapshot().widgetGeneration!.drafts.length, 0);
    assert.equal(
      s.store.db.prepare("SELECT input FROM widget_drafts WHERE id=?").get(id)!
        .input,
      "",
    );
    assert.equal(
      s.store.execute(
        { type: "undoWidgetDraftDeletion", id, undoToken: token },
        "panel",
      ).ok,
      false,
    );
    assert(
      s.store.execute(
        { type: "undoWidgetDraftDeletion", id, undoToken: token },
        "main",
      ).ok,
    );
    let snap = s.store.snapshot().widgetGeneration!;
    assert.equal(snap.drafts[0].input, "unsaved supplement");
    assert.equal(snap.tasks[0].state, "stopped");
    assert.equal(snap.tasks[0].attempt, 1);
    assert.equal(
      s.store.execute(
        { type: "undoWidgetDraftDeletion", id, undoToken: token },
        "main",
      ).ok,
      false,
    );
    const id2 = draft(s, "candidate"),
      c = candidate(s, submit(s, id2).task);
    s.store.db
      .prepare("UPDATE widget_previews SET drafts=? WHERE candidate_id=?")
      .run('{"text":"unsubmitted"}', c.id);
    const del: Command = {
      type: "deleteWidgetDraft",
      id: id2,
      revision: 2,
      name: "candidate",
      input: "",
      undoToken: randomUUID(),
    };
    s.store.db.exec(
      "CREATE TRIGGER reject_delete_draft BEFORE UPDATE OF deleted ON widget_drafts BEGIN SELECT RAISE(ABORT,'injected failure'); END",
    );
    const stable = s.store.snapshot();
    assert.equal(s.store.execute(del, "main").ok, false);
    assert.deepEqual(s.store.snapshot(), stable);
    assert.equal(
      s.store.db
        .prepare("SELECT drafts FROM widget_previews WHERE candidate_id=?")
        .get(c.id)!.drafts,
      '{"text":"unsubmitted"}',
    );
    s.store.db.exec("DROP TRIGGER reject_delete_draft");
    assert(s.store.execute(del, "main").ok);
    assert.equal(
      s.store.db
        .prepare("SELECT drafts FROM widget_previews WHERE candidate_id=?")
        .get(c.id)!.drafts,
      "{}",
    );
    assert.equal(
      s.store
        .snapshot()
        .widgetGeneration!.candidates.find((x) => x.id === c.id)!.state,
      "discarded",
    );
    assert(
      s.store.execute(
        { type: "undoWidgetDraftDeletion", id: id2, undoToken: del.undoToken },
        "main",
      ).ok,
    );
    snap = s.store.snapshot().widgetGeneration!;
    assert.equal(snap.candidates.find((x) => x.id === c.id)!.state, "preview");
    assert.equal(
      s.store.db
        .prepare("SELECT drafts FROM widget_previews WHERE candidate_id=?")
        .get(c.id)!.drafts,
      '{"text":"unsubmitted"}',
    );
    assert.equal(snap.tasks.find((x) => x.id === c.taskId)!.state, "completed");
    assert(
      s.store.execute(
        {
          type: "retainWidgetCandidate",
          candidateId: c.id,
          digest: c.digest,
          requirementRevision: c.requirementRevision,
        },
        "main",
      ).ok,
    );
    const formal = s.store.snapshot().widgetGeneration!,
      formalDraft = formal.drafts.find((x) => x.id === id2)!;
    assert.equal(
      s.store.execute(
        { ...del, revision: formalDraft.revision, undoToken: randomUUID() },
        "main",
      ).ok,
      false,
    );
    assert.deepEqual(s.store.snapshot().widgetGeneration, formal);
    const deletion = {
      ...del,
      revision: formalDraft.revision,
      input: "unfinished change",
      undoToken: randomUUID(),
    };
    assert(s.store.execute(deletion, "main").ok);
    assert.deepEqual(
      s.store.snapshot().widgetGeneration!.widgets,
      formal.widgets,
    );
    assert.deepEqual(s.store.snapshot().widgetGeneration!.tasks, formal.tasks);
    assert(
      s.store.execute(
        {
          type: "undoWidgetDraftDeletion",
          id: id2,
          undoToken: deletion.undoToken,
        },
        "main",
      ).ok,
    );
    assert.deepEqual(
      s.store.snapshot().widgetGeneration!.widgets,
      formal.widgets,
    );
  } finally {
    s.close();
  }
});

test("widget stop recovery: owned evidence survives restart, explicit confirmation preserves expired attempt and enables deletion", async () => {
  const s = setup();
  let reopened: Store | undefined,
    closed = false;
  try {
    const id = draft(s),
      t = submit(s, id).task;
    assert(claim(s, t).ok);
    const evidence = {
      complete: true,
      processes: [{ pid: 123, startSeconds: 456, startMicros: 789 }],
    };
    assert(
      host(s.store, {
        type: "finishWidgetGeneration",
        taskId: t.id,
        executionId: t.executionId,
        state: "interrupted",
        error: "unconfirmed",
        stopUnconfirmed: true,
        stopEvidence: evidence,
      }).ok,
    );
    const request = {
      type: "loadWidgetGenerationStop",
      taskId: t.id,
      executionId: t.executionId,
    } as const;
    assert.equal(s.store.execute(request as never, "main").ok, false);
    s.store.close();
    closed = true;
    reopened = new Store(s.root);
    const store = reopened;
    const read = host(store, request);
    assert(read.ok);
    assert.deepEqual(read.generationStopEvidence, evidence);
    const saved = store.snapshot().widgetGeneration!.tasks[0];
    assert.equal(saved.stopUnconfirmed, true);
    let confirmed = false;
    const runner = new WidgetGenerationRunner(
      async (c) => host(store, c),
      async () => {
        throw new Error("must not generate");
      },
      () => {},
      undefined,
      async (e) => {
        assert.deepEqual(e, evidence);
        return confirmed;
      },
    );
    assert.equal((await runner.confirmStop(saved)).ok, false);
    assert.equal(
      store.snapshot().widgetGeneration!.tasks[0].stopUnconfirmed,
      true,
    );
    confirmed = true;
    assert((await runner.confirmStop(saved)).ok);
    const current = store.snapshot().widgetGeneration!.tasks[0];
    assert.equal(current.state, "stopped");
    assert.equal(current.stopUnconfirmed, false);
    assert.equal(current.attempt, 1);
    assert.equal(
      host(store, {
        type: "receiveWidgetCandidate",
        taskId: t.id,
        executionId: t.executionId,
        build: built(),
      }).ok,
      false,
    );
    const d = store.snapshot().widgetGeneration!.drafts[0];
    assert(
      store.execute(
        {
          type: "deleteWidgetDraft",
          id,
          revision: d.revision,
          name: d.name,
          input: "",
          undoToken: randomUUID(),
        },
        "main",
      ).ok,
    );
  } finally {
    if (reopened) reopened.close();
    if (!closed) s.store.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});
