import { closeLocal, launchLocal } from "./local-client";
import { displayNameFor } from "../../src/shared/app-name";
import { goTo, recent } from "./shell";
import { addProvider, openProvider } from "./provider-ui";
import type { Provider } from "../../src/shared/protocol";
import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";

let app: ElectronApplication;
let page: Page;
let dataRoot: string;
let mock: Server;
const secret = "test-secret-chat-not-a-real-key";
const requests: { path: string; authorization?: string; body: unknown }[] = [];
const open = new Set<ServerResponse>();
let flakyCalls = 0;
let openOnceCalls = 0;

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
function chunk(content: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}
test.beforeAll(async () => {
  // Route prefix in the Base URL selects the streaming behaviour.
  mock = createServer((request, response) => {
    let body = "";
    request.on("data", (part) => (body += part));
    request.on("end", () => {
      requests.push({
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body: body ? JSON.parse(body) : null,
      });
      const route = (request.url ?? "").split("/")[1];
      if (route === "auth") {
        response.writeHead(401, { "content-type": "application/json" });
        return response.end(JSON.stringify({ error: { message: "bad key" } }));
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk("第一段。"));
      if (route === "cut")
        return setTimeout(() => request.socket.destroy(), 30);
      if (route === "flaky" && flakyCalls++ === 0)
        return setTimeout(() => request.socket.destroy(), 30);
      if (route === "openonce" && openOnceCalls++ === 0) {
        open.add(response);
        return;
      }
      if (route === "slow") {
        open.add(response);
        return setTimeout(() => {
          response.write(chunk("第二段，回答结束。"));
          response.end("data: [DONE]\n\n");
          open.delete(response);
        }, 2500);
      }
      if (route === "open") {
        open.add(response);
        return;
      }
      // The first chunk must stay observable as partial output under full-suite load before the answer ends.
      setTimeout(() => {
        response.write(chunk("第二段，回答结束。"));
        response.end("data: [DONE]\n\n");
      }, 1200);
    });
  });
  await new Promise<void>((done) => mock.listen(0, "127.0.0.1", done));
});
test.afterAll(async () => {
  for (const response of open) response.destroy();
  mock.closeAllConnections();
  await new Promise<void>((done) => mock.close(() => done()));
});
test.beforeEach(async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  dataRoot = mkdtempSync(resolve(".test-data/disposable/chat-"));
  requests.length = 0;
  flakyCalls = 0;
  openOnceCalls = 0;
  const started = await launch();
  app = started.application;
  page = started.window;
});
test.afterEach(async () => {
  if (app) await app.close();
});
async function addConnection(
  name: string,
  route: string,
  makeDefault = true,
  provider = "custom",
) {
  const port = (mock.address() as AddressInfo).port;
  await addProvider(page, {
    name,
    url: `http://127.0.0.1:${port}/${route}/v1`,
    provider: provider as Provider,
    model: "mock-model",
    secret,
    makeDefault,
  });
  await goTo(page, "聊天");
}

async function newChat() {
  await page
    .getByRole("button", { name: /^新建(聊天|对话)$/ })
    .first()
    .click();
  await expect(page.getByRole("textbox", { name: "输入草稿" })).toBeEditable();
}
const input = () => page.getByRole("textbox", { name: "输入草稿" });

