import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, migrations, schemaVersion } from "../../src/service/store";
import { migrateConversationOrder } from "../../src/service/conversation-order";
import { unarchiveOnSubmit } from "../../src/service/organization";
import {
  validCommand,
  type ConversationAction,
  type Snapshot,
} from "../../src/shared/protocol";

mkdirSync(".test-data/disposable", { recursive: true });
const root = () =>
  mkdtempSync(resolve(".test-data/disposable/conversation-order-"));

function act(
  store: Store,
  id: string,
  action: ConversationAction,
  confirmed = false,
) {
  const c = store.snapshot().conversations.find((c) => c.id === id)!;
  const reply = store.execute(
    {
      type: "organizeConversation",
      id,
      action,
      revision: c.organizationRevision,
      confirmed,
    },
    "main",
  );
  assert.ok(reply.ok, `${action}: ${reply.ok ? "" : reply.message}`);
}
const find = (snapshot: Snapshot, id: string) =>
  snapshot.conversations.find((c) => c.id === id)!;
function version(db: DatabaseSync) {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
}
/** Every row of every table, so that a failed migration can be compared with the data before it. */
function dump(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
    return {
      version: version(db),
      schema: db
        .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name")
        .all(),
      rows: Object.fromEntries(
        tables.map((name) => [
          name,
          (db.prepare(`SELECT * FROM "${name}"`).all() as unknown[])
            .map((row) => JSON.stringify(row))
            .sort(),
        ]),
      ),
    };
  } finally {
    db.close();
  }
}
/** A data root at schema 26 with pinned, unread, archived (still carrying a pin), deleted and named rows. */
function legacyRoot() {
  const dir = root();
  const store = new Store(dir);
  const ids = Array.from({ length: 6 }, () => randomUUID());
  for (const [index, id] of ids.entries()) {
    assert.ok(store.execute({ type: "create", id }, "main").ok);
    assert.ok(
      store.execute(
        {
          type: "renameConversation",
          id,
          title: index === 5 ? "同名" : `对话 ${index}`,
          revision: 0,
        },
        "main",
      ).ok,
    );
  }
  store.db
    .prepare(
      "INSERT INTO messages(id,conversation_id,turn_id,role,content,created_at) VALUES(?,?,NULL,'user','旧消息',?)",
    )
    .run(randomUUID(), ids[0], "2026-01-02T03:04:05.000Z");
  act(store, ids[0], "pin");
  act(store, ids[1], "unread");
  act(store, ids[2], "archive");
  act(store, ids[3], "delete", true);
  act(store, ids[4], "pin");
  store.close();
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  // Before this version an archived conversation kept its pin; recreate such a row.
  db.prepare("UPDATE conversations SET pinned_at=? WHERE id=?").run(
    "2026-01-03T00:00:00.000Z",
    ids[2],
  );
  db.exec(`DROP TRIGGER conversation_created_at;
    ALTER TABLE conversations DROP COLUMN created_at;
    DROP TABLE pinned_order;
    PRAGMA user_version=26;`);
  db.close();
  return { dir, ids };
}

