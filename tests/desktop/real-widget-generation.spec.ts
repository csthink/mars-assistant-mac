import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { launchReal, shutdownReal, type RealClient } from "./real-client";
import { goTo } from "./shell";
import type { Command, Snapshot } from "../../src/shared/protocol";

const required = [
  "codex",
  "claude",
  "zhipu",
  "deepseek",
  "openrouter",
  "siliconflow",
] as const;
const inputs = [
  {
    group: "A",
    generation:
      "创建一个七格日常饮水记录控件，使用七个可访问的复选框逐格勾选并保存；仅用本控件数据，刷新仍保持。提供标为「重置」的按钮和标为「确认重置」的确认操作。",
    foreground: "用一句话解释Unicode。",
  },
  {
    group: "B",
    generation:
      "创建一个四项阅读进度控件，每项有书名与进度滑块，显示总平均进度，仅用本控件数据。",
    foreground: "写一段约300字的短文介绍编译。",
  },
  {
    group: "C",
    generation:
      "创建一个每周习惯记录控件，三行习惯与七列日期，可独立勾选和保存每格。",
    foreground: "用一句话解释事务。",
  },
] as const;
interface Selection {
  provider: (typeof required)[number];
  connectionId: string;
  model: string;
}
interface Authorization {
  task: string;
  authorized: boolean;
  maxTurns: 36;
  root: string;
  evidence: string;
  selections: Selection[];
}
// Explicit private authorization file only. No defaults, no secrets, no model discovery calls.
function authorization(): Authorization {
  const path = process.env.CSTHINK_WIDGET_REAL_AUTHORIZATION;
  if (!path || !isAbsolute(path) || !existsSync(path))
    throw new Error(
      "NOT RUN: explicit absolute real-call authorization file required",
    );
  const value = JSON.parse(readFileSync(path, "utf8")) as Authorization;
  if (
    process.env.CSTHINK_REAL_CALLS_AUTHORIZED !== "1" ||
    value.task !== "mac-feature-t9" ||
    value.authorized !== true ||
    value.maxTurns !== 36 ||
    !isAbsolute(value.root) ||
    !isAbsolute(value.evidence) ||
    value.selections.length !== 6 ||
    [...value.selections.map((s) => s.provider)].sort().join() !==
      [...required].sort().join() ||
    value.selections.some((s) => !s.connectionId || !s.model)
  )
    throw new Error(
      "NOT RUN: authorization scope or six explicit model selections missing",
    );
  return value;
}
async function command(page: Page, c: Command): Promise<Snapshot> {
  const reply = await page.evaluate((c) => window.desktop.command(c), c);
  if (!reply.ok) throw new Error(reply.message);
  return reply.snapshot;
}
async function snapshot(page: Page) {
  return command(page, { type: "snapshot" });
}

