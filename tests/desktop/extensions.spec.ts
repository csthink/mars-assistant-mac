import { test, expect, type Page } from "@playwright/test";
import { launchLocal } from "./local-client";
import { goTo, ready } from "./shell";
import { scrollIntoCenter } from "./scroll-into-center";
import { buildBundle, newPublisher, sha256 } from "./runtime-fakes/bundle";
import { buildFake, listFakeEntry } from "./runtime-fakes/build";
import { LIST_CAPABILITY, LIST_SCHEMA } from "./runtime-fakes/list-contract";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Snapshot } from "../../src/shared/protocol";

/**
 * Runs the production main process, preload, business service and renderer in the
 * background client; the only stub is the directory dialog, which returns a bundle
 * directory built in the test process. Bundles never leave .test-data.
 */
function bundles() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const dir = mkdtempSync(resolve(".test-data/disposable/extensions-"));
  const publisher = newPublisher();
  const other = newPublisher("publisher:someone-else");
  const listSpec = {
    runtimeId: "runtime:test-list",
    version: "1",
    entrypoint: "list-fake.cjs",
    entrypointBytes: buildFake(listFakeEntry),
    launcher: "electron-node" as const,
    argv: ["${instanceDir}", "${contractDigest}"],
    capabilities: [{ capability: LIST_CAPABILITY, schema: LIST_SCHEMA }],
  };
  mkdirSync(join(dir, "data"));
  return {
    root: join(dir, "data"),
    good: buildBundle(join(dir, "good"), publisher, listSpec).dir,
    badSignature: buildBundle(join(dir, "bad-signature"), publisher, listSpec, {
      signWith: other.privateKey,
    }).dir,
    incompatible: buildBundle(join(dir, "incompatible"), publisher, {
      ...listSpec,
      runtimeId: "runtime:test-old",
      protocols: [{ version: "0.1.0-draft.4", contractDigest: sha256("old") }],
    }).dir,
  };
}
async function launch(root: string) {
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  await ready(page);
  return { app, page };
}
async function openExtensions(page: Page) {
  await goTo(page, "设置");
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "扩展管理", exact: true })
    .click();
  const section = page.getByRole("region", { name: "扩展管理" });
  await expect(section.getByRole("heading", { level: 2 })).toHaveText("扩展");
  return section;
}
const snapshot = (page: Page) =>
  page.evaluate(async () => {
    const reply = await window.desktop.command({ type: "snapshot" });
    if (!reply.ok) throw new Error(reply.message);
    return reply.snapshot as Snapshot;
  });
const card = (page: Page, name: string) =>
  page.getByRole("article", { name: `${name} 扩展`, exact: true });

