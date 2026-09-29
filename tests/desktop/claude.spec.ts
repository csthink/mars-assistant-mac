import { pngSample } from "./samples";
import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { closeLocal, launchLocal } from "./local-client";
import { goTo } from "./shell";
import { stopClaudeTestTurns } from "./claude-test-cleanup";
import { openProvider, providersPage } from "./provider-ui";
import { createClaudeFixture } from "./claude-fixture";
let app: ElectronApplication,
  page: Page,
  fixture: ReturnType<typeof createClaudeFixture>,
  data: string,
  root: string;
async function start() {
  app = await launchLocal({
    args: [resolve("."), `--data-root=${data}`],
    cwd: resolve("."),
    env: { ...process.env, HOME: root, PATH: `${fixture.bin}:/usr/bin:/bin` },
  });
  page = await app.firstWindow();
  await expect(
    page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
  await openProvider(page, "Claude Code");
}
test.beforeEach(async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  root = mkdtempSync(resolve(".test-data/disposable/claude-"));
  fixture = createClaudeFixture(join(root, "cli"));
  data = join(root, "data");
  mkdirSync(data);
  await start();
});
test.afterEach(async () => {
  if (app) await app.close();
});
test("claude: detection and compatible upgrades share the Codex settings layout without making model calls", async ({}, info) => {
  const section = page.getByRole("region", {
    name: "Claude Code 连接",
    exact: true,
  });
  await expect(
    section.getByText("Claude 订阅登录", { exact: true }),
  ).toBeVisible();
  await expect(section.getByText("未测试", { exact: true })).toBeVisible();
  await section.getByText("连接详情", { exact: true }).click();
  await expect(section.getByText("2.1.263", { exact: true })).toBeVisible();
  fixture.update({ version: "99.0.0-preview", model: "claude-new[1m]" });
  await section
    .getByRole("button", { name: "重新检测 Claude Code", exact: true })
    .click();
  await expect(
    section.getByText("99.0.0-preview", { exact: true }),
  ).toBeVisible();
  await expect(
    section
      .locator(".codex-facts")
      .getByText("claude-new[1m]", { exact: true }),
  ).toBeVisible();
  await expect(section.getByRole("alert")).toHaveCount(0);
  await section
    .getByLabel("搜索 Claude Code 模型", { exact: true })
    .fill("other");
  await expect(
    section
      .getByRole("region", { name: "Claude Code 模型列表" })
      .getByText("claude-new[1m]", { exact: true }),
  ).toHaveCount(0);
  await expect(
    section.getByText("claude-other", { exact: true }),
  ).toBeVisible();
  const calls = readFileSync(fixture.calls, "utf8");
  expect(calls).not.toContain('"type":"user"');
  expect(await page.content()).not.toContain("private@");
  expect(await page.content()).not.toContain("SYNTHETIC_SECRET");
  await section.getByText("连接详情", { exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
  );
  await section.locator(".setting-row").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("claude-settings.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("claude: path failure never falls back and the integration switch survives restart", async () => {
  const section = page.getByRole("region", {
    name: "Claude Code 连接",
    exact: true,
  });
  await expect(
    section.getByText("Claude 订阅登录", { exact: true }),
  ).toBeVisible();
  await section
    .getByLabel("Claude Code 安装路径", { exact: true })
    .fill(join(root, "missing"));
  await section
    .getByRole("button", { name: "保存安装路径", exact: true })
    .click();
  await expect(
    section.getByText(
      "指定的 Claude Code 路径不可用，请修改路径或重置为系统识别。",
      { exact: true },
    ),
  ).toBeVisible();
  await section
    .getByRole("button", { name: "重置为系统识别", exact: true })
    .click();
  await expect(
    section.getByText("Claude 订阅登录", { exact: true }),
  ).toBeVisible();
  await section.getByLabel("启用 Claude Code 整合", { exact: true }).click();
  await expect(
    section.getByLabel("启用 Claude Code 整合", { exact: true }),
  ).not.toBeChecked();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const reply = await window.desktop.command({ type: "snapshot" });
        return reply.ok ? reply.snapshot.settings.claude.enabled : null;
      }),
    )
    .toBe(false);
  await expect(
    section.getByRole("button", { name: "重新检测 Claude Code", exact: true }),
  ).toBeDisabled();
  const before = readFileSync(fixture.calls, "utf8");
  await closeLocal(app);
  await start();
  await expect(
    page.getByLabel("启用 Claude Code 整合", { exact: true }),
  ).not.toBeChecked();
  expect(readFileSync(fixture.calls, "utf8")).toBe(before);
});

