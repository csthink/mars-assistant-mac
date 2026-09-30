import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { launchLocal } from "./local-client";
import { goTo } from "./shell";
import { addProvider, openProvider } from "./provider-ui";
import { createClaudeFixture } from "./claude-fixture";
import { createCodexFixture } from "./codex-fixture";
import { trustBoundaryNotice } from "../../src/shared/capabilities";
let app: ElectronApplication,
  page: Page,
  claude: ReturnType<typeof createClaudeFixture>,
  codex: ReturnType<typeof createCodexFixture>,
  data: string,
  root: string;
async function start() {
  app = await launchLocal({
    args: [resolve("."), `--data-root=${data}`],
    cwd: resolve("."),
    env: {
      ...process.env,
      HOME: root,
      PATH: `${claude.bin}:${codex.bin}:/usr/bin:/bin`,
      CODEX_HOME: join(root, "codex-home"),
    },
  });
  page = await app.firstWindow();
  await expect(
    page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
}
async function snapshot() {
  return page.evaluate(async () => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    return r.snapshot;
  });
}
async function configureCodex() {
  const section = page.getByRole("region", { name: "Codex 连接" });
  await section
    .getByRole("button", { name: "配置 Codex", exact: true })
    .click();
  await page
    .getByRole("region", { name: "确认 Codex 连接" })
    .getByRole("button", { name: "确认配置 Codex", exact: true })
    .click();
  await expect(section.getByText("已配置", { exact: true })).toBeVisible();
  return section;
}
async function configureClaude() {
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
  await expect(
    section.getByLabel("启用模型 claude-synthetic[1m]", { exact: true }),
  ).toBeChecked();
  return section;
}
test.beforeEach(async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  root = mkdtempSync(resolve(".test-data/disposable/effort-"));
  claude = createClaudeFixture(join(root, "claude-cli"));
  codex = createCodexFixture(join(root, "codex-cli"));
  data = join(root, "data");
  mkdirSync(data);
  await start();
});
test.afterEach(async () => {
  if (app) await app.close();
});

