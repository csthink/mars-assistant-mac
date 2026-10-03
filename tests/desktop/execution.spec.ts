import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { closeLocal, launchLocal } from "./local-client";
import { displayName } from "../../src/shared/app-name";
import { goTo } from "./shell";
import { openProvider } from "./provider-ui";
import { scrollIntoCenter } from "./scroll-into-center";
import { buildBundle, newPublisher } from "./runtime-fakes/bundle";
import { graphFakeDir } from "./runtime-fakes/build";
import { GRAPH_CAPABILITY, GRAPH_SCHEMA } from "./runtime-fakes/graph-contract";
import { createClaudeFixture } from "./claude-fixture";
import { createCodexFixture } from "./codex-fixture";
import {
  claudeImplementerDigest,
  claudeImplementerProfileId,
} from "../../src/main/execution-claude";
import { codexReviewerProfileId } from "../../src/main/execution-codex";
import { modelRefOf } from "../../src/shared/runtime-execution";
import type { RuntimeHost } from "../../src/main/runtime-host";
import type { EmbeddedExecutionPort } from "../../src/main/execution-port";
import type { RuntimeOperation } from "../../src/shared/runtime-host";
import type { HostExecutionRecord } from "../../src/shared/runtime-execution";

/**
 * S-02 client verification (V-04): 设置 → 模型 configures the fixture Claude Code and Codex
 * the way a person does, the graph fake requests one Implementer and one Reviewer execution,
 * and 运行记录 shows each execution's release (effort, cost cap), the native approval and the
 * completion with the actual model, in agreement with the persisted records.
 * S-03 client verification (V-06): the extension cancels a running Implementer execution
 * whose target hangs; 运行记录 shows 请求停止 and 已停止 with the stop reason and the exit
 * classification, the same-session child is reclaimed and a fixture process started in
 * another terminal keeps running.
 */
type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const claudeModel = "claude-opus-5[1m]";
const codexModel = "synthetic-model";
let app: ElectronApplication;
let page: Page;
let f: ReturnType<typeof fixture>;

