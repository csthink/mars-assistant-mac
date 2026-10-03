import { restorePreWidgetGenerationFixture } from "./legacy-codex-schema";
import { test, expect, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeLocal, launchLocal } from "./local-client";
import { Store } from "../../src/service/store";
import type { Snapshot } from "../../src/shared/protocol";

/* The sidebar's conversation area of the main window: the pinned section and the recent list grouped by
   creation date, section folds and the pinned order, renaming in place, the centre title row with its menu,
   the archived page and the right column's files and turn events. */

/** Local noon a number of days before today, as a stored creation time. */
function daysAgo(days: number) {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - days,
    12,
  ).toISOString();
}

interface Seeded {
  root: string;
  ids: Record<string, string>;
}
/**
 * Conversations with known creation dates and states: today, yesterday, eight days ago (always before this
 * week), an old row without a creation time, a pinned and an archived one, and one with a message.
 */
function seed(): Seeded {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/sidebar-conv-"));
  const store = new Store(root);
  const names = {
    legacy: "没有创建时间的旧对话",
    earlier: "八天前的对话",
    yesterday: "昨天的对话",
    today: "今天的对话",
    pinned: "置顶的对话",
    archived: "归档的对话",
  };
  const ids: Record<string, string> = {};
  for (const [key, title] of Object.entries(names)) {
    const id = randomUUID();
    ids[key] = id;
    store.execute({ type: "create", id }, "main");
    store.execute(
      { type: "renameConversation", id, title, revision: 0 },
      "main",
    );
  }
  const created = store.db.prepare(
    "UPDATE conversations SET created_at=? WHERE id=?",
  );
  created.run(null, ids.legacy);
  created.run(daysAgo(8), ids.earlier);
  created.run(daysAgo(1), ids.yesterday);
  created.run(new Date(Date.now() - 60_000).toISOString(), ids.today);
  store.db
    .prepare(
      "INSERT INTO messages(id,conversation_id,turn_id,role,content,created_at) VALUES(?,?,NULL,'user','今天的一条消息',?)",
    )
    .run(randomUUID(), ids.today, new Date().toISOString());
  const organize = (id: string, action: "pin" | "archive") => {
    const c = store.snapshot().conversations.find((x) => x.id === id)!;
    store.execute(
      {
        type: "organizeConversation",
        id,
        action,
        revision: c.organizationRevision,
        confirmed: false,
      },
      "main",
    );
  };
  organize(ids.pinned, "pin");
  organize(ids.archived, "archive");
  store.execute({ type: "select", id: ids.today }, "main");
  store.close();
  return { root, ids };
}
async function launch(root: string, env: Record<string, string> = {}) {
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (e): e is [string, string] => e[1] !== undefined,
        ),
      ),
      ...env,
    },
  });
  const page = await app.firstWindow();
  await expect(
    page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
  return { app, page };
}
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    return r.snapshot;
  });
}
const sidebar = (page: Page) => page.locator("#main-sidebar");
const pinnedList = (page: Page) =>
  sidebar(page).locator('[aria-label="已置顶对象"]');
const recentList = (page: Page) =>
  sidebar(page).locator('[aria-label="最近对话"]');
const rowLabel = (id: string) => `对话 ${id.slice(0, 8)}`;
const menuLabel = (id: string) => `对话菜单 ${id.slice(0, 8)}`;
/** The recent list as [group, row labels] in page order. */
async function groups(page: Page) {
  return recentList(page).evaluate((list) =>
    Array.from(list.querySelectorAll('[role="group"]')).map((group) => [
      group.getAttribute("aria-label"),
      Array.from(group.querySelectorAll(".session")).map((row) =>
        row.getAttribute("aria-label"),
      ),
    ]),
  );
}
async function rows(list: ReturnType<typeof pinnedList>) {
  return list
    .locator(".session")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));
}
async function menuAction(page: Page, id: string, item: RegExp | string) {
  await sidebar(page).getByLabel(menuLabel(id), { exact: true }).click();
  await page
    .getByRole("menu", { name: "对话菜单" })
    .getByRole("menuitem", {
      name: item,
      exact: typeof item === "string" ? false : undefined,
    })
    .first()
    .click();
}
/** Whether the element that holds focus shows a keyboard focus ring. */
const ringOn = (page: Page) =>
  page.evaluate(() => document.activeElement?.matches(":focus-visible"));

