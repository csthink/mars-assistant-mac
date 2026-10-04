import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { closeLocal, launchLocal } from "./local-client";
import { avatar, ready, settingsDialog } from "./shell";

async function launch() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/settings-dialog-"));
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  await ready(page);
  return { app, page };
}

/** The element that has focus is `target`, with a keyboard ring or without one. */
async function focusedOn(target: Locator, ring: boolean) {
  await expect(target).toBeFocused();
  await expect
    .poll(() => target.evaluate((el) => el.matches(":focus-visible")))
    .toBe(ring);
}

/** A press that starts and ends on the backdrop, outside the dialog box. */
async function pressOutside(page: Page) {
  const box = (await settingsDialog(page).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 12);
}

const categories = [
  ["通用", (d: Locator) => d.getByRole("group", { name: "外观" })],
  ["模型", (d: Locator) => d.locator(".provider-list")],
  ["最近删除", (d: Locator) => d.getByRole("heading", { name: "对话" })],
  [
    "扩展管理",
    (d: Locator) => d.getByRole("heading", { name: "扩展", exact: true }),
  ],
  ["访问权限", (d: Locator) => d.locator(".trust-boundary")],
  ["数据保留", (d: Locator) => d.getByRole("heading", { name: "数据保留" })],
  ["数据与隐私", (d: Locator) => d.getByText("业务数据目录")],
] as const;

