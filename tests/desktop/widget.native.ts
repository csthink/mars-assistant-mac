import { goTo } from "./shell";
import { _electron, test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";

// Scheduled after human acceptance. Physical IME/Tray/compositor checks remain manual.
test("native: widget focus, trusted search occlusion and generation recovery", async ({}, info) => {
  if (process.env.CSTHINK_NATIVE_TESTS !== "1")
    throw new Error("Use the explicitly scheduled native test entry");
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/native-widget-"));
  const client = await _electron.launch({
    args: [resolve("."), `--data-root=${root}`, "--widget-acceptance"],
  });
  try {
    const page = await client.firstWindow();
    await goTo(page, "工作台");
    // feature-t31 S-01 made 项目 the default workbench tab; the widget controls live under 控件 (KB-331).
    await page.getByRole("tab", { name: "控件", exact: true }).click();
    await page.getByRole("button", { name: "载入测试候选" }).click();
    const live = () =>
      client
        .context()
        .pages()
        .filter(
          (page) =>
            page.url().startsWith("csthink-widget:") &&
            page.url().endsWith("/index.html"),
        );
    await expect.poll(() => live().length).toBe(1);
    const widget = live()[0],
      oldURL = widget.url();
    await widget.getByLabel("随手记").fill("原生控件确认草稿");
    await expect(widget.getByRole("status")).toHaveText("草稿已确认保存");
    const frame = await client.evaluate(({ BrowserWindow, webContents }) => {
      const owner = BrowserWindow.getAllWindows()[0];
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith("csthink-widget:"))!;
      const child = owner.contentView.children[0];
      return {
        focused: contents.isFocused(),
        bounds: child.getBounds(),
        visible: child.getVisible(),
        content: owner.getContentBounds(),
      };
    });
    expect(frame.focused).toBe(true);
    expect(frame.visible).toBe(true);
    expect(frame.bounds.x).toBeGreaterThanOrEqual(16);
    expect(frame.bounds.y).toBeGreaterThanOrEqual(96);
    expect(frame.bounds.x + frame.bounds.width).toBeLessThanOrEqual(
      frame.content.width - 16,
    );
    expect(frame.bounds.y + frame.bounds.height).toBeLessThanOrEqual(
      frame.content.height - 16,
    );
    await info.attach("native-widget-view", {
      body: JSON.stringify(frame),
      contentType: "application/json",
    });
    // Chromium keyboard dispatch bypasses Electron before-input-event.
    // Exercise the focused native WebContents input path; physical keys remain manual.
    await client.evaluate(({ webContents }, url) => {
      const focused = webContents.getFocusedWebContents();
      if (!focused || focused.getURL() !== url)
        throw new Error("The widget must own native keyboard focus");
      focused.sendInputEvent({
        type: "keyDown",
        keyCode: "K",
        modifiers: ["meta"],
      });
    }, oldURL);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect.poll(() => live().length).toBe(0);
    await page.keyboard.press("Escape");
    await expect.poll(() => live().length).toBe(1);
    expect(live()[0].url()).not.toBe(oldURL);
    await expect(live()[0].getByLabel("随手记")).toHaveValue(
      "原生控件确认草稿",
    );
  } finally {
    await client.close();
  }
});
