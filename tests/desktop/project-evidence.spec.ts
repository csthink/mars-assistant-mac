import { createServer } from "node:http";
import { goTo } from "./shell";
import type { AddressInfo } from "node:net";
import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyFixture } from "./project-action-fixture";
import { closeLocal } from "./local-client";
import { scrollIntoCenter } from "./scroll-into-center";

async function reader() {
  const f = await journeyFixture({ reader: true });
  return {
    ...f,
    open: (name: string) =>
      f.page
        .getByRole("navigation", { name: "Runtime 内容" })
        .getByRole("button", { name, exact: true })
        .click(),
    fault: (value: Record<string, unknown>) =>
      writeFileSync(
        join(
          f.target.runtimeRoot,
          "instances",
          f.target.instanceId.replace(/[^A-Za-z0-9._-]/g, "_"),
          "fault.json",
        ),
        JSON.stringify(value),
      ),
  };
}
test("project evidence: topology, nodes, Trace runs, documents and differences are read-only and HTML cannot execute", async ({}, info) => {
  const f = await reader();
  try {
    const requests: string[] = [];
    f.page.on("request", (r) => {
      if (r.url().startsWith("https://reader-fixture.invalid"))
        requests.push(r.url());
    });
    const graph = f.page.getByRole("region", { name: "流程拓扑", exact: true });
    await expect(graph.locator("[data-node]")).toHaveCount(11);
    // The canvas fills the graph section (the workspace's 22 px icon rule once shrank it to an icon).
    const canvasBox = (await graph
      .getByRole("group", { name: "拓扑画布，可拖动平移", exact: true })
      .boundingBox())!;
    const graphBox = (await graph.boundingBox())!;
    expect(canvasBox.height).toBe(380);
    expect(canvasBox.width).toBeCloseTo(graphBox.width, 0);
    await graph
      .getByRole("combobox", { name: "检查节点", exact: true })
      .selectOption("stage:4");
    await expect(
      graph.getByRole("region", { name: "节点详情", exact: true }),
    ).toContainText("待变更评审");
    const oldZoom = await graph
      .getByLabel("拓扑缩放", { exact: true })
      .textContent();
    await graph.getByRole("button", { name: "放大拓扑", exact: true }).click();
    await expect(graph.getByLabel("拓扑缩放", { exact: true })).not.toHaveText(
      oldZoom!,
    );
    const canvas = graph.getByRole("group", {
      name: "拓扑画布，可拖动平移",
      exact: true,
    });
    const beforePan = await canvas
      .locator(":scope > g")
      .getAttribute("transform");
    await canvas.focus();
    await f.page.keyboard.press("ArrowRight");
    await expect(canvas.locator(":scope > g")).not.toHaveAttribute(
      "transform",
      beforePan!,
    );
    await f.open("任务运行记录");
    await f.page
      .getByRole("combobox", { name: "选择运行", exact: true })
      .selectOption("run:2");
    await expect(
      f.page.getByRole("region", { name: "Trace 日志", exact: true }),
    ).toContainText("第二轮：当前验证记录");
    await expect(
      f.page.getByText("第一轮：保留的验证记录", { exact: true }),
    ).toHaveCount(0);
    await f.open("合成编码任务");
    await expect(
      graph.getByRole("combobox", { name: "检查节点", exact: true }),
    ).toHaveValue("stage:4");
    await f.open("设计文档");
    const document = f.page.getByRole("region", { name: "文档", exact: true });
    await expect(
      document.getByLabel("文档内容", { exact: true }),
    ).toContainText("当前候选 1");
    await f.open("本次修改");
    await expect(
      f.page.getByLabel("修改前内容", { exact: true }),
    ).toContainText("旧版本内容");
    await expect(
      f.page.getByLabel("修改后内容", { exact: true }),
    ).toContainText("当前候选 1");
    await f.open("原型源码");
    await expect(
      document.getByLabel("文档内容", { exact: true }),
    ).toContainText("<script>window.readerInjected = true</script>");
    expect(
      await f.page.evaluate(
        () =>
          (window as unknown as { readerInjected?: boolean }).readerInjected,
      ),
    ).toBeUndefined();
    expect(requests).toEqual([]);
    await document.screenshot({
      path: info.outputPath("html-source-safe.png"),
    });
    const operations = await f.request({
      type: "list",
      projectId: f.projectId,
    });
    expect(operations.ok && operations.operations?.length).toBe(0);
  } finally {
    await closeLocal(f.app);
  }
});

