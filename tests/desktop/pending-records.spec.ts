import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/service/store";
import { closeLocal, launchLocal } from "./local-client";
import { ready, goTo, settingsDialog } from "./shell";
import { addProvider } from "./provider-ui";
import { journeyFixture } from "./project-action-fixture";

async function fixture() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/pending-records-"));
  const store = new Store(root),
    ids: string[] = [];
  for (let n = 0; n < 30; n++) {
    const id = randomUUID(),
      at = new Date(
        Date.now() - n * 60_000 - (n === 29 ? 10 * 86400000 : 0),
      ).toISOString();
    ids.push(id);
    store.db
      .prepare(
        "INSERT INTO executions (id,kind,state,created_at,ended_at) VALUES (?,'connection_test','failed',?,?)",
      )
      .run(id, at, at);
    store.db
      .prepare(
        "INSERT INTO run_events (id,execution_id,kind,at,payload) VALUES (?,?,'failed',?,?)",
      )
      .run(
        `event-${n}`,
        id,
        at,
        JSON.stringify({ message: `记录内容 ${n}`, errorClass: "network" }),
      );
    if (n < 7)
      store.db
        .prepare(
          "INSERT INTO pending_items (id,execution_id,kind,state,created_at) VALUES (?,?,'failed_turn','open',?)",
        )
        .run(randomUUID(), id, at);
  }
  store.close();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  await ready(page);
  return { app, page, root, ids };
}

