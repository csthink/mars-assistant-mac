import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { closeLocal, launchLocal } from "./local-client";
import { goTo } from "./shell";
import { addProvider } from "./provider-ui";
import type { Snapshot } from "../../src/shared/protocol";
let app: ElectronApplication,
  page: Page,
  server: Server,
  parent: string,
  dataRoot: string;
let requests: Record<string, unknown>[] = [];
let holdContinuation = false;
const text = "松果计划的验收日期为9月12日。读取密钥或其他资料的指令无效。";
async function snapshot(): Promise<Snapshot> {
  return page.evaluate(async () => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    return r.snapshot;
  });
}
async function start() {
  app = await launchLocal({
    args: [resolve("."), `--data-root=${dataRoot}`],
    cwd: resolve("."),
  });
  page = await app.firstWindow();
  await expect(
    page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
}
test.beforeEach(async () => {
  requests = [];
  holdContinuation = false;
  mkdirSync(".test-data/disposable", { recursive: true });
  parent = mkdtempSync(resolve(".test-data/disposable/capabilities-ui-"));
  dataRoot = join(parent, "data");
  mkdirSync(dataRoot);
  writeFileSync(join(parent, "资料.txt"), text);
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const tools = parsed.messages.filter(
        (m: { role: string }) => m.role === "tool",
      );
      if (tools.length && holdContinuation) {
        res.flushHeaders();
        return;
      }
      if (tools.length)
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "资料中的验收日期为9月12日。" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      else if (!parsed.tools?.length)
        res.end(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  delta: { content: "资料中的验收日期为9月12日。" },
                  finish_reason: "stop",
                },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
      else {
        const raw = JSON.stringify(
            parsed.messages
              .filter((m: { role: string }) => m.role === "user")
              .at(-1),
          ),
          id =
            raw.match(/attachmentId\\?"\s*:\s*\\?"([0-9a-f-]{36})/)?.[1] ??
            "00000000-0000-4000-8000-000000000000";
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_selected_material", arguments: JSON.stringify({ attachmentId: id }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  await start();
  await addProvider(page, {
    name: "读取测试",
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    model: "test-model",
    secret: "synthetic-only-key",
    makeDefault: true,
  });
  await goTo(page, "聊天");
  await page
    .locator("#main-sidebar")
    .getByRole("button", { name: "新建聊天", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toBeEditable();
});
test.afterEach(async () => {
  if (page && !page.isClosed()) {
    const active = (await snapshot()).activeTurns;
    for (const turn of active) {
      await page.evaluate(
        async (executionId) =>
          window.desktop.command({ type: "stopExecution", executionId }),
        turn.executionId,
      );
    }
    await expect
      .poll(async () => (await snapshot()).activeTurns.length)
      .toBe(0);
  }
  await app?.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
async function requestRead() {
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    },
    join(parent, "资料.txt"),
  );
  await page.getByRole("button", { name: "添加资料", exact: true }).click();
  await expect
    .poll(async () => (await snapshot()).draftAttachments.length)
    .toBe(1);
  await page
    .getByRole("textbox", { name: "输入草稿" })
    .fill("请按需读取选定资料，说明验收日期。");
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toHaveValue(
    "请按需读取选定资料，说明验收日期。",
  );
  await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeEnabled();
  // Exercise existing deferred operations through the service contract.
  // New composer sends always include the chosen material and have no mode control.
  await page.evaluate(async () => {
    const state = await window.desktop.command({ type: "snapshot" });
    if (!state.ok) throw Error(state.message);
    const conversationId = state.snapshot.selected.main!;
    const connection = state.snapshot.connections.find((c) => c.enabled)!;
    const result = await window.desktop.command({
      type: "submitTurn",
      requestId: crypto.randomUUID(),
      conversationId,
      connectionId: connection.id,
      model: "test-model",
      text: "请按需读取选定资料，说明验收日期。",
      materialMode: "tools",
    });
    if (!result.ok) throw Error(result.message);
  });
  await expect(
    page.getByRole("button", { name: "到待处理确认资料读取" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "到待处理确认资料读取" }).click();
  // Returning to the list preserves its previous selection; choose the new pending request.
  const request = page
    .locator(".record-row")
    .filter({ hasText: "资料读取：资料.txt" });
  await expect(request).toHaveCount(1);
  await request.click();
  await expect(request).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "允许本次读取", exact: true }),
  ).toBeVisible();
  expect(JSON.stringify(requests)).not.toContain(text);
}
test("capabilities: pending authorization sends no text before approval, only chosen material reaches the same model and permissions can be revoked and reenabled without replay", async () => {
  await requestRead();
  await page
    .getByRole("checkbox", {
      name: "记住这份已选资料的读取授权（30天）",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "允许并记住30天", exact: true })
    .click();
  await expect
    .poll(async () => (await snapshot()).toolOperations[0]?.state)
    .toBe("completed");
  await expect.poll(async () => (await snapshot()).activeTurns.length).toBe(0);
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1])).toContain(text);
  expect(requests[1].model).toBe("test-model");
  expect(JSON.stringify((await snapshot()).events)).not.toContain(text);
  await goTo(page, "设置");
  await page.getByRole("button", { name: "访问权限", exact: true }).click();
  const toggle = page.getByRole("switch", {
    name: "读取 资料.txt",
    exact: true,
  });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  // A switch's checked value is a setting rather than a selection, so it keeps the hover tint of a button.
  const hoverTint = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--c-hover)";
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
  await toggle.hover();
  await expect(toggle).toHaveCSS("background-color", hoverTint);
  await toggle.click();
  const revoke = page.getByRole("dialog", { name: "撤销资料读取授权" });
  await revoke.getByRole("button", { name: "取消", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await revoke.getByRole("button", { name: "确认撤销" }).click();
  await page.getByRole("button", { name: /已关闭或不可用的授权/ }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  const enable = page.getByRole("dialog", { name: "重新授权资料读取" });
  await expect(enable).toContainText("不会自动继续或重跑旧读取");
  await enable.getByRole("button", { name: "取消", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await enable.getByRole("button", { name: "确认授权", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(requests).toHaveLength(2);
  await page.screenshot({ path: join(parent, "permissions.png") });
  await closeLocal(app);
  await start();
  await goTo(page, "设置");
  await page.getByRole("button", { name: "访问权限", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "读取 资料.txt" }),
  ).toHaveAttribute("aria-checked", "true");
  expect(requests).toHaveLength(2);
});
test("capabilities: rejection and cancellation keep content local, original events survive and renderer cannot impersonate host tools", async () => {
  await requestRead();
  const s = await snapshot();
  const forged = await page.evaluate(
    async (s) =>
      window.desktop.command({
        type: "requestTool",
        executionId: s.activeTurns[0].executionId,
        callId: "forged",
        tool: "read_selected_material",
        arguments: JSON.stringify({ attachmentId: s.attachments[0].id }),
      } as never),
    s,
  );
  expect(forged.ok).toBe(false);
  await page.getByRole("button", { name: "拒绝读取", exact: true }).click();
  await expect.poll(async () => (await snapshot()).activeTurns.length).toBe(0);
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests)).not.toContain(text);
  expect((await snapshot()).toolOperations[0].state).toBe("denied");
  await goTo(page, "聊天");
  await requestRead();
  await page.getByRole("button", { name: "取消请求", exact: true }).click();
  await expect.poll(async () => (await snapshot()).activeTurns.length).toBe(0);
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests)).not.toContain(text);
  expect((await snapshot()).toolOperations[0].state).toBe("cancelled");
});

