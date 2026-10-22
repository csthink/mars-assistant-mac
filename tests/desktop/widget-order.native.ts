import {
  _electron,
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
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

/**
 * Builds the test-side input helper (tests/desktop/widget-order-input.m). It posts HID events and reports, after
 * each one, the cursor, the frontmost application and the owner of the topmost window under the cursor.
 */
function inputHelper(log: unknown[]) {
  mkdirSync(".test-data/disposable", { recursive: true });
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
    const r = spawnSync(
      out,
      args.map((a) => String(Math.round(Number(a)) || a)),
      {
        encoding: "utf8",
      },
    );
    const reply = {
      args,
      exit: r.status,
      ...(JSON.parse(r.stdout || "{}") as object),
    };
    log.push(reply);
    if (r.status !== 0) throw new Error(`input helper refused: ${r.stdout}`);
    return reply as {
      postEventAccess?: boolean;
      accessibilityTrusted?: number;
    };
  };
}
type Point = { x: number; y: number };
type Hit = {
  class: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
let hitProbe = "";
/** The view AppKit gives a mouse event at a global point (tests/desktop/widget-hit-probe.mm, read-only). */
async function hitAt(app: ElectronApplication, point: Point): Promise<Hit> {
  if (!hitProbe) {
    const build = mkdtempSync(
      resolve(".test-data/disposable/order-hit-probe-"),
    );
    hitProbe = join(build, "widget-hit-probe.node");
    execFileSync("/usr/bin/clang++", [
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
      resolve("tests/desktop/widget-hit-probe.mm"),
      "-o",
      hitProbe,
    ]);
  }
  return app.evaluate(
    ({ BrowserWindow }, a) => {
      const w = BrowserWindow.getAllWindows()[0];
      const content = w.getContentBounds();
      const probe = process.getBuiltinModule("module").createRequire(a.probe)(
        a.probe,
      );
      return JSON.parse(
        probe.hit(
          w.getNativeWindowHandle(),
          a.point.x - content.x,
          a.point.y - content.y,
        ),
      );
    },
    { probe: hitProbe, point },
  );
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
  const inputs: unknown[] = [];
  const input = inputHelper(inputs);
  const permission = input("info");
  if (!permission.postEventAccess || !permission.accessibilityTrusted)
    throw new Error(
      "NOT RUN: posting real input needs the Accessibility and post event permissions for the process running this test; the test does not request them",
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
    // 编辑布局 adds its note above the grid; positions are taken only once the grip has stopped moving.
    await expect(page.locator(".widget-layout-note")).toBeVisible();
    const grip = `[data-formal-widget]:nth-child(5) .widget-order-grip`;
    let settled = "";
    await expect
      .poll(async () => {
        const box = JSON.stringify(await page.locator(grip).boundingBox());
        const same = box === settled;
        settled = box;
        return same;
      })
      .toBe(true);
    const focused = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getFocusedWindow()?.id ===
        BrowserWindow.getAllWindows()[0].id,
    );
    expect(focused, "the test window must be the key window").toBe(true);

    // 1. Real pointer: drag 汇率's grip across the other cards and drop it on the left half of 天气's widget
    //    content, which a native widget view covers.
    const from = await onScreen(app, page, grip);
    const to = await onScreen(app, page, `[data-formal-widget]:nth-child(1)`, {
      x: 0.2,
      y: 0.6,
    });
    // Before any input: AppKit must give the press point to the host page and the drop point to a widget view.
    const hits = {
      from: await hitAt(app, from),
      to: await hitAt(app, to),
    };
    await info.attach("hit-before-drag", {
      body: JSON.stringify({ from, to, hits }),
      contentType: "application/json",
    });
    expect(hits.from.class).toBe("RenderWidgetHostViewCocoa");
    expect(hits.from.width).toBe(1440);
    expect(hits.to.class).toBe("RenderWidgetHostViewCocoa");
    expect(hits.to.width).toBeLessThan(1440);
    input("drag", from.x, from.y, to.x, to.y, 24);
    await expect
      .poll(() => stored(data), { timeout: 10_000 })
      .toEqual(["汇率", "天气", "便笺", "计时", "日程"]);
    const announce = page.locator(".widget-order-announce");
    await expect(announce).toHaveText("「汇率」已移到第 1 位");
    await expect(announce).toHaveAttribute("role", "status");

    // 2. Real keys: Space on the focused 后移 of 天气 moves it one place, and focus stays on that control.
    const later = page.getByRole("button", { name: /^后移 天气 / });
    await later.focus();
    input("key", 49);
    await expect
      .poll(() => stored(data))
      .toEqual(["汇率", "便笺", "天气", "计时", "日程"]);
    await expect(later).toBeFocused();
    await expect(announce).toHaveText("「天气」已移到第 3 位");
    // Return on 前移 moves it back, and focus stays on 前移; the first card's 前移 is disabled.
    const earlier = page.getByRole("button", { name: /^前移 天气 / });
    await earlier.focus();
    input("key", 36);
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
    await info.attach("input-events", {
      body: JSON.stringify(inputs, null, 1),
      contentType: "application/json",
    });
    await app.close();
  }
});
