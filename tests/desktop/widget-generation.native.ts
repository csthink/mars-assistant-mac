import {
  _electron,
  test,
  expect,
  type ElectronApplication,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { goTo, ready, requestSize } from "./shell";
import { seedWidgetCandidate } from "./widget-generation-fixture";

// Foreground only, scheduled explicitly. The artifact is offline; provider validation is separate.
test("native: widget draft failure, real candidate focus and retained identity survive hiding and restart", async ({}, info) => {
  if (process.env.CSTHINK_NATIVE_TESTS !== "1")
    throw new Error("A scheduled foreground window is required");
  test.setTimeout(180_000);
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/native-generation-"));
  seedWidgetCandidate(root);
  let client: ElectronApplication | undefined;
  const launch = async () => {
    client = await _electron.launch({
      args: [resolve("."), `--data-root=${root}`],
    });
    const page = await client.firstWindow();
    await ready(page);
    return page;
  };
  try {
    let page = await launch();
    const size = await requestSize(client!, page, 1440, 900);
    await info.attach("requested-and-actual-content-size", {
      body: JSON.stringify({ requested: [1440, 900], actual: size }),
      contentType: "application/json",
    });
    expect(size).toEqual([1440, 900]);
    await goTo(page, "控件");
    const live = () =>
      client!
        .context()
        .pages()
        .filter((p) => p.url().startsWith("csthink-widget:"));
    await expect.poll(() => live().length).toBe(1);
    await live()[0].getByRole("button", { name: "0", exact: true }).click();
    await expect(
      live()[0].getByRole("button", { name: "7", exact: true }),
    ).toBeVisible();
    const focused = await client!.evaluate(({ webContents }) =>
      webContents.getFocusedWebContents()?.getURL(),
    );
    expect(focused).toBe(live()[0].url());
    await client!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("index.html"))!
        .hide(),
    );
    await expect.poll(() => live().length).toBe(0);
    await client!.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith("index.html"),
      )!;
      w.show();
      w.focus();
    });
    await expect.poll(() => live().length).toBe(1);
    const db = new DatabaseSync(join(root, "state.sqlite"));
    try {
      db.exec(
        "CREATE TRIGGER native_reject_draft BEFORE UPDATE ON widget_drafts BEGIN SELECT RAISE(ABORT,'synthetic write rejection'); END",
      );
    } finally {
      db.close();
    }
    await page
      .getByRole("textbox", { name: "控件需求", exact: true })
      .fill("原生未确认输入");
    await expect(page.getByRole("button", { name: "重试保存" })).toBeVisible();
    await goTo(page, "待处理");
    await expect(
      page.getByRole("textbox", { name: "控件需求", exact: true }),
    ).toHaveValue("原生未确认输入");
    const recovery = new DatabaseSync(join(root, "state.sqlite"));
    try {
      recovery.exec("DROP TRIGGER native_reject_draft");
    } finally {
      recovery.close();
    }
    await page.getByRole("button", { name: "重试保存" }).click();
    await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "保留控件", exact: true }).click();
    await page.getByRole("button", { name: "确认保留", exact: true }).click();
    await expect(
      page.getByText("已保留到控件。编辑历史继续保存。"),
    ).toBeVisible();
    const previous = client;
    client = undefined;
    await previous!.close();
    page = await launch();
    await goTo(page, "控件");
    await expect(
      page.getByRole("textbox", { name: "控件需求", exact: true }),
    ).toHaveValue("原生未确认输入");
    await expect(
      page.getByText("已保留到控件。编辑历史继续保存。"),
    ).toBeVisible();
    const reply = await page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    if (!reply.ok) throw new Error(reply.message);
    expect(reply.snapshot.widgetGeneration!.widgets).toHaveLength(1);
    await info.attach("retained-widget-native", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    const current = client;
    client = undefined;
    try {
      if (current) await current.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
