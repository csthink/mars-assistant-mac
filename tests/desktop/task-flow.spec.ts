import { test, expect } from "@playwright/test";
import { journeyFixture } from "./project-action-fixture";
import { closeLocal } from "./local-client";
import { requestSize, windowClasses } from "./shell";

test("task flow: identity and view survive refresh; missing run and node fields stay explicit without domain writes", async () => {
  const f = await journeyFixture({ reader: true });
  try {
    const task = f.page.getByRole("region", { name: "任务详情", exact: true });
    await expect(task).toBeVisible();
    const colors = await task
      .locator(".project-graph-node rect")
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fill));
    expect(new Set(colors).size).toBe(1);
    expect(
      await task.locator('.project-graph-node[aria-pressed="true"]').count(),
    ).toBe(0);
    await expect(
      f.page.getByRole("region", { name: "运行摘要", exact: true }),
    ).toBeVisible();
    await expect(
      task.getByRole("combobox", { name: "任务运行", exact: true }),
    ).toBeDisabled();
    await expect(
      task.getByRole("button", { name: "定位当前节点", exact: true }),
    ).toBeDisabled();
    await task.getByRole("tab", { name: "详情", exact: true }).click();
    await expect(task).toContainText("历史运行不可用");
    await f.page.reload();
    await expect(
      task.getByRole("tab", { name: "详情", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await task.getByRole("tab", { name: "流程", exact: true }).click();
    const node = task.getByRole("button", {
      name: "检查节点 待接纳",
      exact: true,
    });
    await node.focus();
    await f.page.keyboard.press("Enter");
    await expect(
      f.page.getByRole("region", { name: "节点详情", exact: true }),
    ).toContainText("未提供节点操作");
    await expect(node).toHaveAttribute("aria-pressed", "true");
    const condition = task
      .getByRole("button", { name: "检查条件 继续", exact: true })
      .first();
    await condition.focus();
    await f.page.keyboard.press("Enter");
    await expect(
      f.page.getByRole("region", { name: "节点详情", exact: true }),
    ).toContainText("advance");

    const actions = f.page.getByRole("region", {
      name: "任务操作",
      exact: true,
    });
    const before = await actions.innerText();
    await f.page.getByRole("tab", { name: "Trace 日志", exact: true }).click();
    await f.page
      .getByRole("combobox", { name: "Trace 来源", exact: true })
      .selectOption("trace:1");
    await expect(f.page.locator(".right-body")).toContainText(
      "未提供任务与运行关联",
    );
    await expect(
      f.page.getByRole("combobox", { name: "筛选日志分组", exact: true }),
    ).toBeVisible();
    expect(await actions.innerText()).toBe(before);
    await f.page.getByRole("tab", { name: "文件", exact: true }).click();
    await f.page
      .getByRole("region", { name: "产物与依据 1", exact: true })
      .getByRole("button", { name: "读取", exact: true })
      .click();
    await expect(
      f.page.getByLabel("产物与依据 1内容", { exact: true }),
    ).toContainText("candidate revision 1");
    expect(await actions.innerText()).toBe(before);
    await f.page
      .locator("#right-panel")
      .getByRole("button", { name: "收起右栏", exact: true })
      .click();
    await task.getByRole("button", { name: "任务操作", exact: true }).click();
    await expect(actions).toBeFocused();
    await task
      .getByRole("button", { name: "放大任务视图", exact: true })
      .click();
    await expect(
      f.page.getByRole("navigation", { name: "全局导航" }),
    ).toBeHidden();
    await expect(
      task.getByRole("button", { name: "还原任务视图", exact: true }),
    ).toBeVisible();
    await f.page.keyboard.press("Escape");
    await expect(
      task.getByRole("button", { name: "放大任务视图", exact: true }),
    ).toBeFocused();
    const operations = await f.request({
      type: "list",
      projectId: f.projectId,
    });
    expect(operations.ok && operations.operations?.length).toBe(0);
  } finally {
    await closeLocal(f.app);
  }
});

test("task flow: canvas keyboard and pointer browsing keeps actions visible in both sizes and appearances", async ({}, info) => {
  const f = await journeyFixture();
  try {
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
        const actions = f.page.getByRole("region", {
          name: "任务操作",
          exact: true,
        });
        const box = await actions.boundingBox();
        for (const button of await actions
          .locator(".project-action-row > button")
          .all()) {
          await button.evaluate((element) =>
            element.scrollIntoView({ block: "center", inline: "nearest" }),
          );
          const bounds = await button.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.y).toBeGreaterThanOrEqual(box!.y);
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
            box!.y + box!.height,
          );
          await expect(button).toBeInViewport({ ratio: 1 });
        }
        await actions.evaluate((area) => {
          area.scrollTop = 0;
        });
        await f.page
          .getByRole("combobox", { name: "检查节点", exact: true })
          .selectOption("stage:10");
        await expect(
          f.page.getByRole("region", { name: "节点详情", exact: true }),
        ).toContainText("stage:10");
        const canvas = f.page.getByRole("group", {
          name: "拓扑画布，可拖动平移",
          exact: true,
        });
        await canvas.focus();
        await f.page.keyboard.press("ArrowRight");
        await f.page
          .getByRole("button", { name: "放大拓扑", exact: true })
          .click();
        const b = await canvas.boundingBox();
        if (!b) throw Error("canvas missing");
        expect(b.height).toBeGreaterThan(300);
        expect(b.y + b.height).toBeGreaterThan(
          (await f.page.evaluate(() => innerHeight)) - 80,
        );
        await f.page.mouse.move(b.x + 8, b.y + 8);
        await f.page.mouse.down();
        await f.page.mouse.move(b.x + 55, b.y + 55);
        await f.page.mouse.up();
        await f.page.locator(".right-body").evaluate((e) => {
          e.scrollTop = e.scrollHeight;
        });
        expect(await actions.boundingBox()).toEqual(box);
        await expect(actions).toBeInViewport({ ratio: 1 });
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
        await f.page.screenshot({
          path: info.outputPath(`${sizeName}-${appearance}-flow.png`),
        });
      }
  } finally {
    await closeLocal(f.app);
  }
});

test("task flow: list projections expose honest missing graph, operations and runs without replacing identity", async () => {
  const f = await journeyFixture();
  try {
    await f.page
      .getByRole("navigation", { name: "Runtime 内容" })
      .getByRole("button", { name: "评审额度", exact: true })
      .click();
    await f.page
      .getByRole("button", { name: "查看详情与流程", exact: true })
      .click();
    const task = f.page.getByRole("region", { name: "任务详情", exact: true });
    await expect(task).toContainText("流程不可用");
    await expect(
      f.page.getByRole("region", { name: "任务操作", exact: true }),
    ).toContainText("当前对象未提供可用操作");
    await task.getByRole("tab", { name: "详情", exact: true }).click();
    await f.page.reload();
    await expect(
      task.getByRole("tab", { name: "详情", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      f.page.locator(".task-fixed-actions > .project-source"),
    ).toContainText("quota:1");
    const ops = await f.request({ type: "list", projectId: f.projectId });
    expect(ops.ok && ops.operations?.length).toBe(0);
  } finally {
    await closeLocal(f.app);
  }
});