test("real widget generation: six providers create original candidates with same-conversation concurrency and independent stops", async () => {
  test.setTimeout(4_500_000);
  const auth = authorization();
  if (existsSync(auth.evidence) && readdirSync(auth.evidence).length)
    throw new Error(
      "Evidence directory must be new or empty; failures are never overwritten",
    );
  mkdirSync(auth.evidence, { recursive: true, mode: 0o700 });
  let client: RealClient | undefined,
    turns = 0;
  const records: Record<string, unknown>[] = [];
  const save = () =>
    writeFileSync(
      join(auth.evidence, "result.json"),
      JSON.stringify(
        {
          task: auth.task,
          recordedAt: new Date().toISOString(),
          maxTurns: 36,
          submittedTurns: turns,
          automaticRetries: 0,
          counting:
            "one generation turn and one foreground turn per group; stopped and failed turns count; API foreground uses inline mode and no tool loop",
          usage:
            "provider token/cost usage is not exposed by current adapters; unavailable, not zero",
          records,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  const spend = () => {
    if (++turns > auth.maxTurns)
      throw new Error("Approved turn budget exhausted");
    save();
  };
  try {
    client = await launchReal(auth.root, { background: true });
    let page = client.page;
    const initial = await snapshot(page);
    if (
      initial.activeTurns.length ||
      initial.widgetGeneration?.tasks.length ||
      initial.conversations.length
    )
      throw new Error(
        "Use a dedicated configured data root without conversations, drafts or active work",
      );
    for (const selection of auth.selections) {
      const c = initial.connections.find(
        (c) => c.id === selection.connectionId,
      );
      if (
        !c ||
        !c.enabled ||
        c.provider !== selection.provider ||
        !c.models.some((m) => m.model === selection.model && m.enabled)
      )
        throw new Error(
          `Configured enabled model missing for ${selection.provider}`,
        );
    }
    for (const selection of auth.selections)
      for (const input of inputs) {
        const row: Record<string, unknown> = {
          provider: selection.provider,
          requestedModel: selection.model,
          group: input.group,
          generationInput: input.generation,
          foregroundInput: input.foreground,
          status: "RUNNING",
        };
        records.push(row);
        save();
        const conversationId = randomUUID(),
          draftId = randomUUID();
        let taskId: string | undefined, executionId: string | undefined;
        try {
          await command(page, { type: "create", id: conversationId });
          await command(page, {
            type: "createWidgetDraft",
            id: draftId,
            name: `${selection.provider} ${input.group}`,
            sourceConversationId: conversationId,
          });
          await command(page, {
            type: "saveWidgetDraft",
            id: draftId,
            name: `${selection.provider} ${input.group}`,
            input: input.generation,
            revision: 0,
          });
          spend();
          let state = await command(page, {
            type: "submitWidgetGeneration",
            draftId,
            revision: 1,
            requestId: randomUUID(),
            connectionId: selection.connectionId,
            model: selection.model,
          });
          taskId = state.widgetGeneration!.tasks.find(
            (t) => t.draftId === draftId,
          )!.id;
          await expect
            .poll(
              async () =>
                (await snapshot(page)).widgetGeneration!.tasks.find(
                  (t) => t.id === taskId,
                )!.state,
              { timeout: 30_000 },
            )
            .toBe("running");
          spend();
          state = await command(page, {
            type: "submitTurn",
            conversationId,
            requestId: randomUUID(),
            connectionId: selection.connectionId,
            model: selection.model,
            text: input.foreground,
            materialMode: "inline",
          });
          executionId = state.turns.find(
            (t) => t.conversationId === conversationId,
          )!.executionId;
          await expect
            .poll(
              async () =>
                (await snapshot(page)).turns.find(
                  (t) => t.executionId === executionId,
                )!.state,
              { timeout: 30_000 },
            )
            .toBe("running");
          state = await snapshot(page);
          expect(
            state.widgetGeneration!.tasks.find((t) => t.id === taskId)!.state,
          ).toBe("running");
          row.concurrentObservedAt = new Date().toISOString();
          save();
          if (input.group === "B")
            await command(page, { type: "stopExecution", executionId });
          if (input.group === "C")
            await command(page, { type: "stopWidgetGeneration", taskId });
          if (input.group === "A" || input.group === "C")
            await expect
              .poll(
                async () =>
                  (await snapshot(page)).turns.find(
                    (t) => t.executionId === executionId,
                  )!.state,
                { timeout: 60_000 },
              )
              .toBe("completed");
          if (input.group === "A")
            expect(
              (await snapshot(page)).widgetGeneration!.tasks.find(
                (t) => t.id === taskId,
              )!.state,
            ).toBe("running");
          if (input.group === "B")
            await expect
              .poll(
                async () =>
                  (await snapshot(page)).turns.find(
                    (t) => t.executionId === executionId,
                  )!.state,
                { timeout: 30_000 },
              )
              .toBe("stopped");
          await expect
            .poll(
              async () =>
                (await snapshot(page)).widgetGeneration!.tasks.find(
                  (t) => t.id === taskId,
                )!.state,
              { timeout: 180_000 },
            )
            .toBe(input.group === "C" ? "stopped" : "completed");
          state = await snapshot(page);
          const candidate = state.widgetGeneration!.candidates.find(
            (c) => c.taskId === taskId,
          );
          if (input.group === "C") expect(candidate).toBeUndefined();
          else {
            expect(candidate?.state).toBe("preview");
            expect(candidate!.differences.length).toBeGreaterThan(0);
            row.candidateDigest = candidate!.digest;
          }
          if (input.group === "A") {
            await command(page, { type: "selectWidgetDraft", id: draftId });
            await goTo(page, "控件");
            const view = () =>
              client!.browser
                .contexts()
                .flatMap((c) => c.pages())
                .find((p) => p.url().startsWith("csthink-widget:"));
            await expect.poll(() => !!view()).toBe(true);
            await expect(view()!.getByRole("checkbox")).toHaveCount(7);
            await view()!.getByRole("checkbox").first().check();
            await expect(view()!.getByRole("checkbox").first()).toBeChecked();
            await view()!
              .getByRole("button", { name: "重置", exact: true })
              .click();
            await view()!
              .getByRole("button", { name: "确认重置", exact: true })
              .click();
            await expect(
              view()!.getByRole("checkbox").first(),
            ).not.toBeChecked();
            await view()!.getByRole("checkbox").first().check();
            await view()!.screenshot({
              path: join(
                auth.evidence,
                `${selection.provider}-actual-candidate.png`,
              ),
            });
            await page
              .getByRole("button", { name: "保留控件", exact: true })
              .click();
            await page
              .getByRole("button", { name: "确认保留", exact: true })
              .click();
            await expect(
              page.getByText("已保留到控件。编辑历史继续保存。"),
            ).toBeVisible();
            const formal = (
              await snapshot(page)
            ).widgetGeneration!.widgets.find(
              (w) => w.candidateId === candidate!.id,
            )!;
            row.widgetId = formal.id;
            const previous = client;
            client = undefined;
            await shutdownReal(previous, true);
            client = await launchReal(auth.root, { background: true });
            page = client.page;
            await goTo(page, "控件");
            await expect.poll(() => !!view()).toBe(true);
            await expect(view()!.getByRole("checkbox").first()).toBeChecked();
            expect(
              (await snapshot(page)).widgetGeneration!.widgets.find(
                (w) => w.id === formal.id,
              ),
            ).toBeTruthy();
          }
          row.status = "PASS";
        } catch (error) {
          row.status = "FAIL";
          row.error = error instanceof Error ? error.message : "check failed";
          throw error;
        } finally {
          const state = await snapshot(page);
          const task = state.widgetGeneration!.tasks.find(
              (t) => t.id === taskId,
            ),
            turn = state.turns.find((t) => t.executionId === executionId);
          row.generation = task && {
            id: task.id,
            state: task.state,
            attempt: task.attempt,
            model: task.connection.model,
            provider: task.connection.provider,
            createdAt: task.createdAt,
            endedAt: task.endedAt,
            error: task.error,
            partialChars: task.partialText.length,
          };
          row.foreground = turn && {
            id: turn.id,
            state: turn.state,
            attempt: turn.attempt,
            model: turn.connection.model,
            provider: turn.connection.provider,
            createdAt: turn.createdAt,
            endedAt: turn.endedAt,
            error: turn.errorMessage,
            partialChars: turn.partialText.length,
          };
          save();
          if (task && ["queued", "running", "stopping"].includes(task.state))
            await command(page, {
              type: "stopWidgetGeneration",
              taskId: task.id,
            });
          if (
            turn &&
            ["queued", "running", "awaiting_authorization"].includes(turn.state)
          )
            await command(page, {
              type: "stopExecution",
              executionId: turn.executionId,
            });
        }
      }
  } finally {
    save();
    await shutdownReal(client, true);
  }
});
test.use({ trace: "off", screenshot: "off", actionTimeout: 30_000 });
