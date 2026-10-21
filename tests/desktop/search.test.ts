import {
  restorePreCodexFixture,
  restorePreUnifiedSearchFixture,
} from "./legacy-codex-schema";
import {
  seedRetainedWidgets,
  seedWidgetCandidate,
} from "./widget-generation-fixture";
import { DatabaseSync } from "node:sqlite";
import { rebuildSearchIndex } from "../../src/service/search-index";
import { querySearch } from "../../src/service/search-query";
import {
  matchRanges,
  normalizeSearch,
  validSearch,
} from "../../src/shared/search";
import { SearchService } from "../../src/main/search";
import { buildSync } from "esbuild";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/service/store";
import { automaticTitle, updateAutomaticTitle } from "../../src/service/titles";
mkdirSync(".test-data/disposable", { recursive: true });
function fixture() {
  const dir = mkdtempSync(resolve(".test-data/disposable/search-"));
  const store = new Store(dir);
  const id = randomUUID();
  store.execute({ type: "create", id }, "main");
  return {
    store,
    id,
    dir,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true });
    },
  };
}
test("标题优先级、独立修订与重启持久化", () => {
  const f = fixture();
  try {
    const { store, id } = f;
    store.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user',?,?)",
      )
      .run(
        randomUUID(),
        id,
        "# 如何使用本地搜索？后续问题",
        new Date().toISOString(),
      );
    updateAutomaticTitle(store.db, id);
    assert.equal(store.snapshot().conversations[0].title, "如何使用本地搜索");
    assert.equal(
      store.execute(
        { type: "renameConversation", id, title: " 我的标题 ", revision: 0 },
        "main",
      ).ok,
      true,
    );
    assert.equal(
      store.execute(
        { type: "saveDraft", id, text: "独立草稿", revision: 0 },
        "panel",
      ).ok,
      true,
    );
    updateAutomaticTitle(store.db, id);
    assert.equal(store.snapshot().conversations[0].title, "我的标题");
    const snapshot = store.snapshot();
    store.close();
    const reopened = new Store(f.dir);
    assert.deepEqual(reopened.snapshot(), snapshot);
    reopened.close();
    // Replace only the fixture cleanup handle after this test explicitly closed both instances.
    f.close = () => rmSync(f.dir, { recursive: true });
  } finally {
    f.close();
  }
});
test("改名拒绝过期、空白、控制字符与超长，写入失败保留标题和修订", () => {
  const f = fixture();
  try {
    const { store, id } = f;
    assert.equal(
      store.execute(
        { type: "renameConversation", id, title: "已确认", revision: 0 },
        "main",
      ).ok,
      true,
    );
    const baseline = store.snapshot();
    for (const title of ["", "  ", "bad\nname", "字".repeat(81)])
      assert.equal(
        store.execute(
          { type: "renameConversation", id, title, revision: 1 },
          "main",
        ).ok,
        false,
      );
    const stale = store.execute(
      { type: "renameConversation", id, title: "旧修改", revision: 0 },
      "panel",
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "CONFLICT");
    assert.deepEqual(store.snapshot(), baseline);
    store.db.exec("PRAGMA query_only=ON");
    assert.equal(
      store.execute(
        { type: "renameConversation", id, title: "未保存", revision: 1 },
        "main",
      ).ok,
      false,
    );
    assert.deepEqual(store.snapshot(), baseline);
  } finally {
    f.close();
  }
});
test("自动标题只读首个有效文本句，按 Unicode 字符截断", () => {
  assert.equal(automaticTitle("\n# 中文问题。其他内容"), "中文问题");
  assert.equal([...automaticTitle("😀".repeat(40))].length, 28);
});

