import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  seedEditCandidate,
  seedRetainedWidgets,
} from "./widget-generation-fixture";
import { launchLocal, closeLocal } from "./local-client";
import { goTo, requestSize, recent, settingsDialog, sidebar } from "./shell";
import { Store } from "../../src/service/store";
import { inspectProjectFolder } from "../../src/main/projects";
import type { HostCommand } from "../../src/shared/protocol";
import {
  extendWithinDays,
  expiringWithinDays,
} from "../../src/renderer/recently-deleted";
import { projectDeletionNotice } from "../../src/renderer/deletion-dialogs";

// Deleting retained widgets and projects, and the settings page 最近删除 shared with deleted conversations
// (WB-04, PROJECT-03, CHAT-02, D-03).

function root(name: string) {
  mkdirSync(".test-data/disposable", { recursive: true });
  return mkdtempSync(
    resolve(`.test-data/disposable/recently-deleted-${name}-`),
  );
}
const shown = (page: Page) =>
  page
    .locator("[data-formal-widget]")
    .evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-formal-widget")),
    );
const stored = (dir: string, sql: string, ...values: string[]) => {
  const db = new DatabaseSync(join(dir, "state.sqlite"), { readOnly: true });
  try {
    return db.prepare(sql).all(...values) as Record<string, unknown>[];
  } finally {
    db.close();
  }
};
const savedOrder = (dir: string) =>
  stored(dir, "SELECT id FROM saved_widgets ORDER BY position").map(
    (r) => r.id,
  );
const menuButton = (page: Page, name: string, id: string) =>
  page.getByRole("button", {
    name: `控件操作 ${name} ${id.slice(0, 8)}`,
    exact: true,
  });
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
async function openRecentlyDeleted(page: Page) {
  await goTo(page, "设置");
  const dialog = settingsDialog(page);
  await dialog
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "最近删除", exact: true })
    .click();
  await expect(dialog.getByRole("radiogroup", { name: "类型" })).toBeVisible();
  return dialog;
}

