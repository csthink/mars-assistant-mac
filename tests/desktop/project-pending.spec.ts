import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { journeyFixture } from "./project-action-fixture";
import { closeLocal, launchLocal } from "./local-client";
import { goTo, ready } from "./shell";

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
    await expect(f.page.locator(selector)).toHaveCount(0);
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
    await f.page
      .getByRole("button", { name: "打开原项目", exact: true })
      .click();
    await decide(f, "接纳任务");
    await goTo(f.page, "待处理");
    await decide(f, "冻结定义");
    await goTo(f.page, "工作台");
    await decide(f, "开始实施", false);
    await decide(f, "执行验证", false);
    await decide(f, "提交变更评审", false);
    await decide(f, "修复评审问题", false);
    await decide(f, "执行验证", false);
    await goTo(f.page, "待处理");
    await decide(f, "调整评审额度", true, false, 2);
    await goTo(f.page, "工作台");
    await decide(f, "提交变更评审", false);
    await goTo(f.page, "待处理");
    await decide(f, "授权发布");
    await goTo(f.page, "工作台");
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
    await expect(rejected.locator("time")).toHaveAttribute(
      "datetime",
      refused.processedAt!,
    );
    await rejected.getByText("查看固定依据", { exact: true }).click();
    await rejected
      .getByRole("button", { name: "读取依据 1", exact: true })
      .click();
    await expect(rejected.locator("pre")).toContainText("candidate revision 1");
    await rejected.scrollIntoViewIfNeeded();
    await rejected.screenshot({
      path: info.outputPath("processed-fixed-source.png"),
    });
    await goTo(f.page, "运行记录");
    const log = f.page.getByRole("region", {
      name: "项目运行记录",
      exact: true,
    });
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
    await log.getByText("查看执行过程", { exact: true }).click();
    await expect(log).toContainText("关闭任务已生效");

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

/** Label text, control box and text size of each labelled search or select of the visible filter bar (KB-309). */
async function filterGeometry(page: Page) {
  return page.locator(".record-query-controls").evaluate((bar) =>
    [...bar.querySelectorAll(":scope > label")].flatMap((label) => {
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
          top: box.top,
          height: box.height,
          fontSize: getComputedStyle(control).fontSize,
        },
      ];
    }),
  );
}
function expectAligned(rows: Awaited<ReturnType<typeof filterGeometry>>) {
  for (const key of ["labelTop", "top", "height"] as const) {
    const values = rows.map((r) => r[key]);
    expect(
      Math.max(...values) - Math.min(...values),
      `${key}: ${JSON.stringify(rows)}`,
    ).toBeLessThanOrEqual(0.5);
  }
  expect(new Set(rows.map((r) => r.fontSize)).size, JSON.stringify(rows)).toBe(
    1,
  );
}
/** The checkbox row is centred on the controls and the reset button shares their edges (KB-309). */
async function expectBand(page: Page) {
  const band = await page.locator(".record-query-controls").evaluate((bar) => {
    const box = (el: Element | null) => el?.getBoundingClientRect() ?? null;
    const select = box(bar.querySelector("select"))!,
      check = box(bar.querySelector(".record-query-check input")),
      reset = box(bar.querySelector(":scope > .button"));
    return {
      select: { top: select.top, height: select.height },
      checkCenter: check && check.top + check.height / 2,
      reset: reset && { top: reset.top, height: reset.height },
    };
  });
  const center = band.select.top + band.select.height / 2;
  if (band.checkCenter !== null)
    expect(
      Math.abs(band.checkCenter - center),
      JSON.stringify(band),
    ).toBeLessThanOrEqual(0.5);
  expect(band.reset, JSON.stringify(band)).not.toBeNull();
  expect(
    Math.abs(band.reset!.top - band.select.top),
    JSON.stringify(band),
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(band.reset!.height - band.select.height),
    JSON.stringify(band),
  ).toBeLessThanOrEqual(0.5);
}
/** The focused element's ring and the current workbench interaction colour (--home-blue). */
async function focusRing(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement!,
      probe = document.createElement("span");
    probe.style.color = "var(--home-blue)";
    document.body.append(probe);
    const blue = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      visible: el.matches(":focus-visible"),
      ring: `${style.outlineStyle} ${style.outlineWidth}`,
      color: style.outlineColor,
      blue,
    };
  });
}

