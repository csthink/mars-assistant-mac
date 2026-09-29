import { test, expect } from "@playwright/test";
import { launchLocal } from "./local-client";
import {
  closeRecent,
  expectSessionCount,
  goTo,
  openConversation,
  recent,
} from "./shell";
import { Store } from "../../src/service/store";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
function seed() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/organization-ui-"));
  const store = new Store(root);
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids) {
    store.execute({ type: "create", id }, "main");
    store.execute(
      { type: "renameConversation", id, title: "松果计划", revision: 0 },
      "main",
    );
    store.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user','已保存的消息',?)",
      )
      .run(randomUUID(), id, new Date().toISOString());
  }
  store.close();
  return { root, ids };
}
test("organization: single-line ordering, pin, unread and archive persist with exact identities", async ({}, info) => {
  const { root, ids } = seed();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    const list = await recent(page);
    await expect(list.locator(".session")).toHaveCount(2);
    await recent(page);
    await page
      .getByLabel(`对话菜单 ${ids[0].slice(0, 8)}`, { exact: true })
      .click();
    await page.getByRole("menuitem", { name: "置顶", exact: false }).click();
    await expect(list.locator(".session").first()).toHaveAttribute(
      "aria-label",
      `对话 ${ids[0].slice(0, 8)}`,
    );
    await recent(page);
    await page
      .getByLabel(`对话菜单 ${ids[0].slice(0, 8)}`, { exact: true })
      .click();
    await page.getByRole("menuitem", { name: "标记为未读" }).click();
    await expect(list.locator(".unread-dot")).toHaveCount(1);
    await page.reload();
    await recent(page);
    await expect(list.locator(".unread-dot")).toHaveCount(1);
    await openConversation(page, `对话 ${ids[0].slice(0, 8)}`);
    await recent(page);
    await expect(list.locator(".unread-dot")).toHaveCount(0);
    await page.keyboard.press("Meta+Shift+a");
    await expect(list.locator(".session")).toHaveCount(1);
    // The archived list is a centre page; archiving took the conversation out of the pinned section.
    await page.getByRole("button", { name: "已归档 1", exact: true }).click();
    const archive = page.getByRole("list", { name: "已归档对话" });
    await expect(
      archive.locator(`[data-conversation="${ids[0]}"]`),
    ).toHaveCount(1);
    await expect(page.locator('[aria-label="已置顶对象"]')).toHaveCount(0);
    await archive.getByRole("button", { name: "取消归档" }).click();
    await expect(
      page.getByRole("heading", { name: "没有已归档的对话" }),
    ).toBeVisible();
    await recent(page);
    await expect(list.locator(".session")).toHaveCount(2);
    // Leaving the archive never pins again.
    await expect(page.locator('[aria-label="已置顶对象"]')).toHaveCount(0);
    await openConversation(page, `对话 ${ids[0].slice(0, 8)}`);
    await page.screenshot({ path: info.outputPath("organized-sidebar.png") });
  } finally {
    await app.close();
  }
});
test("organization: deletion confirmation, search exclusion, restoration and separate permanent deletion", async ({}, info) => {
  const { root, ids } = seed();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    const remove = async () => {
      await recent(page);
      await page
        .getByLabel(`对话菜单 ${ids[1].slice(0, 8)}`, { exact: true })
        .click();
      await page.getByRole("menuitem", { name: "删除对话" }).click();
    };
    await remove();
    const dialog = page.getByRole("dialog", { name: "删除对话", exact: true });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expectSessionCount(page, 2);
    await remove();
    await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
    await expectSessionCount(page, 1);
    const results = await page.evaluate(() =>
      window.desktop.search({
        sequence: 901,
        query: "已保存的消息",
        offset: 0,
      }),
    );
    expect(results.ok).toBe(true);
    if (results.ok)
      expect(results.hits.map((h) => h.conversationId)).toEqual([ids[0]]);
    await goTo(page, "设置");
    await page.getByRole("button", { name: "最近删除", exact: true }).click();
    await page.getByRole("button", { name: "延长30天", exact: true }).click();
    await page.getByRole("button", { name: "恢复", exact: true }).click();
    await expectSessionCount(page, 2);
    await remove();
    await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
    await closeRecent(page);
    await goTo(page, "设置");
    await page.getByRole("button", { name: "最近删除", exact: true }).click();
    await page.getByRole("button", { name: "永久删除…", exact: true }).click();
    const permanent = page.getByRole("dialog", {
      name: "永久删除对话",
      exact: true,
    });
    await permanent.getByRole("button", { name: "取消", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "恢复", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "永久删除…", exact: true }).click();
    await permanent
      .getByRole("button", { name: "确认永久删除", exact: true })
      .click();
    await expect(
      page.getByText("没有已删除的对话。", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("recently-deleted.png") });
  } finally {
    await app.close();
  }
});
test("organization: copy exports saved messages only, archives are searchable and working directory stays disabled", async () => {
  const { root, ids } = seed();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  const previous = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    await recent(page);
    await page
      .getByLabel(`对话菜单 ${ids[1].slice(0, 8)}`, { exact: true })
      .click();
    await page.getByRole("menuitem", { name: "复制", exact: true }).click();
    await expect(
      page.getByRole("menuitem", { name: "复制工作目录" }),
    ).toBeDisabled();
    await page
      .getByRole("menuitem", { name: "复制为 Markdown", exact: true })
      .click();
    // The export runs through the business service; the clipboard is read only
    // after the product's own completion notice, as a user would see it.
    await expect(
      page.getByRole("status").filter({ hasText: "已复制为 Markdown" }),
    ).toBeVisible();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      "# 松果计划\n\n## 用户\n\n已保存的消息\n",
    );
    await page.keyboard.press("Meta+Shift+c");
    await expect(
      page.getByRole("status").filter({ hasText: "已复制对话链接" }),
    ).toBeVisible();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      `csthink-assistant://conversation/${ids[1]}`,
    );
    await page.keyboard.press("Meta+Shift+a");
    const results = await page.evaluate(() =>
      window.desktop.search({ sequence: 902, query: "松果计划", offset: 0 }),
    );
    expect(results.ok).toBe(true);
    if (results.ok)
      expect(
        results.hits.find((h) => h.conversationId === ids[1])?.archived,
      ).toBe(true);
  } finally {
    await app.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      previous,
    );
    await app.close();
  }
});