function fixture() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const dir = mkdtempSync(resolve(".test-data/disposable/execution-spec-"));
  mkdirSync(join(dir, "data"));
  mkdirSync(join(dir, "home"));
  const project = join(dir, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  const claude = createClaudeFixture(join(dir, "claude"));
  claude.update({ model: claudeModel });
  const codex = createCodexFixture(join(dir, "codex"));
  const graph = buildBundle(join(dir, "graph-bundle"), newPublisher(), {
    runtimeId: "runtime:test-graph",
    version: "1",
    entrypoint: "graph_fake.py",
    entrypointBytes: readFileSync(join(graphFakeDir, "graph_fake.py")),
    launcher: "python3" as const,
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
  return {
    dir,
    root: join(dir, "data"),
    home: join(dir, "home"),
    project,
    claude,
    codex,
    graphBundle: graph.dir,
  };
}
async function launch() {
  const application = await launchLocal({
    args: [resolve("."), `--data-root=${f.root}`],
    cwd: resolve("."),
    env: {
      ...process.env,
      HOME: f.home,
      PATH: `${f.claude.bin}:${f.codex.bin}:/usr/bin:/bin`,
    },
  });
  const window = await application.firstWindow();
  await expect(
    window
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
  return { application, window };
}
test.beforeEach(async () => {
  f = fixture();
  const launched = await launch();
  app = launched.application;
  page = launched.window;
});
test.afterEach(async () => {
  // A stop-unconfirmed execution now asks for confirmation at quit; the harness answers it and waits for the exit.
  if (app) await closeLocal(app);
});
const ev = <A extends Json, R>(
  fn: (
    host: RuntimeHost,
    port: EmbeddedExecutionPort,
    arg: A,
  ) => Promise<R> | R,
  arg: A,
): Promise<R> =>
  app.evaluate(
    ({ app: _app }, { fn, arg }) => {
      void _app;
      const g = globalThis as unknown as {
        runtimeHost: RuntimeHost;
        executionPort: EmbeddedExecutionPort;
      };
      return (
        new Function(
          "host",
          "port",
          "arg",
          "return (" + fn + ")(host, port, arg)",
        ) as (
          host: RuntimeHost,
          port: EmbeddedExecutionPort,
          arg: unknown,
        ) => Promise<R> | R
      )(g.runtimeHost, g.executionPort, arg);
    },
    { fn: fn.toString(), arg: arg as Json },
  ) as Promise<R>;
const records = () => ev((host) => host.records()!, {});
const business = async () => {
  const reply = await page.evaluate(() =>
    window.desktop.command({ type: "snapshot" }),
  );
  if (!reply.ok || !reply.snapshot) throw new Error("snapshot unavailable");
  return reply.snapshot;
};
const until = async <T>(
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  ms = 60_000,
) => {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - start > ms)
      throw new Error("timeout: " + JSON.stringify(value).slice(0, 400));
    await sleep(150);
  }
};

/** 设置 → 模型: confirms one provider the way a person does and checks its model is enabled. */
async function configureProvider(
  name: "Claude Code" | "Codex",
  model: string,
  screenshot: string,
) {
  const section = await openProvider(page, name);
  await section
    .getByRole("button", { name: `配置 ${name}`, exact: true })
    .click();
  await page
    .getByRole("region", { name: `确认 ${name} 连接` })
    .getByRole("button", { name: `确认配置 ${name}`, exact: true })
    .click();
  await expect(
    section.getByLabel(`启用模型 ${model}`, { exact: true }),
  ).toBeChecked();
  await page.screenshot({ path: screenshot });
}
/** Imports the graph bundle, opens an authorized scope on the project and returns the invoke helper. */
async function importGraph() {
  const installationId = await ev(
    async (host, _port, a) => {
      const imported = await host.supervisor.importBundle(
        a.bundle as string,
        "desktop",
      );
      if (!imported.ok) throw new Error(JSON.stringify(imported));
      return imported.installationId;
    },
    { bundle: f.graphBundle },
  );
  const graph = await until(
    async () =>
      (await records()).runtimeInstances.find(
        (i) => i.installationId === installationId,
      )!,
    (i) => !!i && (i.state === "ready" || i.state === "failed"),
  );
  expect(graph.state, JSON.stringify(graph.failure)).toBe("ready");
  const gid = graph.instanceId;
  const scope = await ev(
    async (host, _port, a) => {
      const resource = await host.registerResource(a.project as string);
      const scope = await host.openScope(a.id as string, resource.handle);
      for (const operation of ["graph.read", "graph.execute"])
        await host.grant(
          a.id as string,
          scope.scopeRef,
          "csthink.test.graph",
          operation,
          "desktop",
        );
      await host.authorize(a.id as string, scope.scopeRef);
      await host.sync(a.id as string, scope.scopeRef);
      await host.awaitCurrent(a.id as string, scope.scopeRef);
      return { scopeRef: scope.scopeRef, resourceHandle: resource.handle };
    },
    { id: gid, project: f.project },
  );
  const invoke = async (actionId: string, objectRef: string, args: Json) => {
    const invoked = await ev(
      (host, _port, a) =>
        host.invoke(a.id as string, a.scope as string, {
          actionId: a.actionId as string,
          objectRef: a.objectRef as string,
          payload: { choice: "request", arguments: a.args },
        }),
      { id: gid, scope: scope.scopeRef, actionId, objectRef, args },
    );
    return (await until(
      async () =>
        (await records()).runtimeOperations.find(
          (o) => o.operationId === invoked.operationId,
        ) ?? null,
      (o) =>
        !!o &&
        ["succeeded", "failed", "cancelled", "unknown"].includes(o.status),
      120_000,
    )) as RuntimeOperation;
  };
  await until(
    async () =>
      ev(
        (host, _port, a) => host.projection(a.id as string, a.scope as string),
        { id: gid, scope: scope.scopeRef },
      ),
    (p) => p.actions.some((a) => a.actionId === "execution.request"),
  );
  return { gid, scope, invoke };
}

test("execution: providers configured in 设置 → 模型, an Implementer and a Reviewer execution requested by the extension, and 运行记录 shows release, cost cap, effort, the native approval and the actual model of each", async ({}, info) => {
  test.setTimeout(300_000);
  // Before any connection is confirmed the product offers no Agent profile.
  expect(
    await ev(
      async (_host, port) => (await port.refreshProfiles()).map((p) => p.id),
      {},
    ),
  ).toEqual([]);
  // 设置 → 模型: Claude Code, then Codex, the way a person confirms them.
  await configureProvider(
    "Claude Code",
    claudeModel,
    info.outputPath("settings-claude.png"),
  );
  await configureProvider(
    "Codex",
    codexModel,
    info.outputPath("settings-codex.png"),
  );
  // The catalogue follows the confirmed connections (the product refreshes on the snapshot change; the test waits explicitly).
  const offered = await ev(
    async (_host, port) => (await port.refreshProfiles()).map((p) => p.id),
    {},
  );
  expect(offered.sort()).toEqual(
    [claudeImplementerProfileId, codexReviewerProfileId].sort(),
  );
  const connections = (await business()).connections;
  const claudeConnection = connections.find((c) => c.provider === "claude")!;
  const codexConnection = connections.find((c) => c.provider === "codex")!;
  // The extension: imported, its scope authorized, its candidate captured as the material.
  const { scope, invoke } = await importGraph();
  expect((await invoke("context.capture", "candidate:1", {})).status).toBe(
    "succeeded",
  );
  const implementer = await invoke("execution.request", "project:1", {
    profileId: claudeImplementerProfileId,
    preflight: true,
    contextFromCapture: true,
    binding: {
      connectionRef: "connection:" + claudeConnection.id,
      configurationRevision: String(claudeConnection.revision),
      model: modelRefOf(claudeModel),
      agent: "agent:claude-code",
      modelVendor: "vendor:anthropic",
      roleIntent: "role:implementer",
      domainNodeRef: "node:implement",
      targetBinding: {
        resourceHandle: scope.resourceHandle,
        relativePath: "src",
      },
    },
  });
  expect(implementer.status, implementer.reason).toBe("succeeded");
  const reviewer = await invoke("execution.request", "project:1", {
    profileId: codexReviewerProfileId,
    preflight: true,
    contextFromCapture: true,
    binding: {
      connectionRef: "connection:" + codexConnection.id,
      configurationRevision: String(codexConnection.revision),
      model: modelRefOf(codexModel),
      agent: "agent:codex",
      modelVendor: "vendor:openai",
      roleIntent: "role:reviewer",
      domainNodeRef: "node:review",
    },
  });
  expect(reviewer.status, reviewer.reason).toBe("succeeded");
  const executions = (await records()).runtimeExecutions;
  const implemented = executions.find(
    (r) => r.profileId === claudeImplementerProfileId,
  ) as HostExecutionRecord;
  const reviewed = executions.find(
    (r) => r.profileId === codexReviewerProfileId,
  ) as HostExecutionRecord;
  expect(implemented.state).toBe("completed");
  expect(implemented.actualBinding?.model).toBe(claudeModel);
  expect("costCapUsd" in implemented).toBe(false);
  expect(implemented.effort).toBeNull();
  expect(existsSync(join(f.project, "src", "IMPLEMENTED.md"))).toBe(true);
  expect(reviewed.state).toBe("completed");
  expect(reviewed.effort).toBe("medium");
  expect(reviewed.approvalDecisionRefs).toHaveLength(1);
  // 运行记录: the events of both executions with the facts a person can check against the protocol output.
  await goTo(page, "运行记录");
  const log = page.getByRole("list", { name: "运行事件" });
  const eventsOf = (record: HostExecutionRecord, kind: string) =>
    log.locator(".event-" + kind).filter({
      hasText: record.executionRef.replace(/^execution:/, "").slice(0, 8),
    });
  // V-19 r1: the heading carries an explicit refresh; the list is unchanged after a re-read of the snapshot.
  const before = await log.locator(".event").count();
  await page.getByRole("button", { name: "刷新运行记录" }).click();
  await expect(log.locator(".event")).toHaveCount(before);
  await expect(
    page.getByRole("status").filter({ hasText: "已刷新" }),
  ).toHaveText(/^已刷新 \d{2}:\d{2}:\d{2}$/);
  // V-19 r1: every event line of an execution names its role, so the two records can be told apart in the list.
  for (const [record, role] of [
    [implemented, "Implementer"],
    [reviewed, "Reviewer"],
  ] as const) {
    const lines = log.locator(".event").filter({
      hasText: record.executionRef.replace(/^execution:/, "").slice(0, 8),
    });
    await expect(lines).toHaveCount(record === reviewed ? 4 : 3);
    for (let i = 0; i < (await lines.count()); i++)
      await expect(lines.nth(i)).toContainText(
        `${role} 执行 ${record.executionRef.replace(/^execution:/, "").slice(0, 8)}`,
      );
  }
  await expect(eventsOf(implemented, "started")).toContainText("推理 未记录");
  await expect(eventsOf(implemented, "started")).not.toContainText("费用上限");
  await expect(eventsOf(implemented, "completed")).toContainText(
    `实际模型 ${claudeModel} · 工具调用 1`,
  );
  await expect(
    eventsOf(implemented, "completed").locator(".event-connection"),
  ).toContainText("Claude Code");
  await expect(eventsOf(reviewed, "started")).toContainText("推理 medium");
  await expect(eventsOf(reviewed, "approval_accepted")).toContainText(
    "原生批准按期望范围放行",
  );
  await expect(eventsOf(reviewed, "completed")).toContainText(
    `实际模型 ${codexModel} · 工具调用 1 · 原生批准 1`,
  );
  await expect(
    eventsOf(reviewed, "completed").locator(".event-connection"),
  ).toContainText("Codex");
  // OD-332: a completed record's reason row is everyday language from the record's fields (tool
  // calls, approvals, run time, exit); the adapter's "completed: …" wording is only in the technical detail.
  const fact = page.getByRole("region", { name: "Host 执行事实" });
  const field = (name: string) =>
    fact
      .locator("dt", { hasText: new RegExp("^" + name + "$") })
      .locator("xpath=following-sibling::dd[1]");
  for (const [record, approvals] of [
    [implemented, 0],
    [reviewed, 1],
  ] as const) {
    await eventsOf(record, "completed")
      .getByRole("button", { name: "查看执行记录" })
      .click();
    await expect(fact).toBeVisible();
    await expect(field("原因")).toHaveText(
      `Agent 已完成这次执行：调用工具 ${record.accounting!.toolCalls} 次${approvals ? `，原生批准 ${approvals} 次` : ""}，用时 ${record.accounting!.runSeconds} 秒，正常退出。`,
    );
    await expect(field("原因")).not.toContainText("completed:");
    await expect(field("角色")).toHaveText(
      approvals ? "Reviewer" : "Implementer",
    );
    await fact.getByRole("button", { name: "技术详情" }).click();
    await expect(field("端口原因")).toContainText("completed:");
    await eventsOf(record, "completed")
      .getByRole("button", { name: "收起执行记录" })
      .click();
    await expect(fact).toHaveCount(0);
  }
  await page.screenshot({
    path: info.outputPath("run-log-executions.png"),
    fullPage: true,
  });
  writeFileSync(
    info.outputPath("executions.json"),
    JSON.stringify({ implemented, reviewed, implementer, reviewer }, null, 2),
  );
});

test("execution cancel: the extension cancels a running Implementer execution whose fixture Claude Code target hangs with a same-session child while the same fixture runs in another terminal; the target is stopped by identity, the child reclaimed, the other process untouched, and 运行记录 shows 请求停止 and 已停止 with the stop reason and the exit classification", async ({}, info) => {
  test.setTimeout(300_000);
  f.claude.update({ implementer: "hang", implementerChildren: 1 });
  // "Another terminal's Agent": the same fixture executable in the same state, in its own session, outside the product.
  const other = spawn(
    f.claude.binary,
    [
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "text",
      "--model",
      claudeModel,
      "--session-id",
      "other-terminal",
    ],
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      cwd: f.dir,
      env: { PATH: "/usr/bin:/bin", HOME: f.home },
    },
  );
  other.stdin!.end("other terminal\n");
  other.unref();
  const calls = () =>
    readFileSync(f.claude.calls, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Json);
  const childrenOf = (parent: number) =>
    calls()
      .filter((c) => typeof c.child === "number" && c.parent === parent)
      .map((c) => c.child as number);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await configureProvider(
      "Claude Code",
      claudeModel,
      info.outputPath("settings-claude.png"),
    );
    await until(
      async () =>
        ev(
          async (_host, port) =>
            (await port.refreshProfiles()).map((p) => p.id),
          {},
        ),
      (ids) => ids.includes(claudeImplementerProfileId),
    );
    const claudeConnection = (await business()).connections.find(
      (c) => c.provider === "claude",
    )!;
    const { gid, scope } = await importGraph();
    const invoked = await ev(
      (host, _port, a) =>
        host.invoke(a.id as string, a.scope as string, {
          actionId: "execution.request",
          objectRef: "project:1",
          payload: { choice: "request", arguments: a.args },
        }),
      {
        id: gid,
        scope: scope.scopeRef,
        args: {
          profileId: claudeImplementerProfileId,
          preflight: true,
          binding: {
            connectionRef: "connection:" + claudeConnection.id,
            configurationRevision: String(claudeConnection.revision),
            model: modelRefOf(claudeModel),
            agent: "agent:claude-code",
            modelVendor: "vendor:anthropic",
            roleIntent: "role:implementer",
            domainNodeRef: "node:implement",
            targetBinding: {
              resourceHandle: scope.resourceHandle,
              relativePath: "src",
            },
          },
        },
      },
    );
    const running = (await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.profileId === claudeImplementerProfileId,
        ) ?? null,
      (r) => !!r && r.state === "running" && r.target !== null,
    )) as HostExecutionRecord;
    const targetPid = running.target!.pid;
    const childPid = (
      await until(
        async () => childrenOf(targetPid),
        (c) => c.length === 1,
      )
    )[0];
    await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.executionRef === running.executionRef,
        )!,
      (r) => r.children.some((c) => c.pid === childPid),
    );
    expect(alive(other.pid!)).toBe(true);
    // 运行记录 while it runs: submitted and released, nothing about a stop yet.
    await goTo(page, "运行记录");
    const log = page.getByRole("list", { name: "运行事件" });
    const short = running.executionRef.replace(/^execution:/, "").slice(0, 8);
    const eventsOf = (kind: string) =>
      log.locator(".event-" + kind).filter({ hasText: short });
    await expect(eventsOf("started")).toContainText("已放行");
    await expect(eventsOf("stop_requested")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("run-log-running.png") });
    // The extension cancels its operation; the fake forwards host.execution.cancel.
    const cancelled = await ev(
      (host, _port, a) =>
        host.cancel(a.id as string, a.scope as string, a.operationId as string),
      { id: gid, scope: scope.scopeRef, operationId: invoked.operationId },
    );
    expect(cancelled.cancel.status).toBe("succeeded");
    const execution = (await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.executionRef === running.executionRef,
        )!,
      (r) => r.state !== "running" && r.state !== "stopping",
    )) as HostExecutionRecord;
    expect(execution.state).toBe("stopped");
    expect(execution.stopReason).toBe("cancelled");
    expect(execution.exit?.signal).toBe("SIGTERM");
    expect(execution.exitClassification).toBe("signaled");
    expect(execution.accounting?.pidGoneAfterExit).toBe(true);
    expect(execution.actualBinding?.model).toBe(claudeModel);
    expect(execution.children.map((c) => c.pid)).toEqual([childPid]);
    expect(alive(childPid)).toBe(false);
    expect(alive(other.pid!)).toBe(true);
    const operation = (await until(
      async () =>
        (await records()).runtimeOperations.find(
          (o) => o.operationId === invoked.operationId,
        ) ?? null,
      (o) =>
        !!o &&
        ["succeeded", "failed", "cancelled", "unknown"].includes(o.status),
      120_000,
    )) as RuntimeOperation;
    expect(operation.status).toBe("cancelled");
    // 运行记录 after the stop: the request, then the stop with reason and classification; the connection column names Claude Code.
    await expect(eventsOf("stop_requested")).toContainText("请求停止");
    await expect(eventsOf("stop_requested")).toContainText(
      "取消请求已持久化，正在按身份停止目标",
    );
    await expect(eventsOf("stopped")).toContainText("已停止");
    await expect(eventsOf("stopped")).toContainText(
      "停止原因 已取消 · 退出分类 信号退出 · 已回收 session 内子进程 1",
    );
    await expect(
      eventsOf("stopped").locator(".event-connection"),
    ).toContainText("Claude Code");
    await expect(eventsOf("completed")).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("run-log-cancelled.png"),
      fullPage: true,
    });
    writeFileSync(
      info.outputPath("execution-cancel.json"),
      JSON.stringify(
        { execution, operation, cancel: cancelled.cancel, otherPid: other.pid },
        null,
        2,
      ),
    );
  } finally {
    for (const pid of [other.pid!, ...childrenOf(other.pid!)])
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
  }
});

