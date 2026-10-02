import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../../src/service/store";
import { launchLocal } from "./local-client";
import { goTo, ready, sidebar as openSidebar } from "./shell";

async function launch(
  names = ["北京", "广州", "上海", "深圳", "天津", "武汉"],
) {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/project-sidebar-"));
  const data = join(root, "data"),
    folders = join(root, "folders");
  mkdirSync(data);
  mkdirSync(folders);
  const store = new Store(data);
  const ids: string[] = [];
  for (const name of names) {
    const id = randomUUID();
    const path = join(folders, id);
    mkdirSync(path);
    const stat = statSync(path, { bigint: true });
    const reply = store.execute(
      {
        type: "projectCreate",
        id,
        name,
        goal: "",
        folder: {
          path,
          canonicalPath: path,
          identity: `${stat.dev}:${stat.ino}`,
          git: null,
        },
      },
      "main",
      "host",
    );
    if (!reply.ok) throw new Error(reply.message);
    ids.push(id);
  }
  const conversation = randomUUID();
  store.execute({ type: "create", id: conversation }, "main");
  store.execute(
    {
      type: "renameConversation",
      id: conversation,
      title: "置顶对话",
      revision: 0,
    },
    "main",
  );
  const revision = (
    store.db
      .prepare(
        "SELECT organization_revision AS revision FROM conversations WHERE id=?",
      )
      .get(conversation) as { revision: number }
  ).revision;
  store.execute(
    {
      type: "organizeConversation",
      id: conversation,
      action: "pin",
      revision,
      confirmed: false,
    },
    "main",
  );
  store.close();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${data}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => ["青鸾", "Qingluan"].includes(window.getTitle()))!
      .setSize(1440, 850),
  );
  await expect
    .poll(() => page.evaluate(() => window.innerHeight))
    .toBeGreaterThanOrEqual(800);
  await ready(page);
  await openSidebar(page);
  await expect(page.locator("#main-sidebar .project-side-line")).toHaveCount(
    Math.min(names.length, 5),
  );
  return { app, page, data, ids, names, conversation };
}

test("project sidebar: the permanent create control opens the shared form even when the section is folded", async () => {
  const { app, page, data } = await launch();
  const sidebar = page.locator("#main-sidebar");
  const create = sidebar.getByRole("button", {
    name: "新建项目",
    exact: true,
  });
  const fold = sidebar.locator("#side-projects-title .section-toggle");
  try {
    await page.mouse.move(20, 20);
    await expect(create).toBeVisible();
    await expect(create).toHaveCSS("opacity", "1");
    await expect(create).toHaveAttribute("aria-label", "新建项目");
    await create.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "新建项目" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "新建项目" })).toHaveCount(0);
    await expect(create).toBeFocused();

    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(create).toBeVisible();
    await create.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "新建项目" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(create).toBeFocused();

    const folder = join(data, "sidebar-created");
    mkdirSync(folder);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, folder);
    await create.click();
    const form = page.getByRole("dialog", { name: "新建项目" });
    await form.getByRole("textbox", { name: /项目名称/ }).fill("侧栏新建");
    await form.getByRole("button", { name: "选择文件夹" }).click();
    await expect(form.getByRole("button", { name: "创建项目" })).toBeEnabled();
    await form.getByRole("button", { name: "创建项目" }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "侧栏新建" })).toBeVisible();
    await expect
      .poll(async () => {
        const reply = await page.evaluate(() =>
          window.desktop.command({ type: "snapshot" }),
        );
        return reply.ok
          ? reply.snapshot.projects.filter((project) => !project.archivedAt)
              .length
          : -1;
      })
      .toBe(7);
  } finally {
    await app.close();
  }
});