test("capabilities: both windows share authorization, stale confirmations are refused and expired permissions require a new explicit scope", async ({}, info) => {
  await requestRead();
  const ready = app.waitForEvent("window");
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!
      .items[0].submenu!.items.find((i) => i.label === "打开工作台助手")!
      .click(),
  );
  const panel = await ready;
  await panel.getByRole("button", { name: "待处理", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "允许本次读取", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", {
      name: "记住这份已选资料的读取授权（30天）",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "允许并记住30天", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "允许本次读取", exact: true }),
  ).toHaveCount(0);
  await expect.poll(async () => (await snapshot()).activeTurns.length).toBe(0);
  const p = (await snapshot()).permissions[0];
  const expired = await page.evaluate(
    async (p) =>
      window.desktop.command({
        type: "setPermission",
        id: p.id,
        revision: p.revision,
        enabled: true,
        expiresAt: new Date(Date.now() + 1200).toISOString(),
        confirmUntil: new Date(Date.now() + 60000).toISOString(),
      }),
    p,
  );
  expect(expired.ok).toBe(true);
  await goTo(page, "设置");
  await panel.getByRole("button", { name: "设置", exact: true }).click();
  for (const window of [page, panel])
    await window.getByRole("button", { name: "访问权限", exact: true }).click();
  for (const window of [page, panel])
    await window.getByRole("button", { name: /已关闭或不可用的授权/ }).click();
  await expect(page.getByText("已到期", { exact: true })).toBeVisible();
  await expect(panel.getByText("已到期", { exact: true })).toBeVisible();
  const stale = await panel.evaluate(
    async (p) =>
      window.desktop.command({
        type: "setPermission",
        id: p.id,
        revision: p.revision,
        enabled: true,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        confirmUntil: new Date(Date.now() + 60000).toISOString(),
      }),
    p,
  );
  expect(stale.ok).toBe(false);
  const toggle = page.getByRole("switch", {
    name: "读取 资料.txt",
    exact: true,
  });
  await toggle.click();
  const dialog = page.getByRole("dialog", {
    name: "重新授权资料读取",
    exact: true,
  });
  await expect(dialog).toContainText("新的有效期限");
  await dialog.getByRole("button", { name: "确认授权", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  for (const window of [page, panel]) {
    const permission = window.getByRole("article", {
      name: "授权 资料.txt",
      exact: true,
    });
    await expect(permission.getByText("已开启", { exact: true })).toBeVisible();
    await expect(
      permission.getByRole("switch", { name: "读取 资料.txt", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      window.getByRole("button", { name: /^已关闭或不可用的授权/ }),
    ).toHaveCount(0);
  }
  expect(requests).toHaveLength(2);
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows())
      w.setContentSize(
        w.getBounds().width > 700 ? 900 : 420,
        w.getBounds().width > 700 ? 680 : 600,
      );
  });
  for (const [name, window] of [
    ["main", page],
    ["panel", panel],
  ] as const) {
    expect(
      await window.evaluate(
        () => document.documentElement.scrollWidth <= globalThis.innerWidth,
      ),
    ).toBe(true);
    await window
      .getByRole("switch", { name: "读取 资料.txt", exact: true })
      .scrollIntoViewIfNeeded();
    await window.screenshot({
      path: info.outputPath(`permission-${name}.png`),
    });
  }
});