test("conversation order: schema 26 data migrates to 27 keeping every conversation, pin, unread and archive state, and old rows get no invented creation time", () => {
  const { dir, ids } = legacyRoot();
  const before = dump(join(dir, "state.sqlite"));
  assert.equal(before.version, 26);
  const store = new Store(dir);
  try {
    assert.equal(schemaVersion, 27);
    assert.equal(version(store.db), 27);
    const snapshot = store.snapshot();
    const expected = (before.rows.conversations as string[])
      .map((row) => JSON.parse(row) as Record<string, unknown>)
      .filter((row) => row.purged_at === null);
    assert.equal(snapshot.conversations.length, expected.length);
    for (const row of expected) {
      const c = find(snapshot, String(row.id));
      assert.equal(c.title, row.title);
      assert.equal(c.pinnedAt, row.pinned_at);
      assert.equal(c.unread, row.unread === 1);
      assert.equal(c.archivedAt, row.archived_at);
      assert.equal(c.deletedAt, row.deleted_at);
      assert.equal(c.createdAt, null, "no creation time for an old row");
    }
    assert.equal(find(snapshot, ids[0]).messageCount, 1);
    assert.deepEqual(snapshot.pinnedOrder, []);
    // A conversation created from now on records its creation time, through either insert path.
    const fresh = randomUUID();
    const start = Date.now();
    assert.ok(store.execute({ type: "create", id: fresh }, "main").ok);
    const created = find(store.snapshot(), fresh).createdAt!;
    assert.match(created, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.ok(Math.abs(Date.parse(created) - start) < 5000);
    const other = randomUUID();
    store.db
      .prepare(
        "INSERT INTO conversations(id,title,updated_at) VALUES(?,'项目对话',?)",
      )
      .run(other, new Date().toISOString());
    assert.match(find(store.snapshot(), other).createdAt!, /Z$/);
  } finally {
    store.close();
  }
  // Opening again does not migrate again and keeps the data.
  const again = new Store(dir);
  try {
    assert.equal(version(again.db), 27);
    assert.equal(find(again.snapshot(), ids[1]).unread, true);
  } finally {
    again.close();
  }
});

test("conversation order: a migration that fails part way rolls back, keeps every row as it was, leaves a verified backup and succeeds once repaired", () => {
  const { dir } = legacyRoot();
  const path = join(dir, "state.sqlite");
  const before = dump(path);
  const original = migrations[26];
  migrations[26] = (db) => {
    migrateConversationOrder(db);
    db.exec(
      "INSERT INTO pinned_order(kind,id,position) VALUES('conversation','x',0)",
    );
    throw new Error("injected failure after the new table");
  };
  try {
    assert.throws(
      () => new Store(dir),
      (error: Error & { code?: string }) =>
        error.code === "INVALID_ROOT" && /原数据未被替换/.test(error.message),
    );
  } finally {
    migrations[26] = original;
  }
  assert.deepEqual(dump(path), before);
  const backups = readdirSync(dirname(dir)).filter((name) =>
    name.startsWith(`${basename(dir)}-schema-26-backup-`),
  );
  assert.ok(backups.length >= 1, "a backup was taken before the upgrade");
  const copy = dump(join(dirname(dir), backups[0], "data", "state.sqlite"));
  assert.deepEqual(copy.rows, before.rows);
  const store = new Store(dir);
  try {
    assert.equal(version(store.db), 27);
  } finally {
    store.close();
  }
});

test("conversation order: a partly migrated database with the column, the trigger and the table already present migrates again", () => {
  const dir = root();
  new Store(dir).close();
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  db.exec("PRAGMA user_version=26");
  db.close();
  const store = new Store(dir);
  try {
    assert.equal(version(store.db), 27);
    const id = randomUUID();
    assert.ok(store.execute({ type: "create", id }, "main").ok);
    assert.notEqual(find(store.snapshot(), id).createdAt, null);
    assert.equal(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='conversation_created_at'",
          )
          .get() as { n: number }
      ).n,
      1,
    );
  } finally {
    store.close();
  }
});

