import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { closeLocal, launchLocal } from "./local-client";

/** Launches with the given locale and checks every place the app shows its own name: 青鸾 whatever the locale. */
async function checkNames(lang: "en-US" | "zh-CN") {
  const name = "青鸾";
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/app-name-"));
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`, `--lang=${lang}`],
  });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle(name);
    // The sidebar heading carries the same name, and the rail shows the app icon as the product mark.
    await expect(page.locator("#main-sidebar .side-title")).toHaveText(name);
    const mark = page.locator(".rail .brand-mark");
    await expect(mark).toHaveAttribute("src", "brand-mark.svg");
    await expect
      .poll(() => mark.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    const shell = await app.evaluate(({ app, BrowserWindow, Menu }) => {
      const menu = Menu.getApplicationMenu()!.items[0];
      return {
        locale: app.getLocale(),
        internal: app.getName(),
        titles: BrowserWindow.getAllWindows().map((w) => w.getTitle()),
        menu: menu.label,
        items: menu.submenu!.items.map((item) => [item.role ?? "", item.label]),
        toolTip: (globalThis as unknown as { testTray: { toolTip: string } })
          .testTray.toolTip,
      };
    });
    expect(shell.locale.startsWith(lang.slice(0, 2))).toBe(true);
    // The internal name keeps the data directories and the keychain item where they were.
    expect(shell.internal).toBe("csthink-assistant");
    expect(shell.titles).toEqual([name]);
    expect(shell.menu).toBe(name);
    expect(shell.items).toEqual([
      ["about", `关于 ${name}`],
      ["", ""],
      ["", "打开主窗口"],
      ["", "打开工作台助手"],
      ["", ""],
      ["", `退出 ${name}`],
    ]);
    expect(shell.toolTip).toBe(name);
  } finally {
    await closeLocal(app);
  }
}

test("app name: with the en-US locale the main window, the page title, the sidebar, the menu bar icon, the application menu and the about panel still say 青鸾", async () => {
  await checkNames("en-US");
});

test("app name: with the zh-CN locale the main window, the page title, the sidebar, the menu bar icon, the application menu and the about panel say 青鸾", async () => {
  await checkNames("zh-CN");
});