test("organization: deep links queue on cold start and open existing identity without sending", async () => {
  const { root, ids } = seed();
  const app = await launchLocal({
    args: [
      resolve("."),
      `--data-root=${root}`,
      `csthink-assistant://conversation/${ids[0]}`,
    ],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    const selected = async () =>
      page.evaluate(async () => {
        const r = await window.desktop.command({ type: "snapshot" });
        return r.ok ? r.snapshot.selected.main : null;
      });
    await expect.poll(selected).toBe(ids[0]);
    await app.evaluate(({ app }, id) => {
      app.emit(
        "open-url",
        { preventDefault() {} },
        `csthink-assistant://conversation/${id}`,
      );
    }, ids[1]);
    await expect.poll(selected).toBe(ids[1]);
    expect(
      await page.evaluate(async () => {
        const r = await window.desktop.command({ type: "snapshot" });
        return r.ok ? r.snapshot.activeTurns.length : -1;
      }),
    ).toBe(0);
  } finally {
    await app.close();
  }
});
test("appearance: light dark and automatic synchronize across windows and preserve draft through restart", async ({}, info) => {
  const { root } = seed();
  let app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  try {
    let page = await app.firstWindow();
    // Playwright defaults CSS media to light; release that emulation to test nativeTheme.
    await page.emulateMedia({ colorScheme: null });
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    const input = page.getByRole("textbox", { name: "输入草稿" });
    await input.fill("外观切换保留草稿");
    await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
    await goTo(page, "设置");
    await expect(
      page.getByRole("heading", { name: "通用", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "浅色", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "浅色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    for (const name of [
      "通用",
      "模型",
      "最近删除",
      "访问权限",
      "数据保留",
      "数据与隐私",
    ]) {
      await page.getByRole("button", { name, exact: true }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.screenshot({ path: info.outputPath("light-settings.png") });
    await goTo(page, "聊天");
    await expect(input).toHaveValue("外观切换保留草稿");
    await goTo(page, "设置");
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const panelReady = app.waitForEvent("window");
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()!.items[0].submenu!.items.find(
        (i) => i.label === "打开工作台助手",
      )!;
      item.click();
    });
    const panel = await panelReady;
    await panel.emulateMedia({ colorScheme: null });
    await expect(panel.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "自动", exact: true }).click();
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe("system");
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(panel.locator("html")).toHaveAttribute("data-theme", "light");
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(panel.locator("html")).toHaveAttribute("data-theme", "dark");
    await app.close();
    app = await launchLocal({
      args: [resolve("."), `--data-root=${root}`],
      cwd: resolve("."),
    });
    page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe("system");
    await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
      "外观切换保留草稿",
    );
  } finally {
    await app.close();
  }
});

