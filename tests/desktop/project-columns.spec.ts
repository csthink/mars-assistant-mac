import { test, expect } from "@playwright/test";
import { journeyFixture } from "./project-action-fixture";
import { closeLocal } from "./local-client";
import { requestSize, windowClasses } from "./shell";

test("project columns: browsing follows explicit discussion, preserves drafts, and exposes only supplied projection types", async () => {
  const f = await journeyFixture({ reader: true });
  try {
    await f.page
      .getByRole("navigation", { name: "Runtime 内容" })
      .getByRole("button", { name: "设计文档", exact: true })
      .click();
    await f.page
      .getByRole("button", { name: "新建项目对话", exact: true })
      .click();
    const input = f.page.getByRole("textbox", {
      name: "项目对话输入",
      exact: true,
    });
    await input.fill("本项目的独立草稿");
    await expect(
      f.page.getByText("正在保存草稿…", { exact: true }),
    ).toHaveCount(0);
    const before = await f.page.evaluate(async (projectId) => {
      const r = await window.desktop.projectWork({ type: "read", projectId });
      if (!r.ok) throw Error(r.message);
      const snapshot = await window.desktop.command({ type: "snapshot" });
      if (!snapshot.ok) throw Error(snapshot.message);
      return {
        projection: r.view?.projection,
        chats: snapshot.snapshot.projects.find((p) => p.id === projectId)
          ?.chats,
      };
    }, f.projectId);
    const navigation = f.page.getByRole("navigation", { name: "Runtime 内容" });
    await navigation
      .getByRole("button", { name: "合成编码任务", exact: true })
      .click();
    await f.page.getByRole("tab", { name: "文件", exact: true }).click();
    await f.page
      .getByRole("region", { name: "产物与依据 1", exact: true })
      .getByRole("button", { name: "读取", exact: true })
      .click();
    await expect(
      f.page.getByLabel("产物与依据 1内容", { exact: true }),
    ).toContainText("candidate revision 1");
    await navigation
      .getByRole("button", { name: "设计文档", exact: true })
      .click();
    await expect(
      f.page.locator("#right-panel").getByLabel("文档内容", { exact: true }),
    ).toContainText("当前候选 1");
    for (const name of ["文件", "文档", "预览", "修改对比", "事件"])
      await expect(
        f.page.getByRole("tab", { name, exact: true }),
      ).toBeVisible();
    await f.page.getByRole("tab", { name: "预览", exact: true }).click();
    await expect(
      f.page.getByText("原型预览不可用：Runtime 未提供受限预览投影。", {
        exact: true,
      }),
    ).toBeVisible();
    await navigation
      .getByRole("button", { name: "本次修改", exact: true })
      .click();
    await expect(
      f.page.getByLabel("修改前内容", { exact: true }),
    ).toContainText("旧版本内容");
    await expect(
      f.page.getByLabel("修改后内容", { exact: true }),
    ).toContainText("当前候选 1");
    await navigation
      .getByRole("button", { name: "任务运行记录", exact: true })
      .click();
    await expect(
      f.page.getByRole("region", { name: "Trace 日志", exact: true }),
    ).toBeVisible();
    const after = await f.page.evaluate(async (projectId) => {
      const r = await window.desktop.projectWork({ type: "read", projectId });
      if (!r.ok) throw Error(r.message);
      const snapshot = await window.desktop.command({ type: "snapshot" });
      if (!snapshot.ok) throw Error(snapshot.message);
      return {
        projection: r.view?.projection,
        chats: snapshot.snapshot.projects.find((p) => p.id === projectId)
          ?.chats,
      };
    }, f.projectId);
    expect(after).toEqual(before);
    await f.page
      .getByRole("navigation", { name: "Runtime 内容" })
      .getByRole("button", { name: "设计文档", exact: true })
      .click();
    await expect(input).toHaveValue("本项目的独立草稿");
    const option = f.page
      .getByRole("combobox", { name: "讨论对象", exact: true })
      .locator("option")
      .filter({ hasText: "设计文档" });
    await f.page
      .getByRole("combobox", { name: "讨论对象", exact: true })
      .selectOption((await option.getAttribute("value"))!);
    await expect(
      navigation.getByRole("button", { name: "设计文档", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(f.page.locator(".right-owner")).toContainText(
      "讨论对象：设计文档",
    );
    await expect(input).toHaveValue("本项目的独立草稿");
    const operations = await f.request({
      type: "list",
      projectId: f.projectId,
    });
    expect(operations.ok && operations.operations?.length).toBe(0);
  } finally {
    await closeLocal(f.app);
  }
});

test("project columns: enlarged content restores scroll, focus and drafts with mouse, keyboard and Escape in both sizes and appearances", async ({}, info) => {
  const f = await journeyFixture({ reader: true });
  try {
    await f.page
      .getByRole("navigation", { name: "Runtime 内容" })
      .getByRole("button", { name: "设计文档", exact: true })
      .click();
    await f.page
      .getByRole("button", { name: "新建项目对话", exact: true })
      .click();
    const input = f.page.getByRole("textbox", {
      name: "项目对话输入",
      exact: true,
    });
    await input.fill("还原后保留的草稿");
    await f.page
      .getByRole("navigation", { name: "Runtime 内容" })
      .getByRole("button", { name: "设计文档", exact: true })
      .click();
    for (const [sizeName, size] of Object.entries(
      await windowClasses(f.app, f.page),
    ))
      for (const appearance of ["light", "dark"] as const) {
        await requestSize(f.app, f.page, ...size);
        await f.page.evaluate(
          (appearance) =>
            window.desktop.command({ type: "setAppearance", appearance }),
          appearance,
        );
        await f.page.locator(".viewport").evaluate((node) => {
          node.scrollTop = 0;
        });
        const settings = f.page.locator(".project-chat-settings");
        if ((await settings.getAttribute("open")) === null) {
          await settings.locator("summary").click();
        }
        await expect(settings).toHaveAttribute("open", "");
        for (const name of [
          "项目对话选择",
          "讨论对象",
          "项目对话模型",
          "项目对话推理强度",
        ]) {
          const control = f.page.getByRole("combobox", { name, exact: true });
          await control.scrollIntoViewIfNeeded();
          await expect(control).toBeInViewport({ ratio: 1 });
        }
        await f.page
          .locator(".project-chat-scroll, .project-chat-settings")
          .evaluateAll((nodes) =>
            nodes.forEach((node) => {
              node.scrollTop = 0;
            }),
          );
        await expect(input).toBeInViewport({ ratio: 1 });
        await expect(
          f.page.getByRole("button", { name: "发送", exact: true }),
        ).toBeInViewport({ ratio: 1 });
        await f.page.locator(".right-body").evaluate((node) => {
          node.scrollTop = 0;
        });
        await expect(
          f.page.getByLabel("文档内容", { exact: true }),
        ).toBeInViewport();
        await f.page.locator(".right-body").evaluate((node) => {
          node.scrollTop = 60;
        });
        const scroll = await f.page
          .locator(".right-body")
          .evaluate((node) => node.scrollTop);
        const enlarge = f.page.getByRole("button", {
          name: "放大内容区",
          exact: true,
        });
        await enlarge.click();
        const restore = f.page.getByRole("button", {
          name: "还原内容区",
          exact: true,
        });
        await expect(restore).toBeVisible();
        await expect(
          f.page.getByRole("navigation", { name: "全局导航" }),
        ).toBeHidden();
        await expect(
          f.page.getByRole("combobox", { name: "对话布局", exact: true }),
        ).toHaveValue("docked");
        expect(
          await f.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().some((w) => w.isFullScreen()),
          ),
        ).toBe(false);
        await f.page.evaluate(() =>
          window.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Escape",
              isComposing: true,
              bubbles: true,
            }),
          ),
        );
        await expect(restore).toBeVisible();
        await f.page.keyboard.press("Meta+k");
        await expect(
          f.page.getByRole("dialog", { name: "搜索对话", exact: true }),
        ).toBeVisible();
        await f.page.keyboard.press("Escape");
        await expect(
          f.page.getByRole("dialog", { name: "搜索对话", exact: true }),
        ).toBeHidden();
        await expect(restore).toBeVisible();
        await f.page.mouse.move(5, 5);
        await input.focus();
        await expect(restore).toBeVisible();
        await f.page
          .getByRole("combobox", { name: "对话布局", exact: true })
          .selectOption("float");
        const boxes = await f.page.evaluate(() => {
          const a = document
            .querySelector(".project-restore")!
            .getBoundingClientRect();
          const b = document
            .querySelector(".project-chat-slot")!
            .getBoundingClientRect();
          return {
            overlap:
              a.left < b.right &&
              a.right > b.left &&
              a.top < b.bottom &&
              a.bottom > b.top,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        expect(boxes).toEqual({ overlap: false, overflow: false });
        await f.page
          .getByRole("button", { name: "收起对话", exact: true })
          .click();
        await expect(input).toBeHidden();
        await f.page
          .getByRole("button", { name: "打开项目对话", exact: true })
          .click();
        await expect(
          f.page.getByRole("combobox", { name: "对话布局", exact: true }),
        ).toHaveValue("float");
        await expect(input).toHaveValue("还原后保留的草稿");
        await f.page.screenshot({
          path: info.outputPath(`${sizeName}-${appearance}-enlarged.png`),
        });
        await restore.click();
        await expect(enlarge).toBeFocused();
        await expect(f.page.locator(".right-body")).toHaveJSProperty(
          "scrollTop",
          scroll,
        );
        await enlarge.focus();
        await f.page.keyboard.press("Enter");
        await restore.focus();
        await f.page.keyboard.press("Enter");
        await expect(enlarge).toBeFocused();
        await enlarge.click();
        await f.page.keyboard.press("Escape");
        await expect(enlarge).toBeFocused();
        await expect(input).toHaveValue("还原后保留的草稿");
        await expect(
          f.page.getByRole("navigation", { name: "全局导航" }),
        ).toBeVisible();
      }
    await f.page
      .getByRole("button", { name: "放大内容区", exact: true })
      .click();
    await f.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send(
        "window:open-conversation",
      ),
    );
    await expect(f.page.locator(".app")).not.toHaveAttribute(
      "data-project-full",
      "true",
    );
  } finally {
    await closeLocal(f.app);
  }
});
