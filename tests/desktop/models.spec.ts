import { launchLocal } from "./local-client";
import { goTo } from "./shell";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { addProvider, openProvider } from "./provider-ui";

test("models: fetched and manual models coexist; probes and budgets stay per model; switches use fixed snapshots and a changed destination needs confirmation", async ({}, info) => {
  const requests: { path: string; model?: string; stream?: boolean }[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => {
      text += String(chunk);
    });
    request.on("end", () => {
      const body = text ? JSON.parse(text) : {};
      requests.push({
        path: request.url!,
        model: body.model,
        stream: body.stream,
      });
      if (request.url?.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }),
        );
      } else if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: `回答来自 ${body.model}` } }] })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        response.writeHead(body.model === "beta" ? 400 : 200, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify(
            body.model === "beta"
              ? {
                  error: { message: "image input not supported by this model" },
                }
              : { choices: [{ message: { content: "red" } }] },
          ),
        );
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/models-"));
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator(".home-header")
        .getByRole("button", { name: "新建对话", exact: true }),
    ).toBeEnabled();
    const snapshot = () =>
      page.evaluate(async () => {
        const r = await window.desktop.command({ type: "snapshot" });
        if (!r.ok) throw new Error(r.message);
        return r.snapshot;
      });
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/one/v1`;
    const detail = await addProvider(page, {
      name: "多模型提供方",
      url: endpoint,
      model: "manual",
      secret: "synthetic-model-key",
      makeDefault: true,
    });
    await detail
      .getByRole("button", { name: "从厂商列表添加", exact: true })
      .click();
    const picker = detail.getByRole("group", {
      name: "厂商模型列表",
      exact: true,
    });
    const search = picker.getByRole("searchbox", {
      name: "搜索模型",
      exact: true,
    });
    await expect(search).toBeVisible();
    const fetchedRequests = requests.length;
    await search.fill(" ALP ");
    await expect(picker.getByRole("checkbox")).toHaveCount(1);
    await picker.getByRole("checkbox", { name: "alpha", exact: true }).check();
    await search.fill("BETA");
    await picker.getByRole("checkbox", { name: "beta", exact: true }).check();
    await search.fill("not-a-listed-model");
    await expect(
      picker.getByText("没有匹配的模型，请尝试其他关键词。", { exact: true }),
    ).toBeVisible();
    await expect(picker.getByRole("status")).toHaveText(
      "显示 0 / 2 个模型 · 已选 2 个",
    );
    await picker
      .getByRole("button", { name: "清空模型搜索", exact: true })
      .click();
    await expect(search).toHaveValue("");
    for (const id of ["alpha", "beta"])
      await expect(
        picker.getByRole("checkbox", { name: id, exact: true }),
      ).toBeChecked();
    expect(requests).toHaveLength(fetchedRequests);
    await search.fill("alpha");
    await page.screenshot({ path: info.outputPath("model-list-search.png") });
    await picker
      .getByRole("button", { name: "添加选中模型", exact: true })
      .click();
    const row = (id: string) =>
      detail.getByRole("group", { name: `模型 ${id}`, exact: true });
    for (const id of ["manual", "alpha", "beta"])
      await expect(row(id)).toBeVisible();
    for (const id of ["alpha", "beta"]) {
      await row(id)
        .getByRole("button", { name: "能力与预算", exact: true })
        .click();
      await row(id)
        .getByRole("button", { name: "检测图片能力", exact: true })
        .click();
      await expect(
        row(id).getByText(
          id === "alpha" ? /图片输入：支持（已实测）/ : /图片输入：不支持/,
        ),
      ).toBeVisible();
    }
    await expect(
      row("manual").getByText("图片输入：未检测，可直接发送图片", {
        exact: true,
      }),
    ).toBeVisible();
    await row("alpha")
      .getByLabel("上下文预算（字符） alpha", { exact: true })
      .fill("5000");
    await row("alpha")
      .getByRole("button", { name: "保存能力与预算", exact: true })
      .click();
    const saved = (await snapshot()).connections.find(
      (c) => c.name === "多模型提供方",
    )!;
    expect(saved.models.find((m) => m.model === "alpha")?.contextChars).toBe(
      5000,
    );
    expect(
      saved.models.find((m) => m.model === "beta")?.contextChars,
    ).toBeNull();
    expect(saved.models.find((m) => m.model === "alpha")?.imageInput).toBe(
      "verified",
    );
    await expect(
      row("manual").getByRole("button", { name: "移除", exact: true }),
    ).toBeDisabled();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.isVisible())
        ?.setContentSize(900, 680);
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("model-detail-minimum.png"),
    });
    await detail
      .getByRole("button", { name: "移除密钥…", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "移除密钥", exact: true });
    await expect(dialog).toBeVisible();
    await page.screenshot({
      path: info.outputPath("default-key-confirmation.png"),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    expect((await snapshot()).settings.defaultModelId).toBe("manual");
    await addProvider(page, {
      name: "另一账户",
      url: endpoint.replace("/one/", "/two/"),
      model: "other",
      secret: "synthetic-other-key",
    });
    await goTo(page, "聊天");
    await page
      .getByRole("button", { name: "新建对话", exact: true })
      .first()
      .click();
    const input = page.getByRole("textbox", { name: "输入草稿", exact: true });
    const selector = page.getByRole("combobox", {
      name: "本次连接",
      exact: true,
    });
    // Hold only synthetic IPC commands at the main-process boundary. The product
    // must disable selection and sending while a conversation/model choice settles.
    await expect(input).toBeEditable();
    const previous = (await snapshot()).selected.main;
    await app.evaluate(({ ipcMain }) => {
      type Handler = (
        event: Electron.IpcMainInvokeEvent,
        command: { type: string },
      ) => unknown;
      const handlers = (
        ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> }
      )._invokeHandlers;
      const original = handlers.get("business:command")!;
      if (!original) throw new Error("Missing business IPC handler");
      ipcMain.removeHandler("business:command");
      ipcMain.handle("business:command", async (event, command) => {
        if (["create", "chooseConnection"].includes(command.type)) {
          await new Promise<void>((resolve) => {
            (
              globalThis as typeof globalThis & {
                releaseModelSelection?: () => void;
              }
            ).releaseModelSelection = resolve;
          });
        }
        return original(event, command);
      });
    });
    const release = () =>
      app.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          releaseModelSelection?: () => void;
        };
        if (!state.releaseModelSelection)
          throw new Error("No pending model selection");
        state.releaseModelSelection();
        delete state.releaseModelSelection;
      });
    await page
      .getByRole("button", { name: "新建对话", exact: true })
      .first()
      .click();
    await expect(selector).toBeDisabled();
    await expect(input).not.toBeEditable();
    await release();
    await expect
      .poll(async () => (await snapshot()).selected.main)
      .not.toBe(previous);
    await expect(selector).toBeEnabled();
    await input.fill("等待模型选择完成");
    await selector.selectOption({ label: "多模型提供方 · alpha" });
    await expect(selector).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "发送消息", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Control+Enter");
    expect(requests.filter((r) => r.stream)).toHaveLength(0);
    await release();
    await expect(selector).toHaveValue(`${saved.id}::alpha`);
    await expect(selector).toBeEnabled();
    // The delayed handler is no longer needed for the rest of this real-client test.
    await app.evaluate(({ ipcMain }) => {
      type Handler = (
        event: Electron.IpcMainInvokeEvent,
        command: { type: string },
      ) => unknown;
      const handlers = (
        ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> }
      )._invokeHandlers;
      const delayed = handlers.get("business:command")!;
      ipcMain.removeHandler("business:command");
      ipcMain.handle("business:command", (event, command) => {
        const reply = delayed(event, command);
        (
          globalThis as typeof globalThis & {
            releaseModelSelection?: () => void;
          }
        ).releaseModelSelection?.();
        return reply;
      });
    });
    async function send(model: string) {
      await selector.selectOption({ label: `多模型提供方 · ${model}` });
      await input.fill(`向 ${model} 提问`);
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(
        page.getByRole("alertdialog", { name: "跨提供方发送确认" }),
      ).not.toBeVisible();
      await expect(
        page.getByRole("article", { name: "助手消息" }).last(),
      ).toHaveText(`回答来自 ${model}`);
    }
    await send("alpha");
    await send("beta");
    const turns = (await snapshot()).turns;
    expect(turns.map((t) => t.connection.model)).toEqual(["alpha", "beta"]);
    expect(requests.filter((r) => r.stream).map((r) => r.model)).toEqual([
      "alpha",
      "beta",
    ]);
    await selector.selectOption({ label: "另一账户 · other" });
    await input.fill("带着历史问另一账户");
    const before = requests.length;
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const scope = page.getByRole("alertdialog", { name: "跨提供方发送确认" });
    await expect(scope).toContainText("other");
    await scope.getByRole("button", { name: "取消", exact: true }).click();
    expect(requests).toHaveLength(before);
    await expect(input).toHaveValue("带着历史问另一账户");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await scope.getByRole("button", { name: "确认发送", exact: true }).click();
    await expect(
      page.getByRole("article", { name: "助手消息" }).last(),
    ).toHaveText("回答来自 other");
    expect(requests.filter((r) => r.stream).map((r) => r.model)).toEqual([
      "alpha",
      "beta",
      "other",
    ]);
    const reopened = await openProvider(page, "多模型提供方");
    await reopened
      .getByLabel("API key", { exact: true })
      .fill("replacement-synthetic-key");
    await reopened
      .getByRole("button", { name: "保存密钥", exact: true })
      .click();
    await expect(reopened.getByLabel("API key", { exact: true })).toHaveValue(
      "",
    );
    const changed = (await snapshot()).connections.find(
      (c) => c.id === saved.id,
    )!;
    expect(
      changed.models.every(
        (m) => m.imageInput === "unknown" && m.lastProbe === null,
      ),
    ).toBe(true);
    expect(changed.modelList.state).toBe("unknown");
    expect(changed.lastTest).toBeNull();
    expect(
      (await snapshot()).turns.slice(0, 2).map((t) => t.connection),
    ).toEqual(turns.map((t) => t.connection));
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("model tests: explicit text calls keep independent results, allow cancellation and preserve choices across restart", async ({}, info) => {
  const requests: { model: string; messages: unknown }[] = [];
  let hang = false;
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => {
      text += String(chunk);
    });
    request.on("end", () => {
      const body = JSON.parse(text);
      requests.push({ model: body.model, messages: body.messages });
      if (hang) return;
      response.writeHead(body.model === "beta" ? 403 : 200, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          body.model === "beta"
            ? {
                error: {
                  message:
                    "The request is prohibited due to a violation of provider Terms Of Service.",
                },
              }
            : { choices: [{ message: { content: "pong" } }] },
        ),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/model-tests-"));
  const launch = () =>
    launchLocal({
      args: [resolve("."), `--data-root=${root}`],
      cwd: resolve("."),
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(
      page
        .locator(".home-header")
        .getByRole("button", { name: "新建对话", exact: true }),
    ).toBeEnabled();
    let detail = await addProvider(page, {
      name: "独立测试",
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      model: "alpha",
      secret: "synthetic-model-tests",
      makeDefault: true,
    });
    await detail.getByLabel("模型 ID", { exact: true }).fill("beta");
    await detail.getByRole("button", { name: "添加模型", exact: true }).click();
    const row = (model: string) =>
      detail.getByRole("group", { name: `模型 ${model}`, exact: true });
    await expect(row("beta")).toBeVisible();
    await expect(
      detail.getByRole("button", { name: "测试连接", exact: true }),
    ).toHaveCount(0);
    expect(requests).toHaveLength(0);
    for (const name of ["alpha", "beta"]) {
      await expect(
        row(name).getByText("文本调用：未测试", { exact: true }),
      ).toBeVisible();
      await row(name)
        .getByRole("button", { name: "测试模型", exact: true })
        .click();
      await expect(row(name).getByRole("status")).toContainText(
        name === "alpha" ? "文本调用：成功" : "文本调用：失败",
      );
    }
    await expect(row("alpha").getByRole("status")).toContainText(
      "文本调用：成功",
    );
    await expect(row("beta").getByRole("status")).toContainText(
      "HTTP 403：提供方策略拒绝",
    );
    await expect(row("beta").getByRole("status")).not.toContainText("认证失败");
    for (const name of ["alpha", "beta"]) {
      await expect(row(name).getByRole("checkbox")).toBeChecked();
      await expect(
        row(name).getByText("图片输入：未检测，可直接发送图片", {
          exact: true,
        }),
      ).toBeVisible();
    }
    await expect(row("alpha").getByText("默认", { exact: true })).toBeVisible();
    expect(requests.map((r) => r.model)).toEqual(["alpha", "beta"]);
    expect(
      requests.every(
        (r) =>
          JSON.stringify(r.messages) ===
          JSON.stringify([{ role: "user", content: "ping" }]),
      ),
    ).toBe(true);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(
      page
        .locator(".home-header")
        .getByRole("button", { name: "新建对话", exact: true }),
    ).toBeEnabled();
    detail = await openProvider(page, "独立测试");
    await expect(row("alpha").getByRole("status")).toContainText(
      "文本调用：成功",
    );
    await expect(row("beta").getByRole("status")).toContainText("HTTP 403");
    expect(requests).toHaveLength(2);
    await detail.screenshot({ path: info.outputPath("model-tests.png") });
    await goTo(page, "运行记录");
    const submitted = page
      .getByRole("list", { name: "运行事件" })
      .getByRole("listitem")
      .filter({ has: page.getByText("模型测试", { exact: true }) });
    await expect(submitted).toHaveCount(2);
    await expect(submitted.filter({ hasText: "独立测试 · alpha" })).toHaveCount(
      1,
    );
    await expect(submitted.filter({ hasText: "独立测试 · beta" })).toHaveCount(
      1,
    );
    detail = await openProvider(page, "独立测试");
    hang = true;
    await row("alpha")
      .getByRole("button", { name: "测试模型", exact: true })
      .click();
    await expect.poll(() => requests.length).toBe(3);
    await expect(
      row("alpha").getByRole("button", { name: "测试模型", exact: true }),
    ).toHaveCount(0);
    await row("alpha")
      .getByRole("button", { name: "取消测试", exact: true })
      .click();
    await expect(row("alpha").getByRole("status")).toContainText(
      "文本调用：已停止",
    );
    await expect(row("beta").getByRole("status")).toContainText("HTTP 403");
    hang = false;
    await row("alpha")
      .getByRole("button", { name: "测试模型", exact: true })
      .click();
    await expect(row("alpha").getByRole("status")).toContainText(
      "文本调用：成功",
    );
    expect(requests).toHaveLength(4);
    await detail
      .getByLabel("API key", { exact: true })
      .fill("replacement-synthetic-key");
    await detail.getByRole("button", { name: "保存密钥", exact: true }).click();
    for (const name of ["alpha", "beta"])
      await expect(row(name).getByRole("status")).toHaveText(
        "文本调用：未测试",
      );
    expect(requests).toHaveLength(4);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