test("appearance: a new data root starts light, and a choice the business service does not confirm keeps the saved appearance with its reason until reconnecting", async ({}, info) => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/appearance-fresh-"));
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  let paused: number | undefined;
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await goTo(page, "设置");
    const light = page.getByRole("button", { name: "浅色", exact: true });
    const dark = page.getByRole("button", { name: "深色", exact: true });
    await expect(light).toHaveAttribute("aria-pressed", "true");
    const service = await app.evaluate(
      ({ app }) =>
        app
          .getAppMetrics()
          .find((metric) => metric.name === "csthink-assistant business")!.pid,
    );
    await app.evaluate((_electron, id) => process.kill(id, "SIGSTOP"), service);
    paused = service;
    await dark.click();
    await expect(
      page.locator(".settings-content").getByRole("alert"),
    ).toContainText("保存确认超时");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(light).toHaveAttribute("aria-pressed", "true");
    await expect(dark).toHaveAttribute("aria-pressed", "false");
    await page.screenshot({
      path: info.outputPath("appearance-unconfirmed.png"),
    });
    await app.evaluate((_electron, id) => process.kill(id, "SIGCONT"), service);
    paused = undefined;
    await page.getByRole("button", { name: "重新连接", exact: true }).click();
    await expect(dark).toBeEnabled();
    await dark.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(dark).toHaveAttribute("aria-pressed", "true");
  } finally {
    if (paused !== undefined)
      await app.evaluate(
        (_electron, id) => process.kill(id, "SIGCONT"),
        paused,
      );
    await app.close();
  }
});

