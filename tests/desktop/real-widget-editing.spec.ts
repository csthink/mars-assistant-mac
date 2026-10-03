import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { launchReal, shutdownReal, type RealClient } from "./real-client";
import { seedWidgetCandidate } from "./widget-generation-fixture";
import { Store } from "../../src/service/store";
import { goTo } from "./shell";
import type { Command } from "../../src/shared/protocol";
import type { GeneratedCandidate } from "../../src/shared/widget-generation";

// This entry has its own task and exact five-turn authorization. It never reuses generation authorization.
function authorization() {
  const path = process.env.CSTHINK_WIDGET_EDITING_AUTHORIZATION;
  if (
    process.env.CSTHINK_REAL_CALLS_AUTHORIZED !== "1" ||
    !path ||
    !isAbsolute(path)
  )
    throw new Error("NOT RUN: editing authorization required");
  const a = JSON.parse(readFileSync(path, "utf8")) as {
    task: string;
    authorized: boolean;
    maxTurns: number;
    root: string;
    evidence: string;
    provider: string;
    connectionId: string;
    model: string;
  };
  if (
    a.task !== "mac-feature-t10" ||
    a.authorized !== true ||
    a.maxTurns !== 5 ||
    !["codex", "claude"].includes(a.provider) ||
    !a.connectionId?.trim() ||
    !a.model?.trim() ||
    !isAbsolute(a.root) ||
    !isAbsolute(a.evidence) ||
    a.root === a.evidence
  )
    throw new Error("NOT RUN: invalid editing scope");
  return a;
}
async function command(page: Page, c: Command) {
  const r = await page.evaluate((c) => window.desktop.command(c), c);
  if (!r.ok) throw new Error(r.message);
  return r.snapshot;
}

