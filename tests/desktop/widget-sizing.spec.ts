import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { seedWidgetCandidate } from "./widget-generation-fixture";
import { Store } from "../../src/service/store";
import { launchLocal, closeLocal } from "./local-client";
import { goTo, requestSize } from "./shell";
import { widgetAppearance } from "../../src/shared/appearance";
const { light, dark } = widgetAppearance;
const source = (short = false) =>
  JSON.stringify({
    schemaVersion: 1,
    name: short ? "单时间卡" : "双时间卡",
    view: {
      html: `<main><section><h1>本地时间</h1><p>09:41</p><label>备注<input id="note" aria-label="备注"></label><button id="toggle">展开详情</button></section>${short ? "" : '<section id="second"><h2>另一个时区</h2><p>18:41</p><p id="bottom">第二时间卡底部文字</p></section>'}<div id="extra" hidden></div></main>`,
      css: `:root{color-scheme:light dark}body{margin:0;background:light-dark(${light.surface},${dark.surface});color:light-dark(${light.text},${dark.text});font:16px system-ui}main{padding:20px}section{height:300px;border:1px solid light-dark(${light.line},${dark.line});border-radius:12px;box-sizing:border-box;padding:24px;margin-bottom:16px}h1,h2{margin-top:0}p{font-size:24px}input{display:block;width:90%;padding:8px;margin:8px 0}button{padding:8px;font:inherit}#extra{height:500px;background:light-dark(${light.raised},${dark.raised})}#extra[hidden]{display:none}@media(max-width:400px){section{height:360px}}`,
      js: "document.querySelector('#toggle').onclick=()=>{const e=document.querySelector('#extra');e.hidden=!e.hidden;document.querySelector('#toggle').textContent=e.hidden?'展开详情':'收起详情'}",
    },
    config: [],
    draftFields: [],
    capabilities: [],
    resources: [],
  });
