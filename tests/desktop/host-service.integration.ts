import { launchLocal } from "./local-client";
import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";

// Exercise the production preload, main IPC handlers, utilityProcess and SQLite.
// No mock business service, renderer state injection or real provider is involved.
test("host-service: validated IPC, durable commit, stale revision rejection and supervised reconnect", async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/integration-"));
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    const outcome = await page.evaluate(async () => {
      const id = crypto.randomUUID();
      const create = await window.desktop.command({ type: "create", id });
      if (!create.ok) throw new Error(create.message);
      const saved = await window.desktop.command({
        type: "saveDraft",
        id,
        text: "集成层持久草稿",
        revision: 0,
      });
      const stale = await window.desktop.command({
        type: "saveDraft",
        id,
        text: "过期值",
        revision: 0,
      });
      const invalid = await window.desktop.command({
        type: "snapshot",
        sql: "DROP TABLE meta",
      } as never);
      const snapshot = await window.desktop.command({ type: "snapshot" });
      if (!snapshot.ok) throw new Error(snapshot.message);
      return {
        id,
        saved: saved.ok,
        stale: stale.ok,
        invalid: invalid.ok,
        draft: snapshot.snapshot.conversations.find((c) => c.id === id)?.draft,
      };
    });
    expect(outcome).toMatchObject({
      saved: true,
      stale: false,
      invalid: false,
      draft: "集成层持久草稿",
    });
    const pid = await app.evaluate(({ app }) => {
      const service = app
        .getAppMetrics()
        .find((p) => p.name === "csthink-assistant business");
      if (!service) throw new Error("No production business process");
      return service.pid;
    });
    await app.evaluate((_electron, id) => process.kill(id, "SIGKILL"), pid);
    await expect(
      page.getByText("业务服务已失联。", { exact: false }),
    ).toBeVisible();
    const disconnected = await page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    expect(disconnected.ok).toBe(false);
    await page.getByRole("button", { name: "重新连接", exact: true }).click();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    const recovered = await page.evaluate(async (id) => {
      const reply = await window.desktop.command({ type: "snapshot" });
      if (!reply.ok) throw new Error(reply.message);
      return reply.snapshot.conversations.find((c) => c.id === id)?.draft;
    }, outcome.id);
    expect(recovered).toBe("集成层持久草稿");
    expect(
      await app.evaluate(
        ({ app }, old) => app.getAppMetrics().some((p) => p.pid === old),
        pid,
      ),
    ).toBe(false);
  } finally {
    await app.close();
  }
});
