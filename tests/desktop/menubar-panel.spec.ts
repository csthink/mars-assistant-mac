import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  seedRetainedWidgets,
  seedWidgetCandidate,
} from "./widget-generation-fixture";
import { launchLocal, closeLocal } from "./local-client";
import { Store } from "../../src/service/store";
import { goTo } from "./shell";
import { widgetStaleMessage } from "../../src/shared/widget-ui";

// mac-feature-t12 (WB-03, OD-168/OD-169): the menu bar panel shows the retained widgets, their own light
// interactions and their order; everything else happens in the main window, opened on the same object.

function root() {
  mkdirSync(".test-data/disposable", { recursive: true });
  return mkdtempSync(resolve(".test-data/disposable/menubar-panel-"));
}
const shown = (page: Page) =>
  page
    .locator("[data-formal-widget]")
    .evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-formal-widget")),
    );
const stored = (dir: string) => {
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  try {
    return (
      db.prepare("SELECT id FROM saved_widgets ORDER BY position").all() as {
        id: string;
      }[]
    ).map((r) => r.id);
  } finally {
    db.close();
  }
};
const card = (page: Page, id: string) =>
  page.locator(`[data-formal-widget="${id}"]`);
/** The panel window: the product page whose title is the panel's, apart from the main window. */
async function openPanel(app: ElectronApplication, main: Page) {
  await app.evaluate(({ app }) => app.emit("test-tray-click"));
  let panel: Page | undefined;
  await expect
    .poll(async () => {
      for (const p of app.windows())
        if (
          p !== main &&
          !p.isClosed() &&
          p.url().startsWith("file:") &&
          (await p.title().catch(() => "")) === "菜单栏面板"
        ) {
          panel = p;
          return true;
        }
      return false;
    })
    .toBe(true);
  await expect(panel!.getByRole("heading", { level: 1 })).toHaveText("控件");
  return panel!;
}
/** Hides the panel the way a second click on the menu bar icon does; its window and widget views go. */
async function hidePanel(app: ElectronApplication, panel: Page) {
  await app.evaluate(({ app }) => app.emit("test-tray-click"));
  await expect.poll(() => panel.isClosed()).toBe(true);
}
/** The native view of one retained widget card in a window. */
async function widgetView(app: ElectronApplication, owner: Page, id: string) {
  let generation = "";
  await expect
    .poll(async () => {
      const reply = await owner.evaluate(
        (slot) => window.desktop.widgetControl({ action: "status", slot }),
        `formal:${id}`,
      );
      generation = reply.ok && reply.generation ? reply.generation : "";
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
const mainWindows = (app: ElectronApplication) =>
  app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        (w) => !w.isDestroyed() && w.getTitle() === "青鸾",
      ).length,
  );
/** Words of management, asking and settings that no panel control may carry (WB-03). */
const managementWords = [
  "对话",
  "聊天",
  "新建",
  "生成",
  "草稿",
  "修改",
  "预览",
  "保留",
  "设置",
  "删除",
  "恢复",
  "授权",
  "待处理",
  "运行记录",
  "搜索",
  "模型",
  "Coding",
];

test("menu bar panel: only retained widgets, ordered by menu, keyboard, layout edit and drag in agreement with the main window, opening the main window on the same widget, and drafts never shown", async () => {
  const dir = root();
  const ids = seedRetainedWidgets(dir, ["天气", "便笺", "计时"]).map(
    (w) => w.id,
  );
  // A generated candidate the main window has not retained yet: a draft, never a panel widget.
  const candidate = seedWidgetCandidate(dir);
  const store = new Store(dir);
  try {
    expect(
      store.execute({ type: "selectWidgetDraft", id: null }, "main").ok,
    ).toBe(true);
  } finally {
    store.close();
  }
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${dir}`],
  });
  try {
    const main = await app.firstWindow();
    await goTo(main, "控件");
    await expect(main.locator("[data-formal-widget]")).toHaveCount(3);
    const panel = await openPanel(app, main);
    await expect(panel.locator("[data-formal-widget]")).toHaveCount(3);
    expect(await shown(panel)).toEqual(ids);
    await expect(panel.locator(".widget-studio-heading .quiet")).toHaveText(
      "3",
    );
    // One page: no navigation, no fields of its own, no management or conversation controls.
    await expect(
      panel.locator("nav, [role=tablist], [role=tab], input, textarea, select"),
    ).toHaveCount(0);
    // Every control a person can see or reach (CSS-hidden parts of the widget shell are neither).
    const controls = await panel
      .locator("button, a, [role=menuitem]")
      .evaluateAll((nodes) =>
        nodes
          .filter((n) => n.checkVisibility())
          .map((n) =>
            [
              n.textContent,
              n.getAttribute("aria-label"),
              n.getAttribute("title"),
            ].join(" "),
          ),
      );
    expect(
      controls.filter((c) => managementWords.some((w) => c.includes(w))),
    ).toEqual([]);
    expect(await panel.locator("body").innerText()).not.toContain("草稿");
    await expect(
      panel.getByRole("button", { name: "编辑布局", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "打开主窗口", exact: true }),
    ).toBeVisible();

    // The ⋯ menu by keyboard: 前移 / 后移 and 在主窗口打开; the first card's 前移 says why it is unavailable.
    await panel
      .getByRole("button", { name: `控件操作 天气 ${ids[0].slice(0, 8)}` })
      .focus();
    await panel.keyboard.press("Enter");
    const firstMenu = panel.getByRole("menu", { name: "控件操作：天气" });
    await expect(firstMenu.getByRole("menuitem")).toHaveText([
      "前移已在最前",
      "后移",
      "在主窗口打开",
    ]);
    await expect(firstMenu.getByRole("menuitem").first()).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await panel.keyboard.press("Escape");
    await expect(firstMenu).toHaveCount(0);
    await expect(
      panel.getByRole("button", {
        name: `控件操作 天气 ${ids[0].slice(0, 8)}`,
      }),
    ).toBeFocused();
    await panel
      .getByRole("button", { name: `控件操作 便笺 ${ids[1].slice(0, 8)}` })
      .focus();
    await panel.keyboard.press("Enter");
    await expect(
      panel.getByRole("menu", { name: "控件操作：便笺" }),
    ).toBeVisible();
    await panel.keyboard.press("Enter");
    const moved = [ids[1], ids[0], ids[2]];
    await expect.poll(() => shown(panel)).toEqual(moved);
    await expect(panel.locator(".widget-order-announce")).toContainText(
      "「便笺」已移到第 1 位",
    );
    await expect(
      panel.getByRole("button", {
        name: `控件操作 便笺 ${ids[1].slice(0, 8)}`,
      }),
    ).toBeFocused();
    await expect.poll(() => shown(main), { timeout: 2000 }).toEqual(moved);
    expect(stored(dir)).toEqual(moved);

    // 编辑布局 in the panel: 后移 keeps focus on the moved card's control; a drag reorders the same order.
    await panel.getByRole("button", { name: "编辑布局", exact: true }).click();
    await expect(
      panel.getByText(
        "拖动控件或用「前移 / 后移」调整顺序，立即生效，不需要保存。",
      ),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: `后移 便笺 ${ids[1].slice(0, 8)}` })
      .click();
    const stepped = [ids[0], ids[1], ids[2]];
    await expect.poll(() => shown(panel)).toEqual(stepped);
    await expect(
      panel.getByRole("button", { name: `后移 便笺 ${ids[1].slice(0, 8)}` }),
    ).toBeFocused();
    // One column: the upper half of a card puts the dragged card before it, the lower half after it.
    await panel.locator(".viewport").evaluate((v) => (v.scrollTop = 0));
    await card(panel, ids[1])
      .locator(".widget-order-grip")
      .dragTo(card(panel, ids[0]).locator(".widget-formal-controls"), {
        targetPosition: { x: 40, y: 16 },
      });
    const before = [ids[1], ids[0], ids[2]];
    await expect.poll(() => shown(panel)).toEqual(before);
    await expect.poll(() => shown(main), { timeout: 2000 }).toEqual(before);
    // A taller panel shows both cards whole, so the lower half of the second one is on screen.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "菜单栏面板")!
        .setSize(420, 1100),
    );
    await expect.poll(() => panel.evaluate(() => innerHeight)).toBe(1100);
    await panel.locator(".viewport").evaluate((v) => (v.scrollTop = 0));
    const target = (await card(panel, ids[0]).boundingBox())!;
    const lower = Math.min(
      target.height - 12,
      (await panel.evaluate(() => innerHeight)) - target.y - 12,
    );
    expect(lower).toBeGreaterThan(target.height / 2);
    await card(panel, ids[1])
      .locator(".widget-order-grip")
      .dragTo(card(panel, ids[0]), {
        targetPosition: { x: 40, y: lower },
      });
    const dragged = [ids[0], ids[1], ids[2]];
    await expect.poll(() => shown(panel)).toEqual(dragged);
    await expect(card(panel, ids[1])).toBeFocused();
    await expect.poll(() => shown(main), { timeout: 2000 }).toEqual(dragged);
    expect(stored(dir)).toEqual(dragged);
    await panel
      .getByRole("button", { name: "完成布局编辑", exact: true })
      .click();
    await panel.screenshot({ path: test.info().outputPath("panel.png") });

    // 在主窗口打开: the existing main window shows the same widget on its 控件 page.
    await goTo(main, "聊天");
    await panel
      .getByRole("button", { name: `控件操作 计时 ${ids[2].slice(0, 8)}` })
      .focus();
    await panel.keyboard.press("Enter");
    await panel
      .getByRole("menu", { name: "控件操作：计时" })
      .getByRole("menuitem", { name: "在主窗口打开" })
      .click();
    await expect(card(main, ids[2])).toBeFocused();
    expect(await mainWindows(app)).toBe(1);

    // The main window retains the generated candidate: it joins the panel at the end; the draft never did.
    const reply = await main.evaluate(async (candidateId) => {
      const snapshot = await new Promise<
        Parameters<Parameters<typeof window.desktop.subscribe>[0]>[0]
      >((done) => {
        const off = window.desktop.subscribe((s) => {
          off();
          done(s);
        });
      });
      const c = snapshot.widgetGeneration!.candidates.find(
        (c) => c.id === candidateId,
      )!;
      return window.desktop.command({
        type: "retainWidgetCandidate",
        candidateId: c.id,
        digest: c.digest,
        requirementRevision: c.requirementRevision,
      });
    }, candidate.candidateId);
    expect(reply.ok).toBe(true);
    await expect(panel.locator("[data-formal-widget]")).toHaveCount(4);
    expect((await shown(panel)).slice(0, 3)).toEqual(dragged);
    await expect(panel.locator(".widget-studio-heading .quiet")).toHaveText(
      "4",
    );
  } finally {
    await closeLocal(app);
  }
});

test("menu bar panel: without retained widgets the panel shows its empty state and opens the existing main window", async () => {
  const dir = root();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${dir}`],
  });
  try {
    const main = await app.firstWindow();
    await expect(main.getByRole("textbox", { name: "输入草稿" })).toBeVisible();
    const panel = await openPanel(app, main);
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText(
      "还没有控件",
    );
    await expect(
      panel.getByText("控件在主窗口创建，完成后会显示在这里。"),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "编辑布局", exact: true }),
    ).toHaveCount(0);
    await panel
      .locator(".empty")
      .getByRole("button", { name: "打开主窗口", exact: true })
      .click();
    await expect.poll(() => mainWindows(app)).toBe(1);
    await panel.screenshot({ path: test.info().outputPath("empty.png") });
  } finally {
    await closeLocal(app);
  }
});

