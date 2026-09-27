import { test, expect } from "@playwright/test";
import { launchLocal } from "./local-client";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
async function launch() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/projects-ui-"));
  const data = join(root, "data"),
    folder = join(root, "repository");
  mkdirSync(data);
  mkdirSync(folder);
  execFileSync("/usr/bin/git", ["init", "-q", folder]);
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${data}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  await expect(
    page
      .locator(".home-header")
      .getByRole("button", { name: "新建对话", exact: true }),
  ).toBeEnabled();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, folder);
  await page
    .getByRole("navigation", { name: "主要页面" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("tab", { name: "项目", exact: true }).click();
  return { app, page, data, folder };
}
test("projects: create, edit, archive and undo preserve project identity and render both themes", async ({}, info) => {
  const { app, page, data } = await launch();
  try {
    await page
      .getByRole("button", { name: "新建项目", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "新建项目", exact: true });
    await dialog.getByRole("textbox", { name: /项目名称/ }).fill("个人作品集");
    await dialog
      .getByRole("textbox", { name: /项目目标/ })
      .fill("整理创作与近期工作");
    await dialog
      .getByRole("button", { name: "选择文件夹", exact: true })
      .click();
    await expect(dialog).toContainText("Git · 无远程");
    await page.screenshot({
      path: info.outputPath("project-create-light.png"),
    });
    await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "个人作品集", exact: true }),
    ).toBeVisible();
    const before = await page.evaluate(async () => {
      const r = await window.desktop.command({ type: "snapshot" });
      return r.ok ? r.snapshot.projects[0].id : null;
    });
    await page
      .getByRole("button", { name: "个人作品集 项目操作", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "编辑项目", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑项目", exact: true });
    await edit
      .getByRole("textbox", { name: /项目名称/ })
      .fill("更新后的作品集");
    await page.screenshot({ path: info.outputPath("project-edit-light.png") });
    await edit.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "更新后的作品集", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "更新后的作品集 项目操作", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "归档项目", exact: true }).click();
    await expect(page.locator(".project-tag")).toHaveText("已归档");
    await page.screenshot({
      path: info.outputPath("project-archive-light.png"),
    });
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".project-tag")).toHaveCount(0);
    await page
      .getByRole("button", { name: "返回项目列表", exact: true })
      .click();
    await expect(page.locator(".project-table")).toContainText(
      "更新后的作品集",
    );
    await page.screenshot({ path: info.outputPath("project-list-light.png") });
    await page.evaluate(() =>
      window.desktop.command({ type: "setAppearance", appearance: "dark" }),
    );
    await page.screenshot({ path: info.outputPath("project-list-dark.png") });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "csthink-assistant")!
        .setSize(900, 680),
    );
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(900);
    await expect(
      page.getByRole("button", {
        name: "更新后的作品集 项目操作",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("project-list-dark-900.png"),
    });

    await page
      .getByRole("button", { name: "更新后的作品集 项目操作", exact: true })
      .click();
    await page.screenshot({
      path: info.outputPath("project-menu-dark-900.png"),
    });
    await page.keyboard.press("End");
    await expect(
      page.getByRole("menuitem", { name: "归档项目", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", {
        name: "更新后的作品集 项目操作",
        exact: true,
      }),
    ).toBeFocused();
    expect(
      await page.evaluate(async () => {
        const r = await window.desktop.command({ type: "snapshot" });
        return r.ok ? r.snapshot.projects[0].id : null;
      }),
    ).toBe(before);
    await app.close();
    const reopened = await launchLocal({
      args: [resolve("."), `--data-root=${data}`],
      cwd: resolve("."),
    });
    try {
      const restored = await reopened.firstWindow();
      await expect(
        restored
          .locator(".home-header")
          .getByRole("button", { name: "新建对话", exact: true }),
      ).toBeEnabled();
      const project = await restored.evaluate(async () => {
        const reply = await window.desktop.command({ type: "snapshot" });
        return reply.ok ? reply.snapshot.projects[0] : null;
      });
      expect(project).toMatchObject({
        id: before,
        name: "更新后的作品集",
        archivedAt: null,
      });
    } finally {
      await reopened.close();
    }
  } finally {
    await app.close();
  }
});
test("projects: cancelled picker, empty name and expired edit retain input without partial creation", async () => {
  const { app, page, folder } = await launch();
  try {
    await page
      .getByRole("button", { name: "新建项目", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "新建项目", exact: true });
    await dialog.getByRole("textbox", { name: /项目名称/ }).fill("保留输入");
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await dialog
      .getByRole("button", { name: "选择文件夹", exact: true })
      .click();
    await expect(dialog.getByRole("textbox", { name: /项目名称/ })).toHaveValue(
      "保留输入",
    );
    await expect(
      dialog.getByRole("button", { name: "创建项目", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    expect(
      await page.evaluate(async () => {
        const r = await window.desktop.command({ type: "snapshot" });
        return r.ok ? r.snapshot.projects.length : -1;
      }),
    ).toBe(0);
    await page
      .getByRole("button", { name: "新建项目", exact: true })
      .first()
      .click();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, folder);
    await dialog
      .getByRole("button", { name: "选择文件夹", exact: true })
      .click();
    await dialog.getByRole("textbox", { name: /项目名称/ }).fill("   ");
    await expect(
      dialog.getByRole("button", { name: "创建项目", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("textbox", { name: /项目名称/ }).fill("编辑竞争");
    await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
    await page
      .getByRole("button", { name: "编辑竞争 项目操作", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "编辑项目", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑项目", exact: true });
    const concurrent = await page.evaluate(async () => {
      const r = await window.desktop.command({ type: "snapshot" });
      if (!r.ok) throw new Error(r.message);
      const project = r.snapshot.projects[0];
      return window.desktop.command({
        type: "projectEdit",
        id: project.id,
        revision: project.revision,
        name: "另一入口已保存",
        goal: "",
      });
    });
    expect(concurrent.ok).toBe(true);
    await edit
      .getByRole("textbox", { name: /项目名称/ })
      .fill("保留的过期输入");
    await edit.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(edit.getByRole("alert")).toContainText("项目已变化");
    await expect(edit.getByRole("textbox", { name: /项目名称/ })).toHaveValue(
      "保留的过期输入",
    );
  } finally {
    await app.close();
  }
});

test("projects: plain folders and multiple Git remotes display their verified source without credentials", async ({}, info) => {
  const { app, page, folder } = await launch();
  try {
    execFileSync("/usr/bin/git", [
      "-C",
      folder,
      "config",
      "remote.origin.url",
      "https://synthetic-user:synthetic-secret@example.invalid/repo?token=synthetic-secret",
    ]);
    execFileSync("/usr/bin/git", [
      "-C",
      folder,
      "config",
      "remote.upstream.url",
      "git@example.invalid:team/repo.git",
    ]);
    for (const [path, name, label] of [
      ["/private/tmp", "普通目录项目", "普通文件夹"],
      [folder, "多远程项目", "2 个远程仓库"],
    ]) {
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        });
      }, path);
      await page
        .getByRole("button", { name: "新建项目", exact: true })
        .first()
        .click();
      const form = page.getByRole("dialog", { name: "新建项目", exact: true });
      await form.getByRole("textbox", { name: /项目名称/ }).fill(name);
      await form
        .getByRole("button", { name: "选择文件夹", exact: true })
        .click();
      await expect(form).toContainText(label);
      await expect(form).not.toContainText("synthetic-secret");
      await expect(form).not.toContainText("synthetic-user");
      if (path === folder) {
        await page.evaluate(() =>
          window.desktop.command({ type: "setAppearance", appearance: "dark" }),
        );
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.getTitle() === "csthink-assistant")!
            .setSize(900, 680),
        );
        await expect(
          form.getByRole("button", { name: "创建项目", exact: true }),
        ).toBeInViewport();
        await page.screenshot({
          path: info.outputPath("project-create-dark-900.png"),
        });
      }
      await form.getByRole("button", { name: "创建项目", exact: true }).click();
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "返回项目列表", exact: true })
        .click();
    }
    await expect(page.locator(".project-table tbody tr")).toHaveCount(2);
  } finally {
    await app.close();
  }
});