test("existing data root: a schema 26 data root opens with every conversation, pin, unread and archive state as before, old rows in the date-not-available group", async () => {
  const { root, ids } = seed();
  // Take the seeded data back to schema 26: no creation times, no pinned order.
  const db = new DatabaseSync(join(root, "state.sqlite"));
  const unread = ids.earlier;
  db.prepare("UPDATE conversations SET unread=1 WHERE id=?").run(unread);
  const before = db
    .prepare(
      "SELECT id, title, pinned_at, unread, archived_at FROM conversations ORDER BY id",
    )
    .all();
  const indexesBefore = db
    .prepare(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
    )
    .all();
  restorePreWidgetGenerationFixture(db);
  db.exec(`DROP TRIGGER conversation_created_at;
    ALTER TABLE conversations DROP COLUMN created_at;
    DROP TABLE pinned_order;
    PRAGMA user_version=26;`);
  db.close();
  const { app, page } = await launch(root);
  try {
    const after = await snapshot(page);
    const migrated = new DatabaseSync(join(root, "state.sqlite"), {
      readOnly: true,
    });
    try {
      expect(migrated.prepare("PRAGMA user_version").get()!.user_version).toBe(
        30,
      );
      expect(
        migrated
          .prepare(
            "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
          )
          .all(),
      ).toEqual(indexesBefore);
    } finally {
      migrated.close();
    }
    for (const row of before as {
      id: string;
      title: string;
      pinned_at: string | null;
      unread: number;
      archived_at: string | null;
    }[]) {
      const c = after.conversations.find((x) => x.id === row.id)!;
      expect(c.title).toBe(row.title);
      expect(c.pinnedAt).toBe(row.pinned_at);
      expect(c.unread).toBe(row.unread === 1);
      expect(c.archivedAt).toBe(row.archived_at);
      expect(c.createdAt).toBeNull();
    }
    // The sidebar shows the same states: the pinned row, the unread mark, the archived count.
    expect(await rows(pinnedList(page))).toEqual([rowLabel(ids.pinned)]);
    await expect(
      recentList(page)
        .getByRole("button", { name: rowLabel(unread) })
        .locator(".unread-dot"),
    ).toHaveCount(1);
    await expect(
      sidebar(page).getByRole("button", { name: "已归档 1", exact: true }),
    ).toBeVisible();
    // Every old row is in the date-not-available group, newest creation first; nothing shows an invented date.
    expect(await groups(page)).toEqual([
      [
        "日期未提供",
        [ids.today, ids.yesterday, ids.earlier, ids.legacy].map(rowLabel),
      ],
    ]);
    // A conversation started now is in today's group.
    await sidebar(page)
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    const draft = page.getByRole("textbox", { name: "输入草稿" });
    await draft.fill("迁移后的新对话");
    await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
    await expect.poll(async () => (await groups(page))[0]?.[0]).toBe("今天");
    // Search still finds the old conversations by title.
    await page.keyboard.press("Meta+k");
    const search = page.getByRole("dialog", { name: "搜索对话" });
    await search.getByRole("combobox").fill("八天前");
    await expect(search.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Escape");
  } finally {
    await closeLocal(app);
  }
});

test("groups and pinned: the recent list groups by creation date, pinned conversations appear once, and pin, unpin, archive, delete, restore and unarchive keep both lists right", async () => {
  const { root, ids } = seed();
  const { app, page } = await launch(root);
  try {
    expect(await rows(pinnedList(page))).toEqual([rowLabel(ids.pinned)]);
    expect(await groups(page)).toEqual([
      ["今天", [rowLabel(ids.today)]],
      ["昨天", [rowLabel(ids.yesterday)]],
      ["更早", [rowLabel(ids.earlier)]],
      ["日期未提供", [rowLabel(ids.legacy)]],
    ]);
    // Rows without a creation date show no invented date group; their time is the last activity.
    await expect(
      sidebar(page).getByRole("group", { name: "日期未提供" }),
    ).toBeVisible();
    // Pinning moves the row to the pinned section (newest pin first) and focus follows it.
    await sidebar(page).getByLabel(menuLabel(ids.yesterday)).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: /^置顶/ }).focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => rows(pinnedList(page)))
      .toEqual([rowLabel(ids.yesterday), rowLabel(ids.pinned)]);
    await expect(
      pinnedList(page).getByLabel(menuLabel(ids.yesterday)),
    ).toBeFocused();
    expect(await ringOn(page)).toBe(true);
    expect(
      (await groups(page)).flatMap(([, labels]) => labels as string[]),
    ).not.toContain(rowLabel(ids.yesterday));
    // Unpinning returns it to its creation-date group.
    await menuAction(page, ids.yesterday, /^取消置顶/);
    await expect
      .poll(() => rows(pinnedList(page)))
      .toEqual([rowLabel(ids.pinned)]);
    expect(await groups(page)).toContainEqual([
      "昨天",
      [rowLabel(ids.yesterday)],
    ]);
    // Archiving a pinned conversation takes it out of both lists; unarchiving does not pin it again.
    await menuAction(page, ids.pinned, /^归档/);
    await expect(pinnedList(page)).toHaveCount(0);
    await expect(
      sidebar(page).getByRole("heading", { name: "已置顶" }),
    ).toHaveCount(0);
    await sidebar(page).getByRole("button", { name: "已归档 2" }).click();
    await page
      .getByRole("list", { name: "已归档对话" })
      .locator(`[data-conversation="${ids.pinned}"]`)
      .locator("xpath=..")
      .getByRole("button", { name: "取消归档" })
      .click();
    await expect
      .poll(async () =>
        (await groups(page)).flatMap(([, labels]) => labels as string[]),
      )
      .toContain(rowLabel(ids.pinned));
    await expect(pinnedList(page)).toHaveCount(0);
    // Deleting a pinned conversation takes it out; restoring from the undo does not pin it again.
    await menuAction(page, ids.today, /^置顶/);
    await expect
      .poll(() => rows(pinnedList(page)))
      .toEqual([rowLabel(ids.today)]);
    await menuAction(page, ids.today, "删除对话");
    await page
      .getByRole("dialog", { name: "删除对话", exact: true })
      .getByRole("button", { name: "确认删除" })
      .click();
    await expect(pinnedList(page)).toHaveCount(0);
    await page.getByRole("button", { name: "撤销删除" }).click();
    await expect
      .poll(async () =>
        (await groups(page)).flatMap(([, labels]) => labels as string[]),
      )
      .toContain(rowLabel(ids.today));
    await expect(pinnedList(page)).toHaveCount(0);
    // Renaming and a new draft do not move a row.
    const order = await groups(page);
    await page.evaluate(
      async ({ id }) => {
        const r = await window.desktop.command({
          type: "renameConversation",
          id,
          title: "改名后的旧对话",
          revision: 1,
        });
        if (!r.ok) throw new Error(r.message);
      },
      { id: ids.legacy },
    );
    await expect(
      recentList(page).getByRole("button", { name: rowLabel(ids.legacy) }),
    ).toContainText("改名后的旧对话");
    expect(await groups(page)).toEqual(order);
    // The in-list filter narrows only the recent list; the pinned section stays whole.
    await menuAction(page, ids.earlier, /^置顶/);
    await sidebar(page).getByRole("button", { name: "搜索最近聊天" }).click();
    await sidebar(page)
      .getByRole("textbox", { name: "搜索最近聊天" })
      .fill("昨天");
    expect(await groups(page)).toEqual([["昨天", [rowLabel(ids.yesterday)]]]);
    expect(await rows(pinnedList(page))).toEqual([rowLabel(ids.earlier)]);
    // Starting new conversations never adds unused rows: 新建聊天 and 主页 reuse the one unused conversation.
    await sidebar(page).getByRole("textbox", { name: "搜索最近聊天" }).fill("");
    const listedBefore = await sidebar(page).locator(".session").count();
    await sidebar(page)
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "全局导航" })
      .getByRole("button", { name: /^主页/ })
      .click();
    await sidebar(page)
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await snapshot(page)).conversations.filter((c) => c.unused).length,
      )
      .toBe(1);
    await expect(sidebar(page).locator(".session")).toHaveCount(listedBefore);
    await expect(
      page
        .getByRole("navigation", { name: "全局导航" })
        .getByRole("button", { name: /^主页/ }),
    ).toHaveAttribute("aria-current", "page");
    // A draft makes it used: it appears at the top of today's group.
    await page.getByRole("textbox", { name: "输入草稿" }).fill("一个新想法");
    await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
    const fresh = (await snapshot(page)).selected.main!;
    await expect
      .poll(async () => (await groups(page))[0])
      .toEqual([
        "今天",
        [rowLabel(fresh), rowLabel(ids.pinned), rowLabel(ids.today)],
      ]);
  } finally {
    await closeLocal(app);
  }
});