test("settings dialog: the avatar opens a modal dialog with the individual space on top, the seven categories on the left and their unchanged content on the right, inside the 900 × 680 window", async ({}, info) => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
    );
    await expect
      .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual([900, 680]);
    await avatar(page).click();
    const dialog = settingsDialog(page);
    await expect(dialog).toBeVisible();
    expect(
      await dialog.evaluate((el) =>
        (el as HTMLDialogElement).matches(":modal"),
      ),
    ).toBe(true);
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(900);
    expect(box.y + box.height).toBeLessThanOrEqual(680);
    await expect(dialog.locator(".settings-dialog-profile")).toHaveText(
      /个人空间\s*保存在这台 Mac 上/,
    );
    const nav = dialog.getByRole("navigation", { name: "设置分类" });
    await expect(nav.getByRole("button")).toHaveText(
      categories.map(([name]) => name),
    );
    // Categories sit left of the content.
    const navBox = (await nav.boundingBox())!;
    const content = (await dialog
      .locator(".settings-dialog-content")
      .boundingBox())!;
    expect(navBox.x + navBox.width).toBeLessThanOrEqual(content.x + 0.5);
    for (const [name, marker] of categories) {
      await nav.getByRole("button", { name, exact: true }).click();
      await expect(
        nav.getByRole("button", { name, exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        dialog.locator(".settings-dialog-content > h2").first(),
      ).toHaveText(name === "扩展管理" ? "扩展" : name);
      await expect(marker(dialog).first()).toBeVisible();
      await page.screenshot({ path: info.outputPath(`settings-${name}.png`) });
    }
    // Arrows, Home and End move between categories from the keyboard.
    await nav.getByRole("button", { name: "通用", exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(nav.getByRole("button", { name: "模型" })).toBeFocused();
    await expect(nav.getByRole("button", { name: "模型" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.keyboard.press("End");
    await expect(nav.getByRole("button", { name: "数据与隐私" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(nav.getByRole("button", { name: "通用" })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(nav.getByRole("button", { name: "数据与隐私" })).toBeFocused();
  } finally {
    await closeLocal(app);
  }
});

test("settings dialog: a press outside, Escape and the close button each close it and return focus to the control that opened it, with a ring only after the keyboard", async () => {
  const { app, page } = await launch();
  try {
    const dialog = settingsDialog(page);
    const closes: [string, () => Promise<void>][] = [
      ["outside", () => pressOutside(page)],
      ["Escape", () => page.keyboard.press("Escape")],
      [
        "close button",
        () => dialog.getByRole("button", { name: "关闭设置" }).click(),
      ],
    ];
    // Pointer opening: no ring on return.
    for (const [label, close] of closes) {
      await avatar(page).click();
      await expect(dialog, label).toBeVisible();
      await close();
      await expect(dialog, label).toHaveCount(0);
      await focusedOn(avatar(page), false);
    }
    // Keyboard opening: the ring comes back with the focus.
    for (const [label, close] of closes) {
      await avatar(page).focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await expect(dialog, label).toBeVisible();
      await close();
      await expect(dialog, label).toHaveCount(0);
      await focusedOn(avatar(page), true);
    }
    // Inside operations keep it open: a click in the content, a choice, a press started inside and released outside.
    await avatar(page).click();
    await dialog
      .locator(".settings-dialog-content")
      .click({ position: { x: 20, y: 20 } });
    await dialog
      .getByRole("group", { name: "外观" })
      .getByRole("button", { name: "深色" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await dialog
      .getByRole("group", { name: "外观" })
      .getByRole("button", { name: "浅色" })
      .click();
    const box = (await dialog.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height + 20, {
      steps: 4,
    });
    await page.mouse.up();
    await expect(dialog).toBeVisible();
    // Command + K does not open the search panel over the settings dialog.
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("dialog", { name: "搜索对话" })).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    await closeLocal(app);
  }
});

test("settings dialog: other entries open the same dialog at their category and return focus to themselves, and a link out of the dialog closes it before opening its object", async () => {
  const { app, page } = await launch();
  try {
    const dialog = settingsDialog(page);
    // The composer's 未配置模型连接 opens 模型.
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    const entry = page.getByRole("button", { name: "未配置模型连接" });
    await entry.click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "模型", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(entry).toBeFocused();
    // 访问权限 → 查看读取历史 closes the dialog and shows the run records in the centre.
    await avatar(page).click();
    await dialog.getByRole("button", { name: "访问权限", exact: true }).click();
    await dialog.getByRole("button", { name: "查看读取历史" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page
        .locator(".center")
        .getByRole("heading", { level: 1, name: "运行记录" }),
    ).toBeVisible();
    // Without the business service the dialog still opens and each category shows its unconnected state.
    const pid = await app.evaluate(({ app }) => {
      const service = app
        .getAppMetrics()
        .find((metric) => metric.name === "csthink-assistant business");
      return service!.pid;
    });
    await app.evaluate((_electron, id) => process.kill(id, "SIGKILL"), pid);
    await expect(
      page.getByText("业务服务已失联。", { exact: false }),
    ).toBeVisible();
    await avatar(page).click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog
        .getByRole("group", { name: "外观" })
        .getByRole("button", { name: "深色" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    await closeLocal(app);
  }
});

test("settings dialog: widget waiting accepts only five to thirty whole minutes and persists the explicit save", async ({}, info) => {
  const { app, page } = await launch();
  try {
    await avatar(page).click();
    const row = settingsDialog(page).locator(".widget-wait-setting");
    const minutes = row.getByRole("spinbutton", { name: "控件生成等待时间" });
    const save = row.getByRole("button", { name: "保存", exact: true });
    await expect(minutes).toHaveValue("10");
    for (const value of ["4", "31", "5.5", ""]) {
      await minutes.fill(value);
      await expect(save).toBeDisabled();
    }
    await minutes.fill("15");
    await save.click();
    await expect(save).toBeDisabled();
    for (const [appearance, size] of [
      ["light", 900],
      ["dark", 1440],
    ] as const) {
      await page.evaluate(
        (appearance) =>
          window.desktop.command({ type: "setAppearance", appearance }),
        appearance,
      );
      await app.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0].setContentSize(
            width,
            width === 900 ? 680 : 900,
          ),
        size,
      );
      await row.scrollIntoViewIfNeeded();
      const bounds = await row.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size);
      await page.screenshot({
        path: info.outputPath(`waiting-settings-${appearance}-${size}.png`),
      });
    }
    await settingsDialog(page)
      .getByRole("button", { name: "关闭设置" })
      .click();
    await avatar(page).click();
    await expect(minutes).toHaveValue("15");
    const reply = await page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    expect(reply.ok && reply.snapshot.settings.widgetGenerationMinutes).toBe(
      15,
    );
  } finally {
    await closeLocal(app);
  }
});