test("extensions: the settings category lists the catalog honestly, an offline import admits the list fake and the card shows its real state, version, source and health", async ({}, info) => {
  const built = bundles();
  const { app, page } = await launch(built.root);
  try {
    const section = await openExtensions(page);
    // Catalog before any bundle: AI-SDLC is not installed and has no start/stop control; knowledge stays planned.
    const sdlc = card(page, "AI-SDLC");
    await expect(sdlc.locator(".extension-badge")).toHaveText("未安装");
    await expect(sdlc.getByRole("button", { name: "检查更新" })).toBeDisabled();
    await expect(sdlc.getByRole("switch")).toHaveCount(0);
    await expect(
      sdlc.getByRole("button", { name: /管理|启用|停用|卸载/ }),
    ).toHaveCount(0);
    const knowledge = card(page, "知识库");
    await expect(knowledge.locator(".extension-badge")).toHaveText("规划中");
    await knowledge.getByRole("button", { name: "了解扩展" }).click();
    await expect(knowledge.getByRole("status")).toContainText(
      "首阶段不提供安装",
    );
    await expect(knowledge.getByRole("button", { name: /安装/ })).toHaveCount(
      0,
    );
    // Offline import through the directory dialog: the only path a bundle can enter.
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, built.good);
    await section.getByRole("button", { name: "从本地导入运行包…" }).click();
    await expect(page.getByTestId("import-result")).toHaveText(
      "已导入并开始可用性检查。",
    );
    // The outcome also flashes as a self-dismissing notice (status, not alert, for an accepted import).
    const flash = page.getByTestId("import-flash");
    await expect(flash).toHaveAttribute("role", "status");
    await expect(flash).toHaveAttribute("data-outcome", "accepted");
    await expect(flash).toContainText("已导入并开始可用性检查。");
    await flash.getByRole("button", { name: "关闭提示" }).click();
    await expect(flash).toHaveCount(0);
    const list = card(page, "test-list");
    await expect(list.getByTestId("extension-state")).toHaveText("可用");
    await expect(list.locator("[data-extension-version]")).toHaveText("1");
    await expect(list.locator(".extension-metadata")).toContainText(
      "csthink-test（密钥",
    );
    await expect(list.locator(".extension-metadata")).toContainText(
      "运行中，PID",
    );
    await expect(list.getByTestId("extension-health")).toContainText("正常");
    await expect(list.getByRole("button", { name: "检查更新" })).toBeDisabled();
    await expect(list.getByRole("button", { name: "重新连接" })).toHaveCount(0);
    const current = await snapshot(page);
    expect(current.runtimeInstallations).toHaveLength(1);
    expect(current.runtimeInstances[0].state).toBe("ready");
    expect(
      current.runtimeInstances[0].negotiation?.selectedProtocol.version,
    ).toBe("0.1.0-draft.5");
    await page.screenshot({
      path: info.outputPath("extensions-available-light.png"),
    });
    // A bad signature is refused with its code and reasons; no card appears.
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, built.badSignature);
    await section.getByRole("button", { name: "从本地导入运行包…" }).click();
    await expect(page.getByTestId("import-result")).toContainText(
      "导入被拒绝（INVALID_SOURCE，来源签名或发布者不可信）",
    );
    await expect(page.getByTestId("import-result")).toContainText(
      "signature does not verify",
    );
    // A rejection flashes as an alert with the same code and reason, then leaves on its own
    // while the inline result line stays (V-15 r1: the inline line alone was easy to miss).
    await expect(flash).toHaveAttribute("role", "alert");
    await expect(flash).toHaveAttribute("data-outcome", "rejected");
    await expect(flash).toContainText(
      "导入被拒绝（INVALID_SOURCE，来源签名或发布者不可信）",
    );
    await expect(flash).toHaveCount(0, { timeout: 10000 });
    await expect(page.getByTestId("import-result")).toContainText(
      "signature does not verify",
    );
    await expect(page.getByRole("article", { name: /扩展$/ })).toHaveCount(3);
    expect((await snapshot(page)).runtimeInstallations).toHaveLength(1);
    // A verified bundle for another protocol is recorded as incompatible, never started, never installable.
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, built.incompatible);
    await section.getByRole("button", { name: "从本地导入运行包…" }).click();
    await expect(page.getByTestId("import-result")).toHaveText(
      "已核验身份，但与本机不兼容，未启动。",
    );
    await expect(flash).toHaveAttribute("data-outcome", "incompatible");
    const old = card(page, "test-old");
    await expect(old.getByTestId("extension-state")).toHaveText("版本不兼容");
    await expect(old.getByRole("status")).toContainText(
      "平台、系统或协议版本不匹配：manifest does not offer Contract 0.1.0",
    );
    await expect(
      old.getByRole("button", { name: "查看适用更新" }),
    ).toBeDisabled();
    await expect(old.locator(".extension-metadata")).toContainText("未启动");
    const after = await snapshot(page);
    expect(after.runtimeInstallations).toHaveLength(2);
    expect(after.runtimeInstances).toHaveLength(1);
    // Cancelling the dialog imports nothing.
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => ({
        canceled: true,
        filePaths: [],
      })) as typeof dialog.showOpenDialog;
    });
    await section.getByRole("button", { name: "从本地导入运行包…" }).click();
    await expect(page.getByTestId("import-result")).toHaveText("已取消导入。");
    // A cancelled dialog flashes nothing new: the previous notice is gone or unchanged.
    await expect(flash.filter({ hasText: "已取消导入。" })).toHaveCount(0);
    // Dark appearance keeps the badges and buttons readable.
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "通用", exact: true })
      .click();
    await page
      .getByRole("group", { name: "外观" })
      .getByRole("button", { name: "深色" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "扩展管理", exact: true })
      .click();
    await expect(
      card(page, "test-list").getByTestId("extension-state"),
    ).toHaveText("可用");
    await page.screenshot({ path: info.outputPath("extensions-dark.png") });
  } finally {
    await app.close();
  }
});

/** Texts of the visible settings controls and result lines the import notice covers (KB-316). */
const coveredByFlash = (page: Page) =>
  page.evaluate(() => {
    const flash = document.querySelector('[data-testid="import-flash"]');
    if (!flash) throw new Error("the import notice is not shown");
    const f = flash.getBoundingClientRect();
    const region = document.querySelector('section[aria-label="扩展管理"]')!;
    return [
      ...region.querySelectorAll(
        'button, summary, [data-testid="import-result"], [data-testid="import-pin"], [data-testid="extension-state"]',
      ),
    ].flatMap((el) => {
      // Only what is drawn: the copy buttons of a closed 接入信息 still have layout boxes.
      if (el.closest('[data-testid="import-flash"]') || !el.checkVisibility())
        return [];
      const r = el.getBoundingClientRect();
      return r.width > 0 &&
        r.height > 0 &&
        r.left < f.right &&
        r.right > f.left &&
        r.top < f.bottom &&
        r.bottom > f.top
        ? [(el.textContent ?? "").trim().slice(0, 40)]
        : [];
    });
  });

