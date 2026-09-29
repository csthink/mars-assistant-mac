import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";

/**
 * Where the main window's navigation takes a test: the conversation in the centre, the objects reached from
 * the rail and the sidebar, and the settings dialog.
 */
export type ShellPage =
  "聊天" | "项目" | "控件" | "待处理" | "运行记录" | "设置";

/** The sidebar's new-chat button. */
export const newChatButton = (page: Page) =>
  page
    .locator("#main-sidebar")
    .getByRole("button", { name: "新建聊天", exact: true });

/** The main window is usable once the sidebar's new-chat button is enabled. */
export async function ready(page: Page) {
  await expect(newChatButton(page)).toBeEnabled();
}

/** The rail entry for one of its objects. */
export const railEntry = (
  page: Page,
  name: "主页" | "控件" | "待处理" | "记录",
) =>
  page
    .getByRole("navigation", { name: "全局导航" })
    .getByRole("button", { name: new RegExp(`^${name}`) });

/** The avatar at the bottom of the rail; it opens the settings dialog. */
export const avatar = (page: Page) =>
  page.getByRole("button", { name: /^我，个人空间/ });

/** The settings dialog when it is open. */
export const settingsDialog = (page: Page) =>
  page.getByRole("dialog", { name: "设置" });

/** Closes the settings dialog with its close button when it is open. */
export async function closeSettings(page: Page) {
  const dialog = settingsDialog(page);
  if (await dialog.isVisible()) {
    await dialog.getByRole("button", { name: "关闭设置" }).click();
    await expect(dialog).toHaveCount(0);
  }
}

/**
 * The sidebar, expanded (or floated over the centre in a narrow window) when it was folded. A person closes
 * the modal settings dialog before reaching the sidebar, and so does this helper.
 */
export async function sidebar(page: Page) {
  await closeSettings(page);
  const list = page.locator("#main-sidebar");
  if (!(await list.isVisible()))
    await page
      .getByRole("navigation", { name: "全局导航" })
      .getByRole("button", { name: "展开侧栏" })
      .click();
  await expect(list).toBeVisible();
  return list;
}

/**
 * Navigates the way a person does: 聊天 returns to the current conversation (its row in the sidebar, or the
 * new-conversation page when there is no row for it), 项目 is the sidebar's 全部项目, 控件, 待处理 and 运行记录
 * are rail entries and 设置 opens the dialog from the avatar.
 */
export async function goTo(page: Page, name: ShellPage) {
  if (name === "设置") {
    // Opening settings starts at 通用, as the avatar does; an open dialog goes back to 通用 too.
    if (!(await settingsDialog(page).isVisible())) await avatar(page).click();
    else
      await settingsDialog(page)
        .getByRole("button", { name: "通用", exact: true })
        .click();
    await expect(settingsDialog(page)).toBeVisible();
    return;
  }
  await closeSettings(page);
  if (name === "聊天") {
    // Already showing the conversation: nothing to select again.
    if (await page.locator(".center .chat-layout").isVisible()) return;
    const selected = await page.evaluate(async () => {
      try {
        const reply = await window.desktop.command({ type: "snapshot" });
        return reply.ok ? (reply.snapshot.selected.main ?? null) : null;
      } catch {
        return null;
      }
    });
    const row = selected
      ? (await recent(page)).getByRole("button", {
          name: `对话 ${selected.slice(0, 8)}`,
          exact: true,
        })
      : undefined;
    if (row && (await row.count())) await row.click();
    else await railEntry(page, "主页").click();
    return;
  }
  if (name === "项目") {
    await (
      await sidebar(page)
    )
      .getByRole("button", { name: /^全部项目/ })
      .click();
    return;
  }
  await railEntry(
    page,
    name === "运行记录" ? "记录" : name === "控件" ? "控件" : "待处理",
  ).click();
}

/** The recent list in the sidebar (expanding the sidebar when it is folded). */
export async function recent(page: Page): Promise<Locator> {
  return (await sidebar(page)).getByLabel("最近对话");
}

/** The recent list lives in the sidebar and never needs closing; waits until no menu or dialog covers it. */
export async function closeRecent(page: Page) {
  await expect(page.locator("dialog[open], .conversation-menu")).toHaveCount(0);
}

/** Asserts the number of rows in the recent list. */
export async function expectSessionCount(page: Page, count: number) {
  await expect((await recent(page)).locator(".session")).toHaveCount(count);
}

/** Number of rows in the recent list, leaving the draft focus as it was found. */
export async function sessionCount(page: Page) {
  const draftFocused = await page.evaluate(
    () => document.activeElement?.getAttribute("aria-label") === "输入草稿",
  );
  const count = await (await recent(page)).locator(".session").count();
  if (draftFocused)
    await page.getByRole("textbox", { name: "输入草稿" }).focus();
  return count;
}

/** Opens a conversation from the recent list by its accessible name (`对话 xxxxxxxx`). */
export async function openConversation(page: Page, label: string) {
  const list = await recent(page);
  await list.getByRole("button", { name: label, exact: true }).click();
}

/**
 * Requests a content size and reads back what the window system gave: the size once the main process and the
 * page agree on it and it holds between two reads. The host screen decides; tests never assume it fits.
 */
export async function requestSize(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<[number, number]> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) =>
      BrowserWindow.getAllWindows()[0].setContentSize(w, h),
    [width, height],
  );
  let last = "";
  let settled: [number, number] = [0, 0];
  await expect
    .poll(
      async () => {
        const main = await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].getContentSize(),
        );
        const inner = await page.evaluate(() => [innerWidth, innerHeight]);
        const reading = `${main.join("x")} ${inner.join("x")}`;
        const steady =
          reading === last && main[0] === inner[0] && main[1] === inner[1];
        last = reading;
        settled = [main[0], main[1]];
        return steady;
      },
      { intervals: [100, 100, 200, 300] },
    )
    .toBe(true);
  test.info().annotations.push({
    type: "window size",
    description: `requested ${width}x${height}, got ${settled.join("x")}`,
  });
  return settled;
}

/** The two supported window classes, read back: the minimum exactly, the standard width by what the host gave. */
export async function windowClasses(app: ElectronApplication, page: Page) {
  const minimum = await requestSize(app, page, 900, 680);
  expect(minimum, "the minimum window 900 × 680").toEqual([900, 680]);
  const standard = await requestSize(app, page, 1440, 900);
  expect(
    standard[0],
    `the standard window: the host gave ${standard.join(" × ")}; four columns need 1104`,
  ).toBeGreaterThanOrEqual(1104);
  expect(standard[0]).toBeLessThanOrEqual(1440);
  expect(standard[1]).toBeGreaterThanOrEqual(680);
  expect(standard[1]).toBeLessThanOrEqual(900);
  return { minimum, standard };
}
