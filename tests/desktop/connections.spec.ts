import { closeLocal, launchLocal } from "./local-client";
import { goTo } from "./shell";
import { addProvider, openProvider, providersPage } from "./provider-ui";
import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";

let app: ElectronApplication;
let page: Page;
let dataRoot: string;
let mock: Server;
let mockRequests = 0;
const secret = "test-secret-7f3a-not-a-real-key";

async function launch(root = dataRoot) {
  const application = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "false" },
  });
  const window = await application.firstWindow();
  await expect(
    window
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
  return { application, window };
}
function vaultKeys() {
  const file = resolve(`${dataRoot}-vault/vault.json`);
  if (!existsSync(file)) return [];
  return Object.keys(JSON.parse(readFileSync(file, "utf8")).secrets);
}
function businessBytes() {
  return ["", "-wal"]
    .map((suffix) => resolve(dataRoot, `state.sqlite${suffix}`))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file));
}
const seen: { path: string; authorization?: string }[] = [];
test.beforeAll(async () => {
  // Behaviour is selected by the Base URL path prefix so one server covers every classification.
  mock = createServer((request, response) => {
    mockRequests += 1;
    seen.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
    });
    const route = (request.url ?? "").split("/")[1];
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (route === "ok") {
      if (request.url?.endsWith("/models"))
        return json(200, { data: [{ id: "mock-alpha" }, { id: "mock-beta" }] });
      return json(200, { choices: [{ message: { content: "pong" } }] });
    }
    if (route === "auth") return json(401, { error: { message: "bad key" } });
    if (route === "rate") return json(429, { error: "slow down" });
    if (route === "model")
      return json(404, { error: { message: "model not found" } });
    if (route === "server") return json(503, { error: "down" });
    if (route === "reset") return request.socket.destroy();
    if (route === "html") {
      response.writeHead(200, { "content-type": "text/html" });
      return response.end("<html></html>");
    }
    if (route === "hang") return;
    json(200, {});
  });
  await new Promise<void>((done) => mock.listen(0, "127.0.0.1", done));
});
test.afterAll(async () => {
  mock.closeAllConnections();
  await new Promise<void>((done) => mock.close(() => done()));
});
test.beforeEach(async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  dataRoot = mkdtempSync(resolve(".test-data/disposable/connections-"));
  mockRequests = 0;
  seen.length = 0;
  const started = await launch();
  app = started.application;
  page = started.window;
});
test.afterEach(async () => {
  if (app) await app.close();
});

test("connections: presets and a custom loopback address save without any request, secrets stay out of business data, restart reads back, delete clears the vault", async () => {
  const external: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("file:")) external.push(r.url());
  });
  const port = (mock.address() as AddressInfo).port;
  const item = await addProvider(page, {
    name: "本地模拟",
    url: `http://127.0.0.1:${port}/v1`,
    model: "test-model",
    secret,
  });
  await expect(item.getByText("已保存", { exact: true })).toBeVisible();
  expect(await page.content()).not.toContain(secret);
  await providersPage(page);
  for (const [label, address] of [
    ["DeepSeek", "https://api.deepseek.com"],
    ["OpenRouter", "https://openrouter.ai/api/v1"],
    ["SiliconFlow", "https://api.siliconflow.cn/v1"],
    ["智谱 GLM", "https://open.bigmodel.cn/api/paas/v4/"],
  ]) {
    await page.locator(".provider-row").filter({ hasText: label }).click();
    const form = page.getByRole("form", { name: "新建提供方" });
    await expect(form.getByLabel("Endpoint")).toHaveValue(address);
    if (label === "智谱 GLM")
      await form
        .getByLabel("Endpoint")
        .fill("https://api.siliconflow.cn/custom");
    await form.getByRole("button", { name: "保存提供方" }).click();
    await expect(
      page.getByRole("article", { name: `提供方 ${label}`, exact: true }),
    ).toBeVisible();
    await providersPage(page);
  }
  await page.getByRole("button", { name: "添加自定义提供方" }).click();
  const form = page.getByRole("form", { name: "新建提供方" });
  await form.getByLabel("名称", { exact: true }).fill("非法地址");
  await form.getByLabel("Endpoint").fill("http://example.com/v1");
  await form.getByRole("button", { name: "保存提供方" }).click();
  await expect(form.getByRole("alert")).toContainText("仅本机 127.0.0.1");
  await expect(form.getByLabel("Endpoint")).toHaveValue(
    "http://example.com/v1",
  );
  await form.getByLabel("Endpoint").fill("https://user:pw@api.example.com/v1");
  await form.getByRole("button", { name: "保存提供方" }).click();
  await expect(form.getByRole("alert")).toContainText("不能包含账号或密码");
  await page.screenshot({ path: "test-results/connections-form.png" });
  await form.getByRole("button", { name: "取消" }).click();
  // Four API presets, the saved custom provider, and two local provider entries.
  await expect(page.locator(".provider-row")).toHaveCount(7);
  await page.screenshot({ path: "test-results/connections-settings.png" });
  expect(vaultKeys()).toHaveLength(1);
  expect(
    readFileSync(resolve(`${dataRoot}-vault/vault.json`)).includes(
      Buffer.from(secret),
    ),
  ).toBe(false);
  for (const bytes of businessBytes())
    expect(bytes.includes(Buffer.from(secret))).toBe(false);
  expect(
    businessBytes().some((b) => b.includes(Buffer.from("test-model"))),
  ).toBe(true);
  await closeLocal(app);
  const restart = await launch();
  app = restart.application;
  page = restart.window;
  const zhipu = await openProvider(page, "智谱 GLM");
  await expect(
    zhipu.getByText("https://api.siliconflow.cn/custom"),
  ).toBeVisible();
  const custom = await openProvider(page, "本地模拟");
  await expect(custom.getByLabel("API key", { exact: true })).toHaveValue("");
  const before = vaultKeys();
  await custom.getByLabel("模型 ID", { exact: true }).fill("test-model-2");
  await custom.getByRole("button", { name: "添加模型", exact: true }).click();
  await expect(
    custom.getByRole("group", { name: "模型 test-model-2", exact: true }),
  ).toBeVisible();
  expect(vaultKeys()).toEqual(before);
  await custom
    .getByLabel("API key", { exact: true })
    .fill(`${secret}-replaced`);
  await custom.getByRole("button", { name: "保存密钥" }).click();
  await expect(custom.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect.poll(() => vaultKeys().length).toBe(1);
  expect(vaultKeys()).not.toEqual(before);
  await custom.getByRole("button", { name: "删除提供方…" }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(custom).toHaveCount(0);
  await expect.poll(() => vaultKeys().length).toBe(0);
  expect(mockRequests).toBe(0);
  expect(external).toEqual([]);
});