test("effort: settings show levels and defaults read back per model, unrecorded when the installation lacks the parameter, and never for API providers", async ({}, info) => {
  await openProvider(page, "Codex");
  const codexSection = await configureCodex();
  const codexSummary = codexSection.locator(".effort-summary > p").first();
  await expect(codexSummary).toHaveText(
    /^推理强度 · synthetic-model：low \/ medium \/ high \/ xhigh · 默认 medium，读回于 /,
  );
  const codexConnection = (await snapshot()).connections.find(
    (c) => c.provider === "codex",
  )!;
  expect(codexConnection.models[0].effort).toMatchObject({
    levels: ["low", "medium", "high", "xhigh"],
    defaultLevel: "medium",
    source: "codex-model-list",
  });
  await page.screenshot({ path: info.outputPath("codex-effort.png") });
  // The parameter disappears from the installation: the next detection records nothing and does not fail.
  codex.update({ efforts: {} });
  await codexSection
    .getByRole("button", { name: "重新检测 Codex", exact: true })
    .click();
  await expect(codexSummary).toHaveText(
    "推理强度 · synthetic-model：未记录（当次安装未提供该参数，按模型默认执行）",
  );
  await expect(codexSection.getByText("已配置", { exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await snapshot()).connections.find((c) => c.provider === "codex")!
          .models[0].effort,
    )
    .toBeNull();
  // The parameter returns with the user's configured default inside the advertised set.
  codex.update({
    efforts: {
      "synthetic-model": { default: "low", levels: ["low", "high", "ultra"] },
    },
    configuredEffort: "high",
  });
  await codexSection
    .getByRole("button", { name: "重新检测 Codex", exact: true })
    .click();
  await expect(codexSummary).toHaveText(
    /^推理强度 · synthetic-model：low \/ high \/ ultra · 默认 high，读回于 /,
  );

  await openProvider(page, "Claude Code");
  const claudeSection = await configureClaude();
  const claudeSummary = claudeSection.locator(".effort-summary > p").first();
  await expect(claudeSummary).toHaveText(
    /^推理强度 · claude-synthetic\[1m\]：low \/ medium \/ high \/ xhigh \/ max · 默认 未记录，读回于 /,
  );
  await claudeSection
    .getByLabel("启用模型 claude-other", { exact: true })
    .click();
  await expect(
    claudeSection.getByLabel("启用模型 claude-other", { exact: true }),
  ).toBeChecked();
  await claudeSection
    .getByLabel("已配置的 Claude Code 模型", { exact: true })
    .selectOption("claude-other");
  await expect(claudeSummary).toHaveText(
    "推理强度 · claude-other：未记录（当次安装未提供该参数，按模型默认执行）",
  );
  await page.screenshot({ path: info.outputPath("claude-effort.png") });
  const claudeConnection = (await snapshot()).connections.find(
    (c) => c.provider === "claude",
  )!;
  expect(
    claudeConnection.models.map((m) => [m.model, m.effort?.levels ?? null]),
  ).toEqual([
    ["claude-synthetic[1m]", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-other", null],
  ]);

  const api = await addProvider(page, {
    name: "合成 API",
    url: "http://127.0.0.1:9/v1",
    model: "api-model",
  });
  await expect(
    api
      .getByRole("group", { name: "模型 api-model", exact: true })
      .locator(".effort-summary"),
  ).toHaveText("推理强度 · api-model：未记录（未按提供方取证，不透传字段）");
  expect(
    (await snapshot()).connections.find((c) => c.name === "合成 API")!.models[0]
      .effort,
  ).toBeNull();
  await page.screenshot({ path: info.outputPath("api-effort.png") });
});

async function clickAppMenu(label: string) {
  await app.evaluate(({ Menu }, target) => {
    const item = Menu.getApplicationMenu()?.items[0].submenu?.items.find(
      (item) => item.label === target,
    );
    if (!item) throw new Error("Missing menu item");
    item.click();
  }, label);
}

test("effort: both surfaces share one level control, the choice lives on the conversation, snapshots and records show it, unrecorded models disable it and a model switch resets it", async ({}, info) => {
  await openProvider(page, "Codex");
  const codexSection = await configureCodex();
  await codexSection
    .getByRole("button", { name: "设为默认模型", exact: true })
    .click();
  const api = await addProvider(page, {
    name: "合成 API",
    url: "http://127.0.0.1:9/v1",
    model: "api-model",
    secret: "synthetic-key-not-real",
  });
  await expect(api).toBeVisible();
  await goTo(page, "聊天");
  await page
    .locator("#main-sidebar")
    .getByRole("button", { name: "新建聊天", exact: true })
    .click();
  const level = page.getByRole("combobox", { name: "推理强度" });
  await expect(level).toBeEnabled();
  await expect(level.locator("option")).toHaveText([
    "推理 · 默认（medium）",
    "推理 · low",
    "推理 · medium",
    "推理 · high",
    "推理 · xhigh",
  ]);
  await level.selectOption("high");
  const conversation = () =>
    snapshot().then((s) =>
      s.conversations.find((c) => c.id === s.selected.main)!,
    );
  await expect.poll(async () => (await conversation()).effort).toBe("high");
  // The menu bar panel renders the same composer and the same saved choice.
  const panelOpening = app.waitForEvent("window");
  await clickAppMenu("打开工作台助手");
  const panel = await panelOpening;
  await panel.waitForLoadState("domcontentloaded");
  await panel.getByRole("button", { name: "聊天", exact: true }).click();
  const panelLevel = panel.getByRole("combobox", { name: "推理强度" });
  await expect(panelLevel).toHaveValue("high");
  await panelLevel.selectOption("low");
  await expect(level).toHaveValue("low");
  await expect.poll(async () => (await conversation()).effort).toBe("low");
  await panel.screenshot({ path: info.outputPath("panel-effort.png") });
  await page.getByRole("textbox", { name: "输入草稿" }).fill("按 low 档位提问");
  await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("article", { name: "助手消息" })).toHaveText(
    "partial-answer",
  );
  await expect(page.locator(".turn-reference")).toHaveText(
    "Codex · synthetic-model · 推理 low",
  );
  const sent = (await snapshot()).turns[0];
  expect(sent.connection.effort).toBe("low");
  await page.screenshot({ path: info.outputPath("main-effort-turn.png") });
  await goTo(page, "运行记录");
  await expect(
    page.locator(".event-connection").filter({ hasText: "推理 low" }).first(),
  ).toBeVisible();
  const historic = (await snapshot()).events.find(
    (event) =>
      event.executionId === sent.executionId &&
      event.connection?.effort === "low",
  )!;
  expect(historic).toBeDefined();
  const historicRow = page
    .locator(".record-row")
    .filter({ hasText: historic.id });
  await expect(historicRow).toContainText("Codex · synthetic-model · 推理 low");
  await historicRow.click();
  await expect(page.locator(".record-context")).toContainText(historic.id);
  await expect(page.locator(".record-context")).toContainText(
    "Codex · synthetic-model · 推理 low",
  );
  await goTo(page, "聊天");
  // An unrecorded model keeps the control visible but disabled, and the choice does not travel.
  const picker = page.getByRole("combobox", { name: "本次连接" });
  const apiId = (await snapshot()).connections.find(
    (c) => c.name === "合成 API",
  )!.id;
  await picker.selectOption(`${apiId}::api-model`);
  await expect(level).toBeDisabled();
  await expect(level.locator("option")).toHaveText(["推理 · 未记录"]);
  await expect(page.locator(".effort-choice")).toHaveAttribute(
    "title",
    "该模型未记录推理强度档位，按模型默认执行",
  );
  await expect.poll(async () => (await conversation()).effort).toBeNull();
  const codexId = (await snapshot()).connections.find(
    (c) => c.provider === "codex",
  )!.id;
  await picker.selectOption(`${codexId}::synthetic-model`);
  await expect(level).toBeEnabled();
  await expect(level).toHaveValue("");
  // The earlier turn keeps the level it was sent with.
  await expect(page.locator(".turn-reference")).toHaveText(
    "Codex · synthetic-model · 推理 low",
  );
  expect((await snapshot()).turns[0].connection.effort).toBe("low");
  await goTo(page, "运行记录");
  await page.locator(".record-row").filter({ hasText: historic.id }).click();
  await expect(page.locator(".record-context")).toContainText(
    "Codex · synthetic-model · 推理 low",
  );
  expect(
    (await snapshot()).events.find((event) => event.id === historic.id),
  ).toEqual(historic);
});

test("effort: sessions receive the fixed level on both local executors, an installation that stops offering it refuses instead of dropping it, a differing Codex read-back stops, and API requests carry no level", async ({}, info) => {
  const requests: Array<Record<string, unknown>> = [];
  const mock = createServer((request, response) => {
    let body = "";
    request.on("data", (part) => (body += part));
    request.on("end", () => {
      requests.push(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"choices":[{"delta":{"content":"API 回答"}}]}\n\ndata: [DONE]\n\n',
      );
    });
  });
  await new Promise<void>((done) => mock.listen(0, "127.0.0.1", done));
  try {
    const port = (mock.address() as AddressInfo).port;
    await openProvider(page, "Codex");
    await configureCodex();
    await openProvider(page, "Claude Code");
    await configureClaude();
    await addProvider(page, {
      name: "模拟 API",
      url: `http://127.0.0.1:${port}/v1`,
      model: "api-model",
      secret: "synthetic-key-not-real",
    });
    const ids = await snapshot();
    const codexId = ids.connections.find((c) => c.provider === "codex")!.id;
    const claudeId = ids.connections.find((c) => c.provider === "claude")!.id;
    const apiId = ids.connections.find((c) => c.name === "模拟 API")!.id;
    const picker = page.getByRole("combobox", { name: "本次连接" });
    const level = page.getByRole("combobox", { name: "推理强度" });
    const input = page.getByRole("textbox", { name: "输入草稿" });
    const ask = async (text: string) => {
      await input.fill(text);
      await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
    };
    const lastTurn = async () =>
      (await snapshot()).turns.sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : -1,
      )[0];
    const settled = async () => {
      await expect
        .poll(async () =>
          ["completed", "failed"].includes((await lastTurn()).state),
        )
        .toBe(true);
      return lastTurn();
    };
    const codexCalls = () =>
      readFileSync(codex.calls, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: { config?: Record<string, unknown> };
            },
        );
    const claudeCalls = () =>
      readFileSync(claude.calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args?: string[] });
    await goTo(page, "聊天");
    // Codex: the chosen level is thread configuration and the read-back matches.
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    await picker.selectOption(`${codexId}::synthetic-model`);
    await level.selectOption("xhigh");
    await ask("Codex xhigh");
    const codexTurn = await settled();
    expect(codexTurn.state).toBe("completed");
    expect(codexTurn.connection.effort).toBe("xhigh");
    expect(
      codexCalls()
        .filter((c) => c.method === "thread/start")
        .at(-1)?.params?.config,
    ).toEqual({ model_reasoning_effort: "xhigh" });
    // Codex: a read-back that differs from the request stops the turn before any answer.
    codex.update({ effortReadback: "low" });
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    await picker.selectOption(`${codexId}::synthetic-model`);
    await level.selectOption("high");
    await ask("Codex 读回不符");
    const mismatch = await settled();
    expect(mismatch.state).toBe("failed");
    expect(mismatch.errorMessage).toMatch(/推理强度.*不符/);
    await expect(page.getByRole("alert")).toContainText("推理强度");
    await page.screenshot({
      path: info.outputPath("codex-readback-mismatch.png"),
    });
    codex.update({ effortReadback: null });
    // Claude Code: --effort is passed, then an installation without the flag refuses the turn.
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    await picker.selectOption(`${claudeId}::claude-synthetic[1m]`);
    await level.selectOption("max");
    await ask("Claude max");
    const claudeTurn = await settled();
    expect(claudeTurn.state).toBe("completed");
    expect(claudeTurn.connection.effort).toBe("max");
    const session = claudeCalls()
      .filter(
        (c) =>
          c.args?.includes("--session-id") &&
          !c.args.includes("--no-session-persistence"),
      )
      .at(-1);
    expect(session?.args?.slice(-2)).toEqual(["--effort", "max"]);
    claude.update({ effortFlag: false });
    const beforeRefusal = claudeCalls().length;
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    await picker.selectOption(`${claudeId}::claude-synthetic[1m]`);
    await level.selectOption("high");
    await ask("Claude 无参数");
    const refused = await settled();
    expect(refused.state).toBe("failed");
    expect(refused.errorMessage).toMatch(/不支持所选推理强度档位/);
    expect(
      claudeCalls()
        .slice(beforeRefusal)
        .some(
          (c) =>
            c.args?.includes("--session-id") && !c.args.includes("--effort"),
        ),
    ).toBe(false);
    await page.screenshot({ path: info.outputPath("claude-flag-missing.png") });
    // API: the request body has no level field and the snapshot records none.
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    await picker.selectOption(`${apiId}::api-model`);
    await expect(level).toBeDisabled();
    await ask("API 回合");
    const apiTurn = await settled();
    expect(apiTurn.state).toBe("completed");
    expect(apiTurn.connection.effort).toBeNull();
    expect(requests.length).toBe(1);
    for (const key of [
      "effort",
      "reasoning_effort",
      "reasoning",
      "thinking",
      "model_reasoning_effort",
    ])
      expect(key in requests[0], key).toBe(false);
  } finally {
    mock.closeAllConnections();
    await new Promise<void>((done) => mock.close(() => done()));
  }
});