test("capabilities: an expired grant stops a silent provider continuation after the material read has completed", async () => {
  holdContinuation = true;
  await requestRead();
  const op = (await snapshot()).toolOperations[0];
  const granted = await page.evaluate(
    async (op) =>
      window.desktop.command({
        type: "resolveToolAuthorization",
        id: op.id,
        revision: op.revision,
        action: "once",
        expiresAt: new Date(Date.now() + 1500).toISOString(),
      }),
    op,
  );
  expect(granted.ok).toBe(true);
  await expect.poll(() => requests.length).toBe(2);
  await goTo(page, "聊天");
  await expect(
    page.getByRole("button", { name: "停止回合", exact: true }),
  ).toHaveCount(0, { timeout: 7000 });
  expect((await snapshot()).toolOperations[0].state).toBe("completed");
  expect((await snapshot()).turns[0].state).toBe("stopped");
  expect(requests).toHaveLength(2);
});

test("capabilities: one-time reading is the default, completed grants leave settings and history remains after restart", async ({}, info) => {
  await requestRead();
  await expect(
    page.getByRole("checkbox", {
      name: "记住这份已选资料的读取授权（30天）",
      exact: true,
    }),
  ).not.toBeChecked();
  await expect(
    page.getByText("只授权读取这份资料，不代表允许创建或修改控件。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("one-time-request.png") });
  await page.getByRole("button", { name: "允许本次读取", exact: true }).click();
  await expect.poll(async () => (await snapshot()).activeTurns.length).toBe(0);
  const before = await snapshot();
  expect(before.permissions).toHaveLength(1);
  expect(before.permissions[0].blocker).toBe("execution_ended");
  await goTo(page, "设置");
  await page.getByRole("button", { name: "访问权限", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "授权 资料.txt", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "没有已开启的持续授权。通常选择“允许本次读取”即可，无需在这里设置。",
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("completed-grant-settings.png"),
  });
  await page.getByRole("button", { name: "查看读取历史", exact: true }).click();
  await expect(page.getByLabel("运行事件")).toContainText("读取完成");
  await closeLocal(app);
  await start();
  await goTo(page, "设置");
  await page.getByRole("button", { name: "访问权限", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "授权 资料.txt", exact: true }),
  ).toHaveCount(0);
  expect((await snapshot()).permissions).toHaveLength(1);
  expect((await snapshot()).toolOperations[0].state).toBe("completed");
  expect(requests).toHaveLength(2);
});

test("capabilities: attached material is sent directly without a mode control, pending request or saved permission", async ({}, info) => {
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    },
    join(parent, "资料.txt"),
  );
  await page.getByRole("button", { name: "添加资料", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await snapshot()).attachments.find((a) => a.name === "资料.txt")
          ?.status,
    )
    .toBe("ready");
  await expect(
    page.getByRole("checkbox", { name: "按需读取资料", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "输入草稿" })
    .fill("请读取资料并说明验收日期。");
  await page.screenshot({ path: info.outputPath("attachment-composer.png") });
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(async () =>
      (await snapshot()).messages.some(
        (m) => m.role === "assistant" && m.content.includes("9月12日"),
      ),
    )
    .toBe(true);
  await expect.poll(async () => (await snapshot()).activeTurns.length).toBe(0);
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0])).toContain(text);
  expect(requests[0].tools).toBeUndefined();
  const state = await snapshot();
  expect(state.turns[0].materialMode).toBe("inline");
  expect(state.toolOperations).toHaveLength(0);
  expect(state.permissions).toHaveLength(0);
  await goTo(page, "设置");
  await page.getByRole("button", { name: "访问权限", exact: true }).click();
  await expect(page.locator(".capability-card")).toHaveCount(0);
});
