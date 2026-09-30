import { createClaudeFixture } from "./claude-fixture";
import { goTo } from "./shell";
import { createCodexFixture } from "./codex-fixture";
import { graphFakeDir } from "./runtime-fakes/build";
import { GRAPH_CAPABILITY, GRAPH_SCHEMA } from "./runtime-fakes/graph-contract";
import {
  claudeImplementerProfileId,
  claudeImplementerDigest,
} from "../../src/main/execution-claude";
import type { EmbeddedExecutionPort } from "../../src/main/execution-port";
import { test, expect } from "@playwright/test";
import { launchLocal, closeLocal } from "./local-client";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildBundle, newPublisher } from "./runtime-fakes/bundle";
import { buildFake, listFakeEntry } from "./runtime-fakes/build";
import { LIST_CAPABILITY, LIST_SCHEMA } from "./runtime-fakes/list-contract";
import type { RuntimeHost } from "../../src/main/runtime-host";
declare global {
  var runtimeHost: RuntimeHost;
}
async function setup(env: NodeJS.ProcessEnv = process.env) {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/project-runtime-")),
    data = join(root, "data"),
    folder = join(root, "folder");
  mkdirSync(data);
  mkdirSync(folder);
  const app = await launchLocal({
      args: [resolve("."), `--data-root=${data}`],
      cwd: resolve("."),
      env: Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    }),
    page = await app.firstWindow();
  try {
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, folder);
    const projectId = await page.evaluate(async () => {
      const chosen = await window.desktop.pickProjectFolder();
      if (!chosen.ok) throw Error(chosen.message);
      const r = await window.desktop.createProject({
        token: chosen.token,
        name: "项目旅程验证",
        goal: "只发送明确选择的上下文",
      });
      if (!r.ok || !r.projectId) throw Error(JSON.stringify(r));
      return r.projectId;
    });
    await goTo(page, "项目");
    await page
      .locator(".project-open")
      .filter({ hasText: "项目旅程验证" })
      .click();
    await page.getByRole("button", { name: "打开右栏", exact: true }).click();
    return { app, page, root, data, folder, projectId };
  } catch (error) {
    await closeLocal(app);
    throw error;
  }
}
test("project runtime: unavailable domain stays honest; independent chats retain drafts across project navigation", async ({}, info) => {
  const f = await setup();
  try {
    await expect(
      f.page.getByText("尚无可关联的 Runtime 数据。你可以先开始项目对话。", {
        exact: true,
      }),
    ).toBeVisible();
    await f.page
      .getByRole("button", { name: "新建项目对话", exact: true })
      .click();
    await f.page
      .getByRole("textbox", { name: "项目对话输入", exact: true })
      .fill("第一段未发送内容");
    await expect(
      f.page.getByText("正在保存草稿…", { exact: true }),
    ).toHaveCount(0);
    const first = await f.page
      .getByRole("combobox", { name: "项目对话选择", exact: true })
      .inputValue();
    await f.page
      .getByRole("button", { name: "新建项目对话", exact: true })
      .click();
    await expect(
      f.page.getByRole("textbox", { name: "项目对话输入", exact: true }),
    ).toHaveValue("");
    await f.page
      .getByRole("textbox", { name: "项目对话输入", exact: true })
      .fill("第二段独立草稿");
    await f.page
      .getByRole("combobox", { name: "项目对话选择", exact: true })
      .selectOption(first);
    await expect(
      f.page.getByRole("textbox", { name: "项目对话输入", exact: true }),
    ).toHaveValue("第一段未发送内容");
    await f.page
      .getByRole("button", { name: "返回项目列表", exact: true })
      .click();
    await f.page
      .locator(".project-open")
      .filter({ hasText: "项目旅程验证" })
      .click();
    await expect(
      f.page.getByRole("textbox", { name: "项目对话输入", exact: true }),
    ).toHaveValue("第一段未发送内容");
    await expect(
      f.page.getByRole("button", { name: "保存实施者", exact: true }),
    ).toBeDisabled();
    await f.page.screenshot({
      path: info.outputPath("project-context-light.png"),
      fullPage: true,
    });
    await f.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "csthink-assistant")!
        .setSize(900, 680),
    );
    await f.page.evaluate(() =>
      window.desktop.command({ type: "setAppearance", appearance: "dark" }),
    );
    await f.page
      .getByRole("textbox", { name: "项目对话输入", exact: true })
      .scrollIntoViewIfNeeded();
    await f.page.screenshot({
      path: info.outputPath("project-context-dark-900.png"),
    });
    expect(
      await f.page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    await closeLocal(f.app);
  }
});
test("project runtime: the Host-registered resource handle of the project folder is shown read-only and copied from the records, never derived from the path (OD-412)", async ({}, info) => {
  const f = await setup();
  try {
    const progress = f.page.getByRole("region", { name: "项目进度" });
    await expect(progress).toBeVisible();
    // Not registered yet: nothing is shown, the handle is not computed from the folder path.
    await expect(f.page.getByTestId("project-resource-handle")).toHaveCount(0);
    const resource = await f.app.evaluate(
      (_, folder) => globalThis.runtimeHost.registerResource(folder),
      f.folder,
    );
    const fact = f.page.getByTestId("project-resource-handle");
    await expect(fact.getByTestId("project-resource-handle-value")).toHaveText(
      resource.handle,
    );
    await expect(fact).toContainText("Runtime 资源句柄");
    await expect(fact.locator("input, textarea, select")).toHaveCount(0);
    const copy = fact.getByRole("button", { name: "复制 Runtime 资源句柄" });
    await copy.click();
    await expect(copy).toHaveText("已复制");
    expect(await f.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      resource.handle,
    );
    await f.page.screenshot({
      path: info.outputPath("project-resource-handle-light.png"),
    });
    await f.page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await f.page.screenshot({
      path: info.outputPath("project-resource-handle-dark.png"),
    });
  } finally {
    await closeLocal(f.app);
  }
});
test("project access (OD-416): inside the project the folder is registered, the scope opened after a refusal is recovered, the authorization reviewed, cancelled, refused and granted, the content linked, and 访问权限 revokes the whole authorization after confirmation; a new review re-authorizes", async ({}, info) => {
  test.setTimeout(180_000);
  const f = await setup();
  try {
    const bundle = buildBundle(join(f.root, "bundle"), newPublisher(), {
      runtimeId: "runtime:test-list",
      version: "1",
      entrypoint: "list-fake.cjs",
      entrypointBytes: buildFake(listFakeEntry),
      launcher: "electron-node",
      argv: ["${instanceDir}", "${contractDigest}"],
      capabilities: [{ capability: LIST_CAPABILITY, schema: LIST_SCHEMA }],
    });
    const imported = await f.app.evaluate(
      (_, dir) => globalThis.runtimeHost.supervisor.importBundle(dir, "access"),
      bundle.dir,
    );
    expect(imported.ok).toBe(true);
    const snap = () =>
      f.page.evaluate(async () => {
        const r = await window.desktop.command({ type: "snapshot" });
        if (!r.ok) throw Error(r.message);
        return r.snapshot;
      });
    const instanceDir = (await snap()).runtimeInstances[0].launchDirectories!
      .instanceDir;
    const fault = (value: Record<string, unknown>) =>
      writeFileSync(join(instanceDir, "fault.json"), JSON.stringify(value));
    const panel = f.page.getByRole("region", {
      name: "仓库治理接入",
      exact: true,
    });
    await expect(panel.getByTestId("access-summary")).toHaveText("未接入");
    await expect(panel).toContainText(f.folder);
    await expect(panel.getByTestId("access-extension")).toContainText(
      "test-list 1 · csthink-test · 可用",
    );
    // Nothing is granted by creating the project or by registering the folder.
    expect((await snap()).runtimeResources).toHaveLength(0);
    await panel.getByRole("button", { name: "登记项目文件夹" }).click();
    const handle = panel.getByTestId("project-resource-handle-value");
    await expect(handle).toHaveText(/^resource:[0-9a-f]{32}$/);
    expect((await snap()).runtimeGrants).toHaveLength(0);
    await expect(panel.getByTestId("access-instance-dir-value")).toHaveText(
      instanceDir,
    );
    // Refused by the Runtime (as hp does without its binding file): no scope, the reason is shown.
    fault({ refuseScopeOpen: "no instance binding file: synthetic" });
    await panel.getByRole("button", { name: "打开项目范围" }).click();
    await expect(panel.getByRole("alert")).toContainText(
      "扩展未打开项目范围（PERMISSION_DENIED：no instance binding file: synthetic）",
    );
    expect((await snap()).runtimeScopes).toHaveLength(0);
    await f.page.screenshot({
      path: info.outputPath("access-refused-light.png"),
    });
    // Recovered: the same step succeeds and the scope is open but not authorized.
    fault({});
    await panel.getByRole("button", { name: "打开项目范围" }).click();
    await expect(panel.getByTestId("access-scope")).toContainText("尚未授权");
    expect((await snap()).runtimeScopes[0].state).toBe("inactive");
    // Review and cancel: nothing is granted.
    await panel.getByRole("button", { name: "核对并授权…" }).click();
    const review = f.page.getByRole("dialog", { name: "核对扩展授权" });
    await expect(review).toContainText("test-list 1 · csthink-test");
    await expect(review).toContainText(f.folder);
    await expect(review).toContainText(LIST_CAPABILITY.id);
    await expect(review).toContainText(
      "runtime.snapshot.open、runtime.snapshot.next、runtime.events.subscribe、runtime.events.ack、runtime.resource.read",
    );
    await expect(review).toContainText(
      "runtime.action.invoke、runtime.operation.get、runtime.operation.cancel",
    );
    await expect(review).toContainText("30 天");
    await expect(review).toContainText("共 8 项授权");
    for (const impact of ["访问仓库", "安装治理内容", "执行", "发布"])
      await expect(review.getByRole("region", { name: "影响" })).toContainText(
        impact,
      );
    await f.page.screenshot({
      path: info.outputPath("access-review-light.png"),
    });
    await review.getByRole("button", { name: "取消", exact: true }).click();
    await expect(review).toHaveCount(0);
    expect((await snap()).runtimeGrants).toHaveLength(0);
    // Refused authorization: the batch is withdrawn, nothing stays usable.
    fault({ refuseAuthorize: "synthetic refusal" });
    await panel.getByRole("button", { name: "核对并授权…" }).click();
    await review.getByRole("button", { name: "确认授权" }).click();
    await expect(panel.getByRole("alert")).toContainText(
      "扩展拒绝授权，已撤回本次授权记录（PERMISSION_DENIED：synthetic refusal）",
    );
    let grants = (await snap()).runtimeGrants;
    expect(grants).toHaveLength(8);
    expect(grants.every((g) => g.status === "revoked")).toBe(true);
    // Granted after review.
    fault({});
    await panel.getByRole("button", { name: "核对并授权…" }).click();
    await review.getByRole("button", { name: "确认授权" }).click();
    await expect(panel.getByTestId("access-summary")).toHaveText(
      "已授权，待关联",
    );
    await expect(panel.getByTestId("access-grants")).toContainText(
      "已授权 8 项，至",
    );
    grants = (await snap()).runtimeGrants.filter((g) => g.status === "active");
    expect(grants).toHaveLength(8);
    // The existing project link step picks the authorized scope up.
    const scopeRef = (await snap()).runtimeScopes[0].scopeRef;
    const instanceId = (await snap()).runtimeInstances[0].instanceId;
    await f.page
      .getByRole("combobox", { name: "关联项目内容", exact: true })
      .selectOption(`${instanceId}|${scopeRef}`);
    await f.page.getByRole("button", { name: "关联", exact: true }).click();
    await expect(panel.getByTestId("access-summary")).toHaveText("已接入");
    await expect(
      f.page.getByRole("navigation", { name: "Runtime 内容" }),
    ).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    await f.page.screenshot({
      path: info.outputPath("access-connected-light.png"),
    });
    await f.page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await panel.scrollIntoViewIfNeeded();
    await f.page.screenshot({
      path: info.outputPath("access-connected-dark.png"),
    });
    await f.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
    );
    await expect
      .poll(() => f.page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual([900, 680]);
    await panel.scrollIntoViewIfNeeded();
    await f.page.screenshot({
      path: info.outputPath("access-connected-dark-900.png"),
    });
    await f.page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "light"),
    );
    // 访问权限: the authorization is one entry; revoking asks first, cancel keeps it.
    await panel.getByRole("button", { name: "在访问权限中查看或撤销" }).click();
    // The refused (withdrawn) authorization is listed too, as 已撤销, after the usable one.
    const entries = f.page
      .getByRole("region", { name: "扩展授权" })
      .getByTestId("extension-grant")
      .filter({ hasText: "项目仓库治理接入：项目旅程验证" });
    await expect(entries).toHaveCount(2);
    await expect(entries.first().getByTestId("grant-status")).toHaveText(
      "有效",
    );
    await expect(entries.nth(1).getByTestId("grant-status")).toHaveText(
      "已撤销",
    );
    const entry = entries.first();
    await expect(entry.getByTestId("grant-operations")).toHaveText(
      "runtime.snapshot.open、runtime.snapshot.next、runtime.events.subscribe、runtime.events.ack、runtime.resource.read、runtime.action.invoke、runtime.operation.get、runtime.operation.cancel（共 8 项）",
    );
    await expect(entry.getByTestId("grant-operations")).toContainText(
      "（共 8 项）",
    );
    await expect(entry.getByTestId("grant-status")).toHaveText("有效");
    await entry.getByRole("button", { name: /^撤销 / }).click();
    const revoke = f.page.getByRole("dialog", { name: "撤销扩展授权" });
    await expect(revoke).toContainText(f.folder);
    await f.page.screenshot({
      path: info.outputPath("access-revoke-light.png"),
    });
    await revoke.getByRole("button", { name: "取消", exact: true }).click();
    await expect(entry.getByTestId("grant-status")).toHaveText("有效");
    await entry.getByRole("button", { name: /^撤销 / }).click();
    await revoke.getByRole("button", { name: "确认撤销" }).click();
    await expect(revoke).toHaveCount(0);
    await expect(entries.getByTestId("grant-status")).toHaveText([
      "已撤销",
      "已撤销",
    ]);
    await expect(entries.getByRole("button")).toHaveCount(0);
    await f.page.screenshot({
      path: info.outputPath("access-revoked-light.png"),
    });
    const afterRevoke = await snap();
    expect(
      afterRevoke.runtimeGrants.filter((g) => g.status === "active"),
    ).toHaveLength(0);
    expect(afterRevoke.runtimeScopes[0].state).toBe("inactive");
    // Back in the project: the dependent actions stop, a new review re-authorizes with new references.
    await goTo(f.page, "项目");
    // 全部项目 opens the project list; the project row reopens its detail, as returning to it did before.
    await f.page.locator(".project-open").first().click();
    await expect(panel.getByTestId("access-summary")).toHaveText("接入未完成");
    await expect(panel.getByTestId("access-grant-state")).toHaveText(
      /^授权已于 .+ 撤销；重新核对范围后再授权。$/,
    );
    await expect(
      f.page
        .getByRole("region", { name: "项目进度" })
        .getByText("项目访问尚未授权或授权已撤销。", { exact: true }),
    ).toBeVisible();
    await panel.getByTestId("access-grant-state").scrollIntoViewIfNeeded();
    await f.page.screenshot({
      path: info.outputPath("access-project-revoked-light-900.png"),
    });
    await panel.getByRole("button", { name: "核对并授权…" }).click();
    // 900 × 680: the review scrolls while its decision buttons stay in view.
    await expect(
      review.getByRole("button", { name: "确认授权" }),
    ).toBeInViewport();
    await f.page.screenshot({
      path: info.outputPath("access-review-light-900.png"),
    });
    await review.getByRole("button", { name: "确认授权" }).click();
    await expect(panel.getByTestId("access-summary")).toHaveText("已接入");
    await panel.scrollIntoViewIfNeeded();
    await f.page.screenshot({
      path: info.outputPath("access-reauthorized-light-900.png"),
    });
    const again = (await snap()).runtimeGrants.filter(
      (g) => g.status === "active",
    );
    expect(again).toHaveLength(8);
    expect(
      again.some((g) => grants.some((old) => old.ref.id === g.ref.id)),
    ).toBe(false);
  } finally {
    await closeLocal(f.app);
  }
});
test("project runtime: real Host projection, explicit context, loopback send and revoked authority remain scoped", async ({}, info) => {
  const f = await setup();
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "已收到所选项目上下文。" } }] })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const bundle = buildBundle(join(f.root, "bundle"), newPublisher(), {
      runtimeId: "runtime:test-list",
      version: "1",
      entrypoint: "list-fake.cjs",
      entrypointBytes: buildFake(listFakeEntry),
      launcher: "electron-node",
      argv: ["${instanceDir}", "${contractDigest}"],
      capabilities: [{ capability: LIST_CAPABILITY, schema: LIST_SCHEMA }],
    });
    const target = await f.app.evaluate(
      async (_, { bundle, folder }) => {
        const host = globalThis.runtimeHost;
        const imported = await host.supervisor.importBundle(
          bundle,
          "project-test",
        );
        if (!imported.ok) throw Error(JSON.stringify(imported));
        const instanceId = host.records()!.runtimeInstances[0].instanceId,
          resource = await host.registerResource(folder),
          scope = await host.openScope(instanceId, resource.handle);
        const grant = await host.grant(
          instanceId,
          scope.scopeRef,
          "csthink.test.list-confirm",
          "directory.read",
          "project synthetic test",
        );
        await host.authorize(instanceId, scope.scopeRef);
        await host.sync(instanceId, scope.scopeRef);
        await host.awaitCurrent(instanceId, scope.scopeRef);
        await host.invoke(instanceId, scope.scopeRef, {
          actionId: "entry.create",
          objectRef: "directory:root",
          payload: {
            choice: "create",
            arguments: { title: "独立任务", group: "inbox" },
          },
        });
        return { instanceId, scopeRef: scope.scopeRef, grantId: grant.ref.id };
      },
      { bundle: bundle.dir, folder: f.folder },
    );
    await f.page
      .getByRole("combobox", { name: "关联项目内容", exact: true })
      .selectOption(`${target.instanceId}|${target.scopeRef}`);
    await f.page.getByRole("button", { name: "关联", exact: true }).click();
    await expect(
      f.page.getByRole("navigation", { name: "Runtime 内容" }),
    ).toContainText("独立任务");
    await f.page
      .getByRole("button", { name: "新建项目对话", exact: true })
      .click();
    await f.page
      .getByRole("combobox", { name: "讨论对象", exact: true })
      .selectOption("directory:root");
    await f.page
      .getByRole("navigation", { name: "Runtime 内容" })
      .getByRole("button", { name: "独立任务", exact: true })
      .click();
    await expect(
      f.page.getByRole("combobox", { name: "讨论对象", exact: true }),
    ).toHaveValue("directory:root");
    const connection = await f.page.evaluate(
      async (port) => {
        const secret = await window.desktop.saveSecret(
          "synthetic-project-chat-key",
        );
        if (!secret.ok) throw Error(JSON.stringify(secret));
        const id = crypto.randomUUID();
        const r = await window.desktop.command({
          type: "upsertConnection",
          id,
          name: "本地合成模型",
          provider: "custom",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "synthetic",
          secretRef: secret.secretRef,
          imageInput: "unknown",
          contextChars: null,
          revision: 0,
        });
        if (!r.ok) throw Error(JSON.stringify(r));
        return id;
      },
      (server.address() as AddressInfo).port,
    );
    await f.page
      .getByRole("combobox", { name: "项目对话模型", exact: true })
      .selectOption(`${connection}::synthetic`);
    await f.page
      .getByRole("textbox", { name: "项目对话输入", exact: true })
      .fill("请说明当前讨论对象");
    await f.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(f.page.getByLabel("助手消息", { exact: true })).toContainText(
      "已收到所选项目上下文。",
    );
    expect(bodies.length).toBe(1);
    const sent = JSON.stringify(bodies[0]);
    expect(sent).toContain("directory:root");
    expect(sent).toContain("只发送明确选择的上下文");
    expect(sent).not.toContain(f.folder);
    expect(sent).not.toContain("entry:e1");
    await goTo(f.page, "聊天");
    const summary = f.page.getByRole("region", {
      name: "项目对话上下文",
      exact: true,
    });
    await expect(summary).toContainText("项目旅程验证");
    await expect(summary).toContainText("当前讨论：");
    await summary
      .getByRole("button", { name: "打开项目", exact: true })
      .click();
    await expect(
      f.page.getByRole("combobox", { name: "讨论对象", exact: true }),
    ).toHaveValue("directory:root");
    await expect(
      f.page.getByRole("navigation", { name: "Runtime 内容" }),
    ).toContainText("独立任务");
    await expect(
      f.page.getByText("讨论对象版本已变化，请重新选择。", { exact: true }),
    ).toHaveCount(0);
    await f.page.screenshot({
      path: info.outputPath("project-runtime-context.png"),
      fullPage: true,
    });
    await f.page
      .getByRole("textbox", { name: "项目对话输入", exact: true })
      .fill("撤销后保留这段草稿");
    await f.app.evaluate(async (_, target) => {
      await globalThis.runtimeHost.revokeGrant(
        target.instanceId,
        target.grantId,
      );
    }, target);
    await expect(
      f.page.getByRole("button", { name: "发送", exact: true }),
    ).toBeDisabled();
    await expect(
      f.page.getByRole("textbox", { name: "项目对话输入", exact: true }),
    ).toHaveValue("撤销后保留这段草稿");
    expect(bodies.length).toBe(1);
  } finally {
    await closeLocal(f.app);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("project runtime: role controls persist actual model effort and reject unavailable negotiated profiles", async ({}, info) => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/project-role-"));
  const home = join(root, "home");
  mkdirSync(home);
  const claude = createClaudeFixture(join(root, "claude")),
    codex = createCodexFixture(join(root, "codex"));
  const f = await setup({
    ...process.env,
    HOME: home,
    PATH: `${claude.bin}:${codex.bin}:/usr/bin:/bin`,
  });
  try {
    for (const provider of ["claude", "codex"] as const) {
      const r = await f.page.evaluate(async (provider) => {
        const prepared =
          provider === "claude"
            ? await window.desktop.prepareClaude()
            : await window.desktop.prepareCodex();
        if (!prepared.ok) throw Error(JSON.stringify(prepared));
        return provider === "claude"
          ? window.desktop.acceptClaude(prepared.setup.token)
          : window.desktop.acceptCodex(prepared.setup.token);
      }, provider);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    const profiles = await f.app.evaluate(async () => {
      const port = (
        globalThis as unknown as { executionPort: EmbeddedExecutionPort }
      ).executionPort;
      return (await port.refreshProfiles()).map((p) => p.id);
    });
    expect(profiles).toContain(claudeImplementerProfileId);
    const bundle = buildBundle(join(root, "bundle"), newPublisher(), {
      runtimeId: "runtime:test-graph",
      version: "1",
      entrypoint: "graph_fake.py",
      entrypointBytes: readFileSync(join(graphFakeDir, "graph_fake.py")),
      launcher: "python3",
      argv: ["${instanceDir}", "${contractDigest}"],
      dataFormat: "test.g1",
      capabilities: [{ capability: GRAPH_CAPABILITY, schema: GRAPH_SCHEMA }],
      extraMembers: [
        {
          name: "fake_framing.py",
          data: readFileSync(join(graphFakeDir, "fake_framing.py")),
        },
      ],
      executionProfileRequirements: [
        {
          capabilityId: GRAPH_CAPABILITY.id,
          profile: {
            id: claudeImplementerProfileId,
            version: "1",
            digest: claudeImplementerDigest,
          },
        },
      ],
    });
    const target = await f.app.evaluate(
      async (_, { bundle, folder }) => {
        const host = globalThis.runtimeHost;
        const imported = await host.supervisor.importBundle(
          bundle,
          "role-test",
        );
        if (!imported.ok) throw Error(JSON.stringify(imported));
        const instanceId = host.records()!.runtimeInstances[0].instanceId;
        const resource = await host.registerResource(folder),
          scope = await host.openScope(instanceId, resource.handle);
        await host.grant(
          instanceId,
          scope.scopeRef,
          "csthink.test.graph",
          "graph.read",
          "role synthetic test",
        );
        await host.authorize(instanceId, scope.scopeRef);
        await host.sync(instanceId, scope.scopeRef);
        await host.awaitCurrent(instanceId, scope.scopeRef);
        return { instanceId, scopeRef: scope.scopeRef };
      },
      { bundle: bundle.dir, folder: f.folder },
    );
    await f.page
      .getByRole("combobox", { name: "关联项目内容", exact: true })
      .selectOption(`${target.instanceId}|${target.scopeRef}`);
    await f.page.getByRole("button", { name: "关联", exact: true }).click();
    const connections = await f.page.evaluate(async () => {
      const r = await window.desktop.command({ type: "snapshot" });
      if (!r.ok) throw Error(r.message);
      return r.snapshot.connections;
    });
    for (const [label, provider] of [
      ["实施者", "claude"],
      ["评审者", "codex"],
    ]) {
      const c = connections.find((c) => c.provider === provider)!;
      await f.page
        .getByRole("combobox", { name: label + "模型", exact: true })
        .selectOption(`${c.id}::${c.model}`);
      await f.page
        .getByRole("combobox", { name: label + "推理强度", exact: true })
        .selectOption("high");
      await f.page
        .getByRole("button", { name: "保存" + label, exact: true })
        .click();
      await expect(
        f.page.locator(".project-role").filter({
          has: f.page.getByRole("combobox", {
            name: label + "模型",
            exact: true,
          }),
        }),
      ).toContainText(`已保存：${c.model} · high`);
    }
    const roles = await f.app.evaluate(async (_, target) => {
      const host = globalThis.runtimeHost;
      return Promise.all([
        host.roleBinding(
          target.instanceId,
          target.scopeRef,
          "role:implementer",
        ),
        host.roleBinding(target.instanceId, target.scopeRef, "role:reviewer"),
      ]);
    }, target);
    expect(roles.map((r) => r?.effort)).toEqual(["high", "high"]);
    await f.page
      .getByRole("region", { name: "执行角色", exact: true })
      .scrollIntoViewIfNeeded();
    await f.page.screenshot({
      path: info.outputPath("project-roles-light.png"),
    });
    await f.page
      .getByRole("button", { name: "返回项目列表", exact: true })
      .click();
    await f.page
      .locator(".project-open")
      .filter({ hasText: "项目旅程验证" })
      .click();
    await expect(
      f.page.getByRole("combobox", { name: "实施者推理强度", exact: true }),
    ).toHaveValue("high");
    const disabled = connections.find((c) => c.provider === "codex")!;
    const r = await f.page.evaluate(
      (c) =>
        window.desktop.command({
          type: "setConnectionEnabled",
          id: c.id,
          enabled: false,
          revision: c.revision,
          clearDefault: true,
        }),
      disabled,
    );
    expect(r.ok).toBe(true);
    await expect(
      f.page.getByRole("button", { name: "保存评审者", exact: true }),
    ).toBeDisabled();
    expect(
      await f.app.evaluate(
        () => globalThis.runtimeHost.records()!.runtimeExecutions.length,
      ),
    ).toBe(0);
  } finally {
    await closeLocal(f.app);
  }
});
