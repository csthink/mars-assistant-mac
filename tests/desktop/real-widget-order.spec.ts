import { test, expect, type Page } from "@playwright/test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { closeLocal, launchLocal } from "./local-client";
import { goTo } from "./shell";
import { addProvider, openProvider } from "./provider-ui";
import { seedRetainedWidgets } from "./widget-generation-fixture";

/*
 * mac-feature-t11 V-16: WB-02 Agent ordering against a real API model. Runs only with an explicit private
 * authorization file and CSTHINK_REAL_CALLS_AUTHORIZED=1; without them it sends nothing. The client starts in
 * the background on a disposable data root with Playwright's mock keychain, so the macOS keychain and any
 * installed copy of the app are never touched. Every model request goes through a loopback forwarder that
 * forwards only POST chat/completions to the authorized provider, counts requests and refuses locally once the
 * authorized count is reached; it records request and response bodies but never the authorization header.
 */
interface OrderRealAuthorization {
  task: "mac-feature-t11";
  authorized: true;
  provider: "deepseek";
  model: string;
  maxRequests: number;
  evidence: string;
}
const upstream = { host: "api.deepseek.com", prefix: "" };
const names = ["天气", "便笺", "计时", "便笺", "汇率"];

function authorization(): OrderRealAuthorization {
  const path = process.env.CSTHINK_ORDER_REAL_AUTHORIZATION;
  if (!path || !isAbsolute(path) || !existsSync(path))
    throw new Error(
      "NOT RUN: explicit absolute real-call authorization file required",
    );
  const a = JSON.parse(readFileSync(path, "utf8")) as OrderRealAuthorization;
  if (
    process.env.CSTHINK_REAL_CALLS_AUTHORIZED !== "1" ||
    Object.keys(a).sort().join(",") !==
      "authorized,evidence,maxRequests,model,provider,task" ||
    a.task !== "mac-feature-t11" ||
    a.authorized !== true ||
    a.provider !== "deepseek" ||
    typeof a.model !== "string" ||
    !/^[\w.-]{1,80}$/.test(a.model) ||
    !Number.isSafeInteger(a.maxRequests) ||
    a.maxRequests < 1 ||
    a.maxRequests > 7 ||
    typeof a.evidence !== "string" ||
    !isAbsolute(a.evidence)
  )
    throw new Error("NOT RUN: invalid authorization scope or request budget");
  if (!process.env.DEEPSEEK_API_KEY)
    throw new Error("NOT RUN: DEEPSEEK_API_KEY must be read in at run time");
  return a;
}

interface Exchange {
  index: number;
  path: string;
  forwarded: boolean;
  status: number | null;
  request: unknown;
  response: string;
  milliseconds: number;
}
function forwarder(maxRequests: number) {
  const exchanges: Exchange[] = [];
  let forwarded = 0;
  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (part: Buffer) => chunks.push(part));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      const started = Date.now();
      const record: Exchange = {
        index: exchanges.length + 1,
        path: `${incoming.method} ${incoming.url}`,
        forwarded: false,
        status: null,
        request: parse(body.toString("utf8")),
        response: "",
        milliseconds: 0,
      };
      exchanges.push(record);
      const refuse = (status: number, message: string) => {
        record.status = status;
        record.response = message;
        outgoing.writeHead(status, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: { message } }));
      };
      if (
        incoming.method !== "POST" ||
        incoming.url !== "/deepseek/chat/completions"
      )
        return refuse(404, "not forwarded by the authorized test forwarder");
      if (forwarded >= maxRequests)
        return refuse(429, "authorized request budget reached; not forwarded");
      forwarded++;
      record.forwarded = true;
      const upstreamRequest = httpsRequest(
        {
          host: upstream.host,
          path: `${upstream.prefix}/chat/completions`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: header(incoming, "authorization"),
            "content-length": body.length,
          },
        },
        (reply) => {
          record.status = reply.statusCode ?? null;
          outgoing.writeHead(reply.statusCode ?? 502, {
            "content-type": reply.headers["content-type"] ?? "text/plain",
          });
          reply.on("data", (part: Buffer) => {
            if (record.response.length < 65_536)
              record.response += part.toString("utf8");
            outgoing.write(part);
          });
          reply.on("end", () => {
            record.milliseconds = Date.now() - started;
            outgoing.end();
          });
        },
      );
      upstreamRequest.on("error", (error) => {
        record.response = `forward error: ${error.message}`;
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      upstreamRequest.end(body);
    });
  });
  return { server, exchanges, count: () => forwarded };
}
function header(message: IncomingMessage, name: string) {
  const value = message.headers[name];
  return Array.isArray(value) ? value[0] : (value ?? "");
}
function parse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
}

