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
import { ready } from "./shell";

/*
 * mac-feature-t12 V-15 (WB-03), scheduled foreground only. The real menu bar icon, its native menu, the native
 * quit confirmation, a real pointer over the panel's native widget views and the input method the person has
 * selected, driven by macOS HID events posted through Core Graphics (tests/desktop/widget-order-input.m). Posting
 * needs the Accessibility permission for the process that runs this test; the test only reads it. The application
 * runs from tests/desktop/native-tray-main.cjs on a disposable data root; no installed copy and no system setting
 * is touched, and the input source is only read.
 */
const PANEL = "菜单栏面板";
const MAIN = "青鸾";
type Point = { x: number; y: number };
type Reply = {
  postEventAccess?: boolean;
  accessibilityTrusted?: number;
  windows?: { bounds: Record<string, number>; layer: number }[];
};

function gate() {
  if (
    process.env.CSTHINK_NATIVE_TESTS !== "1" ||
    process.env.CSTHINK_MENUBAR_PANEL_NATIVE_AUTHORIZED !== "1"
  )
    throw new Error(
      "NOT RUN: scheduled menu bar panel foreground authorization required",
    );
}
function inputHelper(log: unknown[]) {
  mkdirSync(".test-data/disposable", { recursive: true });
  const out = resolve(".test-data/disposable/menubar-panel-input");
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
  const input = (...args: (string | number)[]) => {
    const r = spawnSync(
      out,
      args.map((a) => String(Math.round(Number(a)) || a)),
      { encoding: "utf8" },
    );
    const reply = {
      args,
      exit: r.status,
      ...(JSON.parse(r.stdout || "{}") as object),
    };
    log.push(reply);
    if (r.status !== 0) throw new Error(`input helper refused: ${r.stdout}`);
    return reply as Reply;
  };
  const permission = input("info");
  if (!permission.postEventAccess || !permission.accessibilityTrusted)
    throw new Error(
      "NOT RUN: posting real input needs the Accessibility and post event permissions for the process running this test; the test does not request them",
    );
  return input;
}
const KEY = { down: 125, ret: 36, esc: 53, tab: 48, space: 49 };
async function launch(names: string[]) {
  mkdirSync(".test-data/disposable", { recursive: true });
  const data = mkdtempSync(resolve(".test-data/disposable/native-panel-"));
  const ids = seedRetainedWidgets(data, names).map((w: { id: string }) => w.id);
  const app = await _electron.launch({
    args: [
      resolve("tests/desktop/native-tray-main.cjs"),
      `--data-root=${data}`,
    ],
  });
  const main = await app.firstWindow();
  await ready(main);
  // The main window stands on a display other than the menu bar icon's, so the panel never covers it.
  await app.evaluate(({ BrowserWindow, screen }) => {
    const tray = (globalThis as unknown as { nativeTray: Electron.Tray })
      .nativeTray;
    const icon = screen.getDisplayMatching(tray.getBounds());
    const other = screen.getAllDisplays().find((d) => d.id !== icon.id) ?? icon;
    const w = BrowserWindow.getAllWindows().find(
      (w) => w.getTitle() === "青鸾",
    )!;
    w.setBounds({
      x: other.workArea.x + (other.id === icon.id ? 0 : 40),
      y: other.workArea.y + 40,
      width: 1180,
      height: 800,
    });
  });
  return { app, main, data, ids };
}
async function close(app: ElectronApplication) {
  await app.evaluate(({ app, BrowserWindow, ipcMain }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.removeAllListeners("close");
      ipcMain.emit(
        "window:dirty",
        { sender: w.webContents, senderFrame: w.webContents.mainFrame },
        false,
      );
    }
    app.removeAllListeners("before-quit");
  });
  await app.close();
}
const trayCentre = (app: ElectronApplication) =>
  app.evaluate(() => {
    const b = (
      globalThis as unknown as { nativeTray: Electron.Tray }
    ).nativeTray.getBounds();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
const windowState = (app: ElectronApplication) =>
  app.evaluate(({ app, BrowserWindow }) => ({
    active: app.isActive(),
    windows: BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed())
      .map((w) => ({
        title: w.getTitle(),
        visible: w.isVisible(),
        focused: w.isFocused(),
      })),
  }));
const panelVisible = async (app: ElectronApplication) =>
  (await windowState(app)).windows.some((w) => w.title === PANEL && w.visible);
async function panelPage(app: ElectronApplication) {
  let page: Page | undefined;
  await expect
    .poll(async () => {
      for (const p of app.windows())
        if (!p.isClosed() && (await p.title().catch(() => "")) === PANEL) {
          page = p;
          return true;
        }
      return false;
    })
    .toBe(true);
  await expect(page!.getByRole("heading", { level: 1 })).toHaveText("控件");
  return page!;
}
/** The centre (or a relative point) of an element of a window's page, in global display points. */
async function onScreen(
  app: ElectronApplication,
  page: Page,
  title: string,
  selector: string,
  at = { x: 0.5, y: 0.5 },
): Promise<
  Point & { box: { x: number; y: number; width: number; height: number } }
> {
  const box = (await page.locator(selector).first().boundingBox())!;
  const content = await app.evaluate(
    ({ BrowserWindow }, title) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === title)!
        .getContentBounds(),
    title,
  );
  return {
    x: content.x + box.x + box.width * at.x,
    y: content.y + box.y + box.height * at.y,
    box,
  };
}
async function widgetView(app: ElectronApplication, owner: Page, id: string) {
  let generation = "";
  await expect
    .poll(async () => {
      const r = await owner.evaluate(
        (slot) => window.desktop.widgetControl({ action: "status", slot }),
        `formal:${id}`,
      );
      generation = r.ok && r.generation ? r.generation : "";
      return generation;
    })
    .not.toBe("");
  const url = `csthink-widget://${generation}/index.html`;
  await expect
    .poll(() =>
      app
        .context()
        .pages()
        .some((p) => p.url() === url),
    )
    .toBe(true);
  return app
    .context()
    .pages()
    .find((p) => p.url() === url)!;
}
let hitProbe = "";
/** The view AppKit gives a mouse event at a global point of the panel window (read-only probe). */
async function hitAt(app: ElectronApplication, point: Point) {
  if (!hitProbe) {
    const build = mkdtempSync(
      resolve(".test-data/disposable/panel-hit-probe-"),
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
      const w = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === "菜单栏面板",
      )!;
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
      ) as { class: string; width: number };
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
const settle = () => new Promise((done) => setTimeout(done, 400));

test("native panel: the real menu bar icon shows and hides the panel, an outside click and the main window take it away, its native menu has two items and opens the existing main window, and quitting with unsaved input keeps the native confirmation and its cancel", async ({}, info) => {
  gate();
  const inputs: unknown[] = [];
  const input = inputHelper(inputs);
  test.setTimeout(240_000);
  const { app } = await launch(["便笺", "计时"]);
  const steps: Record<string, unknown>[] = [];
  const step = async (label: string) =>
    steps.push({ label, ...(await windowState(app)) });
  try {
    const pid = app.process().pid!;
    const tray = await trayCentre(app);
    // 1. A real click on the icon shows the panel, which takes the keyboard; a second click hides it.
    input("click", tray.x, tray.y);
    await expect.poll(() => panelVisible(app)).toBe(true);
    await panelPage(app);
    await expect
      .poll(
        async () =>
          (await windowState(app)).windows.find((w) => w.title === PANEL)
            ?.focused,
      )
      .toBe(true);
    await step("icon click shows the panel");
    await settle();
    input("click", tray.x, tray.y);
    await expect.poll(() => panelVisible(app)).toBe(false);
    await step("second icon click hides the panel");
    // 2. Panel to main window: a real click on the main window hides the panel and the main window takes the keys.
    await settle();
    input("click", tray.x, tray.y);
    await expect.poll(() => panelVisible(app)).toBe(true);
    const mainBounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "青鸾")!
        .getContentBounds(),
    );
    await settle();
    input("click", mainBounds.x + mainBounds.width / 2, mainBounds.y + 200);
    await expect.poll(() => panelVisible(app)).toBe(false);
    await expect
      .poll(
        async () =>
          (await windowState(app)).windows.find((w) => w.title === MAIN)
            ?.focused,
      )
      .toBe(true);
    await step("outside click on the main window");
    // 3. Main window to panel: the icon gives the keys to the panel; the main window stays open, unfocused.
    await settle();
    input("click", tray.x, tray.y);
    await expect.poll(() => panelVisible(app)).toBe(true);
    await expect
      .poll(async () => {
        const s = await windowState(app);
        return [
          s.windows.find((w) => w.title === PANEL)?.focused,
          s.windows.find((w) => w.title === MAIN)?.focused,
        ];
      })
      .toEqual([true, false]);
    await step("icon click from the main window");
    // 4. The native right-click menu: exactly 打开主窗口 and 退出 青鸾 (recorded as the main process builds it);
    //    choosing the first one with real keys activates the existing main window.
    await app.evaluate(({ Menu }) => {
      const built: string[][] = [];
      (globalThis as unknown as { builtMenus: string[][] }).builtMenus = built;
      const original = Menu.buildFromTemplate;
      Menu.buildFromTemplate = (template) => {
        built.push(template.map((i) => String(i.label ?? "")));
        return original(template);
      };
    });
    await settle();
    const before = input("windows", pid).windows!.length;
    input("rightclick", tray.x, tray.y);
    await settle();
    const tracking = input("windows", pid).windows!;
    input("key", KEY.down);
    input("key", KEY.ret);
    await expect
      .poll(
        async () =>
          (await windowState(app)).windows.find((w) => w.title === MAIN)
            ?.focused,
      )
      .toBe(true);
    const built = await app.evaluate(
      () => (globalThis as unknown as { builtMenus: string[][] }).builtMenus,
    );
    expect(built).toEqual([["打开主窗口", `退出 ${MAIN}`]]);
    expect(
      tracking.length,
      "the native menu is on screen while it tracks",
    ).toBeGreaterThan(before);
    expect(
      (await windowState(app)).windows.filter((w) => w.title === MAIN),
    ).toHaveLength(1);
    await step("native menu opens the existing main window");
    // 5. Quitting from the menu with unsaved input shows the native confirmation on the main window; Escape is
    //    取消退出, and the application, its windows and the unsaved state stay.
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      const w = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === "青鸾",
      )!;
      ipcMain.emit(
        "window:dirty",
        { sender: w.webContents, senderFrame: w.webContents.mainFrame },
        true,
      );
    });
    await settle();
    const withoutSheet = input("windows", pid).windows!.length;
    input("rightclick", tray.x, tray.y);
    await settle();
    input("key", KEY.down);
    input("key", KEY.down);
    input("key", KEY.ret);
    await settle();
    await settle();
    const withSheet = input("windows", pid).windows!;
    expect(
      withSheet.length,
      "the native quit confirmation is on screen",
    ).toBeGreaterThan(withoutSheet);
    await info.attach("windows-with-confirmation", {
      body: JSON.stringify(withSheet),
      contentType: "application/json",
    });
    input("key", KEY.esc);
    await settle();
    await expect
      .poll(() => input("windows", pid).windows!.length)
      .toBe(withoutSheet);
    expect(app.process().exitCode).toBeNull();
    const after = await windowState(app);
    expect(after.windows.filter((w) => w.title === MAIN)).toHaveLength(1);
    await step("quit cancelled");
    // The application did not start quitting: the icon still opens the panel.
    input("click", tray.x, tray.y);
    await expect.poll(() => panelVisible(app)).toBe(true);
    await step("icon after cancel");
  } finally {
    await info.attach("steps", {
      body: JSON.stringify(steps, null, 1),
      contentType: "application/json",
    });
    await info.attach("input-events", {
      body: JSON.stringify(inputs, null, 1),
      contentType: "application/json",
    });
    await close(app);
  }
});