test("organization: header title edits synchronize across surfaces and keep identity, cancellation and restart", async ({}, info) => {
  const { root, ids } = seed();
  let app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  const longTitle = "项目名称".repeat(19);
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    const heading = page.getByRole("button", {
      name: "修改对话名称",
      exact: true,
    });
    await expect(heading).toHaveText("松果计划");
    await expect(
      page
        .locator(".top-actions")
        .getByRole("button", { name: "重命名", exact: true }),
    ).toHaveCount(0);
    const draft = page.getByRole("textbox", { name: "输入草稿" });
    await draft.fill("改名时保留这段草稿");
    await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
    // The main window renames the centre title in place; Enter saves.
    const field = page
      .locator(".center-header")
      .getByRole("textbox", { name: /^重命名对话/ });
    await heading.click();
    await expect(page.getByRole("dialog", { name: "重命名对话" })).toHaveCount(
      0,
    );
    await expect(field).toHaveValue("松果计划");
    await field.fill("主窗口编辑的名称");
    await field.press("Enter");
    await expect(heading).toHaveText("主窗口编辑的名称");
    await expect(heading).toBeFocused();
    await recent(page);
    await expect(
      page
        .getByLabel(`对话 ${ids[1].slice(0, 8)}`, { exact: true })
        .locator(".session-name"),
    ).toHaveText("主窗口编辑的名称");
    await closeRecent(page);
    const ready = app.waitForEvent("window");
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items[0].submenu!.items.find((i) => i.label === "打开工作台助手")!
        .click(),
    );
    const panel = await ready;
    await panel.getByRole("button", { name: "聊天", exact: true }).click();
    await panel.evaluate(async (id) => {
      const r = await window.desktop.command({ type: "select", id });
      if (!r.ok) throw new Error(r.message);
    }, ids[1]);
    const panelHeading = panel.getByRole("button", {
      name: "修改对话名称",
      exact: true,
    });
    await expect(panelHeading).toHaveText("主窗口编辑的名称");
    await panelHeading.click();
    const panelDialog = panel.getByRole("dialog", { name: "重命名对话" });
    await panelDialog.getByLabel("对话标题", { exact: true }).fill(longTitle);
    await panelDialog
      .getByRole("button", { name: "保存标题", exact: true })
      .click();
    await expect(heading).toHaveText(longTitle);
    await expect(panelHeading).toHaveText(longTitle);
    await expect(draft).toHaveValue("改名时保留这段草稿");
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows())
        w.setContentSize(
          w.getBounds().width > 700 ? 900 : 420,
          w.getBounds().width > 700 ? 680 : 600,
        );
    });
    for (const p of [page, panel]) {
      const title = p.getByRole("button", {
        name: "修改对话名称",
        exact: true,
      });
      const box = await title.boundingBox(),
        menu = await p
          .getByRole("button", { name: "当前对话菜单", exact: true })
          .boundingBox();
      expect(box).not.toBeNull();
      expect(menu).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(menu!.x);
      // In the main window the title source sits between the title and the menu button.
      const before =
        p === page
          ? (await p.locator(".center-header .title-source").boundingBox())!
          : box!;
      if (p === page) expect(box!.x + box!.width).toBeLessThanOrEqual(before.x);
      expect(before.x + before.width).toBeLessThanOrEqual(menu!.x);
      expect(menu!.x - before.x - before.width).toBeLessThanOrEqual(8);
      // The main window's title sits in the centre title row; the panel keeps its compact toolbar with
      // the create button beside the title.
      const header = p.locator(p === page ? ".center-header" : ".topbar");
      if (p === panel) {
        const create = await header
          .getByRole("button", { name: "新建对话", exact: true })
          .boundingBox();
        expect(create!.x + create!.width).toBeLessThanOrEqual(box!.x);
        expect(box!.x - create!.x - create!.width).toBeLessThanOrEqual(8);
        expect((await header.boundingBox())!.height).toBe(44);
      } else {
        const row = (await header.boundingBox())!;
        expect(box!.y).toBeGreaterThanOrEqual(row.y);
        expect(box!.y + box!.height).toBeLessThanOrEqual(row.y + row.height);
      }
      await expect(header).not.toContainText("本地数据");
      const menuButton = p.getByRole("button", {
        name: "当前对话菜单",
        exact: true,
      });
      for (const hover of [false, true]) {
        if (hover) await menuButton.hover();
        expect(
          await menuButton.evaluate((el) => {
            const css = getComputedStyle(el);
            return [css.backgroundColor, css.borderTopWidth, css.boxShadow];
          }),
        ).toEqual(["rgba(0, 0, 0, 0)", "0px", "none"]);
      }
      await menuButton.click();
      await expect(
        p.getByRole("menuitem", { name: "重命名 ⌥⌘R", exact: true }),
      ).toBeVisible();
      await p.keyboard.press("Escape");
      expect(
        await title.evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(true);
    }
    await heading.click();
    await field.fill("取消的名称");
    await field.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(heading).toHaveText(longTitle);
    await expect(panelHeading).toHaveText(longTitle);
    await openConversation(page, `对话 ${ids[0].slice(0, 8)}`);
    await expect(heading).toHaveText("松果计划");
    await expect(panelHeading).toHaveText(longTitle);
    await page.screenshot({
      path: info.outputPath("header-main.png"),
      scale: "css",
    });
    await panel.screenshot({
      path: info.outputPath("header-panel.png"),
      scale: "css",
    });
    await app.close();
    app = await launchLocal({
      args: [resolve("."), `--data-root=${root}`],
      cwd: resolve("."),
    });
    const reopened = await app.firstWindow();
    await expect(
      reopened.getByRole("button", { name: "修改对话名称", exact: true }),
    ).toHaveText("松果计划");
    await openConversation(reopened, `对话 ${ids[1].slice(0, 8)}`);
    await expect(
      reopened.getByRole("button", { name: "修改对话名称", exact: true }),
    ).toHaveText(longTitle);
    await expect(
      reopened.getByRole("textbox", { name: "输入草稿" }),
    ).toHaveValue("改名时保留这段草稿");
    await reopened
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    // An empty conversation shows the welcome instead of a title row (prototype P1); while it is unused it
    // stands for the new-conversation page and has no row in the sidebar.
    await expect(
      reopened.getByRole("button", { name: "修改对话名称", exact: true }),
    ).toHaveCount(0);
    await expect(
      (await recent(reopened))
        .locator(".session-name")
        .filter({ hasText: "新对话" }),
    ).toHaveCount(0);
    await closeRecent(reopened);
    await expect(
      reopened.getByRole("textbox", { name: "输入草稿" }),
    ).toHaveValue("");
    await openConversation(reopened, `对话 ${ids[1].slice(0, 8)}`);
    await expect(
      reopened.getByRole("textbox", { name: "输入草稿" }),
    ).toHaveValue("改名时保留这段草稿");
  } finally {
    await app.close();
  }
});

