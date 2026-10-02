import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { closeLocal, launchLocal } from "./local-client";

for (const [lang, name] of [
  ["en-US", "Qingluan"],
  ["zh-CN", "青鸾"],
] as const) {
  test(`app name: with the ${lang} locale the main window, the page title, the menu bar icon, the application menu and the about panel all say ${name}`, async () => {
    mkdirSync(".test-data/disposable", { recursive: true });
    const root = mkdtempSync(resolve(".test-data/disposable/app-name-"));
    const app = await launchLocal({
      args: [resolve("."), `--data-root=${root}`, `--lang=${lang}`],
    });
    try {
      const page = await app.firstWindow();
      await expect(page).toHaveTitle(name);
      const shell = await app.evaluate(({ app, BrowserWindow, Menu }) => {
        const menu = Menu.getApplicationMenu()!.items[0];
        return {
          locale: app.getLocale(),
          internal: app.getName(),
          titles: BrowserWindow.getAllWindows().map((w) => w.getTitle()),
          menu: menu.label,
          items: menu.submenu!.items.map((item) => [
            item.role ?? "",
            item.label,
          ]),
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
  });
}
