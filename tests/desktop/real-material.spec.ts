import { goTo } from "./shell";
import {
  ensureProviderModel,
  fetchProviderModels,
  openProvider,
} from "./provider-ui";
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchReal, shutdownReal, type RealClient } from "./real-client";
import { textPdf } from "./samples";

/**
 * Real-provider material driver (feature-t3 V-08). Runs only against a data
 * root whose connections already hold user-entered keys, with the user's
 * authorization recorded in the environment. It types no secret and records
 * only non-secret execution data, answer excerpts and screenshots. Material is
 * synthetic: a generated PDF and the application's own tray icon PNG.
 */
const root = process.env.CSTHINK_REAL_DATA_ROOT;
const authorized = process.env.CSTHINK_REAL_CALLS_AUTHORIZED === "1";
const evidenceDir = process.env.CSTHINK_REAL_EVIDENCE_DIR;
test.skip(
  !root || !authorized || !evidenceDir,
  "Real material runs need CSTHINK_REAL_DATA_ROOT, CSTHINK_REAL_CALLS_AUTHORIZED=1 and CSTHINK_REAL_EVIDENCE_DIR",
);
test.setTimeout(1_200_000);

let client: RealClient;
let page: Page;
const secretWord = "PINEAPPLE-42";
const secondLine = "BLUE-LANTERN";
const results: Record<string, unknown> = {};
const selectedModels: Record<string, string> = {};
async function snapshotConnections() {
  return page.evaluate(async (selectedModels) => {
    const reply = await window.desktop.command({ type: "snapshot" });
    if (!reply.ok) throw new Error(reply.message);
    return reply.snapshot.connections.map((c) => {
      const m = c.models.find(
        (m) => m.model === (selectedModels[c.name] ?? c.model),
      );
      return {
        name: c.name,
        provider: c.provider,
        model: m?.model ?? c.model,
        imageInput: m?.imageInput ?? "unknown",
        imageInputCheckedAt: m?.imageInputCheckedAt ?? null,
        probe: m?.lastProbe
          ? {
              state: m.lastProbe.state,
              errorClass: m.lastProbe.errorClass,
              errorMessage: m.lastProbe.errorMessage,
            }
          : null,
        modelList: c.modelList.state === "fetched" ? c.modelList.models : null,
      };
    });
  }, selectedModels);
}
async function openConnections() {
  await goTo(page, "设置");
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "模型", exact: true })
    .click();
}
async function probeState(name: string) {
  const connection = (await snapshotConnections()).find((c) => c.name === name);
  return connection?.probe ?? null;
}
/** Waits for a new probe execution to reach a terminal state, not for an older result line. */
async function probe(name: string) {
  const model = (await snapshotConnections()).find(
    (c) => c.name === name,
  )!.model;
  const item = await openProvider(page, name);
  const row = item.getByRole("group", { name: `模型 ${model}`, exact: true });
  await row.getByRole("button", { name: "能力与预算", exact: true }).click();
  const before = await page.evaluate(
    async ({ name, model }) => {
      const r = await window.desktop.command({ type: "snapshot" });
      if (!r.ok) throw new Error(r.message);
      return r.snapshot.connections
        .find((c) => c.name === name)
        ?.models.find((m) => m.model === model)?.lastProbe?.executionId;
    },
    { name, model },
  );
  await row.getByRole("button", { name: "检测图片能力", exact: true }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(
          async ({ name, model }) => {
            const r = await window.desktop.command({ type: "snapshot" });
            if (!r.ok) throw new Error(r.message);
            const p = r.snapshot.connections
              .find((c) => c.name === name)
              ?.models.find((m) => m.model === model)?.lastProbe;
            return p ? `${p.executionId}:${p.state}` : "none";
          },
          { name, model },
        ),
      { timeout: 120_000 },
    )
    .toMatch(
      new RegExp(
        `^(?!${before ?? "none"}:).*:(completed|failed|stopped|interrupted)$`,
      ),
    );
  return probeState(name);
}
async function setModel(name: string, model: string) {
  await ensureProviderModel(page, name, model);
  selectedModels[name] = model;
}
async function newChatWith(connectionName: string) {
  await goTo(page, "聊天");
  await page
    .getByRole("button", { name: /^新建(聊天|对话)$/ })
    .first()
    .click();
  const select = page.getByRole("combobox", { name: "本次连接" });
  await expect(select).toBeEnabled();
  const current = (await snapshotConnections()).find(
    (c) => c.name === connectionName,
  )!;
  await select.selectOption({ label: `${connectionName} · ${current.model}` });
}
const input = () => page.getByRole("textbox", { name: "输入草稿" });
const addButton = () => page.getByRole("button", { name: "添加资料" });
async function answerAfterSend(prompt: string, timeout = 240_000) {
  const before = await page.getByRole("article", { name: "助手消息" }).count();
  await input().fill(prompt);
  await input().press("Enter");
  const confirm = page.getByRole("alertdialog", { name: "跨提供方发送确认" });
  if (await confirm.count())
    await confirm.getByRole("button", { name: "确认发送" }).click();
  const answers = page.getByRole("article", { name: "助手消息" });
  await expect(answers).toHaveCount(before + 1, { timeout });
  return answers.last().innerText();
}
function exportRecords() {
  const db = new DatabaseSync(
    `file:${resolve(root!, "state.sqlite")}?mode=ro`,
    { open: true, readOnly: true },
  );
  try {
    const executions = db
      .prepare(
        `SELECT e.id, e.kind, e.state, e.attempt, e.error_class AS errorClass, e.error_message AS errorMessage, e.created_at AS createdAt, e.ended_at AS endedAt, length(e.partial_text) AS partialLength,
                COALESCE(json_extract(t.connection_snapshot,'$.name'), c.name) AS connection, COALESCE(json_extract(t.connection_snapshot,'$.model'), c.model) AS model, t.omitted_images AS omittedImages
         FROM executions e LEFT JOIN turns t ON t.id = e.turn_id LEFT JOIN connections c ON c.id = e.connection_id
         WHERE e.created_at >= ? ORDER BY e.created_at`,
      )
      .all(results.startedAt as string);
    const events = db
      .prepare(
        "SELECT seq, execution_id AS executionId, kind, at, json_extract(snapshot,'$.model') AS model, payload FROM run_events WHERE at >= ? ORDER BY seq",
      )
      .all(results.startedAt as string);
    const attachments = db
      .prepare(
        "SELECT name, kind, size, status, reason, chars, pages, width, height, substr(sha256,1,8) AS version FROM attachments WHERE created_at >= ? ORDER BY created_at",
      )
      .all(results.startedAt as string);
    mkdirSync(evidenceDir!, { recursive: true });
    writeFileSync(
      resolve(evidenceDir!, "records.json"),
      JSON.stringify(
        {
          ...results,
          exportedAt: new Date().toISOString(),
          executions,
          events,
          attachments,
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
  results.startedAt = new Date().toISOString();
  client = await launchReal(root!);
  page = client.page;
});
test.afterAll(async () => {
  await shutdownReal(client, true);
  exportRecords();
});

test("real material: probe image capability on every saved connection, ask about a PDF and a PNG on a capable model, follow up, and see a text-only model refuse images", async () => {
  mkdirSync(evidenceDir!, { recursive: true });
  const user = resolve(evidenceDir!, "samples");
  mkdirSync(user, { recursive: true });
  writeFileSync(
    resolve(user, "brief.pdf"),
    textPdf(`The secret word is ${secretWord}. Second line: ${secondLine}.`, 2),
  );
  const star = readFileSync(resolve("dist/trayTemplate@2x.png"));
  writeFileSync(resolve(user, "star.png"), star);
  await openConnections();
  const initial = await snapshotConnections();
  results.connectionsBefore = initial;
  expect(initial.length).toBeGreaterThan(0);
  // Probe every connection as saved by the user.
  for (const connection of initial) await probe(connection.name);
  await page.screenshot({
    path: resolve(evidenceDir!, "probes-saved-models.png"),
    fullPage: true,
  });
  let after = await snapshotConnections();
  results.probesSavedModels = after;
  let capable = after.find((c) => c.imageInput === "verified");
  const textOnly = after.find((c) => c.imageInput === "unsupported");
  results.modelChange = null;
  if (!capable) {
    // Find a vision-capable model in the provider's own list for one connection; restore the model afterwards.
    const candidates: [RegExp, RegExp][] = [
      [/zhipu/, /glm-4\.?\d*v|glm-4v|4\.6v|4\.5v/i],
      [/siliconflow/, /Qwen.*VL|vl-|InternVL|GLM-4\.?\d*V/i],
      [/openrouter/, /gpt-4o|gemini.*flash|qwen.*vl|llama.*vision/i],
    ];
    for (const [providerPattern, modelPattern] of candidates) {
      const target = after.find((c) => providerPattern.test(c.provider));
      if (!target) continue;
      await fetchProviderModels(page, target.name);
      const listed =
        (await snapshotConnections()).find((c) => c.name === target.name)!
          .modelList ?? [];
      const model = listed.find((m) => modelPattern.test(m));
      if (!model) continue;
      await setModel(target.name, model);
      await probe(target.name);
      const probed = (await snapshotConnections()).find(
        (c) => c.name === target.name,
      )!;
      results.modelChange = {
        connection: target.name,
        originalModel: target.model,
        visionModel: model,
        probe: probed.probe,
        imageInput: probed.imageInput,
      };
      if (probed.imageInput === "verified") {
        capable = probed;
        break;
      }
    }
    after = await snapshotConnections();
  }
  await page.screenshot({
    path: resolve(evidenceDir!, "probes-final.png"),
    fullPage: true,
  });
  expect(capable, "no connection verified image input").toBeTruthy();
  expect(textOnly, "no connection measured as unsupported").toBeTruthy();
  // Capable model: PDF + PNG, then a follow-up that needs the PDF's second line.
  await newChatWith(capable!.name);
  await client.pickFiles([
    resolve(user, "brief.pdf"),
    resolve(user, "star.png"),
  ]);
  await addButton().click();
  const chips = page
    .getByRole("list", { name: "待发送资料" })
    .getByRole("listitem");
  await expect(chips).toHaveCount(2);
  await expect(
    chips.filter({ hasText: "brief.pdf" }).getByRole("status"),
  ).toHaveText(/2 页 · \d+ 字符/);
  await expect(
    chips.filter({ hasText: "star.png" }).getByRole("status"),
  ).toHaveText(/像素/);
  const first = await answerAfterSend(
    "请分别回答两个问题，各用一句话：1）资料 brief.pdf 里的 secret word 是什么？2）图片 star.png 里是什么图形、什么颜色的背景？",
  );
  await page.screenshot({
    path: resolve(evidenceDir!, `material-${capable!.name}.png`),
    fullPage: true,
  });
  const second = await answerAfterSend(
    "资料里 Second line 后面写的是什么？只回答那个词。",
  );
  await page.screenshot({
    path: resolve(evidenceDir!, `followup-${capable!.name}.png`),
    fullPage: true,
  });
  results.capable = {
    connection: capable!.name,
    model: capable!.model,
    firstAnswer: first,
    firstMentionsSecret: first.includes(secretWord),
    firstMentionsStarShape: /星|star|四角|four|sparkle|闪/i.test(first),
    followUpAnswer: second,
    followUpMentionsSecondLine: second.includes(secondLine),
  };
  expect(first).toContain(secretWord);
  expect(second).toContain(secondLine);
  // Text-only model: the image is refused before any request; the PDF alone is answered.
  await newChatWith(textOnly!.name);
  await client.pickFiles([resolve(user, "star.png")]);
  await addButton().click();
  await expect(chips).toHaveCount(1);
  await input().fill("图片里是什么？");
  await input().press("Enter");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("不支持图片输入");
  results.textOnly = {
    connection: textOnly!.name,
    model: textOnly!.model,
    imageRefusal: await alert.innerText(),
  };
  await page.screenshot({
    path: resolve(evidenceDir!, `refused-${textOnly!.name}.png`),
    fullPage: true,
  });
  await alert.getByRole("button", { name: "关闭提示" }).click();
  await chips
    .first()
    .getByRole("button", { name: /移除资料/ })
    .click();
  await client.pickFiles([resolve(user, "brief.pdf")]);
  await addButton().click();
  await expect(
    chips.filter({ hasText: "brief.pdf" }).getByRole("status"),
  ).toHaveText(/2 页 · \d+ 字符/);
  const textAnswer = await answerAfterSend(
    "资料 brief.pdf 里的 secret word 是什么？只回答那个词。",
  );
  (results.textOnly as Record<string, unknown>).pdfAnswer = textAnswer;
  (results.textOnly as Record<string, unknown>).pdfMentionsSecret =
    textAnswer.includes(secretWord);
  await page.screenshot({
    path: resolve(evidenceDir!, `pdf-${textOnly!.name}.png`),
    fullPage: true,
  });
  expect(textAnswer).toContain(secretWord);
  // Restore a changed model so the user's connection is as they left it (capability resets to unknown).
  if (results.modelChange) {
    const change = results.modelChange as {
      connection: string;
      originalModel: string;
    };
    await openConnections();
    await setModel(change.connection, change.originalModel);
  }
  results.connectionsAfter = await snapshotConnections();
});
