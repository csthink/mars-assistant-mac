import { goTo } from "./shell";
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchReal, shutdownReal, type RealClient } from "./real-client";
import {
  ensureProviderModel,
  fetchProviderModels,
  openProvider,
} from "./provider-ui";
import { validModel, terminalStates } from "../../src/shared/protocol";

// Exact IDs are chosen from the providers' real lists after authorization, never guessed by the driver.
const root = process.env.CSTHINK_REAL_DATA_ROOT;
const evidence = process.env.CSTHINK_REAL_EVIDENCE_DIR;
const authorized =
  process.env.CSTHINK_REAL_CALLS_AUTHORIZED === "1" &&
  process.env.CSTHINK_REAL_TASK === "feature-t25";
const pairsText = process.env.CSTHINK_REAL_MODEL_PAIRS;
test.skip(
  !root || !evidence || !authorized || !pairsText,
  "feature-t25 needs its own real-call authorization, data root, evidence directory and explicit model pairs",
);
test.setTimeout(600_000);
test.use({ trace: "off" });
for (const provider of ["zhipu", "deepseek", "openrouter", "siliconflow"]) {
  test(`real models: ${provider} model list, two model turns and independent image probes`, async () => {
    const pairs = JSON.parse(pairsText!) as Record<string, string[]>;
    const models = pairs[provider];
    expect(models).toHaveLength(2);
    expect(new Set(models).size).toBe(2);
    expect(models.every(validModel)).toBe(true);
    let client: RealClient | undefined;
    const record: Record<string, unknown> = {
      provider,
      models,
      startedAt: new Date().toISOString(),
      checks: [],
      result: "NOT RUN",
    };
    mkdirSync(evidence!, { recursive: true });
    const output = resolve(evidence!, `models-${provider}-${Date.now()}.json`);
    try {
      client = await launchReal(root!);
      const page = client.page;
      const snapshot = () =>
        page.evaluate(async () => {
          const r = await window.desktop.command({ type: "snapshot" });
          if (!r.ok) throw new Error(r.message);
          return r.snapshot;
        });
      const connection = (await snapshot()).connections.find(
        (c) => c.provider === provider,
      );
      expect(connection?.enabled).toBe(true);
      expect(!!connection?.secretRef).toBe(true);
      const name = connection!.name;
      record.connection = {
        id: connection!.id,
        name,
        baseUrl: connection!.baseUrl,
      };
      const list = await fetchProviderModels(page, name);
      record.modelList = list;
      expect(list.state).toBe("fetched");
      for (const model of models) await ensureProviderModel(page, name, model);
      await goTo(page, "聊天");
      await page
        .getByRole("button", { name: /^新建(聊天|对话)$/ })
        .first()
        .click();
      for (const model of models) {
        await page
          .getByRole("combobox", { name: "本次连接", exact: true })
          .selectOption({ label: `${name} · ${model}` });
        const before = (await snapshot()).turns.map((t) => t.id);
        await page
          .getByRole("textbox", { name: "输入草稿", exact: true })
          .fill("这是一条功能验证消息。请只回复：2 加 3 等于 5。");
        await page
          .getByRole("button", { name: "发送消息", exact: true })
          .click();
        await expect(
          page.getByRole("alertdialog", { name: "跨提供方发送确认" }),
        ).not.toBeVisible();
        await expect
          .poll(
            async () =>
              (await snapshot()).turns.some(
                (t) =>
                  !before.includes(t.id) && terminalStates.includes(t.state),
              ),
            { timeout: 240_000 },
          )
          .toBe(true);
        const turn = (await snapshot()).turns.find(
          (t) => !before.includes(t.id),
        )!;
        (record.checks as unknown[]).push({
          kind: "turn",
          model,
          actualModel: turn.connection.model,
          actualConnectionId: turn.connection.connectionId,
          actualBaseUrl: turn.connection.baseUrl,
          state: turn.state,
          errorClass: turn.errorClass,
          executionId: turn.executionId,
        });
        expect(turn.connection.connectionId).toBe(connection!.id);
        expect(turn.connection.baseUrl).toBe(connection!.baseUrl);
        expect(turn.connection.model).toBe(model);
        expect(turn.state).toBe("completed");
      }
      for (const model of models) {
        const detail = await openProvider(page, name);
        const row = detail.getByRole("group", {
          name: `模型 ${model}`,
          exact: true,
        });
        await row
          .getByRole("button", { name: "能力与预算", exact: true })
          .click();
        const current = async () =>
          (await snapshot()).connections
            .find((c) => c.id === connection!.id)!
            .models.find((m) => m.model === model)!;
        const before = (await current()).lastProbe?.executionId;
        await row
          .getByRole("button", { name: "检测图片能力", exact: true })
          .click();
        await expect
          .poll(
            async () => {
              const probe = (await current()).lastProbe;
              return (
                probe &&
                probe.executionId !== before &&
                terminalStates.includes(probe.state)
              );
            },
            { timeout: 120_000 },
          )
          .toBe(true);
        const result = await current();
        (record.checks as unknown[]).push({
          kind: "image_probe",
          model,
          imageInput: result.imageInput,
          checkedAt: result.imageInputCheckedAt,
          state: result.lastProbe!.state,
          errorClass: result.lastProbe!.errorClass,
          executionId: result.lastProbe!.executionId,
        });
        // A documented unsupported result is valid evidence; a network/auth failure is not a capability result.
        expect(["verified", "unsupported"]).toContain(result.imageInput);
        expect(
          result.lastProbe!.state === "completed" ||
            result.lastProbe!.errorClass === "unsupported",
        ).toBe(true);
      }
      record.result = "PASS";
    } catch (error) {
      record.result = "FAIL";
      throw error;
    } finally {
      record.finishedAt = new Date().toISOString();
      writeFileSync(output, JSON.stringify(record, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      if (client) await shutdownReal(client, true);
    }
  });
}
