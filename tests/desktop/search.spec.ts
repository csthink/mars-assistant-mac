import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import { launchLocal } from "./local-client";
import { closeRecent, goTo, openConversation, recent } from "./shell";
import { Store } from "../../src/service/store";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { updateAutomaticTitle } from "../../src/service/titles";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { seedRetainedWidgets } from "./widget-generation-fixture";
function seed() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/search-ui-"));
  const store = new Store(root);
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids) {
    store.execute({ type: "create", id }, "main");
    store.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user',?,?)",
      )
      .run(
        randomUUID(),
        id,
        "如何查找本地消息？后续问题",
        new Date().toISOString(),
      );
    updateAutomaticTitle(store.db, id);
  }
  store.close();
  return { root, ids };
}
test("search: rename preserves manual titles, duplicate identity and failed input", async ({}, info) => {
  const { root, ids } = seed();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    await expect((await recent(page)).getByText(/同名 2/)).toHaveCount(2);
    await closeRecent(page);
    // Renaming happens in place on the centre title.
    const field = page
      .locator(".center-header")
      .getByRole("textbox", { name: /^重命名对话/ });
    await page.getByRole("button", { name: "修改对话名称" }).click();
    await field.fill("我的离线资料");
    await field.press("Escape");
    await expect((await recent(page)).getByText("我的离线资料")).toHaveCount(0);
    await closeRecent(page);
    await page.getByRole("button", { name: "修改对话名称" }).click();
    await field.fill("保留我的输入");
    await page.evaluate(async (id) => {
      const r = await window.desktop.command({
        type: "renameConversation",
        id,
        title: "另一入口保存的标题",
        revision: 0,
      });
      if (!r.ok) throw new Error(r.message);
    }, ids[1]);
    await field.press("Enter");
    // A failed save keeps the field and the typed text, says why and shows the saved name.
    const alert = page.locator(".center-header").getByRole("alert");
    await expect(alert).toContainText("另一入口");
    await expect(alert).toContainText("另一入口保存的标题");
    await expect(field).toHaveValue("保留我的输入");
    await page.screenshot({ path: info.outputPath("rename-conflict.png") });
    await field.press("Enter");
    await expect(field).toHaveCount(0);
    await expect(
      (await recent(page)).getByText("保留我的输入", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      (await recent(page)).getByText("保留我的输入", { exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("search: offline literal results, keyboard navigation, precise messages and stale response rejection", async ({}, info) => {
  const { root, ids } = seed();
  const store = new Store(root);
  const target = randomUUID();
  for (let i = 0; i < 35; i++)
    store.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user',?,?)",
      )
      .run(
        i === 2 ? target : randomUUID(),
        ids[0],
        i === 2
          ? "这条消息含独有正文、CAFÉ 与 literal%under_score <script>安全文本</script>"
          : `其他消息 ${i}`,
        new Date().toISOString(),
      );
  store.execute(
    {
      type: "renameConversation",
      id: ids[0],
      title: "手动专属标题",
      revision: 0,
    },
    "main",
  );
  store.execute(
    { type: "saveDraft", id: ids[0], text: "草稿秘密不可搜索", revision: 0 },
    "main",
  );
  store.close();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => !w.isDestroyed() && w.isVisible())
        ?.setContentSize(900, 680);
    });
    await page.context().setOffline(true);
    await page.keyboard.press("Meta+k");
    const dialog = page.getByRole("dialog", { name: "全局搜索" }),
      input = dialog.getByRole("combobox");
    await expect(dialog).toBeVisible();
    await input.fill("专属标题");
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await input.fill("独有正文");
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await expect(dialog.locator("mark")).toContainText(["独有正文"]);
    await page.screenshot({
      path: info.outputPath("search-minimum-window.png"),
    });
    await input.dispatchEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
    });
    await expect(dialog).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      const internal = ipcMain as unknown as {
        _invokeHandlers: Map<
          string,
          (event: unknown, command: { type: string }) => Promise<unknown>
        >;
      };
      const original = internal._invokeHandlers.get("business:command")!;
      let failed = false;
      ipcMain.removeHandler("business:command");
      ipcMain.handle("business:command", (event, command) => {
        if (command.type === "select" && !failed) {
          failed = true;
          return {
            ok: false,
            code: "WRITE_FAILED",
            message: "合成选择保存失败",
          };
        }
        return original(event, command);
      });
    });
    await input.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText("未能打开原对话");
    await expect(dialog).toBeVisible();
    await input.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(`#message-${target}`)).toHaveClass(
      /search-match-message/,
    );
    await expect(page.locator(`#message-${target} mark`)).toHaveText(
      "独有正文",
    );
    const box = await page.locator(`#message-${target}`).boundingBox();
    expect(box!.y).toBeGreaterThan(0);
    expect(box!.y + box!.height).toBeLessThan(680);
    await expect(page.getByLabel("输入草稿")).toHaveValue("草稿秘密不可搜索");
    await page.keyboard.press("Meta+k");
    await input.fill("草稿秘密");
    await expect(
      dialog.getByText("没有找到匹配内容", { exact: true }),
    ).toBeVisible();
    await input.fill("literal%under_score");
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await input.fill("café");
    await expect(dialog.locator("mark")).toContainText(["CAFÉ"]);
    // Delay the older response at the registered host boundary, leaving production renderer logic intact.
    await app.evaluate(({ ipcMain }) => {
      const internal = ipcMain as unknown as {
        _invokeHandlers: Map<
          string,
          (event: unknown, request: { query: string }) => Promise<unknown>
        >;
      };
      const original = internal._invokeHandlers.get("business:search")!;
      ipcMain.removeHandler("business:search");
      ipcMain.handle("business:search", async (event, request) => {
        const reply = await original(event, request);
        if (request.query === "旧结果")
          await new Promise((r) => setTimeout(r, 350));
        return reply;
      });
    });
    await input.fill("旧结果");
    await page.waitForTimeout(100);
    await input.fill("独有正文");
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await page.waitForTimeout(450);
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await input.fill("");
    await expect(dialog.getByRole("option")).toHaveCount(2);
    await input.press("ArrowDown");
    await expect(dialog.getByRole("option").nth(1)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await input.press("Escape");
    await expect(dialog).toHaveCount(0);
    await goTo(page, "设置");
    await page.getByRole("button", { name: "数据与隐私", exact: true }).click();
    await page
      .getByRole("button", { name: "重建搜索索引", exact: true })
      .click();
    await expect(
      page.getByText("搜索索引已重建。", { exact: true }),
    ).toBeVisible();
    // Command + K never opens the search panel over the settings dialog; close it first.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+k");
    await input.fill("独有正文");
    await expect(dialog.getByRole("option")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("search: 1000 conversations and 20000 messages render cold and warm first pages within budget", async ({}, info) => {
  test.setTimeout(120000);
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/search-scale-"));
  const store = new Store(root);
  const hash = createHash("sha256");
  const sizes: Record<string, number> = {};
  store.db.exec("BEGIN IMMEDIATE");
  const insertConversation = store.db.prepare(
    "INSERT INTO conversations(id,title,updated_at) VALUES(?,?,?)",
  );
  const insertMessage = store.db.prepare(
    "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user',?,?)",
  );
  for (let c = 0; c < 1000; c++) {
    const cid = `scale-${c.toString().padStart(4, "0")}`;
    insertConversation.run(cid, `合成对话 ${c}`, "2026-09-07T03:00:00Z");
    for (let n = 0; n < 20; n++) {
      const i = c * 20 + n,
        size = n < 15 ? 256 : n < 19 ? 2048 : 8192;
      sizes[size] = (sizes[size] ?? 0) + 1;
      const seed = `对话${c} 消息${i} 离线文本 SQLite 工作台 恢复配置。`;
      let body = seed.repeat(Math.ceil(size / seed.length)).slice(0, size);
      if (i === 19999)
        body +=
          '权限撤销 罕见结果 needle_last literal%under_score "quoted" CAFÉ';
      hash.update(`${i}\0${body}\n`);
      insertMessage.run(`message-${i}`, cid, body, "2026-09-07T03:00:00Z");
    }
  }
  store.db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  store.close();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    await page.keyboard.press("Meta+k");
    const dialog = page.getByRole("dialog", { name: "全局搜索" }),
      input = dialog.getByRole("combobox");
    await expect(dialog.getByRole("option")).toHaveCount(40);
    // Retain both the user-visible duration and the main-process search duration.
    // The difference includes debounce, IPC queueing and the rendered frame.
    await app.evaluate(({ ipcMain }) => {
      const internal = ipcMain as unknown as {
        _invokeHandlers: Map<
          string,
          (event: unknown, request: { query: string }) => Promise<unknown>
        >;
      };
      const original = internal._invokeHandlers.get("business:search")!;
      const measured = globalThis as typeof globalThis & {
        searchIpcTimings?: { query: string; milliseconds: number }[];
      };
      measured.searchIpcTimings = [];
      ipcMain.removeHandler("business:search");
      ipcMain.handle("business:search", async (event, request) => {
        const started = performance.now();
        try {
          return await original(event, request);
        } finally {
          measured.searchIpcTimings!.push({
            query: request.query,
            milliseconds: performance.now() - started,
          });
        }
      });
    });
    const queries = [
      "恢",
      "权限",
      "权限撤销",
      "罕见结果",
      "needle_last",
      "不存在词语",
      "literal%under_score",
      '"quoted"',
      "CAFÉ",
      "工作台",
    ];
    const samples: {
      mode: string;
      query: string;
      milliseconds: number;
      ipcMilliseconds: number;
      outsideIpcMilliseconds: number;
    }[] = [];
    for (const mode of ["cold-worker", "warm-worker"]) {
      for (let i = 0; i < 30; i++) {
        const query = queries[i % queries.length];
        if (mode === "cold-worker")
          await page.evaluate(() => window.desktop.cancelSearch());
        // The production input event starts the clock; the result must pass a rendered frame.
        await input.evaluate((el) => {
          const w = window as unknown as {
            searchMeasurement?: { started: number; elapsed?: number };
          };
          el.addEventListener(
            "input",
            () => {
              w.searchMeasurement = { started: performance.now() };
              const poll = () => {
                const results = document.getElementById("search-results");
                if (results?.getAttribute("aria-busy") === "false")
                  requestAnimationFrame(() => {
                    if (w.searchMeasurement)
                      w.searchMeasurement.elapsed =
                        performance.now() - w.searchMeasurement.started;
                  });
                else requestAnimationFrame(poll);
              };
              requestAnimationFrame(poll);
            },
            { once: true, capture: true },
          );
        });
        await input.fill(query);
        await expect(dialog.getByRole("listbox")).toHaveAttribute(
          "aria-busy",
          "false",
        );
        if (query === "不存在词语")
          await expect(
            dialog.getByText("没有找到匹配内容", { exact: true }),
          ).toBeVisible();
        else await expect(dialog.getByRole("option").first()).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    searchMeasurement?: { elapsed?: number };
                  }
                ).searchMeasurement?.elapsed,
            ),
          )
          .toBeGreaterThan(0);
        const milliseconds = await page.evaluate(
          () =>
            (window as unknown as { searchMeasurement: { elapsed: number } })
              .searchMeasurement.elapsed,
        );
        const ipcTiming = await app.evaluate(() => {
          const measured = globalThis as typeof globalThis & {
            searchIpcTimings?: { query: string; milliseconds: number }[];
          };
          return measured.searchIpcTimings?.at(-1);
        });
        expect(ipcTiming?.query).toBe(query);
        const ipcMilliseconds = ipcTiming!.milliseconds;
        samples.push({
          mode,
          query,
          milliseconds,
          ipcMilliseconds,
          outsideIpcMilliseconds: milliseconds - ipcMilliseconds,
        });
      }
    }
    const percentile = (mode: string) => {
      const values = samples
        .filter((s) => s.mode === mode)
        .map((s) => s.milliseconds)
        .sort((a, b) => a - b);
      return values[Math.ceil(values.length * 0.95) - 1];
    };
    const result = {
      schema_version: 1,
      conversations: 1000,
      messages: 20000,
      distribution: sizes,
      source_sha256: hash.digest("hex"),
      clock: "input event to results rendered frame, includes debounce and IPC",
      cold: "new read worker and SQLite connection; OS filesystem cache not cleared",
      samples,
      p95: { cold: percentile("cold-worker"), warm: percentile("warm-worker") },
      budget_ms: 500,
    };
    writeFileSync(
      info.outputPath("search-performance.json"),
      JSON.stringify(result, null, 2),
    );
    await page.screenshot({ path: info.outputPath("search-scale.png") });
    expect(result.p95.cold).toBeLessThanOrEqual(500);
    expect(result.p95.warm).toBeLessThanOrEqual(500);
  } finally {
    await app.close();
  }
});