const stored = (data: string) => {
  const db = new DatabaseSync(join(data, "state.sqlite"), { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT id,name FROM saved_widgets ORDER BY position")
        .all() as { id: string; name: string }[]
    ).map((r) => ({ ...r }));
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
  await page.getByRole("textbox", { name: "输入草稿" }).fill(text);
  await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  // The turn has ended when the business service reports no active turn.
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const reply = await window.desktop.command({ type: "snapshot" });
          return reply.ok ? reply.snapshot.activeTurns.length : -1;
        }),
      { timeout: 180_000 },
    )
    .toBe(0);
  const answer = page.getByRole("article", { name: "助手消息" }).last();
  return {
    answer: (await answer.innerText()).trim(),
    cards: await page
      .getByRole("list", { name: "工作台操作结果" })
      .getByRole("listitem")
      .allInnerTexts()
      .catch(() => [] as string[]),
  };
}

test("real widget order: an authorized API model is confirmed by its own check, moves the named widget, and asks before moving a shared name", async () => {
  test.setTimeout(900_000);
  const auth = authorization();
  if (existsSync(auth.evidence) && readdirSync(auth.evidence).length)
    throw new Error(
      "Evidence directory must be new or empty; failures are never overwritten",
    );
  mkdirSync(auth.evidence, { recursive: true, mode: 0o700 });
  mkdirSync(".test-data/disposable", { recursive: true });
  const data = mkdtempSync(resolve(".test-data/disposable/real-order-"));
  seedRetainedWidgets(data, names);
  const before = stored(data);
  const { server, exchanges, count } = forwarder(auth.maxRequests);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const result: Record<string, unknown> = {
    task: auth.task,
    provider: auth.provider,
    model: auth.model,
    maxRequests: auth.maxRequests,
    automaticRetries: 0,
    before,
  };
  const save = () =>
    writeFileSync(
      join(auth.evidence, "result.json"),
      JSON.stringify(
        {
          ...result,
          recordedAt: new Date().toISOString(),
          forwardedRequests: count(),
          exchanges,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
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
    await addProvider(page, {
      name: "DeepSeek 实测",
      url: `http://127.0.0.1:${port}/deepseek`,
      provider: "custom",
      model: auth.model,
      secret: process.env.DEEPSEEK_API_KEY!,
      makeDefault: true,
    });
    // 1. The tool call check, started only by the click.
    const provider = await openProvider(page, "DeepSeek 实测");
    const row = provider.getByRole("group", {
      name: `模型 ${auth.model}`,
      exact: true,
    });
    await row.getByRole("button", { name: "能力与预算", exact: true }).click();
    expect(count()).toBe(0);
    await row
      .getByRole("button", { name: "检测工具调用", exact: true })
      .click();
    await expect(row.getByText(/工具调用检测：(成功|失败)/)).toBeVisible({
      timeout: 120_000,
    });
    result.check = {
      capability: await row.getByTestId(/^tools-/).innerText(),
      outcome: await row.getByText(/工具调用检测：/).innerText(),
    };
    save();
    await expect(row.getByText(/工具调用：已确认/)).toBeVisible();
    // 2. A clear instruction moves the one widget named 汇率 to the front.
    result.clear = await ask(page, "把汇率移到第一个");
    result.afterClear = stored(data);
    save();
    // 3. A shared name: the product refuses or the model asks first; either way nothing moves.
    result.shared = await ask(page, "把便笺移到第二个");
    result.afterShared = stored(data);
    save();
    const clear = result.afterClear as { id: string; name: string }[];
    expect(clear[0].name).toBe("汇率");
    expect(clear.slice(1).map((w) => w.id)).toEqual(
      before.filter((w) => w.name !== "汇率").map((w) => w.id),
    );
    expect(result.afterShared).toEqual(result.afterClear);
    expect(
      (result.shared as { cards: string[] }).cards.some((c) =>
        c.startsWith("已将"),
      ),
    ).toBe(false);
    expect(count()).toBeLessThanOrEqual(auth.maxRequests);
  } finally {
    save();
    await closeLocal(app);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
