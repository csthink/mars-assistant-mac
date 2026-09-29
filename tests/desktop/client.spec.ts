import { closeLocal, launchLocal } from "./local-client";
import {
  closeRecent,
  goTo,
  openConversation,
  recent,
  sessionCount,
} from "./shell";
import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
let app: ElectronApplication;
let page: Page;
let dataRoot: string;
async function launch(root = dataRoot) {
  const application = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "false" },
  });
  const window = await application.firstWindow();
  await expect(
    window
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
  return { application, window };
}
async function clickAppMenu(label: string) {
  await app.evaluate(({ Menu }, target) => {
    const item = Menu.getApplicationMenu()?.items[0].submenu?.items.find(
      (item) => item.label === target,
    );
    if (!item) throw new Error("Missing menu item");
    item.click();
  }, label);
}
async function servicePID() {
  return app.evaluate(({ app }) => {
    const service = app
      .getAppMetrics()
      .find((metric) => metric.name === "csthink-assistant business");
    if (!service) throw new Error(JSON.stringify(app.getAppMetrics()));
    return service.pid;
  });
}
async function saved(window = page) {
  await expect(window.getByTestId("save-state")).toHaveText("草稿已保存");
}
async function newChat(window = page) {
  const count = await sessionCount(window);
  await window
    .getByRole("button", { name: /^新建(聊天|对话)$/ })
    .first()
    .click();
  await expect.poll(() => sessionCount(window)).toBe(count + 1);
  await expect(
    window.getByRole("textbox", { name: "输入草稿" }),
  ).toBeEditable();
}
test.beforeEach(async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  dataRoot = mkdtempSync(resolve(".test-data/disposable/client-"));
  const started = await launch();
  app = started.application;
  page = started.window;
});
test.afterEach(async () => {
  if (app) await app.close();
});
test("tray: production PNG has visible pixels and both native scale representations", async () => {
  const image = await app.evaluate(({ nativeImage, app }) => {
    const icon = nativeImage.createFromPath(
      `${app.getAppPath()}/dist/trayTemplate.png`,
    );
    return {
      empty: icon.isEmpty(),
      size: icon.getSize(),
      scales: icon.getScaleFactors(),
      template: icon.isTemplateImage(),
      pixels: [1, 2].map((scaleFactor) => {
        const bitmap = icon.toBitmap({ scaleFactor });
        const alpha = bitmap.filter((_, index) => index % 4 === 3);
        return {
          bytes: bitmap.length,
          visible: alpha.some((value) => value > 0),
          transparent: alpha.some((value) => value === 0),
        };
      }),
    };
  });
  expect(image.empty).toBe(false);
  expect(image.size).toEqual({ width: 20, height: 20 });
  expect(image.scales.sort()).toEqual([1, 2]);
  expect(image.template).toBe(true);
  expect(image.pixels).toEqual([
    { bytes: 20 * 20 * 4, visible: true, transparent: true },
    { bytes: 40 * 40 * 4, visible: true, transparent: true },
  ]);
});
test("navigation: minimum window, every page, keyboard, no external request or Node access", async () => {
  const external: string[] = [],
    errors: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("file:")) external.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
  );
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getContentSize(),
    ),
  ).toEqual([900, 680]);
  for (const title of ["项目", "控件", "待处理", "运行记录", "设置"] as const) {
    await goTo(page, title);
    await expect(
      page
        .locator(title === "设置" ? "dialog[open]" : ".center")
        .getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  for (const title of [
    "通用",
    "模型",
    "最近删除",
    "访问权限",
    "数据保留",
    "数据与隐私",
  ]) {
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: title, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
  }
  await goTo(page, "聊天");
  await newChat();
  const input = page.getByRole("textbox", { name: "输入草稿" });
  await input.fill("很长的中文草稿".repeat(90));
  await saved();
  // Four columns: the rail and the sidebar stay; the sidebar folds and expands by keyboard, and the
  // focus goes back to the control that expands it again.
  const rail = page.getByRole("navigation", { name: "全局导航" });
  await expect(rail).toBeVisible();
  const fold = page.getByRole("button", { name: "折叠侧栏" });
  await fold.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-sidebar")).toHaveCount(0);
  const expand = rail.getByRole("button", { name: "展开侧栏" });
  await expect(expand).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-sidebar")).toBeVisible();
  await expect(fold).toBeFocused();
  await page.screenshot({ path: "test-results/navigation-main.png" });
  expect(
    await page.evaluate(() => ({
      node: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
    })),
  ).toEqual({ node: "undefined", process: "undefined" });
  expect(
    await page.evaluate(async () => {
      try {
        await fetch("https://example.com");
        return "allowed";
      } catch {
        return "denied";
      }
    }),
  ).toBe("denied");
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
test("drafts: identical titles, independent identities, durable restart, save failure and recovery", async () => {
  await newChat();
  await page.getByRole("textbox", { name: "输入草稿" }).fill("甲：中文草稿");
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
    "甲：中文草稿",
  );
  await saved();
  const first = await (
    await recent(page)
  )
    .locator(".session")
    .first()
    .getAttribute("aria-label");
  await closeRecent(page);
  await newChat();
  await page.getByRole("textbox", { name: "输入草稿" }).fill("乙：独立草稿");
  await saved();
  const second = await (
    await recent(page)
  )
    .locator(".session")
    .first()
    .getAttribute("aria-label");
  expect(first).not.toEqual(second);
  await expect(page.locator(".session-name")).toHaveText(["新对话", "新对话"]);
  await openConversation(page, first!);
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
    "甲：中文草稿",
  );
  await closeLocal(app);
  const restart = await launch();
  app = restart.application;
  page = restart.window;
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
    "甲：中文草稿",
  );
  await openConversation(page, second!);
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
    "乙：独立草稿",
  );
  const pid = await servicePID();
  await app.evaluate((_electron, id) => process.kill(id, "SIGSTOP"), pid);
  await page
    .getByRole("textbox", { name: "输入草稿" })
    .fill("保存中断时必须保留的输入");
  await expect(
    page.getByText("保存确认超时。", { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
    "保存中断时必须保留的输入",
  );
  await expect(page.getByTestId("save-state")).toHaveText("尚未保存");
  await page.screenshot({ path: "test-results/drafts-failure.png" });
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect
    .poll(async () =>
      app.evaluate(
        ({ app }, id) =>
          app.getAppMetrics().some((metric) => metric.pid === id),
        pid,
      ),
    )
    .toBe(false);
  await expect(
    page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "用当前输入保存" }).click();
  await saved();
});
test("lifecycle: two surfaces, retired windows, composition, service loss, reconnect and original identity", async () => {
  await newChat();
  await page.getByRole("textbox", { name: "输入草稿" }).fill("共享同一对话");
  await saved();
  await goTo(page, "设置");
  const activationCalls = await app.evaluateHandle(({ app }) => {
    const calls: unknown[] = [];
    app.focus = (options) => {
      calls.push(options);
    };
    return calls;
  });
  const panelOpening = app.waitForEvent("window");
  await clickAppMenu("打开工作台助手");
  const panel = await panelOpening;
  await panel.waitForLoadState("domcontentloaded");
  if (process.platform === "darwin")
    await expect
      .poll(() => activationCalls.jsonValue())
      .toEqual([{ steal: true }]);
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "工作台助手")
        ?.isAlwaysOnTop(),
    ),
  ).toBe(true);
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "csthink-assistant")
        ?.isAlwaysOnTop(),
    ),
  ).toBe(false);
  await panel.getByRole("button", { name: "聊天", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
    "共享同一对话",
  );
  await panel.getByRole("textbox", { name: "输入草稿" }).fill("面板更新的中文");
  await saved(panel);
  await panel
    .getByRole("textbox", { name: "输入草稿" })
    .dispatchEvent("compositionstart", { data: "zhongwen" });
  await panel
    .getByRole("textbox", { name: "输入草稿" })
    .dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await panel
    .getByRole("textbox", { name: "输入草稿" })
    .dispatchEvent("compositionend", { data: "中文" });
  await expect(panel.getByRole("button", { name: "发送消息" })).toBeDisabled();
  await panel.screenshot({ path: "test-results/lifecycle-panel.png" });
  await panel.getByRole("button", { name: "在主窗口打开原对话" }).click();
  // Synthetic windows cannot take native focus; deliver the corresponding blur explicitly.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.getTitle() === "工作台助手")
      ?.emit("blur");
  });
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
    "面板更新的中文",
  );
  const initialId = await (
    await recent(page)
  )
    .locator(".session")
    .first()
    .getAttribute("aria-label");
  await closeRecent(page);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.getTitle() === "csthink-assistant")
      ?.close(),
  );
  await expect
    .poll(() => app.windows().filter((window) => !window.isClosed()).length)
    .toBe(0);
  const opening = app.waitForEvent("window");
  await clickAppMenu("打开主窗口");
  page = await opening;
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
    "面板更新的中文",
  );
  await expect(
    (await recent(page)).locator(".session").first(),
  ).toHaveAttribute("aria-label", initialId!);
  await closeRecent(page);
  const pid = await servicePID();
  await app.evaluate((_electron, id) => process.kill(id, "SIGKILL"), pid);
  await expect(
    page.getByText("业务服务已失联。", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "输入草稿" }),
  ).not.toBeEditable();
  await page.getByRole("button", { name: "重新连接" }).click();
  await expect(
    page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
    "面板更新的中文",
  );
});