test("conversation order: archiving or deleting leaves the pinned section, and leaving the archive, the trash or sending in an archived conversation never pins again", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of [a, b, c]) {
      assert.ok(store.execute({ type: "create", id }, "main").ok);
      act(store, id, "pin");
    }
    const move = (id: string, before: string | null) =>
      store.execute(
        {
          type: "movePinned",
          kind: "conversation",
          id,
          before: before ? { kind: "conversation", id: before } : null,
          revision: find(store.snapshot(), id).organizationRevision,
        },
        "main",
      );
    assert.ok(move(a, null).ok);
    assert.equal(
      store.snapshot().pinnedOrder.some((r) => r.id === a),
      true,
    );
    act(store, a, "archive");
    let s = store.snapshot();
    assert.equal(find(s, a).pinnedAt, null);
    assert.equal(
      s.pinnedOrder.some((r) => r.id === a),
      false,
    );
    act(store, a, "unarchive");
    assert.equal(find(store.snapshot(), a).pinnedAt, null);
    act(store, b, "delete", true);
    s = store.snapshot();
    assert.equal(find(s, b).pinnedAt, null);
    act(store, b, "restore");
    assert.equal(find(store.snapshot(), b).pinnedAt, null);
    act(store, c, "unpin");
    assert.equal(find(store.snapshot(), c).pinnedAt, null);
    // An archived row that still carries a pin from an older version loses it when a message is sent.
    store.db
      .prepare("UPDATE conversations SET archived_at=?, pinned_at=? WHERE id=?")
      .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", c);
    unarchiveOnSubmit(store.db, c, new Date().toISOString());
    const row = store.db
      .prepare("SELECT archived_at, pinned_at FROM conversations WHERE id=?")
      .get(c) as { archived_at: string | null; pinned_at: string | null };
    assert.deepEqual({ ...row }, { archived_at: null, pinned_at: null });
  } finally {
    store.close();
  }
});

test("conversation order: moving a pinned conversation changes only the display order, starts from what is shown and refuses stale, unpinned, archived and deleted targets", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) {
      assert.ok(store.execute({ type: "create", id }, "main").ok);
      act(store, id, "pin");
    }
    const pins = () =>
      Object.fromEntries(
        store.snapshot().conversations.map((c) => [c.id, c.pinnedAt]),
      );
    const pinnedBefore = pins();
    const move = (id: string, before: string | null, revision?: number) =>
      store.execute(
        {
          type: "movePinned",
          kind: "conversation",
          id,
          before: before ? { kind: "conversation", id: before } : null,
          revision: revision ?? find(store.snapshot(), id).organizationRevision,
        },
        "main",
      );
    // Shown order before any move: newest pin first (ids[3], ids[2], ids[1], ids[0]).
    assert.ok(move(ids[0], ids[3]).ok);
    assert.deepEqual(
      store.snapshot().pinnedOrder.map((r) => r.id),
      [ids[0], ids[3], ids[2], ids[1]],
    );
    assert.ok(move(ids[3], null).ok);
    assert.deepEqual(
      store.snapshot().pinnedOrder.map((r) => r.id),
      [ids[0], ids[2], ids[1], ids[3]],
    );
    assert.deepEqual(pins(), pinnedBefore, "moving never changes pin times");
    const snapshot = store.snapshot();
    const stale = find(snapshot, ids[1]).organizationRevision - 1;
    assert.equal(move(ids[1], ids[0], stale).ok, false);
    act(store, ids[2], "unpin");
    assert.equal(move(ids[2], ids[0]).ok, false);
    assert.equal(move(ids[1], ids[2]).ok, false, "target no longer pinned");
    act(store, ids[3], "archive");
    assert.equal(move(ids[3], ids[0]).ok, false);
    act(store, ids[1], "delete", true);
    assert.equal(move(ids[1], null).ok, false);
    assert.deepEqual(
      store.snapshot().pinnedOrder.map((r) => r.id),
      [ids[0]],
    );
    // A new pin is missing from the saved order and comes first in the manual order.
    const fresh = randomUUID();
    assert.ok(store.execute({ type: "create", id: fresh }, "main").ok);
    act(store, fresh, "pin");
    assert.ok(move(ids[0], null).ok);
    assert.deepEqual(
      store.snapshot().pinnedOrder.map((r) => r.id),
      [fresh, ids[0]],
    );
    for (const command of [
      {
        type: "movePinned",
        kind: "project",
        id: ids[0],
        before: null,
        revision: 0,
      },
      {
        type: "movePinned",
        kind: "conversation",
        id: ids[0],
        before: null,
        revision: -1,
      },
      {
        type: "movePinned",
        kind: "conversation",
        id: ids[0],
        before: { kind: "conversation", id: ids[0] },
        revision: 0,
      },
      {
        type: "movePinned",
        kind: "conversation",
        id: ids[0],
        before: { id: fresh },
        revision: 0,
      },
      {
        type: "movePinned",
        kind: "conversation",
        id: ids[0],
        before: null,
        revision: 0,
        extra: 1,
      },
    ])
      assert.equal(validCommand(command), false, JSON.stringify(command));
  } finally {
    store.close();
  }
});