test("extensions: the import notice at the bottom of the window covers no card control or result line, accepted in the default window and rejected at 900 × 680 in dark (KB-316)", async ({}, info) => {
  const built = bundles();
  const { app, page } = await launch(built.root);
  const pick = (path: string) =>
    app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, path);
  try {
    const section = await openExtensions(page);
    await pick(built.good);
    await section.getByRole("button", { name: "从本地导入运行包…" }).click();
    const flash = page.getByTestId("import-flash");
    await expect(flash).toHaveAttribute("data-outcome", "accepted");
    await expect(
      card(page, "test-list").getByTestId("extension-state"),
    ).toHaveText("可用");
    await expect(page.getByTestId("import-pin")).toBeVisible();
    expect(await coveredByFlash(page)).toEqual([]);
    await page.screenshot({
      path: info.outputPath("import-notice-accepted-light.png"),
    });
    await flash.getByRole("button", { name: "关闭提示" }).click();
    await expect(flash).toHaveCount(0);
    await page.evaluate(() =>
      window.desktop.command({ type: "setAppearance", appearance: "dark" }),
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680),
    );
    await expect
      .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual([900, 680]);
    await pick(built.badSignature);
    await section.getByRole("button", { name: "从本地导入运行包…" }).click();
    await expect(flash).toHaveAttribute("data-outcome", "rejected");
    await expect(page.getByTestId("import-result")).toContainText(
      "signature does not verify",
    );
    expect(await coveredByFlash(page)).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("import-notice-rejected-dark-900.png"),
    });
  } finally {
    await app.close();
  }
});

test("extensions: 接入信息 shows the persisted instance and package directories and the pinned publisher key read-only, copies come from the Host records, an identical re-import answers with the recorded installation and changed bytes under the same version are refused", async ({}, info) => {
  const built = bundles();
  const publisher = newPublisher();
  const listSpec = {
    runtimeId: "runtime:test-list",
    version: "1",
    entrypoint: "list-fake.cjs",
    entrypointBytes: buildFake(listFakeEntry),
    launcher: "electron-node" as const,
    argv: ["${instanceDir}", "${contractDigest}"],
    capabilities: [{ capability: LIST_CAPABILITY, schema: LIST_SCHEMA }],
  };
  const good = buildBundle(
    join(built.root, "..", "pinned-good"),
    publisher,
    listSpec,
  ).dir;
  // Same publisher, same version, other bytes; and the same version from another key.
  const changed = buildBundle(join(built.root, "..", "changed"), publisher, {
    ...listSpec,
    argv: [...listSpec.argv, "--changed"],
  }).dir;
  const foreign = buildBundle(
    join(built.root, "..", "foreign"),
    newPublisher(),
    listSpec,
  ).dir;
  const { app, page } = await launch(built.root);
  const pick = (path: string) =>
    app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, path);
  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    const section = await openExtensions(page);
    await pick(good);
    await section.getByRole("button", { name: "从本地导入运行包…" }).click();
    await expect(page.getByTestId("import-result")).toHaveText(
      "已导入并开始可用性检查。",
    );
    // First use of this runtimeId: the pin is stated with the digest to check out of band (KB-278 item 7).
    const current = await snapshot(page);
    const installation = current.runtimeInstallations[0];
    await expect(page.getByTestId("import-pin")).toContainText(
      "首次导入该扩展，已按本次携带的公钥固定发布者（摘要 " +
        installation.publicKeyDigest.slice(0, 12),
    );
    const list = card(page, "test-list");
    await expect(list.getByTestId("extension-state")).toHaveText("可用");
    const instance = (await snapshot(page)).runtimeInstances[0];
    const directories = instance.launchDirectories!;
    expect(directories.instanceDir).toBe(instance.launchArgv[2]);
    const access = list.getByTestId("extension-access");
    await expect(access.locator("summary")).toHaveText("接入信息");
    await access.locator("summary").click();
    await expect(access.getByTestId("fact-instance-value")).toHaveText(
      instance.instanceId,
    );
    await expect(access.getByTestId("fact-instance-dir-value")).toHaveText(
      directories.instanceDir,
    );
    await expect(access.getByTestId("fact-package-dir-value")).toHaveText(
      directories.packageDir,
    );
    await expect(access.getByTestId("fact-publisher-key-value")).toHaveText(
      installation.publicKeyDigest,
    );
    // Read-only: no input, and the instance identity has no copy action of its own.
    await expect(access.locator("input, textarea, select")).toHaveCount(0);
    await expect(
      access.getByRole("button", { name: "复制实例", exact: true }),
    ).toHaveCount(0);
    for (const [label, value] of [
      ["实例目录", directories.instanceDir],
      ["包目录", directories.packageDir],
      ["发布者公钥摘要", installation.publicKeyDigest],
    ]) {
      const button = access.getByRole("button", { name: "复制" + label });
      await button.click();
      await expect(button).toHaveText("已复制");
      expect(await clipboard()).toBe(value);
      await expect(button).toHaveText("复制", { timeout: 5000 });
    }
    // A taller window shows the whole opened section for the screenshot review.
    const showAccess = async () => {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(1180, 1500),
      );
      await list
        .getByTestId("extension-access")
        .evaluate((el) => el.scrollIntoView({ block: "center" }));
    };
    await showAccess();
    await page.screenshot({
      path: info.outputPath("extensions-access-light.png"),
    });
    // The main process copies only what the records hold: unknown or malformed targets change nothing.
    const refusals = await page.evaluate(async () => [
      await window.desktop.copyRuntimeValue({
        field: "instanceDir",
        instanceId: "instance:unknown",
      }),
      await window.desktop.copyRuntimeValue({
        field: "path",
        value: "/etc/passwd",
      } as never),
      await window.desktop.copyRuntimeValue({
        field: "resourceHandle",
        handle: "resource:unregistered",
      }),
    ]);
    expect(refusals).toEqual([
      { ok: false, message: "记录中没有这项内容。" },
      { ok: false, message: "复制参数无效。" },
      { ok: false, message: "记录中没有这项内容。" },
    ]);
    expect(await clipboard()).toBe(installation.publicKeyDigest);
    // The same bytes again: the recorded installation answers; no second installation or instance (KB-278 item 6).
    await pick(good);
    await section.getByRole("button", { name: "从本地导入运行包…" }).click();
    await expect(page.getByTestId("import-result")).toHaveText(
      "该版本已导入过且内容相同，未新建安装。",
    );
    await expect(page.getByTestId("import-flash")).toHaveAttribute(
      "data-outcome",
      "existing",
    );
    await expect(page.getByTestId("import-pin")).toHaveCount(0);
    // Changed bytes under version 1 from the pinned publisher are refused before anything is unpacked.
    await pick(changed);
    await section.getByRole("button", { name: "从本地导入运行包…" }).click();
    await expect(page.getByTestId("import-result")).toContainText(
      "导入被拒绝（INTEGRITY_MISMATCH，包内容与发布记录不一致）：version 1 of runtime:test-list is already installed with a different archive or release record",
    );
    // Another key for the pinned runtimeId is refused by the pin, whatever the version says.
    await pick(foreign);
    await section.getByRole("button", { name: "从本地导入运行包…" }).click();
    await expect(page.getByTestId("import-result")).toContainText(
      "publisher key differs from the key pinned for runtime:test-list",
    );
    const after = await snapshot(page);
    expect(after.runtimeInstallations).toHaveLength(1);
    expect(after.runtimeInstances).toHaveLength(1);
    await expect(page.getByRole("article", { name: /扩展$/ })).toHaveCount(3);
    // Dark appearance keeps the facts readable.
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "通用", exact: true })
      .click();
    await page
      .getByRole("group", { name: "外观" })
      .getByRole("button", { name: "深色" })
      .click();
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "扩展管理", exact: true })
      .click();
    const dark = card(page, "test-list").getByTestId("extension-access");
    await dark.locator("summary").click();
    await expect(dark.getByTestId("fact-instance-dir-value")).toBeVisible();
    await showAccess();
    await page.screenshot({
      path: info.outputPath("extensions-access-dark.png"),
    });
  } finally {
    await app.close();
  }
});