test("stop unconfirmed in the client: after the extension cancels an Implementer execution whose target leaves a descendant in its own session, 待处理 shows an amber 停止未确认 item with 重新检查 and no decision buttons, its detail (the Host execution fact block) lists the reason, the target and escaped processes, the check count, the four blocked operations and the release condition, the connection's own model id and the Contract ref only in the technical detail; 运行记录 has 停止未确认 and no 已停止; the extension card and 设置 → 通用 应用更新 show the block reason; the detail is complete in dark appearance at 900 × 680; the escaped process's own exit moves the item to 已处理 with its result, appends 停止已确认 and lifts the block", async ({}, info) => {
  test.setTimeout(300_000);
  f.claude.update({
    implementer: "hang",
    implementerEscaped: 1,
    implementerEscapedSeconds: 90,
  });
  const calls = () =>
    readFileSync(f.claude.calls, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Json);
  const escapedOf = (parent: number) =>
    calls()
      .filter((c) => typeof c.escaped === "number" && c.parent === parent)
      .map((c) => c.escaped as number);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let escapedPid = 0;
  try {
    await configureProvider(
      "Claude Code",
      claudeModel,
      info.outputPath("settings-claude.png"),
    );
    await until(
      async () =>
        ev(
          async (_host, port) =>
            (await port.refreshProfiles()).map((p) => p.id),
          {},
        ),
      (ids) => ids.includes(claudeImplementerProfileId),
    );
    const claudeConnection = (await business()).connections.find(
      (c) => c.provider === "claude",
    )!;
    const { gid, scope } = await importGraph();
    const invoked = await ev(
      (host, _port, a) =>
        host.invoke(a.id as string, a.scope as string, {
          actionId: "execution.request",
          objectRef: "project:1",
          payload: { choice: "request", arguments: a.args },
        }),
      {
        id: gid,
        scope: scope.scopeRef,
        args: {
          profileId: claudeImplementerProfileId,
          preflight: true,
          binding: {
            connectionRef: "connection:" + claudeConnection.id,
            configurationRevision: String(claudeConnection.revision),
            model: modelRefOf(claudeModel),
            agent: "agent:claude-code",
            modelVendor: "vendor:anthropic",
            roleIntent: "role:implementer",
            domainNodeRef: "node:implement",
            targetBinding: {
              resourceHandle: scope.resourceHandle,
              relativePath: "src",
            },
          },
        },
      },
    );
    const running = (await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.profileId === claudeImplementerProfileId,
        ) ?? null,
      (r) => !!r && r.state === "running" && r.target !== null,
    )) as HostExecutionRecord;
    const targetPid = running.target!.pid;
    escapedPid = (
      await until(
        async () => escapedOf(targetPid),
        (c) => c.length === 1,
      )
    )[0];
    await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.executionRef === running.executionRef,
        )!,
      (r) => r.children.some((c) => c.pid === escapedPid),
    );
    const cancelled = await ev(
      (host, _port, a) =>
        host.cancel(a.id as string, a.scope as string, a.operationId as string),
      { id: gid, scope: scope.scopeRef, operationId: invoked.operationId },
    );
    expect(cancelled.cancel.status).toBe("succeeded");
    const unconfirmed = (await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.executionRef === running.executionRef,
        )!,
      (r) => r.exit !== null,
    )) as HostExecutionRecord;
    expect(unconfirmed.state).toBe("stopping");
    expect(
      unconfirmed.stopUnconfirmed?.escaped.map((e) => e.identity.pid),
    ).toEqual([escapedPid]);
    const short = running.executionRef.replace(/^execution:/, "").slice(0, 8);
    // 待处理: the amber item, its only action and its detail.
    await goTo(page, "待处理");
    const list = page.getByRole("list", { name: "待处理事项" });
    const item = list
      .locator(".pending-item")
      .filter({ hasText: "停止未确认" });
    await expect(item).toHaveCount(1);
    await page
      .getByRole("textbox", { name: "搜索事项", exact: true })
      .fill("停止未确认");
    await expect(item).toHaveCount(1);
    await page.getByRole("textbox", { name: "搜索事项", exact: true }).fill("");
    await expect(item).toHaveAttribute("data-kind", "stop_unconfirmed");
    await expect(item).toHaveAttribute("data-tone", "amber");
    await expect(item.getByRole("button", { name: "重新检查" })).toBeEnabled();
    await expect(item.getByRole("button", { name: "重试" })).toHaveCount(0);
    await expect(item.getByRole("button", { name: "忽略" })).toHaveCount(0);
    await expect(item).toContainText(short);
    await page.screenshot({
      path: info.outputPath("pending-stop-unconfirmed-list.png"),
    });
    await item.getByRole("button", { name: "查看详情" }).click();
    const fact = page.getByRole("region", { name: "Host 执行事实" });
    await expect(fact).toBeVisible();
    const field = (name: string) =>
      fact
        .locator("dt", { hasText: new RegExp("^" + name + "$") })
        .locator("xpath=following-sibling::dd[1]");
    await expect(field("状态")).toContainText("停止未确认");
    await expect(field("状态")).toContainText("等待它退出");
    await expect(field("原因")).toContainText("自己开了新的 session");
    await expect(field("目标进程")).toContainText(`PID ${targetPid}`);
    await expect(field("目标进程")).toContainText("启动");
    await expect(field("目标进程")).toContainText(running.target!.path);
    await expect(field("仍在运行的进程")).toContainText(`PID ${escapedPid}`);
    await expect(field("仍在运行的进程")).toContainText("自己的 session");
    await expect(field("已检查")).toContainText("0 次");
    await expect(field("暂时不能做的事")).toContainText("释放资源");
    await expect(field("暂时不能做的事")).toContainText("切换入口");
    await expect(field("暂时不能做的事")).toContainText("扩展升级");
    await expect(field("暂时不能做的事")).toContainText("应用更新");
    await expect(field("什么时候解除")).toContainText("自动解除");
    await expect(field("模型")).toHaveText(claudeModel);
    await expect(fact).toContainText("这里不需要你做决定");
    // OD-328: the Contract ref appears only in the technical detail, labelled, never as the shown model.
    await expect(
      fact.getByText(modelRefOf(claudeModel), { exact: false }),
    ).toHaveCount(0);
    // V-19 r1: 待处理 has the same explicit refresh with feedback as 运行记录; the process line says 程序, not 映像.
    await expect(field("仍在运行的进程")).toContainText("程序 ");
    await expect(field("仍在运行的进程")).not.toContainText("映像");
    await page.getByRole("button", { name: "刷新待处理" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "已刷新" }),
    ).toHaveText(/^已刷新 \d{2}:\d{2}:\d{2}$/);
    await expect(fact).toBeVisible();
    await fact.getByRole("button", { name: "技术详情" }).click();
    await expect(field("Contract 引用")).toContainText(modelRefOf(claudeModel));
    await expect(field("执行引用")).toHaveText(running.executionRef);
    await page.screenshot({
      path: info.outputPath("pending-stop-unconfirmed-detail.png"),
      fullPage: true,
    });
    // 重新检查: one more observation, counted, nothing signalled.
    await item.getByRole("button", { name: "重新检查" }).click();
    await expect(field("已检查")).toContainText("1 次");
    expect(alive(escapedPid)).toBe(true);
    // feature-t31: the linked project consumes this same persisted physical fact.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, f.project);
    const projectId = await page.evaluate(async () => {
      const picked = await window.desktop.pickProjectFolder();
      if (!picked.ok) throw Error(picked.message);
      const made = await window.desktop.createProject({
        token: picked.token,
        name: "停止事实项目",
        goal: "核对领域任务与实际执行状态",
      });
      if (!made.ok || !made.projectId) throw Error(JSON.stringify(made));
      return made.projectId;
    });
    const bound = await page.evaluate(
      ({ projectId, instanceId, scopeRef }) =>
        window.desktop.projectWork({
          type: "bind",
          projectId,
          instanceId,
          scopeRef,
          revision: 0,
        }),
      { projectId, instanceId: running.instanceId, scopeRef: running.scopeRef },
    );
    expect(bound.ok, JSON.stringify(bound)).toBe(true);
    await goTo(page, "项目");
    await page
      .locator(".project-open")
      .filter({ hasText: "停止事实项目" })
      .click();
    const projectFact = page.getByRole("region", { name: "Host 执行事实" });
    await expect(projectFact).toHaveCount(0);
    await page.getByRole("button", { name: "打开右栏", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Runtime 内容" })
      .getByRole("button", { name: "Synthetic project", exact: true })
      .click();
    await expect(projectFact).toHaveCount(1);
    await expect(projectFact).toContainText("停止未确认");
    await expect(projectFact).toContainText(`PID ${escapedPid}`);
    await projectFact.getByRole("button", { name: "技术详情" }).click();
    await expect(projectFact).toContainText(running.executionRef);
    await projectFact.screenshot({
      path: info.outputPath("project-stop-unconfirmed.png"),
    });
    // 运行记录: 停止未确认 present, 已停止 absent.
    await goTo(page, "运行记录");
    const log = page.getByRole("list", { name: "运行事件" });
    const eventsOf = (kind: string) =>
      log.locator(".event-" + kind).filter({ hasText: short });
    await page
      .getByRole("textbox", { name: "搜索运行记录", exact: true })
      .fill("停止未确认");
    await expect(eventsOf("stop_unconfirmed")).toHaveCount(1);
    await page
      .getByRole("textbox", { name: "搜索运行记录", exact: true })
      .fill("");
    await expect(eventsOf("stop_unconfirmed")).toContainText("停止未确认");
    await expect(eventsOf("stop_unconfirmed")).toContainText(
      "它启动的 1 个进程还在运行",
    );
    await expect(eventsOf("stopped")).toHaveCount(0);
    await expect(eventsOf("stop_confirmed")).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("run-log-stop-unconfirmed.png"),
    });
    // 设置 → 扩展管理: the card of the extension that owns the execution shows the block reason.
    await goTo(page, "设置");
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "扩展管理", exact: true })
      .click();
    const card = page.getByRole("article", {
      name: "test-graph 扩展",
      exact: true,
    });
    await expect(card.getByTestId("extension-blocked")).toContainText(
      "有一次已取消的执行还剩进程没退出，等它退出后才能更新",
    );
    await expect(card.getByRole("button", { name: "检查更新" })).toBeDisabled();
    await expect(
      card.getByRole("button", { name: "检查更新" }),
    ).toHaveAttribute("title", /进程没退出/);
    await page.screenshot({
      path: info.outputPath("extensions-stop-unconfirmed.png"),
    });
    // 设置 → 通用: the application update row shows the same reason; the button stays disabled.
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "通用", exact: true })
      .click();
    const update = page.getByTestId("app-update-row");
    await expect(update.getByTestId("app-update-blocked")).toContainText(
      "有一次已取消的执行还剩进程没退出，等它退出后才能更新",
    );
    await expect(
      update.getByRole("button", { name: "检查更新" }),
    ).toBeDisabled();
    await page.screenshot({
      path: info.outputPath("general-stop-unconfirmed.png"),
    });
    // Dark appearance at 900 × 680: the item and every field of its detail are inside the viewport.
    await page
      .getByRole("group", { name: "外观" })
      .getByRole("button", { name: "深色" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(900, 680);
    });
    await expect
      .poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]))
      .toEqual([900, 680]);
    await goTo(page, "待处理");
    await expect(item).toHaveCount(1);
    await item.getByRole("button", { name: "查看详情" }).click();
    await expect(fact).toBeVisible();
    const marker = item.locator(".pending-marker");
    const colors = await marker.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        color: style.color,
        surface: getComputedStyle(el.closest(".pending-item")!).backgroundColor,
      };
    });
    expect(colors.color).not.toBe(colors.surface);
    for (const control of [
      item.getByRole("button", { name: "重新检查" }),
      field("暂时不能做的事"),
      field("什么时候解除"),
    ]) {
      await scrollIntoCenter(control);
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(900);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(680);
    }
    await page.screenshot({
      path: info.outputPath("pending-stop-unconfirmed-dark-900x680.png"),
    });
    // The escaped process exits on its own: the item leaves 待处理 for 已处理 with its result, 停止已确认 is appended, the block lifts.
    const confirmed = (await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.executionRef === running.executionRef,
        )!,
      (r) => r.state !== "stopping",
      120_000,
    )) as HostExecutionRecord;
    expect(confirmed.state).toBe("stopped");
    expect(confirmed.stopReason).toBe("cancelled");
    expect(confirmed.stopUnconfirmed!.checks).toBe(1);
    expect(alive(escapedPid)).toBe(false);
    await expect(item).toHaveCount(0);
    await page.getByRole("tab", { name: "已处理", exact: true }).click();
    await page
      .locator(".record-row")
      .filter({ hasText: "停止未确认" })
      .first()
      .click();
    const done = page.getByRole("region", { name: "事项详情", exact: true });
    const doneItem = done.getByRole("region", {
      name: "Host 执行事实",
      exact: true,
    });
    await expect(doneItem).toHaveCount(1);
    await expect(doneItem).toContainText("已确认停止（进程自行退出）");
    await expect(
      doneItem.getByRole("button", { name: "重新检查" }),
    ).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("pending-stop-confirmed-dark-900x680.png"),
    });
    await goTo(page, "运行记录");
    await expect(eventsOf("stop_confirmed")).toContainText("停止已确认");
    await expect(eventsOf("stop_confirmed")).toContainText(
      "已确认停止（进程自行退出）",
    );
    await expect(eventsOf("stopped")).toHaveCount(0);
    await goTo(page, "设置");
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "扩展管理", exact: true })
      .click();
    await expect(card.getByTestId("extension-blocked")).toHaveCount(0);
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "通用", exact: true })
      .click();
    await expect(update.getByTestId("app-update-blocked")).toHaveCount(0);
    await expect(update).toContainText("尚未配置更新来源。");
    writeFileSync(
      info.outputPath("execution-stop-unconfirmed.json"),
      JSON.stringify(
        { unconfirmed, confirmed, cancel: cancelled.cancel },
        null,
        2,
      ),
    );
  } finally {
    try {
      if (escapedPid) process.kill(escapedPid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
});

/** The native quit sheet cannot be driven by Playwright: the main process answers it and keeps what it was asked. */
type QuitSheet = { message: string; detail: string; buttons: string[] };
async function answerQuitSheet(response: number) {
  await app.evaluate(({ dialog }, choice) => {
    const g = globalThis as unknown as { quitSheets: QuitSheet[] };
    g.quitSheets = [];
    dialog.showMessageBox = (async (_owner: unknown, options: QuitSheet) => {
      g.quitSheets.push({
        message: options.message,
        detail: options.detail,
        buttons: options.buttons,
      });
      return { response: choice, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  }, response);
}
const quitSheets = () =>
  app.evaluate(
    () => (globalThis as unknown as { quitSheets: QuitSheet[] }).quitSheets,
  );
async function clickQuit() {
  const label = `退出 ${displayName}`;
  await app.evaluate(({ Menu }, target) => {
    const item = Menu.getApplicationMenu()?.items[0].submenu?.items.find(
      (entry) => entry.label === target,
    );
    if (!item) throw new Error("Missing quit menu item");
    item.click();
  }, label);
}

test("quit confirmation in plain words: with an Implementer execution running the sheet says 有工作正在进行 and counts the Coding execution, and 取消退出 leaves the target running; once its cancel leaves a process in its own session the sheet says that process may keep running; 停止并退出 with a running execution stops the target by identity before the exit, the lingering process is never signalled, and the next start still watches it", async ({}, info) => {
  test.setTimeout(300_000);
  f.claude.update({
    implementer: "hang",
    implementerEscaped: 1,
    implementerEscapedSeconds: 180,
  });
  const calls = () =>
    readFileSync(f.claude.calls, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Json);
  const escapedOf = (parent: number) =>
    calls()
      .filter((c) => typeof c.escaped === "number" && c.parent === parent)
      .map((c) => c.escaped as number);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pids: number[] = [];
  try {
    await configureProvider(
      "Claude Code",
      claudeModel,
      info.outputPath("settings-claude.png"),
    );
    await until(
      async () =>
        ev(
          async (_host, port) =>
            (await port.refreshProfiles()).map((p) => p.id),
          {},
        ),
      (ids) => ids.includes(claudeImplementerProfileId),
    );
    const claudeConnection = (await business()).connections.find(
      (c) => c.provider === "claude",
    )!;
    const { gid, scope } = await importGraph();
    const request = () =>
      ev(
        (host, _port, a) =>
          host.invoke(a.id as string, a.scope as string, {
            actionId: "execution.request",
            objectRef: "project:1",
            payload: { choice: "request", arguments: a.args },
          }),
        {
          id: gid,
          scope: scope.scopeRef,
          args: {
            profileId: claudeImplementerProfileId,
            preflight: true,
            // Let the graph fake finish its first poll before it checks the capacity-refused request.
            waitSeconds: 15,
            binding: {
              connectionRef: "connection:" + claudeConnection.id,
              configurationRevision: String(claudeConnection.revision),
              model: modelRefOf(claudeModel),
              agent: "agent:claude-code",
              modelVendor: "vendor:anthropic",
              roleIntent: "role:implementer",
              domainNodeRef: "node:implement",
              targetBinding: {
                resourceHandle: scope.resourceHandle,
                relativePath: "src",
              },
            },
          },
        },
      );
    const first = await request();
    const running = (await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.profileId === claudeImplementerProfileId,
        ) ?? null,
      (r) => !!r && r.state === "running" && r.target !== null,
    )) as HostExecutionRecord;
    const targetPid = running.target!.pid;
    pids.push(targetPid);
    const escapedPid = (
      await until(
        async () => escapedOf(targetPid),
        (c) => c.length === 1,
      )
    )[0];
    pids.push(escapedPid);
    await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.executionRef === running.executionRef,
        )!,
      (r) => r.children.some((c) => c.pid === escapedPid),
    );
    // 1. A Coding execution is running: the sheet names it; 取消退出 changes nothing.
    await answerQuitSheet(0);
    await clickQuit();
    await expect.poll(async () => (await quitSheets()).length).toBe(1);
    const running_sheet = (await quitSheets())[0];
    expect(running_sheet.message).toBe("有工作正在进行");
    expect(running_sheet.buttons).toEqual(["取消退出", "停止并退出"]);
    expect(running_sheet.detail).toContain(
      "1 个 Coding 执行（Claude Code / Codex）正在运行。退出会停止它们",
    );
    expect(running_sheet.detail).not.toContain("回合");
    expect(alive(targetPid)).toBe(true);
    expect(
      (await records()).runtimeExecutions.find(
        (r) => r.executionRef === running.executionRef,
      )!.state,
    ).toBe("running");
    // 2. The extension cancels it; the target leaves its escaped process behind: the sheet says so.
    const cancelled = await ev(
      (host, _port, a) =>
        host.cancel(a.id as string, a.scope as string, a.operationId as string),
      { id: gid, scope: scope.scopeRef, operationId: first.operationId },
    );
    expect(cancelled.cancel.status).toBe("succeeded");
    await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.executionRef === running.executionRef,
        )!,
      (r) => r.exit !== null && r.stopUnconfirmed !== null,
    );
    await answerQuitSheet(0);
    await clickQuit();
    await expect.poll(async () => (await quitSheets()).length).toBe(1);
    const lingering_sheet = (await quitSheets())[0];
    expect(lingering_sheet.message).toBe("有进程还没退出");
    expect(lingering_sheet.buttons).toEqual(["取消退出", "仍然退出"]);
    expect(lingering_sheet.detail).toContain(
      "1 个已取消执行启动的进程还没退出。Assistant 不会强行结束它，退出后它可能继续运行",
    );
    // A stopping domain execution still owns the active slot; a second start must be refused.
    const blocked = await request();
    const refused = await until(
      async () =>
        (await records()).runtimeOperations.find(
          (o) => o.operationId === blocked.operationId,
        ) ?? null,
      (o) => !!o && o.status === "failed",
    );
    expect(refused!.reason).toContain("容量已满");
    expect((await records()).runtimeExecutions).toHaveLength(1);

    // Leave with only the lingering execution, then prove a restart still watches that same process.
    await answerQuitSheet(1);
    let closed = app.waitForEvent("close", { timeout: 60_000 });
    let child = app.process();
    await clickQuit();
    await closed;
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(alive(targetPid)).toBe(false);
    expect(alive(escapedPid)).toBe(true);
    let relaunched = await launch();
    app = relaunched.application;
    page = relaunched.window;
    const waiting = await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.executionRef === running.executionRef,
        ) ?? null,
      (r) => !!r && r.state === "stopping" && r.stopUnconfirmed !== null,
    );
    expect(
      waiting!.stopUnconfirmed!.escaped.map((e) => e.identity.pid),
    ).toEqual([escapedPid]);
    const snapshot = await business();
    expect(
      snapshot.pendingItems.filter((p) => p.kind === "stop_unconfirmed"),
    ).toHaveLength(1);
    expect(
      snapshot.events
        .filter((e) => e.executionId === waiting!.executionId)
        .map((e) => e.kind),
    ).not.toContain("interrupted");
    await goTo(page, "待处理");
    await expect(
      page
        .getByRole("list", { name: "待处理事项" })
        .locator(".pending-item")
        .filter({ hasText: "有一个进程还没退出" }),
    ).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("pending-after-quit.png") });

    // The fixture owner ends its own escaped process. Only the Host's observed terminal state frees capacity.
    process.kill(escapedPid, "SIGKILL");
    const confirmed = await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.executionRef === running.executionRef,
        )!,
      (r) => r.state === "stopped" && !!r.stopUnconfirmed?.resolvedAt,
    );
    expect(confirmed.blockedOperations).toEqual([]);
    expect(alive(escapedPid)).toBe(false);
    expect(
      (await business()).pendingItems.filter(
        (p) => p.kind === "stop_unconfirmed",
      ),
    ).toHaveLength(0);

    // Now a fresh execution can start; 停止并退出 must stop this running target before the exit.
    f.claude.update({ implementerEscaped: 0 });
    await request();
    const secondRecord = (await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) =>
            r.profileId === claudeImplementerProfileId &&
            r.executionRef !== running.executionRef,
        ) ?? null,
      (r) => !!r && r.state === "running" && r.target !== null,
    )) as HostExecutionRecord;
    pids.push(secondRecord.target!.pid);
    await answerQuitSheet(1);
    closed = app.waitForEvent("close", { timeout: 60_000 });
    child = app.process();
    await clickQuit();
    await closed;
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(alive(secondRecord.target!.pid)).toBe(false);
    relaunched = await launch();
    app = relaunched.application;
    page = relaunched.window;
    const stopped = await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.executionRef === secondRecord.executionRef,
        ) ?? null,
      (r) => !!r && r.state === "stopped",
    );
    expect(stopped!.stopReason).toBe("cancelled");
    expect(stopped!.exit?.signal).toBe("SIGTERM");
    writeFileSync(
      info.outputPath("quit-sheets.json"),
      JSON.stringify(
        {
          running_sheet,
          lingering_sheet,
          refused,
          waiting,
          confirmed,
          stopped,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const pid of pids)
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
  }
});