test("record filters: the pending and run-record filter bars share one label line, control height, top edge and text size, and focused controls show the blue workbench focus ring in light and dark (KB-309, KB-310)", async ({}, info) => {
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
  try {
    await ready(page);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(
        (appearance) =>
          window.desktop.command({ type: "setAppearance", appearance }),
        theme,
      );
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const [name, search, names] of [
        ["待处理", "搜索事项", ["搜索", "范围", "类型", "排序"]],
        ["运行记录", "搜索运行记录", ["搜索", "范围", "类型", "排序", "时间"]],
      ] as const) {
        await goTo(page, name);
        const box = page.getByRole("textbox", { name: search, exact: true });
        await expect(box).toBeVisible();
        const rows = await filterGeometry(page);
        expect(rows.map((r) => r.name)).toEqual(names);
        expectAligned(rows);
        // The search field and, by keyboard, the next select carry the blue workbench ring.
        await box.click();
        const text = await focusRing(page);
        expect(text).toMatchObject({ tag: "input", visible: true });
        expect(text.ring).toBe("solid 2px");
        expect(text.color).toBe(text.blue);
        await page.keyboard.press("Tab");
        const select = await focusRing(page);
        expect(select).toMatchObject({ tag: "select", visible: true });
        expect(select.color).toBe(select.blue);
        await box.fill("筛选");
        await expect(
          page.getByRole("button", { name: "返回全部范围", exact: true }),
        ).toBeVisible();
        expectAligned(await filterGeometry(page));
        await expectBand(page);
        await page.screenshot({
          path: info.outputPath(
            `filters-${name === "待处理" ? "pending" : "records"}-${theme}.png`,
          ),
        });
        await page
          .getByRole("button", { name: "返回全部范围", exact: true })
          .click();
      }
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
    );
    await expect
      .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual([900, 680]);
    for (const [name, file] of [
      ["待处理", "pending"],
      ["运行记录", "records"],
    ] as const) {
      await goTo(page, name);
      expectAligned(await filterGeometry(page));
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`filters-${file}-dark-900.png`),
      });
    }
  } finally {
    await closeLocal(app);
  }
});

/** The current workbench edge colour (--home-edge), read from a probe element (KB-314). */
const workbenchEdge = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.border = "1px solid var(--home-edge)";
    document.body.append(probe);
    const edge = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return edge;
  });
/**
 * No near-black base fill (--palette-1a1c24) on the blue workbench cards: the accepted prototype's
 * secondary workbench button has no fill and the workbench edge. The list can render a button again
 * between finding it and reading its style, and a detached button has no computed style, so the style
 * is read by retrying assertions on the button that is in the document.
 */
async function expectWorkbenchSurface(button: Locator) {
  const edge = await workbenchEdge(button.page());
  await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(button).toHaveCSS("border-top-color", edge);
}

test("workbench appearance: in the dark appearance project, pending and run-record buttons take the workbench surface instead of the near-black base fill (KB-314)", async ({}, info) => {
  const f = await journeyFixture();
  try {
    await goTo(f.page, "待处理");
    await decide(f, "接纳任务", true, true);
    await f.page.evaluate(() =>
      window.desktop.command({ type: "setAppearance", appearance: "dark" }),
    );
    await expect(f.page.locator("html")).toHaveAttribute("data-theme", "dark");
    const open = f.page
      .getByRole("region", { name: "项目待处理", exact: true })
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
    const read = processed.getByRole("button", {
      name: "读取依据 1",
      exact: true,
    });
    await expectWorkbenchSurface(read);
    await read.click();
    await expect(processed.locator("pre")).toContainText("candidate revision");
    await processed.scrollIntoViewIfNeeded();
    await f.page.screenshot({
      path: info.outputPath("pending-processed-dark.png"),
    });
    await goTo(f.page, "运行记录");
    await expectWorkbenchSurface(
      f.page
        .getByRole("region", { name: "项目运行记录", exact: true })
        .getByRole("button", { name: "打开原项目", exact: true })
        .first(),
    );
    await f.page.screenshot({ path: info.outputPath("records-dark.png") });
    await f.page
      .getByRole("region", { name: "项目运行记录", exact: true })
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
      name: "项目待处理",
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
