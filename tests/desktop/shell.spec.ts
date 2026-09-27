import {
  test,
  expect,
  type Page,
  type ElectronApplication,
} from "@playwright/test";
import { launchLocal } from "./local-client";
import { Store } from "../../src/service/store";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** Two saved conversations; optionally one failed turn whose pending item is still open. */
function seed(options: { pending?: boolean } = {}) {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/shell-ui-"));
  const store = new Store(root);
  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    store.execute({ type: "create", id }, "main");
    store.execute(
      {
        type: "renameConversation",
        id,
        title: index ? "第二个对话" : "第一个对话",
        revision: 0,
      },
      "main",
    );
  }
  if (options.pending) {
    const turnId = randomUUID(),
      executionId = randomUUID(),
      at = new Date().toISOString();
    const snapshot = {
      connectionId: randomUUID(),
      name: "测试连接",
      provider: "zhipu",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "glm-test",
      revision: 0,
      effort: null,
    };
    store.db
      .prepare(
        "INSERT INTO turns (id,conversation_id,request_id,connection_snapshot,state,created_at,ended_at) VALUES (?,?,?,?,'failed',?,?)",
      )
      .run(turnId, ids[0], randomUUID(), JSON.stringify(snapshot), at, at);
    store.db
      .prepare(
        "INSERT INTO executions (id,turn_id,kind,connection_id,state,created_at,ended_at) VALUES (?,?,'turn',?,'failed',?,?)",
      )
      .run(executionId, turnId, snapshot.connectionId, at, at);
    store.db
      .prepare(
        "INSERT INTO pending_items (id,execution_id,kind,state,created_at) VALUES (?,?,'failed_turn','open',?)",
      )
      .run(randomUUID(), executionId, at);
  }
  store.close();
  return { root, ids };
}
async function launch(root: string) {
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  await expect(
    page
      .locator(".home-header")
      .getByRole("button", { name: "新建对话", exact: true }),
  ).toBeEnabled();
  return { app, page };
}
const avatar = (page: Page) =>
  page.getByRole("button", { name: /^我，个人空间/ });
const profileMenu = (page: Page) => page.locator("section#profile-menu");
async function servicePID(app: ElectronApplication) {
  return app.evaluate(({ app }) => {
    const service = app
      .getAppMetrics()
      .find((metric) => metric.name === "csthink-assistant business");
    if (!service) throw new Error(JSON.stringify(app.getAppMetrics()));
    return service.pid;
  });
}

