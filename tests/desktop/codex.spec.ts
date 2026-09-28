import { openProvider } from "./provider-ui";
import { pngSample } from "./samples";
import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { closeLocal, launchLocal } from "./local-client";
import { goTo } from "./shell";
import { providersPage as overviewPage } from "./provider-ui";
async function providersPage(page: Page) {
  await overviewPage(page);
  if (
    await page
      .getByRole("button", { name: "打开提供方 Codex", exact: true })
      .isVisible()
  )
    await page
      .getByRole("button", { name: "打开提供方 Codex", exact: true })
      .click();
}
import { createCodexFixture } from "./codex-fixture";
let app: ElectronApplication;
let page: Page;
let fixture: ReturnType<typeof createCodexFixture>;
let root: string;
let data: string;
test.beforeEach(async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  root = mkdtempSync(resolve(".test-data/disposable/codex-"));
  fixture = createCodexFixture(join(root, "cli"));
  data = join(root, "data");
  mkdirSync(data);
  await restartClient();
});
async function restartClient() {
  app = await launchLocal({
    args: [resolve("."), `--data-root=${data}`],
    cwd: resolve("."),
    env: {
      ...process.env,
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      HOME: root,
      CODEX_HOME: join(root, "codex-home"),
    },
  });
  page = await app.firstWindow();
  await expect(
    page
      .locator(".home-header")
      .getByRole("button", { name: "新建对话", exact: true }),
  ).toBeEnabled();
  await providersPage(page);
}
test.afterEach(async () => {
  if (app) await app.close();
});
test("codex: settings automatically detect the installed CLI and compatible upgrades without a version warning or model call", async ({}, info) => {
  const section = page.getByRole("region", { name: "Codex 连接" });
  await expect(
    section.getByText("ChatGPT 登录", { exact: true }),
  ).toBeVisible();
  await expect(section.getByText("未测试", { exact: true })).toBeVisible();
  await section.getByText("连接详情", { exact: true }).click();
  await expect(section.getByText("0.153.4", { exact: true })).toBeVisible();
  await expect(section.getByText("已核对", { exact: true })).toBeVisible();
  fixture.update({
    version: "99.4.8-preview",
    model: "synthetic-upgraded-model",
  });
  await section
    .getByRole("button", { name: "重新检测 Codex", exact: true })
    .click();
  await expect(
    section.getByText("99.4.8-preview", { exact: true }),
  ).toBeVisible();
  await expect(
    section
      .locator(".codex-facts")
      .getByText("synthetic-upgraded-model", { exact: true }),
  ).toBeVisible();
  await expect(section.getByRole("alert")).toHaveCount(0);
  expect(await section.innerText()).not.toMatch(
    /版本变化|不支持的版本|需要升级|版本不兼容/,
  );
  const calls = readFileSync(fixture.calls, "utf8");
  expect(calls).not.toContain("turn/start");
  expect(calls).not.toContain("thread/start");
  expect(await page.content()).not.toContain("SYNTHETIC_SECRET_NOT_REAL");
  expect(await page.content()).not.toContain("private@");
  await section.getByText("连接详情", { exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(900, 680);
  });
  await page.screenshot({ path: info.outputPath("codex-settings.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("codex: signed out and unknown authentication are separate and a failed detection can be retried", async () => {
  const section = page.getByRole("region", { name: "Codex 连接" });
  await expect(
    section.getByRole("button", { name: "重新检测 Codex", exact: true }),
  ).toBeEnabled();
  fixture.update({ authentication: "signedOut" });
  await section
    .getByRole("button", { name: "重新检测 Codex", exact: true })
    .click();
  await expect(section.getByText("未登录", { exact: true })).toBeVisible();
  fixture.update({ authentication: "new-auth-mode" });
  await section
    .getByRole("button", { name: "重新检测 Codex", exact: true })
    .click();
  await expect(
    section.getByText("认证来源未知", { exact: true }),
  ).toBeVisible();
  fixture.update({ mode: "malformed" });
  await section
    .getByRole("button", { name: "重新检测 Codex", exact: true })
    .click();
  await expect(
    section.getByText("Codex 未能完成连接检测，请检查本地安装或配置后重试。", {
      exact: true,
    }),
  ).toBeVisible();
  fixture.update({ mode: "normal", authentication: "apiKey" });
  await section
    .getByRole("button", { name: "重新检测 Codex", exact: true })
    .click();
  await expect(
    section.getByText("API key 登录", { exact: true }),
  ).toBeVisible();
  await expect(section.getByText("未测试", { exact: true })).toBeVisible();
});

test("codex: configuration conflict is visible independently of login and recovery needs no version change", async () => {
  const section = page.getByRole("region", { name: "Codex 连接" });
  await expect(
    section.getByRole("button", { name: "重新检测 Codex", exact: true }),
  ).toBeEnabled();
  fixture.update({ mode: "conflict" });
  await section
    .getByRole("button", { name: "重新检测 Codex", exact: true })
    .click();
  await expect(
    section.getByText(
      "Codex 配置限制未能通过核对，暂不能发起会话。请检查配置后重新检测。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    section.getByText("ChatGPT 登录", { exact: true }),
  ).toBeVisible();
  await section.getByText("连接详情", { exact: true }).click();
  await expect(
    section.getByText("配置冲突，不能发起会话", { exact: true }),
  ).toBeVisible();
  fixture.update({ mode: "normal" });
  await section
    .getByRole("button", { name: "重新检测 Codex", exact: true })
    .click();
  await expect(section.getByText("已核对", { exact: true })).toBeVisible();
  expect(readFileSync(fixture.calls, "utf8")).not.toContain("turn/start");
});

test("codex: confirmed native connection becomes selectable and a synthetic answer uses the persisted origin", async () => {
  const section = page.getByRole("region", { name: "Codex 连接" });
  await section
    .getByRole("button", { name: "配置 Codex", exact: true })
    .click();
  const setup = page.getByRole("region", { name: "确认 Codex 连接" });
  await expect(
    setup.getByText("openai · synthetic-model · ChatGPT 登录", { exact: true }),
  ).toBeVisible();
  await setup
    .getByRole("button", { name: "确认配置 Codex", exact: true })
    .click();
  await expect(section.getByText("已配置", { exact: true })).toBeVisible();
  await section
    .getByRole("button", { name: "设为默认模型", exact: true })
    .click();
  await goTo(page, "聊天");
  await page
    .getByRole("button", { name: "新建对话", exact: true })
    .first()
    .click();
  const input = page.getByRole("textbox", { name: "输入草稿" });
  await input.fill("Synthetic native Codex question");
  await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("article", { name: "助手消息" })).toHaveText(
    "partial-answer",
  );
  const snapshot = await page.evaluate(async () => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    return r.snapshot;
  });
  const connection = snapshot.connections.find((c) => c.provider === "codex")!;
  expect(connection.secretRef).toBeNull();
  expect(
    snapshot.events.find(
      (e) => e.kind === "submitted" && e.connection?.provider === "codex",
    )?.connection?.codex,
  ).toEqual(connection.codex);
  expect(await page.content()).not.toContain("SYNTHETIC_SECRET_NOT_REAL");
  await providersPage(page);
  await section
    .getByRole("button", { name: "取消默认模型", exact: true })
    .click();
  await expect
    .poll(async () => (await nativeSnapshot()).settings.defaultConnectionId)
    .toBeNull();
  await section.getByRole("checkbox", { name: "启用 Codex 整合" }).click();
  await expect
    .poll(async () => (await nativeSnapshot()).settings.codex.enabled)
    .toBe(false);
  await section.getByRole("checkbox", { name: "启用 Codex 整合" }).click();
  await expect
    .poll(async () => (await nativeSnapshot()).settings.codex.enabled)
    .toBe(true);
  await expect(section.getByText("已配置", { exact: true })).toBeVisible();
  expect((await nativeSnapshot()).settings.defaultConnectionId).toBeNull();
});

async function configureNative() {
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
  await goTo(page, "聊天");
  await page
    .getByRole("button", { name: "新建对话", exact: true })
    .first()
    .click();
}
async function nativeSnapshot() {
  return page.evaluate(async () => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    return r.snapshot;
  });
}
async function requestNativeMaterial() {
  await configureNative();
  const file = join(fixture.bin, "selected.txt");
  writeFileSync(file, "UNPREDICTABLE_SYNTHETIC_" + Date.now());
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog;
  }, file);
  await page.getByRole("button", { name: "添加资料", exact: true }).click();
  await expect
    .poll(async () => (await nativeSnapshot()).draftAttachments.length)
    .toBe(1);
  await page
    .getByRole("textbox", { name: "输入草稿" })
    .fill("Read the selected synthetic material");
  await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeEnabled();
  const state = await nativeSnapshot();
  fixture.update({
    mode: "turn_tool",
    attachmentId: state.draftAttachments[0].attachmentId,
  });
  await page.evaluate(async () => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    const c = r.snapshot.connections.find((c) => c.provider === "codex")!;
    const reply = await window.desktop.command({
      type: "submitTurn",
      requestId: crypto.randomUUID(),
      conversationId: r.snapshot.selected.main!,
      connectionId: c.id,
      model: c.model,
      text: "Read the selected synthetic material",
      materialMode: "tools",
    });
    if (!reply.ok) throw new Error(reply.message);
  });
  await page
    .getByRole("button", { name: "到待处理确认资料读取", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "允许本次读取", exact: true }),
  ).toBeVisible();
  expect(readFileSync(fixture.calls, "utf8")).not.toContain(
    "UNPREDICTABLE_SYNTHETIC_",
  );
  return file;
}
test("codex: selected material reaches the native callback only after the existing permission UI approves it", async () => {
  const file = await requestNativeMaterial();
  await page.getByRole("button", { name: "允许本次读取", exact: true }).click();
  await expect
    .poll(async () => (await nativeSnapshot()).toolOperations[0]?.state)
    .toBe("completed");
  await expect
    .poll(async () => (await nativeSnapshot()).activeTurns.length)
    .toBe(0);
  expect(readFileSync(fixture.calls, "utf8")).toContain(
    readFileSync(file, "utf8"),
  );
  expect(JSON.stringify((await nativeSnapshot()).events)).not.toContain(
    "UNPREDICTABLE_SYNTHETIC_",
  );
});
test("codex: rejecting a material request does not return its text to the local Agent", async () => {
  await requestNativeMaterial();
  await page.getByRole("button", { name: "拒绝读取", exact: true }).click();
  await expect
    .poll(async () => (await nativeSnapshot()).activeTurns.length)
    .toBe(0);
  expect(readFileSync(fixture.calls, "utf8")).not.toContain(
    "UNPREDICTABLE_SYNTHETIC_",
  );
  expect((await nativeSnapshot()).toolOperations[0].state).toBe("denied");
});
test("codex: native stop preserves partial text and the confirmed CLI upgrade can still resume its own thread", async () => {
  await configureNative();
  fixture.update({ mode: "turn_hang" });
  await page
    .getByRole("textbox", { name: "输入草稿" })
    .fill("Synthetic stop and resume");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByText("partial-before-stop", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "停止回合", exact: true }).click();
  await expect
    .poll(async () => (await nativeSnapshot()).activeTurns.length)
    .toBe(0);
  const old = (await nativeSnapshot()).events.find(
    (e) => e.kind === "native_session" && e.payload.codex,
  )!;
  expect(old.payload.codex).toBeTruthy();
  fixture.update({ mode: "turn_partial_fail" });
  await page
    .getByRole("textbox", { name: "输入草稿" })
    .fill("Synthetic failure for recovery");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(async () => (await nativeSnapshot()).pendingItems.length)
    .toBe(1);
  fixture.update({ version: "100.8.3-preview", mode: "normal" });
  const state = await nativeSnapshot(),
    pending = state.pendingItems.find((p) => p.kind === "failed_turn");
  expect(pending).toBeTruthy();
  await page.evaluate(async (id) => {
    const r = await window.desktop.command({
      type: "resolvePending",
      id,
      action: "retry",
    });
    if (!r.ok) throw new Error(r.message);
  }, pending!.id);
  await expect(page.getByRole("article", { name: "助手消息" })).toHaveText(
    "partial-answer",
  );
  expect(readFileSync(fixture.calls, "utf8")).toContain("thread/resume");
});

