import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { launchLocal } from "./local-client";
import { goTo as goToShell } from "./shell";
async function goTo(page: Page, name: Parameters<typeof goToShell>[1]) {
  await goToShell(page, name);
}
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
function root() {
  mkdirSync(".test-data/disposable", { recursive: true });
  return mkdtempSync(resolve(".test-data/disposable/widget-ui-"));
}
async function view(client: ElectronApplication) {
  await expect
    .poll(
      () =>
        client
          .context()
          .pages()
          .filter(
            (page) =>
              page.url().startsWith("csthink-widget:") &&
              page.url().endsWith("/index.html"),
          ).length,
    )
    .toBe(1);
  return client
    .context()
    .pages()
    .find(
      (page) =>
        page.url().startsWith("csthink-widget:") &&
        page.url().endsWith("/index.html"),
    )!;
}

test("widget client: acceptance gate, real preview config and durable data through the business service", async () => {
  const dataRoot = root();
  let client = await launchLocal({
    args: [resolve("."), `--data-root=${dataRoot}`],
  });
  try {
    const page = await client.firstWindow();
    await goTo(page, "控件");
    await expect(
      page.getByRole("button", { name: "载入测试候选" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        window.desktop.widgetControl({ action: "open" }),
      ),
    ).toEqual({ ok: true, enabled: false });
  } finally {
    await client.close();
  }
  client = await launchLocal({
    args: [resolve("."), `--data-root=${dataRoot}`, "--widget-acceptance"],
  });
  try {
    const page = await client.firstWindow();
    await goTo(page, "控件");
    await page.getByRole("button", { name: "载入测试候选" }).click();
    let widget = await view(client);
    await expect(
      widget.getByRole("heading", { name: "今天想记住的事" }),
    ).toBeVisible();
    await expect(
      page.getByText("本地验收内容，尚未接入模型生成。"),
    ).toBeVisible();
    await widget.getByLabel("随手记").fill("已确认的中文便笺");
    await expect(widget.getByRole("status")).toHaveText("草稿已确认保存");
    await expect(page.locator(".widget-save-status")).toHaveText(
      "本次写入已确认保存",
    );
    await widget.getByRole("button", { name: "记录一次" }).click();
    await expect(widget.getByText("已记录 1 次")).toBeVisible();
    await page
      .locator(".widget-actions")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await expect
      .poll(
        () =>
          client
            .context()
            .pages()
            .filter((page) => page.url().startsWith("csthink-widget:")).length,
      )
      .toBe(0);
    await page.getByLabel("便笺标题").fill("更新后的标题");
    await page.getByLabel("显示记录次数").uncheck();
    await page.screenshot({
      path: test.info().outputPath("trusted-settings.png"),
    });
    await page.getByRole("button", { name: "保存设置" }).click();
    widget = await view(client);
    await expect(
      widget.getByRole("heading", { name: "更新后的标题" }),
    ).toBeVisible();
    await expect(widget.getByLabel("随手记")).toHaveValue("已确认的中文便笺");
    await expect(widget.getByText("已记录 1 次")).toBeHidden();
    await page.locator(".widget-heading h2").click();
    expect(widget.isClosed()).toBe(false);
    await page.screenshot({
      path: test.info().outputPath("trusted-preview.png"),
    });
    await widget.screenshot({
      path: test.info().outputPath("widget-preview.png"),
    });
    const reply = await page.evaluate(() =>
      window.desktop.widgetControl({ action: "status" }),
    );
    expect(reply.ok && reply.preview?.config.title).toBe("更新后的标题");
  } finally {
    await client.close();
  }
});

test("widget client: trusted search occludes native view and crash leaves usable recovery controls", async () => {
  const client = await launchLocal({
    args: [resolve("."), `--data-root=${root()}`, "--widget-acceptance"],
  });
  try {
    const page = await client.firstWindow();
    await goTo(page, "控件");
    await page.getByRole("button", { name: "载入测试候选" }).click();
    await view(client);
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "搜索", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect
      .poll(
        () =>
          client
            .context()
            .pages()
            .filter((page) => page.url().startsWith("csthink-widget:")).length,
      )
      .toBe(0);
    await page.screenshot({
      path: test.info().outputPath("trusted-search.png"),
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The rebuilt view exists before its resources finish loading; crashing it mid-load reports a
    // load failure instead of the crash (KB-225), so wait for the widget content first.
    await expect((await view(client)).getByLabel("随手记")).toBeVisible();
    await client.evaluate(({ webContents }) => {
      const view = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith("csthink-widget:"));
      if (!view) throw new Error("Missing live widget");
      view.forcefullyCrashRenderer();
    });
    await expect(page.locator(".widget-save-status")).toContainText(
      "控件运行中断",
    );
    await page.getByRole("button", { name: "重新打开预览" }).click();
    const widget = await view(client);
    await expect(widget.getByLabel("随手记")).toBeVisible();
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    await expect
      .poll(
        () =>
          client
            .context()
            .pages()
            .filter((page) => page.url().startsWith("csthink-widget:")).length,
      )
      .toBe(0);
  } finally {
    await client.close();
  }
});

test("widget client: unapplied settings drafts and confirmed widget draft survive navigation and restart", async () => {
  const dataRoot = root();
  let client = await launchLocal({
    args: [resolve("."), `--data-root=${dataRoot}`, "--widget-acceptance"],
  });
  try {
    const page = await client.firstWindow();
    await goTo(page, "控件");
    await page.getByRole("button", { name: "载入测试候选" }).click();
    const widget = await view(client);
    await widget.getByLabel("随手记").fill("重启后恢复的草稿");
    await expect(widget.getByRole("status")).toHaveText("草稿已确认保存");
    await page
      .locator(".widget-actions")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await page.getByLabel("文字大小").fill("无效字号");
    await expect(page.locator(".widget-save-status")).toHaveText(
      "设置草稿已确认保存，尚未应用到控件。",
    );
    await page.getByRole("button", { name: "保存设置" }).click();
    await expect(page.locator(".widget-save-status")).toContainText(
      "配置格式无效",
    );
    await expect(page.getByLabel("文字大小")).toHaveValue("无效字号");
    await goTo(page, "聊天");
    await expect
      .poll(
        () =>
          client
            .context()
            .pages()
            .filter((page) => page.url().startsWith("csthink-widget:")).length,
      )
      .toBe(0);
  } finally {
    await client.close();
  }
  client = await launchLocal({
    args: [resolve("."), `--data-root=${dataRoot}`, "--widget-acceptance"],
  });
  try {
    const page = await client.firstWindow();
    await goTo(page, "控件");
    await page.getByRole("button", { name: "载入测试候选" }).click();
    let widget = await view(client);
    await expect(widget.getByLabel("随手记")).toHaveValue("重启后恢复的草稿");
    await expect(widget.getByLabel("随手记")).toHaveCSS("font-size", "14px");
    await page
      .locator(".widget-actions")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await expect(page.getByLabel("文字大小")).toHaveValue("无效字号");
    await page.getByLabel("文字大小").fill("18");
    await page.getByRole("button", { name: "保存设置" }).click();
    widget = await view(client);
    await expect(widget.getByLabel("随手记")).toHaveCSS("font-size", "18px");
    await expect(widget.getByLabel("随手记")).toHaveValue("重启后恢复的草稿");
  } finally {
    await client.close();
  }
});

async function entryView(client: ElectronApplication, shell: Page) {
  await expect
    .poll(async () => {
      const reply = await shell.evaluate(() =>
        window.desktop.widgetControl({ action: "status" }),
      );
      return reply.ok && !!reply.generation;
    })
    .toBe(true);
  const reply = await shell.evaluate(() =>
    window.desktop.widgetControl({ action: "status" }),
  );
  if (!reply.ok || !reply.generation)
    throw new Error("Missing entry generation");
  const url = `csthink-widget://${reply.generation}/index.html`;
  await expect
    .poll(() =>
      client
        .context()
        .pages()
        .some((page) => page.url() === url),
    )
    .toBe(true);
  return client
    .context()
    .pages()
    .find((page) => page.url() === url)!;
}
async function panelWindow(client: ElectronApplication) {
  const ready = client.waitForEvent("window");
  await client.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!
      .items[0].submenu!.items.find((item) => item.label === "打开工作台助手")!
      .click(),
  );
  return ready;
}
test("widget client: two entries reject stale drafts without losing input and panel close rebuilds the confirmed draft", async () => {
  const client = await launchLocal({
    args: [resolve("."), `--data-root=${root()}`, "--widget-acceptance"],
  });
  try {
    const main = await client.firstWindow();
    await goTo(main, "控件");
    await main.getByRole("button", { name: "载入测试候选" }).click();
    const first = await view(client);
    let panel = await panelWindow(client);
    await panel.getByRole("button", { name: "工作台", exact: true }).click();
    await panel.getByRole("button", { name: "载入测试候选" }).click();
    let second = await entryView(client, panel);
    await expect(second.getByRole("status")).toHaveText("已读取上次确认的内容");
    await first.getByLabel("随手记").fill("主窗口已确认版本");
    await expect(first.getByRole("status")).toHaveText("草稿已确认保存");
    await second.getByLabel("随手记").fill("面板旧版本输入必须保留");
    await expect(second.getByRole("status")).toContainText(
      "当前输入未确认保存",
    );
    await expect(second.getByLabel("随手记")).toHaveValue(
      "面板旧版本输入必须保留",
    );
    await expect(panel.locator(".widget-save-status")).toContainText(
      "草稿已在另一入口改变",
    );
    const failedURL = second.url();
    const closing = await client.browserWindow(panel);
    await closing.evaluate((window) => window.close());
    await expect.poll(() => second.isClosed()).toBe(true);
    panel = await panelWindow(client);
    await panel.getByRole("button", { name: "工作台", exact: true }).click();
    await panel.getByRole("button", { name: "载入测试候选" }).click();
    second = await entryView(client, panel);
    expect(second.url()).not.toBe(failedURL);
    await expect(second.getByLabel("随手记")).toHaveValue(
      "面板旧版本输入必须保留",
    );
    await expect(second.getByRole("status")).toContainText("已恢复未确认输入");
    await panel.getByRole("button", { name: "放弃未确认输入并重读" }).click();
    second = await entryView(client, panel);
    await expect(second.getByLabel("随手记")).toHaveValue("主窗口已确认版本");
    await second.getByLabel("随手记").fill("面板重读后的确认版本");
    await expect(second.getByRole("status")).toHaveText("草稿已确认保存");
    await panel.screenshot({
      path: test.info().outputPath("trusted-panel.png"),
    });
    await second.screenshot({
      path: test.info().outputPath("panel-widget.png"),
    });
    const oldURL = second.url();
    const nativePanel = await client.browserWindow(panel);
    await nativePanel.evaluate((window) => window.close());
    await expect.poll(() => second.isClosed()).toBe(true);
    const reopened = await panelWindow(client);
    await reopened.getByRole("button", { name: "工作台", exact: true }).click();
    await reopened.getByRole("button", { name: "载入测试候选" }).click();
    const restored = await entryView(client, reopened);
    expect(restored.url()).not.toBe(oldURL);
    await expect(restored.getByLabel("随手记")).toHaveValue(
      "面板重读后的确认版本",
    );
  } finally {
    await client.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    await client.close();
  }
});

test("widget client: leaving the viewport destroys the instance and returning restores confirmed content", async () => {
  const client = await launchLocal({
    args: [resolve("."), `--data-root=${root()}`, "--widget-acceptance"],
  });
  try {
    const page = await client.firstWindow();
    await goTo(page, "控件");
    await page.getByRole("button", { name: "载入测试候选" }).click();
    const old = await view(client);
    await old.getByLabel("随手记").fill("离开可见区域前已保存");
    await expect(old.getByRole("status")).toHaveText("草稿已确认保存");
    // App-owned layout fixture creates enough document height for a real scroll.
    await page.locator(".widget-shell").evaluate((element) => {
      const spacer = document.createElement("div");
      spacer.id = "test-scroll-space";
      spacer.style.height = "1500px";
      element.after(spacer);
    });
    await page
      .locator(".viewport")
      .evaluate((element) => element.scrollTo(0, 1200));
    await expect.poll(() => old.isClosed()).toBe(true);
    await page
      .locator(".viewport")
      .evaluate((element) => element.scrollTo(0, 0));
    const restored = await view(client);
    expect(restored.url()).not.toBe(old.url());
    await expect(restored.getByLabel("随手记")).toHaveValue(
      "离开可见区域前已保存",
    );
  } finally {
    await client.close();
  }
});
