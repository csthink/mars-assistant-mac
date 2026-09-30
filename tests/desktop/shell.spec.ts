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
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
  return { app, page };
}
const avatar = (page: Page) =>
  page.getByRole("button", { name: /^我，个人空间/ });
const rail = (page: Page) => page.getByRole("navigation", { name: "全局导航" });
const settings = (page: Page) => page.getByRole("dialog", { name: "设置" });
async function servicePID(app: ElectronApplication) {
  return app.evaluate(({ app }) => {
    const service = app
      .getAppMetrics()
      .find((metric) => metric.name === "csthink-assistant business");
    if (!service) throw new Error(JSON.stringify(app.getAppMetrics()));
    return service.pid;
  });
}

test("shell: the rail, the sidebar and the settings dialog replace the top navigation and the avatar popover in both appearances", async ({}, info) => {
  const { root } = seed();
  const { app, page } = await launch(root);
  try {
    // The top page switch, the avatar popover, the recent chats popover and the workbench tabs are gone.
    await expect(
      page.getByRole("navigation", { name: "主要页面" }),
    ).toHaveCount(0);
    await expect(page.locator("section#profile-menu")).toHaveCount(0);
    await expect(page.locator("section#home-history")).toHaveCount(0);
    // The former recent-chats popover button; the recent section's fold toggle has the same name.
    await expect(
      page
        .getByRole("button", { name: "最近聊天", exact: true })
        .and(page.locator(":not(.section-toggle)")),
    ).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "工作台内容" })).toHaveCount(
      0,
    );
    // No Command + K hint in the lower right corner.
    await expect(page.locator("kbd").filter({ hasText: "⌘" })).toHaveCount(1);
    // The rail: 主页, 控件, 待处理, 记录, then the avatar; the current object carries aria-current.
    await expect(rail(page).locator(".rail-item")).toHaveText([
      "主页",
      "控件",
      "待处理",
      "记录",
    ]);
    await expect(
      rail(page).getByRole("button", { name: /^主页/ }),
    ).toHaveAttribute("aria-current", "page");
    // The sidebar: new chat, search, the project area and recent chats, in this order.
    const sidebar = page.locator("#main-sidebar");
    await expect(sidebar.locator(".side-fixed button")).toHaveText([
      "新建聊天",
      "搜索⌘K",
    ]);
    await expect(sidebar.getByRole("heading", { level: 2 })).toHaveText([
      "项目",
      "最近聊天",
    ]);
    // Each rail entry opens its object in the centre and becomes the current entry.
    for (const [entry, heading] of [
      ["控件", "控件"],
      ["待处理", "待处理"],
      ["记录", "运行记录"],
    ] as const) {
      await rail(page)
        .getByRole("button", { name: new RegExp(`^${entry}`) })
        .click();
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      await expect(
        rail(page).getByRole("button", { name: new RegExp(`^${entry}`) }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        rail(page).getByRole("button", { name: /^主页/ }),
      ).not.toHaveAttribute("aria-current", "page");
    }
    // 全部项目 opens the project list and is the current sidebar item.
    await sidebar.getByRole("button", { name: /^全部项目/ }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "项目" }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: /^全部项目/ }),
    ).toHaveAttribute("aria-current", "page");
    // The avatar opens settings as a modal dialog with the individual space line on top; the categories
    // and their content are unchanged.
    await expect(avatar(page)).toHaveAttribute("aria-haspopup", "dialog");
    await avatar(page).click();
    const dialog = settings(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".settings-dialog-profile")).toContainText(
      "个人空间",
    );
    await expect(dialog.locator(".settings-dialog-profile")).toContainText(
      "保存在这台 Mac 上",
    );
    const categories = dialog.getByRole("navigation", { name: "设置分类" });
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
    await expect(dialog.getByRole("group", { name: "外观" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(avatar(page)).toBeFocused();
    // 主页 returns to the new-conversation page.
    await rail(page).getByRole("button", { name: /^主页/ }).click();
    await expect(page.locator(".welcome")).toBeVisible();
    await page.screenshot({ path: info.outputPath("shell-light.png") });
    // Dark appearance keeps the same shell and a visible focus ring on the avatar.
    await avatar(page).click();
    await settings(page)
      .getByRole("group", { name: "外观" })
      .getByRole("button", { name: "深色" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await settings(page).getByRole("button", { name: "关闭设置" }).click();
    await rail(page).getByRole("button", { name: /^记录/ }).focus();
    await page.keyboard.press("Tab");
    await expect(avatar(page)).toBeFocused();
    const ring = await avatar(page).evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        visible: el.matches(":focus-visible"),
        outline: style.outlineStyle,
      };
    });
    expect(ring).toEqual({ visible: true, outline: "solid" });
    await page.screenshot({ path: info.outputPath("shell-dark.png") });
    await avatar(page).click();
    await settings(page)
      .getByRole("group", { name: "外观" })
      .getByRole("button", { name: "浅色" })
      .click();
    await page.keyboard.press("Escape");
  } finally {
    await app.close();
  }
});

