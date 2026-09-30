import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { journeyFixture } from "./project-action-fixture";
import { closeLocal, launchLocal } from "./local-client";
import { goTo, ready, requestSize, windowClasses } from "./shell";
/** Returns to the project detail: 全部项目 opens the project list, the project row reopens its detail. */
async function backToProject(page: Page) {
  await goTo(page, "项目");
  await page.locator(".project-open").first().click();
}

type Fixture = Awaited<ReturnType<typeof journeyFixture>>;
async function projection(f: Fixture) {
  const r = await f.page.evaluate(
    (projectId) => window.desktop.projectWork({ type: "read", projectId }),
    f.projectId,
  );
  if (!r.ok || !r.view?.projection) throw Error(JSON.stringify(r));
  return r.view.projection;
}
async function preparePending(f: Fixture, actionId: string) {
  const p = await projection(f),
    item = p.pendingItems.find(
      (i) => i.status === "pending" && i.actionIds.includes(actionId),
    )!,
    a = p.actions.find((a) => a.actionId === actionId)!;
  const r = await f.request({
    type: "prepare",
    projectId: f.projectId,
    actionId,
    objectRef: a.objectRef,
    expectedRevision: a.expectedRevision,
    candidateRef: a.candidateRef,
    pending: { itemRef: item.itemRef, revision: item.revision },
  });
  if (!r.ok || !r.prepared) throw Error(JSON.stringify(r));
  for (let i = 0; i < r.prepared.evidence.length; i++)
    expect(
      (
        await f.request({
          type: "evidence",
          projectId: f.projectId,
          token: r.prepared.token,
          index: i,
        })
      ).ok,
    ).toBe(true);
  return r.prepared;
}
async function decide(
  f: Fixture,
  label: string,
  human = true,
  reject = false,
  limit?: number,
) {
  if (
    human &&
    (await f.page
      .getByRole("region", { name: "事项列表", exact: true })
      .count())
  ) {
    const item = f.page
      .getByRole("region", { name: "事项列表", exact: true })
      .getByRole("button")
      .filter({ has: f.page.getByText(label, { exact: true }) });
    await expect(item.first()).toBeVisible();
    await item.first().click();
  }
  await f.page
    .getByRole("button", {
      name: human ? `处理：${label}` : label,
      exact: true,
    })
    .click();
  const dialog = f.page.getByRole("dialog", {
    name: "核对项目操作",
    exact: true,
  });
  await dialog
    .getByRole("combobox", { name: "处理方式", exact: true })
    .selectOption(reject ? "拒绝" : "继续");
  if (limit) {
    await dialog
      .getByRole("checkbox", { name: "填写评审次数额度", exact: true })
      .check();
    await dialog
      .getByRole("spinbutton", { name: "评审次数额度", exact: true })
      .fill(String(limit));
  }
  if (human) {
    for (const button of await dialog
      .getByRole("button", { name: /^打开依据 / })
      .all())
      await button.click();
    await dialog
      .getByRole("checkbox", {
        name: "我已核对本次操作与全部依据",
        exact: true,
      })
      .check();
  }
  await dialog.getByRole("button", { name: "确认提交", exact: true }).click();
  await expect(
    dialog.getByText(reject ? "操作失败" : "操作已成功", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
}

test("project pending: global and project decisions share identities, filter without changing totals, and complete the synthetic journey with fixed historical evidence", async ({}, info) => {
  const f = await journeyFixture();
  try {
    const initial = await projection(f),
      item = initial.pendingItems.find((i) => i.status === "pending")!;
    const selector = `.project-pending-item[data-item-ref="${item.itemRef}"]`;
    await expect(f.page.locator(selector)).toHaveAttribute(
      "data-item-revision",
      item.revision,
    );
    await f.page
      .getByRole("navigation", { name: "Runtime 内容" })
      .getByRole("button", { name: "当前阶段：任务开发", exact: true })
      .click();
    await f.page
      .getByRole("combobox", { name: "列表分组方式", exact: true })
      .selectOption("state");
    await expect(f.page.locator(".project-task-group")).toHaveText("待接纳");
    await f.page
      .locator(".project-task-list")
      .getByRole("button", { name: "合成编码任务", exact: true })
      .click();
    await goTo(f.page, "待处理");
    await expect(f.page.locator(selector)).toHaveAttribute(
      "data-item-revision",
      item.revision,
    );
    await expect(
      f.page.getByText("全部未解决：1 · 阻塞：1", { exact: true }),
    ).toBeVisible();
    await f.page
      .getByRole("textbox", { name: "搜索事项", exact: true })
      .fill("不存在的对象");
    await expect(f.page.locator(selector)).toHaveCount(0);
    await expect(
      f.page.getByText("全部未解决：1 · 阻塞：1", { exact: true }),
    ).toBeVisible();
    await f.page
      .getByRole("button", { name: "返回全部范围", exact: true })
      .click();
    await f.page
      .getByRole("combobox", { name: "事项范围", exact: true })
      .selectOption(f.projectId);
    await f.page
      .getByRole("combobox", { name: "处理类型", exact: true })
      .selectOption("runtime:csthink.test.journey:task.accept");
    await expect(f.page.locator(selector)).toHaveCount(1);
    await f.page
      .getByRole("button", { name: "返回全部范围", exact: true })
      .click();
    await f.page.screenshot({
      path: info.outputPath("pending-controls-light.png"),
    });
    await decide(f, "接纳任务", true, true);
    await expect(f.page.locator(selector)).toHaveAttribute(
      "data-status",
      "processed",
    );
    await f.page.getByRole("tab", { name: "已处理", exact: true }).click();
    await expect(
      f.page.getByRole("combobox", { name: "事项排序", exact: true }),
    ).toBeDisabled();
    await expect(
      f.page.getByRole("combobox", { name: "事项排序", exact: true }),
    ).toHaveValue("processed");
    const rejected = f.page.locator(selector);
    await expect(rejected).toHaveAttribute("data-status", "processed");
    expect(
      await rejected.getByRole("button", { name: /^处理：/ }).count(),
    ).toBe(0);
    const refused = (await projection(f)).pendingItems.find(
      (i) => i.itemRef === item.itemRef,
    )!;
    await expect(rejected.locator("time")).toHaveAttribute(
      "datetime",
      refused.processedAt!,
    );
    await f.page.getByRole("tab", { name: "待处理", exact: true }).click();
    await f.page.locator(".record-row").first().click();
    await f.page
      .getByRole("button", { name: "打开原项目", exact: true })
      .click();
    await decide(f, "接纳任务");
    await goTo(f.page, "待处理");
    await decide(f, "冻结定义");
    await backToProject(f.page);
    await decide(f, "开始实施", false);
    await decide(f, "执行验证", false);
    await decide(f, "提交变更评审", false);
    await decide(f, "修复评审问题", false);
    await decide(f, "执行验证", false);
    await goTo(f.page, "待处理");
    await decide(f, "调整评审额度", true, false, 2);
    await backToProject(f.page);
    await decide(f, "提交变更评审", false);
    await goTo(f.page, "待处理");
    await decide(f, "授权发布");
    await backToProject(f.page);
    await decide(f, "Publish", false);
    await decide(f, "核对合并结果", false);
    await goTo(f.page, "待处理");
    await decide(f, "关闭任务");
    await expect(
      f.page.getByText("全部未解决：0 · 阻塞：0", { exact: true }),
    ).toBeVisible();
    const finished = await projection(f),
      historical = finished.pendingItems.find(
        (i) => i.itemRef === item.itemRef,
      )!;
    expect(historical).toEqual(refused);
    const traceBefore = finished.objects.find((o) => o.objectRef === "trace:1")!
      .view.entries;
    const revised = await f.app.evaluate(
      (_, t) =>
        globalThis.runtimeHost.invoke(t.instanceId, t.scopeRef, {
          actionId: "test.revise",
          objectRef: "candidate:1",
          payload: { decision: "继续" },
        }),
      f.target,
    );
    expect(revised.status).toBe("succeeded");
    await f.page.getByRole("tab", { name: "已处理", exact: true }).click();
    await f.page
      .getByRole("combobox", { name: "每页数量", exact: true })
      .selectOption("20");
    await f.page
      .locator(`.record-row[data-item-ref="${item.itemRef}"]`)
      .click();
    await expect(rejected.locator("time")).toHaveAttribute(
      "datetime",
      refused.processedAt!,
    );
    await rejected.getByText("查看固定依据", { exact: true }).click();
    await f.page
      .locator("#right-panel")
      .getByRole("button", { name: "读取依据 1", exact: true })
      .click();
    await expect(f.page.locator("#right-panel pre")).toContainText(
      "candidate revision 1",
    );
    await rejected.scrollIntoViewIfNeeded();
    await rejected.screenshot({
      path: info.outputPath("processed-fixed-source.png"),
    });
    await goTo(f.page, "运行记录");
    const log = f.page.getByRole("region", {
      name: "运行记录列表",
      exact: true,
    });
    await f.page
      .getByRole("combobox", { name: "每页数量", exact: true })
      .selectOption("48");
    await expect(log).toContainText("人工拒绝本候选，任务未推进");
    await expect(log).toContainText("关闭任务已生效");
    await expect(
      f.page.getByText("还没有运行记录", { exact: true }),
    ).toHaveCount(0);
    await expect(
      log.getByRole("button", { name: /确认提交|重新检查|重试|停止/ }),
    ).toHaveCount(0);
    await f.page
      .getByRole("textbox", { name: "搜索运行记录", exact: true })
      .fill("人工拒绝");
    await expect(log.locator("li")).toHaveCount(1);
    await f.page.evaluate(() =>
      window.desktop.command({ type: "setAppearance", appearance: "dark" }),
    );
    await f.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
    );
    await f.page
      .getByRole("textbox", { name: "搜索运行记录", exact: true })
      .scrollIntoViewIfNeeded();
    await f.page.screenshot({ path: info.outputPath("records-dark-900.png") });
    await log.locator(".record-row").first().click();
    await f.page
      .locator("#right-panel")
      .getByRole("button", { name: "查看执行过程", exact: true })
      .click();
    await expect(f.page.locator("#right-panel")).toContainText(
      "Runtime 未提供稳定的运行关联",
    );

    await f.page
      .getByRole("button", { name: "返回全部范围", exact: true })
      .click();
    await expect(log.locator("h3")).toHaveCount(1);
    const after = (await projection(f)).objects.find(
      (o) => o.objectRef === "trace:1",
    )!.view.entries as unknown[];
    expect(after.slice(0, (traceBefore as unknown[]).length)).toEqual(
      traceBefore,
    );
    const ops = await f.request({ type: "list", projectId: f.projectId });
    if (!ops.ok) throw Error(JSON.stringify(ops));
    expect(
      ops.operations!.filter((o) => o.request?.actionId === "task.accept"),
    ).toHaveLength(2);
    expect(
      ops.operations!.filter((o) => o.request?.actionId === "task.publish"),
    ).toHaveLength(1);
    writeFileSync(
      info.outputPath("final-projection.json"),
      JSON.stringify(await projection(f), null, 2),
    );
  } finally {
    await closeLocal(f.app);
  }
});

test("project pending: two confirmations use one operation and stale, foreign, processed and revoked identities cannot decide", async () => {
  const f = await journeyFixture();
  try {
    const a = await preparePending(f, "task.accept"),
      b = await preparePending(f, "task.accept");
    expect(a.pending).toEqual(b.pending);
    const foreign = await f.request({
      type: "prepare",
      projectId: f.projectId,
      actionId: a.action.actionId,
      objectRef: a.action.objectRef,
      expectedRevision: a.action.expectedRevision,
      candidateRef: a.action.candidateRef,
      pending: { itemRef: "pending:foreign", revision: a.pending!.revision },
    });
    expect(foreign.ok).toBe(false);
    const replies = await Promise.all(
      [a, b].map((p) =>
        f.request({
          type: "submit",
          projectId: f.projectId,
          token: p.token,
          payload: { decision: "继续" },
        }),
      ),
    );
    expect(replies.every((r) => r.ok)).toBe(true);
    expect(replies[0].ok && replies[0].operation?.operationId).toBe(
      replies[1].ok && replies[1].operation?.operationId,
    );
    expect(
      (
        await f.request({
          type: "prepare",
          projectId: f.projectId,
          actionId: a.action.actionId,
          objectRef: a.action.objectRef,
          expectedRevision: a.action.expectedRevision,
          candidateRef: a.action.candidateRef,
          pending: {
            itemRef: a.pending!.itemRef,
            revision: a.pending!.revision,
          },
        })
      ).ok,
    ).toBe(false);
    await expect(
      f.page.getByRole("button", { name: "处理：冻结定义", exact: true }),
    ).toBeEnabled();
    const old = await preparePending(f, "definition.freeze");
    await f.app.evaluate(
      (_, t) =>
        globalThis.runtimeHost.invoke(t.instanceId, t.scopeRef, {
          actionId: "test.revise",
          objectRef: "candidate:1",
          payload: { decision: "继续" },
        }),
      f.target,
    );
    expect(
      (
        await f.request({
          type: "submit",
          projectId: f.projectId,
          token: old.token,
          payload: { decision: "继续" },
        })
      ).ok,
    ).toBe(false);
    await expect
      .poll(
        async () =>
          (await projection(f)).objects.find(
            (o) => o.objectRef === "candidate:1",
          )!.revision,
      )
      .not.toBe(old.object.revision);
    const current = await preparePending(f, "definition.freeze");
    await f.app.evaluate(
      (_, t) => globalThis.runtimeHost.revokeGrant(t.instanceId, t.grantId),
      f.target,
    );
    expect(
      (
        await f.request({
          type: "submit",
          projectId: f.projectId,
          token: current.token,
          payload: { decision: "继续" },
        })
      ).ok,
    ).toBe(false);
    await goTo(f.page, "待处理");
    await expect(
      f.page.getByRole("button", { name: "处理：冻结定义", exact: true }),
    ).toBeDisabled();
    await f.page.getByRole("tab", { name: "已处理", exact: true }).click();
    await f.page.locator(".record-row").first().click();
    await expect(
      f.page.locator(".project-pending-item[data-status=processed]"),
    ).toHaveCount(1);
    const ops = await f.request({ type: "list", projectId: f.projectId });
    expect(ops.ok && ops.operations?.length).toBe(2);
  } finally {
    await closeLocal(f.app);
  }
});

test("project pending: a disconnected source preserves the last item and disables both processing and evidence reads", async () => {
  const f = await journeyFixture();
  try {
    await goTo(f.page, "待处理");
    const before = (await projection(f)).pendingItems;
    await expect(
      f.page.getByRole("button", { name: "处理：接纳任务", exact: true }),
    ).toBeEnabled();
    await f.app.evaluate(
      (_, t) =>
        globalThis.runtimeHost.supervisor.shutdown(
          t.instanceId,
          "synthetic disconnection",
        ),
      f.target,
    );
    await expect(
      f.page.getByRole("button", { name: "处理：接纳任务", exact: true }),
    ).toBeDisabled();
    await f.page.getByText("查看固定依据", { exact: true }).click();
    await expect(
      f.page.getByRole("button", { name: "读取依据 1", exact: true }),
    ).toBeDisabled();
    expect((await projection(f)).pendingItems).toEqual(before);
    await f.page
      .getByRole("button", { name: "打开原项目", exact: true })
      .click();
    await expect(
      f.page.getByRole("button", { name: "处理：接纳任务", exact: true }),
    ).toBeDisabled();
    const ops = await f.request({ type: "list", projectId: f.projectId });
    expect(ops.ok && ops.operations?.length).toBe(0);
  } finally {
    await closeLocal(f.app);
  }
});

/**
 * The visible filter bar (KB-309): label text line, control box and text size of each labelled search or
 * select, the checkbox centre and the reset button box, and whether the bar overflows its own width.
 */
async function filterGeometry(page: Page) {
  return page.locator(".record-query-controls").evaluate((bar) => {
    const controls = [...bar.querySelectorAll("label")].flatMap((label) => {
      const control = label.querySelector("input:not([type=checkbox]), select");
      if (!control || !label.firstChild) return [];
      const range = document.createRange();
      range.selectNodeContents(label.firstChild);
      const text = range.getBoundingClientRect(),
        box = control.getBoundingClientRect();
      return [
        {
          name: label.firstChild.textContent!.trim(),
          labelTop: text.top,
          labelHeight: label.getBoundingClientRect().height,
          top: box.top,
          height: box.height,
          fontSize: getComputedStyle(control).fontSize,
        },
      ];
    });
    const check = bar.querySelector(".record-query-check input"),
      reset = [...bar.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "返回全部范围",
      );
    const checkBox = check?.getBoundingClientRect(),
      resetBox = reset?.getBoundingClientRect();
    return {
      controls,
      checkCenter: checkBox ? checkBox.top + checkBox.height / 2 : null,
      reset: resetBox ? { top: resetBox.top, height: resetBox.height } : null,
      overflow: bar.scrollWidth > bar.clientWidth,
      height: bar.getBoundingClientRect().height,
      gap: parseFloat(getComputedStyle(bar).rowGap) || 0,
    };
  });
}
/**
 * The bar has `rows` rows. Within each row every label sits on one line and every control has one height and
 * top edge; the checkbox is centred on its row's controls and the reset button shares their edges; all
 * controls share one text size and nothing overflows the bar.
 */
function expectRows(
  bar: Awaited<ReturnType<typeof filterGeometry>>,
  rows: number,
) {
  const shown = JSON.stringify(bar);
  expect(bar.overflow, shown).toBe(false);
  expect(new Set(bar.controls.map((c) => c.fontSize)).size, shown).toBe(1);
  const tops: number[] = [];
  for (const c of bar.controls)
    if (!tops.some((t) => Math.abs(t - c.top) <= 0.5)) tops.push(c.top);
  if (bar.reset && !tops.some((t) => Math.abs(t - bar.reset!.top) <= 0.5))
    tops.push(bar.reset.top);
  expect(tops.length, `rows: ${shown}`).toBe(rows);
  // No empty band: the bar is exactly its rows and the gaps between them.
  const tallest = Math.max(...bar.controls.map((c) => c.labelHeight));
  expect(
    bar.height - (rows * tallest + (rows - 1) * bar.gap),
    `bar height: ${shown}`,
  ).toBeLessThanOrEqual(0.5);
  for (const top of tops) {
    const row = bar.controls.filter((c) => Math.abs(c.top - top) <= 0.5);
    if (!row.length) continue;
    for (const key of ["labelTop", "height"] as const) {
      const values = row.map((r) => r[key]);
      expect(
        Math.max(...values) - Math.min(...values),
        `${key}: ${shown}`,
      ).toBeLessThanOrEqual(0.5);
    }
  }
  const rowOf = (y: number) =>
    bar.controls.filter((c) => y >= c.top - 0.5 && y <= c.top + c.height + 0.5);
  if (bar.checkCenter !== null) {
    const row = rowOf(bar.checkCenter);
    expect(row.length, `checkbox row: ${shown}`).toBeGreaterThan(0);
    expect(
      Math.abs(bar.checkCenter - (row[0].top + row[0].height / 2)),
      shown,
    ).toBeLessThanOrEqual(0.5);
  }
  if (bar.reset) {
    const row = bar.controls.filter(
      (c) => Math.abs(c.top - bar.reset!.top) <= 0.5,
    );
    expect(
      row.length,
      `reset shares a row with controls: ${shown}`,
    ).toBeGreaterThan(0);
    expect(
      Math.abs(bar.reset.height - row[0].height),
      shown,
    ).toBeLessThanOrEqual(0.5);
  }
}
/** The focused element's ring and the current accent colour. */
async function focusRing(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement!,
      probe = document.createElement("span");
    probe.style.color = "var(--c-accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      visible: el.matches(":focus-visible"),
      ring: `${style.outlineStyle} ${style.outlineWidth}`,
      color: style.outlineColor,
      accent,
    };
  });
}

