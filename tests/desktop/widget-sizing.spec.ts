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
import { goTo, closeSettings, requestSize } from "./shell";
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
async function setup(retain: boolean, connectionOrder?: string) {
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
    env: {
      ...process.env,
      CSTHINK_TEST_PANEL_CONNECTION_ORDER: connectionOrder ?? "",
      CSTHINK_TEST_RECORD_WIDGET_LAYOUT: "1",
    },
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
        .items[0].submenu!.items.find((i) => i.label === "打开菜单栏面板")!
        .click(),
    );
    const panel = await newPanel;
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
  } catch (error) {
    await info.attach("sizing-failure-state", {
      body: JSON.stringify(
        await f.app.evaluate(async ({ BrowserWindow, webContents }) => ({
          records: Reflect.get(globalThis, "widgetLayoutRecords"),
          windows: BrowserWindow.getAllWindows().map((w) => ({
            id: w.id,
            visible: w.isVisible(),
            bounds: w.getBounds(),
            children: w.contentView.children.map((v) => v.getBounds()),
          })),
          pages: await Promise.all(
            webContents.getAllWebContents().map(async (c) => ({
              id: c.id,
              url: c.getURL(),
              state: await c
                .executeJavaScript(
                  `({width:innerWidth,height:innerHeight,hidden:document.hidden,bodyHeight:document.body?.scrollHeight,frames:[...document.querySelectorAll('.widget-frame')].map(e=>({height:e.clientHeight,mode:e.dataset.heightMode,rect:e.getBoundingClientRect().toJSON()})),text:document.body?.innerText})`,
                )
                .catch((e) => String(e)),
            })),
          ),
        })),
      ),
      contentType: "application/json",
    });
    throw error;
  } finally {
    await f.close();
  }
});
test("widget sizing: workspace clip follows the scrolled viewport without a fixed top reserve", async () => {
  const f = await setup(true);
  try {
    await requestSize(f.app, f.shell, 1180, 600);
    const frames = f.shell.locator("[data-formal-widget] .widget-frame");
    await expect
      .poll(() => frames.nth(1).getAttribute("data-height-mode"))
      .toBe("natural");
    // Each widget's expected visible area: its frame content box within the scroll viewport.
    const expected = () =>
      f.shell.evaluate(() => {
        const viewport = document
          .querySelector(".center .viewport")!
          .getBoundingClientRect();
        return [
          ...document.querySelectorAll<HTMLElement>(
            "[data-formal-widget] .widget-frame",
          ),
        ].map((e) => {
          const r = e.getBoundingClientRect();
          const x = Math.max(r.left + e.clientLeft, viewport.left),
            y = Math.max(r.top + e.clientTop, viewport.top);
          const right = Math.min(
              r.left + e.clientLeft + e.clientWidth,
              viewport.right,
            ),
            bottom = Math.min(
              r.top + e.clientTop + e.clientHeight,
              viewport.bottom,
            );
          return {
            x: Math.ceil(x),
            y: Math.ceil(y),
            right: Math.floor(right),
            bottom: Math.floor(bottom),
          };
        });
      });
    const actual = () =>
      f.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]
          .contentView.children.filter((root) => root.getVisible())
          .map((root) => {
            let view: Electron.View = root,
              x = 0,
              y = 0,
              b = { x: -1e9, y: -1e9, right: 1e9, bottom: 1e9 };
            for (let depth = 0; depth < 4; depth++, view = view.children[0]) {
              const r = view.getBounds();
              x += r.x;
              y += r.y;
              b = {
                x: Math.max(b.x, x),
                y: Math.max(b.y, y),
                right: Math.min(b.right, x + r.width),
                bottom: Math.min(b.bottom, y + r.height),
              };
            }
            return b;
          })
          .sort((a, b) => a.x - b.x),
      );
    for (const top of [0, 150]) {
      await f.shell.evaluate(
        (top) => (document.querySelector(".center .viewport")!.scrollTop = top),
        top,
      );
      const want = (await expected()).sort((a, b) => a.x - b.x);
      expect(want[0].y).toBeLessThan(96);
      await expect.poll(actual).toEqual(want);
    }
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

test("widget sizing: edit preview keeps its reading position when settings closes and reopens the widget", async () => {
  const f = await setup(false);
  try {
    await requestSize(f.app, f.shell, 1180, 600);
    const frame = f.shell.locator(".widget-candidate-panel .widget-frame");
    await expect
      .poll(() => frame.getAttribute("data-height-mode"))
      .toBe("natural");
    const height = await frame.evaluate((e) => e.clientHeight);
    const body = f.shell.locator(".right-body");
    const bottom = await body.evaluate((e) => {
      e.scrollTop = e.scrollHeight;
      return e.scrollTop;
    });
    expect(bottom).toBeGreaterThan(300);
    const generation = () =>
      f.shell.evaluate(async () => {
        const r = await window.desktop.widgetControl({ action: "status" });
        return r.ok ? (r.generation ?? "") : "";
      });
    const before = await generation();
    // Settings hides the isolated preview; closing it reopens the same version.
    await goTo(f.shell, "设置");
    await closeSettings(f.shell);
    await expect.poll(generation).not.toBe("");
    expect(await generation()).not.toBe(before);
    await expect
      .poll(() => frame.getAttribute("data-height-mode"))
      .toBe("natural");
    expect(await frame.evaluate((e) => e.clientHeight)).toBe(height);
    expect(await body.evaluate((e) => e.scrollTop)).toBe(bottom);
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

test("widget sizing: retained panel widgets start after either data and connection order without recreating on reconnect", async ({}, info) => {
  for (const order of ["connection-first", "snapshot-first"]) {
    const f = await setup(true, order);
    try {
      for (const w of f.widgets)
        await isolated(f.app, f.shell, `formal:${w.id}`);
      const panelEvent = f.app.waitForEvent("window");
      await f.app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()!
          .items[0].submenu!.items.find((i) => i.label === "打开菜单栏面板")!
          .click(),
      );
      const panel = await panelEvent;
      await expect
        .poll(() =>
          f.app.evaluate(
            () =>
              (
                globalThis as unknown as {
                  panelConnectionGate: { held: boolean };
                }
              ).panelConnectionGate.held,
          ),
        )
        .toBe(true);
      await expect(panel.locator("[data-formal-widget]")).toHaveCount(2);
      await expect
        .poll(() =>
          f.app.evaluate(({ BrowserWindow }) => {
            const owner = BrowserWindow.getAllWindows().find(
              (w) => !w.isResizable(),
            );
            return owner?.isVisible();
          }),
        )
        .toBe(true);
      const before = await panel.evaluate(
        async (widgets) => ({
          connected: !document.querySelector(".service-error"),
          slots: await Promise.all(
            widgets.map((w) =>
              window.desktop.widgetControl({
                action: "status",
                slot: `formal:${w.id}`,
              }),
            ),
          ),
        }),
        f.widgets,
      );
      expect(before.connected).toBe(order === "connection-first");
      if (order === "snapshot-first")
        expect(before.slots.every((r) => r.ok && !r.generation)).toBe(true);
      await info.attach(`${order}-before`, {
        body: JSON.stringify(before),
        contentType: "application/json",
      });
      await f.app.evaluate(({ app }) =>
        app.emit("test-panel-connection-release"),
      );
      await expect(panel.locator(".service-error")).toHaveCount(0);
      const views = await Promise.all(
        f.widgets.map((w) => isolated(f.app, panel, `formal:${w.id}`)),
      );
      const urls = views.map((v) => v.url());
      await views[0].getByLabel("备注").fill("重连保留");
      const ownerId = await panel.evaluate(() => window.desktop.surface);
      expect(ownerId).toBe("panel");
      // Real trusted bridge notifications, without replacing the bridge or renderer.
      for (const connected of [false, true]) {
        await f.app.evaluate(({ BrowserWindow }, connected) => {
          const owner = BrowserWindow.getAllWindows().find(
            (w) => !w.isResizable(),
          )!;
          owner.webContents.send("business:status", {
            connected,
            message: connected ? "" : "测试连接恢复",
          });
        }, connected);
        await expect(panel.locator(".service-error")).toHaveCount(
          connected ? 0 : 1,
        );
      }
      for (let i = 0; i < f.widgets.length; i++) {
        const same = await isolated(f.app, panel, `formal:${f.widgets[i].id}`);
        expect(same.url()).toBe(urls[i]);
      }
      await expect(views[0].getByLabel("备注")).toHaveValue("重连保留");
    } catch (error) {
      await info.attach(`${order}-failure-state`, {
        body: JSON.stringify(
          await f.app.evaluate(async ({ BrowserWindow }) => {
            const owner = BrowserWindow.getAllWindows().find(
              (w) => !w.isResizable(),
            )!;
            function tree(v: Electron.View): unknown {
              return {
                bounds: v.getBounds(),
                visible: v.getVisible(),
                children: v.children.map(tree),
              };
            }
            return {
              owner: {
                id: owner.id,
                visible: owner.isVisible(),
                bounds: owner.getBounds(),
                focusable: owner.isFocusable(),
                opacity: owner.getOpacity(),
              },
              tree: tree(owner.contentView),
              renderer: await owner.webContents.executeJavaScript(
                `(async () => ({ surface: window.desktop.surface, connected: !document.querySelector(".service-error"), frames: [...document.querySelectorAll("[data-formal-widget]")].map(e => ({id:e.dataset.formalWidget, text:e.innerText})), slots: await Promise.all([...document.querySelectorAll("[data-formal-widget]")].map(e => window.desktop.widgetControl({action:"status",slot:"formal:"+e.dataset.formalWidget}))) }))()`,
              ),
            };
          }),
        ),
        contentType: "application/json",
      });
      throw error;
    } finally {
      await f.close();
    }
  }
});

// mac-feature-t53 (repo:KB-16, OD-01 A): the card action overlay is one row at every card width.
/** A timer whose large reading sits at the very top of the widget, as in the reported card. */
const overlayTimer = (name: string) =>
  JSON.stringify({
    schemaVersion: 1,
    name,
    view: {
      html: `<main><p id="clock">25:00</p><p>专注时段</p><button id="start">开始</button></main>`,
      css: `:root{color-scheme:light dark}body{margin:0;background:light-dark(${light.surface},${dark.surface});color:light-dark(${light.text},${dark.text});font:16px system-ui}main{padding:16px}#clock{font-size:48px;line-height:1.2;margin:0;font-variant-numeric:tabular-nums}button{padding:8px;font:inherit}`,
      js: "",
    },
    config: [],
    draftFields: [],
    capabilities: [],
    resources: [],
  });
/** Padding 12 + one 32-point action row + padding 12 + the 1-point bottom border. */
const OVERLAY_ROW = 57;
/** Below this overlay content width (overlay width minus 2 × 12 padding) the actions show as icons
    (the container query in widget-studio.css). */
const OVERLAY_ICONS_BELOW = 440;

async function overlaySetup() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/card-overlay-"));
  const ids = [
    seedWidgetCandidate(
      root,
      false,
      overlayTimer("一个名字很长很长的番茄钟控件，用来核对单行省略"),
    ),
    seedWidgetCandidate(root, false, overlayTimer("番茄钟")),
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
  const shell = await app.firstWindow();
  await goTo(shell, "控件");
  return {
    app,
    shell,
    widgets,
    async close() {
      await closeLocal(app);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The first card's overlay, frame and reading in host coordinates, and the native view's clip top. */
async function overlayGeometry(
  app: ElectronApplication,
  shell: Page,
  view: Page,
) {
  const host = await shell.evaluate(() => {
    const card = document.querySelector<HTMLElement>("[data-formal-widget]")!;
    const controls = card.querySelector<HTMLElement>(
      ".widget-formal-controls",
    )!;
    const frame = card.querySelector<HTMLElement>(".widget-frame")!;
    const box = controls.getBoundingClientRect();
    const children = [...controls.children].map((e) => {
      const r = e.getBoundingClientRect();
      return {
        tag: e.tagName,
        middle: (r.top + r.bottom) / 2,
        right: r.right,
        width: r.width,
        scroll: (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth,
      };
    });
    const texts = [...controls.querySelectorAll(".widget-control-text")].map(
      (e) => getComputedStyle(e).display !== "none",
    );
    const icons = [
      ...controls.querySelectorAll(".widget-control-action svg"),
    ].map((e) => getComputedStyle(e).display !== "none");
    const f = frame.getBoundingClientRect();
    return {
      opacity: getComputedStyle(controls).opacity,
      top: box.top,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
      left: f.left + frame.clientLeft,
      controlsLeft: box.left,
      frameTop: f.top + frame.clientTop,
      children,
      texts,
      icons,
    };
  });
  const clip = await app.evaluate(({ BrowserWindow }, left) => {
    const boxes = BrowserWindow.getAllWindows()[0]
      .contentView.children.filter((root) => root.getVisible())
      .map((root) => {
        let view: Electron.View = root,
          x = 0,
          y = 0,
          b = { x: -1e9, y: -1e9 };
        for (let depth = 0; depth < 4; depth++, view = view.children[0]) {
          const r = view.getBounds();
          x += r.x;
          y += r.y;
          b = { x: Math.max(b.x, x), y: Math.max(b.y, y) };
        }
        return b;
      });
    return boxes.sort((a, b) => Math.abs(a.x - left) - Math.abs(b.x - left))[0];
  }, host.left);
  const reading = await view
    .locator("#clock")
    .evaluate((e) => e.getBoundingClientRect().top);
  return {
    ...host,
    clipTop: clip.y,
    readingTop: host.frameTop + reading,
  };
}

test("widget sizing: the card action overlay stays one row at every card width and the native clip starts below it", async () => {
  const f = await overlaySetup();
  try {
    const seen: string[] = [];
    for (const [width, height, columns] of [
      [1180, 800, 2],
      [1440, 900, 2],
      [900, 680, 1],
      [1050, 700, 2],
    ] as const) {
      await requestSize(f.app, f.shell, width, height);
      const first = await isolated(f.app, f.shell, `formal:${f.widgets[0].id}`);
      await expect(first.locator("#clock")).toHaveText("25:00");
      const tops = await f.shell
        .locator("[data-formal-widget]")
        .evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect().top));
      expect(tops[0] === tops[1] ? 2 : 1, `${width}: columns`).toBe(columns);
      const card = f.shell.locator("[data-formal-widget]").first();
      const controls = card.locator(".widget-formal-controls");
      // At rest only the widget content shows and the native view starts at the frame.
      await f.shell.mouse.move(5, 5);
      await expect(controls).toHaveCSS("opacity", "0");
      await expect
        .poll(async () => {
          const g = await overlayGeometry(f.app, f.shell, first);
          return Math.abs(g.clipTop - Math.ceil(g.frameTop)) <= 1;
        }, `${width}: rest clip`)
        .toBe(true);
      for (const state of ["hover", "focus"] as const) {
        if (state === "hover") {
          const box = (await card.boundingBox())!;
          await f.shell.mouse.move(
            box.x + box.width / 2,
            box.y + box.height / 2,
          );
        } else {
          await f.shell.mouse.move(5, 5);
          await card.getByRole("button", { name: "打开控件" }).focus();
        }
        await expect(controls).toHaveCSS("opacity", "1");
        let g = await overlayGeometry(f.app, f.shell, first);
        await expect
          .poll(async () => {
            g = await overlayGeometry(f.app, f.shell, first);
            return Math.abs(g.clipTop - Math.ceil(g.bottom)) <= 1;
          }, `${width} ${state}: the native clip starts at the overlay bottom`)
          .toBe(true);
        const label = `${width} ${state} overlay ${g.width}`;
        expect(g.height, label).toBe(OVERLAY_ROW);
        for (const child of g.children)
          expect(
            Math.abs(child.middle - g.children[0].middle),
            label,
          ).toBeLessThan(1);
        expect(
          Math.max(...g.children.map((c) => c.right)),
          label,
        ).toBeLessThanOrEqual(g.controlsLeft + g.width);
        // The overlay covers at most its own row of the widget top.
        expect(g.bottom - g.readingTop, label).toBeLessThanOrEqual(OVERLAY_ROW);
        const icons = g.width - 24 < OVERLAY_ICONS_BELOW;
        expect(g.texts, label).toEqual(g.texts.map(() => !icons));
        expect(g.icons, label).toEqual(g.icons.map(() => icons));
        seen.push(icons ? "icons" : "text");
        // The long name and the status are truncated on one line; their full text stays in title.
        expect(g.children[0].scroll, label).toBe(true);
        // The short status stays whole beside the truncated name.
        expect(g.children[1].scroll, label).toBe(false);
        expect(g.children[1].width, label).toBeGreaterThan(40);
        await expect(controls.locator("h2")).toHaveAttribute(
          "title",
          "一个名字很长很长的番茄钟控件，用来核对单行省略",
        );
        await expect(controls.locator("p")).toHaveAttribute(
          "title",
          "已保留 · 版本 1",
        );
        for (const name of ["打开控件", "新建修改草稿"])
          await expect(
            controls.getByRole("button", { name, exact: true }),
          ).toHaveAttribute("title", name);
        await expect(controls.locator("label")).toHaveAttribute(
          "title",
          "选择修改",
        );
        if (state === "focus")
          await card.getByRole("button", { name: "打开控件" }).blur();
      }
    }
    expect(seen).toContain("icons");
    expect(seen).toContain("text");
  } finally {
    await f.close();
  }
});

test("widget sizing: a widget retained through the editor shows only its content when the pointer is away", async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/card-overlay-new-"));
  seedWidgetCandidate(root, false, overlayTimer("番茄钟"));
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
  });
  const shell = await app.firstWindow();
  try {
    await requestSize(app, shell, 1180, 800);
    await goTo(shell, "控件");
    await shell.getByRole("button", { name: "保留控件", exact: true }).click();
    await shell.getByRole("button", { name: "确认保留", exact: true }).click();
    await expect(
      shell.getByText("已保留到控件。编辑历史继续保存。"),
    ).toBeVisible();
    await shell.getByRole("button", { name: "返回控件草稿" }).click();
    await goTo(shell, "控件");
    await expect(shell.locator("[data-formal-widget]")).toHaveCount(1);
    await shell.mouse.move(5, 5);
    await expect(shell.locator(".widget-formal-controls")).toHaveCSS(
      "opacity",
      "0",
    );
  } finally {
    await closeLocal(app);
    rmSync(root, { recursive: true, force: true });
  }
});