test("search: recent conversations keep creation order after renaming the oldest and reloading", async () => {
  const { root, ids } = seed();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    const labels = [ids[1], ids[0]].map((id) => `对话 ${id.slice(0, 8)}`);
    const check = async () => {
      const list = await recent(page);
      await expect
        .poll(() =>
          list
            .locator(".session")
            .evaluateAll((nodes) =>
              nodes.map((n) => n.getAttribute("aria-label")),
            ),
        )
        .toEqual(labels);
    };
    await check();
    await openConversation(page, labels[1]);
    await page.getByRole("button", { name: "修改对话名称" }).click();
    const rename = page
      .locator(".center-header")
      .getByRole("textbox", { name: /^重命名对话/ });
    await rename.fill("最早创建的改名对话");
    await rename.press("Enter");
    await expect(rename).toHaveCount(0);
    await check();
    await page.reload();
    await check();
    await page.keyboard.press("Meta+k");
    const search = page.getByRole("dialog", { name: "全局搜索" });
    await expect(search.getByRole("option")).toHaveCount(2);
    await expect(search.getByRole("option").nth(1)).toContainText(
      "最早创建的改名对话",
    );
    await page.keyboard.press("Escape");
    await check();
  } finally {
    await app.close();
  }
});

test("search: projects and retained widgets open the same identity, same names stay apart, archived stays archived, pages continue and a vanished target says so", async () => {
  const { root } = seed();
  const widgets = seedRetainedWidgets(root, ["松果看板", "松果看板"]);
  const store = new Store(root);
  const folder = (n: number) =>
    JSON.stringify({
      path: `/tmp/fixture-${n}`,
      canonicalPath: `/tmp/fixture-${n}`,
      identity: `fixture-${n}`,
      git: null,
    });
  const insertProject = store.db.prepare(
    "INSERT INTO projects(id,name,goal,folder_json,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,?)",
  );
  const same = [randomUUID(), randomUUID()];
  insertProject.run(
    same[0],
    "松果计划",
    "整理松果标本",
    folder(0),
    "2026-10-01T00:00:00Z",
    "2026-10-01T00:00:00Z",
    null,
  );
  insertProject.run(
    same[1],
    "松果计划",
    "",
    folder(1),
    "2026-10-02T00:00:00Z",
    "2026-10-02T00:00:00Z",
    "2026-10-03T00:00:00Z",
  );
  for (let i = 0; i < 45; i++)
    insertProject.run(
      randomUUID(),
      `翻页项目 ${i}`,
      "",
      folder(10 + i),
      "2026-09-01T00:00:00Z",
      `2026-09-01T00:${String(i).padStart(2, "0")}:00Z`,
      null,
    );
  store.db
    .prepare("UPDATE widget_previews SET data=? WHERE candidate_id=?")
    .run(
      JSON.stringify({ note: "第二个看板的松果笔记" }),
      widgets[1].candidateId,
    );
  store.close();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    await page.context().setOffline(true);
    await page.keyboard.press("Meta+k");
    const dialog = page.getByRole("dialog", { name: "全局搜索" }),
      input = dialog.getByRole("combobox"),
      tabs = dialog.getByRole("tablist", { name: "搜索分类" });
    await input.fill("松果");
    await expect(tabs.getByRole("tab")).toHaveText([
      "全部4",
      "对话0",
      "项目2",
      "控件2",
    ]);
    const projects = dialog
      .getByRole("group", { name: "项目" })
      .getByRole("option");
    await expect(projects).toHaveCount(2);
    // Same names stay two results with their own identities; the archived one is marked.
    await expect(projects.nth(0)).toContainText(same[1].slice(0, 8));
    await expect(projects.nth(0)).toContainText("已归档");
    await expect(projects.nth(1)).toContainText(same[0].slice(0, 8));
    await expect(projects.nth(1).locator("mark")).toHaveText(["松果", "松果"]);
    const widgetHits = dialog
      .getByRole("group", { name: "控件" })
      .getByRole("option");
    await expect(widgetHits.nth(1)).toContainText("第二个看板的松果笔记");
    await expect(widgetHits.nth(1)).toContainText("控件页");
    await expect(widgetHits.nth(1)).toContainText(widgets[1].id.slice(0, 8));

    // A retained widget opens the 控件 page and focuses that card, not its same-name sibling.
    await widgetHits.nth(1).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.locator(`[data-formal-widget="${widgets[1].id}"]`),
    ).toBeFocused();
    await expect(
      page.locator(`[data-formal-widget="${widgets[1].id}"]`),
    ).toBeInViewport();

    // The archived project opens its detail and stays archived.
    await page.keyboard.press("Meta+k");
    await input.fill("松果计划");
    await dialog.locator(`[data-search-object="${same[1]}"]`).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "松果计划", exact: true }),
    ).toBeVisible();
    const db = new DatabaseSync(join(root, "state.sqlite"));
    try {
      expect(
        db.prepare("SELECT archived_at FROM projects WHERE id=?").get(same[1])!
          .archived_at,
      ).toBe("2026-10-03T00:00:00Z");

      // A category pages after its last hit: 45 matches, 40 then 5, and back.
      await page.keyboard.press("Meta+k");
      await input.fill("翻页项目");
      await tabs.getByRole("tab", { name: /^项目/ }).click();
      await expect(dialog.getByRole("option")).toHaveCount(40);
      const firstPage = await dialog
        .getByRole("option")
        .evaluateAll((n) => n.map((e) => e.getAttribute("data-search-object")));
      await dialog.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(dialog.getByRole("option")).toHaveCount(5);
      const secondPage = await dialog
        .getByRole("option")
        .evaluateAll((n) => n.map((e) => e.getAttribute("data-search-object")));
      expect(new Set([...firstPage, ...secondPage]).size).toBe(45);
      await dialog.getByRole("button", { name: "上一页", exact: true }).click();
      await expect(dialog.getByRole("option")).toHaveCount(40);

      // A target removed after the results were drawn is reported, and nothing else opens.
      await tabs.getByRole("tab", { name: /^控件/ }).click();
      await input.fill("松果看板");
      await expect(dialog.getByRole("option")).toHaveCount(2);
      db.prepare("DELETE FROM saved_widgets WHERE id=?").run(widgets[0].id);
      // Any committed command republishes the snapshot the renderer checks against.
      await page.evaluate(() => window.desktop.command({ type: "snapshot" }));
      await page.evaluate(() =>
        window.desktop.command({ type: "setAppearance", appearance: "light" }),
      );
      await dialog.locator(`[data-search-object="${widgets[0].id}"]`).click();
      await expect(dialog.getByRole("alert")).toContainText("该控件已不存在。");
      await expect(dialog).toBeVisible();
    } finally {
      db.close();
    }
  } finally {
    await app.close();
  }
});

