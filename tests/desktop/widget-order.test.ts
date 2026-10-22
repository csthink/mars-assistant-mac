import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Store, schemaVersion } from "../../src/service/store";
import {
  seedRetainedWidgets,
  seedWidgetCandidate,
} from "./widget-generation-fixture";

function root() {
  mkdirSync(".test-data/disposable", { recursive: true });
  return mkdtempSync(resolve(".test-data/disposable/widget-order-"));
}
const names = ["天气", "便笺", "计时", "便笺", "汇率"];
const order = (store: Store) =>
  store.snapshot().widgetGeneration!.widgets.map((w) => w.id);

test("widget order: moves commit atomically with a revision, stale and invalid moves change nothing", () => {
  const dir = root();
  const seeded = seedRetainedWidgets(dir, names);
  const store = new Store(dir);
  try {
    const before = store.snapshot().widgetGeneration!;
    assert.deepEqual(
      before.widgets.map((w) => w.position),
      [1, 2, 3, 4, 5],
    );
    // Each retain appended to the end and advanced the revision.
    assert.equal(before.orderRevision, 5);
    const data = store.db
      .prepare("SELECT candidate_id,data,data_revision FROM widget_previews")
      .all();
    const ids = seeded.map((w) => w.id);
    const move = (widgetId: string, toIndex: number, orderRevision: number) =>
      store.execute(
        { type: "moveWidget", widgetId, toIndex, orderRevision },
        "main",
      );
    assert(move(ids[4], 0, 5).ok);
    assert.deepEqual(order(store), [ids[4], ids[0], ids[1], ids[2], ids[3]]);
    assert.equal(store.snapshot().widgetGeneration!.orderRevision, 6);
    // Same-name widgets keep separate identities; the second 便笺 moves, the first stays.
    assert(move(ids[3], 1, 6).ok);
    assert.deepEqual(order(store), [ids[4], ids[3], ids[0], ids[1], ids[2]]);
    // A request that saw an older order is refused and changes nothing.
    const stale = move(ids[0], 4, 6);
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.code, "CONFLICT");
    const missing = move("no-such-widget", 0, 7);
    assert.equal(!missing.ok && missing.code, "NOT_FOUND");
    const beyond = move(ids[0], 5, 7);
    assert.equal(!beyond.ok && beyond.code, "INVALID_COMMAND");
    assert.equal(
      store.execute(
        { type: "moveWidget", widgetId: ids[0], toIndex: -1, orderRevision: 7 },
        "main",
      ).ok,
      false,
    );
    assert.deepEqual(order(store), [ids[4], ids[3], ids[0], ids[1], ids[2]]);
    assert.equal(store.snapshot().widgetGeneration!.orderRevision, 7);
    // Moving to its own place is accepted without a new revision.
    assert(move(ids[0], 2, 7).ok);
    assert.equal(store.snapshot().widgetGeneration!.orderRevision, 7);
    // Content, versions and widget data are untouched by ordering.
    assert.deepEqual(
      store.db
        .prepare("SELECT candidate_id,data,data_revision FROM widget_previews")
        .all(),
      data,
    );
    for (const w of store.snapshot().widgetGeneration!.widgets) {
      const old = before.widgets.find((b) => b.id === w.id)!;
      assert.equal(w.revision, old.revision);
      assert.equal(w.candidateId, old.candidateId);
      assert.equal(w.name, old.name);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("widget order: a failed write rolls back positions and revision; restart keeps the committed order", () => {
  const dir = root();
  const ids = seedRetainedWidgets(dir, names).map((w) => w.id);
  let store = new Store(dir);
  try {
    assert(
      store.execute(
        { type: "moveWidget", widgetId: ids[2], toIndex: 0, orderRevision: 5 },
        "main",
      ).ok,
    );
    const committed = order(store);
    store.db.exec(
      "CREATE TEMP TRIGGER fail_order BEFORE UPDATE OF position ON saved_widgets WHEN NEW.position>0 BEGIN SELECT RAISE(ABORT,'injected order failure'); END;",
    );
    const failed = store.execute(
      { type: "moveWidget", widgetId: ids[4], toIndex: 0, orderRevision: 6 },
      "main",
    );
    assert.equal(failed.ok, false);
    assert.equal(!failed.ok && failed.code, "WRITE_FAILED");
    assert.deepEqual(order(store), committed);
    assert.deepEqual(
      store.snapshot().widgetGeneration!.widgets.map((w) => w.position),
      [1, 2, 3, 4, 5],
    );
    assert.equal(store.snapshot().widgetGeneration!.orderRevision, 6);
    store.close();
    store = new Store(dir);
    assert.deepEqual(order(store), committed);
    assert.equal(store.snapshot().widgetGeneration!.orderRevision, 6);
    // The next retained widget joins the end of the user's order.
    store.close();
    seedRetainedWidgets(dir, ["新控件"]);
    store = new Store(dir);
    const after = store.snapshot().widgetGeneration!;
    assert.deepEqual(
      after.widgets.slice(0, 5).map((w) => w.id),
      committed,
    );
    assert.equal(after.widgets[5].name, "新控件");
    assert.equal(after.widgets[5].position, 6);
    assert.equal(after.orderRevision, 7);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("widget order migration: schema 34 positions with gaps become 1..N in the same order at revision 0", () => {
  const dir = root();
  const ids = seedRetainedWidgets(dir, ["甲", "乙", "丙"]).map((w) => w.id);
  // An unretained candidate stays out of the order.
  seedWidgetCandidate(dir);
  let store = new Store(dir);
  try {
    store.db.exec(`UPDATE saved_widgets SET position=position*10;
      UPDATE saved_widgets SET position=5 WHERE id='${ids[2]}';
      DROP TABLE widget_order; PRAGMA user_version=34;`);
    store.close();
    store = new Store(dir);
    const after = store.snapshot().widgetGeneration!;
    assert.equal(
      (
        store.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
      schemaVersion,
    );
    assert.deepEqual(
      after.widgets.map((w) => [w.id, w.position]),
      [
        [ids[2], 1],
        [ids[0], 2],
        [ids[1], 3],
      ],
    );
    assert.equal(after.orderRevision, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
