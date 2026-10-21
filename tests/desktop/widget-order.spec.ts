import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedRetainedWidgets } from "./widget-generation-fixture";
import { launchLocal, closeLocal } from "./local-client";
import { goTo, requestSize } from "./shell";

const names = ["天气", "便笺", "计时", "便笺", "汇率"];
function root() {
  mkdirSync(".test-data/disposable", { recursive: true });
  return mkdtempSync(resolve(".test-data/disposable/widget-order-ui-"));
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

test("widget order: five widgets across columns move by drag, 前移 / 后移 and the widget menu, both entries agree and restart keeps the order", async () => {
  const dir = root();
  const ids = seedRetainedWidgets(dir, names).map((w) => w.id);
  let app = await launchLocal({ args: [resolve("."), `--data-root=${dir}`] });
  try {
    let shell = await app.firstWindow();
    await requestSize(app, shell, 1440, 900);
    await goTo(shell, "控件");
    await expect(shell.locator("[data-formal-widget]")).toHaveCount(5);
    // At least two columns: the first two cards share a row.
    const tops = await shell
      .locator("[data-formal-widget]")
      .evaluateAll((nodes) =>
        nodes.map((n) => Math.round(n.getBoundingClientRect().top)),
      );
    expect(tops[0]).toBe(tops[1]);
    expect(tops[4]).toBeGreaterThan(tops[0]);
    // Same-name widgets stay apart by identity in every control name.
    await expect(
      shell.getByRole("button", {
        name: `控件操作 便笺 ${ids[1].slice(0, 8)}`,
      }),
    ).toHaveCount(1);
    await expect(
      shell.getByRole("button", {
        name: `控件操作 便笺 ${ids[3].slice(0, 8)}`,
      }),
    ).toHaveCount(1);

    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items[0].submenu!.items.find(
          (item) => item.label === "打开工作台助手",
        )!
        .click(),
    );
    // Widget views are pages too; the panel is the other window that loads the product shell.
    let panel: Page | undefined;
    await expect
      .poll(() => {
        panel = app
          .windows()
          .find((p) => p !== shell && p.url().startsWith("file:"));
        return !!panel;
      })
      .toBe(true);
    await panel!.getByRole("button", { name: "工作台", exact: true }).click();
    await expect(panel!.locator("[data-formal-widget]")).toHaveCount(5);
    expect(await shown(panel!)).toEqual(ids);

    // 编辑布局: drag 汇率 (last, second row) before 天气 (first card, first row).
    await shell.getByRole("button", { name: "编辑布局", exact: true }).click();
    await expect(
      shell.getByText(
        "拖动控件或用「前移 / 后移」调整顺序，立即生效，不需要保存。",
      ),
    ).toBeVisible();
    await expect(
      shell.getByRole("button", { name: `前移 天气 ${ids[0].slice(0, 8)}` }),
    ).toBeDisabled();
    await expect(
      shell.getByRole("button", { name: `后移 汇率 ${ids[4].slice(0, 8)}` }),
    ).toBeDisabled();
    await card(shell, ids[4])
      .locator(".widget-order-grip")
      .dragTo(card(shell, ids[0]).locator(".widget-formal-controls"), {
        targetPosition: { x: 8, y: 16 },
      });
    const dragged = [ids[4], ids[0], ids[1], ids[2], ids[3]];
    await expect.poll(() => shown(shell)).toEqual(dragged);
    await expect(shell.locator(".widget-order-announce")).toContainText(
      "「汇率」已移到第 1 位",
    );
    await expect.poll(() => shown(panel!), { timeout: 2000 }).toEqual(dragged);
    expect(stored(dir)).toEqual(dragged);

    // 后移 the second 便笺 is not 前移 of the first one: identities do not merge.
    await shell
      .getByRole("button", { name: `前移 便笺 ${ids[3].slice(0, 8)}` })
      .click();
    const stepped = [ids[4], ids[0], ids[1], ids[3], ids[2]];
    await expect.poll(() => shown(shell)).toEqual(stepped);
    await expect(
      shell.getByRole("button", { name: `前移 便笺 ${ids[3].slice(0, 8)}` }),
    ).toBeFocused();
    await expect.poll(() => shown(panel!), { timeout: 2000 }).toEqual(stepped);

    // Outside the mode, the ⋯ menu by keyboard: first item disabled with its reason.
    await shell
      .getByRole("button", { name: "完成布局编辑", exact: true })
      .click();
    await shell
      .getByRole("button", { name: `控件操作 汇率 ${ids[4].slice(0, 8)}` })
      .focus();
    await shell.keyboard.press("Enter");
    const menu = shell.getByRole("menu", { name: "控件操作：汇率" });
    // The menu hangs over the card's content: the native widget view of that card starts below the menu.
    const menuBottom = (await menu.boundingBox())!;
    const status = await shell.evaluate(
      (slot) => window.desktop.widgetControl({ action: "status", slot }),
      `formal:${ids[4]}`,
    );
    expect(status.ok && status.generation).toBeTruthy();
    const url = `csthink-widget://${status.ok ? status.generation : ""}/index.html`;
    await expect
      .poll(async () => {
        // Top of the drawn area: the intersection of the view and every ancestor's bounds.
        const top = await app.evaluate(({ BrowserWindow }, url) => {
          let found: number | null = null;
          type V = {
            getBounds(): {
              x: number;
              y: number;
              width: number;
              height: number;
            };
            children: V[];
            webContents?: { getURL(): string };
          };
          const walk = (parent: V, x: number, y: number, clipTop: number) => {
            for (const child of parent.children) {
              const r = child.getBounds();
              const ax = x + r.x,
                ay = y + r.y;
              if (child.webContents?.getURL() === url)
                found = Math.max(clipTop, ay);
              else walk(child, ax, ay, Math.max(clipTop, ay));
            }
          };
          for (const w of BrowserWindow.getAllWindows())
            walk(w.contentView as unknown as V, 0, 0, 0);
          return found;
        }, url);
        return (
          top !== null && top >= Math.floor(menuBottom.y + menuBottom.height)
        );
      })
      .toBe(true);
    await expect(menu.getByRole("menuitem", { name: /前移/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(menu).toContainText("已在最前");
    await shell.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: /后移/ })).toBeFocused();
    await shell.keyboard.press("Enter");
    const menued = [ids[0], ids[4], ids[1], ids[3], ids[2]];
    await expect.poll(() => shown(shell)).toEqual(menued);
    await expect(
      shell.getByRole("button", {
        name: `控件操作 汇率 ${ids[4].slice(0, 8)}`,
      }),
    ).toBeFocused();
    await expect.poll(() => shown(panel!), { timeout: 2000 }).toEqual(menued);
    await expect.poll(() => stored(dir)).toEqual(menued);

    await closeLocal(app);
    app = await launchLocal({ args: [resolve("."), `--data-root=${dir}`] });
    shell = await app.firstWindow();
    await goTo(shell, "控件");
    await expect(shell.locator("[data-formal-widget]")).toHaveCount(5);
    expect(await shown(shell)).toEqual(menued);
  } finally {
    await closeLocal(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("widget order: a failed save returns to the saved order with a retry, and a stale view is refused without overwriting the newer order", async () => {
  const dir = root();
  const ids = seedRetainedWidgets(dir, names).map((w) => w.id);
  // A fault switch the test can flip while the client runs: while a row exists, writing positions fails.
  const setup = new DatabaseSync(join(dir, "state.sqlite"));
  setup.exec(`CREATE TABLE test_order_fault(id INTEGER PRIMARY KEY);
    CREATE TRIGGER test_order_fault BEFORE UPDATE OF position ON saved_widgets
    WHEN NEW.position>0 AND EXISTS(SELECT 1 FROM test_order_fault)
    BEGIN SELECT RAISE(ABORT,'injected order failure'); END;`);
  setup.close();
  const app = await launchLocal({ args: [resolve("."), `--data-root=${dir}`] });
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  try {
    const shell = await app.firstWindow();
    await requestSize(app, shell, 1440, 900);
    await goTo(shell, "控件");
    await expect(shell.locator("[data-formal-widget]")).toHaveCount(5);
    await shell.getByRole("button", { name: "编辑布局", exact: true }).click();
    db.exec("INSERT INTO test_order_fault VALUES(1)");
    await shell
      .getByRole("button", { name: `后移 天气 ${ids[0].slice(0, 8)}` })
      .click();
    const alert = shell.locator(".widget-order-notice[role=alert]");
    await expect(alert).toContainText("顺序未保存");
    await expect(alert).toContainText("已恢复为上次保存的顺序");
    await expect.poll(() => shown(shell)).toEqual(ids);
    expect(stored(dir)).toEqual(ids);
    db.exec("DELETE FROM test_order_fault");
    await alert.getByRole("button", { name: "重试", exact: true }).click();
    const retried = [ids[1], ids[0], ids[2], ids[3], ids[4]];
    await expect.poll(() => shown(shell)).toEqual(retried);
    await expect(shell.locator(".widget-order-announce")).toContainText(
      "「天气」已移到第 2 位",
    );
    expect(stored(dir)).toEqual(retried);

    // Another writer commits first: the host boundary lets a competing move of 天气 to the front land just
    // before this view's move arrives with the revision it saw. The view's move is refused, not applied on top.
    await app.evaluate(({ ipcMain }) => {
      const internal = ipcMain as unknown as {
        _invokeHandlers: Map<
          string,
          (
            event: unknown,
            command: { type: string; orderRevision?: number },
          ) => Promise<unknown>
        >;
      };
      const original = internal._invokeHandlers.get("business:command")!;
      let competed = false;
      ipcMain.removeHandler("business:command");
      ipcMain.handle("business:command", async (event, command) => {
        if (command.type === "moveWidget" && !competed) {
          competed = true;
          const snapshot = (await original(event, { type: "snapshot" })) as {
            snapshot: {
              widgetGeneration: { widgets: { id: string; name: string }[] };
            };
          };
          const first = snapshot.snapshot.widgetGeneration.widgets.find(
            (w) => w.name === "天气",
          )!;
          await original(event, {
            type: "moveWidget",
            widgetId: first.id,
            toIndex: 0,
            orderRevision: command.orderRevision,
          } as never);
        }
        return original(event, command);
      });
    });
    await shell
      .getByRole("button", { name: `前移 汇率 ${ids[4].slice(0, 8)}` })
      .click();
    await expect(
      shell.locator(".widget-order-notice[role=alert]"),
    ).toContainText(
      "顺序已在另一入口更新，「汇率」的移动未应用，已显示最新顺序。",
    );
    const competing = [ids[0], ids[1], ids[2], ids[3], ids[4]];
    await expect.poll(() => shown(shell)).toEqual(competing);
    expect(stored(dir)).toEqual(competing);
    await expect(
      shell
        .locator(".widget-order-notice[role=alert]")
        .getByRole("button", { name: "重试" }),
    ).toHaveCount(0);
  } finally {
    db.close();
    await closeLocal(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
