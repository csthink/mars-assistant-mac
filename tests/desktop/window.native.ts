import { _electron, test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";

// Explicitly scheduled OS integration. Never included in desktop/integration regression.
test("native: production window activation and focus transfer", async ({}, info) => {
  if (process.env.CSTHINK_NATIVE_TESTS !== "1")
    throw new Error(
      "Native desktop tests require the explicit npm run test:native entry",
    );
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/native-window-"));
  const app = await _electron.launch({
    args: [resolve("."), `--data-root=${root}`],
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator(".home-header")
        .getByRole("button", { name: "新建对话", exact: true }),
    ).toBeEnabled();
    const mainId = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id,
    );
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isFocused(),
          mainId,
        ),
      )
      .toBe(true);
    const otherOpening = app.waitForEvent("window");
    await app.evaluate(({ BrowserWindow }, id) => {
      const main = BrowserWindow.fromId(id)!;
      const other = new BrowserWindow({ width: 320, height: 240 });
      void other.loadURL("data:text/html,<title>Native focus target</title>");
      other.show();
      other.focus();
      main.once("focus", () => other.destroy());
    }, mainId);
    await otherOpening;
    await info.attach("window-identities-after-transfer", {
      body: JSON.stringify(
        await app.evaluate(
          ({ BrowserWindow }, id) => ({
            mainId: id,
            windows: BrowserWindow.getAllWindows().map((w) => ({
              id: w.id,
              focused: w.isFocused(),
            })),
          }),
          mainId,
        ),
      ),
      contentType: "application/json",
    });
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isFocused(),
          mainId,
        ),
      )
      .toBe(false);
    await app.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.focus(),
      mainId,
    );
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isFocused(),
          mainId,
        ),
      )
      .toBe(true);
    const panelOpening = app.waitForEvent("window");
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()!
        .items[0].submenu!.items.find(
          (item) => item.label === "打开工作台助手",
        )!
        .click();
    });
    const panel = await panelOpening;
    await panel.waitForLoadState("domcontentloaded");
    const panelId = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "工作台助手",
        )!.id,
    );
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }, id) => ({
            visible: BrowserWindow.fromId(id)?.isVisible(),
            focused: BrowserWindow.fromId(id)?.isFocused(),
            top: BrowserWindow.fromId(id)?.isAlwaysOnTop(),
          }),
          panelId,
        ),
      )
      .toEqual({ visible: true, focused: true, top: true });
    expect(
      await app.evaluate(
        ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isAlwaysOnTop(),
        mainId,
      ),
    ).toBe(false);
    await panel.screenshot({
      path: info.outputPath("panel-above-normal-windows.png"),
    });
    await app.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.focus(),
      mainId,
    );
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }, id) =>
            BrowserWindow.fromId(id)?.isVisible() ?? false,
          panelId,
        ),
      )
      .toBe(false);
  } finally {
    await app.close();
  }
});