test("native panel: a real pointer drags a widget's grip across the panel's native widget views and drops it after the card under the lower half, and the keys stay with the panel", async ({}, info) => {
  gate();
  const inputs: unknown[] = [];
  const input = inputHelper(inputs);
  test.setTimeout(240_000);
  const { app, data, ids } = await launch(["甲", "乙", "丙"]);
  const focus: Record<string, unknown>[] = [];
  try {
    const tray = await trayCentre(app);
    input("click", tray.x, tray.y);
    await expect.poll(() => panelVisible(app)).toBe(true);
    const panel = await panelPage(app);
    await widgetView(app, panel, ids[0]);
    await widgetView(app, panel, ids[1]);
    const toggle = await onScreen(
      app,
      panel,
      PANEL,
      ".widget-studio-heading button[aria-pressed]",
    );
    input("click", toggle.x, toggle.y);
    await expect(panel.locator(".widget-layout-note")).toBeVisible();
    // A taller panel, within its display, shows the second card whole, so the lower half of its widget view is
    // on screen (the panel has a minimum size, no maximum).
    const height = await app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === "菜单栏面板",
      )!;
      const area = screen.getDisplayMatching(w.getBounds()).workArea;
      const height = Math.min(
        1000,
        area.y + area.height - w.getBounds().y - 20,
      );
      w.setSize(420, height);
      return height;
    });
    await expect.poll(() => panel.evaluate(() => innerHeight)).toBe(height);
    const grip = `[data-formal-widget="${ids[0]}"] .widget-order-grip`;
    let settled = "";
    await expect
      .poll(async () => {
        const box = JSON.stringify(await panel.locator(grip).boundingBox());
        const same = box === settled;
        settled = box;
        return same;
      })
      .toBe(true);
    const from = await onScreen(app, panel, PANEL, grip);
    const target = await onScreen(
      app,
      panel,
      PANEL,
      `[data-formal-widget="${ids[1]}"] .widget-frame`,
      { x: 0.4, y: 0 },
    );
    const viewport = await onScreen(app, panel, PANEL, ".viewport", {
      x: 0,
      y: 1,
    });
    const card = await onScreen(
      app,
      panel,
      PANEL,
      `[data-formal-widget="${ids[1]}"]`,
      { x: 0, y: 0.5 },
    );
    const to = {
      x: target.x,
      y: Math.min(target.y + target.box.height * 0.85, viewport.y - 12),
    };
    const hits = { from: await hitAt(app, from), to: await hitAt(app, to) };
    await info.attach("drag-geometry", {
      body: JSON.stringify({
        from,
        to,
        cardMiddle: card.y,
        viewportBottom: viewport.y,
        hits,
      }),
      contentType: "application/json",
    });
    expect(
      to.y,
      "the drop point is in the lower half of the second card",
    ).toBeGreaterThan(card.y);
    expect(hits.from.class).toBe("RenderWidgetHostViewCocoa");
    expect(hits.from.width).toBe(420);
    expect(hits.to.class).toBe("RenderWidgetHostViewCocoa");
    expect(hits.to.width).toBeLessThan(420);
    input("drag", from.x, from.y, to.x, to.y, 24);
    await expect
      .poll(() => stored(data), { timeout: 10_000 })
      .toEqual(["乙", "甲", "丙"]);
    await expect(panel.locator(".widget-order-announce")).toHaveText(
      "「甲」已移到第 2 位",
    );
    const keys = async (label: string) => {
      const state = await app.evaluate(({ BrowserWindow, webContents }) => {
        const owner = BrowserWindow.getAllWindows().find(
          (w) => w.getTitle() === "菜单栏面板",
        )!;
        const focused = webContents.getFocusedWebContents();
        return {
          keyWindow: BrowserWindow.getFocusedWindow()?.id === owner.id,
          host: focused?.id === owner.webContents.id,
        };
      });
      const entry = {
        label,
        ...state,
        active: await panel.evaluate(
          () =>
            document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.tagName,
        ),
      };
      focus.push(entry);
      return entry;
    };
    await expect.poll(async () => (await keys("after drop")).host).toBe(true);
    expect((await keys("after drop, settled")).active).toMatch(/^控件 甲 /);
    // Without a click: a real Tab reaches 前移 of 甲 and a real Space moves it back to the first place.
    input("key", KEY.tab);
    const earlier = panel.getByRole("button", { name: /^前移 甲 / });
    await expect(earlier).toBeFocused();
    expect((await keys("before space")).host).toBe(true);
    input("key", KEY.space);
    await expect.poll(() => stored(data)).toEqual(["甲", "乙", "丙"]);
    await expect(panel.locator(".widget-order-announce")).toHaveText(
      "「甲」已移到第 1 位",
    );
    expect(await panelVisible(app)).toBe(true);
  } finally {
    await info.attach("keyboard-focus", {
      body: JSON.stringify(focus, null, 1),
      contentType: "application/json",
    });
    await info.attach("input-events", {
      body: JSON.stringify(inputs, null, 1),
      contentType: "application/json",
    });
    await close(app);
  }
});