test("extensions: a lost process shows a connection error with the real reason, reconnect starts a new incarnation, and a restarted client re-activates the installation", async () => {
  const built = bundles();
  let { app, page } = await launch(built.root);
  try {
    await openExtensions(page);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, built.good);
    await page.getByRole("button", { name: "从本地导入运行包…" }).click();
    const list = card(page, "test-list");
    await expect(list.getByTestId("extension-state")).toHaveText("可用");
    const before = (await snapshot(page)).runtimeInstances[0];
    process.kill(before.pid!, "SIGKILL");
    await expect(list.getByTestId("extension-state")).toHaveText("连接异常");
    await expect(list.getByRole("status")).toContainText(
      "进程已退出（退出码 无，信号 SIGKILL）",
    );
    await expect(list.getByRole("status")).toContainText(
      "重新连接不会自动继续任务或重放操作",
    );
    await expect(list.locator(".extension-metadata")).toContainText("已退出");
    await list.getByRole("button", { name: "重新连接" }).click();
    await expect(list.getByTestId("extension-state")).toHaveText("可用");
    const after = (await snapshot(page)).runtimeInstances[0];
    expect(after.instanceId).toBe(before.instanceId);
    expect(after.incarnationId).not.toBe(before.incarnationId);
    expect(after.connectionId).not.toBe(before.connectionId);
    expect(after.controlGeneration).toBe("2");
    const pid = after.pid!;
    await app.close();
    // Quit shuts the runtime down: the process is gone, not orphaned.
    expect(() => process.kill(pid, 0)).toThrow();
    ({ app, page } = await launch(built.root));
    await openExtensions(page);
    const again = card(page, "test-list");
    await expect(again.getByTestId("extension-state")).toHaveText("可用");
    const restarted = (await snapshot(page)).runtimeInstances[0];
    expect(restarted.instanceId).toBe(before.instanceId);
    expect(restarted.incarnationId).not.toBe(after.incarnationId);
    expect(restarted.controlGeneration).toBe("3");
  } finally {
    await app.close();
  }
});

