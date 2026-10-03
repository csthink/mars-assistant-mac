import {
  test,
  expect,
  type Page,
  type ElectronApplication,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedWidgetCandidate } from "./widget-generation-fixture";
import { launchLocal, closeLocal } from "./local-client";
async function ready(page: Page) {
  await expect(
    page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
}
async function fixture(seed?: (root: string) => void) {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/widget-editor-"));
  seed?.(root);
  let app: ElectronApplication | undefined = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
  });
  let page = await app.firstWindow();
  await ready(page);
  return {
    root,
    get app() {
      return app!;
    },
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

test("widget candidate: actual artifact preview, first retain and restart preserve one identity and editor history", async () => {
  const f = await fixture((root) => {
    seedWidgetCandidate(root);
  });
  try {
    await widgets(f.page);
    await expect(
      f.page.getByRole("button", { name: "保留控件", exact: true }),
    ).toBeEnabled();
    await expect
      .poll(
        () =>
          f.app
            .context()
            .pages()
            .filter((p) => p.url().startsWith("csthink-widget:")).length,
      )
      .toBe(1);
    const preview = f.app
      .context()
      .pages()
      .find((p) => p.url().startsWith("csthink-widget:"))!;
    await preview.getByRole("button", { name: "0", exact: true }).click();
    await expect(
      preview.getByRole("button", { name: "7", exact: true }),
    ).toBeVisible();
    await f.page.getByRole("button", { name: "查看实际差异" }).click();
    await expect(f.page.getByLabel("实际产物差异")).toContainText("新增");
    await f.page.getByRole("button", { name: "保留控件", exact: true }).click();
    await f.page.getByRole("button", { name: "确认保留", exact: true }).click();
    await expect(
      f.page.getByText("已保留到控件。编辑历史继续保存。"),
    ).toBeVisible();
    await expect(
      f.page.getByRole("textbox", { name: "控件需求", exact: true }),
    ).toBeVisible();
    let reply = await f.page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    if (!reply.ok) throw new Error(reply.message);
    const id = reply.snapshot.widgetGeneration!.widgets[0].id;
    await f.page.getByRole("button", { name: "返回控件草稿" }).click();
    await f.page.getByRole("button", { name: /^草稿 / }).click();
    await expect(
      f.page.getByRole("heading", { name: "还没有控件草稿" }),
    ).toBeVisible();
    await f.restart();
    reply = await f.page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    if (!reply.ok) throw new Error(reply.message);
    expect(reply.snapshot.widgetGeneration!.widgets).toHaveLength(1);
    expect(reply.snapshot.widgetGeneration!.widgets[0].id).toBe(id);
    expect(reply.snapshot.widgetGeneration!.tasks).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("widget candidate: rejected retain preserves candidate and explicit retry succeeds without duplicate widgets", async () => {
  const f = await fixture((root) => {
    seedWidgetCandidate(root);
  });
  try {
    await widgets(f.page);
    const database = new DatabaseSync(join(f.root, "state.sqlite"));
    try {
      database.exec(
        "CREATE TRIGGER reject_retain BEFORE INSERT ON saved_widgets BEGIN SELECT RAISE(ABORT,'synthetic retain failure'); END",
      );
    } finally {
      database.close();
    }
    await f.page.getByRole("button", { name: "保留控件", exact: true }).click();
    await f.page.getByRole("button", { name: "确认保留", exact: true }).click();
    await expect(
      f.page.getByRole("dialog", { name: "确认保留控件" }).getByRole("alert"),
    ).toBeVisible();
    let reply = await f.page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    if (!reply.ok) throw new Error(reply.message);
    expect(reply.snapshot.widgetGeneration!.widgets).toHaveLength(0);
    expect(reply.snapshot.widgetGeneration!.candidates[0].state).toBe(
      "preview",
    );
    const recovery = new DatabaseSync(join(f.root, "state.sqlite"));
    try {
      recovery.exec("DROP TRIGGER reject_retain");
    } finally {
      recovery.close();
    }
    await f.page.getByRole("button", { name: "确认保留", exact: true }).click();
    await expect(
      f.page.getByText("已保留到控件。编辑历史继续保存。"),
    ).toBeVisible();
    reply = await f.page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    if (!reply.ok) throw new Error(reply.message);
    expect(reply.snapshot.widgetGeneration!.widgets).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("widget candidate: discard preserves history and remaining input while unchanged artifacts offer no retain", async () => {
  const f = await fixture((root) => {
    seedWidgetCandidate(root);
  });
  try {
    await widgets(f.page);
    await f.page
      .getByRole("textbox", { name: "控件需求", exact: true })
      .fill("remaining unsubmitted idea");
    await saved(f.page);
    await f.page.getByRole("button", { name: "撤销预览", exact: true }).click();
    await f.page.getByRole("button", { name: "确认撤销", exact: true }).click();
    await expect(
      f.page.getByText("已撤销预览，编辑历史继续保存。"),
    ).toBeVisible();
    await expect(
      f.page.getByRole("textbox", { name: "控件需求", exact: true }),
    ).toHaveValue("remaining unsubmitted idea");
    await f.page.getByRole("button", { name: "返回控件草稿" }).click();
    await f.page.getByRole("button", { name: /^草稿 / }).click();
    await expect(f.page.locator(".widget-draft-row")).toHaveCount(1);
    const reply = await f.page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    if (!reply.ok) throw new Error(reply.message);
    expect(reply.snapshot.widgetGeneration!.widgets).toHaveLength(0);
    expect(reply.snapshot.widgetGeneration!.tasks).toHaveLength(1);
  } finally {
    await f.close();
  }
  const empty = await fixture((root) => {
    seedWidgetCandidate(root, true);
  });
  try {
    await widgets(empty.page);
    await expect(
      empty.page.getByText("没有实际变化，无需保留。"),
    ).toBeVisible();
    await expect(
      empty.page.getByRole("button", { name: "保留控件", exact: true }),
    ).toHaveCount(0);
  } finally {
    await empty.close();
  }
});

test("widget candidate: native owner hide and show recreate a fresh preview while occlusion and explicit close keep their meaning", async ({}, info) => {
  const f = await fixture(seedWidgetCandidate);
  const live = () =>
    f.app
      .context()
      .pages()
      .filter(
        (p) =>
          p.url().startsWith("csthink-widget:") &&
          p.url().endsWith("/index.html"),
      );
  const owner = (action: "hide" | "show" | "occlude") =>
    f.app.evaluate(({ BrowserWindow }, action) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith("index.html"),
      )!;
      if (action === "occlude") w.emit("hide");
      else w[action]();
      return { visible: w.isVisible() };
    }, action);
  try {
    await widgets(f.page);
    await expect.poll(() => live().length).toBe(1);
    const first = live()[0],
      firstURL = first.url();
    await first.getByRole("button", { name: "0", exact: true }).click();
    await expect(
      first.getByRole("button", { name: "7", exact: true }),
    ).toBeVisible();
    expect(await owner("occlude")).toEqual({ visible: true });
    await expect(
      first.getByRole("button", { name: "7", exact: true }),
    ).toBeVisible();
    expect(live().map((p) => p.url())).toEqual([firstURL]);
    expect(await owner("hide")).toEqual({ visible: false });
    await expect.poll(() => first.isClosed()).toBe(true);
    await expect.poll(() => live().length).toBe(0);
    await info.attach("hidden-owner-renderer-state", {
      body: JSON.stringify(
        await f.page.evaluate(() => ({
          hidden: document.hidden,
          state: document.visibilityState,
        })),
      ),
      contentType: "application/json",
    });
    expect(await owner("show")).toEqual({ visible: true });
    await expect.poll(() => live().length).toBe(1);
    expect(live()[0].url()).not.toBe(firstURL);
    await expect(
      live()[0].getByRole("button", { name: "0", exact: true }),
    ).toBeVisible();
    const second = live()[0],
      secondURL = second.url();
    const rapid = await f.app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith("index.html"),
      )!;
      // Wait only for native hide, then show in that event. Do not wait for a renderer frame.
      await new Promise<void>((resolve) => {
        const hidden = () => {
          if (w.isVisible()) return;
          w.removeListener("hide", hidden);
          w.show();
          resolve();
        };
        w.on("hide", hidden);
        w.hide();
      });
      return { visible: w.isVisible() };
    });
    expect(rapid).toEqual({ visible: true });
    await expect.poll(() => second.isClosed()).toBe(true);
    await expect.poll(() => live().length).toBe(1);
    expect(live()[0].url()).not.toBe(secondURL);
    await expect(
      live()[0].getByRole("button", { name: "0", exact: true }),
    ).toBeVisible();
    await f.page.getByRole("button", { name: "关闭预览", exact: true }).click();
    await expect.poll(() => live().length).toBe(0);
    await owner("hide");
    await owner("show");
    await expect(
      f.page.getByRole("button", { name: "重新打开预览", exact: true }),
    ).toBeVisible();
    expect(live()).toHaveLength(0);
  } finally {
    await f.close();
  }
});
