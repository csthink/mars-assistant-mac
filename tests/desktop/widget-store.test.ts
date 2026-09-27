import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../../src/service/store";
import type {
  WidgetIdentity,
  WidgetRequest,
} from "../../src/shared/widget-runtime";
const definition = {
  name: "测试候选",
  config: [{ id: "title", label: "标题", type: "text", default: "笔记" }],
  draftFields: ["note"],
  capabilities: ["data.read", "data.write", "draft.write", "config.read"],
};
const identity = (
  candidateId = "candidate-a",
  generation = "generation-a",
): WidgetIdentity => ({
  widgetId: "widget-a",
  candidateId,
  version: "a".repeat(64),
  surface: "main",
  generation,
});
function open() {
  mkdirSync(".test-data/disposable", { recursive: true });
  return new Store(mkdtempSync(resolve(".test-data/disposable/widget-store-")));
}
function create(store: Store, candidateId = "candidate-a") {
  return store.execute(
    {
      type: "widgetCreate",
      candidateId,
      widgetId: "widget-a",
      version: "a".repeat(64),
      definition,
    },
    "main",
    "host",
  );
}
function bind(store: Store, i = identity()) {
  return store.execute({ type: "widgetBind", identity: i }, i.surface, "host");
}
function request(store: Store, request: WidgetRequest, i = identity()) {
  return store.execute(
    { type: "widgetRequest", identity: i, request },
    i.surface,
    "host",
  );
}
test("widget store: candidate isolation, exact host identity, revocation and confirmed restart recovery", () => {
  let store = open();
  const root = store.root;
  try {
    const conversations = store.snapshot().conversations;
    assert(create(store).ok);
    assert(create(store, "candidate-b").ok);
    assert(bind(store).ok);
    assert.equal(
      store.execute({ type: "widgetBind", identity: identity() }, "main").ok,
      false,
    );
    assert.equal(
      request(store, { method: "readData" }, identity("candidate-b")).ok,
      false,
    );
    assert.equal(
      request(
        store,
        { method: "readData" },
        { ...identity(), widgetId: "other" },
      ).ok,
      false,
    );
    assert.equal(
      store.execute(
        {
          type: "widgetRequest",
          identity: identity(),
          request: { method: "readData" },
        },
        "panel",
        "host",
      ).ok,
      false,
    );
    const saved = request(store, {
      method: "writeData",
      revision: 0,
      value: { count: 1 },
    });
    assert(saved.ok && saved.widget?.ok);
    assert.equal(saved.widget.revision, 1);
    assert.equal(
      request(store, { method: "writeData", revision: 0, value: { count: 2 } })
        .ok,
      false,
    );
    const second = identity("candidate-b", "generation-b");
    assert(bind(store, second).ok);
    const untouched = request(store, { method: "readData" }, second);
    assert(untouched.ok && untouched.widget?.ok);
    assert.deepEqual(untouched.widget.value, {});
    assert(
      request(store, {
        method: "writeDraft",
        revision: 0,
        field: "note",
        value: "已确认草稿",
      }).ok,
    );
    assert.equal(
      request(store, {
        method: "writeDraft",
        revision: 0,
        field: "note",
        value: "旧输入",
      }).ok,
      false,
    );
    assert.deepEqual(store.snapshot().conversations, conversations);
    store.close();
    store = new Store(root);
    assert.equal(request(store, { method: "readData" }).ok, false);
    const fresh = identity("candidate-a", "generation-new");
    assert(bind(store, fresh).ok);
    const restored = request(store, { method: "readDraft" }, fresh);
    assert(restored.ok && restored.widget?.ok);
    assert.deepEqual(restored.widget.value, {
      note: { text: "已确认草稿", revision: 1 },
    });
    assert(
      store.execute(
        { type: "widgetDiscard", candidateId: "candidate-a" },
        "main",
        "host",
      ).ok,
    );
    assert.equal(request(store, { method: "readDraft" }, fresh).ok, false);
    assert.equal(
      bind(store, identity("candidate-a", "generation-rejected")).ok,
      false,
    );
  } finally {
    store.close();
  }
});
test("widget store: transactional save failure, config validation, capabilities and size limits", () => {
  const store = open();
  try {
    assert(create(store).ok);
    assert(bind(store).ok);
    const configure = (revision: number, value: unknown) =>
      store.execute(
        {
          type: "widgetConfigure",
          draftRevisions: { title: 0 },
          candidateId: "candidate-a",
          revision,
          value,
        },
        "main",
        "host",
      );
    assert.equal(configure(0, { title: 9 }).ok, false);
    assert(configure(0, { title: "新标题" }).ok);
    assert.equal(configure(0, { title: "旧标题" }).ok, false);
    assert.equal(
      request(store, {
        method: "writeData",
        revision: 0,
        value: { text: "中".repeat(25000) },
      }).ok,
      false,
    );
    assert.equal(
      request(store, {
        method: "writeDraft",
        revision: 0,
        field: "secret",
        value: "synthetic",
      }).ok,
      false,
    );
    store.db.exec(
      "CREATE TRIGGER widget_fail BEFORE UPDATE ON widget_previews BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END;",
    );
    assert.equal(
      request(store, {
        method: "writeDraft",
        revision: 0,
        field: "note",
        value: "未确认",
      }).ok,
      false,
    );
    const read = request(store, { method: "readDraft" });
    assert(read.ok && read.widget?.ok);
    assert.deepEqual(read.widget.value, {});
    store.db.exec("DROP TRIGGER widget_fail");
    assert(
      store.execute(
        { type: "widgetRevoke", generation: identity().generation },
        "main",
        "host",
      ).ok,
    );
    assert.equal(request(store, { method: "readConfig" }).ok, false);
    const denied = store.execute(
      {
        type: "widgetCreate",
        candidateId: "denied",
        widgetId: "widget-a",
        version: "a".repeat(64),
        definition: { ...definition, capabilities: [] },
      },
      "main",
      "host",
    );
    assert(denied.ok);
    const i = identity("denied", "denied-gen");
    assert(bind(store, i).ok);
    assert.equal(request(store, { method: "readData" }, i).ok, false);
  } finally {
    store.close();
  }
});