test("extensions: the card's diagnostics show scope authorization, freshness and watermark from the Host records, turn stale when the process is lost and return to current after reconnect", async ({}, info) => {
  const built = bundles();
  mkdirSync(join(built.root, "..", "project"));
  const project = join(built.root, "..", "project");
  const { app, page } = await launch(built.root);
  try {
    await openExtensions(page);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, built.good);
    await page.getByRole("button", { name: "从本地导入运行包…" }).click();
    const list = card(page, "test-list");
    await expect(list.getByTestId("extension-state")).toHaveText("可用");
    await list.getByText("运行诊断").click();
    await expect(list.locator(".extension-diagnostics")).toContainText(
      "尚未接入项目资源",
    );
    // A scope opened, authorized and synchronised through the Host API appears with its real sync state.
    await app.evaluate(async ({ app: _app }, project) => {
      void _app;
      const host = (
        globalThis as unknown as {
          runtimeHost: import("../../src/main/runtime-host").RuntimeHost;
        }
      ).runtimeHost;
      const instanceId = host.records()!.runtimeInstances[0].instanceId;
      const resource = await host.registerResource(project);
      const scope = await host.openScope(instanceId, resource.handle);
      await host.grant(
        instanceId,
        scope.scopeRef,
        "csthink.test.list-confirm",
        "directory.read",
        "desktop test",
      );
      await host.authorize(instanceId, scope.scopeRef);
      await host.sync(instanceId, scope.scopeRef);
      await host.awaitCurrent(instanceId, scope.scopeRef);
      await host.invoke(instanceId, scope.scopeRef, {
        actionId: "entry.create",
        objectRef: "directory:root",
        payload: {
          choice: "create",
          arguments: { title: "诊断条目", group: "inbox" },
        },
      });
    }, project);
    const scopeRow = list.getByTestId("extension-scope");
    await expect(scopeRow).toContainText("scope:list-1");
    await expect(scopeRow).toContainText("已授权");
    await expect(scopeRow.getByTestId("scope-freshness")).toHaveText("实时");
    await expect(scopeRow.getByTestId("scope-cursor")).toContainText(
      "水位 epoch:1 /",
    );
    await expect(scopeRow).toContainText("对象 2，操作 4/4，待处理 1");
    const operationRow = list.getByTestId("extension-operation").first();
    await expect(operationRow).toContainText("entry.create");
    await expect(operationRow).toContainText("succeeded");
    await page.screenshot({
      path: info.outputPath("extensions-diagnostics.png"),
    });
    // Process loss: the scope is stale with the real reason; reconnect resumes the scope to current with the same watermark basis.
    const pid = (await snapshot(page)).runtimeInstances[0].pid!;
    process.kill(pid, "SIGKILL");
    await expect(list.getByTestId("extension-state")).toHaveText("连接异常");
    await expect(scopeRow.getByTestId("scope-freshness")).toHaveText("过期");
    await expect(scopeRow).toContainText("RUNTIME_EXITED");
    await list.getByRole("button", { name: "重新连接" }).click();
    await expect(list.getByTestId("extension-state")).toHaveText("可用");
    await expect(scopeRow.getByTestId("scope-freshness")).toHaveText("实时");
    await expect(scopeRow).toContainText("已授权");
    await expect(scopeRow).toContainText("对象 2，操作 4/4，待处理 1");
  } finally {
    await app.close();
  }
});