test("shell: the top navigation, avatar popover and settings entry replace the sidebar in both appearances", async ({}, info) => {
  const { root } = seed();
  const { app, page } = await launch(root);
  try {
    // The old sidebar, its brand row, the collapse toggle and the bottom-left entries are gone.
    await expect(page.locator(".sidebar")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /侧栏/ })).toHaveCount(0);
    await expect(page.locator(".local-profile")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(
      0,
    );
    // Only 聊天 and 工作台 sit in the primary navigation; the current page carries aria-current.
    const primary = page.getByRole("navigation", { name: "主要页面" });
    await expect(primary.getByRole("button")).toHaveText(["聊天", "工作台"]);
    await expect(primary.getByRole("button", { name: "聊天" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await primary.getByRole("button", { name: "工作台" }).click();
    await expect(
      primary.getByRole("button", { name: "工作台" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      primary.getByRole("button", { name: "聊天" }),
    ).not.toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { level: 1, name: "工作台" }),
    ).toBeVisible();
    // The avatar opens a non-modal popover below it with pending, records and settings.
    await expect(avatar(page)).toHaveAttribute("aria-haspopup", "menu");
    await expect(avatar(page)).toHaveAttribute("aria-expanded", "false");
    await expect(avatar(page).locator(".profile-pending-dot")).toHaveCount(0);
    await avatar(page).click();
    await expect(avatar(page)).toHaveAttribute("aria-expanded", "true");
    const menu = profileMenu(page);
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("aria-label", "个人空间");
    await expect(menu.locator(".profile-menu-heading")).toContainText(
      "个人空间",
    );
    await expect(menu.locator(".profile-menu-heading")).toContainText(
      "保存在这台 Mac 上",
    );
    await expect(menu.getByRole("menuitem")).toHaveText([
      /^待处理/,
      "记录",
      "设置",
    ]);
    await expect(menu.getByRole("menuitem", { name: /^待处理/ })).toContainText(
      "0",
    );
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    // Nothing covers the page: the primary navigation is still clickable while the popover is open.
    await expect(page.locator(".modal-backdrop, dialog[open]")).toHaveCount(0);
    const menuBox = (await menu.boundingBox())!;
    const avatarBox = (await avatar(page).boundingBox())!;
    expect(menuBox.y).toBeGreaterThan(avatarBox.y + avatarBox.height);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(
      avatarBox.x + avatarBox.width + 1,
    );
    // Escape closes and hands focus back to the avatar; a second Escape does nothing harmful.
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(avatar(page)).toBeFocused();
    await expect(avatar(page)).toHaveAttribute("aria-expanded", "false");
    // Keyboard: ArrowDown moves between items, End jumps to the last, Enter activates 设置 → 通用.
    await avatar(page).click();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "记录" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "设置" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(
      page.getByRole("heading", { level: 1, name: "设置" }),
    ).toBeVisible();
    const categories = page.getByRole("navigation", { name: "设置分类" });
    await expect(categories.getByRole("button")).toHaveText([
      "通用",
      "模型",
      "最近删除",
      "扩展管理",
      "访问权限",
      "数据保留",
      "数据与隐私",
    ]);
    await expect(
      categories.getByRole("button", { name: "通用" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("group", { name: "外观" })).toBeVisible();
    // The current page is marked inside the popover; an outside click closes it; an inside click does not.
    await avatar(page).click();
    await expect(menu.getByRole("menuitem", { name: "设置" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await menu.locator(".profile-menu-heading").click();
    await expect(menu).toBeVisible();
    await page.getByRole("heading", { level: 1, name: "设置" }).click();
    await expect(menu).toHaveCount(0);
    await avatar(page).click();
    await menu.getByRole("menuitem", { name: "记录" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "运行记录" }),
    ).toBeVisible();
    await expect(
      primary.getByRole("button", { name: "聊天" }),
    ).not.toHaveAttribute("aria-current", "page");
    await expect(
      primary.getByRole("button", { name: "工作台" }),
    ).not.toHaveAttribute("aria-current", "page");
    // The chat tool group (new, recent, search) is absent on 记录 and 待处理, present on 聊天, 工作台 and 设置.
    await expect(page.locator(".home-history-actions")).toHaveCount(0);
    await avatar(page).click();
    await menu.getByRole("menuitem", { name: /^待处理/ }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "待处理" }),
    ).toBeVisible();
    await expect(page.locator(".home-history-actions")).toHaveCount(0);
    await primary.getByRole("button", { name: "聊天" }).click();
    await expect(page.locator(".home-history-actions")).toBeVisible();
    // Dark appearance keeps the same shell and a visible focus ring on the avatar.
    await page.screenshot({ path: info.outputPath("shell-light.png") });
    await avatar(page).click();
    await menu.getByRole("menuitem", { name: "设置" }).click();
    await page
      .getByRole("group", { name: "外观" })
      .getByRole("button", { name: "深色" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    // Keyboard focus (Tab from the page switch) must show a ring; pointer focus alone does not count.
    await page
      .getByRole("navigation", { name: "主要页面" })
      .getByRole("button", { name: "工作台" })
      .focus();
    await page.keyboard.press("Tab");
    await expect(avatar(page)).toBeFocused();
    const ring = await avatar(page).evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        outline: style.outlineStyle,
        width: style.outlineWidth,
        box: style.boxShadow,
      };
    });
    expect(ring.outline !== "none" || ring.box !== "none").toBe(true);
    await avatar(page).click();
    await expect(menu).toBeVisible();
    await page.screenshot({ path: info.outputPath("shell-dark.png") });
    await page.keyboard.press("Escape");
    await page
      .getByRole("group", { name: "外观" })
      .getByRole("button", { name: "浅色" })
      .click();
  } finally {
    await app.close();
  }
});

test("shell: at the 900 × 680 minimum window the header stacks, nothing overlaps and both popovers stay inside the viewport", async ({}, info) => {
  const { root } = seed();
  const { app, page } = await launch(root);
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === "csthink-assistant",
      )!;
      window.setContentSize(900, 680);
    });
    await expect
      .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual([900, 680]);
    const box = async (locator: ReturnType<Page["locator"]>) =>
      (await locator.boundingBox())!;
    const tools = await box(page.locator(".home-history-actions"));
    const nav = await box(page.getByRole("navigation", { name: "主要页面" }));
    const account = await box(avatar(page));
    // Two rows: the tools and the avatar share the first, the page switch sits below them.
    expect(nav.y).toBeGreaterThanOrEqual(tools.y + tools.height);
    expect(tools.x + tools.width).toBeLessThan(account.x);
    expect(nav.x).toBeGreaterThanOrEqual(0);
    expect(nav.x + nav.width).toBeLessThanOrEqual(900);
    await avatar(page).click();
    const menu = await box(profileMenu(page));
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(900);
    expect(menu.y + menu.height).toBeLessThanOrEqual(680);
    await page.screenshot({
      path: info.outputPath("shell-900x680-profile.png"),
    });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "最近聊天", exact: true }).click();
    const history = await box(page.locator("section#home-history"));
    expect(history.x).toBeGreaterThanOrEqual(0);
    expect(history.x + history.width).toBeLessThanOrEqual(900);
    expect(history.y).toBeGreaterThanOrEqual(tools.y + tools.height);
    expect(history.y + history.height).toBeLessThanOrEqual(680);
    await page.screenshot({
      path: info.outputPath("shell-900x680-recent.png"),
    });
    // The chat page's composer is still reachable below the stacked header.
    const composer = await box(page.getByRole("textbox", { name: "输入草稿" }));
    expect(composer.y + composer.height).toBeLessThanOrEqual(680);
  } finally {
    await app.close();
  }
});