test("recently deleted: deleting a widget asks first, leaves both entries together, its undo puts it back next to its neighbours; an older candidate shows the conflict", async () => {
  const dir = root("widget");
  const widgets = seedRetainedWidgets(dir, ["甲", "乙", "丙"]);
  const ids = widgets.map((w) => w.id);
  const { draftId } = seedEditCandidate(dir, ids[1]);
  const app = await launchLocal({ args: [resolve("."), `--data-root=${dir}`] });
  try {
    const main = await app.firstWindow();
    await requestSize(app, main, 1440, 900);
    await goTo(main, "控件");
    await expect(main.locator("[data-formal-widget]")).toHaveCount(3);
    const panel = await openPanel(app, main);
    await expect(panel.locator("[data-formal-widget]")).toHaveCount(3);
    // The panel has no deletion (WB-03).
    await panel.locator(`[data-formal-widget="${ids[1]}"]`).hover();
    await menuButton(panel, "乙", ids[1]).click();
    await expect(
      panel.getByRole("menuitem", { name: "在主窗口打开" }),
    ).toBeVisible();
    await expect(panel.getByRole("menuitem", { name: /删除/ })).toHaveCount(0);
    await panel.keyboard.press("Escape");

    const ask = async () => {
      await main.locator(`[data-formal-widget="${ids[1]}"]`).hover();
      await menuButton(main, "乙", ids[1]).click();
      await main.getByRole("menuitem", { name: "删除控件…" }).click();
      const dialog = main.getByRole("dialog", { name: "删除控件「乙」" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("移入最近删除，至少保留 30 天");
      await expect(dialog).toContainText(
        "1 个草稿保留；之后保留其候选时按冲突处理，不复活已删除的控件",
      );
      await expect(dialog).toContainText("主窗口与菜单栏同时移除");
      await expect(
        dialog.getByRole("button", { name: "取消", exact: true }),
      ).toBeFocused();
      return dialog;
    };
    // Cancel, the close button and Escape change nothing; focus goes back to the widget's menu button.
    let dialog = await ask();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(menuButton(main, "乙", ids[1])).toBeFocused();
    dialog = await ask();
    await main.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(menuButton(main, "乙", ids[1])).toBeFocused();
    dialog = await ask();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(savedOrder(dir)).toEqual(ids);

    const deleteNow = async () => {
      const d = await ask();
      await d.getByRole("button", { name: "移入最近删除" }).click();
      await expect(d).toHaveCount(0);
      await expect.poll(() => shown(main)).toEqual([ids[0], ids[2]]);
      await expect.poll(() => shown(panel)).toEqual([ids[0], ids[2]]);
      expect(savedOrder(dir)).toEqual([ids[0], ids[2]]);
    };
    await deleteNow();
    await expect(main.getByRole("button", { name: "新建控件" })).toBeFocused();
    const notice = main.getByRole("status").filter({
      hasText: "已删除「乙」；可在设置「最近删除」恢复。",
    });
    await expect(notice).toBeVisible();
    // Undo within the notice: same identity, between its former neighbours, in both entries.
    await notice.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(() => shown(main)).toEqual(ids);
    await expect.poll(() => shown(panel)).toEqual(ids);
    expect(savedOrder(dir)).toEqual(ids);
    expect(stored(dir, "SELECT COUNT(*) AS n FROM deleted_widgets")[0].n).toBe(
      0,
    );
    await expect(
      main.locator(`[data-formal-widget="${ids[1]}"]`),
    ).toBeFocused();

    // Deleted again: the edit candidate made before cannot bring 乙 back.
    await deleteNow();
    await main.getByRole("button", { name: /^草稿 / }).click();
    await main
      .getByRole("button", { name: `编辑草稿 ${draftId.slice(0, 8)}` })
      .click();
    await expect(main.getByText("冲突：目标控件已删除")).toBeVisible();
    await expect(
      main.getByRole("button", { name: "保留控件", exact: true }),
    ).toBeDisabled();
  } finally {
    await closeLocal(app);
  }
});

async function seedProjects(dir: string) {
  const folder = join(dir, "repository");
  mkdirSync(join(folder, "src"), { recursive: true });
  writeFileSync(join(folder, "README.md"), "外部仓库\n");
  writeFileSync(join(folder, "src", "main.txt"), "源码\n");
  const data = join(dir, "data");
  mkdirSync(data);
  const info = await inspectProjectFolder(folder);
  const store = new Store(data, true);
  const host = (c: HostCommand) => {
    const r = store.execute(c, "main", "host");
    if (!r.ok) throw new Error(r.message);
  };
  const create = (name: string, goal: string) => {
    const id = randomUUID();
    host({ type: "projectCreate", id, name, goal, folder: info });
    return id;
  };
  try {
    const first = create("同名项目", "甲目标");
    const second = create("同名项目", "乙目标");
    const unknown = create("结果未知", "核实发布");
    const chat = randomUUID();
    host({
      type: "projectWork",
      request: { type: "chat", projectId: first, conversationId: chat },
    } as HostCommand);
    store.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,turn_id,role,content,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        chat,
        null,
        "user",
        "项目里的讨论",
        new Date().toISOString(),
      );
    // A Runtime operation of the third project whose result is unknown.
    const instance = randomUUID();
    store.db.exec("PRAGMA foreign_keys=OFF");
    store.db
      .prepare(
        "INSERT INTO project_runtime(project_id,record,instance_id,scope_ref) VALUES(?,?,?,?)",
      )
      .run(
        unknown,
        JSON.stringify({
          instanceId: instance,
          scopeRef: "scope-1",
          bindingRef: "b",
          resourceHandle: "r",
        }),
        instance,
        "scope-1",
      );
    store.db
      .prepare(
        "INSERT INTO runtime_operations(operation_id,instance_id,scope_ref,method,idempotency_key,record,created_at,updated_at,touched) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        instance,
        "scope-1",
        "task.publish",
        null,
        JSON.stringify({ status: "unknown" }),
        "2026-10-25T00:00:00.000Z",
        "2026-10-25T00:00:00.000Z",
        1,
      );
    store.db.exec("PRAGMA foreign_keys=ON");
    return { folder, data, first, second, unknown, chat };
  } finally {
    store.close();
  }
}
function digest(folder: string) {
  const out: Record<string, string> = {};
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        out[full.slice(folder.length)] = createHash("sha256")
          .update(readFileSync(full))
          .digest("hex");
    }
  };
  walk(folder);
  return out;
}