test("search: a failed index rebuild says so and the previous index keeps answering for all three kinds", async () => {
  const { root } = seed();
  seedRetainedWidgets(root, ["重建看板"]);
  const db = new DatabaseSync(join(root, "state.sqlite"));
  db.exec(`CREATE TABLE test_rebuild_fault(id INTEGER PRIMARY KEY);
    CREATE TRIGGER test_rebuild_fault BEFORE INSERT ON search_documents
    WHEN EXISTS(SELECT 1 FROM test_rebuild_fault) BEGIN SELECT RAISE(ABORT,'injected rebuild failure'); END;`);
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    db.exec("INSERT INTO test_rebuild_fault VALUES(1)");
    await goTo(page, "设置");
    await page.getByRole("button", { name: "数据与隐私", exact: true }).click();
    await page
      .getByRole("button", { name: "重建搜索索引", exact: true })
      .click();
    await expect(
      page.getByText(
        "索引未重建。原对话、项目与控件保持不变，上一份索引仍可搜索。",
        { exact: true },
      ),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+k");
    const dialog = page.getByRole("dialog", { name: "全局搜索" });
    await dialog.getByRole("combobox").fill("重建看板");
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await dialog.getByRole("combobox").fill("如何查找");
    await expect(
      dialog.getByRole("group", { name: "对话" }).getByRole("option"),
    ).toHaveCount(4);
    await page.keyboard.press("Escape");
    db.exec("DELETE FROM test_rebuild_fault");
    await goTo(page, "设置");
    await page.getByRole("button", { name: "数据与隐私", exact: true }).click();
    await page
      .getByRole("button", { name: "重建搜索索引", exact: true })
      .click();
    await expect(
      page.getByText("搜索索引已重建。", { exact: true }),
    ).toBeVisible();
  } finally {
    db.close();
    await app.close();
  }
});
