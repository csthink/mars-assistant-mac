import { goTo } from "./shell";
import { fetchProviderModels } from "./provider-ui";
import {
  test,
  expect,
  chromium,
  type Browser,
  type Page,
} from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Real-provider matrix driver. It only runs when CSTHINK_REAL_DATA_ROOT names a
 * data root whose connections already hold user-entered API keys (in the vault,
 * never in this process) and CSTHINK_REAL_CALLS_AUTHORIZED=1 records that the
 * user authorized real calls. It never types or reads a secret; it exports
 * non-secret execution records to CSTHINK_REAL_EVIDENCE_DIR.
 *
 * Playwright's Electron launcher forces --use-mock-keychain, under which the
 * real macOS keychain key is unavailable and the user's vault cannot be
 * decrypted. The client is therefore started directly and driven over CDP.
 */
const root = process.env.CSTHINK_REAL_DATA_ROOT;
const authorized = process.env.CSTHINK_REAL_CALLS_AUTHORIZED === "1";
const evidenceDir = process.env.CSTHINK_REAL_EVIDENCE_DIR;
test.skip(
  !root || !authorized || !evidenceDir,
  "Real provider runs need CSTHINK_REAL_DATA_ROOT, CSTHINK_REAL_CALLS_AUTHORIZED=1 and CSTHINK_REAL_EVIDENCE_DIR",
);
test.setTimeout(900_000);

let child: ChildProcess;
let browser: Browser;
let page: Page;
const electronBinary = resolve(
  "node_modules/electron/dist",
  readFileSync("node_modules/electron/path.txt", "utf8").trim(),
);
async function launch() {
  const process_ = spawn(
    electronBinary,
    [resolve("."), `--data-root=${root}`, "--remote-debugging-port=0"],
    { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] },
  );
  const endpoint = await new Promise<string>((done, fail) => {
    let buffer = "";
    const timer = setTimeout(
      () => fail(new Error("DevTools endpoint not announced")),
      30_000,
    );
    process_.stderr?.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    });
    process_.on("exit", () => fail(new Error("Electron exited early")));
  });
  const connection = await chromium.connectOverCDP(endpoint);
  const start = Date.now();
  let window: Page | undefined;
  while (!window && Date.now() - start < 30_000) {
    window = connection
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().endsWith("index.html"));
    if (!window) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!window) throw new Error("Main window not found over CDP");
  await expect(
    window
      .locator(".home-header")
      .getByRole("button", { name: "新建对话", exact: true }),
  ).toBeEnabled();
  return { process_, connection, window };
}
async function shutdown() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
async function openConnections() {
  await goTo(page, "设置");
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "模型", exact: true })
    .click();
}
async function newChatWith(connectionName: string) {
  await goTo(page, "聊天");
  await page
    .getByRole("button", { name: "新建对话", exact: true })
    .first()
    .click();
  const select = page.getByRole("combobox", { name: "本次连接" });
  await expect(select).toBeEnabled();
  const labels = await select.locator("option").allTextContents();
  const label = labels.find((l) => l.startsWith(`${connectionName} · `));
  if (!label) throw new Error(`No option for ${connectionName}: ${labels}`);
  await select.selectOption({ label });
}
const input = () => page.getByRole("textbox", { name: "输入草稿" });
function exportRecords(name: string) {
  const db = new DatabaseSync(
    `file:${resolve(root!, "state.sqlite")}?mode=ro`,
    { open: true, readOnly: true },
  );
  try {
    const connections = db
      .prepare(
        "SELECT name, provider, base_url AS baseUrl, model, secret_ref IS NOT NULL AS hasSecret, models_fetched_at AS modelsFetchedAt, models_error AS modelsError, json_array_length(models_json) AS modelCount FROM connections ORDER BY created_at",
      )
      .all();
    const executions = db
      .prepare(
        `SELECT e.id, e.kind, e.state, e.attempt, e.error_class AS errorClass, e.error_message AS errorMessage, e.created_at AS createdAt, e.ended_at AS endedAt, length(e.partial_text) AS partialLength,
                COALESCE(json_extract(t.connection_snapshot,'$.name'), c.name) AS connection, COALESCE(json_extract(t.connection_snapshot,'$.provider'), c.provider) AS provider, COALESCE(json_extract(t.connection_snapshot,'$.model'), c.model) AS model
         FROM executions e LEFT JOIN turns t ON t.id = e.turn_id LEFT JOIN connections c ON c.id = e.connection_id ORDER BY e.created_at`,
      )
      .all();
    const events = db
      .prepare(
        "SELECT seq, execution_id AS executionId, kind, at, json_extract(snapshot,'$.provider') AS provider, json_extract(snapshot,'$.model') AS model, payload FROM run_events ORDER BY seq",
      )
      .all();
    mkdirSync(evidenceDir!, { recursive: true });
    writeFileSync(
      resolve(evidenceDir!, name),
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          connections,
          executions,
          events,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    db.close();
  }
}

test.beforeAll(async () => {
  const started = await launch();
  child = started.process_;
  browser = started.connection;
  page = started.window;
});
test.afterAll(async () => {
  // A failed run may leave a turn open; the graceful path already ran on success, so end hard here.
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) child.kill("SIGKILL");
});