test("sections and sort: the three section headers fold, the pinned sort menu orders by pin, update or hand, and moving rows changes only the display order", async () => {
  const { root, ids } = seed();
  const { app, page } = await launch(root);
  try {
    // Two more pinned conversations: pin order is pinned, then today, then yesterday.
    await menuAction(page, ids.today, /^置顶/);
    await expect.poll(() => rows(pinnedList(page))).toHaveLength(2);
    await menuAction(page, ids.yesterday, /^置顶/);
    await expect.poll(() => rows(pinnedList(page))).toHaveLength(3);
    const pinTimes = async () =>
      Object.fromEntries(
        (await snapshot(page)).conversations.map((c) => [c.id, c.pinnedAt]),
      );
    const pinnedAt = await pinTimes();
    expect(await rows(pinnedList(page))).toEqual(
      [ids.yesterday, ids.today, ids.pinned].map(rowLabel),
    );
    // Folding: the header toggle keeps focus and leaves only the header row.
    for (const [title, body] of [
      ["已置顶", "#side-pinned-body"],
      ["项目", "#side-projects-body"],
      ["最近聊天", "#side-recent-body"],
    ] as const) {
      const toggle = sidebar(page).getByRole("button", {
        name: title,
        exact: true,
      });
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toHaveAttribute("aria-controls", body.slice(1));
      await toggle.focus();
      await page.keyboard.press(title === "项目" ? "Space" : "Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator(body)).toBeHidden();
      await expect(toggle).toBeFocused();
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(body)).toBeVisible();
    }
    // A folded recent section opens when its filter button is used.
    const recentToggle = sidebar(page).getByRole("button", {
      name: "最近聊天",
      exact: true,
    });
    await recentToggle.click();
    await sidebar(page).getByRole("button", { name: "搜索最近聊天" }).click();
    await expect(recentToggle).toHaveAttribute("aria-expanded", "true");
    await expect(
      sidebar(page).getByRole("textbox", { name: "搜索最近聊天" }),
    ).toBeVisible();
    await sidebar(page).getByRole("button", { name: "搜索最近聊天" }).click();
    // The sort button shows on hover or focus only.
    const sort = sidebar(page).getByRole("button", {
      name: "已置顶的排序方式",
    });
    await expect(sort).toHaveCSS("opacity", "0");
    await sort.focus();
    await expect(sort).toHaveCSS("opacity", "1");
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "已置顶的排序方式" });
    await expect(menu.getByRole("menuitemradio")).toHaveText([
      "最近置顶",
      "最近更新",
      "手动排序",
    ]);
    await expect(
      menu.getByRole("menuitemradio", { name: "最近置顶" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      menu.getByRole("menuitemradio", { name: "最近置顶" }),
    ).toBeFocused();
    // The check is on the left of the name.
    const check = await menu
      .getByRole("menuitemradio", { name: "最近置顶" })
      .evaluate((item) => {
        const mark = item
          .querySelector(".menu-check svg")!
          .getBoundingClientRect();
        const name = item.querySelector(".menu-label")!.getBoundingClientRect();
        return mark.right <= name.left;
      });
    expect(check).toBe(true);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(sort).toBeFocused();
    // Last update: the conversation with the newest activity comes first (drafts saved yesterday's first).
    for (const id of [ids.yesterday, ids.pinned])
      await page.evaluate(
        async ({ id }) => {
          const c = (await window.desktop.command({ type: "snapshot" })) as {
            ok: true;
            snapshot: Snapshot;
          };
          const row = c.snapshot.conversations.find((x) => x.id === id)!;
          await new Promise((done) => setTimeout(done, 20));
          await window.desktop.command({
            type: "saveDraft",
            id,
            text: "更新一下",
            revision: row.revision,
          });
        },
        { id },
      );
    await sort.click();
    await page.getByRole("menuitemradio", { name: "最近更新" }).click();
    await expect(menu).toHaveCount(0);
    await expect
      .poll(() => rows(pinnedList(page)))
      .toEqual([ids.pinned, ids.yesterday, ids.today].map(rowLabel));
    // Manual order: the row menu gets 上移 and 下移, disabled at the ends; focus follows the moved row.
    await sort.click();
    await page.getByRole("menuitemradio", { name: "手动排序" }).click();
    await expect
      .poll(() => rows(pinnedList(page)))
      .toEqual([ids.yesterday, ids.today, ids.pinned].map(rowLabel));
    await pinnedList(page).getByLabel(menuLabel(ids.yesterday)).click();
    const rowMenu = page.getByRole("menu", { name: "对话菜单" });
    await expect(
      rowMenu.getByRole("menuitem", { name: "上移" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await pinnedList(page).getByLabel(menuLabel(ids.pinned)).click();
    await expect(
      rowMenu.getByRole("menuitem", { name: "下移" }),
    ).toBeDisabled();
    await rowMenu.getByRole("menuitem", { name: "上移" }).click();
    await expect
      .poll(() => rows(pinnedList(page)))
      .toEqual([ids.yesterday, ids.pinned, ids.today].map(rowLabel));
    await expect(
      pinnedList(page).getByLabel(menuLabel(ids.pinned)),
    ).toBeFocused();
    await pinnedList(page).getByLabel(menuLabel(ids.yesterday)).focus();
    await page.keyboard.press("Enter");
    await rowMenu.getByRole("menuitem", { name: "下移" }).focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => rows(pinnedList(page)))
      .toEqual([ids.pinned, ids.yesterday, ids.today].map(rowLabel));
    await expect(
      pinnedList(page).getByLabel(menuLabel(ids.yesterday)),
    ).toBeFocused();
    expect(await ringOn(page)).toBe(true);
    // Dragging a row onto the top half of another puts it before that row.
    const source = pinnedList(page).locator(
      `[data-conversation="${ids.today}"]`,
    );
    const target = pinnedList(page).locator(
      `[data-conversation="${ids.pinned}"]`,
    );
    const box = (await target.boundingBox())!;
    await source.dragTo(target, {
      targetPosition: { x: box.width / 2, y: 3 },
    });
    await expect
      .poll(() => rows(pinnedList(page)))
      .toEqual([ids.today, ids.pinned, ids.yesterday].map(rowLabel));
    // Only the display order changed: every pin time is what it was.
    expect(await pinTimes()).toEqual(pinnedAt);
    // Back to pin time: the pin order again.
    await sort.click();
    await page.getByRole("menuitemradio", { name: "最近置顶" }).click();
    await expect
      .poll(() => rows(pinnedList(page)))
      .toEqual([ids.yesterday, ids.today, ids.pinned].map(rowLabel));
    // Colours come from the semantic tokens.
    const colours = await page.evaluate(() => {
      const scratch = document.createElement("span");
      document.body.append(scratch);
      const token = (name: string) => {
        scratch.style.color = `var(${name})`;
        return getComputedStyle(scratch).color;
      };
      const muted = token("--c-muted");
      scratch.remove();
      const title = document.querySelector(
        "#side-pinned-title .section-title",
      )!;
      const chevron = document.querySelector(
        "#side-pinned-title .section-chevron",
      )!;
      return {
        muted,
        title: getComputedStyle(title).color,
        chevron: getComputedStyle(chevron).color,
      };
    });
    expect(colours.title).toBe(colours.muted);
    expect(colours.chevron).toBe(colours.muted);
  } finally {
    await closeLocal(app);
  }
});

test("restart and failed saves: folds, the pinned sort and the manual order stay after a restart, and a save the service does not confirm stays for this window with a notice", async () => {
  const { root, ids } = seed();
  let { app, page } = await launch(root);
  try {
    await menuAction(page, ids.today, /^置顶/);
    await expect.poll(() => rows(pinnedList(page))).toHaveLength(2);
    await sidebar(page)
      .getByRole("button", { name: "已置顶的排序方式" })
      .click();
    await page.getByRole("menuitemradio", { name: "手动排序" }).click();
    await pinnedList(page).getByLabel(menuLabel(ids.pinned)).click();
    await page.getByRole("menuitem", { name: "上移" }).click();
    await expect
      .poll(() => rows(pinnedList(page)))
      .toEqual([ids.pinned, ids.today].map(rowLabel));
    await sidebar(page)
      .getByRole("button", { name: "项目", exact: true })
      .click();
    await sidebar(page)
      .getByRole("button", { name: "最近聊天", exact: true })
      .click();
    await expect
      .poll(async () => (await snapshot(page)).settings.interface)
      .toMatchObject({
        pinnedSort: "manual",
        projectsFolded: true,
        recentFolded: true,
        pinnedFolded: false,
      });
  } finally {
    await closeLocal(app);
  }
  // Restart with the business service late: the first frame already has the folded sections.
  ({ app, page } = await launch(root, {
    CSTHINK_TEST_SERVICE_DELAY_MS: "900",
  }).catch(async () => {
    throw new Error("restart failed");
  }));
  try {
    await expect(
      sidebar(page).getByRole("button", { name: "项目", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(
      sidebar(page).getByRole("button", { name: "最近聊天", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(await rows(pinnedList(page))).toEqual(
      [ids.pinned, ids.today].map(rowLabel),
    );
    // Without the business service a fold stays for this window with a notice; the saved value does not change.
    const pid = await app.evaluate(({ app }) => {
      const service = app
        .getAppMetrics()
        .find((metric) => metric.name === "csthink-assistant business");
      return service!.pid;
    });
    await app.evaluate((_electron, id) => process.kill(id, "SIGKILL"), pid);
    await expect(
      page.getByText("业务服务已失联。", { exact: false }),
    ).toBeVisible();
    const pinnedToggle = sidebar(page).getByRole("button", {
      name: "已置顶",
      exact: true,
    });
    await pinnedToggle.click();
    await expect(pinnedToggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".notice")).toContainText("界面偏好未保存");
    await page.getByRole("button", { name: "重新连接" }).click();
    await expect(page.locator(".service-error")).toHaveCount(0);
    await expect(pinnedToggle).toHaveAttribute("aria-expanded", "false");
    expect((await snapshot(page)).settings.interface.pinnedFolded).toBe(false);
    // A move the service refuses (a stale revision) keeps the order and says why.
    await pinnedToggle.click();
    await page.evaluate(
      async ({ id }) => {
        const s = (await window.desktop.command({ type: "snapshot" })) as {
          ok: true;
          snapshot: Snapshot;
        };
        const c = s.snapshot.conversations.find((x) => x.id === id)!;
        await window.desktop.command({
          type: "organizeConversation",
          id,
          action: "read",
          revision: c.organizationRevision,
          confirmed: false,
        });
      },
      { id: ids.today },
    );
    const refused = await page.evaluate(
      async ({ id, before }) => {
        const r = await window.desktop.command({
          type: "movePinned",
          kind: "conversation",
          id,
          before: { kind: "conversation", id: before },
          revision: 0,
        });
        return r.ok ? null : r.message;
      },
      { id: ids.today, before: ids.pinned },
    );
    expect(refused).toContain("顺序未改变");
    expect(await rows(pinnedList(page))).toEqual(
      [ids.pinned, ids.today].map(rowLabel),
    );
  } finally {
    await closeLocal(app);
  }
  // After a restart the value saved last is back.
  ({ app, page } = await launch(root));
  try {
    await expect(
      sidebar(page).getByRole("button", { name: "已置顶", exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
  } finally {
    await closeLocal(app);
  }
});

test("inline rename: the sidebar row and the centre title rename in place; Enter saves, Escape, leaving and an empty name keep the name, a composition's Enter does not save, and focus returns to the entry", async () => {
  const { root, ids } = seed();
  const { app, page } = await launch(root);
  try {
    const field = (scope: ReturnType<typeof sidebar>) =>
      scope.getByRole("textbox", { name: /^重命名对话/ });
    const title = page.getByRole("button", { name: "修改对话名称" });
    const centre = page.locator(".center-header");
    // From the sidebar row menu, by pointer: the row becomes a field; Enter saves everywhere.
    await menuAction(page, ids.yesterday, "重命名");
    await expect(page.getByRole("dialog", { name: "重命名对话" })).toHaveCount(
      0,
    );
    const rowField = field(sidebar(page));
    await expect(rowField).toBeFocused();
    await expect(rowField).toHaveValue("昨天的对话");
    await rowField.fill("侧栏改的名字");
    await rowField.press("Enter");
    await expect(rowField).toHaveCount(0);
    await expect(
      recentList(page).getByRole("button", { name: rowLabel(ids.yesterday) }),
    ).toContainText("侧栏改的名字");
    await expect(
      sidebar(page).getByLabel(menuLabel(ids.yesterday)),
    ).toBeFocused();
    expect(await ringOn(page)).toBe(false);
    // By keyboard: the ring comes back with focus.
    await sidebar(page).getByLabel(menuLabel(ids.yesterday)).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: /^重命名/ }).focus();
    await page.keyboard.press("Enter");
    await expect(rowField).toBeFocused();
    await rowField.fill("不会保存");
    await page.keyboard.press("Escape");
    await expect(rowField).toHaveCount(0);
    await expect(
      recentList(page).getByRole("button", { name: rowLabel(ids.yesterday) }),
    ).toContainText("侧栏改的名字");
    await expect(
      sidebar(page).getByLabel(menuLabel(ids.yesterday)),
    ).toBeFocused();
    expect(await ringOn(page)).toBe(true);
    // A pinned row renames in place in the pinned section.
    await pinnedList(page).getByLabel(menuLabel(ids.pinned)).click();
    await page.getByRole("menuitem", { name: /^重命名/ }).click();
    await expect(field(pinnedList(page))).toBeFocused();
    await field(pinnedList(page)).press("Escape");
    // The centre title, by pointer: an empty name keeps the saved one without a command.
    const revision = async () =>
      (await snapshot(page)).conversations.find((c) => c.id === ids.today)!
        .titleRevision;
    const start = await revision();
    await title.click();
    await expect(field(centre)).toBeFocused();
    // The centre field is 360 points wide (narrower only when the title row has no room), not the width of the
    // shortest title.
    expect((await field(centre).boundingBox())!.width).toBeGreaterThanOrEqual(
      359,
    );
    await field(centre).fill("   ");
    await field(centre).press("Enter");
    await expect(field(centre)).toHaveCount(0);
    await expect(title).toHaveText("今天的对话");
    expect(await revision()).toBe(start);
    await expect(title).toBeFocused();
    expect(await ringOn(page)).toBe(false);
    // Leaving the field cancels.
    await title.click();
    await field(centre).fill("离开时不保存");
    await sidebar(page)
      .getByRole("button", { name: "搜索", exact: true })
      .focus();
    await expect(field(centre)).toHaveCount(0);
    await expect(title).toHaveText("今天的对话");
    // A composition's Enter commits the composition and neither saves nor closes.
    await title.click();
    const cdp = await page.context().newCDPSession(page);
    await field(centre).fill("");
    await cdp.send("Input.imeSetComposition", {
      text: "zhong",
      selectionStart: 5,
      selectionEnd: 5,
    });
    await page.keyboard.press("Enter");
    await expect(field(centre)).toBeVisible();
    expect(await revision()).toBe(start);
    await cdp.send("Input.insertText", { text: "中文名字" });
    await page.keyboard.press("Enter");
    await expect(field(centre)).toHaveCount(0);
    await expect(title).toHaveText("中文名字");
    // A name that is too long or a save the service refuses keeps the field, the typed text and the saved name.
    await title.click();
    await field(centre).fill("长".repeat(81));
    await field(centre).press("Enter");
    await expect(centre.getByRole("alert")).toContainText("80 个字符");
    await expect(field(centre)).toHaveValue("长".repeat(81));
    await field(centre).fill("冲突时保留的输入");
    await page.evaluate(
      async ({ id, revision }) => {
        const r = await window.desktop.command({
          type: "renameConversation",
          id,
          title: "另一入口的名字",
          revision,
        });
        if (!r.ok) throw new Error(r.message);
      },
      { id: ids.today, revision: await revision() },
    );
    await field(centre).press("Enter");
    await expect(centre.getByRole("alert")).toContainText("另一入口的名字");
    await expect(field(centre)).toHaveValue("冲突时保留的输入");
    expect(
      (await snapshot(page)).conversations.find((c) => c.id === ids.today)!
        .title,
    ).toBe("另一入口的名字");
    await field(centre).press("Escape");
    // ⌥⌘R renames the current conversation's centre title and returns focus to where it was.
    const draft = page.getByRole("textbox", { name: "输入草稿" });
    await draft.focus();
    await page.keyboard.press("Meta+Alt+r");
    await expect(field(centre)).toBeFocused();
    await field(centre).fill("快捷键改的名字");
    await field(centre).press("Enter");
    await expect(title).toHaveText("快捷键改的名字");
    await expect(draft).toBeFocused();
    // The panel still renames in its dialog and shows the same name.
    const opened = app.waitForEvent("window");
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items[0].submenu!.items.find((i) => i.label === "打开工作台助手")!
        .click(),
    );
    const panel = await opened;
    await panel.getByRole("button", { name: "聊天", exact: true }).click();
    await panel.evaluate(async (id) => {
      await window.desktop.command({ type: "select", id });
    }, ids.today);
    await expect(
      panel.getByRole("button", { name: "修改对话名称" }),
    ).toHaveText("快捷键改的名字");
  } finally {
    await closeLocal(app);
  }
});

test("centre title and menu: the title row shows the title, its source, the same-name and archived marks and the menu, and the menu gives the same items and results from the row and the title", async () => {
  const { root, ids } = seed();
  const opened = new Store(root);
  const store = opened.db;
  // A conversation titled from its first message, and one with messages but the default name.
  const auto = randomUUID(),
    plain = randomUUID();
  const insert = store.prepare(
    "INSERT INTO conversations(id,title,updated_at,auto_title) VALUES(?,?,?,?)",
  );
  insert.run(
    auto,
    "取自消息的标题",
    new Date().toISOString(),
    "取自消息的标题",
  );
  insert.run(plain, "新对话", new Date().toISOString(), null);
  const message = store.prepare(
    "INSERT INTO messages(id,conversation_id,turn_id,role,content,created_at) VALUES(?,?,NULL,'user','内容',?)",
  );
  message.run(randomUUID(), auto, new Date().toISOString());
  message.run(randomUUID(), plain, new Date().toISOString());
  opened.close();
  const { app, page } = await launch(root);
  try {
    const source = page.locator(".center-header .title-source");
    await expect(source).toHaveText("用户命名");
    await recentList(page)
      .getByRole("button", { name: rowLabel(auto) })
      .click();
    await expect(source).toHaveText("取自首条消息");
    await recentList(page)
      .getByRole("button", { name: rowLabel(plain) })
      .click();
    await expect(source).toHaveText("默认名称");
    await expect(page.locator(".center")).not.toContainText("自动标题");
    // No connection status toolbar in the title row.
    await expect(page.locator(".center-header")).not.toContainText("本地数据");
    await expect(page.locator(".center-header .connection-status")).toHaveCount(
      0,
    );
    // Same names are marked in the title row too.
    await page.evaluate(
      async ({ id }) => {
        await window.desktop.command({
          type: "renameConversation",
          id,
          title: "今天的对话",
          revision: 0,
        });
      },
      { id: plain },
    );
    await expect(page.locator(".center-header .same-name")).toHaveText(
      "同名 2",
    );
    // The same menu from the row and from the title: items, keys and availability.
    const describe = () =>
      page
        .getByRole("menu", { name: "对话菜单" })
        .getByRole("menuitem")
        .evaluateAll((items) =>
          items.map((i) => [
            i.textContent?.trim(),
            (i as HTMLButtonElement).disabled,
          ]),
        );
    await recentList(page)
      .getByRole("button", { name: rowLabel(ids.today) })
      .click();
    await page.getByRole("button", { name: "当前对话菜单" }).click();
    const fromTitle = await describe();
    await page.keyboard.press("Escape");
    await sidebar(page).getByLabel(menuLabel(ids.today)).click();
    const fromRow = await describe();
    await page.keyboard.press("Escape");
    expect(fromTitle).toEqual(fromRow);
    // The same results: pin from the title, unread from the row, archive from the title.
    const state = async () => {
      const c = (await snapshot(page)).conversations.find(
        (x) => x.id === ids.today,
      )!;
      return {
        pinned: !!c.pinnedAt,
        unread: c.unread,
        archived: !!c.archivedAt,
      };
    };
    await page.getByRole("button", { name: "当前对话菜单" }).click();
    await page.getByRole("menuitem", { name: /^置顶/ }).click();
    await expect
      .poll(state)
      .toEqual({ pinned: true, unread: false, archived: false });
    await expect(
      page.getByRole("button", { name: "当前对话菜单" }),
    ).toBeFocused();
    await pinnedList(page).getByLabel(menuLabel(ids.today)).click();
    await page.getByRole("menuitem", { name: /^取消置顶/ }).click();
    await expect
      .poll(state)
      .toEqual({ pinned: false, unread: false, archived: false });
    // The menu acts on the conversation it was opened for, without switching the current one.
    await sidebar(page).getByLabel(menuLabel(ids.yesterday)).click();
    await page.getByRole("menuitem", { name: /^标记为未读/ }).click();
    expect((await snapshot(page)).selected.main).toBe(ids.today);
    expect(
      (await snapshot(page)).conversations.find((c) => c.id === ids.yesterday)!
        .unread,
    ).toBe(true);
    await page.getByRole("button", { name: "当前对话菜单" }).click();
    await page.getByRole("menuitem", { name: /^归档/ }).click();
    await expect
      .poll(state)
      .toEqual({ pinned: false, unread: false, archived: true });
    await expect(page.locator(".center-header .archived-tag")).toHaveText(
      "已归档",
    );
  } finally {
    await closeLocal(app);
  }
});

test("archived page: the archived entry opens a centre page that opens and unarchives conversations like the menu does, and an archived conversation says so", async () => {
  const { root, ids } = seed();
  const { app, page } = await launch(root);
  try {
    await menuAction(page, ids.yesterday, /^归档/);
    const entry = sidebar(page).getByRole("button", { name: "已归档 2" });
    await entry.click();
    await expect(entry).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("dialog", { name: "已归档对话" })).toHaveCount(
      0,
    );
    await expect(
      page.locator(".center-header").getByRole("heading", { name: "已归档" }),
    ).toBeVisible();
    await expect(page.locator(".center-header .panel-toggle")).toHaveCount(0);
    const list = page.getByRole("list", { name: "已归档对话" });
    // Newest creation first, with the owner, last activity and archive time.
    await expect(list.locator(".archived-open")).toHaveCount(2);
    expect(
      await list
        .locator(".archived-open")
        .evaluateAll((rows) =>
          rows.map((r) => r.getAttribute("data-conversation")),
        ),
    ).toEqual([ids.archived, ids.yesterday]);
    await expect(list.locator(".archived-open").first()).toContainText(
      "未归属项目 · 最后活动",
    );
    await expect(list.locator(".archived-open").first()).toContainText(
      "归档于",
    );
    // Opening does not unarchive; the conversation says it is archived.
    await list.locator(`[data-conversation="${ids.archived}"]`).click();
    await expect(page.locator(".archived-banner")).toContainText(
      "这段对话已归档。发送新消息后会自动取消归档。",
    );
    expect(
      (await snapshot(page)).conversations.find((c) => c.id === ids.archived)!
        .archivedAt,
    ).not.toBeNull();
    // The banner's 取消归档 and the page's 取消归档 run the same command as the menu.
    await page
      .locator(".archived-banner")
      .getByRole("button", { name: "取消归档" })
      .click();
    await expect(page.locator(".archived-banner")).toHaveCount(0);
    await expect(
      recentList(page).getByRole("button", { name: rowLabel(ids.archived) }),
    ).toBeVisible();
    await entry
      .or(sidebar(page).getByRole("button", { name: "已归档 1" }))
      .click();
    await list
      .locator(`[data-conversation="${ids.yesterday}"]`)
      .locator("xpath=..")
      .getByRole("button", { name: "取消归档" })
      .focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "没有已归档的对话" }),
    ).toBeVisible();
    await expect(page.locator(".archived-empty")).toBeFocused();
    const unarchived = (await snapshot(page)).conversations.find(
      (c) => c.id === ids.yesterday,
    )!;
    expect(unarchived.archivedAt).toBeNull();
    expect(unarchived.pinnedAt).toBeNull();
    await expect(
      recentList(page).getByRole("button", { name: rowLabel(ids.yesterday) }),
    ).toBeVisible();
  } finally {
    await closeLocal(app);
  }
});

test("right column files and events: the files tab lists the submitted versions with their send scope, draft attachments are only counted, the events tab lists the turns read only", async () => {
  const { root, ids } = seed();
  // A submitted message carrying one saved copy and a finished turn; a draft attachment not yet sent.
  const copy = "已提交的资料内容";
  const sha = createHash("sha256").update(copy).digest("hex");
  mkdirSync(join(root, "attachments"), { recursive: true });
  writeFileSync(join(root, "attachments", sha), copy);
  const opened = new Store(root);
  const db = opened.db;
  const at = new Date().toISOString();
  const [attachment, draftAttachment, turn, message] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const insertAttachment = db.prepare(
    "INSERT INTO attachments(id,sha256,name,kind,size,status,reason,chars,pages,width,height,created_at) VALUES(?,?,?,?,?,'ready',NULL,?,NULL,NULL,NULL,?)",
  );
  insertAttachment.run(attachment, sha, "资料.md", "markdown", 24, 8, at);
  insertAttachment.run(
    draftAttachment,
    sha,
    "未提交.md",
    "markdown",
    24,
    8,
    at,
  );
  db.prepare(
    "INSERT INTO attachment_texts(attachment_id,text) VALUES(?,?)",
  ).run(attachment, copy);
  const connection = {
    connectionId: randomUUID(),
    name: "测试连接",
    provider: "zhipu",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "glm-test",
    revision: 0,
    effort: "high",
  };
  db.prepare(
    "INSERT INTO turns (id,conversation_id,request_id,connection_snapshot,state,created_at,ended_at) VALUES (?,?,?,?,'completed',?,?)",
  ).run(turn, ids.today, randomUUID(), JSON.stringify(connection), at, at);
  db.prepare(
    "INSERT INTO executions (id,turn_id,kind,connection_id,state,created_at,ended_at) VALUES (?,?,'turn',?,'completed',?,?)",
  ).run(randomUUID(), turn, connection.connectionId, at, at);
  db.prepare(
    "INSERT INTO messages(id,conversation_id,turn_id,role,content,created_at) VALUES(?,?,?,'user','带资料的消息',?)",
  ).run(message, ids.today, turn, at);
  db.prepare(
    "INSERT INTO message_attachments(message_id,attachment_id,position) VALUES(?,?,0)",
  ).run(message, attachment);
  db.prepare(
    "INSERT INTO draft_attachments(conversation_id,attachment_id,position) VALUES(?,?,0)",
  ).run(ids.today, draftAttachment);
  opened.close();
  const { app, page } = await launch(root);
  try {
    await page.getByRole("button", { name: "打开右栏" }).click();
    const panel = page.getByRole("complementary", { name: "右栏" });
    const files = panel.getByRole("list", { name: "已提交的资料" });
    await expect(files.locator("li")).toHaveCount(1);
    await expect(files).toContainText("资料.md");
    await expect(files).toContainText(`已提交版本 ${sha.slice(0, 12)}`);
    await expect(files).toContainText(
      "发送范围：本回合发送给 测试连接 · glm-test",
    );
    await expect(panel).not.toContainText("未提交.md");
    await expect(panel).toContainText("输入区另有 1 个已选择、尚未提交的资料");
    await expect(panel).not.toContainText("尚未提供");
    // The preview reads the saved copy.
    await files.getByRole("button", { name: "预览 资料.md" }).click();
    await expect(page.getByText(copy).first()).toBeVisible();
    // Events: the turn, read only.
    await panel.getByRole("tab", { name: "事件" }).click();
    const events = panel.getByRole("list", { name: "回合事件" });
    await expect(events.locator("li")).toHaveCount(1);
    await expect(events).toContainText("回合已完成");
    await expect(events).toContainText("测试连接 · glm-test · 推理 high");
    await expect(panel.getByRole("button", { name: /重试|停止/ })).toHaveCount(
      0,
    );
    // The new-conversation page: both tabs say there is nothing yet.
    await page
      .getByRole("navigation", { name: "全局导航" })
      .getByRole("button", { name: /^主页/ })
      .click();
    await sidebar(page)
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    await expect(panel).toContainText("新对话还没有回合事件。");
    await panel.getByRole("tab", { name: "文件" }).click();
    await expect(panel).toContainText("新对话还没有提交的资料。");
    // Without the business service the tabs say they cannot read, instead of showing old data.
    await recentList(page)
      .getByRole("button", { name: rowLabel(ids.today) })
      .click();
    await expect(files).toBeVisible();
    const pid = await app.evaluate(({ app }) => {
      const service = app
        .getAppMetrics()
        .find((metric) => metric.name === "csthink-assistant business");
      return service!.pid;
    });
    await app.evaluate((_electron, id) => process.kill(id, "SIGKILL"), pid);
    await expect(panel).toContainText("未连接，无法读取本对话的文件与事件。");
    await expect(files).toHaveCount(0);
  } finally {
    await closeLocal(app);
  }
});
