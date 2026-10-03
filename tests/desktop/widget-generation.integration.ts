import { test, expect, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { launchLocal, closeLocal } from "./local-client";
import type { Command } from "../../src/shared/protocol";
const source = JSON.stringify({
  schemaVersion: 1,
  name: "Original seven marks",
  view: {
    html: "<button id='seven'>Seven</button>",
    css: "button{color:navy}",
    js: "document.querySelector('#seven').addEventListener('click',()=>{document.querySelector('#seven').textContent='7'});",
  },
  config: [],
  draftFields: [],
  capabilities: [],
  resources: [],
});
async function fixture(autoSubmit = true) {
  const responses = new Map<string, ServerResponse>(),
    counts = { generation: 0, foreground: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const value = JSON.parse(body),
        kind =
          value.tools?.[0]?.function?.name === "submit_widget_candidate"
            ? "generation"
            : "foreground";
      counts[kind]++;
      responses.set(kind, res);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: `${kind} partial` } }] })}\n\n`,
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(
    resolve(".test-data/disposable/generation-integration-"),
  );
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
  });
  let closed = false;
  const closeApp = async () => {
    if (!closed) {
      closed = true;
      await closeLocal(app);
    }
  };
  const page = await app.firstWindow();
  await expect(
    page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const ids = await page.evaluate(
    async ({ baseUrl, autoSubmit }) => {
      const connectionId = crypto.randomUUID(),
        conversationId = crypto.randomUUID(),
        draftId = crypto.randomUUID();
      const secret = await window.desktop.saveSecret(
        "synthetic-generation-key",
      );
      if (!secret.ok) throw new Error(secret.message);
      for (const command of [
        {
          type: "upsertConnection",
          id: connectionId,
          name: "Offline",
          provider: "custom",
          baseUrl,
          model: "synthetic-model",
          secretRef: secret.secretRef,
          imageInput: "unknown",
          contextChars: null,
          revision: 0,
        },
        { type: "create", id: conversationId },
        {
          type: "createWidgetDraft",
          id: draftId,
          name: "Original seven marks",
          sourceConversationId: conversationId,
        },
        {
          type: "saveWidgetDraft",
          id: draftId,
          name: "Original seven marks",
          input: "Create seven original marks",
          revision: 0,
        },
        {
          type: "submitWidgetGeneration",
          draftId,
          connectionId,
          model: "synthetic-model",
          revision: 1,
          requestId: crypto.randomUUID(),
        },
      ] as Command[]) {
        if (command.type === "submitWidgetGeneration" && !autoSubmit) continue;
        const r = await window.desktop.command(command);
        if (!r.ok) throw new Error(r.message);
      }
      return { connectionId, conversationId, draftId };
    },
    { baseUrl, autoSubmit },
  );
  return {
    app,
    closeApp,
    page,
    counts,
    root,
    ids,
    finish(kind: "generation" | "foreground") {
      const res = responses.get(kind);
      if (!res) throw new Error("missing request");
      if (kind === "generation")
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "generated", type: "function", function: { name: "submit_widget_candidate", arguments: JSON.stringify({ package: source }) } }] } }] })}\n\n`,
        );
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: kind === "generation" ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    },
    async ask() {
      await send(page, {
        type: "submitTurn",
        ...{
          conversationId: ids.conversationId,
          connectionId: ids.connectionId,
        },
        requestId: crypto.randomUUID(),
        text: "Explain a transaction",
      });
    },
    async close() {
      await closeApp();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function send(page: Page, command: Command) {
  const r = await page.evaluate((c) => window.desktop.command(c), command);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r;
}
async function snapshot(page: Page) {
  const r = await page.evaluate(() =>
    window.desktop.command({ type: "snapshot" }),
  );
  if (!r.ok) throw new Error(r.message);
  return r.snapshot;
}
test("widget generation IPC: durable queue dispatch and same-conversation answer finish before original candidate", async () => {
  const f = await fixture();
  try {
    await expect.poll(() => f.counts.generation).toBe(1);
    await f.ask();
    await expect.poll(() => f.counts.foreground).toBe(1);
    f.finish("foreground");
    await expect
      .poll(async () => (await snapshot(f.page)).activeTurns.length)
      .toBe(0);
    expect((await snapshot(f.page)).widgetGeneration!.tasks[0].state).toBe(
      "running",
    );
    f.finish("generation");
    await expect
      .poll(
        async () => (await snapshot(f.page)).widgetGeneration!.tasks[0].state,
      )
      .toBe("completed");
    const value = (await snapshot(f.page)).widgetGeneration!;
    expect(value.candidates[0].name).toBe("Original seven marks");
    expect(value.widgets).toHaveLength(0);
    expect(f.counts).toEqual({ generation: 1, foreground: 1 });
    const forbidden = await f.page.evaluate(() =>
      window.desktop.command({
        type: "receiveWidgetCandidate",
        taskId: "forged",
        executionId: "forged",
        build: {},
      } as never),
    );
    expect(forbidden.ok).toBe(false);
  } finally {
    await f.close();
  }
});
test("widget generation IPC: each stop cancels only its own production request", async () => {
  for (const kind of ["generation", "foreground"] as const) {
    const f = await fixture();
    try {
      await expect.poll(() => f.counts.generation).toBe(1);
      await f.ask();
      await expect.poll(() => f.counts.foreground).toBe(1);
      const value = await snapshot(f.page);
      if (kind === "generation") {
        await send(f.page, {
          type: "stopWidgetGeneration",
          taskId: value.widgetGeneration!.tasks[0].id,
        });
        await expect
          .poll(
            async () =>
              (await snapshot(f.page)).widgetGeneration!.tasks[0].state,
          )
          .toBe("stopped");
        expect(
          (await snapshot(f.page)).widgetGeneration!.tasks[0].partialText,
        ).toBe("generation partial");
        f.finish("foreground");
        await expect
          .poll(async () => (await snapshot(f.page)).activeTurns.length)
          .toBe(0);
        expect(
          (await snapshot(f.page)).widgetGeneration!.candidates,
        ).toHaveLength(0);
      } else {
        await send(f.page, {
          type: "stopExecution",
          executionId: value.activeTurns[0].executionId,
        });
        await expect
          .poll(async () => (await snapshot(f.page)).activeTurns.length)
          .toBe(0);
        expect((await snapshot(f.page)).widgetGeneration!.tasks[0].state).toBe(
          "running",
        );
        f.finish("generation");
        await expect
          .poll(
            async () =>
              (await snapshot(f.page)).widgetGeneration!.tasks[0].state,
          )
          .toBe("completed");
      }
    } finally {
      await f.close();
    }
  }
});
test("widget generation IPC: quitting names generation, cancel keeps running and restart does not replay", async () => {
  const f = await fixture();
  try {
    await expect.poll(() => f.counts.generation).toBe(1);
    const detail = await f.app.evaluate(async ({ app, dialog }) => {
      let detail = "";
      dialog.showMessageBox = (async (
        _owner: unknown,
        options: { detail: string },
      ) => {
        detail = options.detail;
        return { response: 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
      app.quit();
      await new Promise((r) => setTimeout(r, 100));
      return detail;
    });
    expect(detail).toContain("控件生成任务");
    expect((await snapshot(f.page)).widgetGeneration!.tasks[0].state).toBe(
      "running",
    );
    await f.closeApp();
    const reopened = await launchLocal({
      args: [resolve("."), `--data-root=${f.root}`],
    });
    try {
      const page = await reopened.firstWindow();
      await expect(
        page
          .locator("#main-sidebar")
          .getByRole("button", { name: "新建聊天", exact: true }),
      ).toBeEnabled();
      expect((await snapshot(page)).widgetGeneration!.tasks[0].state).toBe(
        "stopped",
      );
      expect(f.counts.generation).toBe(1);
    } finally {
      await closeLocal(reopened);
    }
  } finally {
    await f.close();
  }
});

test("widget generation UI: confirmed requirement submits once and the real local response opens a retainable preview", async () => {
  const f = await fixture(false);
  try {
    await f.page.evaluate(
      (id) => window.desktop.command({ type: "selectWidgetDraft", id }),
      f.ids.draftId,
    );
    await f.page
      .getByRole("navigation", { name: "全局导航" })
      .getByRole("button", { name: "控件", exact: true })
      .click();
    await expect(
      f.page.getByRole("textbox", { name: "控件需求", exact: true }),
    ).toHaveValue("Create seven original marks");
    await f.page.getByRole("button", { name: "生成控件", exact: true }).click();
    await expect.poll(() => f.counts.generation).toBe(1);
    await expect(
      f.page.getByRole("textbox", { name: "控件需求", exact: true }),
    ).toHaveValue("");
    await expect(
      f.page.getByRole("button", { name: "停止生成", exact: true }),
    ).toBeVisible();
    f.finish("generation");
    await expect(
      f.page.getByRole("button", { name: "保留控件", exact: true }),
    ).toBeEnabled();
    await f.page.getByRole("button", { name: "保留控件", exact: true }).click();
    await f.page.getByRole("button", { name: "确认保留", exact: true }).click();
    await expect(
      f.page.getByText("已保留到控件。编辑历史继续保存。"),
    ).toBeVisible();
    expect((await snapshot(f.page)).widgetGeneration!.widgets).toHaveLength(1);
    expect(f.counts).toEqual({ generation: 1, foreground: 0 });
  } finally {
    await f.close();
  }
});