test("default connection: requires a hand-filled model, shows in the composer, survives restart and blocks deletion", async () => {
  const port = (mock.address() as AddressInfo).port;
  const without = await addProvider(page, {
    name: "无模型连接",
    url: `http://127.0.0.1:${port}/ok/v1`,
  });
  await expect(
    without.getByRole("button", { name: "测试模型", exact: true }),
  ).toHaveCount(0);
  await expect(
    without.getByRole("button", { name: "从厂商列表添加" }),
  ).toBeDisabled();
  const withModel = await addProvider(page, {
    name: "有模型连接",
    url: `http://127.0.0.1:${port}/ok/v1`,
    model: "deepseek-chat",
  });
  await expect(
    withModel.getByRole("button", { name: "设为默认", exact: true }),
  ).toBeDisabled();
  await withModel.getByLabel("API key", { exact: true }).fill(secret);
  await withModel.getByRole("button", { name: "保存密钥" }).click();
  await expect(withModel.getByLabel("API key", { exact: true })).toHaveValue(
    "",
  );
  await withModel
    .getByRole("button", { name: "设为默认", exact: true })
    .click();
  await expect(withModel.getByText("默认", { exact: true })).toBeVisible();
  const row = withModel.getByRole("group", {
    name: "模型 deepseek-chat",
    exact: true,
  });
  await expect(row.getByRole("checkbox")).toBeDisabled();
  await expect(
    row.getByRole("button", { name: "移除", exact: true }),
  ).toBeDisabled();
  await goTo(page, "聊天");
  await expect(page.getByRole("combobox", { name: "本次连接" })).toContainText(
    "默认：有模型连接 · deepseek-chat",
  );
  await page.screenshot({ path: "test-results/default-connection.png" });
  await closeLocal(app);
  const restart = await launch();
  app = restart.application;
  page = restart.window;
  await expect(page.getByRole("combobox", { name: "本次连接" })).toContainText(
    "默认：有模型连接 · deepseek-chat",
  );
  const reopened = await openProvider(page, "有模型连接");
  await reopened.getByRole("button", { name: "删除提供方…" }).click();
  await expect(
    page.getByRole("button", { name: "确认删除", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await reopened.getByRole("button", { name: "取消默认模型" }).click();
  await expect(reopened.getByText("默认", { exact: true })).toHaveCount(0);
  await goTo(page, "聊天");
  await expect(page.getByRole("combobox", { name: "本次连接" })).toContainText(
    "默认连接未选择",
  );
  expect(mockRequests).toBe(0);
});

test("connection checks: explicit test and model list bind executions, classify failures, keep the hand-filled model and can be cancelled", async () => {
  const port = (mock.address() as AddressInfo).port;
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const freed = (probe.address() as AddressInfo).port;
  await new Promise<void>((done) => probe.close(() => done()));
  for (const [name, route] of [
    ["正常", "ok"],
    ["认证失败", "auth"],
    ["协议错误", "html"],
    ["限流", "rate"],
    ["模型不存在", "model"],
    ["提供方拒绝", "server"],
    ["网络中断", "reset"],
    ["挂起", "hang"],
  ])
    await addProvider(page, {
      name,
      url: `http://127.0.0.1:${port}/${route}/v1`,
      model: "hand-filled",
      secret,
    });
  await addProvider(page, {
    name: "地址不可达",
    url: `http://127.0.0.1:${freed}/v1`,
    model: "hand-filled",
    secret,
  });
  const noKey = await addProvider(page, {
    name: "无密钥",
    url: `http://127.0.0.1:${port}/ok/v1`,
    model: "hand-filled",
  });
  await expect(
    noKey.getByRole("button", { name: "测试模型", exact: true }),
  ).toBeDisabled();
  await expect(
    noKey.getByRole("button", { name: "从厂商列表添加" }),
  ).toBeDisabled();
  const noModel = await addProvider(page, {
    name: "无模型",
    url: `http://127.0.0.1:${port}/ok/v1`,
    secret,
  });
  await expect(
    noModel.getByRole("button", { name: "测试模型", exact: true }),
  ).toHaveCount(0);
  await expect(
    noModel.getByRole("button", { name: "从厂商列表添加" }),
  ).toBeEnabled();
  expect(mockRequests).toBe(0);
  const ok = await openProvider(page, "正常");
  await expect(ok.getByText("文本调用：未测试")).toBeVisible();
  await ok.getByRole("button", { name: "测试模型", exact: true }).click();
  await expect(ok.getByText(/文本调用：成功/)).toBeVisible();
  await ok.getByRole("button", { name: "从厂商列表添加" }).click();
  await expect(
    ok
      .getByRole("group", { name: "厂商模型列表" })
      .getByText("mock-alpha", { exact: true }),
  ).toBeVisible();
  await expect(
    ok.getByRole("group", { name: "模型 hand-filled", exact: true }),
  ).toBeVisible();
  const auth = await openProvider(page, "认证失败");
  await auth.getByRole("button", { name: "测试模型", exact: true }).click();
  await expect(
    auth.getByText(/文本调用：失败.*HTTP 401.*认证失败/),
  ).toBeVisible();
  await auth.getByRole("button", { name: "从厂商列表添加" }).click();
  await expect(auth.getByText(/模型列表获取失败：HTTP 401/)).toBeVisible();
  await expect(
    auth.getByRole("group", { name: "模型 hand-filled", exact: true }),
  ).toBeVisible();
  for (const [name, pattern] of [
    ["协议错误", /不是 JSON/],
    ["限流", /HTTP 429.*请求限流/],
    ["模型不存在", /HTTP 404.*模型不存在.*model not found/],
    ["提供方拒绝", /HTTP 503.*提供方拒绝/],
    ["网络中断", /网络错误/],
    ["地址不可达", /无法连接到该地址/],
  ] as const) {
    const item = await openProvider(page, name);
    await item.getByRole("button", { name: "测试模型", exact: true }).click();
    await expect(item.locator('[data-testid^="test-"]')).toContainText(pattern);
    await expect(
      item.getByRole("group", { name: "模型 hand-filled", exact: true }),
    ).toBeVisible();
  }
  const hang = await openProvider(page, "挂起");
  await hang.getByRole("button", { name: "测试模型", exact: true }).click();
  await expect(
    hang.getByText(/文本调用：生成中|文本调用：等待执行/),
  ).toBeVisible();
  await hang.getByRole("button", { name: "取消测试" }).click();
  await expect(hang.getByText(/文本调用：已停止/)).toBeVisible();
  await page.screenshot({ path: "test-results/connection-checks.png" });
  expect(seen.length).toBeGreaterThanOrEqual(10);
  expect(seen.filter((r) => r.authorization !== `Bearer ${secret}`)).toEqual(
    [],
  );
  expect(new Set(seen.map((r) => r.path))).toEqual(
    new Set([
      "/ok/v1/chat/completions",
      "/ok/v1/models",
      "/auth/v1/chat/completions",
      "/auth/v1/models",
      "/html/v1/chat/completions",
      "/rate/v1/chat/completions",
      "/model/v1/chat/completions",
      "/server/v1/chat/completions",
      "/reset/v1/chat/completions",
      "/hang/v1/chat/completions",
    ]),
  );
  expect(await page.content()).not.toContain(secret);
  const kinds = await page.evaluate(async () => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    return r.snapshot.events.map((e) => e.kind);
  });
  expect(kinds.filter((k) => k === "submitted")).toHaveLength(11);
  expect(kinds).toContain("stop_requested");
  expect(kinds).toContain("stopped");
  expect(kinds.filter((k) => k === "completed")).toHaveLength(2);
  expect(kinds.filter((k) => k === "failed")).toHaveLength(8);
});

test("provider input: repeated immediate submits preserve the exact name and Endpoint across snapshots and restart", async () => {
  const values = [];
  for (let i = 0; i < 12; i++) {
    const name = `完整名称-末字${i}`,
      url = `http://127.0.0.1:12345/path-${i}/v1`;
    await providersPage(page);
    await page
      .getByRole("button", { name: "添加自定义提供方", exact: true })
      .click();
    const form = page.getByRole("form", { name: "新建提供方" });
    await form.getByLabel("名称", { exact: true }).fill(name);
    await form.getByLabel("Endpoint", { exact: true }).fill(url);
    await form.getByRole("button", { name: "保存提供方", exact: true }).click();
    const item = page.getByRole("article", {
      name: `提供方 ${name}`,
      exact: true,
    });
    await expect(item).toBeVisible();
    await expect(item.getByText(url, { exact: true })).toBeVisible();
    values.push({ name, baseUrl: url });
  }
  await closeLocal(app);
  const restart = await launch();
  app = restart.application;
  page = restart.window;
  const saved = await page.evaluate(async () => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    return r.snapshot.connections.map((c) => ({
      name: c.name,
      baseUrl: c.baseUrl,
    }));
  });
  expect(saved).toEqual(values);
  expect(mockRequests).toBe(0);
});

test("connections: every preset and custom provider shows an accessible status dot beside its name", async ({}, info) => {
  await providersPage(page);
  await expect(page.locator(".provider-name .provider-indicator")).toHaveCount(
    6,
  );
  await expect(
    page.locator('.provider-indicator[data-state="inactive"]'),
  ).toHaveCount(6);
  const port = (mock.address() as AddressInfo).port;
  await addProvider(page, {
    provider: "deepseek",
    name: "DeepSeek",
    url: `http://127.0.0.1:${port}/ok`,
    model: "test-model",
    secret,
  });
  await addProvider(page, {
    name: "自定义连接",
    url: `http://127.0.0.1:${port}/auth`,
    model: "test-model",
    secret,
  });
  await providersPage(page);
  const row = (name: string) =>
    page.getByRole("button", { name: `打开提供方 ${name}`, exact: true });
  await expect(page.locator(".provider-name .provider-indicator")).toHaveCount(
    7,
  );
  await expect(row("DeepSeek").getByRole("img")).toHaveAttribute(
    "data-state",
    "available",
  );
  await expect(row("自定义连接").getByRole("img")).toHaveAttribute(
    "data-state",
    "available",
  );
  expect(mockRequests).toBe(0);
  const result = await page.evaluate(async () => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    const c = r.snapshot.connections.find((c) => c.name === "自定义连接")!;
    return window.desktop.runConnectionCheck(
      "connection_test",
      c.id,
      "test-model",
    );
  });
  expect(result.ok).toBe(true);
  await expect(row("自定义连接").getByRole("img")).toHaveAttribute(
    "data-state",
    "error",
  );
  await expect(row("自定义连接").getByRole("img")).toHaveAttribute(
    "title",
    /认证|密钥/,
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1180, 1000),
  );
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (appearance) => {
      await window.desktop.command({ type: "setAppearance", appearance });
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const geometry = await row("DeepSeek")
      .locator(".provider-name")
      .evaluate((element) => {
        const name = element.querySelector("strong")!.getBoundingClientRect();
        const dot = element
          .querySelector(".provider-indicator")!
          .getBoundingClientRect();
        return {
          width: dot.width,
          height: dot.height,
          gap: dot.left - name.right,
          center: Math.abs(
            dot.top + dot.height / 2 - (name.top + name.height / 2),
          ),
        };
      });
    expect(geometry).toMatchObject({ width: 8, height: 8, gap: 8 });
    // Chromium rounds fractional line boxes to layout subpixels.
    expect(geometry.center).toBeLessThan(0.01);
    await page.screenshot({
      path: info.outputPath(`provider-indicators-${theme}.png`),
    });
  }
  const toggle = page.getByLabel("启用提供方 自定义连接", { exact: true });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(row("自定义连接").getByRole("img")).toHaveAttribute(
    "data-state",
    "inactive",
  );
  expect(mockRequests).toBe(1);
});
