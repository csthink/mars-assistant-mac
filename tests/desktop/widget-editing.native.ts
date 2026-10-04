import {
  _electron,
  test,
  expect,
  type ElectronApplication,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { seedWidgetCandidate } from "./widget-generation-fixture";
import { widgetFixture } from "../../src/main/widget-fixture";
import { Store } from "../../src/service/store";
import { goTo, ready, requestSize } from "./shell";

// Scheduled foreground only. No model call, settings change, or permission request.
test("native: widget editing focus, deletion undo, fullscreen state and restart require explicit foreground authorization", async ({}, info) => {
  if (
    process.env.CSTHINK_NATIVE_TESTS !== "1" ||
    process.env.CSTHINK_WIDGET_EDITING_NATIVE_AUTHORIZED !== "1"
  )
    throw new Error(
      "NOT RUN: scheduled editing foreground authorization required",
    );
  test.setTimeout(600_000);
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/native-editing-"));
  const source = JSON.parse(widgetFixture);
  source.view.css += "body{min-height:1600px}";
  const ids = [
    seedWidgetCandidate(root, false, JSON.stringify(source)),
    seedWidgetCandidate(root, false, JSON.stringify(source)),
  ];
  const store = new Store(root);
  try {
    for (const id of ids) {
      const c = store
        .snapshot()
        .widgetGeneration!.candidates.find((c) => c.id === id.candidateId)!;
      const r = store.execute(
        {
          type: "retainWidgetCandidate",
          candidateId: c.id,
          digest: c.digest,
          requirementRevision: c.requirementRevision,
        },
        "main",
      );
      if (!r.ok) throw new Error(r.message);
    }
    store.execute({ type: "selectWidgetDraft", id: null }, "main");
  } finally {
    store.close();
  }
  let app: ElectronApplication | undefined;
  const launch = async () => {
    app = await _electron.launch({
      args: [resolve("."), `--data-root=${root}`],
    });
    const page = await app.firstWindow();
    await ready(page);
    const window = await app.browserWindow(page);
    const windowId = await window.evaluate((w) => w.id);
    const display = await app.evaluate(({ BrowserWindow, screen }, id) => {
      const w = BrowserWindow.fromId(id)!;
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
      return { id: target.id, workArea: target.workArea, windowId: id };
    }, windowId);
    await info.attach("selected-display", {
      body: JSON.stringify(display),
      contentType: "application/json",
    });
    return page;
  };
  try {
    let page = await launch();
    const actual = await requestSize(app!, page, 1440, 900);
    await info.attach("content-size", {
      body: JSON.stringify({ requested: [1440, 900], actual }),
      contentType: "application/json",
    });
    // A short screen does not hide all other foreground coverage. The size item fails at the end.
    const snapshot = async () => {
      const r = await page.evaluate(() =>
        window.desktop.command({ type: "snapshot" }),
      );
      if (!r.ok) throw new Error(r.message);
      return r.snapshot;
    };
    const tasksBefore = (await snapshot()).widgetGeneration!.tasks.length;
    await goTo(page, "控件");
    await page
      .getByRole("button", { name: "新建修改草稿", exact: true })
      .first()
      .click();
    const input = page.getByRole("textbox", { name: "控件需求", exact: true });
    await input.fill("前台修改输入，保留到下次用户操作");
    await expect(input).toBeFocused();
    await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
    const selected = (await snapshot()).widgetGeneration!.drafts.find((d) =>
      d.input.startsWith("前台修改输入"),
    )!.id;
    await page.getByRole("button", { name: "删除草稿", exact: true }).click();
    await page
      .getByRole("dialog", { name: "确认删除控件草稿" })
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(input).toHaveValue("前台修改输入，保留到下次用户操作");
    await page.getByRole("button", { name: "删除草稿", exact: true }).click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await page.getByRole("button", { name: "撤销删除", exact: true }).click();
    await expect(input).toHaveValue("前台修改输入，保留到下次用户操作");
    await page.getByRole("button", { name: "返回控件草稿" }).click();
    await page.getByRole("button", { name: "返回控件", exact: true }).click();
    await expect(page.locator("[data-formal-widget]")).toHaveCount(2);
    const formal = (await snapshot()).widgetGeneration!.widgets;
    const instance = async (id: string) => {
      const status = () =>
        page.evaluate(
          (slot) => window.desktop.widgetControl({ action: "status", slot }),
          `formal:${id}`,
        );
      await expect
        .poll(async () => {
          const r = await status();
          return r.ok && r.generation;
        })
        .toBeTruthy();
      const r = await status();
      if (!r.ok) throw new Error(r.message);
      const url = `csthink-widget://${r.generation}/index.html`;
      await expect
        .poll(() =>
          app!
            .context()
            .pages()
            .some((p) => p.url() === url),
        )
        .toBe(true);
      return {
        generation: r.generation,
        view: app!
          .context()
          .pages()
          .find((p) => p.url() === url)!,
      };
    };
    const a = await instance(formal[0].id);
    await a.view.getByLabel("随手记").fill("前台全屏草稿");
    await expect(a.view.getByRole("status")).toHaveText("草稿已确认保存");
    await a.view.evaluate(() => window.scrollTo(0, 150));
    const inner = await a.view.evaluate(() => window.scrollY);
    const order = await page
      .locator("[data-formal-widget]")
      .evaluateAll((ns) => ns.map((n) => n.getAttribute("data-formal-widget")));
    await page.getByRole("button", { name: "控件全屏", exact: true }).click();
    const restore = page.getByRole("button", { name: "还原控件 Esc" });
    await page.mouse.move(300, 30);
    await expect(restore).toHaveCSS("opacity", "0");
    await page.locator(".widget-restore-zone").hover();
    await expect(restore).toHaveCSS("opacity", "1");
    expect(await a.view.evaluate(() => window.scrollY)).toBe(inner);
    await restore.click();
    expect((await instance(formal[0].id)).generation).toBe(a.generation);
    await page.getByRole("button", { name: "控件全屏", exact: true }).click();
    await restore.focus();
    await expect(restore).toHaveCSS("opacity", "1");
    await restore.press("Enter");
    await expect(page.locator(".app")).not.toHaveAttribute(
      "data-widget-full",
      "true",
    );
    await page.getByRole("button", { name: "控件全屏", exact: true }).click();
    await a.view.getByLabel("随手记").focus();
    await app!.evaluate(({ webContents }, generation) => {
      const wc = webContents
        .getAllWebContents()
        .find(
          (w) => w.getURL() === `csthink-widget://${generation}/index.html`,
        )!;
      wc.focus();
      wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    }, a.generation);
    await expect(page.locator(".app")).not.toHaveAttribute(
      "data-widget-full",
      "true",
    );
    expect((await instance(formal[0].id)).generation).toBe(a.generation);
    await expect(a.view.getByLabel("随手记")).toHaveValue("前台全屏草稿");
    // Focusing the input may scroll it into view, so assert preservation before that native focus action separately.
    expect(inner).toBeGreaterThan(0);
    expect(
      await page
        .locator("[data-formal-widget]")
        .evaluateAll((ns) =>
          ns.map((n) => n.getAttribute("data-formal-widget")),
        ),
    ).toEqual(order);
    await info.attach("restored-shell", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await info.attach("restored-widget", {
      body: await a.view.screenshot(),
      contentType: "image/png",
    });
    await app!.close();
    app = undefined;
    page = await launch();
    await goTo(page, "控件");
    expect((await snapshot()).widgetGeneration!.tasks.length).toBe(tasksBefore);
    expect(
      (await snapshot()).widgetGeneration!.tasks.some((t) =>
        ["running", "queued", "stopping"].includes(t.state),
      ),
    ).toBe(false);
    const r = await page.evaluate(
      (id) => window.desktop.command({ type: "selectWidgetDraft", id }),
      selected,
    );
    expect(r.ok).toBe(true);
    await expect(
      page.getByRole("textbox", { name: "控件需求", exact: true }),
    ).toHaveValue("前台修改输入，保留到下次用户操作");
    expect
      .soft(
        actual,
        "900 content height remains required; no system scaling change is authorized",
      )
      .toEqual([1440, 900]);
  } finally {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