test("project evidence: missing bytes, digest and offset mismatch, stale revisions and revoked grants preserve the last read content", async () => {
  const f = await reader();
  try {
    await f.open("设计文档");
    const document = f.page.getByRole("region", { name: "文档", exact: true }),
      text = document.getByLabel("文档内容", { exact: true });
    await expect(text).toContainText("当前候选 1");
    const original = await text.textContent();
    for (const fault of [
      { wrongDigest: true },
      { wrongOffset: true },
      { missingArtifact: true },
    ]) {
      f.fault(fault);
      await document.getByRole("button", { name: "读取", exact: true }).click();
      await expect(document.getByRole("alert")).toBeVisible();
      await expect(text).toHaveText(original!);
    }
    const changed = await f.app.evaluate(
      (_, t) =>
        globalThis.runtimeHost.invoke(t.instanceId, t.scopeRef, {
          actionId: "test.revise",
          objectRef: "candidate:1",
          payload: { decision: "继续" },
        }),
      f.target,
    );
    expect(changed.status).toBe("succeeded");
    await expect(
      document.getByText("当前对象版本已变化，下面保留上次读取的内容。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(text).toHaveText(original!);
    f.fault({});
    await document.getByRole("button", { name: "读取", exact: true }).click();
    await expect(text).toContainText("当前候选 2");
    const stale = await f.page.evaluate(
      (projectId) =>
        window.desktop.projectEvidence({
          projectId,
          objectRef: "document:1",
          revision: "doc:1",
          source: { kind: "document" },
        }),
      f.projectId,
    );
    expect(stale.ok).toBe(false);
    const forged = await f.page.evaluate(
      (projectId) =>
        window.desktop.projectEvidence({
          projectId,
          objectRef: "document:1",
          revision: "doc:2",
          source: { kind: "document" },
          path: "/private/secret",
        } as unknown as Parameters<typeof window.desktop.projectEvidence>[0]),
      f.projectId,
    );
    expect(forged.ok).toBe(false);
    await f.app.evaluate(
      (_, t) => globalThis.runtimeHost.revokeGrant(t.instanceId, t.grantId),
      f.target,
    );
    await expect(
      document.getByRole("button", { name: "读取", exact: true }),
    ).toBeDisabled();
    await expect(text).toContainText("当前候选 2");
    const revoked = await f.page.evaluate(
      (projectId) =>
        window.desktop.projectEvidence({
          projectId,
          objectRef: "document:1",
          revision: "doc:2",
          source: { kind: "document" },
        }),
      f.projectId,
    );
    expect(revoked.ok).toBe(false);
  } finally {
    await closeLocal(f.app);
  }
});

test("project evidence: fullscreen chat can float dock collapse and restore while drafts and reading scroll survive", async ({}, info) => {
  const f = await reader();
  try {
    await f.open("设计文档");
    const content = f.page.getByLabel("文档内容", { exact: true });
    await expect(content).toContainText("当前候选 1");
    await f.page
      .getByRole("button", { name: "新建项目对话", exact: true })
      .click();
    const input = f.page.getByRole("textbox", {
      name: "项目对话输入",
      exact: true,
    });
    await input.fill("保留草稿，不发送");
    await content.evaluate((el) => {
      el.scrollTop = 400;
    });
    const scroll = await content.evaluate((el) => el.scrollTop);
    expect(scroll).toBeGreaterThan(0);
    await f.page
      .getByRole("button", { name: "放大内容区", exact: true })
      .click();
    const layout = f.page.locator(".project-work-grid");
    await expect(layout).toHaveAttribute("data-full", "true");
    // The enlarged content covers the window: the rail and the sidebar step aside.
    await expect(
      f.page.getByRole("navigation", { name: "全局导航" }),
    ).toBeHidden();
    await expect(f.page.locator("#main-sidebar")).toBeHidden();
    await expect(input).toHaveValue("保留草稿，不发送");
    expect(await content.evaluate((el) => el.scrollTop)).toBe(scroll);
    await f.page
      .getByRole("combobox", { name: "对话布局", exact: true })
      .selectOption("float");
    await f.page.getByRole("button", { name: "收起对话", exact: true }).click();
    await expect(input).toBeHidden();
    await f.page
      .getByRole("button", { name: "打开项目对话", exact: true })
      .click();
    await expect(input).toHaveValue("保留草稿，不发送");
    await expect(layout).toHaveAttribute("data-chat", "float");
    await f.page
      .getByRole("combobox", { name: "对话布局", exact: true })
      .selectOption("docked");
    await f.page.evaluate(() =>
      window.desktop.command({ type: "setAppearance", appearance: "dark" }),
    );
    await f.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
    );
    await expect(f.page.locator("html")).toHaveAttribute("data-theme", "dark");
    // The resize reaches the renderer asynchronously; the fixed 还原 button follows the viewport's
    // right edge, so hovering before the new size applies leaves the pointer where it used to be.
    await expect
      .poll(() => f.page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual([900, 680]);
    const restoreBox = await f.page
      .getByRole("button", { name: "还原内容区", exact: true })
      .boundingBox();
    expect(restoreBox).not.toBeNull();
    expect(restoreBox!.x + restoreBox!.width).toBeLessThanOrEqual(900);
    await scrollIntoCenter(input);
    const box = (await input.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(900);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(680);
    await f.page
      .getByRole("button", { name: "还原内容区", exact: true })
      .hover();
    await expect(
      f.page.getByRole("button", { name: "还原内容区", exact: true }),
    ).toHaveCSS("opacity", "1");
    const send = f.page
      .getByRole("region", { name: "项目对话", exact: true })
      .getByRole("button", { name: "发送", exact: true });
    await expect(send).toBeVisible();
    const sendBox = (await send.boundingBox())!;
    expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(680);
    await f.page.screenshot({
      path: info.outputPath("fullscreen-docked-dark-900.png"),
    });
    await f.page.keyboard.press("Escape");
    await expect(layout).toHaveAttribute("data-full", "false");
    await expect(input).toHaveValue("保留草稿，不发送");
    expect(await content.evaluate((el) => el.scrollTop)).toBe(scroll);
    await f.page
      .getByRole("button", { name: "放大内容区", exact: true })
      .click();
    await f.page
      .getByRole("button", { name: "还原内容区", exact: true })
      .click();
    await expect(layout).toHaveAttribute("data-full", "false");
    await goTo(f.page, "聊天");
    await goTo(f.page, "项目");
    // 全部项目 opens the project list; the project row reopens its detail, as returning to it did before.
    await f.page.locator(".project-open").first().click();
    await expect(input).toHaveValue("保留草稿，不发送");
    await expect(content).toContainText("当前候选 1");
    await expect
      .poll(() => content.evaluate((el) => el.scrollTop))
      .toBe(scroll);
    const operations = await f.request({
      type: "list",
      projectId: f.projectId,
    });
    expect(operations.ok && operations.operations?.length).toBe(0);
  } finally {
    await closeLocal(f.app);
  }
});

test("project evidence: Host context snapshots read through the same project and retain their fixed historical bytes", async () => {
  const f = await reader();
  try {
    const op = await f.app.evaluate(
      (_, t) =>
        globalThis.runtimeHost.invoke(t.instanceId, t.scopeRef, {
          actionId: "test.capture",
          objectRef: "candidate:1",
          payload: { decision: "继续" },
        }),
      f.target,
    );
    expect(["accepted", "succeeded"]).toContain(op.status);
    await f.open("Host 固定快照");
    const text = f.page.getByLabel("文档内容", { exact: true });
    await expect(text).toContainText("candidate revision 1");
    const original = await text.textContent();
    await f.app.evaluate(
      (_, t) =>
        globalThis.runtimeHost.invoke(t.instanceId, t.scopeRef, {
          actionId: "test.revise",
          objectRef: "candidate:1",
          payload: { decision: "继续" },
        }),
      f.target,
    );
    await f.page
      .getByRole("region", { name: "文档", exact: true })
      .getByRole("button", { name: "读取", exact: true })
      .click();
    await expect(text).toHaveText(original!);
    const foreign = await f.page.evaluate(
      (projectId) =>
        window.desktop.projectEvidence({
          projectId,
          objectRef: "host-document:0:0",
          revision: "rev:1",
          source: { kind: "document" },
        }),
      "00000000-0000-0000-0000-000000000001",
    );
    expect(foreign.ok).toBe(false);
  } finally {
    await closeLocal(f.app);
  }
});

test("project evidence: a fullscreen chat sends once while Runtime candidate updates preserve the view and explicit discussion identity", async () => {
  const f = await reader(),
    bodies: Record<string, unknown>[] = [],
    pending: (() => void)[] = [];
  let released = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      bodies.push(JSON.parse(body));
      const answer = () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "已收到本次讨论对象。" } }] })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      };
      if (released) answer();
      else pending.push(answer);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    await f.open("设计文档");
    await expect(f.page.getByLabel("文档内容", { exact: true })).toContainText(
      "当前候选 1",
    );
    await f.page
      .getByRole("button", { name: "新建项目对话", exact: true })
      .click();
    const connection = await f.page.evaluate(
      async (port) => {
        const secret = await window.desktop.saveSecret(
          "synthetic-fullscreen-key",
        );
        if (!secret.ok) throw Error(JSON.stringify(secret));
        const id = crypto.randomUUID();
        const saved = await window.desktop.command({
          type: "upsertConnection",
          id,
          name: "全屏合成模型",
          provider: "custom",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "synthetic",
          secretRef: secret.secretRef,
          imageInput: "unknown",
          contextChars: null,
          revision: 0,
        });
        if (!saved.ok) throw Error(JSON.stringify(saved));
        return id;
      },
      (server.address() as AddressInfo).port,
    );
    await f.page
      .getByRole("combobox", { name: "项目对话模型", exact: true })
      .selectOption(`${connection}::synthetic`);
    await f.page
      .getByRole("combobox", { name: "讨论对象", exact: true })
      .selectOption("document:1");
    await f.page
      .getByRole("button", { name: "放大内容区", exact: true })
      .click();
    const chat = f.page.getByRole("region", { name: "项目对话", exact: true });
    await chat
      .getByRole("textbox", { name: "项目对话输入", exact: true })
      .fill("请记录本次明确选择的讨论对象");
    await expect(
      chat.getByRole("button", { name: "发送", exact: true }),
    ).toBeEnabled();
    await chat
      .getByRole("button", { name: "发送", exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await expect.poll(() => bodies.length).toBe(1);
    await expect(
      chat.getByRole("button", { name: "发送", exact: true }),
    ).toBeDisabled();
    await expect(f.page.getByLabel("文档内容", { exact: true })).toContainText(
      "当前候选 1",
    );
    // A Runtime event is a separate authoritative update, never inferred from the chat reply.
    const changed = await f.app.evaluate(
      (_, t) =>
        globalThis.runtimeHost.invoke(t.instanceId, t.scopeRef, {
          actionId: "test.revise",
          objectRef: "candidate:1",
          payload: { decision: "继续" },
        }),
      f.target,
    );
    expect(changed.status).toBe("succeeded");
    await expect(f.page.getByLabel("文档内容", { exact: true })).toContainText(
      "当前候选 2",
    );
    await expect(f.page.locator(".project-work-grid")).toHaveAttribute(
      "data-full",
      "true",
    );
    released = true;
    pending.splice(0).forEach((answer) => answer());
    await expect(chat.getByLabel("助手消息", { exact: true })).toContainText(
      "已收到本次讨论对象。",
    );
    const snapshot = await f.page.evaluate(() =>
      window.desktop.command({ type: "snapshot" }),
    );
    if (!snapshot.ok) throw Error(JSON.stringify(snapshot));
    const chatId = snapshot.snapshot.projects.find((p) => p.id === f.projectId)!
      .chats[0].conversationId;
    expect(
      snapshot.snapshot.turns.filter((t) => t.conversationId === chatId),
    ).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(bodies[0])).toContain("document:1");
    expect(JSON.stringify(bodies[0])).toContain("doc:1");
    expect(JSON.stringify(bodies[0])).not.toContain(f.folder);
    expect(
      snapshot.snapshot.projects.find((p) => p.id === f.projectId)!.chats[0]
        .context?.revision,
    ).toBe("doc:1");
  } finally {
    released = true;
    pending.splice(0).forEach((answer) => answer());
    await closeLocal(f.app);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("project evidence: 适应内容 shows the whole topology inside the canvas at a readable size in the default and the 900 × 680 window (KB-319)", async ({}, info) => {
  const f = await reader();
  try {
    const graph = f.page.getByRole("region", { name: "流程拓扑", exact: true });
    const canvas = graph.getByRole("group", {
      name: "拓扑画布，可拖动平移",
      exact: true,
    });
    await expect(graph.locator("[data-node]")).toHaveCount(11);
    /** Canvas box, node boxes and the rendered size of the node titles after 适应内容. */
    const fitted = async () => {
      await graph
        .getByRole("button", { name: "适应内容", exact: true })
        .click();
      return canvas.evaluate((svg) => {
        const box = svg.getBoundingClientRect();
        const nodes = [...svg.querySelectorAll("[data-node]")].map((node) => {
          const r = node.querySelector("rect")!.getBoundingClientRect(),
            title = node.querySelector("text")!;
          return {
            id: node.getAttribute("data-node"),
            inside:
              r.left >= box.left &&
              r.right <= box.right &&
              r.top >= box.top &&
              r.bottom <= box.bottom,
            // The rendered title size: its font size times the canvas scale.
            titlePx:
              parseFloat(getComputedStyle(title).fontSize) *
              (r.width /
                Number(node.querySelector("rect")!.getAttribute("width"))),
          };
        });
        return { width: box.width, height: box.height, nodes };
      });
    };
    for (const size of [null, [900, 680]] as const) {
      if (size) {
        await f.app.evaluate(
          ({ BrowserWindow }, [w, h]) =>
            BrowserWindow.getAllWindows()[0].setContentSize(w, h),
          size,
        );
        await expect
          .poll(() => f.page.evaluate(() => [innerWidth, innerHeight]))
          .toEqual(size);
      }
      const result = await fitted();
      const shown = JSON.stringify(result);
      expect(
        result.nodes.every((n) => n.inside),
        shown,
      ).toBe(true);
      expect(
        Math.min(...result.nodes.map((n) => n.titlePx)),
        shown,
      ).toBeGreaterThanOrEqual(10);
      await graph.scrollIntoViewIfNeeded();
      await graph.screenshot({
        path: info.outputPath(`topology-fit-${size ? "900" : "default"}.png`),
      });
    }
  } finally {
    await closeLocal(f.app);
  }
});
