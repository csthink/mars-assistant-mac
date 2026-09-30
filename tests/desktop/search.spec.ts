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
    const dialog = page.getByRole("dialog", { name: "搜索对话" }),
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
    const dialog = page.getByRole("dialog", { name: "搜索对话" }),
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
    const search = page.getByRole("dialog", { name: "搜索对话" });
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