test("shell: recent chats open in an anchored popover that keeps the existing list and closes on selection", async ({}, info) => {
  const { root, ids } = seed();
  const { app, page } = await launch(root);
  try {
    const trigger = page.getByRole("button", { name: "最近聊天", exact: true });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByLabel("最近对话")).toHaveCount(0);
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const history = page.locator("section#home-history");
    await expect(history).toHaveAttribute("aria-label", "最近聊天");
    await expect(
      history.getByRole("heading", { level: 2, name: "最近聊天" }),
    ).toBeVisible();
    const triggerBox = (await trigger.boundingBox())!;
    const historyBox = (await history.boundingBox())!;
    expect(historyBox.y).toBeGreaterThan(triggerBox.y + triggerBox.height);
    // The popover holds the existing list: same rows, same menus, same archived entry; the page did not move.
    const recent = history.getByLabel("最近对话");
    await expect(recent.locator(".session")).toHaveCount(2);
    await expect(
      history.getByRole("button", { name: "已归档 0", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "输入草稿" })).toBeVisible();
    await recent
      .getByLabel(`对话菜单 ${ids[1].slice(0, 8)}`, { exact: true })
      .click();
    await expect(page.getByRole("menu", { name: "对话菜单" })).toBeVisible();
    await expect(history).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu", { name: "对话菜单" })).toHaveCount(0);
    await expect(history).toBeVisible();
    await page.screenshot({ path: info.outputPath("recent-chats.png") });
    // Selecting a conversation closes the popover and lands on 聊天 with that conversation.
    await page
      .getByRole("navigation", { name: "主要页面" })
      .getByRole("button", { name: "工作台" })
      .click();
    await expect(history).toHaveCount(0);
    await trigger.click();
    await recent
      .getByLabel(`对话 ${ids[1].slice(0, 8)}`, { exact: true })
      .click();
    await expect(history).toHaveCount(0);
    await expect(
      page
        .getByRole("navigation", { name: "主要页面" })
        .getByRole("button", { name: "聊天" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".home-chat-title")).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "输入草稿" }),
    ).toBeEditable();
    // Escape and outside click close it and return focus to the trigger; the avatar popover replaces it.
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(history).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole("textbox", { name: "输入草稿" }).click();
    await expect(history).toHaveCount(0);
    await trigger.click();
    await avatar(page).click();
    await expect(history).toHaveCount(0);
    await expect(profileMenu(page)).toBeVisible();
    await trigger.click();
    await expect(profileMenu(page)).toHaveCount(0);
    await expect(history).toBeVisible();
  } finally {
    await app.close();
  }
});