test("lifecycle: application deactivation hides repeated panels and preserves unconfirmed retirement", async () => {
  await newChat();
  await page
    .getByRole("textbox", { name: "输入草稿" })
    .fill("失焦后仍保留的草稿");
  await saved();
  const mainId = await app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id,
  );
  for (let round = 0; round < 3; round++) {
    const opening = app.waitForEvent("window");
    await clickAppMenu("打开工作台助手");
    const panel = await opening;
    await panel.getByRole("button", { name: "聊天", exact: true }).click();
    await expect(panel.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
      "失焦后仍保留的草稿",
    );
    await saved(panel);
    const id = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "工作台助手",
        )!.id,
    );
    const markDirty = async (dirty: boolean) =>
      app.evaluate(
        ({ ipcMain, BrowserWindow }, args) => {
          const sender = BrowserWindow.fromId(args.id)!.webContents;
          ipcMain.emit(
            "window:dirty",
            { sender, senderFrame: sender.mainFrame },
            args.dirty,
          );
        },
        { id, dirty },
      );
    await markDirty(true);
    await app.evaluate(({ app }) => {
      app.emit("did-resign-active");
      app.emit("did-resign-active");
    });
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }, id) => ({
            exists: !!BrowserWindow.fromId(id),
            visible: BrowserWindow.fromId(id)?.isVisible(),
          }),
          id,
        ),
      )
      .toEqual({ exists: true, visible: false });
    await clickAppMenu("打开工作台助手");
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isVisible(),
          id,
        ),
      )
      .toBe(true);
    await markDirty(false);
    // A save confirmation for the reopened window must not destroy it.
    expect(
      await app.evaluate(
        ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isVisible(),
        id,
      ),
    ).toBe(true);
    await app.evaluate(({ app }) => app.emit("did-resign-active"));
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }, id) => !!BrowserWindow.fromId(id), id),
      )
      .toBe(false);
    expect(
      await app.evaluate(
        ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isVisible(),
        mainId,
      ),
    ).toBe(true);
  }
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
    "失焦后仍保留的草稿",
  );
});