test("organization: deletion reminder expires, undo remains safe and navigation keeps assistant actions scoped", async ({}, info) => {
  const { root, ids } = seed();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    const create = page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true });
    await expect(create).toBeEnabled();
    await page.clock.install();
    const toast = page.locator(".organization-undo");
    const remove = async (id: string) => {
      await recent(page);
      await page
        .getByLabel(`对话菜单 ${id.slice(0, 8)}`, { exact: true })
        .click();
      await page.getByRole("menuitem", { name: "删除对话" }).click();
      await page
        .getByRole("dialog", { name: "删除对话", exact: true })
        .getByRole("button", { name: "确认删除", exact: true })
        .click();
      await expect(toast).toContainText("至少保留30天");
      await expect(page.locator(".notice")).toHaveCount(0);
    };
    const restore = async () => {
      await goTo(page, "设置");
      await page.getByRole("button", { name: "最近删除", exact: true }).click();
      await page.getByRole("button", { name: "恢复", exact: true }).click();
      await goTo(page, "聊天");
      await openConversation(page, `对话 ${ids[1].slice(0, 8)}`);
    };
    // Deleting the selected conversation must still show the receipt.
    await remove(ids[1]);
    await page.clock.fastForward(4000);
    await expect(toast).toBeVisible();
    await page.clock.fastForward(1100);
    await expect(toast).toHaveCount(0);
    await restore();
    await remove(ids[0]);
    await toast.getByRole("button", { name: "撤销删除", exact: true }).click();
    await expect(toast).toHaveCount(0);
    await expectSessionCount(page, 2);
    await remove(ids[0]);
    await goTo(page, "项目");
    await expect(toast).toHaveCount(0);
    // The sidebar keeps new chat and search beside every object in the centre.
    await expect(create).toHaveCount(1);
    await page.screenshot({
      path: info.outputPath("workbench-header.png"),
      scale: "css",
    });
    await goTo(page, "聊天");
    await expect(toast).toHaveCount(0);
    await restore();
    await remove(ids[0]);
    await create.click();
    await expect(toast).toHaveCount(0);
    await openConversation(page, `对话 ${ids[1].slice(0, 8)}`);
    await expect(toast).toHaveCount(0);
    for (const name of [
      "项目",
      "控件",
      "待处理",
      "运行记录",
      "设置",
    ] as const) {
      await goTo(page, name);
      await expect(create).toHaveCount(1);
    }
    await goTo(page, "聊天");
    const ready = app.waitForEvent("window");
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items[0].submenu!.items.find((i) => i.label === "打开工作台助手")!
        .click(),
    );
    const panel = await ready;
    const panelCreate = panel
      .locator(".topbar")
      .getByRole("button", { name: "新建对话", exact: true });
    await expect(
      panel.getByRole("heading", { name: "工作台", exact: true }),
    ).toBeVisible();
    await expect(panelCreate).toHaveCount(0);
    await panel.getByRole("button", { name: "聊天", exact: true }).click();
    await expect(panelCreate).toBeEnabled();
    await panel.getByRole("button", { name: "设置", exact: true }).click();
    await expect(panelCreate).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("organization: dialogs restore pointer focus without rings and preserve keyboard focus navigation", async ({}, info) => {
  const { root } = seed();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    const search = page
      .locator("#main-sidebar")
      .getByRole("button", { name: "搜索", exact: true });
    const heading = page.getByRole("button", {
      name: "修改对话名称",
      exact: true,
    });
    await expect(heading).toBeEnabled();
    const indicator = async (target: typeof search, visible: boolean) => {
      await expect(target).toBeFocused();
      await expect
        .poll(() => target.evaluate((el) => el.matches(":focus-visible")))
        .toBe(visible);
      await expect
        .poll(() => target.evaluate((el) => getComputedStyle(el).outlineStyle))
        .toBe(visible ? "solid" : "none");
    };
    for (const close of ["Escape", "关闭搜索"]) {
      await search.click();
      await page.getByRole("dialog", { name: "搜索对话" }).waitFor();
      if (close === "Escape") await page.keyboard.press("Escape");
      else await page.getByRole("button", { name: close, exact: true }).click();
      await indicator(search, false);
    }
    // The centre title renames in place: Escape cancels, an empty name keeps the saved one, Enter saves;
    // each time focus returns to the title without a ring, since it was reached by the pointer.
    const field = page
      .locator(".center-header")
      .getByRole("textbox", { name: /^重命名对话/ });
    for (const close of ["Escape", "empty", "Enter"]) {
      await heading.click();
      await expect(field).toBeFocused();
      await field.fill(close === "empty" ? "   " : "焦点恢复后的名称");
      await page.keyboard.press(close === "Escape" ? "Escape" : "Enter");
      await expect(field).toHaveCount(0);
      await indicator(heading, false);
      if (close !== "Enter") await expect(heading).toHaveText("松果计划");
    }
    await expect(heading).toHaveText("焦点恢复后的名称");
    await page.screenshot({
      path: info.outputPath("pointer-return.png"),
      clip: (await page.locator(".center-header").boundingBox())!,
      scale: "css",
    });
    // Shift+Tab away and Tab back establishes real keyboard navigation.
    for (const target of [search, heading]) {
      await target.click();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await indicator(target, true);
      await page.keyboard.press("Enter");
      if (target === heading) await expect(field).toBeFocused();
      else await page.locator("dialog[open]").waitFor();
      await page.keyboard.press("Escape");
      await indicator(target, true);
    }
    await page.screenshot({
      path: info.outputPath("keyboard-return.png"),
      clip: (await page.locator(".center-header").boundingBox())!,
      scale: "css",
    });
    const menu = page.getByRole("button", {
      name: "当前对话菜单",
      exact: true,
    });
    await menu.click();
    await page.getByRole("menuitem", { name: "删除对话" }).click();
    await page
      .getByRole("dialog", { name: "删除对话", exact: true })
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() =>
        document.activeElement?.matches(":focus-visible"),
      ),
    ).toBe(true);
    await expectSessionCount(page, 2);
  } finally {
    await app.close();
  }
});