function message(store: Store, id: string, content: string) {
  const mid = randomUUID();
  store.db
    .prepare(
      "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user',?,?)",
    )
    .run(mid, id, content, new Date().toISOString());
  return mid;
}
function hits(store: Store, query: string, cursor: string | null = null) {
  const r = querySearch(store.db, {
    sequence: 1,
    query,
    category: "conversation",
    cursor,
  });
  if (!r.ok) throw new Error(r.message);
  return r;
}
test("字面搜索覆盖中文短词、特殊字符、Unicode 高亮及排除草稿", () => {
  const f = fixture();
  try {
    const body =
      '权限撤销 SQLite literal%under_score "quoted" CAFÉ Straße e\u0301 😀 <script>secret</script>';
    const id = message(f.store, f.id, body);
    f.store.execute(
      { type: "saveDraft", id: f.id, text: "只在草稿的秘密", revision: 0 },
      "main",
    );
    for (const query of [
      "权",
      "权限",
      "权限撤销",
      "SQLite",
      "literal%under_score",
      '"quoted"',
      "café",
      "STRASSE",
      "é",
      "😀",
      "<script>",
    ]) {
      const result = hits(f.store, query);
      assert.equal(result.hits[0].messageId, id, query);
      const hit = result.hits[0];
      assert.ok(hit.ranges.length, query);
      assert.ok(
        hit.ranges.some(([a, b]) =>
          normalizeSearch(hit.text.slice(a, b)).includes(
            normalizeSearch(query),
          ),
        ),
        query,
      );
    }
    for (const query of ["只在草稿", "OR nonexistent", "NEAR(x)", "不存在"])
      assert.equal(hits(f.store, query).hits.length, 0);
    assert.deepEqual(matchRanges("a e\u0301 ß 😀", "É"), [[2, 4]]);
    assert.equal(
      validSearch({
        query: "x",
        sequence: 1,
        category: "all",
        cursor: null,
        path: "/etc/passwd",
      }),
      false,
    );
    assert.equal(
      validSearch({
        query: "x".repeat(201),
        sequence: 1,
        category: "all",
        cursor: null,
      }),
      false,
    );
  } finally {
    f.close();
  }
});
test("标题索引改名即时更新、同名与稳定分页，重建失败回滚后可恢复", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 83; i++) message(f.store, f.id, `共同文本 ${i}`);
    const first = hits(f.store, "共同文本"),
      second = hits(f.store, "共同文本", first.next),
      third = hits(f.store, "共同文本", second.next);
    assert.equal(first.hasMore, true);
    assert.equal(second.hasMore, true);
    assert.equal(third.hasMore, false);
    assert.equal(
      new Set(
        [...first.hits, ...second.hits, ...third.hits].map((h) => h.messageId),
      ).size,
      83,
    );
    f.store.execute(
      { type: "renameConversation", id: f.id, title: "独有标题", revision: 0 },
      "main",
    );
    assert.equal(hits(f.store, "新对话").hits.length, 0);
    assert.equal(hits(f.store, "独有标题").hits[0].messageId, null);
    const before = hits(f.store, "共同文本");
    f.store.db.exec(
      "CREATE TEMP TRIGGER reject_rebuild BEFORE DELETE ON search_documents BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    assert.equal(
      f.store.execute({ type: "rebuildSearchIndex" }, "main").ok,
      false,
    );
    assert.deepEqual(hits(f.store, "共同文本"), before);
    f.store.db.exec("DROP TRIGGER reject_rebuild");
    assert.equal(
      f.store.execute({ type: "rebuildSearchIndex" }, "main").ok,
      true,
    );
    const rebuilt = hits(f.store, "共同文本");
    assert.deepEqual(rebuilt.hits, before.hits);
    assert.deepEqual(rebuilt.counts, before.counts);
    assert.equal(rebuilt.snapshot.generation, before.snapshot.generation + 1);
  } finally {
    f.close();
  }
});
test("读取 worker 拒绝旧查询、有界超时与重试，查询不写业务数据", async () => {
  const f = fixture();
  const workerFile = join(f.dir, "search-worker.cjs");
  buildSync({
    entryPoints: ["src/service/search-worker.ts"],
    outfile: workerFile,
    bundle: true,
    platform: "node",
    target: "node24",
  });
  const service = new SearchService(f.dir, workerFile);
  try {
    message(f.store, f.id, "worker 中文内容");
    const before = f.store.snapshot();
    const old = service.query("main", {
      sequence: 1,
      query: "old",
      category: "all",
      cursor: null,
    });
    const newer = service.query("main", {
      sequence: 2,
      query: "中文",
      category: "all",
      cursor: null,
    });
    assert.deepEqual(await old, {
      ok: false,
      code: "SUPERSEDED",
      message: "搜索词已变化。",
    });
    const actual = await newer;
    assert.equal(actual.ok, true);
    if (actual.ok) assert.equal(actual.hits.length, 1);
    const stale = await service.query("main", {
      sequence: 1,
      query: "old",
      category: "all",
      cursor: null,
    });
    assert.equal(stale.ok, false);
    assert.deepEqual(f.store.snapshot(), before);
    const blockedFile = join(f.dir, "blocked.cjs");
    writeFileSync(blockedFile, "while(true){}");
    const bounded = new SearchService(f.dir, blockedFile, 50);
    const timeout = await bounded.query("main", {
      sequence: 1,
      query: "x",
      category: "all",
      cursor: null,
    });
    assert.equal(timeout.ok, false);
    if (!timeout.ok) assert.equal(timeout.code, "TIMEOUT");
    bounded.close();
    assert.equal(
      (
        await service.query("main", {
          sequence: 3,
          query: "worker",
          category: "all",
          cursor: null,
        })
      ).ok,
      true,
    );
  } finally {
    service.close();
    f.close();
  }
});