test("record filters: the pending and run-record filter bars keep one row in a wide centre and two rows in a narrow one, each row with one label line, control height and top edge, one text size throughout, and focused controls show the accent focus ring in light and dark", async ({}, info) => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const data = join(
    mkdtempSync(resolve(".test-data/disposable/record-filters-")),
    "data",
  );
  mkdirSync(data);
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${data}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  const fold = page
    .locator("#main-sidebar")
    .getByRole("button", { name: "折叠侧栏", exact: true });
  const unfold = page
    .getByRole("navigation", { name: "全局导航" })
    .getByRole("button", { name: "展开侧栏", exact: true });
  const sidebar = async (expanded: boolean) => {
    if (expanded && (await unfold.isVisible())) await unfold.click();
    if (!expanded && (await fold.isVisible())) await fold.click();
    await expect(page.locator("#main-sidebar")).toHaveCount(expanded ? 1 : 0);
  };
  try {
    await ready(page);
    const { standard } = await windowClasses(app, page);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(
        (appearance) =>
          window.desktop.command({ type: "setAppearance", appearance }),
        theme,
      );
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      // The standard width is wide enough for one row; the 900 point window, folded or not, is not.
      for (const [label, size, expanded, rows] of [
        ["standard", standard, true, 1],
        ["900-expanded", [900, 680], true, 2],
        ["900-folded", [900, 680], false, 2],
      ] as const) {
        expect(await requestSize(app, page, size[0], size[1])).toEqual([
          ...size,
        ]);
        await sidebar(expanded);
        for (const [name, search, names] of [
          ["待处理", "搜索事项", ["搜索", "范围", "类型", "排序"]],
          [
            "运行记录",
            "搜索运行记录",
            ["搜索", "范围", "类型", "排序", "时间"],
          ],
        ] as const) {
          await goTo(page, name);
          const box = page.getByRole("textbox", { name: search, exact: true });
          await expect(box).toBeVisible();
          const before = await filterGeometry(page);
          expect(before.controls.map((r) => r.name)).toEqual(names);
          expectRows(before, rows);
          if (label === "standard") {
            // The search field and, by keyboard, the next select carry the accent ring.
            await box.click();
            const text = await focusRing(page);
            expect(text).toMatchObject({ tag: "input", visible: true });
            expect(text.ring).toBe("solid 2px");
            expect(text.color).toBe(text.accent);
            await page.keyboard.press("Tab");
            const select = await focusRing(page);
            expect(select).toMatchObject({ tag: "select", visible: true });
            expect(select.color).toBe(select.accent);
          }
          // A filter adds the reset button without adding a row.
          await box.fill("筛选");
          await expect(
            page.getByRole("button", { name: "返回全部范围", exact: true }),
          ).toBeVisible();
          const filtered = await filterGeometry(page);
          expect(filtered.reset).not.toBeNull();
          expectRows(filtered, rows);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({
            path: info.outputPath(
              `filters-${name === "待处理" ? "pending" : "records"}-${theme}-${label}.png`,
            ),
          });
          await page
            .getByRole("button", { name: "返回全部范围", exact: true })
            .click();
        }
      }
      await sidebar(true);
    }
  } finally {
    await closeLocal(app);
  }
});

