import {
  _electron,
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { seedRetainedWidgets } from "./widget-generation-fixture";
import { goTo, ready, requestSize } from "./shell";

/*
 * mac-feature-t11 V-15 (WB-02), scheduled foreground only: a real pointer drags a retained widget across the
 * native widget views, and real key presses move widgets with 前移 / 后移 in 编辑布局. Real input means macOS
 * HID events posted through Core Graphics, so the window server routes them as it routes a person's mouse and
 * keyboard, including over the native WebContentsView of each widget. Posting them needs the Accessibility
 * permission for the process that runs this test; the test only reads that permission and never asks for it.
 * The spoken result is checked through the accessibility tree and the live region text; VoiceOver itself is
 * not turned on. No model call, no settings change.
 */
const names = ["天气", "便笺", "计时", "日程", "汇率"];

/** Runs Core Graphics through JavaScript for Automation; returns its stdout. */
function jxa(source: string) {
  return execFileSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", source],
    {
      encoding: "utf8",
    },
  ).trim();
}
function accessibilityTrusted() {
  // Reads the permission only; AXIsProcessTrustedWithOptions with a prompt is never called.
  return (
    jxa(
      "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted() ? 'yes' : 'no'",
    ) === "yes"
  );
}
type Point = { x: number; y: number };
/** A pointer drag in global display points: press, move in steps, release. */
function drag(from: Point, to: Point, steps = 24) {
  const path = Array.from({ length: steps + 1 }, (_, i) => ({
    x: Math.round(from.x + ((to.x - from.x) * i) / steps),
    y: Math.round(from.y + ((to.y - from.y) * i) / steps),
  }));
  jxa(`ObjC.import('CoreGraphics'); ObjC.import('Foundation');
const post = (type, p) => { const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(p.x, p.y), 0); $.CGEventPost(0, e); };
const pause = (s) => $.NSThread.sleepForTimeInterval(s);
const path = ${JSON.stringify(path)};
post(5, path[0]); pause(0.2);
post(1, path[0]); pause(0.3);
for (const p of path.slice(1)) { post(6, p); pause(0.04); }
pause(0.3); post(2, path[path.length - 1]); pause(0.3); 'ok'`);
}
/** One key press with the given macOS virtual key code (49 space, 36 return). */
function press(keyCode: number) {
  jxa(`ObjC.import('CoreGraphics'); ObjC.import('Foundation');
$.CGEventPost(0, $.CGEventCreateKeyboardEvent(null, ${keyCode}, true));
$.NSThread.sleepForTimeInterval(0.05);
$.CGEventPost(0, $.CGEventCreateKeyboardEvent(null, ${keyCode}, false)); 'ok'`);
}
const stored = (data: string) => {
  const db = new DatabaseSync(join(data, "state.sqlite"), { readOnly: true });
  try {
    return (
      db.prepare("SELECT name FROM saved_widgets ORDER BY position").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
  } finally {
    db.close();
  }
};
/** The centre of an element in global display points (content bounds plus page coordinates). */
async function onScreen(
  app: ElectronApplication,
  page: Page,
  selector: string,
  at: { x: number; y: number } = { x: 0.5, y: 0.5 },
): Promise<Point> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  const content = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentBounds(),
  );
  return {
    x: content.x + box.x + box.width * at.x,
    y: content.y + box.y + box.height * at.y,
  };
}