test("schema 10 迁移保留手动标题与原消息，索引重启持久化", () => {
  const f = fixture();
  let open = true;
  try {
    message(f.store, f.id, "旧库原始消息 独有内容");
    f.store.db
      .prepare("UPDATE conversations SET title='旧手动标题' WHERE id=?")
      .run(f.id);
    // The fixture restores the schema-10 index; the version-10 database below predates it.
    restorePreCodexFixture(f.store.db);
    for (const row of f.store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%search%'",
      )
      .all())
      f.store.db.exec(`DROP TRIGGER "${row.name}"`);
    f.store.db.exec(
      "DROP TABLE tool_operations; DROP TABLE capability_permissions; ALTER TABLE turns DROP COLUMN material_mode; ALTER TABLE settings DROP COLUMN appearance; ALTER TABLE conversations DROP COLUMN organization_revision; ALTER TABLE conversations DROP COLUMN pinned_at; ALTER TABLE conversations DROP COLUMN unread; ALTER TABLE conversations DROP COLUMN archived_at; ALTER TABLE conversations DROP COLUMN deleted_at; ALTER TABLE conversations DROP COLUMN retain_until; ALTER TABLE conversations DROP COLUMN purged_at; DROP TRIGGER conversation_creation_order; DROP INDEX conversations_creation_order; ALTER TABLE conversations DROP COLUMN creation_order; DROP TABLE search_fts; DROP TABLE search_documents; ALTER TABLE conversations DROP COLUMN title_revision; ALTER TABLE conversations DROP COLUMN auto_title; ALTER TABLE conversations DROP COLUMN manual_title; PRAGMA user_version=10",
    );
    f.store.close();
    open = false;
    const upgraded = new Store(f.dir);
    assert.equal(upgraded.snapshot().conversations[0].title, "旧手动标题");
    assert.equal(hits(upgraded, "独有内容").hits.length, 1);
    upgraded.close();
    const restarted = new Store(f.dir);
    assert.equal(hits(restarted, "旧手动标题").hits.length, 1);
    restarted.close();
  } finally {
    if (open) f.store.close();
    rmSync(f.dir, { recursive: true });
  }
});
test("已保存部分回答增量可查，完成后同一内容只保留正式消息索引", () => {
  const f = fixture();
  try {
    const turn = randomUUID();
    f.store.db
      .prepare(
        "INSERT INTO turns(id,conversation_id,request_id,connection_snapshot,state,created_at) VALUES(?,?,?,'{}','running',?)",
      )
      .run(turn, f.id, randomUUID(), new Date().toISOString());
    f.store.db
      .prepare("UPDATE turns SET partial_text=? WHERE id=?")
      .run("已保存的部分答案", turn);
    assert.equal(hits(f.store, "部分答案").hits[0].messageId, `turn-${turn}`);
    const mid = randomUUID();
    f.store.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,turn_id,role,content,created_at) VALUES(?,?,?,'assistant',?,?)",
      )
      .run(mid, f.id, turn, "已保存的部分答案", new Date().toISOString());
    const result = hits(f.store, "部分答案");
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].messageId, mid);
  } finally {
    f.close();
  }
});

test("丢失 FTS 表后重建从原文恢复，不依赖损坏的旧索引", () => {
  const f = fixture();
  try {
    message(f.store, f.id, "需要恢复的索引内容");
    f.store.db.exec("DROP TABLE search_fts");
    const result = f.store.execute({ type: "rebuildSearchIndex" }, "main");
    assert.equal(result.ok, true);
    assert.equal(hits(f.store, "索引内容").hits.length, 1);
  } finally {
    f.close();
  }
});