test("access boundary: the trust boundary notice is fixed at the top of the access permission page in both appearances, even with no saved permissions", async ({}, info) => {
  await goTo(page, "设置");
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "访问权限", exact: true })
    .click();
  const notice = page.getByRole("region", {
    name: "首期信任边界",
    exact: true,
  });
  await expect(notice).toBeVisible();
  await expect(notice.locator("p").last()).toHaveText(trustBoundaryNotice);
  // The notice precedes the permission list, which is empty here.
  const order = await page.evaluate(() => {
    const region = document.querySelector('[aria-label="首期信任边界"]')!;
    const list = document.querySelector('[aria-label="已保存的访问权限"]')!;
    return region.compareDocumentPosition(list) &
      Node.DOCUMENT_POSITION_FOLLOWING
      ? "notice-first"
      : "list-first";
  });
  expect(order).toBe("notice-first");
  const contrast = async () =>
    page.evaluate(() => {
      const target = document.querySelector(
        '[aria-label="首期信任边界"] p:last-child',
      ) as HTMLElement;
      const parse = (value: string) => {
        const m = /rgba?\(([^)]+)\)/.exec(value);
        if (!m) return null;
        const [r, g, b, a = "1"] = m[1].split(",").map((v) => v.trim());
        return { r: +r, g: +g, b: +b, a: +a };
      };
      let element: HTMLElement | null = target;
      let background = null as {
        r: number;
        g: number;
        b: number;
        a: number;
      } | null;
      while (element && !background) {
        const value = parse(getComputedStyle(element).backgroundColor);
        if (value && value.a > 0) background = value;
        element = element.parentElement;
      }
      const color = parse(getComputedStyle(target).color)!;
      const luminance = (c: { r: number; g: number; b: number }) => {
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const l1 = luminance(color),
        l2 = luminance(background ?? { r: 255, g: 255, b: 255 });
      return {
        ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05),
        theme: document.documentElement.dataset.theme,
      };
    });
  const light = await contrast();
  expect(light.theme).toBe("light");
  expect(light.ratio).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: info.outputPath("access-boundary-light.png") });
  await page.evaluate(async () => {
    const r = await window.desktop.command({
      type: "setAppearance",
      appearance: "dark",
    });
    if (!r.ok) throw new Error(r.message);
  });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");
  const dark = await contrast();
  expect(dark.ratio).toBeGreaterThanOrEqual(4.5);
  await expect(notice.locator("p").last()).toHaveText(trustBoundaryNotice);
  await page.screenshot({ path: info.outputPath("access-boundary-dark.png") });
});