test("recently deleted: a project is deleted from its detail, the list or the sidebar after a separate confirmation; cancel stays with focus back, its conversation stays reachable and its folder unchanged", async () => {
  const dir = root("project");
  const seeded = await seedProjects(dir);
  const before = digest(seeded.folder);
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${seeded.data}`],
  });
  try {
    const page = await app.firstWindow();
    await requestSize(app, page, 1440, 900);
    await goTo(page, "项目");
    await page.getByRole("button", { name: /同名项目\s*甲目标/ }).click();
    const heading = page.locator(".project-detail-heading h2");
    await expect(heading).toHaveText("同名项目");
    const ops = page
      .locator(".project-detail-heading")
      .getByRole("button", { name: "同名项目 项目操作" });
    const ask = async () => {
      await ops.click();
      await page.getByRole("menuitem", { name: "删除项目" }).click();
      const dialog = page.getByRole("dialog", { name: "删除项目「同名项目」" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("移入最近删除，至少保留 30 天");
      await expect(dialog).toContainText("1 段，保留在最近聊天中，可继续打开");
      await expect(dialog).toContainText(`${seeded.folder}：不删除，字节不变`);
      await expect(
        dialog.getByRole("button", { name: "取消", exact: true }),
      ).toBeFocused();
      return dialog;
    };
    // Cancel, the close button and Escape keep the detail and give focus back to the menu entry.
    let dialog = await ask();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(heading).toHaveText("同名项目");
    await expect(ops).toBeFocused();
    dialog = await ask();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(ops).toBeFocused();
    dialog = await ask();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(ops).toBeFocused();
    expect(
      stored(
        seeded.data,
        "SELECT deleted_at FROM projects WHERE id=?",
        seeded.first,
      )[0].deleted_at,
    ).toBeNull();

    dialog = await ask();
    await dialog.getByRole("button", { name: "移入最近删除" }).click();
    await expect(dialog).toHaveCount(0);
    // Back on the list; the other same-name project stays.
    await expect(page.locator(".project-detail-heading")).toHaveCount(0);
    await expect(page.locator(".project-primary")).toBeFocused();
    await expect(
      page.getByRole("button", { name: /同名项目\s*乙目标/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /同名项目\s*甲目标/ }),
    ).toHaveCount(0);
    const notice = page.getByRole("status").filter({
      hasText: "已将「同名项目」移入最近删除，至少保留 30 天。",
    });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("button", { name: "撤销" })).toHaveCount(
      projectDeletionNotice.includes("undo") ? 1 : 0,
    );
    await expect(
      notice.getByRole("button", { name: "打开最近删除" }),
    ).toHaveCount(projectDeletionNotice.includes("open") ? 1 : 0);
    // 打开最近删除 in the notice shows the deleted project there.
    if (projectDeletionNotice.includes("open")) {
      await notice.getByRole("button", { name: "打开最近删除" }).click();
      const settings = settingsDialog(page);
      await expect(
        settings
          .locator(".recently-deleted-row")
          .filter({ hasText: "同名项目" }),
      ).toHaveCount(1);
      await settings.getByRole("button", { name: "关闭设置" }).click();
    }
    // The project's conversation stays in the recent list and opens.
    await (
      await recent(page)
    )
      .getByRole("button", {
        name: `对话 ${seeded.chat.slice(0, 8)}`,
        exact: true,
      })
      .click();
    await expect(page.getByText("项目里的讨论")).toBeVisible();
    // The sidebar's menu: work with an unknown result blocks the deletion and points to its records.
    const side = await sidebar(page);
    await side.locator(`[data-project-menu="${seeded.unknown}"]`).click();
    await page.getByRole("menuitem", { name: "删除项目" }).click();
    dialog = page.getByRole("dialog", { name: "删除项目「结果未知」" });
    await expect(dialog).toContainText("暂时不能删除");
    await expect(
      dialog.getByRole("button", { name: "移入最近删除" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "查看项目记录" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "运行记录" })).toBeVisible();
    // The sidebar's menu deletes the other same-name project.
    await side.locator(`[data-project-menu="${seeded.second}"]`).click();
    await page.getByRole("menuitem", { name: "删除项目" }).click();
    dialog = page.getByRole("dialog", { name: "删除项目「同名项目」" });
    await dialog.getByRole("button", { name: "移入最近删除" }).click();
    await expect(
      side.locator(`[data-project-menu="${seeded.second}"]`),
    ).toHaveCount(0);
    expect(
      stored(
        seeded.data,
        "SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NOT NULL",
      )[0].n,
    ).toBe(2);
    expect(digest(seeded.folder)).toEqual(before);
  } finally {
    await closeLocal(app);
  }
});

test("recently deleted: settings shows the three kinds with counts and filters, extends, permanently deletes with its own confirmation and restores each to its place across a restart", async () => {
  const dir = root("settings");
  const seeded = await seedProjects(dir);
  const widgets = seedRetainedWidgets(seeded.data, ["甲", "乙", "丙"]);
  const ids = widgets.map((w) => w.id);
  const running = seedEditCandidate(seeded.data, ids[2], false);
  const store = new Store(seeded.data);
  const day = 86_400_000;
  try {
    const run = (c: Parameters<Store["execute"]>[0]) => {
      const r = store.execute(c, "main");
      if (!r.ok) throw new Error(r.message);
      return r;
    };
    for (const w of [widgets[1], widgets[2]])
      run({
        type: "deleteWidget",
        id: w.id,
        revision: w.revision,
        confirmed: true,
      });
    const p = store.snapshot().projects.find((p) => p.id === seeded.first)!;
    run({
      type: "deleteProject",
      id: p.id,
      revision: p.revision,
      confirmed: true,
    });
    const c = store.snapshot().conversations.find((c) => c.id === seeded.chat)!;
    run({
      type: "organizeConversation",
      id: c.id,
      action: "delete",
      revision: c.organizationRevision,
      confirmed: true,
    });
    // 乙 ends its retention in two days; the generation of 丙 never confirmed its stop.
    store.db
      .prepare("UPDATE deleted_widgets SET retain_until=? WHERE id=?")
      .run(new Date(Date.now() + 2 * day - 60_000).toISOString(), ids[1]);
    store.db
      .prepare(
        "UPDATE widget_generation_tasks SET stop_unconfirmed=1 WHERE id=?",
      )
      .run(running.taskId);
    // The conversation has five days left: within the days 延长 30 天 shows; the project has the full 30.
    store.db
      .prepare("UPDATE conversations SET retain_until=? WHERE id=?")
      .run(new Date(Date.now() + 5 * day - 60_000).toISOString(), seeded.chat);
  } finally {
    store.close();
  }
  let app = await launchLocal({
    args: [resolve("."), `--data-root=${seeded.data}`],
  });
  try {
    let page = await app.firstWindow();
    await requestSize(app, page, 1440, 900);
    let dialog = await openRecentlyDeleted(page);
    const filters = dialog.getByRole("radiogroup", { name: "类型" });
    const radio = (name: string, count: number) =>
      filters.getByRole("radio", { name: new RegExp(`^${name}\\s*${count}$`) });
    await expect(radio("全部", 4)).toHaveAttribute("aria-checked", "true");
    await expect(radio("项目", 1)).toBeVisible();
    await expect(radio("对话", 1)).toBeVisible();
    await expect(radio("控件", 2)).toBeVisible();
    await expect(dialog.getByText("1 项即将到期")).toBeVisible();
    const rows = dialog.locator(".recently-deleted-row");
    await expect(rows).toHaveCount(4);
    // The soonest end of retention comes first.
    await expect(rows.first()).toContainText("乙");
    await expect(rows.first()).toContainText("还剩 2 天");
    await radio("控件", 2).click();
    await expect(rows).toHaveCount(2);
    await radio("项目", 1).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("同名项目");
    await radio("全部", 4).click();
    // 延长 30 天 shows within the configured days before the end of the retention.
    const extendOf = (kind: string, name: string) =>
      dialog.getByRole("button", { name: `延长 30 天 ${kind} ${name}` });
    await expect(extendOf("项目", "同名项目")).toHaveCount(
      extendWithinDays === null ? 1 : 0,
    );
    await expect(extendOf("对话", "项目对话")).toHaveCount(1);
    const conversationEnd = () =>
      Date.parse(
        String(
          stored(
            seeded.data,
            "SELECT retain_until FROM conversations WHERE id=?",
            seeded.chat,
          )[0].retain_until,
        ),
      );
    const beforeConversation = conversationEnd();
    await extendOf("对话", "项目对话").click();
    await expect(
      dialog.getByText(/已延长 30 天：「项目对话」保留至/),
    ).toBeVisible();
    expect(conversationEnd() - beforeConversation).toBe(30 * day);
    const beforeExtend = Date.parse(
      String(
        stored(
          seeded.data,
          "SELECT retain_until FROM deleted_widgets WHERE id=?",
          ids[1],
        )[0].retain_until,
      ),
    );
    await extendOf("控件", "乙").click();
    await expect(dialog.getByText(/已延长 30 天：「乙」保留至/)).toBeVisible();
    expect(
      Date.parse(
        String(
          stored(
            seeded.data,
            "SELECT retain_until FROM deleted_widgets WHERE id=?",
            ids[1],
          )[0].retain_until,
        ),
      ) - beforeExtend,
    ).toBe(30 * day);
    expect(expiringWithinDays).toBeGreaterThanOrEqual(2);
    await expect(dialog.getByText("1 项即将到期")).toHaveCount(0);

    // A protected widget cannot be permanently deleted; the dialog offers its restore instead.
    await dialog.getByRole("button", { name: "永久删除 控件 丙" }).click();
    let confirm = page.getByRole("dialog", { name: "不能永久删除「丙」" });
    await expect(confirm).toContainText("仍被保护");
    await expect(confirm).toContainText("进行中的生成任务");
    await confirm
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    await expect(confirm).toHaveCount(0);

    // A permanent deletion has its own confirmation; cancel and Escape delete nothing.
    const purge = dialog.getByRole("button", {
      name: "永久删除 对话 项目对话",
    });
    await purge.click();
    confirm = page.getByRole("dialog", { name: "永久删除「项目对话」" });
    await expect(confirm).toContainText("永久删除后不能恢复");
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    await expect(purge).toBeFocused();
    await purge.click();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    expect(
      stored(
        seeded.data,
        "SELECT purged_at FROM conversations WHERE id=?",
        seeded.chat,
      )[0].purged_at,
    ).toBeNull();
    await purge.click();
    await confirm
      .getByRole("button", { name: "永久删除", exact: true })
      .click();
    await expect(confirm).toHaveCount(0);
    await expect(dialog.getByText("已永久删除「项目对话」。")).toBeVisible();
    await expect(rows).toHaveCount(3);
    expect(
      stored(
        seeded.data,
        "SELECT purged_at FROM conversations WHERE id=?",
        seeded.chat,
      )[0].purged_at,
    ).not.toBeNull();

    // Restore 乙: back between 甲 and its former next neighbour's place.
    await dialog.getByRole("button", { name: "恢复 控件 乙" }).click();
    await expect(dialog.getByText("已恢复「乙」。")).toBeVisible();
    expect(savedOrder(seeded.data)).toEqual([ids[0], ids[1]]);

    // Across a restart the remaining entries are the same and restore with their identity.
    await closeLocal(app);
    app = await launchLocal({
      args: [resolve("."), `--data-root=${seeded.data}`],
    });
    page = await app.firstWindow();
    await requestSize(app, page, 1440, 900);
    dialog = await openRecentlyDeleted(page);
    await expect(dialog.locator(".recently-deleted-row")).toHaveCount(2);
    await dialog.getByRole("button", { name: "恢复 项目 同名项目" }).click();
    await expect(
      dialog.getByText(
        "已恢复项目「同名项目」；不会自动重新置顶，之后改过归属的对象不回退。",
      ),
    ).toBeVisible();
    await goTo(page, "项目");
    await expect(
      page.getByRole("button", { name: /同名项目\s*甲目标/ }),
    ).toBeVisible();
    expect(
      stored(
        seeded.data,
        "SELECT pinned_at,deleted_at FROM projects WHERE id=?",
        seeded.first,
      )[0],
    ).toEqual({ pinned_at: null, deleted_at: null });
    // The conversation purged while the project was deleted does not come back with it.
    expect(
      stored(
        seeded.data,
        "SELECT COUNT(*) AS n FROM project_chats WHERE project_id=?",
        seeded.first,
      )[0].n,
    ).toBe(0);
  } finally {
    await closeLocal(app);
  }
});