test("native: a real pointer drags a widget across native widget views, real keys move it with 前移 / 后移, and focus and announcements follow", async ({}, info) => {
  if (
    process.env.CSTHINK_NATIVE_TESTS !== "1" ||
    process.env.CSTHINK_WIDGET_ORDER_NATIVE_AUTHORIZED !== "1"
  )
    throw new Error(
      "NOT RUN: scheduled widget order foreground authorization required",
    );
  if (!accessibilityTrusted())
    throw new Error(
      "NOT RUN: posting real input needs the Accessibility permission for the process running this test; the test does not request it",
    );
  test.setTimeout(300_000);
  mkdirSync(".test-data/disposable", { recursive: true });
  const data = mkdtempSync(resolve(".test-data/disposable/native-order-"));
  seedRetainedWidgets(data, names);
  const app = await _electron.launch({
    args: [resolve("."), `--data-root=${data}`],
  });
  try {
    const page = await app.firstWindow();
    await ready(page);
    // A secondary display that holds the standard content size, as in the other scheduled native tests.
    const display = await app.evaluate(({ BrowserWindow, screen, app }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const bounds = w.getBounds();
      const content = w.getContentBounds();
      const primary = screen.getPrimaryDisplay().id;
      const target = screen
        .getAllDisplays()
        .find(
          (d) =>
            d.id !== primary &&
            d.workArea.width >= 1440 + bounds.width - content.width &&
            d.workArea.height >= 900 + bounds.height - content.height,
        );
      if (!target)
        throw new Error(
          "No existing secondary display fits the required content size",
        );
      w.setPosition(target.workArea.x, target.workArea.y);
      app.focus({ steal: true });
      w.focus();
      return { id: target.id, workArea: target.workArea };
    });
    await info.attach("selected-display", {
      body: JSON.stringify(display),
      contentType: "application/json",
    });
    expect(await requestSize(app, page, 1440, 900)).toEqual([1440, 900]);
    await goTo(page, "控件");
    const cards = page.locator("[data-formal-widget]");
    await expect(cards).toHaveCount(5);
    // The widget views are native: their WebContentsViews are mounted above the host page.
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }) =>
            webContents
              .getAllWebContents()
              .filter((c) => c.getURL().startsWith("csthink-widget:")).length,
        ),
      )
      .toBeGreaterThanOrEqual(2);
    await page.getByRole("button", { name: "编辑布局", exact: true }).click();
    const focused = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getFocusedWindow()?.id ===
        BrowserWindow.getAllWindows()[0].id,
    );
    expect(focused, "the test window must be the key window").toBe(true);

    // 1. Real pointer: drag 汇率's grip across the other cards and drop it on the left half of 天气's widget
    //    content, which a native widget view covers.
    const from = await onScreen(
      app,
      page,
      `[data-formal-widget]:nth-child(5) .widget-order-grip`,
    );
    const to = await onScreen(app, page, `[data-formal-widget]:nth-child(1)`, {
      x: 0.2,
      y: 0.6,
    });
    drag(from, to);
    await expect
      .poll(() => stored(data), { timeout: 10_000 })
      .toEqual(["汇率", "天气", "便笺", "计时", "日程"]);
    const announce = page.locator(".widget-order-announce");
    await expect(announce).toHaveText("「汇率」已移到第 1 位");
    await expect(announce).toHaveAttribute("role", "status");

    // 2. Real keys: Space on the focused 后移 of 天气 moves it one place, and focus stays on that control.
    const later = page.getByRole("button", { name: /^后移 天气 / });
    await later.focus();
    press(49);
    await expect
      .poll(() => stored(data))
      .toEqual(["汇率", "便笺", "天气", "计时", "日程"]);
    await expect(later).toBeFocused();
    await expect(announce).toHaveText("「天气」已移到第 3 位");
    // Return on 前移 moves it back, and focus stays on 前移; the first card's 前移 is disabled.
    const earlier = page.getByRole("button", { name: /^前移 天气 / });
    await earlier.focus();
    press(36);
    await expect
      .poll(() => stored(data))
      .toEqual(["汇率", "天气", "便笺", "计时", "日程"]);
    await expect(earlier).toBeFocused();
    await expect(announce).toHaveText("「天气」已移到第 2 位");
    const firstEarlier = page.getByRole("button", { name: /^前移 汇率 / });
    await expect(firstEarlier).toBeDisabled();

    // 3. What assistive technology reads: the live region and the named move controls.
    const tree = await page.locator(".widget-studio").ariaSnapshot();
    await info.attach("aria-snapshot", {
      body: tree,
      contentType: "text/plain",
    });
    expect(tree).toContain("status: 「天气」已移到第 2 位");
    expect(tree).toMatch(/button "后移 天气 [0-9a-f]{8}"/);
    // Leaving 编辑布局 keeps the saved order.
    await page
      .getByRole("button", { name: "完成布局编辑", exact: true })
      .click();
    await expect(cards.first()).toHaveAttribute("aria-label", /^控件 汇率 /);
  } finally {
    await app.close();
  }
});