test("shell: the avatar dot and pending count follow open items and keep the last value when the service is lost", async () => {
  const { root } = seed({ pending: true });
  const { app, page } = await launch(root);
  try {
    await expect(avatar(page)).toHaveAttribute(
      "aria-label",
      "我，个人空间，1 项待处理",
    );
    await expect(avatar(page).locator(".profile-pending-dot")).toHaveCount(1);
    await avatar(page).click();
    const menu = profileMenu(page);
    await expect(
      menu
        .getByRole("menuitem", { name: /^待处理/ })
        .locator(".profile-menu-count"),
    ).toHaveText("1");
    await menu.getByRole("menuitem", { name: /^待处理/ }).click();
    await expect(
      page.getByRole("list", { name: "待处理事项" }).getByRole("listitem"),
    ).toHaveCount(1);
    // Losing the business service must not turn the count into a reassuring zero.
    const pid = await servicePID(app);
    await app.evaluate((_electron, id) => process.kill(id, "SIGKILL"), pid);
    await expect(
      page.getByText("业务服务已失联。", { exact: false }),
    ).toBeVisible();
    await expect(avatar(page)).toHaveAttribute(
      "aria-label",
      "我，个人空间，1 项待处理，未连接",
    );
    await expect(avatar(page).locator(".profile-pending-dot")).toHaveCount(1);
    await avatar(page).click();
    await expect(
      menu
        .getByRole("menuitem", { name: /^待处理/ })
        .locator(".profile-menu-count"),
    ).toHaveText("1");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "重新连接" }).click();
    await expect(avatar(page)).toHaveAttribute(
      "aria-label",
      "我，个人空间，1 项待处理",
    );
    await expect(
      page.getByRole("button", { name: "忽略", exact: true }),
    ).toBeEnabled();
    // Dismissing the item removes the dot and the count.
    await page.getByRole("button", { name: "忽略", exact: true }).click();
    await expect(avatar(page)).toHaveAttribute("aria-label", "我，个人空间");
    await expect(avatar(page).locator(".profile-pending-dot")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

/** Counts business:search invocations from the main process; the renderer cannot fake this. */
async function countSearches(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const internal = ipcMain as unknown as {
      _invokeHandlers: Map<string, (...args: unknown[]) => unknown>;
    };
    const original = internal._invokeHandlers.get("business:search")!;
    const counter = globalThis as unknown as { searchCalls: number };
    counter.searchCalls = 0;
    internal._invokeHandlers.set("business:search", (...args) => {
      counter.searchCalls++;
      return original(...args);
    });
  });
  return () =>
    app.evaluate(
      () => (globalThis as unknown as { searchCalls: number }).searchCalls,
    );
}

