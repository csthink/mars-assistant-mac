import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeLocal, launchLocal } from "./local-client";
import { goTo } from "./shell";
import { addProvider, openProvider } from "./provider-ui";
import {
  workbenchProvider,
  workbenchProviderSecret,
} from "./workbench-provider-fixture";
import type { AddressInfo } from "node:net";
import { createClaudeFixture } from "./claude-fixture";
import { createCodexFixture } from "./codex-fixture";
import { seedRetainedWidgets } from "./widget-generation-fixture";

/*
 * WB-02 Agent ordering in a main-window conversation (mac-feature-t11 S-05), with local CLI fixtures standing in
 * for Claude Code and Codex: the fixture plays the model's tool calls; the product resolves them, commits or
 * refuses, and draws the result under the request. No real model is called.
 */
const names = ["天气", "便笺", "计时", "便笺", "汇率"];
function setup(prefix: string) {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(`.test-data/disposable/${prefix}-`));
  const data = join(root, "data");
  mkdirSync(data);
  const ids = seedRetainedWidgets(data, names).map((w) => w.id);
  return { root, data, ids };
}
const stored = (data: string) => {
  const db = new DatabaseSync(join(data, "state.sqlite"), { readOnly: true });
  try {
    return (
      db.prepare("SELECT id FROM saved_widgets ORDER BY position").all() as {
        id: string;
      }[]
    ).map((r) => r.id);
  } finally {
    db.close();
  }
};
async function ask(page: Page, text: string) {
  await goTo(page, "聊天");
  await page
    .getByRole("button", { name: /^新建(聊天|对话)$/ })
    .first()
    .click();
  const input = page.getByRole("textbox", { name: "输入草稿" });
  await input.fill(text);
  await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}

test("workbench agent: a Claude Code turn moves a widget by name and is refused for a shared name, with product result cards", async () => {
  const { root, data, ids } = setup("workbench-claude");
  const fixture = createClaudeFixture(join(root, "cli"));
  fixture.update({
    mode: "workbench",
    workbenchCalls: [
      { name: "list_workbench_widgets", arguments: {} },
      {
        name: "move_workbench_widget",
        arguments: { name: "汇率", toPosition: 1, orderRevision: 5 },
      },
      {
        name: "move_workbench_widget",
        arguments: { name: "便笺", toPosition: 2, orderRevision: 6 },
      },
    ],
  });
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${data}`],
    cwd: resolve("."),
    env: { ...process.env, HOME: root, PATH: `${fixture.bin}:/usr/bin:/bin` },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    await openProvider(page, "Claude Code");
    const section = page.getByRole("region", {
      name: "Claude Code 连接",
      exact: true,
    });
    await section
      .getByRole("button", { name: "配置 Claude Code", exact: true })
      .click();
    await section
      .getByRole("button", { name: "确认配置 Claude Code", exact: true })
      .click();
    const row = section.getByRole("group", {
      name: "模型 claude-synthetic[1m]",
      exact: true,
    });
    await row.getByRole("button", { name: "设为默认", exact: true }).click();
    await expect(row.getByText("默认", { exact: true })).toBeVisible();
    await ask(page, "把汇率移到第一个，再把便笺移到第二个");
    const cards = page.getByRole("list", { name: "工作台操作结果" });
    await expect(cards.getByRole("listitem")).toHaveText([
      "已将「汇率」移到第 1 位",
      `未移动：有 2 个名为「便笺」的控件（第 3 位 ${ids[1].slice(0, 8)}、第 5 位 ${ids[3].slice(0, 8)}），需要先说明是哪一个`,
    ]);
    expect(stored(data)).toEqual([ids[4], ids[0], ids[1], ids[2], ids[3]]);
    // The session allowed only the product's workbench tools; the shared name returned candidates to the model.
    const calls = readFileSync(fixture.calls, "utf8");
    expect(calls).toContain(
      "mcp__csthink_assistant__list_workbench_widgets,mcp__csthink_assistant__move_workbench_widget",
    );
    expect(calls).toMatch(/workbenchResult.*ambiguous/);
    await goTo(page, "控件");
    await expect(page.locator("[data-formal-widget]").first()).toHaveAttribute(
      "data-formal-widget",
      ids[4],
    );
  } finally {
    await closeLocal(app);
  }
});

test("workbench agent: a Codex turn quoting an old order revision moves nothing, and the current revision moves once", async () => {
  const { root, data, ids } = setup("workbench-codex");
  const fixture = createCodexFixture(join(root, "cli"));
  fixture.update({
    mode: "turn_workbench",
    workbenchCalls: [
      {
        tool: "move_workbench_widget",
        arguments: { widgetId: ids[4], toPosition: 1, orderRevision: 4 },
      },
      {
        tool: "move_workbench_widget",
        arguments: { widgetId: ids[4], toPosition: 1, orderRevision: 5 },
      },
    ],
  });
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${data}`],
    cwd: resolve("."),
    env: {
      ...process.env,
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      HOME: root,
      CODEX_HOME: join(root, "codex-home"),
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    await openProvider(page, "Codex");
    const section = page.getByRole("region", { name: "Codex 连接" });
    await section
      .getByRole("button", { name: "配置 Codex", exact: true })
      .click();
    await page
      .getByRole("region", { name: "确认 Codex 连接" })
      .getByRole("button", { name: "确认配置 Codex", exact: true })
      .click();
    await expect(section.getByText("已配置", { exact: true })).toBeVisible();
    await section
      .getByRole("button", { name: "设为默认模型", exact: true })
      .click();
    await ask(page, "把汇率移到第一个");
    const cards = page.getByRole("list", { name: "工作台操作结果" });
    await expect(cards.getByRole("listitem")).toHaveText([
      "未移动：控件顺序已在之后被改动，「汇率」保持在第 5 位",
      "已将「汇率」移到第 1 位",
    ]);
    await expect(page.getByRole("article", { name: "助手消息" })).toHaveText(
      "fixture-workbench-done",
    );
    // The stale request moved nothing; the second call quoted the current revision and moved once.
    expect(stored(data)).toEqual([ids[4], ids[0], ids[1], ids[2], ids[3]]);
  } finally {
    await closeLocal(app);
  }
});