test("chat: a streamed answer shows increments and the actual connection, ends completed, and the run log records the events", async () => {
  await expect(page.getByTestId("turn-state")).toHaveText(
    "选择可用模型后即可提问",
  );
  await addConnection("流式模拟", "stream");
  await newChat();
  await expect(page.getByRole("button", { name: "发送消息" })).toBeDisabled();
  await input().fill("请回答一个问题");
  await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
  await input().press("Enter");
  await expect(page.getByRole("article", { name: "用户消息" })).toHaveText(
    "请回答一个问题",
  );
  await expect(input()).toHaveValue("");
  const turn = page.getByRole("article", { name: "助手回合" });
  await expect(turn.getByText("第一段。", { exact: false })).toBeVisible();
  await expect(turn.getByText("流式模拟 · mock-model")).toBeVisible();
  await expect(turn.getByRole("status")).toHaveText("生成中");
  await expect(page.getByTestId("turn-state")).toContainText(
    "生成中 · 流式模拟",
  );
  await expect(page.getByRole("article", { name: "助手消息" })).toHaveText(
    "第一段。第二段，回答结束。",
  );
  await expect(page.getByRole("article", { name: "助手回合" })).toHaveCount(0);
  await expect(page.getByTestId("turn-state")).toHaveText(
    "Enter 发送，Shift + Enter 换行",
  );
  await page.screenshot({ path: "test-results/chat-completed.png" });
  expect(requests).toHaveLength(1);
  expect(requests[0].path).toBe("/stream/v1/chat/completions");
  expect(requests[0].authorization).toBe(`Bearer ${secret}`);
  expect((requests[0].body as { messages: unknown[] }).messages).toEqual([
    { role: "user", content: "请回答一个问题" },
  ]);
  // A follow-up carries the saved history.
  await input().fill("再追问一句");
  await input().press("Enter");
  await expect(page.getByRole("article", { name: "助手消息" })).toHaveCount(2);
  expect((requests[1].body as { messages: unknown[] }).messages).toEqual([
    { role: "user", content: "请回答一个问题" },
    { role: "assistant", content: "第一段。第二段，回答结束。" },
    { role: "user", content: "再追问一句" },
  ]);
  await goTo(page, "运行记录");
  const events = page
    .getByRole("list", { name: "运行事件" })
    .getByRole("listitem");
  await expect(events).toHaveCount(6);
  await expect(events.first()).toContainText("已完成");
  await expect(events.first()).toContainText("流式模拟 · mock-model");
  await expect(
    page.getByRole("button", { name: /重试|停止|授权/ }),
  ).toHaveCount(0);
  await page.screenshot({ path: "test-results/chat-run-log.png" });
  expect(await page.content()).not.toContain(secret);
});