test("budgets in the client: 设置 → 模型 → Claude Code 的模型行 has no cost cap control (spec 0.6 r3 U-19); an execution the CLI ends with error_max_budget_usd shows 预算超限 in 运行记录 and its release line carries no cap; a timed-out execution shows 时长超限; each execution's record detail lists the accounting fields without a cost cap row, complete in dark appearance at 900 × 680, and scripts/execution-audit.mjs over the data root agrees with them", async ({}, info) => {
  test.setTimeout(300_000);
  await configureProvider(
    "Claude Code",
    claudeModel,
    info.outputPath("settings-claude.png"),
  );
  const section = page.getByRole("article", {
    name: "提供方 Claude Code",
    exact: true,
  });
  const row = section.getByRole("group", { name: `模型 ${claudeModel}` });
  // No cost cap row, input or button on the model row (OD-331 removal).
  await expect(row).not.toContainText("费用上限");
  await expect(row.getByRole("button", { name: "保存上限" })).toHaveCount(0);
  await expect(row.getByRole("spinbutton")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("settings-model-row-no-cost-cap.png"),
  });
  const connections = (await business()).connections;
  const claudeConnection = connections.find((c) => c.provider === "claude")!;
  expect(
    "costCap" in claudeConnection.models.find((m) => m.model === claudeModel)!,
  ).toBe(false);
  const { scope, invoke } = await importGraph();
  expect((await invoke("context.capture", "candidate:1", {})).status).toBe(
    "succeeded",
  );
  const bindingOf = (model: string) => ({
    connectionRef: "connection:" + claudeConnection.id,
    configurationRevision: String(claudeConnection.revision),
    model: modelRefOf(model),
    agent: "agent:claude-code",
    modelVendor: "vendor:anthropic",
    roleIntent: "role:implementer",
    domainNodeRef: "node:implement",
    targetBinding: {
      resourceHandle: scope.resourceHandle,
      relativePath: "src",
    },
  });
  // Over budget: the fixture ends with error_max_budget_usd by itself; the product passes no cap.
  f.claude.update({ implementer: "budget", costUsd: 0.052 });
  const budget = await invoke("execution.request", "project:1", {
    profileId: claudeImplementerProfileId,
    preflight: true,
    contextFromCapture: true,
    binding: bindingOf(claudeModel),
  });
  expect(budget.status).toBe("failed");
  const overBudget = (await records()).runtimeExecutions.find(
    (r) => r.state === "failed",
  ) as HostExecutionRecord;
  expect("costCapUsd" in overBudget).toBe(false);
  // Timed out: a hanging target under a one-second run-time budget.
  f.claude.update({ implementer: "hang" });
  await invoke("execution.request", "project:1", {
    profileId: claudeImplementerProfileId,
    contextFromCapture: true,
    maxRunSeconds: 1,
    cleanupSeconds: 2,
    binding: bindingOf(claudeModel),
  });
  const timedOut = (await until(
    async () =>
      (await records()).runtimeExecutions.find((r) => r.state === "stopped") ??
      null,
    (r) => !!r,
  )) as HostExecutionRecord;
  expect(timedOut.stopReason).toBe("timeout");
  // 运行记录: no cap at release, 预算超限 on the failure, 时长超限 on the stop.
  await goTo(page, "运行记录");
  const log = page.getByRole("list", { name: "运行事件" });
  const shortOf = (r: HostExecutionRecord) =>
    r.executionRef.replace(/^execution:/, "").slice(0, 8);
  const eventsOf = (r: HostExecutionRecord, kind: string) =>
    log.locator(".event-" + kind).filter({ hasText: shortOf(r) });
  await expect(eventsOf(overBudget, "started")).toContainText("已放行");
  await expect(eventsOf(overBudget, "started")).not.toContainText("费用上限");
  await expect(eventsOf(overBudget, "failed")).toContainText(
    "预算超限：Claude Code 报告预算超限（error_max_budget_usd，产品未设置费用上限），已花费 0.052 美元",
  );
  await expect(eventsOf(timedOut, "started")).not.toContainText("费用上限");
  await expect(eventsOf(timedOut, "stopped")).toContainText(
    "停止原因 时长超限 · 退出分类 信号退出",
  );
  await expect(eventsOf(timedOut, "stop_requested")).toHaveCount(0);
  // The record detail of each execution: the accounting fields as the audit recomputes them.
  const fact = page.getByRole("region", { name: "Host 执行事实" });
  const field = (name: string) =>
    fact
      .locator("dt", { hasText: new RegExp("^" + name + "$") })
      .locator("xpath=following-sibling::dd[1]");
  await eventsOf(overBudget, "failed")
    .getByRole("button", { name: "查看执行记录" })
    .click();
  await expect(fact).toBeVisible();
  await expect(field("状态")).toContainText("失败");
  // OD-332: the reason row is everyday language built from the record's fields; the adapter's own
  // wording is only in the technical detail.
  await expect(field("原因")).toHaveText(
    "Agent 进程以退出码 1 退出，没有给出可用的结果。具体说明见运行记录的“失败”事件和下方技术详情。",
  );
  await expect(field("原因")).not.toContainText("error_max_budget_usd");
  await fact.getByRole("button", { name: "技术详情" }).click();
  await expect(field("端口原因")).toContainText(
    "Claude Code 报告预算超限（error_max_budget_usd，产品未设置费用上限）",
  );
  await fact.getByRole("button", { name: "技术详情" }).click();
  await expect(field("工具调用")).toContainText(
    `${overBudget.accounting!.toolCalls} 次（上限 ${overBudget.budget.maxToolCalls}）`,
  );
  await expect(field("时长")).toContainText(
    `${overBudget.accounting!.runSeconds} 秒（上限 ${overBudget.budget.maxRunSeconds} 秒）`,
  );
  await expect(field("输出字节")).toContainText(
    `${overBudget.accounting!.outputBytes}`,
  );
  await expect(field("父进程等待")).toContainText("是");
  await expect(field("退出后进程消失")).toContainText("是");
  await expect(field("退出")).toContainText("退出码 1");
  await expect(fact.locator("dt", { hasText: "费用上限" })).toHaveCount(0);
  await expect(field("模型")).toContainText(claudeModel);
  await page.screenshot({
    path: info.outputPath("run-log-budget-record.png"),
    fullPage: true,
  });
  await eventsOf(overBudget, "failed")
    .getByRole("button", { name: "收起执行记录" })
    .click();
  await expect(fact).toHaveCount(0);
  // Dark appearance at 900 × 680: the timed-out record's detail, every accounting field inside the viewport.
  await goTo(page, "设置");
  await page
    .getByRole("group", { name: "外观" })
    .getByRole("button", { name: "深色" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(900, 680);
  });
  await expect
    .poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]))
    .toEqual([900, 680]);
  await goTo(page, "运行记录");
  await eventsOf(timedOut, "stopped")
    .getByRole("button", { name: "查看执行记录" })
    .click();
  await expect(fact).toBeVisible();
  await expect(field("状态")).toContainText("已停止（时长超限）");
  await expect(field("时长")).toContainText(
    `${timedOut.accounting!.runSeconds} 秒（上限 1 秒）`,
  );
  await expect(field("退出")).toContainText("信号 SIGTERM");
  for (const name of [
    "工具调用",
    "时长",
    "输出字节",
    "父进程等待",
    "退出后进程消失",
    "退出",
    "推理强度",
  ]) {
    const control = field(name);
    await scrollIntoCenter(control);
    const box = (await control.boundingBox())!;
    expect(box.x, name).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, name).toBeLessThanOrEqual(900);
    expect(box.y, name).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, name).toBeLessThanOrEqual(680);
  }
  await page.screenshot({
    path: info.outputPath("run-log-timeout-record-dark-900x680.png"),
  });
  // The audit over the data root agrees with what the page shows.
  const report = spawnSync(
    process.execPath,
    [
      "scripts/execution-audit.mjs",
      "--data-root",
      f.root,
      "--out",
      info.outputPath("execution-audit.json"),
    ],
    { encoding: "utf8", cwd: resolve(".") },
  );
  expect(report.status, report.stderr + report.stdout).toBe(0);
  const audit = JSON.parse(
    readFileSync(info.outputPath("execution-audit.json"), "utf8"),
  ) as {
    passed: boolean;
    executions: {
      executionRef: string;
      recomputed: {
        toolCalls: number;
        runSeconds: number;
        outputBytes: number;
        waited: boolean;
        pidGoneAfterExit: boolean;
      };
    }[];
  };
  expect(audit.passed).toBe(true);
  // Two records: the two settled executions.
  expect(audit.executions).toHaveLength(2);
  expect(audit.executions.map((e) => e.executionRef)).toEqual(
    expect.arrayContaining([overBudget.executionRef, timedOut.executionRef]),
  );
  const audited = audit.executions.find(
    (e) => e.executionRef === overBudget.executionRef,
  )!;
  expect(audited.recomputed).toEqual({
    toolCalls: overBudget.accounting!.toolCalls,
    runSeconds: overBudget.accounting!.runSeconds,
    outputBytes: overBudget.accounting!.outputBytes,
    waited: overBudget.accounting!.waited,
    pidGoneAfterExit: overBudget.accounting!.pidGoneAfterExit,
  });
  writeFileSync(
    info.outputPath("execution-budgets.json"),
    JSON.stringify({ overBudget, timedOut, budget }, null, 2),
  );
});