test("walkthrough: a conversation with API history can be sent to a local executor after the scope confirmation, with the chosen level", async ({}, info) => {
  const mock = createServer((request, response) => {
    let body = "";
    request.on("data", (part) => (body += part));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"choices":[{"delta":{"content":"API 回答"}}]}\n\ndata: [DONE]\n\n',
      );
    });
  });
  await new Promise<void>((done) => mock.listen(0, "127.0.0.1", done));
  try {
    const port = (mock.address() as AddressInfo).port;
    await openProvider(page, "Codex");
    await configureCodex();
    await addProvider(page, {
      name: "模拟 API",
      url: `http://127.0.0.1:${port}/v1`,
      model: "api-model",
      secret: "synthetic-key-not-real",
      makeDefault: true,
    });
    await goTo(page, "聊天");
    await page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true })
      .click();
    const input = page.getByRole("textbox", { name: "输入草稿" });
    await input.fill("先问 API");
    await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("article", { name: "助手消息" })).toHaveText(
      "API 回答",
    );
    const codexId = (await snapshot()).connections.find(
      (c) => c.provider === "codex",
    )!.id;
    await page
      .getByRole("combobox", { name: "本次连接" })
      .selectOption(`${codexId}::synthetic-model`);
    await page
      .getByRole("combobox", { name: "推理强度" })
      .selectOption("medium");
    await input.fill("再问 Codex");
    await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const scope = page.getByRole("alertdialog", { name: "跨提供方发送确认" });
    await expect(scope).toBeVisible();
    await scope.getByRole("button", { name: "确认发送", exact: true }).click();
    await expect(page.locator(".notice")).toHaveCount(0);
    await expect(
      page.getByRole("article", { name: "助手消息" }).last(),
    ).toHaveText("partial-answer");
    await expect(page.locator(".turn-reference").last()).toHaveText(
      "Codex · synthetic-model · 推理 medium",
    );
    await page.screenshot({
      path: info.outputPath("cross-provider-codex.png"),
    });
  } finally {
    mock.closeAllConnections();
    await new Promise<void>((done) => mock.close(() => done()));
  }
});