test("real widget editing: five authorized turns retain behavior, revised requirements and both selected targets", async () => {
  test.setTimeout(1_500_000);
  const auth = authorization();
  if (existsSync(auth.evidence) && readdirSync(auth.evidence).length)
    throw new Error("Evidence directory must be empty");
  mkdirSync(auth.evidence, { recursive: true, mode: 0o700 });
  let client: RealClient | undefined;
  let turns = 0;
  const records: Record<string, unknown>[] = [];
  const save = () =>
    writeFileSync(
      join(auth.evidence, "result.json"),
      JSON.stringify(
        {
          task: auth.task,
          submittedTurns: turns,
          maxTurns: 5,
          automaticRetries: 0,
          provider: auth.provider,
          model: auth.model,
          records,
          usage: "unavailable, not zero",
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  try {
    client = await launchReal(auth.root, { background: true });
    let page = client.page;
    const state = () => command(page, { type: "snapshot" });
    const initial = await state();
    expect(initial.conversations).toHaveLength(0);
    expect(initial.widgetGeneration!.tasks).toHaveLength(0);
    expect(initial.widgetGeneration!.widgets).toHaveLength(0);
    const connection = initial.connections.find(
      (c) => c.id === auth.connectionId,
    );
    expect(connection?.provider).toBe(auth.provider);
    expect(connection?.enabled).toBe(true);
    expect(
      connection?.models.some((m) => m.model === auth.model && m.enabled),
    ).toBe(true);
    const submit = async (
      draftId: string,
      input: string,
      supplement = false,
    ) => {
      const draft = (await state()).widgetGeneration!.drafts.find(
        (d) => d.id === draftId,
      )!;
      await command(page, {
        type: "saveWidgetDraft",
        id: draftId,
        revision: draft.revision,
        name: draft.name,
        input,
      });
      if (turns >= auth.maxTurns) throw new Error("Turn budget exhausted");
      const row: Record<string, unknown> = {
        turn: ++turns,
        input,
        draftId,
        status: "RUNNING",
      };
      records.push(row);
      save();
      const s = await command(page, {
        type: supplement
          ? "supplementWidgetGeneration"
          : "submitWidgetGeneration",
        draftId,
        revision: draft.revision + 1,
        requestId: randomUUID(),
        connectionId: auth.connectionId,
        model: auth.model,
      });
      const task = s
        .widgetGeneration!.tasks.filter((t) => t.draftId === draftId)
        .at(-1)!;
      row.taskId = task.id;
      row.requirementRevision = task.requirementRevision;
      row.connection = task.connection;
      save();
      return task;
    };
    const finish = async (taskId: string) => {
      await expect
        .poll(
          async () =>
            (await state()).widgetGeneration!.tasks.find(
              (t) => t.id === taskId,
            )!.state,
          { timeout: 240_000 },
        )
        .toBe("completed");
      const c = (await state()).widgetGeneration!.candidates.find(
        (c) => c.taskId === taskId,
      )!;
      expect(c.state).toBe("preview");
      expect(c.differences.length).toBeGreaterThan(0);
      const row = records.find((r) => r.taskId === taskId)!;
      row.candidateId = c.id;
      row.digest = c.digest;
      save();
      return c;
    };
    const view = async (candidateId: string) => {
      await expect
        .poll(async () => {
          const r = await page.evaluate(() =>
            window.desktop.widgetControl({ action: "status" }),
          );
          return r.ok && r.preview?.candidateId === candidateId
            ? r.generation
            : null;
        })
        .toBeTruthy();
      const status = await page.evaluate(() =>
        window.desktop.widgetControl({ action: "status" }),
      );
      if (!status.ok) throw new Error(status.message);
      const url = `csthink-widget://${status.generation}/index.html`;
      await expect
        .poll(() =>
          client!.browser
            .contexts()
            .flatMap((c) => c.pages())
            .some((p) => p.url() === url),
        )
        .toBe(true);
      return client!.browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url() === url)!;
    };
    const retain = async (c: GeneratedCandidate) => {
      await page.getByRole("button", { name: "保留控件", exact: true }).click();
      await page.getByRole("button", { name: "确认保留", exact: true }).click();
      await expect(
        page.getByText("已保留到控件。编辑历史继续保存。", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "控件需求", exact: true }),
      ).toBeVisible();
      records.find((r) => r.taskId === c.taskId)!.status = "PASS";
      save();
    };
    const draftId = randomUUID();
    await command(page, {
      type: "createWidgetDraft",
      id: draftId,
      name: "合成计数器",
      sourceConversationId: null,
    });
    await command(page, { type: "selectWidgetDraft", id: draftId });
    await goTo(page, "控件");
    const first = await submit(
      draftId,
      "创建计数器：output#value初始0，label步长的select选项值1和2，按钮增加按所选步长相加。仅本控件本地数据，无外部资源。保留这些标识供可访问性检查。",
    );
    const c1 = await finish(first.id),
      v1 = await view(c1.id);
    await v1.getByLabel("步长").selectOption("2");
    await v1.getByRole("button", { name: "增加", exact: true }).click();
    await expect(v1.locator("#value")).toHaveText("2");
    await retain(c1);
    const formal = (await state()).widgetGeneration!.widgets[0];
    const second = await submit(
      draftId,
      "保留output#value、步长select和增加按钮，新增减少按钮按步长相减，以及重置按钮立即归零。初始值与已保存数据保持。",
    );
    const c2 = await finish(second.id),
      v2 = await view(c2.id);
    await v2.getByRole("button", { name: "重置", exact: true }).click();
    await expect(v2.locator("#value")).toHaveText("0");
    await v2.getByLabel("步长").selectOption("2");
    await v2.getByRole("button", { name: "减少", exact: true }).click();
    await expect(v2.locator("#value")).toHaveText("-2");
    await retain(c2);
    expect((await state()).widgetGeneration!.widgets[0].id).toBe(formal.id);
    const third = await submit(
      draftId,
      "增加一个显示当前步长的摘要，保持现有计数行为。",
    );
    await expect
      .poll(
        async () =>
          (await state()).widgetGeneration!.tasks.find(
            (t) => t.id === third.id,
          )!.state,
      )
      .toBe("running");
    const fourth = await submit(
      draftId,
      "补充并替代上一要求：步长增加选项3，保留value标识与增加、减少、重置按钮，摘要必须显示当前步长。",
      true,
    );
    await expect
      .poll(
        async () =>
          (await state()).widgetGeneration!.tasks.find(
            (t) => t.id === third.id,
          )!.state,
        { timeout: 30_000 },
      )
      .toBe("stopped");
    expect(
      (await state()).widgetGeneration!.candidates.some(
        (c) => c.taskId === third.id && c.state === "preview",
      ),
    ).toBe(false);
    records[2].status = "PASS";
    save();
    const c4 = await finish(fourth.id),
      v4 = await view(c4.id);
    expect(c4.requirementRevision).toBe(fourth.requirementRevision);
    await v4.getByRole("button", { name: "重置", exact: true }).click();
    await v4.getByLabel("步长").selectOption("3");
    await v4.getByRole("button", { name: "增加", exact: true }).click();
    await expect(v4.locator("#value")).toHaveText("3");
    await retain(c4);
    expect((await state()).widgetGeneration!.widgets[0].id).toBe(formal.id);
    await shutdownReal(client, true);
    client = undefined;
    const seed = [
      seedWidgetCandidate(auth.root),
      seedWidgetCandidate(auth.root),
    ];
    const store = new Store(auth.root);
    const targetIds: string[] = [];
    try {
      for (const s of seed) {
        const c = store
          .snapshot()
          .widgetGeneration!.candidates.find((c) => c.id === s.candidateId)!;
        const r = store.execute(
          {
            type: "retainWidgetCandidate",
            candidateId: c.id,
            digest: c.digest,
            requirementRevision: c.requirementRevision,
          },
          "main",
        );
        if (!r.ok) throw new Error(r.message);
        targetIds.push(
          r.snapshot.widgetGeneration!.widgets.find(
            (w) => w.candidateId === c.id,
          )!.id,
        );
      }
    } finally {
      store.close();
    }
    client = await launchReal(auth.root, { background: true });
    page = client.page;
    const pairId = randomUUID();
    await command(page, {
      type: "createWidgetEditDraft",
      id: pairId,
      widgetIds: targetIds,
    });
    await command(page, { type: "selectWidgetDraft", id: pairId });
    await goTo(page, "控件");
    const before = (await state()).widgetGeneration!.widgets;
    const fifth = await submit(
      pairId,
      `仅修改所选两个目标：${targetIds[0]}每次增加5，${targetIds[1]}每次增加9；各自output#value初始0、按钮增加。保留目标身份，提交完整集合和紧凑布局minWidth300 gap12。`,
    );
    const c5 = await finish(fifth.id);
    expect(c5.members?.map((m) => m.widgetId).sort()).toEqual(
      [...targetIds].sort(),
    );
    for (const [i, id] of targetIds.entries()) {
      const member = c5.members!.find((m) => m.widgetId === id)!;
      await page
        .getByLabel("选择集合预览")
        .getByRole("button", { name: member.name, exact: true })
        .click();
      const v = await view(member.id);
      await v.getByRole("button", { name: "增加", exact: true }).click();
      await expect(v.locator("#value")).toHaveText(String(i === 0 ? 5 : 9));
      await v.screenshot({ path: join(auth.evidence, `target-${i}.png`) });
    }
    await retain(c5);
    const after = (await state()).widgetGeneration!.widgets;
    expect(after.map((w) => ({ id: w.id, position: w.position }))).toEqual(
      before.map((w) => ({ id: w.id, position: w.position })),
    );
    for (const id of targetIds)
      expect(after.find((w) => w.id === id)!.revision).toBe(
        before.find((w) => w.id === id)!.revision + 1,
      );
    records[4].targets = targetIds;
    save();
  } catch (e) {
    records.push({
      status: "FAIL",
      error: e instanceof Error ? e.message : String(e),
    });
    save();
    throw e;
  } finally {
    save();
    await shutdownReal(client, true);
  }
});
test.use({ trace: "off", screenshot: "off", actionTimeout: 30_000 });