test("menu bar panel: a stale input is refused, the widget shows the main window's newer text and the panel keeps the input to read or discard across hiding; the right-click menu offers two items and quitting keeps its confirmation and cancel", async () => {
  const dir = root();
  const [widget] = seedRetainedWidgets(dir, ["随手记"]);
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${dir}`],
  });
  try {
    const main = await app.firstWindow();
    await goTo(main, "控件");
    let panel = await openPanel(app, main);
    // Both views open on revision 0 of the draft field.
    let panelView = await widgetView(app, panel, widget.id);
    const mainView = await widgetView(app, main, widget.id);
    await expect(panelView.getByLabel("随手记")).toHaveValue("");
    await mainView.getByLabel("随手记").fill("主窗口已确认版本");
    await expect(mainView.getByRole("status")).toHaveText("草稿已确认保存");
    const failedURL = panelView.url();
    await panelView.getByLabel("随手记").fill("面板旧版本输入");
    await expect(panel.locator(".widget-save-status")).toHaveText(
      widgetStaleMessage,
    );
    // The view reopens on the newer saved text; the panel's input stays with the host.
    await expect.poll(() => panelView.isClosed()).toBe(true);
    panelView = await widgetView(app, panel, widget.id);
    expect(panelView.url()).not.toBe(failedURL);
    await expect(panelView.getByLabel("随手记")).toHaveValue(
      "主窗口已确认版本",
    );
    // The status says so where the person sees it: an alert under the widget, not hidden with the card's quiet ones.
    await expect(panel.locator(".widget-save-status")).toBeVisible();
    await expect(panel.locator(".widget-save-status")).toHaveClass(/error/);
    await expect(panel.locator(".widget-save-status")).toHaveAttribute(
      "role",
      "alert",
    );
    await panel
      .getByRole("button", { name: "查看未保存输入", exact: true })
      .click();
    await expect(panel.getByLabel("未保存的输入")).toHaveText("面板旧版本输入");
    await panel.screenshot({ path: test.info().outputPath("conflict.png") });

    // Hiding destroys the panel and its view; reopening reads the newer text and still offers the input.
    await hidePanel(app, panel);
    await expect.poll(() => panelView.isClosed()).toBe(true);
    panel = await openPanel(app, main);
    panelView = await widgetView(app, panel, widget.id);
    await expect(panelView.getByLabel("随手记")).toHaveValue(
      "主窗口已确认版本",
    );
    await expect(panel.locator(".widget-save-status")).toHaveText(
      widgetStaleMessage,
    );

    // The right-click menu: open the main window, or quit through the existing confirmation.
    await app.evaluate(({ app }) => app.emit("test-tray-right-click"));
    expect(
      await app.evaluate(
        () =>
          (globalThis as unknown as { testTray: { menus: string[][] } })
            .testTray.menus,
      ),
    ).toEqual([["打开主窗口", "退出 青鸾"]]);
    await app.evaluate(({ app }) => app.emit("test-tray-menu", "打开主窗口"));
    await expect.poll(() => mainWindows(app)).toBe(1);
    // The kept input counts as unsaved: quitting asks first, and cancelling keeps the application and panel.
    await app.evaluate(({ dialog }) => {
      const asked: string[] = [];
      (globalThis as unknown as { asked: string[] }).asked = asked;
      dialog.showMessageBox = (async (
        _owner: unknown,
        options: { message: string },
      ) => {
        asked.push(options.message);
        return { response: 0, checkboxChecked: false };
      }) as unknown as typeof dialog.showMessageBox;
    });
    await app.evaluate(({ app }) => app.emit("test-tray-right-click"));
    await app.evaluate(({ app }) => app.emit("test-tray-menu", "退出 青鸾"));
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { asked: string[] }).asked,
        ),
      )
      .toEqual(["有草稿尚未确认保存"]);
    expect(panel.isClosed()).toBe(false);
    await expect(panel.locator(".widget-save-status")).toHaveText(
      widgetStaleMessage,
    );

    await panel
      .getByRole("button", { name: "放弃未保存输入", exact: true })
      .click();
    await expect(panel.locator(".widget-save-actions")).toHaveCount(0);
    await expect(panelView.getByLabel("随手记")).toHaveValue(
      "主窗口已确认版本",
    );
    // A confirmed panel input survives hiding: the reopened view reads it back.
    await panelView.getByLabel("随手记").fill("面板确认的版本");
    await expect(panelView.getByRole("status")).toHaveText("草稿已确认保存");
    await hidePanel(app, panel);
    panel = await openPanel(app, main);
    panelView = await widgetView(app, panel, widget.id);
    await expect(panelView.getByLabel("随手记")).toHaveValue("面板确认的版本");
  } finally {
    await closeLocal(app);
  }
});

test("menu bar panel: an input whose save fails stays with the host, returns after hiding and saves on 重试保存 once the service is back", async () => {
  const dir = root();
  const [widget] = seedRetainedWidgets(dir, ["随手记"]);
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${dir}`],
  });
  try {
    const main = await app.firstWindow();
    let panel = await openPanel(app, main);
    let panelView = await widgetView(app, panel, widget.id);
    const pid = await app.evaluate(({ app }) => {
      const service = app
        .getAppMetrics()
        .find((metric) => metric.name === "csthink-assistant business");
      if (!service) throw new Error("no business service");
      return service.pid;
    });
    await app.evaluate((_electron, id) => process.kill(id, "SIGSTOP"), pid);
    await panelView.getByLabel("随手记").fill("服务中断时的输入");
    await expect(panel.getByRole("alert").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(
      panel.getByRole("button", { name: "重新连接", exact: true }),
    ).toBeVisible();
    // Hiding keeps the unconfirmed input with the host; the reopened view restores it.
    await hidePanel(app, panel);
    panel = await openPanel(app, main);
    await panel.getByRole("button", { name: "重新连接", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "重新连接", exact: true }),
    ).toHaveCount(0, { timeout: 15000 });
    panelView = await widgetView(app, panel, widget.id);
    await expect(panelView.getByLabel("随手记")).toHaveValue(
      "服务中断时的输入",
    );
    await expect(panel.locator(".widget-save-status")).toHaveText(
      "已恢复未确认输入，请先核对保存状态。",
    );
    await panel.screenshot({ path: test.info().outputPath("unconfirmed.png") });
    await panel.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect(panel.locator(".widget-save-actions")).toHaveCount(0);
    panelView = await widgetView(app, panel, widget.id);
    await expect(panelView.getByLabel("随手记")).toHaveValue(
      "服务中断时的输入",
    );
    await goTo(main, "控件");
    const mainView = await widgetView(app, main, widget.id);
    await expect(mainView.getByLabel("随手记")).toHaveValue("服务中断时的输入");
  } finally {
    await closeLocal(app);
  }
});