test("project sidebar: three sort modes preserve a separate list preference and manual moves stay within the visible five", async () => {
  const { app, page, data, ids } = await launch();
  const rows = page.locator(
    "#main-sidebar .sessions[aria-label='侧栏项目'] .project-side-line",
  );
  const names = () => rows.locator(".session-name").allTextContents();
  const sort = page
    .locator("#main-sidebar")
    .getByRole("button", { name: "项目区操作" });
  try {
    await goTo(page, "项目");
    await page.getByRole("combobox", { name: "项目排序" }).selectOption("name");
    await sort.click();
    await page.getByRole("menuitemradio", { name: "名称" }).click();
    await expect.poll(names).toEqual(["北京", "广州", "上海", "深圳", "天津"]);
    await sort.click();
    await page.getByRole("menuitemradio", { name: "手动排序" }).click();
    await expect.poll(names).toEqual(["武汉", "天津", "深圳", "上海", "广州"]);
    await expect(page.getByRole("combobox", { name: "项目排序" })).toHaveValue(
      "name",
    );

    const last = rows.nth(4).locator(".project-side-more");
    await last.click();
    await expect(page.getByRole("menuitem", { name: "下移" })).toBeDisabled();
    await page.keyboard.press("Escape");
    const fourth = rows.nth(3).locator(".project-side-more");
    await fourth.click();
    await page.getByRole("menuitem", { name: "下移" }).click();
    await expect.poll(names).toEqual(["武汉", "天津", "深圳", "广州", "上海"]);
    await expect(
      page.locator(
        `#main-sidebar .sessions[aria-label='侧栏项目'] [data-project='${ids[0]}']`,
      ),
    ).toHaveCount(0);
    await expect(rows.nth(4).locator(".project-side-more")).toBeFocused();

    const source = await rows.nth(0).boundingBox(),
      target = await rows.nth(4).boundingBox();
    if (!source || !target)
      throw new Error("manual project rows not measurable");
    await page.mouse.move(
      source.x + source.width / 2,
      source.y + source.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      source.x + source.width / 2,
      source.y + source.height / 2 + 10,
      { steps: 3 },
    );
    await expect(rows.nth(0)).toHaveClass(/dragging/);
    await page.mouse.move(
      target.x + target.width / 2,
      target.y + target.height * 0.75,
      { steps: 8 },
    );
    await expect(rows.nth(4)).toHaveClass(/drop-after/);
    await page.mouse.up();
    await expect.poll(names).toEqual(["天津", "深圳", "广州", "上海", "武汉"]);
    await expect(rows).toHaveCount(5);
    const fullOrder = await page.evaluate(async () => {
      const reply = await window.desktop.command({ type: "snapshot" });
      return reply.ok
        ? reply.snapshot.projects
            .filter((project) => !project.archivedAt && !project.pinnedAt)
            .sort((a, b) => a.manualPosition - b.manualPosition)
            .map((project) => project.name)
        : [];
    });
    expect(fullOrder).toEqual(["天津", "深圳", "广州", "上海", "武汉", "北京"]);
    await app.close();
    const restored = await launchLocal({
      args: [resolve("."), `--data-root=${data}`],
      cwd: resolve("."),
    });
    try {
      const restoredPage = await restored.firstWindow();
      await expect
        .poll(() =>
          restoredPage
            .locator(
              "#main-sidebar .sessions[aria-label='侧栏项目'] .session-name",
            )
            .allTextContents(),
        )
        .toEqual(["天津", "深圳", "广州", "上海", "武汉"]);
      expect(
        await restoredPage.evaluate(async () => {
          const reply = await window.desktop.command({ type: "snapshot" });
          return reply.ok
            ? reply.snapshot.projects
                .filter((project) => !project.archivedAt && !project.pinnedAt)
                .sort((a, b) => a.manualPosition - b.manualPosition)
                .map((project) => project.name)
            : [];
        }),
      ).toEqual(fullOrder);
    } finally {
      await restored.close();
    }
  } finally {
    await app.close();
  }
});

