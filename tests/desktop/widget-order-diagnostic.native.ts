import {
  _electron,
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { seedRetainedWidgets } from "./widget-generation-fixture";
import { goTo, ready, requestSize } from "./shell";

/*
 * mac-feature-t11 V-15 input diagnostic, scheduled foreground only. The first V-15 run and the first
 * diagnostic posted Core Graphics events through osascript and no page received any event. This entry checks
 * where posted input goes: one move and click through osascript, one through a test-side native helper that
 * reports the cursor, the frontmost application and the owner of the topmost window under the cursor after
 * each event, then the two V-15 drags (onto widget content, which a native widget view covers, and onto the
 * title row, which the host page draws) through the helper. It records the events the host page and every
 * widget view page receive and the saved order; it asserts nothing about the outcome.
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

/** Builds the test-side input helper (tests/desktop/widget-order-input.m) into the disposable directory. */
function inputHelper() {
  const out = resolve(".test-data/disposable/widget-order-input");
  execFileSync("/usr/bin/clang", [
    "-fobjc-arc",
    "-O1",
    "-Wall",
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
    "-o",
    out,
    resolve("tests/desktop/widget-order-input.m"),
  ]);
  return (...args: (string | number)[]) => {
    const r = spawnSync(out, args.map(String), { encoding: "utf8" });
    return { exit: r.status, ...(JSON.parse(r.stdout || "{}") as object) };
  };
}
/** The osascript path of the first V-15 run, reduced to one move and one click. */
function osascriptClick(p: Point) {
  return jxa(`ObjC.import('CoreGraphics'); ObjC.import('Foundation');
const post = (type, q) => { const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(q.x, q.y), 0); $.CGEventPost(0, e); };
const p = ${JSON.stringify(p)};
post(5, p); $.NSThread.sleepForTimeInterval(0.2); post(1, p); $.NSThread.sleepForTimeInterval(0.08); post(2, p); $.NSThread.sleepForTimeInterval(0.2);
const c = $.CGEventGetLocation($.CGEventCreate(null)); JSON.stringify({ x: c.x, y: c.y })`);
}

test("native diagnostic: where real input posted by osascript and by a native helper goes, and which pages receive the drag events", async ({}, info) => {
  if (
    process.env.CSTHINK_NATIVE_TESTS !== "1" ||
    process.env.CSTHINK_WIDGET_ORDER_DIAGNOSTIC_AUTHORIZED !== "1"
  )
    throw new Error(
      "NOT RUN: scheduled drag diagnostic authorization required",
    );
  const helper = inputHelper();
  const before = helper("info") as {
    postEventAccess?: boolean;
    accessibilityTrusted?: number;
  };
  if (!before.postEventAccess || !before.accessibilityTrusted)
    throw new Error("NOT RUN: posting events is not allowed; not requested");
  test.setTimeout(300_000);
  mkdirSync(".test-data/disposable", { recursive: true });
  const data = mkdtempSync(resolve(".test-data/disposable/native-order-diag-"));
  seedRetainedWidgets(data, names);
  const app = await _electron.launch({
    args: [resolve("."), `--data-root=${data}`],
  });
  const result: Record<string, unknown> = { before };
  try {
    const page = await app.firstWindow();
    await ready(page);
    result.app = await app.evaluate(({ app }) => ({
      pid: process.pid,
      name: app.getName(),
    }));
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
    result.windowBounds = await app.evaluate(({ BrowserWindow }) => ({
      bounds: BrowserWindow.getAllWindows()[0].getBounds(),
      content: BrowserWindow.getAllWindows()[0].getContentBounds(),
      focused:
        BrowserWindow.getFocusedWindow()?.id ===
        BrowserWindow.getAllWindows()[0].id,
    }));
    result.afterSetup = helper("info");
    const install = async () => {
      await page.evaluate(recorder);
      for (const p of widgetPages())
        await p.evaluate(recorder).catch((e) => `not installed: ${e}`);
    };
    const collect = async () => ({
      layoutEdit: await page
        .getByRole("button", { name: "完成布局编辑", exact: true })
        .count(),
      host: await page.evaluate(
        () => (window as unknown as { __dragLog: unknown[] }).__dragLog,
      ),
      widgets: (
        await Promise.all(
          widgetPages().map((p) =>
            p
              .evaluate(
                () =>
                  (window as unknown as { __dragLog?: unknown[] }).__dragLog ??
                  null,
              )
              .catch((e) => `unreadable: ${e}`),
          ),
        )
      ).filter((log) => !Array.isArray(log) || log.length),
    });
    const toggle = `button[aria-pressed]:has-text("布局")`;
    // 1. Minimal check of the osascript path: move and click the layout toggle.
    await install();
    const t1 = await onScreen(app, page, toggle, { x: 0.5, y: 0.5 });
    const cursor1 = osascriptClick(t1);
    await page.waitForTimeout(800);
    result.osascriptClick = {
      at: t1,
      cursorAfter: cursor1,
      state: helper("info"),
      ...(await collect()),
    };
    // 2. The same with the native helper.
    await install();
    const t2 = await onScreen(app, page, toggle, { x: 0.5, y: 0.5 });
    const click2 = helper("click", t2.x, t2.y);
    await page.waitForTimeout(800);
    result.helperClick = { at: t2, helper: click2, ...(await collect()) };
    // Back in 编辑布局 for the drags, whatever the clicks did.
    if (
      !(await page
        .getByRole("button", { name: "完成布局编辑", exact: true })
        .count())
    )
      await page.getByRole("button", { name: "编辑布局", exact: true }).click();
    await page.waitForTimeout(500);
    const grip = `[data-formal-widget][aria-label^="控件 汇率 "] .widget-order-grip`;
    const weather = `[data-formal-widget][aria-label^="控件 天气 "]`;
    // 3. Drop on 天气's widget content (a native widget view covers it).
    await install();
    const from3 = await onScreen(app, page, grip, { x: 0.5, y: 0.5 });
    const to3 = await onScreen(app, page, weather, { x: 0.2, y: 0.6 });
    const drag3 = helper("drag", from3.x, from3.y, to3.x, to3.y, 24);
    await page.waitForTimeout(2000);
    result.contentDrop = {
      from: from3,
      to: to3,
      helper: drag3,
      order: stored(data),
      ...(await collect()),
    };
    // 4. Control: drop on 天气's title row, which the host page draws.
    await install();
    const from4 = await onScreen(app, page, grip, { x: 0.5, y: 0.5 });
    const to4 = await onScreen(
      app,
      page,
      `${weather} .widget-formal-controls`,
      { x: 0.3, y: 0.5 },
    );
    const drag4 = helper("drag", from4.x, from4.y, to4.x, to4.y, 24);
    await page.waitForTimeout(2000);
    result.titleDrop = {
      from: from4,
      to: to4,
      helper: drag4,
      order: stored(data),
      ...(await collect()),
    };
  } finally {
    await info.attach("input-diagnostic", {
      body: JSON.stringify(result, null, 1),
      contentType: "application/json",
    });
    await app.close();
  }
});
