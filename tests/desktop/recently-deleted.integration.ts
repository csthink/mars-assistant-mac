import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { seedRetainedWidgets } from "./widget-generation-fixture";
import { launchLocal, closeLocal } from "./local-client";
import { goTo } from "./shell";

// A retained widget's deletion through the main process (WB-04): the panel cannot ask for it, the views of both
// entries go, and the panel's projection no longer carries the widget.

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
  return panel!;
}
/** The generation of the view a window shows for one retained widget, or "" when there is none. */
const generation = (owner: Page, id: string) =>
  owner.evaluate(async (slot) => {
    const reply = await window.desktop.widgetControl({
      action: "status",
      slot,
    });
    return reply.ok ? (reply.generation ?? "") : "";
  }, `formal:${id}`);

test("recently deleted integration: the panel cannot delete a widget; a deletion from the main window removes the views of both entries and the panel projection", async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const dir = mkdtempSync(
    resolve(".test-data/disposable/recently-deleted-ipc-"),
  );
  const [first, second] = seedRetainedWidgets(dir, ["甲", "乙"]);
  const app = await launchLocal({ args: [resolve("."), `--data-root=${dir}`] });
  try {
    const main = await app.firstWindow();
    await goTo(main, "控件");
    const panel = await openPanel(app, main);
    let mainView = "";
    let panelView = "";
    await expect
      .poll(async () => {
        mainView = await generation(main, first.id);
        panelView = await generation(panel, first.id);
        return !!mainView && !!panelView;
      })
      .toBe(true);
    const viewOpen = (id: string) =>
      app
        .context()
        .pages()
        .some((p) => p.url() === `csthink-widget://${id}/index.html`);
    await expect
      .poll(() => viewOpen(mainView) && viewOpen(panelView))
      .toBe(true);

    // The panel's channel refuses the deletion before it reaches the business service.
    const refused = await panel.evaluate(
      (w) =>
        window.desktop.command({
          type: "deleteWidget",
          id: w.id,
          revision: w.revision,
          confirmed: true,
        }),
      first,
    );
    expect(refused.ok).toBe(false);
    const kept = await main.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    expect(
      kept.ok && kept.snapshot.widgetGeneration!.widgets.map((w) => w.id),
    ).toEqual([first.id, second.id]);

    const deleted = await main.evaluate(
      (w) =>
        window.desktop.command({
          type: "deleteWidget",
          id: w.id,
          revision: w.revision,
          confirmed: true,
        }),
      first,
    );
    expect(deleted.ok).toBe(true);
    // Both entries let the widget's views go; the other widget's views stay.
    await expect
      .poll(() => viewOpen(mainView) || viewOpen(panelView))
      .toBe(false);
    await expect.poll(() => generation(main, first.id)).toBe("");
    await expect.poll(() => generation(panel, first.id)).toBe("");
    expect(await generation(main, second.id)).not.toBe("");
    // The panel's projection carries only the remaining widget and nothing of recently deleted.
    const projection = await panel.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    expect(projection.ok).toBe(true);
    if (projection.ok) {
      expect(
        projection.snapshot.widgetGeneration!.widgets.map((w) => w.id),
      ).toEqual([second.id]);
      expect(projection.snapshot.recentlyDeleted ?? null).toEqual(null);
    }
  } finally {
    await closeLocal(app);
  }
});