test("lifecycle: outside clicks dismiss repeated panels without focus events and pause for file dialogs", async () => {
  await newChat();
  for (const outcome of ["cancel", "error", "cancel"]) {
    const opening = app.waitForEvent("window");
    await clickAppMenu("打开工作台助手");
    const panel = await opening;
    await panel.getByRole("button", { name: "聊天", exact: true }).click();
    await saved(panel);
    const state = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (w) => w.getTitle() === "工作台助手" && w.isVisible(),
        ),
      );
    await app.evaluate(({ app, BrowserWindow }) => {
      const panel = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === "工作台助手",
      )!;
      const bounds = panel.getBounds();
      app.emit("test-panel-outside-click", {
        x: bounds.x + 100,
        y: bounds.y + 100,
      });
    });
    expect(await state()).toBe(true);
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = () =>
        new Promise((resolve, reject) => {
          Object.assign(globalThis, {
            finishPanelDialog: (fail: boolean) =>
              fail
                ? reject(new Error("test dialog error"))
                : resolve({ canceled: true, filePaths: [] }),
          });
        });
    });
    await panel.evaluate(() => {
      void window.desktop
        .pickAttachments("00000000-0000-4000-8000-000000000001")
        .catch(() => {});
    });
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            typeof (globalThis as unknown as { finishPanelDialog?: unknown })
              .finishPanelDialog,
        ),
      )
      .toBe("function");
    await app.evaluate(({ app, BrowserWindow }) => {
      const panel = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === "工作台助手",
      )!;
      const bounds = panel.getBounds();
      app.emit("test-panel-outside-click", {
        x: bounds.x - 10,
        y: bounds.y + 100,
      });
      panel.emit("blur");
      app.emit("did-resign-active");
    });
    expect(await state()).toBe(true);
    await app.evaluate((_, fail) => {
      const context = globalThis as unknown as {
        finishPanelDialog?: (fail: boolean) => void;
      };
      context.finishPanelDialog!(fail);
      delete context.finishPanelDialog;
    }, outcome === "error");
    // Wait for the dialog finally block to re-arm outside-click observation.
    await expect
      .poll(() =>
        app.evaluate(() =>
          (
            globalThis as unknown as {
              panelMouseMonitor: { isActive(): boolean };
            }
          ).panelMouseMonitor.isActive(),
        ),
      )
      .toBe(true);
    await app.evaluate(({ app, BrowserWindow }) => {
      const panel = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === "工作台助手",
      )!;
      const bounds = panel.getBounds();
      app.emit("test-panel-outside-click", {
        x: bounds.x - 10,
        y: bounds.y + 100,
      });
    });
    await expect.poll(state).toBe(false);
  }
});