test("重建事务未提交时读取仍看到上一完整索引，回滚不丢数据", () => {
  const f = fixture();
  const reader = new DatabaseSync(join(f.dir, "state.sqlite"), {
    readOnly: true,
  });
  try {
    message(f.store, f.id, "原索引内容");
    f.store.db.exec("BEGIN IMMEDIATE");
    f.store.db
      .prepare(
        "UPDATE messages SET content='新事务内容' WHERE conversation_id=?",
      )
      .run(f.id);
    rebuildSearchIndex(f.store.db);
    const during = querySearch(reader, {
      sequence: 1,
      query: "原索引内容",
      category: "all",
      cursor: null,
    });
    assert.equal(during.ok, true);
    if (during.ok) assert.equal(during.hits.length, 1);
    f.store.db.exec("ROLLBACK");
    assert.equal(hits(f.store, "原索引内容").hits.length, 1);
    assert.equal(hits(f.store, "新事务内容").hits.length, 0);
  } finally {
    reader.close();
    f.close();
  }
});

test("最近对话按创建顺序倒序，重命名与活动更新不重排且重启保持", () => {
  const f = fixture();
  try {
    const second = randomUUID(),
      third = randomUUID();
    f.store.execute({ type: "create", id: second }, "main");
    f.store.execute({ type: "create", id: third }, "main");
    const expected = [third, second, f.id];
    const check = (store: Store) => {
      assert.deepEqual(
        store.snapshot().conversations.map((c) => c.id),
        expected,
      );
      assert.deepEqual(
        hits(store, "").hits.map((h) => h.conversationId),
        expected,
      );
    };
    check(f.store);
    assert.equal(
      f.store.execute(
        {
          type: "renameConversation",
          id: f.id,
          title: "最早创建改名",
          revision: 0,
        },
        "main",
      ).ok,
      true,
    );
    check(f.store);
    assert.equal(
      f.store.execute(
        { type: "saveDraft", id: second, text: "新草稿", revision: 0 },
        "main",
      ).ok,
      true,
    );
    message(f.store, f.id, "旧对话收到新消息");
    f.store.db
      .prepare(
        "UPDATE conversations SET updated_at='2099-01-01T00:00:00Z' WHERE id=?",
      )
      .run(f.id);
    check(f.store);
    f.store.close();
    f.close = () => rmSync(f.dir, { recursive: true });
    const reopened = new Store(f.dir);
    try {
      check(reopened);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});

test("schema 11 迁移保留旧创建顺序，不用消息或更新时间反推，VACUUM 与新建后保持", () => {
  const f = fixture();
  let store = f.store;
  let storeOpen = true;
  try {
    const second = randomUUID();
    store.execute({ type: "create", id: second }, "main");
    message(store, second, "较晚创建却更早发消息");
    store.db
      .prepare(
        "UPDATE conversations SET updated_at='2099-01-01T00:00:00Z' WHERE id=?",
      )
      .run(f.id);
    restorePreCodexFixture(store.db);
    store.db.exec(
      "DROP TABLE tool_operations; DROP TABLE capability_permissions; ALTER TABLE turns DROP COLUMN material_mode; ALTER TABLE settings DROP COLUMN appearance; ALTER TABLE conversations DROP COLUMN organization_revision; ALTER TABLE conversations DROP COLUMN pinned_at; ALTER TABLE conversations DROP COLUMN unread; ALTER TABLE conversations DROP COLUMN archived_at; ALTER TABLE conversations DROP COLUMN deleted_at; ALTER TABLE conversations DROP COLUMN retain_until; ALTER TABLE conversations DROP COLUMN purged_at; DROP TRIGGER conversation_creation_order; DROP INDEX conversations_creation_order; ALTER TABLE conversations DROP COLUMN creation_order; PRAGMA user_version=11",
    );
    store.close();
    storeOpen = false;
    store = new Store(f.dir);
    storeOpen = true;
    const check = (ids: string[]) => {
      assert.deepEqual(
        store.snapshot().conversations.map((c) => c.id),
        ids,
      );
      assert.deepEqual(
        hits(store, "").hits.map((h) => h.conversationId),
        ids,
      );
    };
    check([second, f.id]);
    store.db.exec("VACUUM");
    check([second, f.id]);
    const third = randomUUID();
    assert.equal(store.execute({ type: "create", id: third }, "main").ok, true);
    check([third, second, f.id]);
  } finally {
    if (storeOpen) store.close();
    rmSync(f.dir, { recursive: true });
  }
});

function project(store: Store, name: string, goal: string, at: string) {
  const id = randomUUID();
  store.db
    .prepare(
      "INSERT INTO projects(id,name,goal,folder_json,created_at,updated_at) VALUES(?,?,?,'{}',?,?)",
    )
    .run(id, name, goal, at, at);
  return id;
}
function search(
  store: Store,
  query: string,
  category: "all" | "conversation" | "project" | "widget" = "all",
  cursor: string | null = null,
) {
  const r = querySearch(store.db, { sequence: 1, query, category, cursor });
  if (!r.ok) throw new Error(r.message);
  return r;
}

test("三类检索：项目名称与目标、正式控件名称与已保存内容各自命中，同名分别保留身份，草稿、配置与未保留候选不进入", () => {
  const f = fixture();
  f.store.close();
  const widgets = seedRetainedWidgets(f.dir, ["汇率看板", "汇率看板"]);
  seedWidgetCandidate(f.dir);
  const store = new Store(f.dir);
  try {
    const first = project(
      store,
      "松果计划",
      "整理松果标本",
      "2026-10-01T00:00:00Z",
    );
    const second = project(store, "松果计划", "", "2026-10-02T00:00:00Z");
    const archived = project(
      store,
      "旧项目",
      "只在归档项目目标里的词",
      "2026-09-01T00:00:00Z",
    );
    store.db
      .prepare("UPDATE projects SET archived_at=? WHERE id=?")
      .run("2026-09-02T00:00:00Z", archived);
    const candidate = (id: string) =>
      widgets.find((w) => w.id === id)!.candidateId;
    store.db
      .prepare(
        "UPDATE widget_previews SET data=?,config=? WHERE candidate_id=?",
      )
      .run(
        JSON.stringify({ notes: ["只在控件数据里的词", { deep: "第二段" }] }),
        JSON.stringify({ token: "配置里的秘密口令" }),
        candidate(widgets[0].id),
      );
    // An unretained preview's data and a draft's name never become results.
    const preview = store
      .snapshot()
      .widgetGeneration!.candidates.find((c) => c.state === "preview")!;
    store.db
      .prepare("UPDATE widget_previews SET data=? WHERE candidate_id=?")
      .run(JSON.stringify({ note: "未保留候选的词" }), preview.id);
    store.execute(
      {
        type: "createWidgetDraft",
        id: randomUUID(),
        name: "草稿名称独有",
        sourceConversationId: null,
      },
      "main",
    );

    const named = search(store, "松果计划");
    assert.deepEqual(named.counts, { conversation: 0, project: 2, widget: 0 });
    assert.deepEqual(
      named.hits.map((h) => [h.kind, h.objectId]),
      [
        ["project", second],
        ["project", first],
      ],
    );
    assert.deepEqual(named.hits[0].titleRanges, [[0, 4]]);
    const goal = search(store, "松果标本", "project");
    assert.equal(goal.hits[0].objectId, first);
    assert.equal(goal.hits[0].text, "整理松果标本");
    assert.deepEqual(goal.hits[0].ranges, [[2, 6]]);
    const old = search(store, "归档项目目标");
    assert.equal(old.hits[0].archived, true);
    assert.equal(old.hits[0].updatedAt, "2026-09-01T00:00:00Z");

    const widgetName = search(store, "汇率看板");
    assert.deepEqual(widgetName.counts, {
      conversation: 0,
      project: 0,
      widget: 2,
    });
    assert.deepEqual(
      widgetName.hits.map((h) => h.objectId),
      widgets.map((w) => w.id),
    );
    assert.equal(widgetName.hits[0].updatedAt, null);
    const content = search(store, "控件数据里", "widget");
    assert.deepEqual(
      content.hits.map((h) => h.objectId),
      [widgets[0].id],
    );
    assert.match(content.hits[0].text, /只在控件数据里的词/);
    assert.equal(search(store, "第二段").counts.widget, 1);
    for (const hidden of [
      "配置里的秘密",
      "未保留候选",
      "草稿名称独有",
      "token",
    ])
      assert.deepEqual(
        search(store, hidden).counts,
        { conversation: 0, project: 0, widget: 0 },
        hidden,
      );

    // The index follows the source rows in the same transaction.
    store.db
      .prepare("UPDATE projects SET name='松果计划二期' WHERE id=?")
      .run(second);
    assert.equal(search(store, "二期").hits[0].objectId, second);
    store.db
      .prepare("UPDATE widget_previews SET data=? WHERE candidate_id=?")
      .run(JSON.stringify({ notes: [] }), candidate(widgets[0].id));
    assert.equal(search(store, "控件数据里").counts.widget, 0);
    store.db.prepare("DELETE FROM saved_widgets WHERE id=?").run(widgets[1].id);
    assert.deepEqual(
      search(store, "汇率看板").hits.map((h) => h.objectId),
      [widgets[0].id],
    );
  } finally {
    store.close();
    rmSync(f.dir, { recursive: true });
  }
});

test("一致快照与键集分页：翻页间的新写入不重复不遗漏，计数与结果同一修订，非法翻页位置拒绝", () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 50 }, (_, i) =>
      project(
        f.store,
        `共同项目 ${i}`,
        "",
        `2026-10-01T00:${String(i).padStart(2, "0")}:00Z`,
      ),
    );
    const first = search(f.store, "共同项目", "project");
    assert.equal(first.hits.length, 40);
    assert.equal(first.counts.project, 50);
    const revision = first.snapshot.revision;
    // A newer project sorts before the first page; it must not shift the second page.
    const newer = project(f.store, "共同项目 新", "", "2026-10-02T00:00:00Z");
    const second = search(f.store, "共同项目", "project", first.next);
    assert.equal(second.counts.project, 51);
    assert.ok(second.snapshot.revision > revision);
    const seen = [...first.hits, ...second.hits].map((h) => h.objectId);
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(new Set(seen), new Set(ids));
    assert.equal(second.next, null);
    assert.equal(
      search(f.store, "共同项目", "project").hits[0].objectId,
      newer,
    );
    // 全部 shows the first hits of each kind and no pages.
    const all = search(f.store, "共同项目");
    assert.equal(all.hits.length, 10);
    assert.equal(all.next, null);
    for (const cursor of [
      "garbage",
      JSON.stringify(["widget", 1, "x"]),
      JSON.stringify(["project", "only-one"]),
    ]) {
      const refused = querySearch(f.store.db, {
        sequence: 1,
        query: "共同项目",
        category: "project",
        cursor,
      });
      assert.equal(refused.ok, false, cursor);
      if (!refused.ok) assert.equal(refused.code, "INVALID_QUERY");
    }
    const allPaged = querySearch(f.store.db, {
      sequence: 1,
      query: "共同项目",
      category: "all",
      cursor: first.next,
    });
    assert.equal(allPaged.ok, false);
  } finally {
    f.close();
  }
});

