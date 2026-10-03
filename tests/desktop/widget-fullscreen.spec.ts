import {
  test,
  expect,
  type Page,
  type ElectronApplication,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedWidgetCandidate } from "./widget-generation-fixture";
import { Store } from "../../src/service/store";
import { widgetFixture } from "../../src/main/widget-fixture";
import { launchLocal, closeLocal } from "./local-client";
import { goTo } from "./shell";

async function instance(app: ElectronApplication, shell: Page, id: string) {
  const status = () =>
    shell.evaluate(
      (slot) => window.desktop.widgetControl({ action: "status", slot }),
      `formal:${id}`,
    );
  await expect
    .poll(async () => {
      const r = await status();
      return r.ok && !!r.generation;
    })
    .toBe(true);
  const r = await status();
  if (!r.ok || !r.generation) throw new Error("Missing formal widget instance");
  const url = `csthink-widget://${r.generation}/index.html`;
  await expect
    .poll(() =>
      app
        .context()
        .pages()
        .some((p) => p.url() === url),
    )
    .toBe(true);
  return {
    page: app
      .context()
      .pages()
      .find((p) => p.url() === url)!,
    generation: r.generation,
    preview: r.preview!,
  };
}

test("widget fullscreen: same instances preserve order, scroll, inputs and data without repeated operations across two entries", async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/widget-full-"));
  const source = JSON.parse(widgetFixture);
  source.view.css += "body{min-height:1600px}";
  const ids = [
    seedWidgetCandidate(root, false, JSON.stringify(source)),
    seedWidgetCandidate(root, false, JSON.stringify(source)),
  ];
  const store = new Store(root);
  for (const id of ids) {
    const c = store
      .snapshot()
      .widgetGeneration!.candidates.find((c) => c.id === id.candidateId)!;
    expect(
      store.execute(
        {
          type: "retainWidgetCandidate",
          candidateId: c.id,
          digest: c.digest,
          requirementRevision: c.requirementRevision,
        },
        "main",
      ).ok,
    ).toBe(true);
  }
  expect(
    store.execute({ type: "selectWidgetDraft", id: null }, "main").ok,
  ).toBe(true);
  const widgets = store.snapshot().widgetGeneration!.widgets;
  store.close();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
  });
  try {
    const shell = await app.firstWindow();
    await goTo(shell, "控件");
    await expect(shell.locator("[data-formal-widget]")).toHaveCount(2);
    const first = await instance(app, shell, widgets[0].id),
      second = await instance(app, shell, widgets[1].id);
    expect(first.preview.widgetId).toBe(widgets[0].id);
    expect(second.preview.widgetId).toBe(widgets[1].id);
    expect(first.generation).not.toBe(second.generation);
    await first.page.getByLabel("随手记").fill("全屏保持的草稿");
    await expect(first.page.getByRole("status")).toHaveText("草稿已确认保存");
    await first.page.getByRole("button", { name: "记录一次" }).click();
    await expect(first.page.locator("#count")).toHaveText("已记录 1 次");
    await expect(second.page.getByLabel("随手记")).toHaveValue("");
    const wrongSlot = await shell.evaluate(
      ({ slot, generation }) =>
        window.desktop.widgetControl({
          action: "place",
          slot,
          generation,
          x: 10,
          y: 100,
          width: 100,
          height: 100,
        }),
      { slot: `formal:${widgets[1].id}`, generation: first.generation },
    );
    expect(wrongSlot.ok).toBe(false);
    await first.page.evaluate(() => window.scrollTo(0, 150));
    const beforeScroll = await first.page.evaluate(() => window.scrollY);
    const order = await shell
      .locator("[data-formal-widget]")
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-formal-widget")),
      );
    await shell.locator(".viewport").evaluate((node) => {
      node.scrollTop = 90;
    });
    const outerScroll = await shell
      .locator(".viewport")
      .evaluate((node) => node.scrollTop);
    await shell
      .getByRole("button", { name: "控件全屏", exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(shell.locator(".app")).toHaveAttribute(
      "data-widget-full",
      "true",
    );
    await expect(
      shell.getByRole("navigation", { name: "全局导航" }),
    ).toBeHidden();
    await expect(shell.locator(".sidebar")).toBeHidden();
    await expect(shell.locator(".widget-studio-heading")).toBeHidden();
    const restore = shell.getByRole("button", { name: "还原控件 Esc" });
    await shell.mouse.move(300, 300);
    await expect(restore).toHaveCSS("opacity", "0");
    await restore.focus();
    await expect(restore).toHaveCSS("opacity", "1");
    expect((await instance(app, shell, widgets[0].id)).generation).toBe(
      first.generation,
    );
    expect((await instance(app, shell, widgets[1].id)).generation).toBe(
      second.generation,
    );
    expect(await first.page.evaluate(() => window.scrollY)).toBe(beforeScroll);
    await expect(first.page.getByLabel("随手记")).toHaveValue("全屏保持的草稿");
    await app.evaluate(({ webContents }, generation) => {
      const contents = webContents
        .getAllWebContents()
        .find(
          (c) => c.getURL() === `csthink-widget://${generation}/index.html`,
        )!;
      contents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    }, first.generation);
    await expect(shell.locator(".app")).not.toHaveAttribute(
      "data-widget-full",
      "true",
    );
    await expect
      .poll(() => shell.locator(".viewport").evaluate((node) => node.scrollTop))
      .toBe(outerScroll);
    expect(
      await shell
        .locator("[data-formal-widget]")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("data-formal-widget")),
        ),
    ).toEqual(order);
    await shell.getByRole("button", { name: "控件全屏", exact: true }).click();
    await shell.mouse.move(10, 500);
    await shell.locator(".widget-restore-zone").hover();
    await expect(restore).toHaveCSS("opacity", "1");
    await restore.click();
    expect((await instance(app, shell, widgets[0].id)).generation).toBe(
      first.generation,
    );

    const panelReady = app.waitForEvent("window");
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items[0].submenu!.items.find(
          (item) => item.label === "打开工作台助手",
        )!
        .click(),
    );
    const panel = await panelReady;
    await panel.getByRole("button", { name: "工作台", exact: true }).click();
    const panelFirst = await instance(app, panel, widgets[0].id);
    expect(panelFirst.generation).not.toBe(first.generation);
    expect(panelFirst.preview.widgetId).toBe(first.preview.widgetId);
    expect(panelFirst.preview.version).toBe(first.preview.version);
    await expect(panelFirst.page.getByLabel("随手记")).toHaveValue(
      "全屏保持的草稿",
    );
    await expect(panelFirst.page.locator("#count")).toHaveText("已记录 1 次");
    await panelFirst.page.getByRole("button", { name: "记录一次" }).click();
    await expect(panelFirst.page.locator("#count")).toHaveText("已记录 2 次");
    const db = new DatabaseSync(join(root, "state.sqlite"));
    try {
      const data = db
        .prepare(
          "SELECT data,data_revision FROM widget_previews WHERE candidate_id=?",
        )
        .get(widgets[0].candidateId)!;
      expect(JSON.parse(String(data.data))).toEqual({ count: 2 });
      expect(data.data_revision).toBe(2);
      expect(
        db
          .prepare(
            "SELECT data_revision FROM widget_previews WHERE candidate_id=?",
          )
          .get(widgets[1].candidateId)!.data_revision,
      ).toBe(0);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM widget_generation_tasks").get()!
          .n,
      ).toBe(2);
    } finally {
      db.close();
    }
    await goTo(shell, "运行记录");
    await expect
      .poll(() => first.page.isClosed() && second.page.isClosed())
      .toBe(true);
    await expect(panelFirst.page.getByLabel("随手记")).toHaveValue(
      "全屏保持的草稿",
    );
    const nativePanel = await app.browserWindow(panel);
    await nativePanel.evaluate((w) => w.hide());
    await expect.poll(() => panelFirst.page.isClosed()).toBe(true);
  } finally {
    await closeLocal(app);
    rmSync(root, { recursive: true, force: true });
  }
});