test("claude: settings configure multiple models and a default, then chat uses only the selected native connection", async ({}, info) => {
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
  await section.getByLabel("启用模型 claude-other", { exact: true }).click();
  await expect(
    section.getByLabel("启用模型 claude-other", { exact: true }),
  ).toBeChecked();
  const row = section.getByRole("group", {
    name: "模型 claude-other",
    exact: true,
  });
  await row.getByRole("button", { name: "设为默认", exact: true }).click();
  await expect(row.getByText("默认", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "测试模型", exact: true }).click();
  await expect(section.getByText(/测试模型：.*模型测试成功/)).toBeVisible();
  await page
    .locator(".settings-content")
    .evaluate((element) => {
      element.scrollTop = 0;
    })
    .catch(() => {});
  await expect(section).not.toContainText(
    "已读取本地登录信息，尚未测试模型调用。",
  );
  await page.screenshot({ path: info.outputPath("claude-configured.png") });
  await section.locator(".setting-row").first().scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("claude-configured-header.png"),
  });
  await goTo(page, "聊天");
  await page
    .locator("#main-sidebar")
    .getByRole("button", { name: "新建聊天", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "输入草稿" })
    .fill("请回答合成测试。");
  await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByText("SYNTHETIC_RESPONSE", { exact: true }),
  ).toBeVisible();
  const state = await page.evaluate(async () => {
    const reply = await window.desktop.command({ type: "snapshot" });
    return reply.ok ? reply.snapshot : null;
  });
  expect(state?.settings.defaultModelId).toBe("claude-other");
  expect(
    state?.events.some(
      (e) => e.kind === "completed" && e.connection?.provider === "claude",
    ),
  ).toBe(true);
  expect(
    state?.connections
      .filter((c) => c.provider === "claude")[0]
      .models.filter((m) => m.enabled),
  ).toHaveLength(2);
});