test("chat: stopping shows stopping before stopped and keeps the partial output; a cut stream fails with the partial text kept", async () => {
  await addConnection("挂起模拟", "open");
  await newChat();
  await input().fill("请慢慢回答");
  await input().press("Enter");
  const turn = page.getByRole("article", { name: "助手回合" });
  await expect(turn.getByText("第一段。", { exact: false })).toBeVisible();
  await expect(turn.getByRole("status")).toHaveText("生成中");
  // While a turn is open, Enter and the send button cannot start another one.
  await input().fill("重复提交");
  await input().press("Enter");
  await expect(page.getByRole("article", { name: "用户消息" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "停止回合" })).toBeVisible();
  await turn.getByRole("button", { name: "停止" }).click();
  await expect(turn.getByRole("status")).toHaveText(/停止中|已停止/);
  await expect(turn.getByRole("status")).toHaveText("已停止");
  await expect(turn.getByText("第一段。", { exact: false })).toBeVisible();
  await page.screenshot({ path: "test-results/chat-stopped.png" });
  const kinds = await page.evaluate(async () => {
    const reply = await window.desktop.command({ type: "snapshot" });
    if (!reply.ok) throw new Error(reply.message);
    return reply.snapshot.events.map((e) => e.kind);
  });
  expect(kinds.indexOf("stopped")).toBeLessThan(
    kinds.indexOf("stop_requested"),
  );
  expect(kinds).toContain("stop_requested");
  await expect(input()).toHaveValue("重复提交");

  await addConnection("断流模拟", "cut");
  await input().fill("这次会断流");
  await input().press("Enter");
  const scope = page.getByRole("alertdialog", { name: "跨提供方发送确认" });
  await expect(scope).toContainText("断流模拟（自定义 · mock-model）");
  expect(requests).toHaveLength(1);
  await scope.getByRole("button", { name: "确认发送", exact: true }).click();
  const failed = page.getByRole("article", { name: "助手回合" }).last();
  await expect(failed.getByRole("status")).toHaveText("失败");
  await expect(failed.getByText("第一段。", { exact: false })).toBeVisible();
  await expect(failed.getByRole("alert")).toContainText("输出中断");
  await expect(failed.getByText("断流模拟 · mock-model")).toBeVisible();
  // The stopped answer's partial text reaches the model as an unfinished answer, not as an unanswered question.
  expect((requests[1].body as { messages: unknown[] }).messages).toEqual([
    { role: "user", content: "请慢慢回答" },
    { role: "assistant", content: "第一段。\n\n（回答未完成：已停止。）" },
    { role: "user", content: "这次会断流" },
  ]);
  await goTo(page, "待处理");
  await expect(
    page.getByRole("list", { name: "待处理事项" }).getByRole("listitem"),
  ).toHaveCount(1);
  // The 类型 filter lists 回合失败 as an option while such an item exists; the item title is read inside the list.
  await expect(
    page
      .getByRole("list", { name: "待处理事项" })
      .getByText("回合失败", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/chat-failed.png" });
});

test("chat: an authentication failure is explained, a composing IME Enter does not send, and nothing is sent without a default connection", async () => {
  await newChat();
  await input().fill("没有默认连接");
  await input().press("Enter");
  await expect(page.getByRole("article", { name: "用户消息" })).toHaveCount(0);
  await expect(input()).toHaveValue("没有默认连接");
  expect(requests).toHaveLength(0);
  await addConnection("认证失败模拟", "auth");
  await input().fill("");
  await input().dispatchEvent("compositionstart", { data: "zhongwen" });
  await input().fill("中文");
  await input().dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await input().dispatchEvent("compositionend", { data: "中文" });
  await expect(page.getByRole("article", { name: "用户消息" })).toHaveCount(0);
  await input().press("Enter");
  const turn = page.getByRole("article", { name: "助手回合" });
  await expect(turn.getByRole("status")).toHaveText("失败");
  await expect(turn.getByRole("alert")).toContainText("认证失败");
  await expect(turn.getByRole("alert")).toContainText("HTTP 401");
  expect(requests).toHaveLength(1);
});

test("history and retry: a reopened conversation distinguishes saved messages from an unfinished turn, and a pending retry adds a new attempt while the failed event stays", async () => {
  await addConnection("先断后通", "flaky");
  await newChat();
  await input().fill("第一次会断流");
  await input().press("Enter");
  const failed = page.getByRole("article", { name: "助手回合" });
  await expect(failed.getByRole("status")).toHaveText("失败");
  await expect(failed.getByText("第一段。", { exact: false })).toBeVisible();
  // CHAT-02 now uses a single-line title without a message preview.
  await recent(page);
  await expect(page.locator(".session-preview")).toHaveCount(0);
  await expect(page.locator(".session-name").first()).toHaveText(
    "第一次会断流",
  );

  // Restart: the saved user message and the failed turn are both recognisable.
  await closeLocal(app);
  const restart = await launch();
  app = restart.application;
  page = restart.window;
  await expect(page.getByRole("article", { name: "用户消息" })).toHaveText(
    "第一次会断流",
  );
  await expect(
    page.getByRole("article", { name: "助手回合" }).getByRole("status"),
  ).toHaveText("失败");
  const eventsBefore = await page.evaluate(async () => {
    const reply = await window.desktop.command({ type: "snapshot" });
    if (!reply.ok) throw new Error(reply.message);
    return reply.snapshot.events.map((e) => `${e.id}:${e.kind}`);
  });

  // Retry from pending: the same turn gets a second attempt; the run log keeps the failure.
  await goTo(page, "待处理");
  const item = page
    .getByRole("list", { name: "待处理事项" })
    .getByRole("listitem");
  await expect(item).toHaveCount(1);
  await item.getByRole("button", { name: "重试" }).click();
  await expect(item).toHaveCount(0);
  await goTo(page, "聊天");
  await expect(page.getByRole("article", { name: "助手消息" })).toHaveText(
    "第一段。第二段，回答结束。",
  );
  await expect(page.getByRole("article", { name: "用户消息" })).toHaveCount(1);
  const eventsAfter = await page.evaluate(async () => {
    const reply = await window.desktop.command({ type: "snapshot" });
    if (!reply.ok) throw new Error(reply.message);
    return reply.snapshot.events.map((e) => `${e.id}:${e.kind}`);
  });
  // Newest first: every earlier event is still present, byte for byte identical identities.
  expect(eventsAfter.slice(-eventsBefore.length)).toEqual(eventsBefore);
  expect(eventsAfter.map((e) => e.split(":")[1]).slice(0, 4)).toEqual([
    "completed",
    "started",
    "pending_resolved",
    "retried",
  ]);
  expect(requests).toHaveLength(2);
  expect((requests[1].body as { messages: unknown[] }).messages).toEqual([
    { role: "user", content: "第一次会断流" },
  ]);
  await goTo(page, "运行记录");
  await expect(page.getByText("第 2 次尝试")).toBeVisible();
  await expect(
    page.getByText("输出中断", { exact: false }).first(),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/chat-retry-log.png" });
  // The follow-up carries only saved messages, never the failed attempt's partial text.
  await goTo(page, "聊天");
  await input().fill("继续");
  await input().press("Enter");
  await expect(page.getByRole("article", { name: "助手消息" })).toHaveCount(2);
  expect((requests[2].body as { messages: unknown[] }).messages).toEqual([
    { role: "user", content: "第一次会断流" },
    { role: "assistant", content: "第一段。第二段，回答结束。" },
    { role: "user", content: "继续" },
  ]);
});

async function chooseQuitDialog(response: number) {
  // The native dialog cannot be driven by Playwright; the main process answers it deterministically.
  await app.evaluate(({ dialog }, choice) => {
    dialog.showMessageBox = (async () => ({
      response: choice,
      checkboxChecked: false,
    })) as typeof dialog.showMessageBox;
  }, response);
}
/** The application menu's quit item carries the localized display name the app resolved from its locale. */
async function quitLabel() {
  return `退出 ${displayNameFor(await app.evaluate(({ app }) => app.getLocale()))}`;
}
async function clickAppMenu(label: string) {
  await app.evaluate(({ Menu }, target) => {
    const item = Menu.getApplicationMenu()?.items[0].submenu?.items.find(
      (entry) => entry.label === target,
    );
    if (!item) throw new Error("Missing menu item");
    item.click();
  }, label);
}
async function snapshotEvents() {
  return page.evaluate(async () => {
    const reply = await window.desktop.command({ type: "snapshot" });
    if (!reply.ok) throw new Error(reply.message);
    return {
      kinds: reply.snapshot.events.map((e) => e.kind),
      turns: reply.snapshot.turns.map((t) => [t.state, t.partialText]),
      pending: reply.snapshot.pendingItems.length,
      telemetry: reply.snapshot.settings.telemetryEnabled,
    };
  });
}

test("quit and windows: closing the window keeps the turn running; cancelling quit keeps everything; stop-and-quit records stopped before exit", async () => {
  await addConnection("慢速模拟", "slow");
  await newChat();
  await input().fill("关窗后继续");
  await input().press("Enter");
  const turn = page.getByRole("article", { name: "助手回合" });
  await expect(turn.getByRole("status")).toHaveText("生成中");
  // Closing the main window is not quitting: the turn finishes in the background.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => ["青鸾", "Qingluan"].includes(window.getTitle()))
      ?.close(),
  );
  await expect
    .poll(() => app.windows().filter((window) => !window.isClosed()).length)
    .toBe(0);
  const opening = app.waitForEvent("window");
  await clickAppMenu("打开主窗口");
  page = await opening;
  await expect(page.getByRole("article", { name: "助手消息" })).toHaveText(
    "第一段。第二段，回答结束。",
    { timeout: 15000 },
  );
  // A second turn is running when quit is requested and cancelled.
  await input().fill("退出前取消");
  await input().press("Enter");
  await expect(
    page.getByRole("article", { name: "助手回合" }).getByRole("status"),
  ).toHaveText("生成中");
  await chooseQuitDialog(0);
  await clickAppMenu(await quitLabel());
  await expect(page.getByRole("article", { name: "助手消息" })).toHaveCount(2, {
    timeout: 15000,
  });
  // Stop and quit: the turn is recorded as stopped with its partial text before the app exits.
  await input().fill("停止并退出");
  await input().press("Enter");
  await expect(
    page.getByRole("article", { name: "助手回合" }).getByRole("status"),
  ).toHaveText("生成中");
  await chooseQuitDialog(1);
  const closed = app.waitForEvent("close", { timeout: 15000 });
  await clickAppMenu(await quitLabel());
  await closed;
  const restart = await launch();
  app = restart.application;
  page = restart.window;
  const after = await snapshotEvents();
  expect(after.turns[2]).toEqual(["stopped", "第一段。"]);
  expect(after.pending).toBe(0);
  expect(after.kinds.indexOf("stopped")).toBeLessThan(
    after.kinds.indexOf("stop_requested"),
  );
  expect(after.kinds).not.toContain("interrupted");
  await expect(
    page.getByRole("article", { name: "助手回合" }).getByRole("status"),
  ).toHaveText("已停止");
  await page.screenshot({ path: "test-results/chat-quit-stopped.png" });
});

test("crash and restart: an unfinished turn becomes interrupted with a pending item, is not replayed automatically, and retries on request; telemetry stays off unless chosen", async () => {
  await addConnection("首次挂起", "openonce");
  await newChat();
  await input().fill("这次会被强制结束");
  await input().press("Enter");
  await expect(
    page.getByRole("article", { name: "助手回合" }).getByRole("status"),
  ).toHaveText("生成中");
  // The first increment is committed before the process is killed, so it must survive.
  await expect(
    page
      .getByRole("article", { name: "助手回合" })
      .getByText("第一段。", { exact: false }),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
  app.process().kill("SIGKILL");
  await expect
    .poll(
      () => {
        try {
          process.kill(app.process().pid!, 0);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15000 },
    )
    .toBe(false);
  const restart = await launch();
  app = restart.application;
  page = restart.window;
  const turn = page.getByRole("article", { name: "助手回合" });
  await expect(turn.getByRole("status")).toHaveText("已中断");
  await expect(turn.getByRole("alert")).toContainText("结果不明");
  await expect(turn.getByText("第一段。", { exact: false })).toBeVisible();
  // Nothing was replayed: still exactly one provider request after the restart.
  await page.waitForTimeout(500);
  expect(requests).toHaveLength(1);
  await goTo(page, "待处理");
  const item = page
    .getByRole("list", { name: "待处理事项" })
    .getByRole("listitem");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("回合被中断，结果不明");
  await item.getByRole("button", { name: "重试" }).click();
  await expect(item).toHaveCount(0);
  await goTo(page, "聊天");
  await expect(page.getByRole("article", { name: "助手消息" })).toHaveText(
    "第一段。第二段，回答结束。",
  );
  expect(requests).toHaveLength(2);
  const events = await snapshotEvents();
  expect(events.kinds).toContain("interrupted");
  expect(events.telemetry).toBe(false);
  // Telemetry: off by default, the choice persists, and no request other than the turns was made.
  await goTo(page, "设置");
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "数据与隐私", exact: true })
    .click();
  const toggle = page.getByRole("checkbox", { name: "可选诊断统计" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await closeLocal(app);
  const again = await launch();
  app = again.application;
  page = again.window;
  await goTo(page, "设置");
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "数据与隐私", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "可选诊断统计" }),
  ).toBeChecked();
  await page.getByRole("checkbox", { name: "可选诊断统计" }).uncheck();
  await expect(
    page.getByRole("checkbox", { name: "可选诊断统计" }),
  ).not.toBeChecked();
  expect(requests).toHaveLength(2);
  expect(
    requests.every((r) => r.path === "/openonce/v1/chat/completions"),
  ).toBe(true);
});

test("defaults and providers: changing the default keeps the active turn on its snapshot; a cross-provider send asks once and cancelling keeps the draft; referenced connections cannot be deleted", async () => {
  await addConnection("甲家", "slow");
  await newChat();
  await input().fill("在甲家生成中改默认");
  await input().press("Enter");
  const turn = page.getByRole("article", { name: "助手回合" });
  await expect(turn.getByRole("status")).toHaveText("生成中");
  // While the turn streams, a second connection from another provider becomes the default.
  await addConnection("乙家", "stream", true, "deepseek");
  await expect(turn.getByText("甲家 · mock-model")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "本次连接" })).toHaveValue(
    "",
  );
  await expect(page.getByRole("article", { name: "助手消息" })).toHaveText(
    "第一段。第二段，回答结束。",
    { timeout: 15000 },
  );
  await expect(page.getByRole("combobox", { name: "本次连接" })).toContainText(
    "默认：乙家 · mock-model",
  );
  expect(requests.map((r) => r.path)).toEqual(["/slow/v1/chat/completions"]);

  // Sending the conversation to another provider needs one confirmation; cancel keeps the draft.
  await input().fill("换到乙家继续");
  await input().press("Enter");
  const confirm = page.getByRole("alertdialog", { name: "跨提供方发送确认" });
  await expect(confirm).toContainText("乙家（DeepSeek · mock-model）");
  await expect(confirm).toContainText("上一次使用自定义");
  await expect(confirm).toContainText("2 条消息");
  await page.screenshot({ path: "test-results/chat-cross-provider.png" });
  await confirm.getByRole("button", { name: "取消" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(input()).toHaveValue("换到乙家继续");
  await expect(page.getByRole("article", { name: "用户消息" })).toHaveCount(1);
  expect(requests).toHaveLength(1);
  await input().press("Enter");
  await confirm.getByRole("button", { name: "确认发送" }).click();
  await expect(page.getByRole("article", { name: "助手消息" })).toHaveCount(2);
  expect(requests[1].path).toBe("/stream/v1/chat/completions");
  expect((requests[1].body as { messages: unknown[] }).messages).toHaveLength(
    3,
  );
  // Same provider again: no second confirmation.
  await input().fill("再问乙家");
  await input().press("Enter");
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole("article", { name: "助手消息" })).toHaveCount(3);
  // An explicit per-conversation choice back to 甲家 asks again for that provider.
  await page
    .getByRole("combobox", { name: "本次连接" })
    .selectOption({ label: "甲家 · mock-model" });
  await input().fill("回到甲家");
  await input().press("Enter");
  await expect(confirm).toContainText("甲家（自定义 · mock-model）");
  await confirm.getByRole("button", { name: "确认发送" }).click();
  await expect(page.getByRole("article", { name: "助手消息" })).toHaveCount(4, {
    timeout: 15000,
  });
  expect(requests[3].path).toBe("/slow/v1/chat/completions");

  // Deleting a referenced connection is refused with a reason; history keeps the connection names.
  await goTo(page, "设置");
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "模型", exact: true })
    .click();
  const second = await openProvider(page, "乙家");
  // The default model is visibly protected even for a preset without a delete action.
  await expect(
    second
      .getByRole("group", { name: "模型 mock-model", exact: true })
      .getByRole("button", { name: "移除", exact: true }),
  ).toBeDisabled();
  const first = await openProvider(page, "甲家");
  await first.getByRole("button", { name: "删除提供方…", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(first).toHaveCount(0);
  await goTo(page, "聊天");
  await expect(page.getByRole("combobox", { name: "本次连接" })).toHaveValue(
    "",
  );
  await goTo(page, "运行记录");
  await expect(page.getByText("甲家 · mock-model").first()).toBeVisible();
});