/** The secondary button surface and edge of the current appearance, read from a probe element. */
const secondaryColours = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.background = "var(--c-secondary-bg)";
    probe.style.border = "1px solid var(--c-line-strong)";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const colours = {
      background: style.backgroundColor,
      edge: style.borderTopColor,
    };
    probe.remove();
    return colours;
  });
/**
 * A secondary button on the project, pending and run-record pages takes the secondary button surface and
 * edge, the same as on every other page. The list can render a button again between finding it and reading
 * its style, and a detached button has no computed style, so the style is read by retrying assertions on
 * the button that is in the document.
 */
async function expectWorkbenchSurface(button: Locator) {
  const { background, edge } = await secondaryColours(button.page());
  await expect(button).toHaveCSS("background-color", background);
  await expect(button).toHaveCSS("border-top-color", edge);
}

test("workbench appearance: in the dark appearance project, pending and run-record secondary buttons take the secondary button surface and edge", async ({}, info) => {
  const f = await journeyFixture();
  try {
    await goTo(f.page, "待处理");
    await decide(f, "接纳任务", true, true);
    await f.page.evaluate(() =>
      window.desktop.command({ type: "setAppearance", appearance: "dark" }),
    );
    await expect(f.page.locator("html")).toHaveAttribute("data-theme", "dark");
    const open = f.page
      .getByRole("region", { name: "事项详情", exact: true })
      .getByRole("button", { name: "打开原项目", exact: true })
      .first();
    await expectWorkbenchSurface(open);
    await expectWorkbenchSurface(
      f.page.getByRole("button", { name: "处理：接纳任务", exact: true }),
    );
    await f.page.screenshot({ path: info.outputPath("pending-dark.png") });
    await f.page.getByRole("tab", { name: "已处理", exact: true }).click();
    const processed = f.page.locator(
      ".project-pending-item[data-status=processed]",
    );
    await processed.getByText("查看固定依据", { exact: true }).click();
    const read = f.page.locator("#right-panel").getByRole("button", {
      name: "读取依据 1",
      exact: true,
    });
    await expectWorkbenchSurface(read);
    await read.click();
    await expect(f.page.locator("#right-panel pre")).toContainText(
      "candidate revision",
    );
    await processed.scrollIntoViewIfNeeded();
    await f.page.screenshot({
      path: info.outputPath("pending-processed-dark.png"),
    });
    await goTo(f.page, "运行记录");
    await f.page.locator(".record-row").first().click();
    await expectWorkbenchSurface(
      f.page
        .locator("#right-panel")
        .getByRole("button", { name: "打开原项目", exact: true })
        .first(),
    );
    await f.page.screenshot({ path: info.outputPath("records-dark.png") });
    await f.page
      .locator("#right-panel")
      .getByRole("button", { name: "打开原项目", exact: true })
      .first()
      .click();
    await f.page
      .getByRole("navigation", { name: "Runtime 内容" })
      .getByRole("button", { name: "合成编码任务", exact: true })
      .click();
    const pane = f.page.getByRole("region", { name: "项目操作", exact: true });
    const query = pane
      .getByRole("button", { name: "查询该操作", exact: true })
      .first();
    await expectWorkbenchSurface(query);
    await query.scrollIntoViewIfNeeded();
    await f.page.screenshot({
      path: info.outputPath("project-actions-dark.png"),
    });
    await f.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
    );
    await expect
      .poll(() => f.page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual([900, 680]);
    await pane.scrollIntoViewIfNeeded();
    expect(
      await f.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await f.page.screenshot({
      path: info.outputPath("project-actions-dark-900.png"),
    });
  } finally {
    await closeLocal(f.app);
  }
});

test("project pending: a decision that can no longer be opened keeps its reason in view after the list has moved on (KB-317)", async ({}, info) => {
  const f = await journeyFixture();
  try {
    await goTo(f.page, "待处理");
    const list = f.page.getByRole("region", {
      name: "事项详情",
      exact: true,
    });
    const handle = list.getByRole("button", {
      name: "处理：接纳任务",
      exact: true,
    });
    await expect(handle).toBeEnabled();
    // Hold the Host projection read of the next confirmation opened in the main process, so the item can be
    // decided through the other entry before that confirmation is answered (the refusal then reaches a row
    // the refreshed list no longer shows, which is how Mars's click on the old row went unanswered).
    await f.app.evaluate(() => {
      type Read = (...args: unknown[]) => Promise<unknown>;
      const host = globalThis.runtimeHost as unknown as { projection: Read },
        read = host.projection.bind(host),
        state = globalThis as unknown as {
          projectionHeld?: boolean;
          releaseProjection?: () => void;
        };
      let armed = true;
      const gate = new Promise<void>((resolve) => {
        state.releaseProjection = resolve;
      });
      host.projection = async (...args: unknown[]) => {
        if (armed && new Error().stack?.includes("ProjectActions.request")) {
          armed = false;
          state.projectionHeld = true;
          await gate;
        }
        return read(...args);
      };
    });
    await handle.click();
    await expect
      .poll(() =>
        f.app.evaluate(
          () =>
            (globalThis as unknown as { projectionHeld?: boolean })
              .projectionHeld ?? false,
        ),
      )
      .toBe(true);
    const other = await preparePending(f, "task.accept");
    const decided = await f.request({
      type: "submit",
      projectId: f.projectId,
      token: other.token,
      payload: { decision: "继续" },
    });
    expect(decided.ok, JSON.stringify(decided)).toBe(true);
    await expect(
      list.locator(
        `.project-pending-item[data-status=pending][data-item-ref="${other.pending!.itemRef}"]`,
      ),
    ).toHaveCount(0);
    await f.app.evaluate(() =>
      (
        globalThis as unknown as { releaseProjection: () => void }
      ).releaseProjection(),
    );
    const notice = list.getByRole("alert");
    // The item's title with the main process's own refusal (the action or the item has moved on).
    await expect(notice).toHaveText(/接纳任务.*(操作|事项)/);
    await expect(notice).toBeInViewport();
    await f.page.screenshot({
      path: info.outputPath("pending-refused-after-refresh.png"),
    });
    // The next item still opens normally, and opening it clears the old notice.
    await decide(f, "冻结定义");
    await expect(notice).toHaveCount(0);
    const ops = await f.request({ type: "list", projectId: f.projectId });
    expect(
      ops.ok &&
        ops.operations!.filter((o) => o.request?.actionId === "task.accept")
          .length,
    ).toBe(1);
  } finally {
    await closeLocal(f.app);
  }
});

test("record filters: each search field's placeholder names what its page searches and shows in full: items, projects or objects for 待处理, objects, events or identifiers for 运行记录 (KB-318)", async ({}, info) => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const data = join(
    mkdtempSync(resolve(".test-data/disposable/record-search-")),
    "data",
  );
  mkdirSync(data);
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${data}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  /** How much of the placeholder the field cannot show (its text width beyond the content box). */
  const overflow = (name: string) =>
    page.getByRole("textbox", { name, exact: true }).evaluate((input) => {
      const field = input as HTMLInputElement,
        style = getComputedStyle(field),
        context = document.createElement("canvas").getContext("2d")!;
      context.font = style.font;
      return (
        context.measureText(field.placeholder).width -
        (field.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight))
      );
    });
  try {
    await ready(page);
    for (const size of [null, [900, 680]] as const) {
      if (size) {
        await app.evaluate(
          ({ BrowserWindow }, [w, h]) =>
            BrowserWindow.getAllWindows()[0].setContentSize(w, h),
          size,
        );
        await expect
          .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
          .toEqual(size);
      }
      await goTo(page, "运行记录");
      await expect(
        page.getByRole("textbox", { name: "搜索运行记录", exact: true }),
      ).toHaveAttribute("placeholder", "搜索运行记录（对象、事件或编号）…");
      expect(await overflow("搜索运行记录")).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: info.outputPath(`records-search-${size ? "900" : "default"}.png`),
      });
      await goTo(page, "待处理");
      await expect(
        page.getByRole("textbox", { name: "搜索事项", exact: true }),
      ).toHaveAttribute("placeholder", "搜索事项、项目或对象…");
      expect(await overflow("搜索事项")).toBeLessThanOrEqual(0);
    }
  } finally {
    await closeLocal(app);
  }
});