async function configureNative() {
  const section = page.getByRole("region", { name: "Claude Code 连接" });
  await section
    .getByRole("button", { name: "配置 Claude Code", exact: true })
    .click();
  await page
    .getByRole("region", { name: "确认 Claude Code 连接" })
    .getByRole("button", { name: "确认配置 Claude Code", exact: true })
    .click();
  await expect(section.getByText("已配置", { exact: true })).toBeVisible();
  await section
    .getByRole("button", { name: "设为默认模型", exact: true })
    .click();
  await goTo(page, "聊天");
  await page
    .getByRole("button", { name: /^新建(聊天|对话)$/ })
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
    mode: "tools",
    attachmentId: state.draftAttachments[0].attachmentId,
  });
  await page.evaluate(async () => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    const c = r.snapshot.connections.find((c) => c.provider === "claude")!;
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
test("claude: selected material reaches the native callback only after the existing permission UI approves it", async () => {
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
test("claude: rejecting a material request does not return its text to the local Agent", async ({}, info) => {
  await requestNativeMaterial();
  await page.getByRole("button", { name: "拒绝读取", exact: true }).click();
  await expect
    .poll(async () => (await nativeSnapshot()).activeTurns.length)
    .toBe(0);
  expect(readFileSync(fixture.calls, "utf8")).not.toContain(
    "UNPREDICTABLE_SYNTHETIC_",
  );
  expect((await nativeSnapshot()).toolOperations[0].state).toBe("denied");
  await info.attach("denied-result", {
    body: JSON.stringify({ state: "denied", materialDisclosed: false }),
    contentType: "application/json",
  });
});

test("claude: stop and a failed partial turn preserve text and recover only the saved native session", async ({}, info) => {
  await configureNative();
  fixture.update({ mode: "slow" });
  await page.getByRole("textbox", { name: "输入草稿" }).fill("Synthetic stop");
  await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByText("SYNTHETIC_RESPONSE", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "停止回合", exact: true }).click();
  await expect
    .poll(async () => (await nativeSnapshot()).activeTurns.length)
    .toBe(0);
  const stopped = (await nativeSnapshot()).turns.find(
    (t) => t.state === "stopped",
  )!;
  expect(stopped).toBeTruthy();
  expect(stopped.partialText).toBe("SYNTHETIC_RESPONSE");
  await expect(
    page.getByText("SYNTHETIC_RESPONSE", { exact: true }),
  ).toBeVisible();
  await info.attach("stopped-result", {
    body: JSON.stringify(stopped),
    contentType: "application/json",
  });
  await page.screenshot({ path: info.outputPath("stopped.png") });
  await info.attach("stopped-screen", {
    path: info.outputPath("stopped.png"),
    contentType: "image/png",
  });
  fixture.update({ mode: "crash" });
  await page
    .getByRole("textbox", { name: "输入草稿" })
    .fill("Synthetic failure");
  await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await nativeSnapshot()).pendingItems.filter(
          (p) => p.kind === "failed_turn",
        ).length,
    )
    .toBe(1);
  const state = await nativeSnapshot(),
    pending = state.pendingItems.find((p) => p.kind === "failed_turn")!;
  const failed = state.turns.find((t) => t.id === pending.turnId)!;
  expect(failed.state).toBe("failed");
  expect(failed.partialText).toBe("SYNTHETIC_RESPONSE");
  const session = state.events.find(
    (e) => e.kind === "native_session" && e.executionId === failed.executionId,
  )!.payload.claude as { threadId: string; cwd: string; fingerprint: string };
  expect(session.threadId).toBeTruthy();
  await goTo(page, "待处理");
  await expect(
    page.getByRole("button", { name: "打开原对话", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("failed.png") });
  await info.attach("failed-screen", {
    path: info.outputPath("failed.png"),
    contentType: "image/png",
  });
  fixture.update({ mode: "normal", version: "100.0.0-preview" });
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect
    .poll(async () => (await nativeSnapshot()).activeTurns.length)
    .toBe(0);
  await expect
    .poll(
      async () =>
        (await nativeSnapshot()).pendingItems.filter(
          (p) => p.kind === "failed_turn",
        ).length,
    )
    .toBe(0);
  const recovered = await nativeSnapshot();
  const completed = recovered.turns.find((t) => t.id === failed.id)!;
  expect(completed.state).toBe("completed");
  expect(completed.conversationId).toBe(failed.conversationId);
  expect(completed.attempt).toBe(failed.attempt + 1);
  expect(completed.executionId).not.toBe(failed.executionId);
  const resumed = recovered.events.find(
    (e) =>
      e.kind === "native_session" && e.executionId === completed.executionId,
  )!.payload.claude as typeof session;
  expect(resumed.threadId).toBe(session.threadId);
  expect(resumed.cwd).toBe(session.cwd);
  expect(resumed.fingerprint).toBe(session.fingerprint);
  const calls = readFileSync(fixture.calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args?: string[] });
  expect(
    calls.some(
      (c) =>
        c.args?.includes("--resume") &&
        c.args[c.args.indexOf("--resume") + 1] === session.threadId,
    ),
  ).toBe(true);
  await goTo(page, "聊天");
  expect((await nativeSnapshot()).selected.main).toBe(failed.conversationId);
  await expect(
    page.getByText("Synthetic failure", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("SYNTHETIC_RESPONSE", { exact: true }).last(),
  ).toBeVisible();
  await info.attach("recovery-result", {
    body: JSON.stringify({ failed, completed, session, resumed }),
    contentType: "application/json",
  });
  await page.screenshot({ path: info.outputPath("recovered.png") });
  await info.attach("recovered-screen", {
    path: info.outputPath("recovered.png"),
    contentType: "image/png",
  });
});

test("claude: provider refusal is distinct from login failure and keeps partial output", async ({}, info) => {
  await configureNative();
  fixture.update({ mode: "refusal" });
  await page
    .getByRole("textbox", { name: "输入草稿" })
    .fill("Synthetic refusal");
  await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByText(/模型服务拒绝了本次请求（reasoning_extraction）/).first(),
  ).toBeVisible();
  await expect(page.getByRole("article", { name: "助手回合" })).toContainText(
    "SYNTHETIC_RESPONSE",
  );
  await expect(page.locator("body")).not.toContainText(
    "SYNTHETIC_PRIVATE_DIAGNOSTIC",
  );
  expect(
    (await nativeSnapshot()).events.some(
      (e) => e.kind === "failed" && e.payload.errorClass === "provider",
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("claude-provider-refusal.png"),
  });
});

test("claude: test cleanup confirms a running native turn stops before app exit", async () => {
  await configureNative();
  fixture.update({ mode: "slow" });
  await page
    .getByRole("textbox", { name: "输入草稿" })
    .fill("Synthetic cleanup");
  await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByText("SYNTHETIC_RESPONSE", { exact: true }),
  ).toBeVisible();
  const stopped = await stopClaudeTestTurns(app, data);
  expect(stopped).toHaveLength(1);
  const snapshot = await nativeSnapshot();
  expect(snapshot.activeTurns).toHaveLength(0);
  expect(
    snapshot.events.some(
      (event) => event.executionId === stopped[0] && event.kind === "stopped",
    ),
  ).toBe(true);
  expect(readFileSync(fixture.calls, "utf8")).toContain(
    '"subtype":"interrupt"',
  );
});

