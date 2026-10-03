import { test } from "node:test";
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
    const other = draft(s),
      next = submit(s, other).task;
    // Real storage fixture supplies an existing formal baseline without exposing a modification UI.
    s.store.db
      .prepare("UPDATE widget_drafts SET widget_id=? WHERE id=?")
      .run(formal.id, other);
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