test("native panel: the selected Chinese input method composes in a panel widget's field opened from the application menu, the chosen word is what is kept, and the panel does not act on the composing keys", async ({}, info) => {
  gate();
  const inputs: unknown[] = [];
  const input = inputHelper(inputs);
  test.setTimeout(240_000);
  // Read only: the input source the person has selected. The test never switches it.
  const source = spawnSync(
    "defaults",
    ["read", "com.apple.HIToolbox", "AppleSelectedInputSources"],
    {
      encoding: "utf8",
    },
  ).stdout;
  await info.attach("selected-input-source", {
    body: source,
    contentType: "text/plain",
  });
  const { app, data, ids } = await launch(["随手记"]);
  try {
    // The panel opens through the application menu item 打开菜单栏面板, clicked by the main process: the
    // icon itself is checked by the first test, and this one must not depend on which display's menu bar holds
    // the icon. Everything typed afterwards is real keyboard input through the selected input method.
    await app.evaluate(({ Menu, app }) => {
      Menu.getApplicationMenu()!
        .items[0].submenu!.items.find((i) => i.label === "打开菜单栏面板")!
        .click();
      app.focus({ steal: true });
    });
    await expect.poll(() => panelVisible(app)).toBe(true);
    const panel = await panelPage(app);
    await expect
      .poll(
        async () =>
          (await windowState(app)).windows.find((w) => w.title === PANEL)
            ?.focused,
      )
      .toBe(true);
    const view = await widgetView(app, panel, ids[0]);
    const field = view.getByLabel("随手记");
    await expect(field).toBeVisible();
    // Observation only: composition events, every input event with whether it came during a composition, and
    // each text of the widget's own status line, in order.
    await view.evaluate(() => {
      const events: string[] = [];
      const start = performance.now();
      const at = () => Math.round(performance.now() - start);
      (window as unknown as { imeEvents: string[] }).imeEvents = events;
      for (const type of ["compositionstart", "compositionend", "keydown"])
        document.addEventListener(type, (e) =>
          events.push(
            `${at()} ${type}:${(e as CompositionEvent).data ?? (e as KeyboardEvent).key}`,
          ),
        );
      document.addEventListener("input", (e) =>
        events.push(
          `${at()} input:${(e as InputEvent).inputType}:${(e as InputEvent).isComposing ? "composing" : "committed"}:${(e.target as HTMLTextAreaElement).value}`,
        ),
      );
      const status = document.querySelector("[role=status]");
      if (status)
        new MutationObserver(() =>
          events.push(`${at()} status:${status.textContent}`),
        ).observe(status, {
          childList: true,
          characterData: true,
          subtree: true,
        });
    });
    const box = (await field.boundingBox())!;
    const frame = await onScreen(
      app,
      panel,
      PANEL,
      `[data-formal-widget="${ids[0]}"] .widget-frame`,
      { x: 0, y: 0 },
    );
    input(
      "click",
      frame.x + box.x + box.width / 2,
      frame.y + box.y + box.height / 2,
    );
    await expect(field).toBeFocused();
    const order = stored(data);
    for (const code of [45, 34, 4, 0, 31]) input("key", code); // n i h a o
    await settle();
    const composing = await view.evaluate(() =>
      (window as unknown as { imeEvents: string[] }).imeEvents.slice(),
    );
    if (!composing.some((e) => e.startsWith("compositionstart")))
      throw new Error(
        `NOT RUN: the selected input method produced no composition for real key presses (it is in a Latin mode); switching it would change a setting. Events: ${JSON.stringify(composing)}`,
      );
    input("key", KEY.space); // choose the first candidate
    await settle();
    const value = await field.inputValue();
    const events = await view.evaluate(() =>
      (window as unknown as { imeEvents: string[] }).imeEvents.slice(),
    );
    const storedDrafts = (() => {
      const db = new DatabaseSync(join(data, "state.sqlite"), {
        readOnly: true,
      });
      try {
        return (
          db.prepare("SELECT drafts FROM widget_previews").all() as {
            drafts: string;
          }[]
        ).map((r) => JSON.parse(r.drafts));
      } finally {
        db.close();
      }
    })();
    await info.attach("stored-drafts", {
      body: JSON.stringify(storedDrafts, null, 1),
      contentType: "application/json",
    });
    await info.attach("ime", {
      body: JSON.stringify({ value, events }, null, 1),
      contentType: "application/json",
    });
    expect(value).toMatch(/[一-鿿]/);
    expect(value).not.toMatch(/[a-z]/);
    expect(events.some((e) => e.startsWith("compositionend"))).toBe(true);
    // The panel itself did nothing with the keys: same order, still open, no menu, no notice.
    expect(stored(data)).toEqual(order);
    expect(await panelVisible(app)).toBe(true);
    await expect(panel.getByRole("menu")).toHaveCount(0);
    await expect(panel.locator(".widget-order-notice")).toHaveCount(0);
    // The chosen word is what the widget keeps.
    await expect(view.getByRole("status")).toHaveText("草稿已确认保存");
    await expect
      .poll(() => {
        const db = new DatabaseSync(join(data, "state.sqlite"), {
          readOnly: true,
        });
        try {
          return (
            db.prepare("SELECT drafts FROM widget_previews").all() as {
              drafts: string;
            }[]
          ).some((r) => r.drafts.includes(JSON.stringify(value).slice(1, -1)));
        } finally {
          db.close();
        }
      })
      .toBe(true);
  } finally {
    await info.attach("input-events", {
      body: JSON.stringify(inputs, null, 1),
      contentType: "application/json",
    });
    await close(app);
  }
});