test("claude: provider indicator follows local login and disabled state without model calls", async () => {
  await configureNative();
  // Configuration runs the isolated synthetic contract; count only list inspection below.
  const setupBytes = readFileSync(fixture.calls, "utf8").length;
  await providersPage(page);
  const dot = page
    .getByRole("button", { name: "打开提供方 Claude Code", exact: true })
    .getByRole("img");
  await expect(dot).toHaveAttribute("data-state", "available");
  fixture.update({ authentication: "signedOut" });
  await goTo(page, "聊天");
  await providersPage(page);
  await expect(dot).toHaveAttribute("data-state", "error");
  await expect(dot).toHaveAttribute("title", /登录/);
  fixture.update({ authentication: "subscription" });
  await goTo(page, "聊天");
  await providersPage(page);
  await expect(dot).toHaveAttribute("data-state", "available");
  const reply = await page.evaluate(async () => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    return window.desktop.command({
      type: "setClaudeSettings",
      enabled: false,
      path: null,
      revision: r.snapshot.settings.claude.revision,
    });
  });
  expect(reply.ok).toBe(true);
  await expect(dot).toHaveAttribute("data-state", "inactive");
  expect(readFileSync(fixture.calls, "utf8").slice(setupBytes)).not.toContain(
    '"type":"user"',
  );
});

test("claude: unknown images send intact, native probes stay model-specific and quota errors identify the tested model", async ({}, info) => {
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
  await section
    .getByRole("button", { name: "设为默认模型", exact: true })
    .click();
  await goTo(page, "聊天");
  await page
    .locator("#main-sidebar")
    .getByRole("button", { name: "新建聊天", exact: true })
    .click();
  const bytes = Buffer.concat([pngSample(), Buffer.alloc(1_500_000)]);
  const path = join(root, "large.png");
  writeFileSync(path, bytes);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog;
  }, path);
  await page.getByRole("button", { name: "添加资料", exact: true }).click();
  const input = page.getByRole("textbox", { name: "输入草稿" });
  await input.fill("描述这张图片");
  await input.press("Enter");
  await expect(
    page
      .getByRole("article", { name: "助手消息" })
      .getByText("红色", { exact: true }),
  ).toBeVisible();
  const calls = readFileSync(fixture.calls, "utf8")
    .trim()
    .split("\n")
    .map((v) => JSON.parse(v));
  const images = calls
    .filter((v) => v.type === "user")
    .flatMap((v) => v.message.content)
    .filter((v: { type: string }) => v.type === "image");
  expect(images).toHaveLength(1);
  expect(Buffer.from(images[0].source.data, "base64").equals(bytes)).toBe(true);
  await openProvider(page, "Claude Code");
  await section.getByLabel("启用模型 claude-other", { exact: true }).click();
  await section
    .getByLabel("已配置的 Claude Code 模型", { exact: true })
    .selectOption("claude-other");
  const capability = section.getByRole("group", {
    name: "图片能力 claude-other",
    exact: true,
  });
  await capability
    .getByRole("button", { name: "检测图片能力", exact: true })
    .click();
  await expect(capability.getByRole("status")).toContainText("成功");
  const capabilities = await page.evaluate(async () => {
    const r = await window.desktop.command({ type: "snapshot" });
    return r.ok
      ? r.snapshot.connections
          .find((c) => c.provider === "claude")
          ?.models.map((m) => [m.model, m.imageInput])
      : [];
  });
  expect(capabilities).toContainEqual(["claude-other", "verified"]);
  expect(capabilities).toContainEqual(["claude-synthetic[1m]", "unknown"]);
  fixture.update({
    mode: "apiError",
    errorCode: "rate_limit",
    errorText: "You've reached your Fable limit. SYNTHETIC_PRIVATE_DIAGNOSTIC",
  });
  await section.getByRole("button", { name: "模型测试", exact: true }).click();
  await expect(
    section.getByText(/测试模型：claude-other.*模型测试失败/),
  ).toContainText("用量已达上限");
  await expect(
    section.getByText(/测试模型：claude-other.*模型测试失败/),
  ).not.toContainText("已保留");
  expect(await page.content()).not.toContain("SYNTHETIC_PRIVATE_DIAGNOSTIC");
  await page.screenshot({
    path: info.outputPath("image-capability-and-quota.png"),
  });
});
