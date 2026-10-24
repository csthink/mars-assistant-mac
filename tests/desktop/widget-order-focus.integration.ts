import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedRetainedWidgets } from "./widget-generation-fixture";
import { launchLocal, closeLocal } from "./local-client";
import { goTo, requestSize } from "./shell";

/*
 * mac-feature-t11:KB-05. On a real drop, Chromium's drag destination focuses the web contents under the pointer
 * before it hands the drop to that page (content/browser/web_contents/web_drag_dest_mac.mm), so a card dropped on
 * another card's native widget content left the window's first responder, and with it every key, on that widget
 * view. A protocol drop skips the native drag destination, so this test first gives the widget view the focus a
 * real drop gives it, then drops. Which view takes key events is read from AppKit (read-only): a background window
 * is never the key window, and its page focus is emulated, but its first responder is real.
 */
type View = {
  class: string;
  identity: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
const names = ["天气", "便笺", "计时", "日程", "汇率"];
const order = "application/x-qingluan-widget-order";

test("widget order focus: a reorder drop on a native widget view returns the key events to the host page and the DOM focus to the moved card; a widget's own drop keeps its focus", async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const dir = mkdtempSync(resolve(".test-data/disposable/widget-focus-"));
  const build = mkdtempSync(
    resolve(".test-data/disposable/widget-focus-probe-"),
  );
  const module = join(build, "widget-hit-probe.node");
  execFileSync("/usr/bin/clang++", [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-std=c++17",
    "-fobjc-arc",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-framework",
    "AppKit",
    "-I",
    resolve(dirname(process.execPath), "../include/node"),
    "tests/desktop/widget-hit-probe.mm",
    "-o",
    module,
  ]);
  const ids = seedRetainedWidgets(dir, names).map((w) => w.id);
  const stored = () => {
    const db = new DatabaseSync(join(dir, "state.sqlite"), { readOnly: true });
    try {
      return (
        db.prepare("SELECT id FROM saved_widgets ORDER BY position").all() as {
          id: string;
        }[]
      ).map((r) => r.id);
    } finally {
      db.close();
    }
  };
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${dir}`],
    cwd: resolve("."),
  });
  try {
    const shell = await app.firstWindow();
    await requestSize(app, shell, 1440, 900);
    await goTo(shell, "控件");
    const cards = shell.locator("[data-formal-widget]");
    await expect(cards).toHaveCount(5);
    const views = () =>
      app
        .context()
        .pages()
        .filter((p) => p.url().startsWith("csthink-widget:"));
    await expect.poll(() => views().length).toBe(5);
    await shell.getByRole("button", { name: "编辑布局", exact: true }).click();
    await expect(shell.locator(".widget-layout-note")).toBeVisible();
    const width = await shell.evaluate(() => innerWidth);
    const firstResponder = () =>
      app.evaluate(
        ({ BrowserWindow }, m) =>
          JSON.parse(
            process
              .getBuiltinModule("module")
              .createRequire(m)(m)
              .firstResponder(
                BrowserWindow.getAllWindows()[0].getNativeWindowHandle(),
              ),
          ) as View,
        module,
      );
    const isHost = (v: View) =>
      v.class === "RenderWidgetHostViewCocoa" && v.width === width;
    // What the native drop destination does first: the web contents under the pointer takes the focus.
    const focusView = (url: string) =>
      app.evaluate(({ webContents }, u) => {
        webContents
          .getAllWebContents()
          .find((c) => c.getURL() === u)!
          .focus();
      }, url);
    const trusted = async (
      view: Page,
      type: "dragEnter" | "dragOver" | "drop",
      x: number,
      mimeType = order,
    ) => {
      // The main process takes at most one relayed dragover every 16 ms, as a real drag repeats them.
      await shell.waitForTimeout(40);
      const cdp = await app.context().newCDPSession(view);
      await cdp.send("Input.dispatchDragEvent", {
        type,
        x,
        y: 40,
        data: {
          items: [{ mimeType, data: mimeType === order ? ids[4] : "text" }],
          dragOperationsMask: 16,
        },
      });
      await cdp.detach();
    };
    const target = views()[0];

    // 1. A drag that is not a reorder (text from elsewhere) dropped on a widget: the widget keeps the focus.
    await focusView(target.url());
    const widgetView = await firstResponder();
    expect(widgetView.class).toBe("RenderWidgetHostViewCocoa");
    expect(isHost(widgetView)).toBe(false);
    await trusted(target, "dragEnter", 10, "text/plain");
    await trusted(target, "dragOver", 12, "text/plain");
    await trusted(target, "drop", 12, "text/plain");
    await shell.waitForTimeout(300);
    expect((await firstResponder()).identity).toBe(widgetView.identity);
    expect(stored()).toEqual(ids);

    // 2. The person drags 汇率 by its grip across a native widget view and drops it on that view's left half.
    const moved = shell.locator(`[data-formal-widget="${ids[4]}"]`);
    const source = moved.locator(".widget-order-grip");
    const data = await shell.evaluateHandle(() => new DataTransfer());
    await source.dispatchEvent("dragstart", { dataTransfer: data });
    await trusted(target, "dragEnter", 10);
    await trusted(target, "dragOver", 12);
    const marked = shell.locator("[data-formal-widget].drop-before");
    await expect(marked).toHaveCount(1);
    const over = (await marked.getAttribute("data-formal-widget"))!;
    await focusView(target.url());
    expect((await firstResponder()).identity).toBe(widgetView.identity);
    await trusted(target, "drop", 12);
    // The source's dragend can come before the relayed drop.
    await source.dispatchEvent("dragend", { dataTransfer: data });
    const rest = ids.filter((id) => id !== ids[4]);
    rest.splice(rest.indexOf(over), 0, ids[4]);
    await expect.poll(stored).toEqual(rest);
    // Key events go to the host page again, and the moved card holds the DOM focus there.
    await expect.poll(async () => isHost(await firstResponder())).toBe(true);
    await expect(moved).toBeFocused();
    await expect(shell.locator(".widget-order-announce")).toHaveText(
      /「汇率」已移到第 \d 位/,
    );
    // The next Tab starts from the moved card: its first enabled control.
    await shell.keyboard.press("Tab");
    await expect(
      moved.locator(".widget-formal-controls button:not(:disabled)").first(),
    ).toBeFocused();
  } finally {
    await closeLocal(app);
    rmSync(dir, { recursive: true, force: true });
    rmSync(build, { recursive: true, force: true });
  }
});
