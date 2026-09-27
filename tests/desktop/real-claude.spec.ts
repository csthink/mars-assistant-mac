import { test, expect, type ElectronApplication } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, isAbsolute, relative } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { launchLocal } from "./local-client";
import { goTo } from "./shell";
import { stopClaudeTestTurns } from "./claude-test-cleanup";
import { openProvider } from "./provider-ui";
const root = process.env.CSTHINK_REAL_DATA_ROOT;
const evidence = process.env.CSTHINK_REAL_EVIDENCE_DIR;
const model = process.env.CSTHINK_CLAUDE_MODEL;
const authorized =
  process.env.CSTHINK_REAL_CALLS_AUTHORIZED === "1" &&
  process.env.CSTHINK_REAL_TASK === "feature-t7";
test.skip(
  !authorized || !root || !evidence || !model,
  "feature-t7 requires explicit recorded real-call authorization, model and isolated data/evidence directories",
);
test.setTimeout(900000);
test.use({ trace: "off", actionTimeout: 30000 });
/** CLI Keychain access belongs to its separate process. The app needs no API-key vault in this suite. */
test("real claude: model test, question, selected material, rejection, stop and native recovery", async () => {
  if (
    !isAbsolute(root!) ||
    !isAbsolute(evidence!) ||
    !relative(resolve("."), root!).startsWith("..")
  )
    throw Error("Real data must be outside the checkout");
  mkdirSync(root!, { recursive: true });
  mkdirSync(evidence!, { recursive: true });
  const budgetPath = join(evidence!, "budget.json");
  const priorEvidence = process.env.CSTHINK_CLAUDE_RESUME_EVIDENCE;
  let initialTurns = 0;
  let startedAt = Date.now();
  if (priorEvidence) {
    const previous = JSON.parse(
      readFileSync(join(priorEvidence, "result.json"), "utf8"),
    );
    const input = JSON.parse(
      readFileSync(join(priorEvidence, "input.json"), "utf8"),
    );
    const previousBudget = JSON.parse(
      readFileSync(join(priorEvidence, "budget.json"), "utf8"),
    );
    if (
      input.data_root !== root ||
      previous.result !== "FAIL" ||
      previous.checks.map((c: { name: string }) => c.name).join(",") !==
        "settings-model-test,question-answer" ||
      !previous.error.includes("仍在提取正文") ||
      previousBudget.turns !== 3
    )
      throw Error("Unsupported real validation continuation");
    for (const [path, sha] of Object.entries(input.inputs)) {
      if (path === "tests/desktop/real-claude.spec.ts") continue;
      if (createHash("sha256").update(readFileSync(path)).digest("hex") !== sha)
        throw Error("Previous real validation product inputs changed");
    }
    const db = new DatabaseSync(join(root!, "state.sqlite"), {
      readOnly: true,
    });
    try {
      const runs = db.prepare("SELECT kind,state FROM executions").all();
      if (
        runs.length !== 2 ||
        runs.some((r) => r.state !== "completed") ||
        db.prepare("SELECT count(*) AS count FROM claude_runs").get()?.count !==
          2
      )
        throw Error(
          "Existing real execution count differs from continuation budget",
        );
    } finally {
      db.close();
    }
    initialTurns = 2;
    startedAt = previousBudget.startedAt;
  }
  const budget = { startedAt, turns: initialTurns };
  test.setTimeout(Math.max(1, 900000 - (Date.now() - startedAt)));
  writeFileSync(budgetPath, JSON.stringify(budget), { flag: "wx" });
  const spend = () => {
    if (budget.turns >= 7 || Date.now() - budget.startedAt > 900000)
      throw Error("Authorized real-call budget exhausted");
    budget.turns++;
    writeFileSync(budgetPath, JSON.stringify(budget));
  };
  const checks: Array<{ name: string; at: string }> = [];
  let app: ElectronApplication | undefined;
  const result: {
    model: string;
    result: string;
    checks: typeof checks;
    error?: string;
    scope: string;
  } = {
    model: model!,
    result: "NOT RUN",
    checks,
    scope: priorEvidence
      ? "Remaining five stages; earlier connection and question results remain in the preceding FAIL run"
      : "All seven real stages",
  };
  const save = () =>
    writeFileSync(
      join(evidence!, "result.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
  const checked = (name: string) => {
    checks.push({ name, at: new Date().toISOString() });
    save();
  };
  try {
    app = await launchLocal({
      args: [resolve("."), `--data-root=${root}`],
      cwd: resolve("."),
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    });
    const page = await app.firstWindow();
    const snapshot = () =>
      page.evaluate(async () => {
        const r = await window.desktop.command({ type: "snapshot" });
        if (!r.ok) throw Error(r.message);
        return r.snapshot;
      });
    await expect(
      page
        .locator(".home-header")
        .getByRole("button", { name: "新建对话", exact: true }),
    ).toBeEnabled();
    await openProvider(page, "Claude Code");
    const section = page.getByRole("region", {
      name: "Claude Code 连接",
      exact: true,
    });
    await expect(
      section.getByText("Claude 订阅登录", { exact: true }),
    ).toBeVisible();
    const entry = section.getByRole("group", {
      name: `模型 ${model}`,
      exact: true,
    });
    const toggle = entry.getByRole("checkbox", {
      name: `启用模型 ${model}`,
      exact: true,
    });
    if (!(await toggle.isChecked())) {
      await toggle.click();
      const confirmation = section.getByRole("button", {
        name: "确认配置 Claude Code",
        exact: true,
      });
      await expect
        .poll(
          async () =>
            (await toggle.isChecked()) || (await confirmation.isVisible()),
        )
        .toBe(true);
      if (!(await toggle.isChecked())) await confirmation.click();
      await expect(toggle).toBeChecked();
    }
    if (
      await entry
        .getByRole("button", { name: "设为默认", exact: true })
        .isVisible()
    )
      await entry
        .getByRole("button", { name: "设为默认", exact: true })
        .click();
    if (!priorEvidence) {
      spend();
      await entry
        .getByRole("button", { name: "测试模型", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await snapshot()).connections
              .find((c) => c.provider === "claude")
              ?.models.find((m) => m.model === model)?.lastTest?.state,
          { timeout: 90000 },
        )
        .toBe("completed");
      checked("settings-model-test");
    }
    const newConversation = async () => {
      await goTo(page, "聊天");
      await page
        .locator(".home-header")
        .getByRole("button", { name: "新建对话", exact: true })
        .click();
    };
    const send = async (text: string) => {
      const submitted = (await snapshot()).events
        .filter((e) => e.kind === "submitted")
        .map((e) => e.executionId);
      spend();
      await page.getByRole("textbox", { name: "输入草稿" }).fill(text);
      await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect
        .poll(async () =>
          (await snapshot()).events.some(
            (e) => e.kind === "submitted" && !submitted.includes(e.executionId),
          ),
        )
        .toBe(true);
    };
    const settled = () =>
      expect
        .poll(async () => (await snapshot()).activeTurns.length, {
          timeout: 120000,
        })
        .toBe(0);
    if (!priorEvidence) {
      await newConversation();
      const qa = "T7_QA_" + randomUUID();
      await send("请只回复以下字符串：" + qa);
      await expect(
        page.getByRole("article", { name: "助手消息" }),
      ).toContainText(qa, { timeout: 90000 });
      await settled();
      checked("question-answer");
    }
    for (const allow of [true, false]) {
      await newConversation();
      const marker = "T7_MATERIAL_" + randomUUID();
      const file = join(evidence!, `material-${allow}.txt`);
      writeFileSync(file, marker);
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [path],
        })) as typeof dialog.showOpenDialog;
      }, file);
      await page.getByRole("button", { name: "添加资料", exact: true }).click();
      await expect
        .poll(async () => (await snapshot()).draftAttachments.length)
        .toBe(1);
      await page
        .getByRole("textbox", { name: "输入草稿" })
        .fill(
          "请使用产品资料读取工具读取选定文件，只回复文件中的标记。如果读取被拒绝，明确说明无法读取，不要猜测。",
        );
      await expect(page.getByTestId("save-state")).toHaveText("草稿已保存");
      await expect(
        page.getByRole("button", { name: "发送消息", exact: true }),
      ).toBeEnabled();
      spend();
      await page.evaluate(async () => {
        const r = await window.desktop.command({ type: "snapshot" });
        if (!r.ok) throw Error(r.message);
        const c = r.snapshot.connections.find((c) => c.provider === "claude")!;
        const reply = await window.desktop.command({
          type: "submitTurn",
          requestId: crypto.randomUUID(),
          conversationId: r.snapshot.selected.main!,
          connectionId: c.id,
          model: r.snapshot.settings.defaultModelId!,
          text: "请使用产品资料读取工具读取选定文件，只回复文件中的标记。如果读取被拒绝，明确说明无法读取，不要猜测。",
          materialMode: "tools",
        });
        if (!reply.ok) throw Error(reply.message);
      });
      await page
        .getByRole("button", { name: "到待处理确认资料读取", exact: true })
        .click({ timeout: 90000 });
      await page
        .getByRole("button", {
          name: allow ? "允许本次读取" : "拒绝读取",
          exact: true,
        })
        .click();
      await settled();
      const state = await snapshot();
      expect(
        state.toolOperations.some(
          (o) => o.state === (allow ? "completed" : "denied"),
        ),
      ).toBe(true);
      expect(JSON.stringify(state.events)).not.toContain(marker);
      await goTo(page, "聊天");
      if (allow)
        await expect(
          page.getByRole("article", { name: "助手消息" }),
        ).toContainText(marker);
      else
        await expect(
          page.getByRole("article", { name: "助手消息" }),
        ).not.toContainText(marker);
      checked(allow ? "material-allowed" : "material-denied");
    }
    await newConversation();
    await send(
      "请依次输出从 1 到 500 的编号，每行加一句不同的简短中文说明，不调用工具。",
    );
    await expect(
      page.getByRole("article", { name: "助手回合" }),
    ).not.toHaveText("", { timeout: 90000 });
    await page.getByRole("button", { name: "停止回合", exact: true }).click();
    await settled();
    expect(
      (await snapshot()).events.some(
        (e) => e.kind === "stopped" && e.connection?.provider === "claude",
      ),
    ).toBe(true);
    checked("native-stop");
    // Fault injection is confined to the next product-owned real CLI after its first actual delta.
    await app.evaluate(() => {
      const cp = process.mainModule!.require(
        "node:child_process",
      ) as typeof import("node:child_process");
      const original = cp.spawn;
      let armed = true;
      cp.spawn = function (...args: Parameters<typeof original>) {
        const child = original(...args);
        const argv = args[1];
        const opts = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
        if (
          armed &&
          Array.isArray(argv) &&
          argv.includes("--session-id") &&
          opts?.env?.ANTHROPIC_API_KEY !== "SYNTHETIC_ONLY_NOT_REAL"
        ) {
          armed = false;
          let buffer = "";
          child.stdout?.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            let end: number;
            while ((end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              try {
                const m = JSON.parse(line);
                if (
                  m.type === "stream_event" &&
                  m.event?.delta?.type === "text_delta"
                ) {
                  child.kill("SIGTERM");
                  cp.spawn = original;
                }
              } catch {
                /* only inspect structured frames */
              }
            }
          });
        }
        return child;
      } as typeof original;
    });
    await newConversation();
    await send("请输出从 1 到 100 的编号，每个编号单独一行。");
    await settled();
    const failed = await snapshot(),
      pending = failed.pendingItems.find((p) => p.kind === "failed_turn");
    expect(pending).toBeTruthy();
    const prior = failed.events.find(
      (e) =>
        e.kind === "native_session" && e.executionId === pending?.executionId,
    )?.payload.claude;
    expect(prior).toBeTruthy();
    checked("owned-process-failure");
    spend();
    await page.evaluate(async (id) => {
      const r = await window.desktop.command({
        type: "resolvePending",
        id,
        action: "retry",
      });
      if (!r.ok) throw Error(r.message);
    }, pending!.id);
    await settled();
    const recovered = await snapshot();
    expect(recovered.pendingItems.some((p) => p.id === pending!.id)).toBe(
      false,
    );
    const resumed = recovered.events.find(
      (e) =>
        e.kind === "native_session" &&
        e.payload.claude &&
        (e.payload.claude as { threadId: string }).threadId ===
          (prior as { threadId: string }).threadId &&
        e.executionId !== pending!.executionId,
    );
    expect(resumed).toBeTruthy();
    expect(
      recovered.events.some(
        (e) =>
          e.kind === "completed" &&
          e.executionId === resumed!.executionId &&
          e.connection?.provider === "claude",
      ),
    ).toBe(true);
    expect(
      recovered.pendingItems.some(
        (p) => p.executionId === resumed!.executionId,
      ),
    ).toBe(false);
    checked("native-resume");
    await page.screenshot({ path: join(evidence!, "real-claude-result.png") });
    result.result = "PASS";
    save();
  } catch (error) {
    result.result = "FAIL";
    result.error = error instanceof Error ? error.message : "Unknown failure";
    save();
    throw error;
  } finally {
    if (app) {
      await stopClaudeTestTurns(app, root!);
      const client = app;
      const child = client.process();
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, 5000);
      try {
        await client.close();
      } finally {
        clearTimeout(timer);
      }
    }
    const spent = JSON.parse(readFileSync(budgetPath, "utf8"));
    expect(spent.turns).toBeLessThanOrEqual(7);
  }
});
