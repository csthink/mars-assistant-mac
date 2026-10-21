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
 * mac-feature-t11 V-15 drag diagnostic, scheduled foreground only. It repeats the V-15 pointer drag (drop on
 * a widget's content, which a native widget view covers) and adds a control drag that drops on the card's
 * title row, which the host page draws. It records the drag and pointer events that the host page and every
 * widget view page receive, with coordinates, and the saved order after each drag. It asserts nothing about
 * the outcome: its result is the event record. Real input is posted through Core Graphics, as in V-15.
 */
const names = ["天气", "便笺", "计时", "日程", "汇率"];
function jxa(source: string) {
  return execFileSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", source],
    {
      encoding: "utf8",
    },
  ).trim();
}
type Point = { x: number; y: number };
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
async function onScreen(
  app: ElectronApplication,
  page: Page,
  selector: string,
  at: Point,
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
/** Installs a capture-phase recorder; repeated move and over events keep a count plus first and last. */
const recorder = `(() => {
  const log = (window.__dragLog = []);
  const repeated = new Set(["dragover", "pointermove", "mousemove"]);
  const where = (t) => {
    const card = t && t.closest && t.closest("[data-formal-widget]");
    return card ? card.getAttribute("aria-label") + (t.closest(".widget-formal-controls") ? " / 标题栏" : " / 内容") : (t && t.tagName) || "";
  };
  for (const type of ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "dragstart", "dragenter", "dragover", "dragleave", "drop", "dragend"])
    window.addEventListener(type, (e) => {
      const entry = { type, x: Math.round(e.clientX), y: Math.round(e.clientY), target: where(e.target), at: Math.round(performance.now()) };
      const last = log[log.length - 1];
      if (repeated.has(type) && last && last.type === type && last.target === entry.target) {
        last.count = (last.count || 1) + 1; last.lastX = entry.x; last.lastY = entry.y; last.lastAt = entry.at;
      } else log.push(entry);
    }, true);
  return "installed";
})()`;

test("native diagnostic: which pages receive the drag events of a real pointer drag onto widget content and onto the title row", async ({}, info) => {
  if (
    process.env.CSTHINK_NATIVE_TESTS !== "1" ||
    process.env.CSTHINK_WIDGET_ORDER_DIAGNOSTIC_AUTHORIZED !== "1"
  )
    throw new Error(
      "NOT RUN: scheduled drag diagnostic authorization required",
    );
  if (
    jxa(
      "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted() ? 'yes' : 'no'",
    ) !== "yes"
  )
    throw new Error(
      "NOT RUN: Accessibility permission is not granted; not requested",
    );
  test.setTimeout(300_000);
  mkdirSync(".test-data/disposable", { recursive: true });
  const data = mkdtempSync(resolve(".test-data/disposable/native-order-diag-"));
  seedRetainedWidgets(data, names);
  const app = await _electron.launch({
    args: [resolve("."), `--data-root=${data}`],
  });
  const result: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    await ready(page);
    result.display = await app.evaluate(({ BrowserWindow, screen, app }) => {
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
    expect(await requestSize(app, page, 1440, 900)).toEqual([1440, 900]);
    await goTo(page, "控件");
    await expect(page.locator("[data-formal-widget]")).toHaveCount(5);
    const widgetPages = () =>
      app
        .context()
        .pages()
        .filter((p) => p.url().startsWith("csthink-widget:"));
    await expect.poll(() => widgetPages().length).toBeGreaterThanOrEqual(2);
    await page.getByRole("button", { name: "编辑布局", exact: true }).click();
    await page.waitForTimeout(500);
    result.focused = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getFocusedWindow()?.id ===
        BrowserWindow.getAllWindows()[0].id,
    );
    result.widgetViews = await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((c) => c.getURL().startsWith("csthink-widget:"))
        .map((c) => ({ id: c.id, url: c.getURL().slice(0, 60) })),
    );
    const install = async () => {
      await page.evaluate(recorder);
      for (const p of widgetPages())
        await p.evaluate(recorder).catch((e) => `not installed: ${e}`);
    };
    const collect = async () => ({
      host: await page.evaluate(
        () => (window as unknown as { __dragLog: unknown[] }).__dragLog,
      ),
      widgets: await Promise.all(
        widgetPages().map(async (p) => ({
          url: p.url().slice(0, 60),
          log: await p
            .evaluate(
              () =>
                (window as unknown as { __dragLog?: unknown[] }).__dragLog ??
                null,
            )
            .catch((e) => `unreadable: ${e}`),
        })),
      ),
    });
    const grip = `[data-formal-widget][aria-label^="控件 汇率 "] .widget-order-grip`;
    const weather = `[data-formal-widget][aria-label^="控件 天气 "]`;
    // 1. As V-15: drop on 天气's widget content.
    await install();
    const from1 = await onScreen(app, page, grip, { x: 0.5, y: 0.5 });
    const to1 = await onScreen(app, page, weather, {
      x: 0.2,
      y: 0.6,
    });
    drag(from1, to1);
    await page.waitForTimeout(2000);
    result.contentDrop = {
      from: from1,
      to: to1,
      order: stored(data),
      ...(await collect()),
    };
    // 2. Control: drop on 天气's title row, which the host page draws.
    await install();
    const from2 = await onScreen(app, page, grip, { x: 0.5, y: 0.5 });
    const to2 = await onScreen(
      app,
      page,
      `${weather} .widget-formal-controls`,
      { x: 0.3, y: 0.5 },
    );
    drag(from2, to2);
    await page.waitForTimeout(2000);
    result.titleDrop = {
      from: from2,
      to: to2,
      order: stored(data),
      ...(await collect()),
    };
  } finally {
    await info.attach("drag-diagnostic", {
      body: JSON.stringify(result, null, 1),
      contentType: "application/json",
    });
    await app.close();
  }
});
