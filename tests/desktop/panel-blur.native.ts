import {
  _electron,
  test,
  expect,
  type ElectronApplication,
} from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";

test("native: Tray panel activates across applications and hides on external focus", async ({}, info) => {
  if (process.env.CSTHINK_NATIVE_TESTS !== "1")
    throw new Error("Native tests require the explicit native entry");
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/native-blur-"));
  mkdirSync(`${root}/product`);
  mkdirSync(`${root}/peer`);
  const executablePath = process.env.CSTHINK_NATIVE_EXECUTABLE;
  const product = await _electron.launch({
    executablePath,
    args: [
      ...(executablePath
        ? []
        : [resolve("tests/desktop/native-tray-main.cjs")]),
      `--data-root=${root}/product`,
    ],
  });
  const clickTray = async () =>
    product.evaluate(({ app, Menu, BrowserWindow }, packaged) => {
      if (!packaged) {
        app.emit("native-test-tray-click");
        return;
      }
      const panel = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === "工作台助手",
      );
      if (panel?.isVisible()) panel.close();
      else
        Menu.getApplicationMenu()!
          .items[0].submenu!.items.find(
            (item) => item.label === "打开工作台助手",
          )!
          .click();
    }, !!executablePath);
  let peer: ElectronApplication | undefined;
  try {
    const main = await product.firstWindow();
    await expect(
      main
        .locator(".home-header")
        .getByRole("button", { name: "新建对话", exact: true }),
    ).toBeEnabled();
    await product.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0].focus();
    });
    peer = await _electron.launch({
      args: [
        resolve("tests/desktop/native-focus-peer.cjs"),
        `--peer-root=${root}/peer`,
      ],
    });
    await (await product.firstWindow()).waitForLoadState("domcontentloaded");
    await (await peer!.firstWindow()).waitForLoadState("domcontentloaded");
    const focusPeer = async () => {
      await peer!.evaluate(({ app, BrowserWindow }) => {
        app.focus({ steal: true });
        BrowserWindow.getAllWindows()[0].focus();
      });
      await expect
        .poll(() => peer!.evaluate(({ app }) => app.isActive()))
        .toBe(true);
      await expect
        .poll(() => product.evaluate(({ app }) => app.isActive()))
        .toBe(false);
    };
    await product.evaluate(({ app }) => app.hide());
    await focusPeer();
    for (let round = 1; round <= 5; round++) {
      const opening = product.waitForEvent("window");
      await clickTray();
      const panel = await opening;
      await panel.waitForLoadState("domcontentloaded");
      const panelId = await product.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().find(
            (w) => w.getTitle() === "工作台助手",
          )!.id,
      );
      const state = () =>
        product.evaluate(
          ({ app, BrowserWindow }, id) => ({
            active: app.isActive(),
            visible: BrowserWindow.fromId(id)?.isVisible(),
            focused: BrowserWindow.fromId(id)?.isFocused(),
            top: BrowserWindow.fromId(id)?.isAlwaysOnTop(),
          }),
          panelId,
        );
      await expect
        .poll(state)
        .toEqual({ active: true, visible: true, focused: true, top: true });
      await info.attach(`round-${round}-open`, {
        body: JSON.stringify(await state()),
        contentType: "application/json",
      });
      // Missing window-blur notifications must not leave a panel visible after
      // the real macOS application has resigned active. Keep round 1 unmodified.
      if (round > 1)
        await product.evaluate(({ BrowserWindow }, id) => {
          BrowserWindow.fromId(id)!.removeAllListeners("blur");
        }, panelId);
      if (!executablePath)
        expect(
          await product.evaluate(() =>
            (
              globalThis as unknown as {
                panelMouseMonitor: { isActive(): boolean };
              }
            ).panelMouseMonitor.isActive(),
          ),
        ).toBe(true);
      await focusPeer();
      await expect
        .poll(() =>
          product.evaluate(
            ({ BrowserWindow }, id) =>
              BrowserWindow.fromId(id)?.isVisible() ?? false,
            panelId,
          ),
        )
        .toBe(false);
      if (!executablePath)
        expect(
          await product.evaluate(() =>
            (
              globalThis as unknown as {
                panelMouseMonitor: { isActive(): boolean };
              }
            ).panelMouseMonitor.isActive(),
          ),
        ).toBe(false);
      await info.attach(`round-${round}-external-focus`, {
        body: JSON.stringify(await state()),
        contentType: "application/json",
      });
    }
    const reopening = product.waitForEvent("window");
    await clickTray();
    await (await reopening).waitForLoadState("domcontentloaded");
    await expect
      .poll(() =>
        product.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some(
            (w) => w.getTitle() === "工作台助手" && w.isFocused(),
          ),
        ),
      )
      .toBe(true);
    await clickTray();
    await expect
      .poll(() =>
        product.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some(
            (w) => w.getTitle() === "工作台助手" && w.isVisible(),
          ),
        ),
      )
      .toBe(false);
  } finally {
    await info.attach("final-window-state", {
      body: JSON.stringify(
        await product.evaluate(({ app, BrowserWindow }) => ({
          active: app.isActive(),
          windows: BrowserWindow.getAllWindows().map((w) => ({
            id: w.id,
            visible: w.isVisible(),
            focused: w.isFocused(),
            title: w.getTitle(),
          })),
          events: (globalThis as unknown as { nativeFocusEvents?: unknown })
            .nativeFocusEvents,
        })),
      ),
      contentType: "application/json",
    });
    await peer?.close();
    await product.evaluate(({ app, BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        window.removeAllListeners("close");
      app.removeAllListeners("before-quit");
      app.removeAllListeners("activate");
    });
    await product.close();
  }
});