test("三类索引重建失败保留上一代索引与原数据，成功后代次推进；schema 34 升级重建三类索引", () => {
  const f = fixture();
  f.store.close();
  const widgets = seedRetainedWidgets(f.dir, ["重建控件"]);
  let store = new Store(f.dir);
  try {
    const id = project(store, "重建项目", "重建目标", "2026-10-01T00:00:00Z");
    const before = search(store, "重建");
    assert.deepEqual(before.counts, { conversation: 0, project: 1, widget: 1 });
    store.db.exec(
      "CREATE TEMP TRIGGER reject_widget_rebuild BEFORE INSERT ON search_documents WHEN NEW.kind='widget' BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    const failed = store.execute({ type: "rebuildSearchIndex" }, "main");
    assert.equal(failed.ok, false);
    assert.deepEqual(search(store, "重建"), before);
    store.db.exec("DROP TRIGGER reject_widget_rebuild");
    assert.equal(
      store.execute({ type: "rebuildSearchIndex" }, "main").ok,
      true,
    );
    const after = search(store, "重建");
    assert.deepEqual(after.hits, before.hits);
    assert.equal(after.snapshot.generation, before.snapshot.generation + 1);

    restorePreUnifiedSearchFixture(store.db);
    store.close();
    store = new Store(f.dir);
    assert.equal(
      (
        store.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
      35,
    );
    assert.deepEqual(
      search(store, "重建").hits.map((h) => [h.kind, h.objectId]),
      [
        ["project", id],
        ["widget", widgets[0].id],
      ],
    );
  } finally {
    store.close();
    rmSync(f.dir, { recursive: true });
  }
});
