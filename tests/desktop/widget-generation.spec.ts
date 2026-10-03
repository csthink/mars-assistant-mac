import {
  test,
  expect,
  type Page,
  type ElectronApplication,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchLocal, closeLocal } from "./local-client";
async function ready(page: Page) {
  await expect(
    page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
}
async function fixture() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/widget-editor-"));
  let app: ElectronApplication | undefined = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
  });
  let page = await app.firstWindow();
  await ready(page);
  return {
    root,
    get page() {
      return page;
    },
    async restart() {
      const previous = app;
      app = undefined;
      if (previous) await closeLocal(previous);
      app = await launchLocal({ args: [resolve("."), `--data-root=${root}`] });
      page = await app.firstWindow();
      await ready(page);
    },
    async close() {
      const current = app;
      app = undefined;
      try {
        if (current) await closeLocal(current);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
async function widgets(page: Page) {
  await page
    .getByRole("navigation", { name: "全局导航" })
    .getByRole("button", { name: "控件", exact: true })
    .click();
}
async function newDraft(page: Page) {
  await page
    .getByRole("button", { name: "新建控件", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("textbox", { name: "控件需求", exact: true }),
  ).toBeVisible();
}
async function saved(page: Page) {
  await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
}
test("widget editor: same-name drafts stay independent and returning preserves draft search", async () => {
  const f = await fixture();
  try {
    await widgets(f.page);
    await newDraft(f.page);
    await f.page
      .getByRole("textbox", { name: "控件草稿名称" })
      .fill("同名控件");
    await f.page
      .getByRole("textbox", { name: "控件需求", exact: true })
      .fill("first requirement");
    await saved(f.page);
    await f.page.getByRole("button", { name: "返回控件草稿" }).click();
    await newDraft(f.page);
    await f.page
      .getByRole("textbox", { name: "控件草稿名称" })
      .fill("同名控件");
    await f.page
      .getByRole("textbox", { name: "控件需求", exact: true })
      .fill("second requirement");
    await saved(f.page);
    await f.page.getByRole("button", { name: "返回控件草稿" }).click();
    await f.page.getByRole("button", { name: /^草稿 / }).click();
    await expect(f.page.locator(".widget-draft-row")).toHaveCount(2);
    await f.page.getByRole("button", { name: "搜索控件草稿" }).click();
    await f.page
      .getByRole("textbox", { name: "搜索草稿名称或需求" })
      .fill("first");
    await f.page.keyboard.press("Escape");
    await expect(f.page.locator(".widget-draft-row")).toHaveCount(1);
    await f.page.locator(".widget-draft-row").click();
    await expect(
      f.page.getByRole("textbox", { name: "控件需求", exact: true }),
    ).toHaveValue("first requirement");
    await f.page.getByRole("button", { name: "返回控件草稿" }).click();
    await expect(f.page.locator(".widget-draft-row")).toHaveCount(1);
    await f.page.getByRole("button", { name: "搜索控件草稿" }).click();
    await f.page
      .getByRole("textbox", { name: "搜索草稿名称或需求" })
      .fill("missing");
    await expect(
      f.page.getByRole("heading", { name: "没有匹配的控件草稿" }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});
test("widget editor: confirmed input and identity survive navigation and restart without sending", async () => {
  const f = await fixture();
  try {
    await widgets(f.page);
    await newDraft(f.page);
    await f.page
      .getByRole("textbox", { name: "控件需求", exact: true })
      .fill("重启后仍保留，不自动发送");
    await saved(f.page);
    await f.page
      .getByRole("navigation", { name: "全局导航" })
      .getByRole("button", { name: "待处理", exact: true })
      .click();
    await widgets(f.page);
    await expect(
      f.page.getByRole("textbox", { name: "控件需求", exact: true }),
    ).toHaveValue("重启后仍保留，不自动发送");
    await f.restart();
    await widgets(f.page);
    await expect(
      f.page.getByRole("textbox", { name: "控件需求", exact: true }),
    ).toHaveValue("重启后仍保留，不自动发送");
    const reply = await f.page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.snapshot.widgetGeneration!.drafts).toHaveLength(1);
      expect(reply.snapshot.widgetGeneration!.tasks).toHaveLength(0);
    }
  } finally {
    await f.close();
  }
});
test("widget editor: rejected save keeps input and blocks leaving until explicit retry confirms it", async () => {
  const f = await fixture();
  try {
    await widgets(f.page);
    await newDraft(f.page);
    await f.page
      .getByRole("textbox", { name: "控件需求", exact: true })
      .fill("confirmed");
    await saved(f.page);
    // A real SQLite write failure propagates through the production service and IPC.
    const database = new DatabaseSync(join(f.root, "state.sqlite"));
    try {
      database.exec(
        "CREATE TRIGGER reject_widget_draft BEFORE UPDATE ON widget_drafts BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END",
      );
    } finally {
      database.close();
    }
    await f.page
      .getByRole("textbox", { name: "控件需求", exact: true })
      .fill("write rejected");
    await expect(
      f.page.getByRole("button", { name: "重试保存" }),
    ).toBeVisible();
    await f.page
      .getByRole("textbox", { name: "控件需求", exact: true })
      .fill("unconfirmed preserved");
    await f.page
      .getByRole("navigation", { name: "全局导航" })
      .getByRole("button", { name: "待处理", exact: true })
      .click();
    await expect(
      f.page.getByRole("textbox", { name: "控件需求", exact: true }),
    ).toHaveValue("unconfirmed preserved");
    const recovery = new DatabaseSync(join(f.root, "state.sqlite"));
    try {
      recovery.exec("DROP TRIGGER reject_widget_draft");
    } finally {
      recovery.close();
    }

    await f.page.getByRole("button", { name: "重试保存" }).click();
    await saved(f.page);
    const reply = await f.page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    if (!reply.ok) throw new Error(reply.message);
    expect(reply.snapshot.widgetGeneration!.drafts[0].input).toBe(
      "unconfirmed preserved",
    );
  } finally {
    await f.close();
  }
});