test("workbench agent: an API model gets the workbench tools only after its tool call check confirmed them", async () => {
  const { data, ids } = setup("workbench-api");
  const { server, requests } = workbenchProvider();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${data}`],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    for (const [name, route] of [
      ["拒绝工具模拟", "notools"],
      ["工具模拟", "agent"],
    ] as const)
      await addProvider(page, {
        name,
        url: `http://127.0.0.1:${port}/${route}/v1`,
        provider: "custom",
        model: "mock-model",
        secret: workbenchProviderSecret,
        makeDefault: route === "agent",
      });
    // Unchecked: an ordinary conversation sends no tools, and the Agent cannot move anything.
    await ask(page, "把汇率移到第一个");
    await expect(page.getByRole("article", { name: "助手消息" })).toHaveText(
      "收到。",
    );
    expect(requests.at(-1)!.body.tools).toBeUndefined();
    expect(stored(data)).toEqual(ids);
    // A provider that refuses tools is recorded as unsupported; no probe is ever sent without a click.
    const refusing = await openProvider(page, "拒绝工具模拟");
    const refusingRow = refusing.getByRole("group", {
      name: "模型 mock-model",
      exact: true,
    });
    await expect(refusingRow.getByText(/工具调用：未检测/)).toBeVisible();
    const before = requests.length;
    await refusingRow
      .getByRole("button", { name: "能力与预算", exact: true })
      .click();
    expect(requests.length).toBe(before);
    await refusingRow
      .getByRole("button", { name: "检测工具调用", exact: true })
      .click();
    await expect(
      refusingRow.getByText(/工具调用：不支持，检测于/),
    ).toBeVisible();
    await expect(
      refusingRow.getByText(/工具调用检测：失败.*不支持工具调用/),
    ).toBeVisible();
    // The capable model is confirmed by its own check.
    const capable = await openProvider(page, "工具模拟");
    const capableRow = capable.getByRole("group", {
      name: "模型 mock-model",
      exact: true,
    });
    await capableRow
      .getByRole("button", { name: "能力与预算", exact: true })
      .click();
    await capableRow
      .getByRole("button", { name: "检测工具调用", exact: true })
      .click();
    await expect(
      capableRow.getByText(/工具调用：已确认，检测于/),
    ).toBeVisible();
    await expect(capableRow.getByText(/工具调用检测：成功/)).toBeVisible();
    await ask(page, "把汇率移到第一个");
    await expect(
      page.getByRole("list", { name: "工作台操作结果" }).getByRole("listitem"),
    ).toHaveText(["已将「汇率」移到第 1 位"]);
    await expect(page.getByRole("article", { name: "助手消息" })).toHaveText(
      "已按要求调整。",
    );
    const offered = requests.filter(
      (r) => r.body.tools && r.body.stream !== false,
    );
    expect(
      (offered[0].body.tools as { function: { name: string } }[]).map(
        (t) => t.function.name,
      ),
    ).toEqual(["list_workbench_widgets", "move_workbench_widget"]);
    expect(stored(data)).toEqual([ids[4], ids[0], ids[1], ids[2], ids[3]]);
  } finally {
    await closeLocal(app);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