test("shell: the recent chats popover filters its own list by title only, keeps the archived entry and stays open while a row's confirm dialog is up", async ({}, info) => {
  const { root, ids } = seed();
  const { app, page } = await launch(root);
  try {
    // A message that would match a global search but not a title-only filter.
    await page.evaluate(async (id) => {
      await window.desktop.command({ type: "select", id });
    }, ids[0]);
    const searches = await countSearches(app);
    const trigger = page.getByRole("button", { name: "最近聊天", exact: true });
    await trigger.click();
    const history = page.locator("section#home-history");
    const toggle = history.getByRole("button", { name: "搜索最近聊天" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(history.locator("#history-query-row")).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const input = history.getByRole("textbox", { name: "搜索最近聊天" });
    await expect(input).toBeFocused();
    const rows = history.getByLabel("最近对话").locator(".session");
    await expect(rows).toHaveCount(2);
    await input.fill("第二");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("第二个对话");
    // The filter never becomes a global search: message text does not match, nothing is queried.
    await input.fill("已保存的消息");
    await expect(rows).toHaveCount(0);
    await expect(history.getByRole("status")).toHaveText("没有匹配的对话");
    await expect(
      history.getByRole("button", { name: "已归档 0", exact: true }),
    ).toBeVisible();
    expect(await searches()).toBe(0);
    await expect(page.getByRole("dialog", { name: "搜索对话" })).toHaveCount(0);
    // Composition: the list waits for the IME to commit before filtering.
    await input.fill("");
    await expect(rows).toHaveCount(2);
    await input.dispatchEvent("compositionstart", { data: "di" });
    await input.fill("第一");
    await expect(rows).toHaveCount(2);
    await input.dispatchEvent("compositionend", { data: "第一" });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("第一个对话");
    await page.screenshot({ path: info.outputPath("recent-filter.png") });
    // A row's delete confirmation opens over the popover and the popover survives it; cancelling keeps the row.
    await history
      .locator(".session-line")
      .first()
      .locator(".session-more")
      .click();
    await page.getByRole("menuitem", { name: "删除对话" }).click();
    const confirm = page.getByRole("dialog", { name: "删除对话", exact: true });
    await expect(confirm).toBeVisible();
    await expect(history).toBeVisible();
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(history).toBeVisible();
    await expect(rows).toHaveCount(1);
    // Closing the filter row clears the query and restores the full list.
    await toggle.click();
    await expect(history.locator("#history-query-row")).toBeHidden();
    await expect(rows).toHaveCount(2);
    // Opening the archived list from the popover keeps the archive behaviour; unarchive returns the row.
    await history
      .locator(".session-line")
      .first()
      .locator(".session-more")
      .click();
    await page.getByRole("menuitem", { name: /^归档/ }).click();
    await expect(rows).toHaveCount(1);
    await history
      .getByRole("button", { name: "已归档 1", exact: true })
      .click();
    const archive = page.getByRole("dialog", { name: "已归档对话" });
    await expect(archive).toBeVisible();
    await archive.getByRole("button", { name: "取消归档并打开" }).click();
    await expect(archive).toHaveCount(0);
    await expect(history).toHaveCount(0);
    await trigger.click();
    await expect(rows).toHaveCount(2);
  } finally {
    await app.close();
  }
});

test("shell: the global search offers all, conversation, project and widget categories; project and widget say they are not provided and issue no query", async ({}, info) => {
  const { root, ids } = seed();
  const { app, page } = await launch(root);
  try {
    await page.evaluate(async (id) => {
      await window.desktop.command({ type: "select", id });
    }, ids[0]);
    const searches = await countSearches(app);
    await page.getByRole("button", { name: "全局搜索" }).click();
    const dialog = page.getByRole("dialog", { name: "搜索对话" });
    await expect(dialog).toBeVisible();
    const tabs = dialog.getByRole("tablist", { name: "搜索分类" });
    await expect(tabs.getByRole("tab")).toHaveText([
      "全部",
      "对话",
      "项目",
      "控件",
    ]);
    await expect(tabs.getByRole("tab", { name: "全部" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // 全部: conversation results plus one fixed line saying the other two kinds are not provided yet.
    await expect(dialog.getByText("项目与控件搜索尚未提供")).toBeVisible();
    const input = dialog.getByRole("combobox", { name: "搜索标题与正文" });
    await expect(input).toBeFocused();
    await input.fill("第二");
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await expect(dialog.getByRole("option").first()).toContainText(
      "第二个对话",
    );
    const afterConversation = await searches();
    expect(afterConversation).toBeGreaterThan(0);
    // 项目: no results are invented, no query is sent, the keyword stays.
    await tabs.getByRole("tab", { name: "项目" }).click();
    await expect(tabs.getByRole("tab", { name: "项目" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(dialog.getByRole("option")).toHaveCount(0);
    await expect(dialog.getByRole("status")).toContainText("项目搜索尚未提供");
    await expect(input).toHaveValue("第二");
    await input.fill("第二个");
    await expect(dialog.getByRole("status")).toContainText("项目搜索尚未提供");
    expect(await searches()).toBe(afterConversation);
    await page.screenshot({
      path: info.outputPath("search-project-entry.png"),
    });
    // 控件: same honesty; Enter must not open anything.
    await tabs.getByRole("tab", { name: "控件" }).click();
    await expect(dialog.getByRole("status")).toContainText("控件搜索尚未提供");
    await input.press("Enter");
    await expect(dialog).toBeVisible();
    expect(await searches()).toBe(afterConversation);
    // 对话: the same results as before, without the fixed line; 全部 shows the line again.
    await tabs.getByRole("tab", { name: "对话" }).click();
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await expect(dialog.getByText("项目与控件搜索尚未提供")).toHaveCount(0);
    await tabs.getByRole("tab", { name: "全部" }).click();
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await expect(dialog.getByText("项目与控件搜索尚未提供")).toBeVisible();
    // Tabs are keyboard reachable: ArrowRight moves the selection, focus stays on the tablist.
    await tabs.getByRole("tab", { name: "全部" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.getByRole("tab", { name: "对话" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(tabs.getByRole("tab", { name: "对话" })).toBeFocused();
    // Command + K from the workbench page opens the same panel; Escape returns to the page.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page
      .getByRole("navigation", { name: "主要页面" })
      .getByRole("button", { name: "工作台" })
      .click();
    await page.keyboard.press("Meta+k");
    await expect(dialog).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "全部" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { level: 1, name: "工作台" }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

/** The accessible name of the element that currently has focus, for keyboard-order checks. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el
      ? (el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName)
      : "body";
  });

test("shell: keyboard order runs tools, page switch, avatar then content in both appearances, and a composition never fires shortcuts or sends in either entry", async ({}, info) => {
  const { root, ids } = seed();
  const { app, page } = await launch(root);
  try {
    await page.evaluate(async (id) => {
      await window.desktop.command({ type: "select", id });
    }, ids[0]);
    for (const theme of ["浅色", "深色"] as const) {
      await goToSettingsAppearance(page, theme);
      await page
        .getByRole("navigation", { name: "主要页面" })
        .getByRole("button", { name: "聊天" })
        .click();
      // From the first tool, Tab walks the shell left to right before entering the content.
      const first = page
        .locator(".home-header")
        .getByRole("button", { name: "新建对话", exact: true });
      await first.focus();
      const order: string[] = [await focused(page)];
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press("Tab");
        order.push(await focused(page));
      }
      expect(order.slice(0, 6)).toEqual([
        "新建对话",
        "最近聊天",
        "全局搜索",
        "聊天",
        "工作台",
        "我，个人空间",
      ]);
      expect(order[6]).not.toBe("body");
      expect(order[6]).not.toBe("新建对话");
      // Every shell control shows a visible ring when reached by keyboard.
      await first.focus();
      await page.keyboard.press("Shift+Tab");
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press("Tab");
        const ring = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          const css = getComputedStyle(el);
          return {
            visible: el.matches(":focus-visible"),
            outline: css.outlineStyle,
            width: parseFloat(css.outlineWidth),
          };
        });
        expect(ring.visible).toBe(true);
        expect(ring.outline).toBe("solid");
        expect(ring.width).toBeGreaterThanOrEqual(2);
      }
      // Enter on the avatar opens the popover with focus inside; Escape returns it; the same for recent chats.
      await page.keyboard.press("Enter");
      await expect(
        profileMenu(page).getByRole("menuitem").first(),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(avatar(page)).toBeFocused();
      await page.getByRole("button", { name: "最近聊天", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("section#home-history")).toBeVisible();
      // Opening moves focus into the popover (search toggle); Tab then reaches the first row.
      await expect(
        page
          .locator("section#home-history")
          .getByRole("button", { name: "搜索最近聊天" }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      const inPopover = await page.evaluate(
        () =>
          !!document.activeElement?.closest("section#home-history .sessions"),
      );
      expect(inPopover).toBe(true);
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "最近聊天", exact: true }),
      ).toBeFocused();
      await page.screenshot({ path: info.outputPath(`keyboard-${theme}.png`) });
    }
    await goToSettingsAppearance(page, "浅色");
    await page
      .getByRole("navigation", { name: "主要页面" })
      .getByRole("button", { name: "聊天" })
      .click();
    // A composition in the composer: Enter does not send, Command + K does not open search,
    // Command + Shift + A does not archive; the draft keeps the committed text.
    const input = page.getByRole("textbox", { name: "输入草稿" });
    await input.fill("组合前的文字");
    await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
    await input.dispatchEvent("compositionstart", { data: "zhong" });
    await input.dispatchEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
    });
    await input.dispatchEvent("keydown", {
      key: "k",
      metaKey: true,
      isComposing: true,
      bubbles: true,
    });
    await input.dispatchEvent("keydown", {
      key: "a",
      code: "KeyA",
      metaKey: true,
      shiftKey: true,
      isComposing: true,
      bubbles: true,
    });
    await input.dispatchEvent("compositionend", { data: "中" });
    await expect(page.getByRole("dialog", { name: "搜索对话" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "发送消息" })).toBeDisabled();
    await expect(input).toHaveValue("组合前的文字");
    const archived = await page.evaluate(async () => {
      const r = await window.desktop.command({ type: "snapshot" });
      return r.ok
        ? r.snapshot.conversations.filter((c) => c.archivedAt).length
        : -1;
    });
    expect(archived).toBe(0);
    // After the composition commits, Command + K opens the search panel from the composer.
    await input.dispatchEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
    });
    await expect(page.getByRole("dialog", { name: "搜索对话" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "搜索对话" })).toHaveCount(0);
    // The panel keeps its own compact chrome: tabs named like the main window, composition Enter does not send.
    const opening = app.waitForEvent("window");
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items[0].submenu!.items.find((i) => i.label === "打开工作台助手")!
        .click(),
    );
    const panel = await opening;
    await expect(
      panel.getByRole("navigation", { name: "面板导航" }).getByRole("button"),
    ).toHaveText(["工作台", "聊天", "待处理", "设置"]);
    await expect(
      panel.getByRole("navigation", { name: "主要页面" }),
    ).toHaveCount(0);
    await panel.getByRole("button", { name: "聊天", exact: true }).click();
    const panelInput = panel.getByRole("textbox", { name: "输入草稿" });
    await expect(panelInput).toBeEditable();
    await panelInput.fill("面板组合前");
    await expect(panel.getByTestId("save-state")).toHaveText("草稿已保存");
    await panelInput.dispatchEvent("compositionstart", { data: "zhong" });
    await panelInput.dispatchEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
    });
    await panelInput.dispatchEvent("compositionend", { data: "中" });
    await expect(
      panel.getByRole("button", { name: "发送消息" }),
    ).toBeDisabled();
    await expect(panelInput).toHaveValue("面板组合前");
    await panel.getByRole("button", { name: "搜索对话", exact: true }).click();
    await expect(panel.getByRole("dialog", { name: "搜索对话" })).toBeVisible();
    await panel.keyboard.press("Escape");
    await expect(panel.getByRole("dialog", { name: "搜索对话" })).toHaveCount(
      0,
    );
    await panel.screenshot({ path: info.outputPath("panel-chrome.png") });
  } finally {
    await app.close();
  }
});

async function goToSettingsAppearance(page: Page, theme: "浅色" | "深色") {
  await avatar(page).click();
  await profileMenu(page).getByRole("menuitem", { name: "设置" }).click();
  await page
    .getByRole("group", { name: "外观" })
    .getByRole("button", { name: theme })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    theme === "深色" ? "dark" : "light",
  );
}

test("shell: a click outside the global search panel closes it like Escape and returns focus, while an inside press released outside keeps it open", async ({}, info) => {
  const { root } = seed();
  const { app, page } = await launch(root);
  try {
    const trigger = page.getByRole("button", { name: "全局搜索" });
    const dialog = page.getByRole("dialog", { name: "搜索对话" });
    await trigger.click();
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    const viewport = await page.evaluate(() => [innerWidth, innerHeight]);
    // A press that starts inside the panel and is released outside must not close it.
    await page.mouse.move(box.x + box.width / 2, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 40, box.y + box.height + 40, {
      steps: 4,
    });
    await page.mouse.up();
    await expect(dialog).toBeVisible();
    // A press outside the panel (on the backdrop) closes it and returns focus to the trigger.
    await page.mouse.click(
      box.x + box.width + 40,
      Math.min(viewport[1] - 20, box.y + box.height + 40),
    );
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.screenshot({
      path: info.outputPath("search-closed-by-outside-click.png"),
    });
    // Command + K reopens it; a click inside the results area keeps it open.
    await page.keyboard.press("Meta+k");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("tab", { name: "对话" }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
  }
});