test("quit dialog: while the real confirmation is open the business service stays alive and the turn keeps streaming", async () => {
  await addConnection("对话框期间", "open");
  await newChat();
  await input().fill("对话框打开时继续");
  await input().press("Enter");
  const turn = page.getByRole("article", { name: "助手回合" });
  await expect(turn.getByText("第一段。", { exact: false })).toBeVisible();
  const businessAlive = () =>
    app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .some((metric) => metric.name === "csthink-assistant business"),
    );
  expect(await businessAlive()).toBe(true);
  // A real (unpatched) dialog opens because a turn is active; SIGTERM asks Electron to quit.
  process.kill(app.process().pid!, "SIGTERM");
  await page.waitForTimeout(8000);
  expect(await businessAlive()).toBe(true);
  await expect(turn.getByRole("status")).toHaveText("生成中");
  await expect(page.getByText("业务服务已失联", { exact: false })).toHaveCount(
    0,
  );
  // The dialog cannot be answered from the test; end the process hard and recover on restart.
  app.process().kill("SIGKILL");
  await expect
    .poll(
      () => {
        try {
          process.kill(app.process().pid!, 0);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15000 },
    )
    .toBe(false);
  const restart = await launch();
  app = restart.application;
  page = restart.window;
  await expect(
    page.getByRole("article", { name: "助手回合" }).getByRole("status"),
  ).toHaveText("已中断");
});
