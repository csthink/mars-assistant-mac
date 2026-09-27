import { expect, type Locator, type Page } from "@playwright/test";

export type ShellPage = "聊天" | "工作台" | "待处理" | "运行记录" | "设置";

/** The main window is usable once the header's new-conversation button is enabled. */
export async function ready(page: Page) {
  await expect(
    page
      .locator(".home-header")
      .getByRole("button", { name: "新建对话", exact: true }),
  ).toBeEnabled();
}

/** Navigates the way a user does: the page switch for 聊天/工作台, the avatar popover for the rest. */
export async function goTo(page: Page, name: ShellPage) {
  if (name === "聊天" || name === "工作台") {
    await page
      .getByRole("navigation", { name: "主要页面" })
      .getByRole("button", { name, exact: true })
      .click();
    return;
  }
  const avatar = page.getByRole("button", { name: /^我，个人空间/ });
  if ((await avatar.getAttribute("aria-expanded")) !== "true")
    await avatar.click();
  await page
    .locator("section#profile-menu")
    .getByRole("menuitem", {
      name: name === "运行记录" ? "记录" : new RegExp(`^${name}`),
    })
    .click();
}

/** Opens the recent chats popover when it is closed and returns the list inside it. */
export async function recent(page: Page): Promise<Locator> {
  const history = page.locator("section#home-history");
  if (!(await history.isVisible()))
    await page.getByRole("button", { name: "最近聊天", exact: true }).click();
  await expect(history).toBeVisible();
  return history.getByLabel("最近对话");
}

/** Closes the recent chats popover if it is open, returning focus to its trigger. */
export async function closeRecent(page: Page) {
  const history = page.locator("section#home-history");
  if (await history.isVisible()) {
    // A row menu or confirm dialog owns Escape first; wait until the popover is the top layer again.
    await expect(page.locator("dialog[open], .conversation-menu")).toHaveCount(
      0,
    );
    await page.keyboard.press("Escape");
    await expect(history).toHaveCount(0);
  }
}

/** Asserts the number of rows in the recent list, leaving the popover as it was found. */
export async function expectSessionCount(page: Page, count: number) {
  const wasOpen = await page.locator("section#home-history").isVisible();
  await expect((await recent(page)).locator(".session")).toHaveCount(count);
  if (!wasOpen) await closeRecent(page);
}

/** Number of rows in the recent list, leaving the popover and the draft focus as they were found. */
export async function sessionCount(page: Page) {
  const wasOpen = await page.locator("section#home-history").isVisible();
  const draftFocused = await page.evaluate(
    () => document.activeElement?.getAttribute("aria-label") === "输入草稿",
  );
  const count = await (await recent(page)).locator(".session").count();
  if (!wasOpen) {
    await closeRecent(page);
    if (draftFocused)
      await page.getByRole("textbox", { name: "输入草稿" }).focus();
  }
  return count;
}

/** Opens a conversation from the recent list by its accessible name (`对话 xxxxxxxx`); the popover closes on selection. */
export async function openConversation(page: Page, label: string) {
  const list = await recent(page);
  await list.getByRole("button", { name: label, exact: true }).click();
  await expect(page.locator("section#home-history")).toHaveCount(0);
}
