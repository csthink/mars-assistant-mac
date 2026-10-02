import { _electron, test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { closeLocal, launchLocal } from "./local-client";
import { displayName } from "../../src/shared/app-name";

test("background: failed isolation closes only its own launched application", async () => {
  const original = _electron.launch;
  const calls: string[] = [];
  _electron.launch = async () =>
    ({
      evaluate: async () => {
        throw new Error("synthetic isolation failure");
      },
      close: async () => {
        calls.push("close");
      },
      process: () => ({
        exitCode: null,
        signalCode: null,
        kill: (signal: string) => {
          calls.push(signal);
        },
      }),
    }) as never;
  try {
    await expect(launchLocal({ args: [resolve(".")] })).rejects.toThrow(
      "synthetic isolation failure",
    );
    expect(calls).toEqual(["close", "SIGKILL"]);
  } finally {
    _electron.launch = original;
  }
});

test("background: initial and subsequent windows stay isolated while input, screenshots and persistence work", async ({}, info) => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/background-"));
  const options = { args: [resolve("."), `--data-root=${root}`] };
  let app = await launchLocal(options);
  try {
    const page = await app.firstWindow();
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "输入草稿" }),
    ).toBeEditable();
    await page
      .getByRole("textbox", { name: "输入草稿" })
      .fill("后台输入仍然保存");
    await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
    const opening = app.waitForEvent("window");
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()
        ?.items[0].submenu?.items.find(
          (item) => item.label === "打开工作台助手",
        )
        ?.click();
    });
    const panel = await opening;
    await panel.getByRole("button", { name: "聊天", exact: true }).click();
    await expect(panel.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
      "后台输入仍然保存",
    );
    await app.evaluate(({ app }) => app.focus({ steal: true }));
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => {
        window.show();
        window.focus();
        return {
          focusable: window.isFocusable(),
          focused: window.isFocused(),
          opacity: window.getOpacity(),
          throttling: window.webContents.getBackgroundThrottling(),
        };
      }),
    );
    expect(windows).toHaveLength(2);
    for (const window of windows)
      expect(window).toEqual({
        focusable: false,
        focused: false,
        opacity: 0,
        throttling: false,
      });
    const png = await page.screenshot({
      path: info.outputPath("background-page.png"),
    });
    expect(png.byteLength).toBeGreaterThan(10000);
    const pixels = await app.evaluate(({ nativeImage }, bytes) => {
      const bitmap = nativeImage
        .createFromBuffer(Buffer.from(bytes))
        .toBitmap();
      return { size: bitmap.length, distinct: new Set(bitmap).size };
    }, Array.from(png));
    expect(pixels.size).toBeGreaterThan(100000);
    expect(pixels.distinct).toBeGreaterThan(32);
    await closeLocal(app);
    app = await launchLocal(options);
    await expect(
      (await app.firstWindow()).getByRole("textbox", { name: "输入草稿" }),
    ).toHaveValue("后台输入仍然保存");
  } finally {
    await app.close();
  }
});

test("background: clipboard is process-local and unexpected native dialogs are refused", async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/clipboard-"));
  const options = { args: [resolve("."), `--data-root=${root}`] };
  let app = await launchLocal(options);
  try {
    await app.evaluate(({ clipboard }) =>
      clipboard.writeText("测试专属剪贴板"),
    );
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      "测试专属剪贴板",
    );
    await expect(
      app.evaluate(({ dialog }) => dialog.showOpenDialog({})),
    ).rejects.toThrow("Unexpected native dialog");
    await closeLocal(app);
    app = await launchLocal(options);
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      "",
    );
  } finally {
    await app.close();
  }
});

test("background: the menu bar icon is an in-process stand-in: no system status item, a test click opens and closes the panel, the context menu is recorded", async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/menu-bar-icon-"));
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
  });
  type Record = {
    created: number;
    realTrayUsed: boolean;
    toolTip: string | null;
    imageEmpty: boolean;
    menus: string[][];
  };
  const record = () =>
    app.evaluate(() => {
      const { created, realTrayUsed, toolTip, imageEmpty, menus } = (
        globalThis as unknown as { testTray: Record }
      ).testTray;
      return { created, realTrayUsed, toolTip, imageEmpty, menus };
    });
  const panelVisible = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(
        (w) => w.getTitle() === "工作台助手" && w.isVisible(),
      ),
    );
  try {
    await expect(
      (await app.firstWindow())
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    // The production code made exactly one icon, with its image and tooltip, and never a real one.
    const name = displayName;
    expect(await record()).toEqual({
      created: 1,
      realTrayUsed: false,
      toolTip: name,
      imageEmpty: false,
      menus: [],
    });
    const opening = app.waitForEvent("window");
    await app.evaluate(({ app }) => app.emit("test-tray-click"));
    await opening;
    await expect.poll(panelVisible).toBe(true);
    await app.evaluate(({ app }) => app.emit("test-tray-click"));
    await expect.poll(panelVisible).toBe(false);
    await app.evaluate(({ app }) => app.emit("test-tray-right-click"));
    expect((await record()).menus).toEqual([["打开主窗口", `退出 ${name}`]]);
    // The recorded menu still acts: with the main window closed, its first item opens a new one.
    const mainVisible = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (w) => w.getTitle() !== "工作台助手" && w.isVisible(),
        ),
      );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() !== "工作台助手")
        ?.close(),
    );
    await expect.poll(mainVisible).toBe(false);
    const reopening = app.waitForEvent("window");
    await app.evaluate(({ app }) => app.emit("test-tray-menu", "打开主窗口"));
    await reopening;
    await expect.poll(mainVisible).toBe(true);
    expect((await record()).realTrayUsed).toBe(false);
  } finally {
    await closeLocal(app);
  }
});