test("shell: at the 900 × 680 minimum window the four columns do not overlap, the settings dialog stays inside the viewport and the composer is reachable", async ({}, info) => {
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
    const railBox = await box(rail(page));
    const sidebarBox = await box(page.locator("#main-sidebar"));
    const centerBox = await box(page.locator(".center"));
    // Rail 56, sidebar 248, the centre the rest; side by side without overlap or horizontal scrolling.
    expect([railBox.x, railBox.width]).toEqual([0, 56]);
    expect([sidebarBox.x, sidebarBox.width]).toEqual([56, 248]);
    expect([centerBox.x, centerBox.width]).toEqual([304, 596]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await avatar(page).click();
    const dialog = await box(settings(page));
    expect(dialog.x).toBeGreaterThanOrEqual(0);
    expect(dialog.x + dialog.width).toBeLessThanOrEqual(900);
    expect(dialog.y).toBeGreaterThanOrEqual(0);
    expect(dialog.y + dialog.height).toBeLessThanOrEqual(680);
    await page.screenshot({
      path: info.outputPath("shell-900x680-settings.png"),
    });
    await page.keyboard.press("Escape");
    // The composer is inside the window below the centre title row.
    const composer = await box(page.getByRole("textbox", { name: "输入草稿" }));
    expect(composer.y + composer.height).toBeLessThanOrEqual(680);
    expect(composer.x).toBeGreaterThanOrEqual(centerBox.x);
    await page.screenshot({ path: info.outputPath("shell-900x680.png") });
  } finally {
    await app.close();
  }
});