test("drafts: a concurrent confirmed update is not overwritten by local unconfirmed input", async () => {
  await newChat();
  await page.evaluate(async () => {
    const reply = await window.desktop.command({ type: "snapshot" });
    if (!reply.ok) throw new Error("No snapshot");
    const saved = reply.snapshot.conversations[0];
    const other = window.desktop.command({
      type: "saveDraft",
      id: saved.id,
      text: "另一入口的版本",
      revision: saved.revision,
    });
    const textarea = document.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, "当前入口的未确认输入");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await other;
  });
  await expect(
    page.getByText("另一入口已更新草稿。", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
    "当前入口的未确认输入",
  );
  await expect(page.getByText("本机已保存：另一入口的版本")).toBeVisible();
  await page.screenshot({ path: "test-results/drafts-conflict.png" });
  await page.getByRole("button", { name: "采用已保存版本" }).click();
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
    "另一入口的版本",
  );
});
test("lifecycle: host crash releases the supervised writer and recovers confirmed drafts", async () => {
  await newChat();
  await page
    .getByRole("textbox", { name: "输入草稿" })
    .fill("异常退出前已确认");
  await saved();
  const pid = await servicePID();
  app.process().kill("SIGKILL");
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15000 },
    )
    .toBe(false);
  const restart = await launch();
  app = restart.application;
  page = restart.window;
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
    "异常退出前已确认",
  );
});

test("drafts: pending new conversation freezes input and never writes into the old conversation", async () => {
  await newChat();
  const input = page.getByRole("textbox", { name: "输入草稿" });
  await input.fill("原对话必须保留");
  await expect(input).toHaveValue("原对话必须保留");
  await saved();
  const old = await (
    await recent(page)
  )
    .locator(".session")
    .first()
    .getAttribute("aria-label");
  await closeRecent(page);
  const pid = await servicePID();
  await app.evaluate((_electron, id) => process.kill(id, "SIGSTOP"), pid);
  try {
    await page
      .getByRole("button", { name: /^新建(聊天|对话)$/ })
      .first()
      .click();
    await expect(input).not.toBeEditable();
  } finally {
    await app.evaluate((_electron, id) => process.kill(id, "SIGCONT"), pid);
  }
  await expect.poll(() => sessionCount(page)).toBe(2);
  await expect(input).toBeEditable();
  await expect(input).toHaveValue("");
  await input.fill("新对话的输入");
  await saved();
  await openConversation(page, old!);
  await expect(input).toHaveValue("原对话必须保留");
});