test("extensions: 访问权限 lists every extension grant with subject, capability, resource, expiry and status; revoking one takes effect at once, shows the paused dependent operation, drops the scope to unauthorized, and a replayed request is refused as PERMISSION_REVOKED in the diagnostics", async ({}, info) => {
  const built = bundles();
  mkdirSync(join(built.root, "..", "project"));
  const project = join(built.root, "..", "project");
  const { app, page } = await launch(built.root);
  try {
    await openExtensions(page);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, built.good);
    await page.getByRole("button", { name: "从本地导入运行包…" }).click();
    const list = card(page, "test-list");
    await expect(list.getByTestId("extension-state")).toHaveText("可用");
    // Through the Host API: a scope with one grant, one answered action and one action whose answer was lost.
    const ids = await app.evaluate(async ({ app: _app }, project) => {
      void _app;
      const host = (
        globalThis as unknown as {
          runtimeHost: import("../../src/main/runtime-host").RuntimeHost;
        }
      ).runtimeHost;
      const instanceId = host.records()!.runtimeInstances[0].instanceId;
      const resource = await host.registerResource(project);
      const scope = await host.openScope(instanceId, resource.handle);
      const grant = await host.grant(
        instanceId,
        scope.scopeRef,
        "csthink.test.list-confirm",
        "directory.read",
        "desktop test",
      );
      await host.authorize(instanceId, scope.scopeRef);
      await host.sync(instanceId, scope.scopeRef);
      await host.awaitCurrent(instanceId, scope.scopeRef);
      const answered = await host.invoke(instanceId, scope.scopeRef, {
        actionId: "entry.create",
        objectRef: "directory:root",
        payload: {
          choice: "create",
          arguments: { title: "已应答", group: "inbox" },
        },
      });
      return {
        instanceId,
        scopeRef: scope.scopeRef,
        grantId: grant.ref.id,
        answered: answered.operationId,
        instanceDir: host.records()!.runtimeInstances[0].launchArgv[2],
      };
    }, project);
    writeFileSync(
      join(ids.instanceDir, "fault.json"),
      JSON.stringify({ dropResponse: "runtime.action.invoke" }),
    );
    const lost = await app.evaluate(
      async ({ app: _app }, { instanceId, scopeRef }) => {
        void _app;
        const host = (
          globalThis as unknown as {
            runtimeHost: import("../../src/main/runtime-host").RuntimeHost;
          }
        ).runtimeHost;
        await host.awaitCurrent(instanceId, scopeRef);
        return host.invoke(instanceId, scopeRef, {
          actionId: "entry.create",
          objectRef: "directory:root",
          payload: {
            choice: "create",
            arguments: { title: "应答丢失", group: "inbox" },
          },
        });
      },
      ids,
    );
    writeFileSync(join(ids.instanceDir, "fault.json"), "{}");
    expect(lost.transport).toBe("lost");
    await list.getByText("运行诊断").click();
    await expect(list.getByTestId("extension-grants")).toHaveText(
      "授权 有效 1，已撤销 0，已到期 0",
    );
    // 访问权限 → 扩展授权: the grant with its subject, capability, resource, expiry and status.
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "访问权限", exact: true })
      .click();
    const grants = page.getByRole("region", { name: "扩展授权" });
    await expect(grants.getByRole("heading", { level: 2 })).toHaveText(
      "扩展授权",
    );
    const row = grants.getByTestId("extension-grant");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("test-list");
    await expect(row).toContainText(ids.instanceId);
    await expect(row).toContainText(
      "csthink.test.list-confirm（directory.read）",
    );
    await expect(row).toContainText(project);
    await expect(row).toContainText("至 ");
    await expect(row).toContainText("desktop test");
    await expect(row.getByTestId("grant-status")).toHaveText("有效");
    await expect(row.getByTestId("grant-paused")).toHaveCount(0);
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("extension-grants.png") });
    // Revoke after confirmation (ACCESS-01): cancel keeps the grant; confirm takes effect at once, the unanswered
    // dependent operation is shown paused, the button is gone.
    await row.getByRole("button", { name: /^撤销 / }).click();
    const confirmRevoke = page.getByRole("dialog", { name: "撤销扩展授权" });
    await expect(confirmRevoke).toContainText("csthink.test.list-confirm");
    await confirmRevoke
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(row.getByTestId("grant-status")).toHaveText("有效");
    await row.getByRole("button", { name: /^撤销 / }).click();
    await confirmRevoke.getByRole("button", { name: "确认撤销" }).click();
    await expect(row.getByTestId("grant-status")).toHaveText("已撤销");
    await expect(row).toContainText("撤销");
    await expect(row.getByTestId("grant-paused")).toContainText(
      "依赖操作已暂停：entry.create",
    );
    await expect(row.getByRole("button")).toHaveCount(0);
    await expect(row).toHaveAttribute("data-status", "revoked");
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath("extension-grants-revoked.png"),
    });
    const after = await snapshot(page);
    expect(after.runtimeGrants[0].status).toBe("revoked");
    expect(after.runtimeScopes[0].state).toBe("inactive");
    expect(after.runtimeScopes[0].grantRefs).toEqual([]);
    // A replay of the answered request cites the revoked grant: refused as PERMISSION_REVOKED, visible in the diagnostics.
    const replayed = await app.evaluate(
      ({ app: _app }, { instanceId, answered }) => {
        void _app;
        const host = (
          globalThis as unknown as {
            runtimeHost: import("../../src/main/runtime-host").RuntimeHost;
          }
        ).runtimeHost;
        return host.resend(instanceId, answered);
      },
      ids,
    );
    expect(replayed.errorCode).toBe("PERMISSION_REVOKED");
    const section = await openExtensions(page);
    void section;
    const diagnostics = card(page, "test-list");
    await diagnostics.getByText("运行诊断").click();
    await expect(diagnostics.getByTestId("extension-grants")).toHaveText(
      "授权 有效 0，已撤销 1，已到期 0",
    );
    await expect(diagnostics.getByTestId("extension-scope")).toContainText(
      "未授权",
    );
    const refused = diagnostics
      .getByTestId("extension-operation")
      .filter({ hasText: "PERMISSION_REVOKED" });
    await expect(refused).toHaveCount(1);
    await expect(refused).toContainText("恢复 reauthorize");
    await refused.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath("extension-grants-diagnostics.png"),
    });
  } finally {
    await app.close();
  }
});