test("conversation order: the title source is the person's name, then the first user message, then the default name", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    const id = randomUUID();
    assert.ok(store.execute({ type: "create", id }, "main").ok);
    assert.equal(find(store.snapshot(), id).titleSource, "default");
    store.db
      .prepare(
        "UPDATE conversations SET auto_title='整理笔记', title='整理笔记' WHERE id=?",
      )
      .run(id);
    assert.equal(find(store.snapshot(), id).titleSource, "first-message");
    assert.ok(
      store.execute(
        { type: "renameConversation", id, title: "我的名字", revision: 0 },
        "main",
      ).ok,
    );
    assert.equal(find(store.snapshot(), id).titleSource, "manual");
  } finally {
    store.close();
  }
});

test("conversation order: starting a new conversation reuses the unused one instead of adding rows, and never reuses one with content, a name, a pin, an archive or the other surface's selection", () => {
  const dir = root();
  const store = new Store(dir);
  try {
    const start = (surface: "main" | "panel" = "main") => {
      const id = randomUUID();
      const reply = store.execute({ type: "newConversation", id }, surface);
      assert.ok(reply.ok);
      return { requested: id, selected: reply.snapshot.selected[surface]! };
    };
    const first = start();
    assert.equal(first.selected, first.requested);
    assert.equal(find(store.snapshot(), first.selected).unused, true);
    const second = start();
    assert.equal(second.selected, first.selected, "the unused one is reused");
    assert.equal(store.snapshot().conversations.length, 1);
    // The panel shows its own new conversation: the main window's unused one stays the main window's.
    const panel = start("panel");
    assert.notEqual(panel.selected, first.selected);
    assert.equal(store.snapshot().conversations.length, 2);
    // Draft text makes it used.
    assert.ok(
      store.execute(
        { type: "saveDraft", id: first.selected, text: "想法", revision: 0 },
        "main",
      ).ok,
    );
    assert.equal(find(store.snapshot(), first.selected).unused, false);
    const third = start();
    assert.equal(third.selected, third.requested);
    // A name, a pin or an archive also make it used; whitespace alone does not.
    assert.ok(
      store.execute(
        {
          type: "renameConversation",
          id: third.selected,
          title: "名字",
          revision: 0,
        },
        "main",
      ).ok,
    );
    assert.equal(find(store.snapshot(), third.selected).unused, false);
    const fourth = start();
    act(store, fourth.selected, "pin");
    assert.equal(find(store.snapshot(), fourth.selected).unused, false);
    const fifth = start();
    assert.ok(
      store.execute(
        { type: "saveDraft", id: fifth.selected, text: "   ", revision: 0 },
        "main",
      ).ok,
    );
    assert.equal(find(store.snapshot(), fifth.selected).unused, true);
    act(store, fifth.selected, "archive");
    assert.equal(find(store.snapshot(), fifth.selected).unused, false);
    const sixth = start();
    assert.equal(sixth.selected, sixth.requested);
    // Messages make it used.
    store.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,turn_id,role,content,created_at) VALUES(?,?,NULL,'user','你好',?)",
      )
      .run(randomUUID(), sixth.selected, new Date().toISOString());
    assert.equal(find(store.snapshot(), sixth.selected).unused, false);
    // The explicit create command keeps creating the identity it names.
    const explicit = randomUUID();
    assert.ok(store.execute({ type: "create", id: explicit }, "main").ok);
    assert.equal(store.snapshot().selected.main, explicit);
    assert.equal(
      validCommand({ type: "newConversation", id: explicit, x: 1 }),
      false,
    );
  } finally {
    store.close();
  }
});