test("widget store: per-entry view state and unapplied config drafts survive restart with revision checks", () => {
  let store = open();
  const root = store.root;
  try {
    assert(create(store).ok);
    assert(bind(store).ok);
    const state = {
      scrollX: 0,
      scrollY: 120,
      expanded: ["details"],
      focus: "note",
    };
    assert(
      request(store, { method: "writeView", revision: 0, value: state }).ok,
    );
    assert.equal(
      request(store, {
        method: "writeView",
        revision: 0,
        value: { ...state, scrollY: 0 },
      }).ok,
      false,
    );
    const panel = {
      ...identity("candidate-a", "panel-generation"),
      surface: "panel" as const,
    };
    assert(bind(store, panel).ok);
    const different = request(store, { method: "readView" }, panel);
    assert(different.ok && different.widget?.ok);
    assert.equal(different.widget.value.scrollY, 0);
    const draft = {
      type: "widgetConfigDraft",
      candidateId: "candidate-a",
      field: "title",
      revision: 0,
      value: "尚未应用的标题",
    };
    assert(store.execute(draft, "main", "host").ok);
    assert.equal(
      store.execute({ ...draft, value: "过期设置草稿" }, "panel", "host").ok,
      false,
    );
    assert.equal(
      store.execute(
        {
          type: "widgetConfigure",
          candidateId: "candidate-a",
          revision: 0,
          draftRevisions: { title: 0 },
          value: { title: "旧值" },
        },
        "main",
        "host",
      ).ok,
      false,
    );
    store.close();
    store = new Store(root);
    const fresh = identity("candidate-a", "fresh-generation");
    assert(bind(store, fresh).ok);
    const restored = request(store, { method: "readView" }, fresh);
    assert(restored.ok && restored.widget?.ok);
    assert.deepEqual(restored.widget.value, state);
    const inspected = store.execute(
      { type: "widgetInspect", candidateId: "candidate-a" },
      "main",
      "host",
    );
    assert(inspected.ok && inspected.widgetPreview);
    assert.equal(inspected.widgetPreview.config.title, "笔记");
    assert.equal(
      inspected.widgetPreview.configDrafts.title.text,
      "尚未应用的标题",
    );
  } finally {
    store.close();
  }
});