test("shell: the sidebar keeps the existing recent list with its menus and archived entry, and selecting a row opens the conversation in the centre", async ({}, info) => {
  const { root, ids } = seed();
  const { app, page } = await launch(root);
  try {
    const history = page.locator("#main-sidebar #recent-chats");
    await expect(history).toHaveAttribute("aria-label", "最近聊天");
    await expect(
      history.getByRole("heading", { level: 2, name: "最近聊天" }),
    ).toBeVisible();
    // The existing list: same rows, same menus, same archived entry.
    const recent = history.getByLabel("最近对话");
    await expect(recent.locator(".session")).toHaveCount(2);
    await expect(
      history.getByRole("button", { name: "已归档 0", exact: true }),
    ).toBeVisible();
    await recent
      .getByLabel(`对话菜单 ${ids[1].slice(0, 8)}`, { exact: true })
      .click();
    await expect(page.getByRole("menu", { name: "对话菜单" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu", { name: "对话菜单" })).toHaveCount(0);
    await expect(history).toBeVisible();
    await page.screenshot({ path: info.outputPath("recent-chats.png") });
    // From another object, selecting a conversation opens it in the centre and marks its row.
    await rail(page)
      .getByRole("button", { name: /^待处理/ })
      .click();
    await recent
      .getByLabel(`对话 ${ids[1].slice(0, 8)}`, { exact: true })
      .click();
    await expect(page.locator(".chat-layout")).toBeVisible();
    await expect(
      recent.getByLabel(`对话 ${ids[1].slice(0, 8)}`, { exact: true }),
    ).toHaveAttribute("aria-current", "true");
    await expect(
      page.getByRole("textbox", { name: "输入草稿" }),
    ).toBeEditable();
    // While another object is in the centre no row is marked current.
    await rail(page).getByRole("button", { name: /^记录/ }).click();
    await expect(recent.locator('[aria-current="true"]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("shell: the rail's pending badge follows open items, equals the pending page's unresolved count and keeps the last value when the service is lost", async () => {
  const { root } = seed({ pending: true });
  const { app, page } = await launch(root);
  try {
    const entry = rail(page).getByRole("button", { name: /^待处理/ });
    const badge = entry.locator(".rail-badge");
    await expect(entry).toHaveAttribute("aria-label", "待处理，1 项未解决");
    await expect(badge).toHaveText("1");
    await entry.click();
    await expect(
      page.getByRole("list", { name: "待处理事项" }).getByRole("listitem"),
    ).toHaveCount(1);
    await expect(page.getByText(/^全部未解决：1/)).toBeVisible();
    // Losing the business service must not turn the count into a reassuring zero.
    const pid = await servicePID(app);
    await app.evaluate((_electron, id) => process.kill(id, "SIGKILL"), pid);
    await expect(
      page.getByText("业务服务已失联。", { exact: false }),
    ).toBeVisible();
    await expect(entry).toHaveAttribute(
      "aria-label",
      "待处理，1 项未解决，未连接",
    );
    await expect(badge).toHaveText("1");
    await page.getByRole("button", { name: "重新连接" }).click();
    await expect(entry).toHaveAttribute("aria-label", "待处理，1 项未解决");
    await expect(
      page.getByRole("button", { name: "忽略", exact: true }),
    ).toBeEnabled();
    // Dismissing the item removes the badge.
    await page.getByRole("button", { name: "忽略", exact: true }).click();
    await expect(entry).toHaveAttribute("aria-label", "待处理");
    await expect(badge).toHaveCount(0);
    await expect(page.getByText(/^全部未解决：0/)).toBeVisible();
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

test("shell: the sidebar's recent list filters by title only, keeps the archived entry and stays while a row's confirm dialog is up", async ({}, info) => {
  const { root, ids } = seed();
  const { app, page } = await launch(root);
  try {
    // A message that would match a global search but not a title-only filter.
    await page.evaluate(async (id) => {
      await window.desktop.command({ type: "select", id });
    }, ids[0]);
    const searches = await countSearches(app);
    const history = page.locator("#main-sidebar #recent-chats");
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
    // The filter stays while other objects are shown in the centre.
    await rail(page)
      .getByRole("button", { name: /^待处理/ })
      .click();
    await expect(input).toHaveValue("第一");
    await expect(rows).toHaveCount(1);
    // A row's delete confirmation opens over the sidebar; cancelling keeps the row.
    await history
      .locator(".session-line")
      .first()
      .locator(".session-more")
      .click();
    await page.getByRole("menuitem", { name: "删除对话" }).click();
    const confirm = page.getByRole("dialog", { name: "删除对话", exact: true });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(history).toBeVisible();
    await expect(rows).toHaveCount(1);
    // Closing the filter row clears the query and restores the full list.
    await toggle.click();
    await expect(history.locator("#history-query-row")).toBeHidden();
    await expect(rows).toHaveCount(2);
    // The archived entry opens the archived page in the centre; unarchive returns the row.
    await history
      .locator(".session-line")
      .first()
      .locator(".session-more")
      .click();
    await page.getByRole("menuitem", { name: /^归档/ }).click();
    await expect(rows).toHaveCount(1);
    const entry = history.getByRole("button", {
      name: "已归档 1",
      exact: true,
    });
    await entry.click();
    await expect(entry).toHaveAttribute("aria-current", "page");
    const archive = page.getByRole("list", { name: "已归档对话" });
    await expect(archive).toBeVisible();
    await archive.getByRole("button", { name: "取消归档" }).click();
    await expect(archive).toHaveCount(0);
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
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "搜索", exact: true })
      .click();
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
    // Command + K from the project list opens the same panel as the sidebar search; Escape returns to the page.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: /^全部项目/ })
      .click();
    await page.keyboard.press("Meta+k");
    await expect(dialog).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "全部" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { level: 1, name: "项目" }),
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

test("shell: keyboard order runs the rail, the sidebar, the centre title then content in both appearances, and a composition never fires shortcuts or sends in either entry", async ({}, info) => {
  const { root, ids } = seed();
  const { app, page } = await launch(root);
  try {
    await page.evaluate(async (id) => {
      await window.desktop.command({ type: "select", id });
    }, ids[0]);
    for (const theme of ["浅色", "深色"] as const) {
      await goToSettingsAppearance(page, theme);
      // From the first rail entry, Tab walks the rail, the sidebar and the centre title row before the content.
      const first = rail(page).getByRole("button", { name: /^主页/ });
      await first.focus();
      const order: string[] = [await focused(page)];
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press("Tab");
        order.push(await focused(page));
        if (order.at(-1) === "打开右栏") break;
      }
      // Each sidebar section starts with its fold toggle; the permanent project create control precedes its menu.
      expect(order.slice(0, 14)).toEqual([
        "主页",
        "控件",
        "待处理",
        "记录",
        "我，个人空间，打开设置",
        "折叠侧栏",
        "新建聊天",
        "搜索⌘K",
        "项目",
        "新建项目",
        "项目区操作",
        "全部项目 · 0",
        "最近聊天",
        "搜索最近聊天",
      ]);
      expect(order.at(-1)).toBe("打开右栏");
      const rows = order.slice(14, -1);
      expect(rows.filter((name) => name.startsWith("对话 ")).length).toBe(2);
      expect(rows.at(-1)).toBe("已归档 0");
      // Every shell control shows a visible ring when reached by keyboard.
      await first.focus();
      await page.keyboard.press("Shift+Tab");
      for (let i = 0; i < order.length; i++) {
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
      // Enter on the avatar opens the settings dialog with focus inside; Escape returns it to the avatar.
      await avatar(page).focus();
      await page.keyboard.press("Enter");
      await expect(settings(page)).toBeVisible();
      expect(
        await page.evaluate(
          () => !!document.activeElement?.closest("dialog[open]"),
        ),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(settings(page)).toHaveCount(0);
      await expect(avatar(page)).toBeFocused();
      await page.screenshot({ path: info.outputPath(`keyboard-${theme}.png`) });
    }
    await goToSettingsAppearance(page, "浅色");
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
  await settings(page)
    .getByRole("group", { name: "外观" })
    .getByRole("button", { name: theme })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    theme === "深色" ? "dark" : "light",
  );
  await settings(page).getByRole("button", { name: "关闭设置" }).click();
  await expect(settings(page)).toHaveCount(0);
}

test("shell: a click outside the global search panel closes it like Escape and returns focus, while an inside press released outside keeps it open", async ({}, info) => {
  const { root } = seed();
  const { app, page } = await launch(root);
  try {
    const trigger = page
      .locator("#main-sidebar")
      .getByRole("button", { name: "搜索", exact: true });
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
