import { test } from "node:test";
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