async function setup(retain: boolean) {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/content-sizing-"));
  const ids = retain
    ? [
        seedWidgetCandidate(root, false, source(true)),
        seedWidgetCandidate(root, false, source()),
      ]
    : [seedWidgetCandidate(root, false, source())];
  const store = new Store(root);
  if (retain) {
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
  }
  const widgets = store.snapshot().widgetGeneration!.widgets;
  store.close();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
  });
  const shell = await app.firstWindow();
  await goTo(shell, "控件");
  return {
    app,
    shell,
    root,
    widgets,
    async close() {
      await closeLocal(app);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function isolated(app: ElectronApplication, shell: Page, slot: string) {
  let generation = "";
  await expect
    .poll(async () => {
      const r = await shell.evaluate(
        (slot) => window.desktop.widgetControl({ action: "status", slot }),
        slot,
      );
      generation = r.ok ? (r.generation ?? "") : "";
      return generation;
    })
    .not.toBe("");
  await expect
    .poll(() =>
      app
        .context()
        .pages()
        .some((p) => p.url() === `csthink-widget://${generation}/index.html`),
    )
    .toBe(true);
  const page = app
    .context()
    .pages()
    .find((p) => p.url() === `csthink-widget://${generation}/index.html`)!;
  // Release Playwright's default light emulation; exercise the actual native App theme.
  await page.emulateMedia({ colorScheme: null });
  return page;
}
test("widget sizing: workspace, fullscreen and panel preserve natural geometry, order and input", async ({}, info) => {
  const f = await setup(true);
  try {
    await requestSize(f.app, f.shell, 1440, 900);
    const first = await isolated(f.app, f.shell, `formal:${f.widgets[0].id}`),
      second = await isolated(f.app, f.shell, `formal:${f.widgets[1].id}`);
    const frames = f.shell.locator("[data-formal-widget] .widget-frame");
    await expect
      .poll(() => frames.nth(1).evaluate((e) => e.clientHeight))
      .toBeGreaterThan(600);
    const heights = await frames.evaluateAll((nodes) =>
      nodes.map((n) => n.clientHeight),
    );
    expect(heights[1]).toBeGreaterThan(heights[0]);
    await first.getByLabel("备注").fill("保持输入");
    await expect(
      f.shell.locator("[data-formal-widget]").first(),
    ).toHaveAttribute("data-native-focus", "true");
    await expect(f.shell.locator(".widget-formal-controls").first()).toHaveCSS(
      "opacity",
      "1",
    );
    const initialURL = first.url();
    const order = await f.shell
      .locator("[data-formal-widget]")
      .evaluateAll((ns) => ns.map((n) => n.getAttribute("data-formal-widget")));
    await first.getByLabel("备注").evaluate((e: HTMLInputElement) => e.blur());
    await f.shell.mouse.move(5, 5);
    await expect(f.shell.locator(".widget-formal-controls").first()).toHaveCSS(
      "opacity",
      "0",
    );
    const position = await frames.first().boundingBox();
    await f.shell.locator(".widget-formal-controls button").first().focus();
    await expect(f.shell.locator(".widget-formal-controls").first()).toHaveCSS(
      "opacity",
      "1",
    );
    expect(await frames.first().boundingBox()).toEqual(position);
    await f.shell
      .getByRole("button", { name: "控件全屏", exact: true })
      .click();
    await expect(f.shell.locator(".app")).toHaveAttribute(
      "data-widget-full",
      "true",
    );
    const restore = f.shell.getByRole("button", {
      name: "还原（Esc）",
      exact: true,
    });
    expect(await restore.innerText()).toBe("");
    await restore.focus();
    await expect(restore).toHaveCSS("opacity", "1");
    expect(first.url()).toBe(initialURL);
    await expect(first.getByLabel("备注")).toHaveValue("保持输入");
    await f.shell.keyboard.press("Escape");
    await expect(f.shell.locator(".app")).not.toHaveAttribute(
      "data-widget-full",
      "true",
    );
    expect(
      await f.shell
        .locator("[data-formal-widget]")
        .evaluateAll((ns) =>
          ns.map((n) => n.getAttribute("data-formal-widget")),
        ),
    ).toEqual(order);
    const oldHeight = await frames.nth(1).evaluate((e) => e.clientHeight);
    await second.getByRole("button", { name: "展开详情" }).click();
    await expect
      .poll(() => frames.nth(1).evaluate((e) => e.clientHeight))
      .toBe(oldHeight + 500);
    await second.getByRole("button", { name: "收起详情" }).click();
    await expect
      .poll(() => frames.nth(1).evaluate((e) => e.clientHeight))
      .toBe(oldHeight);

    await requestSize(f.app, f.shell, 900, 680);
    await f.shell
      .locator("[data-formal-widget]")
      .nth(1)
      .scrollIntoViewIfNeeded();
    const readingTop = await frames
      .nth(1)
      .evaluate((e) => e.getBoundingClientRect().top);
    const firstHeight = await frames.first().evaluate((e) => e.clientHeight);
    await first.evaluate(() => {
      (document.querySelector("#extra") as HTMLElement).hidden = false;
    });
    await expect
      .poll(() => frames.first().evaluate((e) => e.clientHeight))
      .toBe(firstHeight + 500);
    await expect
      .poll(async () =>
        Math.abs(
          (await frames.nth(1).evaluate((e) => e.getBoundingClientRect().top)) -
            readingTop,
        ),
      )
      .toBeLessThanOrEqual(1);
    await first.evaluate(() => {
      (document.querySelector("#extra") as HTMLElement).hidden = true;
    });
    await expect
      .poll(() => frames.first().evaluate((e) => e.clientHeight))
      .toBe(firstHeight);
    await requestSize(f.app, f.shell, 1440, 900);
    await info.attach("workspace-host", {
      body: await f.shell.screenshot(),
      contentType: "image/png",
    });
    await info.attach("workspace-isolated", {
      body: await second.screenshot(),
      contentType: "image/png",
    });
    const newPanel = f.app.waitForEvent("window");
    await f.app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items[0].submenu!.items.find((i) => i.label === "打开工作台助手")!
        .click(),
    );
    const panel = await newPanel;
    await panel.getByRole("button", { name: "工作台", exact: true }).click();
    const panelSecond = await isolated(
      f.app,
      panel,
      `formal:${f.widgets[1].id}`,
    );
    await expect
      .poll(() =>
        panel
          .locator("[data-formal-widget] .widget-frame")
          .nth(1)
          .evaluate((e) => e.clientHeight),
      )
      .toBeGreaterThan(720);
    expect(panelSecond.url()).not.toBe(second.url());
    await panel.locator("[data-formal-widget]").nth(1).scrollIntoViewIfNeeded();
    await expect
      .poll(() => panelSecond.evaluate(() => innerHeight))
      .toBe(
        await panel
          .locator("[data-formal-widget] .widget-frame")
          .nth(1)
          .evaluate((e) => e.clientHeight),
      );
    await info.attach("panel-host", {
      body: await panel.screenshot(),
      contentType: "image/png",
    });
    await info.attach("panel-isolated", {
      body: await panelSecond.screenshot(),
      contentType: "image/png",
    });
    const snap = await f.shell.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    expect(snap.ok && snap.snapshot.widgetGeneration!.tasks.length).toBe(2);
  } finally {
    await f.close();
  }
});
test("widget sizing: edit preview grows while requirement and candidate actions stay reachable", async ({}, info) => {
  const f = await setup(false);
  try {
    const view = await isolated(f.app, f.shell, "default");
    const frame = f.shell.locator(".widget-candidate-panel .widget-frame");
    await expect
      .poll(() => frame.evaluate((e) => e.clientHeight))
      .toBeGreaterThan(600);
    await expect(
      f.shell.getByRole("textbox", { name: "控件需求", exact: true }),
    ).toBeVisible();
    await expect(
      f.shell.getByRole("button", { name: "保留控件", exact: true }),
    ).toBeVisible();
    const before = await frame.evaluate((e) => e.clientHeight);
    await view.getByRole("button", { name: "展开详情" }).click();
    await expect
      .poll(() => frame.evaluate((e) => e.clientHeight))
      .toBe(before + 500);
    await expect(
      f.shell.getByRole("textbox", { name: "控件需求", exact: true }),
    ).toBeVisible();
    await view.getByRole("button", { name: "收起详情" }).click();
    await expect.poll(() => frame.evaluate((e) => e.clientHeight)).toBe(before);
    await info.attach("preview-host", {
      body: await f.shell.screenshot(),
      contentType: "image/png",
    });
    await info.attach("preview-isolated", {
      body: await view.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await f.close();
  }
});

test("widget sizing: isolated backgrounds follow the saved App appearance without rewriting packages", async () => {
  const f = await setup(true);
  try {
    const first = await isolated(f.app, f.shell, `formal:${f.widgets[0].id}`);
    const second = await isolated(f.app, f.shell, `formal:${f.widgets[1].id}`);
    const before = await f.shell.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    await first.getByLabel("备注").fill("保留主题切换输入");
    const url = first.url();
    // A document without author styles exercises the host's weaker default stylesheet.
    await second.evaluate(() =>
      document.querySelector('link[rel="stylesheet"]')?.remove(),
    );
    for (const appearance of ["dark", "light", "dark"] as const) {
      const reply = await f.shell.evaluate(
        (appearance) =>
          window.desktop.command({ type: "setAppearance", appearance }),
        appearance,
      );
      expect(reply.ok).toBe(true);
      await expect(f.shell.locator("html")).toHaveAttribute(
        "data-theme",
        appearance,
      );
      await expect
        .poll(() =>
          f.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
        )
        .toBe(appearance);
      const colors = await f.shell.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        const c = document.createElement("div");
        c.style.color = s.getPropertyValue("--c-surface");
        document.body.append(c);
        const surface = getComputedStyle(c).color;
        c.style.color = s.getPropertyValue("--c-text");
        const text = getComputedStyle(c).color;
        c.remove();
        return { surface, text };
      });
      for (const page of [first, second]) {
        await expect
          .poll(() =>
            page.evaluate(
              () => matchMedia("(prefers-color-scheme:dark)").matches,
            ),
          )
          .toBe(appearance === "dark");
        await expect
          .poll(() =>
            page.evaluate(() => ({
              surface: getComputedStyle(document.documentElement)
                .backgroundColor,
              text: getComputedStyle(document.body).color,
            })),
          )
          .toEqual(colors);
      }
      await expect(first.locator("body")).toHaveCSS(
        "background-color",
        colors.surface,
      );
      expect(first.url()).toBe(url);
      await expect(first.getByLabel("备注")).toHaveValue("保留主题切换输入");
    }
    const after = await f.shell.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    expect(before.ok && after.ok && after.snapshot.widgetGeneration).toEqual(
      before.ok && before.snapshot.widgetGeneration,
    );
  } finally {
    await f.close();
  }
});