test("extensions: the card follows the real checks: the periodic health check turns a degraded runtime into 待核实 with 重新核实, a hung health answer shows 连接异常 with the timeout instead of the cached success, 重新连接 passes through 待核实 before 可用 without replaying operations, diagnostics list process, protocol, scope, grants and operations, and badges, focus rings and buttons stay usable in dark appearance and at 900 × 680", async ({}, info) => {
  test.setTimeout(240_000);
  const built = bundles();
  mkdirSync(join(built.root, "..", "project"));
  const project = join(built.root, "..", "project");
  const { app, page } = await launch(built.root);
  try {
    await openExtensions(page);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, built.good);
    await page.getByRole("button", { name: "从本地导入运行包…" }).click();
    const list = card(page, "test-list");
    const state = list.getByTestId("extension-state");
    await expect(state).toHaveText("可用");
    const ids = await app.evaluate(async ({ app: _app }, project) => {
      void _app;
      const host = (
        globalThis as unknown as {
          runtimeHost: import("../../src/main/runtime-host").RuntimeHost;
        }
      ).runtimeHost;
      const instanceId = host.records()!.runtimeInstances[0].instanceId;
      const resource = await host.registerResource(project);
      const scope = await host.openScope(instanceId, resource.handle);
      await host.grant(
        instanceId,
        scope.scopeRef,
        "csthink.test.list-confirm",
        "directory.read",
        "desktop test",
      );
      await host.authorize(instanceId, scope.scopeRef);
      await host.sync(instanceId, scope.scopeRef);
      await host.awaitCurrent(instanceId, scope.scopeRef);
      const created = await host.invoke(instanceId, scope.scopeRef, {
        actionId: "entry.create",
        objectRef: "directory:root",
        payload: {
          choice: "create",
          arguments: { title: "状态条目", group: "inbox" },
        },
      });
      return {
        instanceId,
        scopeRef: scope.scopeRef,
        instanceDir: host.records()!.runtimeInstances[0].launchArgv[2],
        created: created.status,
      };
    }, project);
    expect(ids.created).toBe("succeeded");
    const fault = (value: Record<string, unknown>) =>
      writeFileSync(join(ids.instanceDir, "fault.json"), JSON.stringify(value));
    // Diagnostics: process, protocol and health come from the instance record.
    await list.getByText("运行诊断").click();
    const before = (await snapshot(page)).runtimeInstances[0];
    await expect(list.getByTestId("extension-process")).toContainText(
      `进程 运行中，PID ${before.pid}，启动 `,
    );
    await expect(list.getByTestId("extension-protocol")).toContainText(
      "协议 0.1.0-draft.5，健康 正常，",
    );
    await expect(list.getByTestId("extension-scope")).toContainText(
      "对象 2，操作 4/4，待处理 1",
    );
    // Domain writes the Host issued; the lifecycle shutdown of a reconnect is recorded but is not a write.
    const hostOperations = async () =>
      (await snapshot(page)).runtimeOperations.filter(
        (o) => o.origin === "host" && o.method === "runtime.action.invoke",
      ).length;
    const operationsBefore = await hostOperations();
    // The periodic health check (30 s) notices a degraded runtime: 待核实 with the real reason and 重新核实.
    fault({ degraded: "index rebuilding" });
    await expect(state).toHaveText("待核实", { timeout: 45_000 });
    await expect(list.getByRole("status")).toContainText(
      "健康检查降级：index rebuilding",
    );
    await expect(list.getByTestId("extension-health")).toContainText(
      "降级（index rebuilding）",
    );
    const degradedAt = (await snapshot(page)).runtimeInstances[0].health!.at;
    expect(degradedAt > before.health!.at).toBe(true);
    // KB-285: 待核实 also offers 重新连接; its result names the new connection's real state, not "recovered".
    await expect(list.getByRole("button", { name: "重新连接" })).toBeVisible();
    await page.screenshot({
      path: info.outputPath("extensions-unverified-light.png"),
    });
    const beforeReconnect = (await snapshot(page)).runtimeInstances[0];
    await list.getByRole("button", { name: "重新连接" }).click();
    await expect(list.getByTestId("reconnect-result")).toHaveText(
      "已建立新的连接，当前状态：待核实。",
      { timeout: 20_000 },
    );
    await expect(state).toHaveText("待核实");
    const afterReconnect = (await snapshot(page)).runtimeInstances[0];
    expect(afterReconnect.incarnationId).not.toBe(
      beforeReconnect.incarnationId,
    );
    await page.screenshot({
      path: info.outputPath("extensions-unverified-reconnected-light.png"),
    });
    // 重新核实 runs the check now; with the fault cleared the card is 可用 again and the time moves on.
    fault({});
    await list.getByRole("button", { name: "重新核实" }).click();
    await expect(state).toHaveText("可用");
    await expect(list.getByTestId("extension-health")).toContainText("正常");
    expect(
      (await snapshot(page)).runtimeInstances[0].health!.at >= degradedAt,
    ).toBe(true);
    await expect(list.getByRole("button", { name: "重新核实" })).toHaveCount(0);
    // A hung health answer: the timeout is recorded and shown, never the earlier success.
    fault({ healthHang: true });
    await app.evaluate(({ app: _app }, instanceId) => {
      void _app;
      return (
        globalThis as unknown as {
          runtimeHost: import("../../src/main/runtime-host").RuntimeHost;
        }
      ).runtimeHost.reverify(instanceId);
    }, ids.instanceId);
    await expect(state).toHaveText("连接异常", { timeout: 20_000 });
    await expect(list.getByTestId("extension-health")).toContainText("超时");
    await expect(list.getByTestId("extension-health")).not.toContainText(
      "正常",
    );
    await expect(list.getByRole("status")).toContainText(
      "重新连接不会自动继续任务或重放操作",
    );
    await page.screenshot({
      path: info.outputPath("extensions-connection-error-light.png"),
    });
    fault({});
    // 重新连接: the request is acknowledged, the card passes through 待核实 (negotiating, then resuming the scope) and only then 可用.
    await list.getByRole("button", { name: "重新连接" }).click();
    await expect(list.getByRole("status").last()).toContainText(
      "已发出重新连接请求",
    );
    await expect(state).toHaveText("待核实");
    await expect(state).toHaveText("可用", { timeout: 20_000 });
    const after = (await snapshot(page)).runtimeInstances[0];
    expect(after.incarnationId).not.toBe(before.incarnationId);
    // The 待核实 reconnect above already took generation 2.
    expect(after.controlGeneration).toBe("3");
    await expect(list.getByTestId("extension-scope")).toContainText("实时");
    await expect(list.getByTestId("extension-scope")).toContainText(
      "对象 2，操作 4/4，待处理 1",
    );
    expect(await hostOperations()).toBe(operationsBefore);
    // Each reconnect (the 待核实 one above and this one) ends the previous process with one answered shutdown.
    expect(
      (await snapshot(page)).runtimeOperations
        .filter(
          (o) => o.method === "runtime.shutdown" && o.transport === "answered",
        )
        .map((o) => (o.request as { reason?: unknown }).reason),
    ).toEqual(["reconnect requested", "reconnect requested"]);
    await expect(list.getByTestId("extension-process")).toContainText(
      `PID ${after.pid}`,
    );
    await expect(list.getByRole("button", { name: "检查更新" })).toBeDisabled();
    await expect(
      list.getByRole("button", { name: "检查更新" }),
    ).toHaveAttribute("title", "更新检查在去留门后提供");
    await page.screenshot({
      path: info.outputPath("extensions-states-light.png"),
    });
    // Keyboard: the disclosure is reachable by Tab from the card and shows the focus ring in both appearances.
    const focusRing = async () => {
      // Inside the settings dialog a click on text focuses the dialog itself, so the keyboard path starts
      // from the control before the disclosure: Shift+Tab away and Tab back.
      await list.locator(".extension-diagnostics summary").focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      return list.locator(".extension-diagnostics summary").evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          focused:
            document.activeElement === el && el.matches(":focus-visible"),
          outline: style.outlineStyle + " " + style.outlineWidth,
          color: style.outlineColor,
        };
      });
    };
    const lightRing = await focusRing();
    expect(lightRing.focused).toBe(true);
    expect(lightRing.outline).toBe("solid 2px");
    const badgeColors = () =>
      state.evaluate((el) => {
        const style = getComputedStyle(el);
        const surface = getComputedStyle(
          el.closest("article")!,
        ).backgroundColor;
        return {
          color: style.color,
          background: style.backgroundColor,
          surface,
        };
      });
    const lightBadge = await badgeColors();
    expect(lightBadge.color).not.toBe(lightBadge.surface);
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "通用", exact: true })
      .click();
    await page
      .getByRole("group", { name: "外观" })
      .getByRole("button", { name: "深色" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await openExtensions(page);
    await expect(state).toHaveText("可用");
    await list.getByText("运行诊断").click();
    const darkRing = await focusRing();
    expect(darkRing.focused).toBe(true);
    expect(darkRing.outline).toBe("solid 2px");
    expect(darkRing.color).not.toBe("rgba(0, 0, 0, 0)");
    const darkBadge = await badgeColors();
    expect(darkBadge.color).not.toBe(darkBadge.surface);
    expect(darkBadge.surface).not.toBe(lightBadge.surface);
    await page.screenshot({
      path: info.outputPath("extensions-states-dark.png"),
    });
    // 900 × 680: every card control can be brought into view and lies inside the viewport.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(900, 680);
    });
    await expect
      .poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]))
      .toEqual([900, 680]);
    for (const control of [
      list.locator(".extension-diagnostics summary"),
      list.getByTestId("extension-access").locator("summary"),
      list.getByRole("button", { name: "检查更新" }),
      page.getByRole("button", { name: "从本地导入运行包…" }),
    ]) {
      await scrollIntoCenter(control);
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(900);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(680);
    }
    await page.screenshot({
      path: info.outputPath("extensions-900x680-dark.png"),
    });
  } finally {
    await app.close();
  }
});