test("codex: personal rule sources require consent and changed bytes invalidate configuration acceptance", async ({}, info) => {
  const path = join(fixture.bin, "personal-rule.md");
  writeFileSync(path, "SYNTHETIC_PRIVATE_RULE_FIRST");
  fixture.update({
    instructionsPath: path,
    inlineInstructions: "SYNTHETIC_INLINE_RULE",
  });
  const section = page.getByRole("region", { name: "Codex 连接" });
  await section
    .getByRole("button", { name: "配置 Codex", exact: true })
    .click();
  const setup = page.getByRole("region", { name: "确认 Codex 连接" });
  await expect(setup.getByText(path, { exact: true })).toBeVisible();
  await expect(
    setup.getByText("Codex 配置字段：developer_instructions", { exact: true }),
  ).toBeVisible();
  const accept = setup.getByRole("button", {
    name: "确认配置 Codex",
    exact: true,
  });
  await expect(accept).toBeDisabled();
  expect(await setup.innerText()).not.toContain("SYNTHETIC_PRIVATE_RULE_FIRST");
  expect(await setup.innerText()).not.toContain("SYNTHETIC_INLINE_RULE");
  await setup.getByRole("checkbox").click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
  );
  await accept.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("codex-source-consent.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  writeFileSync(path, "SYNTHETIC_PRIVATE_RULE_CHANGED");
  await accept.click();
  await expect(section.getByRole("alert")).toContainText("已确认配置不一致");
  expect(
    (await nativeSnapshot()).connections.some((c) => c.provider === "codex"),
  ).toBe(false);
  const calls = readFileSync(fixture.calls, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  expect(
    calls
      .filter((c) => c.method === "turn/start")
      .every(
        (c) =>
          c.params.input[0].text ===
          "Synthetic local runtime capability check.",
      ),
  ).toBe(true);
});

test("codex: custom executable persists, invalid override never falls back, and reset restores automatic discovery", async () => {
  const alternate = createCodexFixture(join(root, "alternate"));
  alternate.update({ model: "alternate-model", version: "201.0.1" });
  let section = page.getByRole("region", { name: "Codex 连接" });
  await expect(section.locator(".codex-path-settings")).toContainText(
    fixture.binary,
  );
  await section
    .getByRole("textbox", { name: "Codex 安装路径" })
    .fill(alternate.binary);
  await section
    .getByRole("button", { name: "保存安装路径", exact: true })
    .click();
  await expect(
    section
      .locator(".codex-facts")
      .getByText("alternate-model", { exact: true }),
  ).toBeVisible();
  await closeLocal(app);
  await restartClient();
  section = page.getByRole("region", { name: "Codex 连接" });
  await expect(
    section.getByRole("textbox", { name: "Codex 安装路径" }),
  ).toHaveValue(alternate.binary);
  await expect(
    section
      .locator(".codex-facts")
      .getByText("alternate-model", { exact: true }),
  ).toBeVisible();
  await section
    .getByRole("textbox", { name: "Codex 安装路径" })
    .fill(join(root, "missing-codex"));
  await section
    .getByRole("button", { name: "保存安装路径", exact: true })
    .click();
  await expect(
    section.getByText("指定的 Codex 路径不可用，请修改路径或重置为系统识别。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    section
      .locator(".codex-facts")
      .getByText("synthetic-model", { exact: true }),
  ).toHaveCount(0);
  await section
    .getByRole("button", { name: "重置为系统识别", exact: true })
    .click();
  await expect(
    section
      .locator(".codex-facts")
      .getByText("synthetic-model", { exact: true }),
  ).toBeVisible();
  expect((await nativeSnapshot()).settings.codex.path).toBeNull();
});

test("codex: disabled integration persists and blocks detection, preparation and model checks without spawning", async () => {
  await configureNative();
  await providersPage(page);
  await page.evaluate(() => window.desktop.detectCodex());
  const section = page.getByRole("region", { name: "Codex 连接" });
  await section.getByRole("checkbox", { name: "启用 Codex 整合" }).click();
  await expect
    .poll(async () => (await nativeSnapshot()).settings.codex.enabled)
    .toBe(false);
  const before = readFileSync(join(fixture.bin, "invocations.jsonl"), "utf8");
  const connection = (await nativeSnapshot()).connections.find(
    (c) => c.provider === "codex",
  )!;
  expect((await nativeSnapshot()).settings.defaultConnectionId).toBeNull();
  await closeLocal(app);
  await restartClient();
  await expect(
    page
      .getByRole("region", { name: "Codex 连接" })
      .getByRole("checkbox", { name: "启用 Codex 整合" }),
  ).not.toBeChecked();
  const result = await page.evaluate(
    async (id) => ({
      detected: await window.desktop.detectCodex(),
      prepared: await window.desktop.prepareCodex(),
      tested: await window.desktop.runConnectionCheck(
        "connection_test",
        id,
        "synthetic-model",
      ),
    }),
    connection.id,
  );
  expect(result.prepared.ok).toBe(false);
  expect(result.tested.ok).toBe(false);
  expect(readFileSync(join(fixture.bin, "invocations.jsonl"), "utf8")).toBe(
    before,
  );
});

test("codex: model list selection drives model testing, failures and stop retain separate native execution results", async () => {
  fixture.update({ models: ["second-model"] });
  const section = page.getByRole("region", { name: "Codex 连接" });
  await section
    .getByRole("button", { name: "刷新模型列表", exact: true })
    .click();
  await section
    .getByRole("checkbox", { name: "启用模型 second-model", exact: true })
    .click();
  await page
    .getByRole("region", { name: "确认 Codex 连接" })
    .getByRole("button", { name: "确认配置 Codex", exact: true })
    .click();
  await expect(
    section.getByText("当前模型：second-model", { exact: true }),
  ).toBeVisible();
  await section.getByRole("button", { name: "模型测试", exact: true }).click();
  await expect(section.getByText(/测试模型：.*模型测试成功/)).toBeVisible();
  const selected = (await nativeSnapshot()).connections
    .find((c) => c.provider === "codex")!
    .models.find((m) => m.model === "second-model")!;
  const first = selected.lastTest!;
  expect(selected.model).toBe("second-model");
  const native = (await nativeSnapshot()).events.find(
    (e) => e.executionId === first.executionId && e.kind === "submitted",
  )!;
  expect(native.connection?.codex?.authentication).toBe("chatgpt");
  expect(readFileSync(fixture.calls, "utf8")).toContain(
    '"model":"second-model"',
  );
  fixture.update({ mode: "turn_partial_fail" });
  await section.getByRole("button", { name: "模型测试", exact: true }).click();
  await expect(section.getByText(/测试模型：.*模型测试失败：/)).toBeVisible();
  fixture.update({ mode: "turn_hang" });
  await section.getByRole("button", { name: "模型测试", exact: true }).click();
  await expect(
    section.getByRole("button", { name: "停止测试", exact: true }),
  ).toBeVisible();
  await section.getByRole("checkbox", { name: "启用 Codex 整合" }).click();
  await expect(section.getByRole("alert")).toContainText("请先停止回合或测试");
  await section.getByRole("button", { name: "停止测试", exact: true }).click();
  await expect(
    section.getByText("模型测试已停止", { exact: true }),
  ).toBeVisible();
  expect((await nativeSnapshot()).settings.codex.enabled).toBe(true);
});

test("codex: pending source verification rejects setting edits and a later path change invalidates its confirmation", async () => {
  await page.evaluate(() => window.desktop.detectCodex());
  const results = await page.evaluate(async () => {
    const preparing = window.desktop.prepareCodex();
    const changed = await window.desktop.command({
      type: "setCodexSettings",
      enabled: false,
      path: null,
      revision: 0,
    });
    return { changed, prepared: await preparing };
  });
  expect(results.changed.ok).toBe(false);
  expect(results.prepared.ok).toBe(true);
  expect((await nativeSnapshot()).settings.codex.enabled).toBe(true);
  if (!results.prepared.ok) throw new Error(results.prepared.message);
  const accepted = await page.evaluate(
    async ({ path, token }) => {
      const changed = await window.desktop.command({
        type: "setCodexSettings",
        enabled: true,
        path,
        revision: 0,
      });
      if (!changed.ok) throw new Error(changed.message);
      return window.desktop.acceptCodex(token);
    },
    { path: fixture.binary, token: results.prepared.setup.token },
  );
  expect(accepted.ok).toBe(false);
});

test("codex: search, multiple configured native models and API models remain selectable with their own sources", async ({}, info) => {
  fixture.update({ models: ["synthetic-model", "second-model"] });
  await configureNative();
  await providersPage(page);
  const section = page.getByRole("region", { name: "Codex 连接" });
  await section
    .getByRole("button", { name: "刷新模型列表", exact: true })
    .click();
  await section
    .getByRole("searchbox", { name: "搜索 Codex 模型" })
    .fill("SECOND");
  await expect(
    section.getByRole("checkbox", {
      name: "启用模型 synthetic-model",
      exact: true,
    }),
  ).toHaveCount(0);
  await section
    .getByRole("checkbox", { name: "启用模型 second-model", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await nativeSnapshot()).connections
          .find((c) => c.provider === "codex")!
          .models.filter((m) => m.enabled).length,
    )
    .toBe(2);
  await expect(
    page.getByRole("region", { name: "确认 Codex 连接" }),
  ).toHaveCount(0);
  await expect(section.getByText("核对并添加", { exact: true })).toHaveCount(0);
  const secondRow = section.getByRole("group", {
    name: "模型 second-model",
    exact: true,
  });
  await secondRow
    .getByRole("checkbox", { name: "启用模型 second-model", exact: true })
    .click();
  await expect(secondRow.getByRole("checkbox")).not.toBeChecked();
  await secondRow.getByRole("checkbox").click();
  await expect(secondRow.getByRole("checkbox")).toBeChecked();
  await expect(
    page.getByRole("region", { name: "确认 Codex 连接" }),
  ).toHaveCount(0);
  await secondRow
    .getByRole("button", { name: "设为默认", exact: true })
    .click();
  await expect(secondRow.getByText("默认", { exact: true })).toBeVisible();
  await expect(secondRow.getByRole("checkbox")).toBeDisabled();
  await secondRow
    .getByRole("button", { name: "测试模型", exact: true })
    .click();
  await expect(secondRow.getByRole("status")).toHaveText("文本调用：已完成");
  expect(
    (await nativeSnapshot()).connections
      .find((c) => c.provider === "codex")!
      .models.find((m) => m.model === "second-model")!.lastTest?.state,
  ).toBe("completed");
  const codex = (await nativeSnapshot()).connections.find(
    (c) => c.provider === "codex",
  )!;
  expect(codex.models.filter((m) => m.enabled).map((m) => m.model)).toEqual([
    "synthetic-model",
    "second-model",
  ]);
  expect(codex.models[0].codex?.fingerprint).not.toBe(
    codex.models[1].codex?.fingerprint,
  );
  await section
    .getByRole("searchbox", { name: "搜索 Codex 模型" })
    .fill("missing");
  await expect(section.getByText("没有匹配的 Codex 模型")).toBeVisible();
  await section.getByRole("searchbox", { name: "搜索 Codex 模型" }).fill("");
  await section
    .getByLabel("已配置的 Codex 模型")
    .selectOption("synthetic-model");
  await section.getByRole("button", { name: "模型测试", exact: true }).click();
  await expect(section.getByText(/测试模型：.*模型测试成功/)).toBeVisible();
  // Add an API model using synthetic data only; its missing key must remain visible and unavailable.
  await page.evaluate(async () => {
    const r = await window.desktop.command({
      type: "upsertConnection",
      id: crypto.randomUUID(),
      name: "API visible",
      provider: "custom",
      baseUrl: "https://example.test/v1",
      model: "api-model",
      secretRef: null,
      revision: 0,
      imageInput: "unknown",
      contextChars: null,
    });
    if (!r.ok) throw Error(r.message);
  });
  await page.evaluate(async () => {
    const reply = await window.desktop.command({
      type: "setDefaultConnection",
      id: null,
    });
    if (!reply.ok) throw Error(reply.message);
  });
  await closeLocal(app);
  await restartClient();
  await goTo(page, "聊天");
  await page
    .getByRole("button", { name: "新建对话", exact: true })
    .first()
    .click();
  const picker = page.getByRole("combobox", { name: "本次连接" });
  // The picker stays disabled until the new conversation has loaded, so its options are checked once it is
  // usable. Playwright judges an <option> inside the <label> that wraps its <select> by the label's control,
  // the select itself, so each option's own disabled property is read instead of toBeDisabled/toBeEnabled.
  await expect(picker).toBeEnabled();
  await expect(
    picker.locator("option").filter({ hasText: "API visible · api-model" }),
  ).toHaveJSProperty("disabled", true);
  await expect(
    page.getByRole("searchbox", { name: "搜索对话模型" }),
  ).toHaveCount(0);
  await expect(
    picker.locator(`option[value="${codex.id}::second-model"]`),
  ).toHaveJSProperty("disabled", false);
  await picker.selectOption(`${codex.id}::second-model`);
  await picker.selectOption(`${codex.id}::synthetic-model`);
  await expect(page.getByTestId("turn-state")).toHaveText(
    "Enter 发送，Shift + Enter 换行",
  );
  await page
    .getByRole("textbox", { name: "输入草稿" })
    .fill("multi-model synthetic request");
  await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(async () =>
      (await nativeSnapshot()).events.some(
        (e) => e.kind === "submitted" && e.payload.turnId,
      ),
    )
    .toBe(true);
  await expect
    .poll(async () => (await nativeSnapshot()).activeTurns.length)
    .toBe(0);
  const sent = (await nativeSnapshot()).events.find(
    (e) => e.kind === "submitted" && e.payload.turnId,
  );
  expect(sent?.connection?.model).toBe("synthetic-model");
  expect(sent?.connection?.codex?.fingerprint).toBe(
    codex.models[0].codex?.fingerprint,
  );
  await page.screenshot({ path: info.outputPath("model-picker.png") });
});

test("codex: local providers have independent detail pages and no inline configuration on the overview", async ({}, info) => {
  await page.getByRole("button", { name: "‹ 全部提供方", exact: true }).click();
  await expect(page.getByRole("region", { name: "Codex 连接" })).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Codex 安装路径" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "打开提供方 Codex", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "打开提供方 Claude Code", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "提供方 Claude Code", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Claude Code 连接", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Claude Code 安装路径", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Codex 连接" })).toHaveCount(0);
  await page.getByRole("button", { name: "‹ 全部提供方", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
  );
  await page.screenshot({ path: info.outputPath("provider-overview.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "打开提供方 Codex", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Codex 安装路径" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Codex 连接" })
      .getByText("ChatGPT 登录", { exact: true }),
  ).toBeVisible();
  expect(readFileSync(fixture.calls, "utf8")).not.toContain("turn/start");
});

test("codex: enabling a model with a changed authentication source requires confirmation and cancellation preserves configured models", async () => {
  await configureNative();
  await providersPage(page);
  fixture.update({
    authentication: "apiKey",
    models: ["synthetic-model", "other-account-model"],
  });
  const section = page.getByRole("region", { name: "Codex 连接" });
  await section
    .getByRole("button", { name: "刷新模型列表", exact: true })
    .click();
  await section
    .getByRole("checkbox", {
      name: "启用模型 other-account-model",
      exact: true,
    })
    .click();
  const consent = page.getByRole("region", { name: "确认 Codex 连接" });
  await expect(consent).toBeVisible();
  expect(
    (await nativeSnapshot()).connections
      .find((c) => c.provider === "codex")!
      .models.map((m) => m.model),
  ).toEqual(["synthetic-model"]);
  await consent.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    section.getByRole("checkbox", {
      name: "启用模型 other-account-model",
      exact: true,
    }),
  ).not.toBeChecked();
  expect((await nativeSnapshot()).turns).toHaveLength(0);
  const turns = readFileSync(fixture.calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((call) => call.method === "turn/start");
  expect(
    turns.every(
      (call) =>
        call.params.input[0].text ===
        "Synthetic local runtime capability check.",
    ),
  ).toBe(true);
});

test("codex: models without the optional clock remain usable while extra or missing required tools are rejected", async () => {
  const required = ["read_selected_material", "skills__list", "skills__read"];
  fixture.update({ runtimeTools: required });
  await configureNative();
  await providersPage(page);
  const section = page.getByRole("region", { name: "Codex 连接" });
  for (const runtimeTools of [
    [...required, "exec_command"],
    ["skills__list", "skills__read"],
  ]) {
    fixture.update({
      runtimeTools,
      models: ["synthetic-model", "rejected-model"],
    });
    await section
      .getByRole("button", { name: "刷新模型列表", exact: true })
      .click();
    await section
      .getByRole("checkbox", { name: "启用模型 rejected-model", exact: true })
      .click();
    await expect(section.getByRole("alert")).toContainText(
      "运行环境未通过工具限制验证",
    );
    await expect(
      section.getByRole("checkbox", {
        name: "启用模型 rejected-model",
        exact: true,
      }),
    ).not.toBeChecked();
    expect(
      (await nativeSnapshot()).connections
        .find((c) => c.provider === "codex")!
        .models.map((m) => m.model),
    ).toEqual(["synthetic-model"]);
  }
  expect((await nativeSnapshot()).turns).toHaveLength(0);
});

test("codex: direct function models preserve controlled reads and reject extra advertised execution tools", async () => {
  fixture.update({ runtimeStyle: "functions" });
  await configureNative();
  await providersPage(page);
  const section = page.getByRole("region", { name: "Codex 连接" });
  fixture.update({
    runtimeTools: ["read_selected_material", "exec_command"],
    models: ["synthetic-model", "rejected-model"],
  });
  await section
    .getByRole("button", { name: "刷新模型列表", exact: true })
    .click();
  await section
    .getByRole("checkbox", { name: "启用模型 rejected-model", exact: true })
    .click();
  await expect(section.getByRole("alert")).toContainText(
    "运行环境未通过工具限制验证",
  );
  expect(
    (await nativeSnapshot()).connections
      .find((c) => c.provider === "codex")!
      .models.map((m) => m.model),
  ).toEqual(["synthetic-model"]);
  expect((await nativeSnapshot()).turns).toHaveLength(0);
});

test("codex: setup confirmation and failure stay in view after checking from a scrolled page", async ({}, info) => {
  fixture.update({
    models: Array.from({ length: 7 }, (_, i) => `synthetic-${i}`),
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
  );
  const section = page.getByRole("region", { name: "Codex 连接", exact: true });
  await section
    .getByRole("button", { name: "重新检测 Codex", exact: true })
    .click();
  const configure = section.getByRole("button", {
    name: "配置 Codex",
    exact: true,
  });
  await configure.click();
  const setup = page.getByRole("region", {
    name: "确认 Codex 连接",
    exact: true,
  });
  await expect(setup).toBeVisible();
  await expect(configure).toBeEnabled();
  await page.screenshot({ path: info.outputPath("setup-after-check.png") });
  await expect(setup).toBeInViewport();
  await expect(setup).toBeFocused();
  await setup.getByRole("button", { name: "取消", exact: true }).click();
  fixture.update({ runtimeTools: ["exec_command"] });
  await configure.click();
  const error = section.getByRole("alert");
  await expect(error).toContainText("工具限制验证");
  await expect(error).toBeInViewport();
  await expect(error).toBeFocused();
  await expect(configure).toBeEnabled();
  await page.screenshot({ path: info.outputPath("setup-error.png") });
  expect(
    (await nativeSnapshot()).connections.some((c) => c.provider === "codex"),
  ).toBe(false);
});

test("codex: native image probe and unknown image submission preserve the selected model and full image bytes", async ({}, info) => {
  const section = page.getByRole("region", { name: "Codex 连接" });
  await section
    .getByRole("button", { name: "配置 Codex", exact: true })
    .click();
  await section
    .getByRole("button", { name: "确认配置 Codex", exact: true })
    .click();
  await section
    .getByRole("button", { name: "设为默认模型", exact: true })
    .click();
  const before = readFileSync(fixture.calls, "utf8");
  expect(
    before
      .trim()
      .split("\n")
      .map((v) => JSON.parse(v))
      .filter(
        (v) =>
          v.method === "turn/start" &&
          v.params.input.some((i: { type: string }) => i.type === "image"),
      ),
  ).toHaveLength(0);
  await goTo(page, "聊天");
  await page
    .locator(".home-header")
    .getByRole("button", { name: "新建对话", exact: true })
    .click();
  const bytes = Buffer.concat([pngSample(), Buffer.alloc(1_500_000)]),
    path = join(root, "large.png");
  writeFileSync(path, bytes);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog;
  }, path);
  await page.getByRole("button", { name: "添加资料", exact: true }).click();
  await page.getByRole("textbox", { name: "输入草稿" }).fill("描述图片");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page
      .getByRole("article", { name: "助手消息" })
      .getByText("红色", { exact: true }),
  ).toBeVisible();
  const turns = readFileSync(fixture.calls, "utf8")
    .trim()
    .split("\n")
    .map((v) => JSON.parse(v))
    .filter(
      (v) =>
        v.method === "turn/start" &&
        v.params.input.some((i: { type: string }) => i.type === "image"),
    );
  expect(turns).toHaveLength(1);
  const image = turns[0].params.input.find(
    (v: { type: string }) => v.type === "image",
  );
  expect(Buffer.from(image.url.split(",")[1], "base64").equals(bytes)).toBe(
    true,
  );
  await openProvider(page, "Codex");
  const capability = section.getByRole("group", {
    name: "图片能力 synthetic-model",
    exact: true,
  });
  await expect(capability).toContainText("未检测");
  await capability
    .getByRole("button", { name: "检测图片能力", exact: true })
    .click();
  await expect(capability.getByRole("status")).toContainText("成功");
  await expect(capability).toContainText("支持（已实测）");
  await page.screenshot({
    path: info.outputPath("codex-image-capability.png"),
  });
});
