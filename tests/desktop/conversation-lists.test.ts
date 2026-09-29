import { test } from "node:test";
import assert from "node:assert/strict";
import {
  archivedRows,
  dateGroup,
  nextMidnight,
  pinnedRows,
  recentGroups,
  sameNameCounts,
} from "../../src/renderer/conversation-lists";
import type { Conversation } from "../../src/shared/protocol";

/** Local times, so the checks hold in any time zone. */
const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min);
const iso = (date: Date) => date.toISOString();
let order = 0;
function conversation(fields: Partial<Conversation>): Conversation {
  order += 1;
  return {
    id: `c${order}`,
    title: `对话 ${order}`,
    titleSource: "manual",
    createdAt: null,
    creationOrder: order,
    unused: false,
    titleRevision: 0,
    organizationRevision: 0,
    pinnedAt: null,
    unread: false,
    archivedAt: null,
    deletedAt: null,
    retainUntil: null,
    draft: "",
    revision: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    preview: "",
    messageCount: 1,
    connectionId: null,
    modelId: null,
    effort: null,
    lastProvider: null,
    lastDestination: null,
    grantedConnections: [],
    grantedProviders: [],
    ...fields,
  };
}

test("conversation lists: creation dates group into today, yesterday, this week from Monday, earlier and not available", () => {
  // Wednesday 30 September 2026, 10:00 local.
  const now = at(2026, 9, 30, 10);
  assert.equal(dateGroup(iso(at(2026, 9, 30, 0, 0)), now), "today");
  assert.equal(dateGroup(iso(at(2026, 9, 30, 23, 59)), now), "today");
  assert.equal(dateGroup(iso(at(2026, 9, 29, 23, 59)), now), "yesterday");
  assert.equal(dateGroup(iso(at(2026, 9, 29, 0, 0)), now), "yesterday");
  assert.equal(dateGroup(iso(at(2026, 9, 28, 23, 59)), now), "week");
  assert.equal(dateGroup(iso(at(2026, 9, 28, 0, 0)), now), "week", "Monday");
  assert.equal(
    dateGroup(iso(at(2026, 9, 27, 23, 59)), now),
    "earlier",
    "Sunday before",
  );
  assert.equal(dateGroup(null, now), "unknown");
  assert.equal(dateGroup("not a time", now), "unknown");
  // On a Monday the week has only today; Sunday is yesterday, not this week.
  const monday = at(2026, 9, 28, 9);
  assert.equal(dateGroup(iso(at(2026, 9, 27, 18)), monday), "yesterday");
  assert.equal(dateGroup(iso(at(2026, 9, 26, 18)), monday), "earlier");
  // On a Sunday the week reaches back to Monday.
  const sunday = at(2026, 10, 4, 20);
  assert.equal(dateGroup(iso(at(2026, 9, 28, 1)), sunday), "week");
  assert.equal(dateGroup(iso(at(2026, 9, 27, 23)), sunday), "earlier");
  // Across a month and a year boundary.
  const firstOfMonth = at(2026, 10, 1, 8);
  assert.equal(dateGroup(iso(at(2026, 9, 30, 22)), firstOfMonth), "yesterday");
  const newYear = at(2027, 1, 1, 0, 30);
  assert.equal(dateGroup(iso(at(2026, 12, 31, 23, 59)), newYear), "yesterday");
  assert.equal(dateGroup(iso(at(2027, 1, 1, 0, 1)), newYear), "today");
  // Around midnight the same creation time moves from today to yesterday.
  const created = iso(at(2026, 9, 30, 23, 50));
  assert.equal(dateGroup(created, at(2026, 9, 30, 23, 59)), "today");
  assert.equal(dateGroup(created, at(2026, 10, 1, 0, 1)), "yesterday");
  assert.equal(
    nextMidnight(at(2026, 9, 30, 23, 59)),
    at(2026, 10, 1, 0, 0).getTime(),
  );
});