test("pending records: selection survives filters, paging and tabs; accepted results stay until the next list change and history survives restart", async () => {
  const initial = await fixture();
  const root = initial.root;
  let { app, page } = initial;
  try {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
    );
    await goTo(page, "待处理");
    await expect(page.locator(".pending-index .record-rows")).toHaveCSS(
      "max-height",
      "120px",
    );
    const detail = page.getByRole("region", { name: "事项详情", exact: true });
    await expect(
      detail.getByRole("button", { name: "忽略", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await detail.getByRole("button", { name: "重试", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(
      detail.getByRole("button", { name: "忽略", exact: true }),
    ).toBeFocused();
    await expect(
      detail.getByRole("button", { name: "忽略", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      detail.getByRole("button", { name: "忽略", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "查看证据与执行过程", exact: true })
      .click();
    await expect(page.locator("#right-panel")).toBeVisible();
    await page
      .getByRole("textbox", { name: "搜索事项", exact: true })
      .fill("不存在");
    await expect(detail).toContainText("当前筛选下没有选中的事项");
    await expect(page.locator("#right-panel")).toHaveCount(0);
    await page.getByRole("button", { name: "显示该事项", exact: true }).click();
    await expect(page.locator("#right-panel")).toBeVisible();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(detail).toContainText("选中的事项不在当前页");
    await page.getByRole("button", { name: "显示该事项", exact: true }).click();
    await detail.getByRole("button", { name: "忽略", exact: true }).click();
    await expect(
      detail.getByRole("heading", { name: "已处理", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("全部未解决：6 · 阻塞：0", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "每页数量", exact: true })
      .selectOption("10");
    await expect(detail).toContainText("该事项已移入已处理");
    await page
      .getByRole("button", { name: "在已处理中查看", exact: true })
      .click();
    await expect(
      detail.getByRole("heading", { name: "已处理", exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "待处理", exact: true }).click();
    await expect(detail).toContainText("当前页签下没有选中的事项");
    await closeLocal(app);
    app = await launchLocal({
      args: [resolve("."), `--data-root=${root}`],
      cwd: resolve("."),
    });
    page = await app.firstWindow();
    await ready(page);
    await goTo(page, "待处理");
    await page.getByRole("tab", { name: "已处理", exact: true }).click();
    await page.locator(".record-row").first().click();
    await expect(
      page.getByRole("region", { name: "事项详情", exact: true }),
    ).toContainText("事项已处理");
  } finally {
    await closeLocal(app);
  }
});

test("pending records: event queries preserve bytes, dates, pagination and absent-source boundaries while details and execution stay in the right column", async () => {
  const { app, page } = await fixture();
  try {
    const before = await page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text: string) => {
            sessionStorage.setItem("copied-event", text);
          },
        },
        configurable: true,
      }),
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
    );
    await goTo(page, "运行记录");
    await expect(
      page.getByRole("combobox", { name: "记录时间", exact: true }),
    ).toHaveValue("7");
    await expect(page.locator("#right-panel")).toHaveCount(0);
    await expect(page.locator(".record-row")).toHaveCount(12);
    await page.locator(".record-row").first().click();
    const right = page.locator("#right-panel");
    await expect(right).toContainText("event-0");
    await right
      .getByRole("button", { name: "复制事件详情", exact: true })
      .click();
    const copy = page.getByRole("dialog", {
      name: "复制事件详情",
      exact: true,
    });
    await expect(copy.locator("pre")).toContainText("event-0");
    expect(
      await page.evaluate(() => sessionStorage.getItem("copied-event")),
    ).toBeNull();
    await copy.getByRole("button", { name: "取消", exact: true }).click();
    await expect(
      right.getByRole("button", { name: "复制事件详情", exact: true }),
    ).toBeFocused();
    await right
      .getByRole("button", { name: "复制事件详情", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(copy).toHaveCount(0);
    await expect(
      right.getByRole("button", { name: "复制事件详情", exact: true }),
    ).toBeFocused();
    await right
      .getByRole("button", { name: "复制事件详情", exact: true })
      .click();
    const copied = await copy.locator("pre").innerText();
    await copy.getByRole("button", { name: "复制", exact: true }).click();
    await expect(copy).toHaveCount(0);
    expect(
      await page.evaluate(() => sessionStorage.getItem("copied-event")),
    ).toBe(copied);
    await expect(
      right.getByRole("button", { name: "打开关联对象", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(right).toContainText("选中的记录不在当前页");
    await right
      .getByRole("button", { name: "显示该记录", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "搜索运行记录", exact: true })
      .fill("记录内容 29");
    await expect(right).toContainText("当前筛选下没有选中的记录");
    await right
      .getByRole("button", { name: "显示该记录", exact: true })
      .click();
    await right
      .getByRole("button", { name: "查看执行过程", exact: true })
      .click();
    await expect(
      right.getByRole("list", { name: "运行事件", exact: true }),
    ).toContainText("记录内容 0");
    const event = right.locator(".event").first(),
      content = event.locator(".event-detail");
    const eventBox = (await event.boundingBox())!,
      contentBox = (await content.boundingBox())!;
    expect(contentBox.width / eventBox.width).toBeGreaterThan(0.9);
    const textLines = await content.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getClientRects().length;
    });
    expect(textLines).toBeLessThanOrEqual(2);
    expect(
      await right
        .getByRole("button", { name: /^(重试|停止|忽略|确认提交)$/ })
        .count(),
    ).toBe(0);
    await page
      .getByRole("combobox", { name: "记录时间", exact: true })
      .selectOption("7");
    await page
      .getByRole("button", { name: "查看全部时间", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "搜索运行记录", exact: true })
      .fill("event-29");
    await expect(page.locator(".record-row")).toHaveCount(1);
    await page.locator(".record-row").click();
    await expect(right).toContainText("记录内容 29");
    const after = await page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    if (!before.ok || !after.ok) throw Error("snapshot unavailable");
    expect(after.snapshot?.events).toEqual(before.snapshot?.events);
  } finally {
    await closeLocal(app);
  }
});

test("pending records: Runtime fixed evidence opens in the right column and project scope returns to global without new domain actions", async () => {
  const f = await journeyFixture();
  try {
    await f.page
      .getByRole("button", { name: "在待处理中处理", exact: true })
      .click();
    await expect(
      f.page.getByRole("combobox", { name: "事项范围", exact: true }),
    ).toHaveValue(f.projectId);
    await f.page.getByRole("button", { name: "回到全局", exact: true }).click();
    const before = await f.request({ type: "list", projectId: f.projectId });
    await f.page
      .getByRole("button", { name: "查看固定依据", exact: true })
      .click();
    const right = f.page.locator("#right-panel");
    await right
      .getByRole("button", { name: "读取依据 1", exact: true })
      .click();
    await expect(right.locator("pre")).toContainText("candidate revision 1");
    await f.page
      .getByRole("textbox", { name: "搜索事项", exact: true })
      .fill("不存在");
    await expect(right).toHaveCount(0);
    await f.page
      .getByRole("button", { name: "显示该事项", exact: true })
      .click();
    await expect(right).toBeVisible();
    const after = await f.request({ type: "list", projectId: f.projectId });
    expect(after).toEqual(before);
    await right
      .getByRole("button", { name: "读取依据 1", exact: true })
      .click();
    await expect(right.locator("pre")).toContainText("candidate revision 1");
    const original = await right.locator("pre").innerText();
    writeFileSync(
      join(
        f.target.runtimeRoot,
        "instances",
        f.target.instanceId.replace(/[^A-Za-z0-9._-]/g, "_"),
        "fault.json",
      ),
      JSON.stringify({ missingEvidence: true }),
    );
    await right
      .getByRole("button", { name: "读取依据 1", exact: true })
      .click();
    await expect(right.getByRole("alert")).toContainText(
      "固定版本的证据不可用，上一内容已保留。",
    );
    await expect(right.locator("pre")).toHaveText(original);
  } finally {
    await closeLocal(f.app);
  }
});

test("pending records: model search separates local Agents and providers, handles no matches and leaves defaults and effort untouched", async () => {
  const { app, page } = await fixture();
  try {
    await addProvider(page, {
      name: "搜索用提供方",
      url: "https://search-fixture.invalid/v1",
      model: "fixture-search-model",
    });
    await page
      .getByRole("button", { name: "‹ 全部提供方", exact: true })
      .click();
    const dialog = settingsDialog(page);
    await dialog.getByRole("button", { name: "模型", exact: true }).click();
    await expect(
      dialog.getByRole("region", { name: "本地 Agent", exact: true }),
    ).toContainText("Codex");
    await expect(
      dialog.getByRole("region", { name: "模型提供方", exact: true }),
    ).not.toContainText("Claude Code");
    const searchBox = dialog.getByRole("textbox", {
      name: "搜索模型与 Agent",
      exact: true,
    });
    await expect(searchBox).toHaveCSS("border-radius", "8px");
    await expect(searchBox.locator("..")).toHaveCSS("align-items", "stretch");
    const alignment = await searchBox.locator("..").evaluate((label) => {
      const range = document.createRange();
      range.selectNodeContents(label.firstChild!);
      return {
        label: range.getBoundingClientRect().x,
        input: label.querySelector("input")!.getBoundingClientRect().x,
      };
    });
    expect(Math.abs(alignment.label - alignment.input)).toBeLessThanOrEqual(1);
    await expect
      .poll(async () => (await searchBox.boundingBox())!.height)
      .toBeGreaterThanOrEqual(36);
    const before = await page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    await dialog
      .getByRole("textbox", { name: "搜索模型与 Agent", exact: true })
      .fill("Codex");
    await expect(dialog.locator(".provider-row")).toHaveCount(1);
    for (const term of [
      "搜索用提供方",
      "fixture-search-model",
      "search-fixture.invalid",
    ]) {
      await searchBox.fill(term);
      await expect(dialog.locator(".provider-row")).toHaveCount(1);
      await expect(dialog.locator(".provider-row")).toContainText(
        "搜索用提供方",
      );
      await expect(
        dialog.getByText("没有匹配的模型或 Agent", { exact: true }),
      ).toHaveCount(0);
    }
    await searchBox.fill("api.deepseek.com");
    await expect(dialog.locator(".provider-row")).toHaveCount(1);
    await expect(
      dialog.getByText("没有匹配的模型或 Agent", { exact: true }),
    ).toHaveCount(0);
    await dialog
      .getByRole("textbox", { name: "搜索模型与 Agent", exact: true })
      .fill("无匹配模型");
    await expect(dialog.locator(".provider-row")).toHaveCount(0);
    await expect(
      dialog.getByText("没有匹配的模型或 Agent", { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("textbox", { name: "搜索模型与 Agent", exact: true })
      .fill("");
    const after = await page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    if (!before.ok || !after.ok) throw Error("snapshot unavailable");
    expect(after.snapshot?.settings).toEqual(before.snapshot?.settings);
    expect(after.snapshot?.connections).toEqual(before.snapshot?.connections);
  } finally {
    await closeLocal(app);
  }
});