test("real providers: model list, streamed answer with stop, follow-up, then crash recovery on one provider", async () => {
  await openConnections();
  const names = await page.evaluate(async () => {
    const r = await window.desktop.command({ type: "snapshot" });
    if (!r.ok) throw new Error(r.message);
    return r.snapshot.connections
      .filter(
        (c) => c.enabled && c.secretRef && c.models.some((m) => m.enabled),
      )
      .map((c) => c.name);
  });
  const only = process.env.CSTHINK_REAL_ONLY;
  const selected = only ? names.filter((n) => n === only) : names;
  expect(selected.length).toBeGreaterThan(0);
  for (const name of selected) await fetchProviderModels(page, name);
  await page.screenshot({
    path: resolve(evidenceDir!, "settings-after-model-list.png"),
  });
  for (const name of selected) {
    await newChatWith(name);
    await input().fill(
      "请先用一句话介绍你自己，然后从一慢慢数到一百，每个数字单独一行。",
    );
    await input().press("Enter");
    const turn = page.getByRole("article", { name: "助手回合" });
    await expect(turn.getByRole("status")).toHaveText("生成中", {
      timeout: 60_000,
    });
    await expect(turn.locator("p").first()).not.toHaveText("", {
      timeout: 60_000,
    });
    await turn.getByRole("button", { name: "停止" }).click();
    await expect(turn.getByRole("status")).toHaveText("已停止", {
      timeout: 30_000,
    });
    await page.screenshot({
      path: resolve(evidenceDir!, `stopped-${name}.png`),
    });
    await input().fill("请只回复两个字：收到");
    await input().press("Enter");
    await expect(
      page.getByRole("article", { name: "助手消息" }).last(),
    ).toBeVisible({ timeout: 90_000 });
    await page.screenshot({
      path: resolve(evidenceDir!, `completed-${name}.png`),
    });
  }
  // Crash recovery on the first provider: kill the host mid-answer, relaunch, retry from pending.
  await newChatWith(selected[0]);
  await input().fill("请从一慢慢数到一百，每个数字单独一行。");
  await input().press("Enter");
  const running = page.getByRole("article", { name: "助手回合" });
  await expect(running.getByRole("status")).toHaveText("生成中", {
    timeout: 60_000,
  });
  await expect(running.locator("p").first()).not.toHaveText("", {
    timeout: 60_000,
  });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  await browser.close().catch(() => {});
  child.kill("SIGKILL");
  await exited;
  const restart = await launch();
  child = restart.process_;
  browser = restart.connection;
  page = restart.window;
  await expect(
    page.getByRole("article", { name: "助手回合" }).getByRole("status"),
  ).toHaveText("已中断");
  await goTo(page, "待处理");
  const item = page
    .getByRole("list", { name: "待处理事项" })
    .getByRole("listitem")
    .filter({ hasText: "回合被中断" })
    .first();
  await expect(item).toBeVisible();
  await page.screenshot({
    path: resolve(evidenceDir!, "pending-after-crash.png"),
  });
  await item.getByRole("button", { name: "重试" }).click();
  await expect(item).toHaveCount(0);
  await goTo(page, "聊天");
  await expect(
    page.getByRole("article", { name: "助手消息" }).last(),
  ).toBeVisible({ timeout: 180_000 });
  await goTo(page, "运行记录");
  await page.screenshot({ path: resolve(evidenceDir!, "run-log.png") });
  await browser.close().catch(() => {});
  await shutdown();
  exportRecords("records.json");
});