test("conversation lists: the recent list keeps creation order inside and across groups, leaves out pinned, archived, deleted and unused rows and filters by title only", () => {
  const now = at(2026, 9, 30, 10);
  const legacy = conversation({ title: "旧对话" });
  const earlier = conversation({ createdAt: iso(at(2026, 9, 20)) });
  const week = conversation({
    createdAt: iso(at(2026, 9, 28)),
    title: "读书笔记",
  });
  const yesterday = conversation({ createdAt: iso(at(2026, 9, 29)) });
  const todayOld = conversation({ createdAt: iso(at(2026, 9, 30, 8)) });
  // Renamed and updated later: still at its creation position.
  const todayNew = conversation({
    createdAt: iso(at(2026, 9, 30, 9)),
    title: "改过名字",
    updatedAt: "2020-01-01T00:00:00.000Z",
  });
  const pinned = conversation({
    createdAt: iso(at(2026, 9, 30, 9, 30)),
    pinnedAt: "2026-09-30T02:00:00.000Z",
  });
  const archivedPin = conversation({
    createdAt: iso(at(2026, 9, 30, 9, 40)),
    pinnedAt: "2026-09-30T02:00:00.000Z",
    archivedAt: "2026-09-30T03:00:00.000Z",
  });
  const deleted = conversation({
    createdAt: iso(at(2026, 9, 30, 9, 45)),
    deletedAt: "2026-09-30T03:00:00.000Z",
  });
  const unused = conversation({
    createdAt: iso(at(2026, 9, 30, 9, 50)),
    unused: true,
  });
  const all = [
    legacy,
    earlier,
    week,
    yesterday,
    todayOld,
    todayNew,
    pinned,
    archivedPin,
    deleted,
    unused,
  ];
  const groups = recentGroups(all, now);
  assert.deepEqual(
    groups.map((g) => [g.group, g.items.map((c) => c.id)]),
    [
      ["today", [todayNew.id, todayOld.id]],
      ["yesterday", [yesterday.id]],
      ["week", [week.id]],
      ["earlier", [earlier.id]],
      ["unknown", [legacy.id]],
    ],
  );
  assert.deepEqual(
    recentGroups(all, now, "读书").map((g) => [
      g.group,
      g.items.map((c) => c.id),
    ]),
    [["week", [week.id]]],
  );
  assert.deepEqual(recentGroups(all, now, "不存在"), []);
  assert.deepEqual(
    archivedRows(all).map((c) => c.id),
    [archivedPin.id],
  );
  const counts = sameNameCounts([
    conversation({ title: "同名" }),
    conversation({ title: "同名" }),
    conversation({ title: "同名", unused: true }),
  ]);
  assert.equal(counts.get("同名"), 2);
});

test("conversation lists: the pinned section orders by pin time, by last update or by the manual order, with new pins first in manual order", () => {
  const a = conversation({
    pinnedAt: "2026-09-30T01:00:00.000Z",
    updatedAt: "2026-09-30T05:00:00.000Z",
  });
  const b = conversation({
    pinnedAt: "2026-09-30T03:00:00.000Z",
    updatedAt: "2026-09-30T04:00:00.000Z",
  });
  const c = conversation({
    pinnedAt: "2026-09-30T02:00:00.000Z",
    updatedAt: "2026-09-30T06:00:00.000Z",
  });
  const archived = conversation({
    pinnedAt: "2026-09-30T04:00:00.000Z",
    archivedAt: "2026-09-30T04:30:00.000Z",
  });
  const plain = conversation({});
  const all = [a, b, c, archived, plain];
  const ids = (rows: Conversation[]) => rows.map((r) => r.id);
  assert.deepEqual(ids(pinnedRows(all, "pinned", [])), [b.id, c.id, a.id]);
  assert.deepEqual(ids(pinnedRows(all, "updated", [])), [c.id, a.id, b.id]);
  const order = [
    { kind: "conversation" as const, id: a.id },
    { kind: "conversation" as const, id: c.id },
  ];
  assert.deepEqual(ids(pinnedRows(all, "manual", order)), [b.id, a.id, c.id]);
  assert.deepEqual(ids(pinnedRows(all, "manual", [])), [b.id, c.id, a.id]);
  // Switching back to pin time shows the pin order again; pin times were never changed.
  assert.deepEqual(ids(pinnedRows(all, "pinned", order)), [b.id, c.id, a.id]);
});
