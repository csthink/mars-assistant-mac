import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { seedRetainedWidgets } from "./widget-generation-fixture";
import { launchLocal, closeLocal } from "./local-client";
import { goTo } from "./shell";

/*
 * mac-feature-t11:KB-04. The drawing masks of each native widget view sit above the host page, and a mouse
 * event inside a mask goes to the mask. Real mouse input follows AppKit hit testing, which Playwright's input
 * bypasses, so this test asks AppKit directly (read-only, background window, no input sent): the host page
 * must receive every control of a card's title row, in 编辑布局 and in the overlay of normal mode, and the
 * gaps between cards; a card's content must stay with its own widget view.
 */
type Hit = {
  class: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

test("widget order hit testing: title row controls and card gaps reach the host page; widget content stays with its view", async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const dir = mkdtempSync(resolve(".test-data/disposable/widget-hit-"));
  const build = mkdtempSync(resolve(".test-data/disposable/widget-hit-probe-"));
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
  seedRetainedWidgets(dir, ["天气", "便笺", "计时", "日程", "汇率"]);
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${dir}`],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 900),
    );
    await goTo(page, "控件");
    const cards = page.locator("[data-formal-widget]");
    await expect(cards).toHaveCount(5);
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }) =>
            webContents
              .getAllWebContents()
              .filter((c) => c.getURL().startsWith("csthink-widget:")).length,
        ),
      )
      .toBe(5);
    const width = await page.evaluate(() => innerWidth);
    const hit = (x: number, y: number) =>
      app.evaluate(
        ({ BrowserWindow }, a) => {
          const probe = process
            .getBuiltinModule("module")
            .createRequire(a.module)(a.module);
          return JSON.parse(
            probe.hit(
              BrowserWindow.getAllWindows()[0].getNativeWindowHandle(),
              a.x,
              a.y,
            ),
          ) as Hit;
        },
        { module, x, y },
      );
    const host = (h: Hit) =>
      h.class === "RenderWidgetHostViewCocoa" && h.width === width;
    const centre = async (page: Page, selector: string) => {
      const box = (await page.locator(selector).first().boundingBox())!;
      return [box.x + box.width / 2, box.y + box.height / 2] as const;
    };
    const misses: string[] = [];
    const expectHost = async (label: string, x: number, y: number) => {
      const h = await hit(x, y);
      if (!host(h)) misses.push(`${label} → ${h.class} ${h.width}x${h.height}`);
    };
    // Normal mode, the overlay row shown by keyboard focus as a person reaches it.
    const ids = await cards.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-formal-widget")!),
    );
    const row = (id: string) =>
      `[data-formal-widget="${id}"] .widget-formal-controls`;
    await page
      .locator(`${row(ids[4])} button`)
      .first()
      .focus();
    await expect(page.locator(`${row(ids[4])}`)).toHaveCSS("opacity", "1");
    await page.waitForTimeout(300);
    for (const [i, button] of (
      await page.locator(`${row(ids[4])} button`).all()
    ).entries()) {
      const box = (await button.boundingBox())!;
      await expectHost(
        `overlay button ${i}`,
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
    }
    await expectHost(
      "overlay title",
      ...(await centre(page, `${row(ids[4])} h2`)),
    );
    // 编辑布局: every card's grip, 前移, 后移, 更多 and title.
    await page.getByRole("button", { name: "编辑布局", exact: true }).click();
    await page.waitForTimeout(500);
    for (const id of ids) {
      for (const selector of [
        ".widget-order-grip",
        "[data-order-step='-1']",
        "[data-order-step='1']",
        ".widget-order-more",
        "h2",
      ])
        await expectHost(
          `${id.slice(0, 8)} ${selector}`,
          ...(await centre(page, `${row(id)} ${selector}`)),
        );
      // The card's content stays with its own widget view.
      const box = (await page
        .locator(`[data-formal-widget="${id}"]`)
        .boundingBox())!;
      const content = await hit(
        box.x + box.width / 2,
        box.y + box.height * 0.7,
      );
      expect(content.class, `${id.slice(0, 8)} content`).toBe(
        "RenderWidgetHostViewCocoa",
      );
      expect(content.width, `${id.slice(0, 8)} content`).toBeLessThan(width);
    }
    // Gaps: the far half of the gap to the right of and below the first card.
    const first = (await cards.first().boundingBox())!;
    await expectHost(
      "gap right",
      first.x + first.width + 12,
      first.y + first.height / 2,
    );
    await expectHost(
      "gap below",
      first.x + first.width / 2,
      first.y + first.height + 12,
    );
    expect(misses).toEqual([]);
  } finally {
    await closeLocal(app);
    rmSync(dir, { recursive: true, force: true });
    rmSync(build, { recursive: true, force: true });
  }
});