test("project sidebar: a project and a conversation share pin order, and archive undo leaves the project unpinned", async () => {
  const { app, page, ids, conversation } = await launch();
  const sidebar = page.locator("#main-sidebar");
  const project = sidebar.locator(`[data-project='${ids[5]}']`);
  const pinned = sidebar.locator(".pinned-section");
  try {
    await project.locator(".project-side-more").click();
    await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
    await expect(pinned.locator(`[data-project='${ids[5]}']`)).toBeVisible();
    await expect(
      pinned.locator("[data-project], [data-conversation]").first(),
    ).toHaveAttribute("data-project", ids[5]);
    await sidebar.getByRole("button", { name: "已置顶的排序方式" }).click();
    await page.getByRole("menuitemradio", { name: "手动排序" }).click();
    const pinnedProject = pinned.locator(`[data-project='${ids[5]}']`);
    await pinnedProject.locator(".project-side-more").click();
    await page.getByRole("menuitem", { name: "下移" }).click();
    await expect(
      pinned.locator("[data-project], [data-conversation]").first(),
    ).toHaveAttribute("data-conversation", conversation);
    await pinnedProject.locator(".project-side-more").click();
    await page.getByRole("menuitem", { name: "归档项目" }).click();
    await expect(pinnedProject).toHaveCount(0);
    await page.locator(".project-sidebar-notice button").click();
    await expect(sidebar.locator(`[data-project='${ids[5]}']`)).toBeVisible();
    await expect(pinnedProject).toHaveCount(0);
    const saved = await page.evaluate(async () => {
      const result = await window.desktop.command({ type: "snapshot" });
      return result.ok ? result.snapshot : null;
    });
    expect(saved?.projects.find((value) => value.id === ids[5])).toMatchObject({
      pinnedAt: null,
      archivedAt: null,
    });
    expect(saved?.pinnedOrder).toEqual([
      { kind: "conversation", id: conversation },
    ]);
  } finally {
    await app.close();
  }
});

test("project menus: sidebar, list and detail keep same-name project identities and keyboard focus", async () => {
  const { app, page, ids } = await launch(["同名", "同名", "其他"]);
  const sidebar = page.locator("#main-sidebar");
  const first = sidebar.locator(`[data-project='${ids[0]}']`);
  const second = sidebar.locator(`[data-project='${ids[1]}']`);
  try {
    await first.locator(".project-side-more").focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menu", { name: "同名 项目操作" }),
    ).toBeVisible();
    await page.keyboard.press("End");
    await expect(
      page.getByRole("menuitem", { name: "归档项目" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(first.locator(".project-side-more")).toBeFocused();
    await first.locator(".project-side-more").click();
    await page.getByRole("menuitem", { name: "编辑项目" }).click();
    const edit = page.getByRole("dialog", { name: "编辑项目" });
    await expect(edit.locator(".project-folder-path")).toContainText(ids[0]);
    await edit.getByRole("button", { name: "取消" }).click();
    await expect(first.locator(".project-side-more")).toBeFocused();

    await goTo(page, "项目");
    const listRow = page
      .locator(".project-table tbody tr")
      .filter({ hasText: ids[1] });
    await expect(listRow).toHaveCount(1);
    await listRow.locator(".project-more").click();
    await page.getByRole("menuitem", { name: "编辑项目" }).click();
    await expect(edit.locator(".project-folder-path")).toContainText(ids[1]);
    await edit.getByRole("button", { name: "取消" }).click();
    await second.locator(".project-side-open").click();
    await expect(
      page.locator(".project-detail-card .project-folder-path"),
    ).toContainText(ids[1]);
    await page.locator(".project-detail-heading .project-more").click();
    await expect(page.getByRole("menuitem", { name: "删除项目" })).toHaveCount(
      0,
    );
    await page.getByRole("menuitem", { name: "归档项目" }).click();
    await expect(page.locator(".project-tag")).toHaveText("已归档");
    const saved = await page.evaluate(async () => {
      const reply = await window.desktop.command({ type: "snapshot" });
      return reply.ok ? reply.snapshot.projects : [];
    });
    expect(saved.find((item) => item.id === ids[0])?.archivedAt).toBeNull();
    expect(saved.find((item) => item.id === ids[1])?.archivedAt).not.toBeNull();
    await expect(first).toBeVisible();
    await expect(second).toHaveCount(0);
  } finally {
    await app.close();
  }
});