/** The stored note draft of the one seeded widget: its text and how many confirmed writes it has had. */
const noteDraft = (dir: string) => {
  const db = new DatabaseSync(join(dir, "state.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT drafts FROM widget_previews").all() as {
      drafts: string;
    }[];
    const notes = rows
      .map((r) => (JSON.parse(r.drafts) as Record<string, unknown>).note)
      .filter(Boolean) as { text: string; revision: number }[];
    return notes.length === 1
      ? { text: notes[0].text, revision: notes[0].revision }
      : { text: "", revision: 0 };
  } finally {
    db.close();
  }
};

test("widget views in the panel and the main window: while an input method composes nothing is saved, the chosen text is saved once, and hiding the panel mid-composition keeps the last confirmed text (OD-04)", async () => {
  const dir = root();
  const [widget] = seedRetainedWidgets(dir, ["随手记"]);
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${dir}`],
  });
  try {
    const main = await app.firstWindow();
    await goTo(main, "控件");
    // The main window first, then the panel opened afterwards, so each view starts on the latest revision.
    let panel: Page | undefined;
    const compose = async (view: Page, steps: string[]) => {
      const cdp = await app.context().newCDPSession(view);
      for (const text of steps)
        await cdp.send("Input.imeSetComposition", {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        });
      return cdp;
    };
    let typed = "";
    for (const entry of ["主窗口", "面板"] as const) {
      if (entry === "面板") panel = await openPanel(app, main);
      const view = await widgetView(
        app,
        entry === "面板" ? panel! : main,
        widget.id,
      );
      const field = view.getByLabel("随手记");
      // Input outside a composition saves as before.
      typed = `${entry}已确认`;
      await field.fill(typed);
      await expect(view.getByRole("status")).toHaveText("草稿已确认保存");
      await expect.poll(() => noteDraft(dir).text).toBe(typed);
      const before = noteDraft(dir);
      await field.focus();
      const cdp = await compose(view, ["n", "ni", "ni'h", "ni'hao"]);
      await expect(field).toHaveValue(`${typed}ni'hao`);
      await view.waitForTimeout(400);
      // Nothing of the composition reached the widget's code or the store.
      expect(noteDraft(dir)).toEqual(before);
      await expect(view.getByRole("status")).toHaveText("草稿已确认保存");
      await cdp.send("Input.insertText", { text: "你好" });
      typed = `${typed}你好`;
      await expect(field).toHaveValue(typed);
      await expect
        .poll(() => noteDraft(dir))
        .toEqual({ text: typed, revision: before.revision + 1 });
      await expect(view.getByRole("status")).toHaveText("草稿已确认保存");
      await view.waitForTimeout(400);
      expect(noteDraft(dir)).toEqual({
        text: typed,
        revision: before.revision + 1,
      });
      await cdp.detach();
    }

    // Hiding the panel during a composition writes nothing; the reopened view reads the last confirmed text.
    const view = await widgetView(app, panel!, widget.id);
    await expect(view.getByLabel("随手记")).toHaveValue(typed);
    const before = noteDraft(dir);
    await view.getByLabel("随手记").focus();
    await compose(view, ["z", "zh", "zhong"]);
    await expect(view.getByLabel("随手记")).toHaveValue(`${typed}zhong`);
    await hidePanel(app, panel!);
    await main.waitForTimeout(400);
    expect(noteDraft(dir)).toEqual(before);
    panel = await openPanel(app, main);
    const reopened = await widgetView(app, panel, widget.id);
    await expect(reopened.getByLabel("随手记")).toHaveValue(typed);
    await expect(panel.locator(".widget-save-actions")).toHaveCount(0);
    expect(noteDraft(dir)).toEqual(before);
  } finally {
    await closeLocal(app);
  }
});
