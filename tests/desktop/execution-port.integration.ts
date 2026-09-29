import { test, expect } from "@playwright/test";
import { auditExecutionQueries } from "./runtime-fakes/execution-schema";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { closeLocal, launchLocal } from "./local-client";
import { goTo } from "./shell";
import { buildBundle, newPublisher } from "./runtime-fakes/bundle";
import {
  buildFake,
  fixtureAdapterEntry,
  graphFakeDir,
} from "./runtime-fakes/build";
import { GRAPH_CAPABILITY, GRAPH_SCHEMA } from "./runtime-fakes/graph-contract";
import {
  FIXTURE_PROFILE,
  type FixtureAdapter,
  type Variant,
} from "./runtime-fakes/fixture-adapter";
import { createClaudeFixture } from "./claude-fixture";
import {
  gitCommonDir,
  readExecutionRecords,
  recordSegment,
} from "../../src/main/execution-record";
import type { RuntimeHost } from "../../src/main/runtime-host";
import type { EmbeddedExecutionPort } from "../../src/main/execution-port";
import type { RuntimeOperation } from "../../src/shared/runtime-host";
import type { HostExecutionRecord } from "../../src/shared/runtime-execution";

/**
 * S-01 client verification (V-02) and S-03 (V-06): the production embedded port inside the
 * real Electron main process, driven by the graph-domain fake's execution.request, with the
 * fixture `claude` executable as the target through the fixture adapter registered by this
 * test. The run log page shows the execution's events and the shared observation record
 * sits in the project's Git common directory; the cancel path stops a hanging target by
 * identity, reclaims its same-session child and leaves another terminal's process alone.
 */
type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.afterEach(async ({}, info) => {
  auditExecutionQueries(
    info.outputPath("protocol"),
    info.outputPath("execution-get-schema.json"),
  );
});

function fixture() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const dir = mkdtempSync(
    resolve(".test-data/disposable/execution-integration-"),
  );
  mkdirSync(join(dir, "data"));
  mkdirSync(join(dir, "home"));
  const project = join(dir, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  const claude = createClaudeFixture(join(dir, "claude"));
  const publisher = newPublisher();
  const graph = buildBundle(join(dir, "graph-bundle"), publisher, {
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
          id: FIXTURE_PROFILE.id,
          version: FIXTURE_PROFILE.version,
          digest: FIXTURE_PROFILE.digest,
        },
      },
    ],
  });
  const adapterFile = join(dir, "fixture-adapter.cjs");
  writeFileSync(adapterFile, buildFake(fixtureAdapterEntry));
  return {
    dir,
    root: join(dir, "data"),
    home: join(dir, "home"),
    project,
    claude,
    graphBundle: graph.dir,
    adapterFile,
  };
}

type Ev = <A extends Json, R>(
  fn: (
    host: RuntimeHost,
    port: EmbeddedExecutionPort,
    arg: A,
  ) => Promise<R> | R,
  arg: A,
) => Promise<R>;
/** Launches the client, registers the fixture adapter on the production port, imports the graph bundle and opens an authorized scope. */
async function connect(f: ReturnType<typeof fixture>, transcripts?: string) {
  const app = await launchLocal({
    args: [
      resolve("."),
      `--data-root=${f.root}`,
      ...(transcripts ? [`--runtime-transcripts=${transcripts}`] : []),
    ],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  await expect(
    page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
  const ev: Ev = (fn, arg) =>
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
          ) => unknown
        )(g.runtimeHost, g.executionPort, arg);
      },
      { fn: fn.toString(), arg: arg as Json },
    ) as never;
  const records = () => ev((host) => host.records()!, {});
  const until = async <T>(
    read: () => Promise<T>,
    ok: (v: T) => boolean,
    ms = 30_000,
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
  // The fixture adapter joins the production port before the bundle negotiates its profile.
  const offered = await ev(
    async (_host, port, a) => {
      const loaded = process
        .getBuiltinModule("module")
        .createRequire(a.adapterFile as string)(a.adapterFile as string) as {
        FixtureAdapter: new (
          binary: string,
          home: string,
          image: string,
        ) => FixtureAdapter;
      };
      const adapter = new loaded.FixtureAdapter(
        a.binary as string,
        a.home as string,
        a.image as string,
      );
      (globalThis as unknown as { fixtureAdapter: unknown }).fixtureAdapter =
        adapter;
      port.registerAdapter(adapter);
      return (await port.refreshProfiles()).map((p) => p.id);
    },
    {
      adapterFile: f.adapterFile,
      binary: f.claude.binary,
      home: f.home,
      image: process.execPath,
    },
  );
  expect(offered).toEqual([FIXTURE_PROFILE.id]);
  const installationId = await ev(
    async (host, _port, a) => {
      const imported = await host.supervisor.importBundle(
        a.bundle as string,
        "integration",
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
  expect(graph.negotiation?.executionProfiles).toEqual([
    { id: FIXTURE_PROFILE.id, version: "1", digest: FIXTURE_PROFILE.digest },
  ]);
  const gid = graph.instanceId;
  const scope = await ev(
    async (host, _port, a) => {
      const resource = await host.registerResource(a.project as string);
      const scope = await host.openScope(a.id as string, resource.handle);
      await host.grant(
        a.id as string,
        scope.scopeRef,
        "csthink.test.graph",
        "graph.read",
        "integration",
      );
      await host.grant(
        a.id as string,
        scope.scopeRef,
        "csthink.test.graph",
        "graph.execute",
        "integration",
      );
      await host.authorize(a.id as string, scope.scopeRef);
      await host.sync(a.id as string, scope.scopeRef);
      await host.awaitCurrent(a.id as string, scope.scopeRef);
      return scope.scopeRef;
    },
    { id: gid, project: f.project },
  );
  // The projection must offer the action before it is invoked.
  await until(
    async () =>
      ev(
        (host, _port, a) => host.projection(a.id as string, a.scope as string),
        { id: gid, scope },
      ),
    (p) => p.actions.some((a) => a.actionId === "execution.request"),
  );
  const variant = (value: Variant) =>
    ev(
      (_host, _port, a) => {
        (
          globalThis as unknown as { fixtureAdapter: { variant: Variant } }
        ).fixtureAdapter.variant = a.value as Variant;
      },
      { value: value as unknown as Json },
    );
  return { app, page, ev, records, until, gid, scope, variant };
}

/** The next start of the client on the same data root: the persisted instance is adopted; the fixture adapter joins the port again and the instance reconnects so its profile negotiates. */
async function relaunch(f: ReturnType<typeof fixture>, instanceId: string) {
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${f.root}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  await expect(
    page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
  const ev: Ev = (fn, arg) =>
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
          ) => unknown
        )(g.runtimeHost, g.executionPort, arg);
      },
      { fn: fn.toString(), arg: arg as Json },
    ) as never;
  const records = () => ev((host) => host.records()!, {});
  const until = async <T>(
    read: () => Promise<T>,
    ok: (v: T) => boolean,
    ms = 30_000,
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
  await ev(
    async (host, port, a) => {
      const loaded = process
        .getBuiltinModule("module")
        .createRequire(a.adapterFile as string)(a.adapterFile as string) as {
        FixtureAdapter: new (
          binary: string,
          home: string,
          image: string,
        ) => FixtureAdapter;
      };
      const adapter = new loaded.FixtureAdapter(
        a.binary as string,
        a.home as string,
        a.image as string,
      );
      adapter.variant = { print: true };
      port.registerAdapter(adapter);
      await port.refreshProfiles();
      await host.supervisor.reconnect(a.instanceId as string);
    },
    {
      adapterFile: f.adapterFile,
      binary: f.claude.binary,
      home: f.home,
      image: process.execPath,
      instanceId,
    },
  );
  await until(
    async () =>
      (await records()).runtimeInstances.find(
        (i) => i.instanceId === instanceId,
      )!,
    (i) => !!i && (i.state === "ready" || i.state === "failed"),
  );
  return { app, page, ev, records, until };
}

test("embedded port end to end: the graph fake requests an execution, the fixture target is released after its identity is pinned, the run log shows the Agent execution's events and the shared record sits in the project's Git common directory", async ({}, info) => {
  test.setTimeout(240_000);
  const f = fixture();
  const { app, page, ev, records, until, gid, scope } = await connect(
    f,
    info.outputPath("protocol"),
  );
  try {
    const invoked = await ev(
      (host, _port, a) =>
        host.invoke(a.id as string, a.scope as string, {
          actionId: "execution.request",
          objectRef: "project:1",
          payload: { choice: "request", arguments: {} },
        }),
      { id: gid, scope },
    );
    const operation = (await until(
      async () =>
        (await records()).runtimeOperations.find(
          (o) => o.operationId === invoked.operationId,
        ) ?? null,
      (o) =>
        !!o &&
        ["succeeded", "failed", "cancelled", "unknown"].includes(o.status),
      90_000,
    )) as RuntimeOperation;
    expect(operation.status, operation.reason).toBe("succeeded");
    const execution = (await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.portId === "embedded",
        ) ?? null,
      (r) => !!r && r.state === "completed",
    )) as HostExecutionRecord;
    expect(execution.actualBinding?.model).toBe("installation-default");
    expect(execution.target?.parent).toBeGreaterThan(0);
    expect(execution.target?.session).toBe(execution.target?.pid);
    expect(execution.exit?.code).toBe(0);
    expect(execution.accounting?.pidGoneAfterExit).toBe(true);
    expect(execution.releasedAt).not.toBeNull();
    // The fixture received exactly one user line: released once, after the identity was pinned.
    const lines = readFileSync(f.claude.calls, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Json);
    expect(lines.filter((l) => l.type === "user")).toHaveLength(1);
    // Shared observation record in the project's Git common directory: seq 0..3.
    const common = gitCommonDir(f.project)!;
    const shared = readExecutionRecords(
      join(
        common,
        "harness",
        "executions",
        recordSegment(execution.operationId),
      ),
    );
    expect(shared.problems).toEqual([]);
    expect(
      shared.records.map((r) => [
        r.released,
        r.target !== null,
        r.exit !== null,
      ]),
    ).toEqual([
      [false, false, false],
      [false, true, false],
      [true, true, false],
      [true, true, true],
    ]);
    expect(shared.records[3].supervisor.pid).toBeGreaterThan(0);
    // The run log page shows the execution's events.
    await goTo(page, "运行记录");
    const log = page.getByRole("list", { name: "运行事件" });
    await expect(log).toContainText("Implementer 执行");
    await expect(log).toContainText("已放行");
    await expect(log).toContainText("实际模型 installation-default");
    await expect(log.locator(".event-connection").first()).toContainText(
      "fake-agent · installation-default",
    );
    await expect(log.locator(".event-completed").first()).toContainText("执行");
    await page.screenshot({ path: info.outputPath("execution-run-log.png") });
    const domain = (await records()).runtimeExecutions;
    expect(domain).toHaveLength(1);
    writeFileSync(
      info.outputPath("execution-record.json"),
      JSON.stringify({ execution, operation, shared: shared.records }, null, 2),
    );
  } finally {
    await app.close();
  }
});

test("embedded port cancel end to end: the graph fake cancels a running execution whose target hangs with a same-session child while another terminal's fixture process runs alongside; the target is stopped by identity, the child reclaimed, the other process untouched, the domain operation ends cancelled and the run log shows the request, the stop reason and the exit classification", async ({}, info) => {
  test.setTimeout(240_000);
  const f = fixture();
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
      "other-terminal",
      "--session-id",
      "other-terminal",
    ],
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      cwd: f.dir,
      env: { PATH: "/usr/bin:/bin" },
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
  const { app, page, ev, records, until, gid, scope, variant } = await connect(
    f,
    info.outputPath("protocol"),
  );
  try {
    await variant({ print: true });
    const invoked = await ev(
      (host, _port, a) =>
        host.invoke(a.id as string, a.scope as string, {
          actionId: "execution.request",
          objectRef: "project:1",
          payload: { choice: "request", arguments: {} },
        }),
      { id: gid, scope },
    );
    const running = (await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.portId === "embedded",
        ) ?? null,
      (r) => !!r && r.state === "running" && r.target !== null,
    )) as HostExecutionRecord;
    const targetPid = running.target!.pid;
    // The same-session child is registered and persisted before the cancel.
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
    // The domain cancels its own operation; the fake forwards host.execution.cancel with the executionRef.
    const cancelled = await ev(
      (host, _port, a) =>
        host.cancel(a.id as string, a.scope as string, a.operationId as string),
      { id: gid, scope, operationId: invoked.operationId },
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
    expect(execution.cancelRequestedAt).not.toBeNull();
    expect(execution.exit?.signal).toBe("SIGTERM");
    expect(execution.exitClassification).toBe("signaled");
    expect(execution.accounting?.pidGoneAfterExit).toBe(true);
    expect(execution.observationCompleteness).toBe("complete");
    expect(execution.children.map((c) => c.pid)).toEqual([childPid]);
    expect(alive(childPid)).toBe(false);
    expect(alive(other.pid!)).toBe(true);
    const target = (await until(
      async () =>
        (await records()).runtimeOperations.find(
          (o) => o.operationId === invoked.operationId,
        ) ?? null,
      (o) =>
        !!o &&
        ["succeeded", "failed", "cancelled", "unknown"].includes(o.status),
      60_000,
    )) as RuntimeOperation;
    expect(target.status).toBe("cancelled");
    const hostCancel = (await records()).runtimeOperations.find(
      (o) => o.method === "host.execution.cancel",
    )!;
    expect(hostCancel.status).toBe("succeeded");
    expect(hostCancel.reason).toMatch(/SIGTERM sent by identity/);
    // Shared observation record: the child registration and the cancel time are in the record before the exit row.
    const common = gitCommonDir(f.project)!;
    const shared = readExecutionRecords(
      join(
        common,
        "harness",
        "executions",
        recordSegment(execution.operationId),
      ),
    );
    expect(shared.problems).toEqual([]);
    const last = shared.records.at(-1)!;
    expect(last.exit?.signal).toBe("SIGTERM");
    expect(last.cancelRequestedAt).not.toBeNull();
    expect(last.children.map((c) => c.pid)).toEqual([childPid]);
    // The run log: the request, then the stop with its reason and classification.
    await goTo(page, "运行记录");
    const log = page.getByRole("list", { name: "运行事件" });
    await expect(log.locator(".event-stop_requested").first()).toContainText(
      "请求停止",
    );
    await expect(log.locator(".event-stop_requested").first()).toContainText(
      "取消请求已持久化",
    );
    await expect(log.locator(".event-stopped").first()).toContainText("已停止");
    await expect(log.locator(".event-stopped").first()).toContainText(
      "停止原因 已取消 · 退出分类 信号退出 · 已回收 session 内子进程 1",
    );
    await page.screenshot({
      path: info.outputPath("execution-cancel-run-log.png"),
    });
    writeFileSync(
      info.outputPath("execution-cancel-record.json"),
      JSON.stringify(
        { execution, target, hostCancel, shared: shared.records },
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
    await app.close();
  }
});

test("embedded port stop unconfirmed end to end: the cancelled target leaves a descendant in its own session; the record is stopping with the escaped identity, the pending item and the 停止未确认 event exist and no 已停止 is written; runtime.upgrade.prepare is blocked by the Host barrier, quiesce is refused stop-unconfirmed while a grant revocation on the resource takes effect at once (OD-329 b), a recheck through runtime:control counts once; after the client restarts the item and the events are still there and the new Host keeps observing, so the escaped process's own exit is confirmed with 停止已确认 and the references are released", async ({}, info) => {
  test.setTimeout(300_000);
  const f = fixture();
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
  const first = await connect(f, info.outputPath("protocol"));
  let app = first.app;
  try {
    const { ev, records, until, gid, scope, variant, page } = first;
    await variant({ print: true });
    const invoked = await ev(
      (host, _port, a) =>
        host.invoke(a.id as string, a.scope as string, {
          actionId: "execution.request",
          objectRef: "project:1",
          payload: { choice: "request", arguments: {} },
        }),
      { id: gid, scope },
    );
    const running = (await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.portId === "embedded",
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
      { id: gid, scope, operationId: invoked.operationId },
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
    expect(unconfirmed.blockedOperations).toEqual([
      "release-resource",
      "switch-entry",
      "upgrade-extension",
      "update-application",
    ]);
    expect(alive(escapedPid)).toBe(true);
    // The business side: the open item names the execution; the run log has 停止未确认 and no 已停止.
    const business = async () => {
      const reply = await page.evaluate(() =>
        window.desktop.command({ type: "snapshot" }),
      );
      if (!reply.ok || !reply.snapshot) throw new Error("snapshot unavailable");
      return reply.snapshot;
    };
    const snapshot = await business();
    const item = snapshot.pendingItems.find(
      (p) => p.kind === "stop_unconfirmed",
    )!;
    expect(item).toBeTruthy();
    expect(item.executionRef).toBe(running.executionRef);
    expect(item.state).toBe("open");
    const kinds = (events: typeof snapshot.events) =>
      events
        .filter((e) => e.executionId === unconfirmed.executionId)
        .map((e) => e.kind)
        .reverse();
    expect(kinds(snapshot.events)).toEqual([
      "submitted",
      "started",
      "stop_requested",
      "stop_unconfirmed",
    ]);
    // The domain's start operation is still running (not cancelled) while the stop is unconfirmed.
    const startOperation = (await records()).runtimeOperations.find(
      (o) => o.operationId === invoked.operationId,
    )!;
    expect(startOperation.status).toBe("running");
    // (a) Upgrade preparation: blocked by the Host barrier before anything is sent, the detail names the unconfirmed stop.
    const prepare = await ev(
      (host, _port, a) =>
        host.upgradePrepare(a.id as string, {
          bundleDigest: "b".repeat(64),
          dataFormat: "test.g2",
        }),
      { id: gid },
    );
    expect(prepare.status).toBe("failed");
    expect(prepare.resultCode).toBe("HOST_BARRIER");
    const physical = prepare.result.hostBarrier.checks.find(
      (c) => c.id === "physical-execution",
    )!;
    expect(physical.passed).toBe(false);
    expect(physical.detail).toMatch(/stop unconfirmed/);
    // (c) The handoff path is refused stop-unconfirmed with nothing persisted; the grant revocation is not held.
    const refused = await ev(
      async (host, _port, a) => {
        const outcome: Record<string, string> = {};
        try {
          await host.quiesce(a.id as string, "handoff");
          outcome.quiesce = "allowed";
        } catch (error) {
          outcome.quiesce =
            (error as { code: string }).code + ":" + (error as Error).message;
        }
        const grant = host
          .records()!
          .runtimeGrants.find(
            (g) => g.instanceId === a.id && g.operation === "graph.execute",
          )!;
        try {
          await host.revokeGrant(a.id as string, grant.ref.id);
          outcome.revoke = "allowed";
        } catch (error) {
          outcome.revoke =
            (error as { code: string }).code + ":" + (error as Error).message;
        }
        return outcome;
      },
      { id: gid },
    );
    expect(refused.quiesce).toMatch(
      /^PRECONDITION_CONFLICT:.*stop-unconfirmed/,
    );
    // OD-329 (b): revoking a grant on the resource takes effect at once, unaffected by the lingering process.
    expect(refused.revoke).toBe("allowed");
    expect(
      (await records()).runtimeGrants
        .map((g) => [g.operation, g.status])
        .sort(),
    ).toEqual([
      ["graph.execute", "revoked"],
      ["graph.read", "active"],
    ]);
    expect(
      (await records()).runtimeOperations.filter(
        (o) => o.method === "runtime.quiesce",
      ),
    ).toHaveLength(0);
    // The pending item's action through the renderer bridge: one more observation, counted once.
    const recheck = await page.evaluate(
      (executionRef) =>
        window.desktop.runtimeControl({
          type: "recheckExecution",
          executionRef,
        }),
      running.executionRef,
    );
    expect(recheck).toEqual({ ok: true });
    const rechecked = await until(
      async () =>
        (await records()).runtimeExecutions.find(
          (r) => r.executionRef === running.executionRef,
        )!,
      (r) => (r.stopUnconfirmed?.checks ?? 0) >= 1,
    );
    expect(rechecked.state).toBe("stopping");
    expect(rechecked.stopUnconfirmed!.checks).toBe(1);
    expect(alive(escapedPid)).toBe(true);
    // The client restarts (the quit confirmation names the lingering process; the harness answers it and waits
    // for the exit): nothing is re-executed, the item and the events stay, the new Host watches again.
    await closeLocal(app);
    const second = await relaunch(f, gid);
    app = second.app;
    const after = await second.until(
      async () =>
        (await second.records()).runtimeExecutions.find(
          (r) => r.executionRef === running.executionRef,
        ) ?? null,
      (r) => r !== null,
    );
    expect(after!.state).toBe("stopping");
    expect(after!.stopUnconfirmed!.checks).toBe(1);
    const businessAfter = async () => {
      const reply = await second.page.evaluate(() =>
        window.desktop.command({ type: "snapshot" }),
      );
      if (!reply.ok || !reply.snapshot) throw new Error("snapshot unavailable");
      return reply.snapshot;
    };
    const restarted = await businessAfter();
    expect(
      restarted.pendingItems
        .filter((p) => p.kind === "stop_unconfirmed")
        .map((p) => p.id),
    ).toEqual([item.id]);
    expect(kinds(restarted.events)).toEqual([
      "submitted",
      "started",
      "stop_requested",
      "stop_unconfirmed",
    ]);
    // The escaped process exits on its own; the restarted Host confirms the stop without any click.
    const confirmed = (await second.until(
      async () =>
        (await second.records()).runtimeExecutions.find(
          (r) => r.executionRef === running.executionRef,
        )!,
      (r) => r.state !== "stopping",
      120_000,
    )) as HostExecutionRecord;
    expect(confirmed.state).toBe("stopped");
    expect(confirmed.stopReason).toBe("cancelled");
    expect(confirmed.blockedOperations).toEqual([]);
    expect(confirmed.stopUnconfirmed!.resolvedAt).not.toBeNull();
    expect(alive(escapedPid)).toBe(false);
    const released = await businessAfter();
    expect(
      released.pendingItems.filter((p) => p.kind === "stop_unconfirmed"),
    ).toEqual([]);
    expect(kinds(released.events)).toEqual([
      "submitted",
      "started",
      "stop_requested",
      "stop_unconfirmed",
      "stop_confirmed",
    ]);
    // The Host's start operation follows the physical terminal state: cancelled, only now; the references are released.
    const startAfter = (await second.records()).runtimeOperations.find(
      (o) => o.operationId === unconfirmed.operationId,
    )!;
    expect(startAfter.status).toBe("cancelled");
    const prepared = await second.ev(
      (host, _port, a) =>
        host.upgradePrepare(a.id as string, {
          bundleDigest: "b".repeat(64),
          dataFormat: "test.g2",
        }),
      { id: gid },
    );
    expect(
      prepared.result.hostBarrier.checks.find(
        (c) => c.id === "physical-execution",
      )!.passed,
    ).toBe(true);
    await goTo(second.page, "运行记录");
    const log = second.page.getByRole("list", { name: "运行事件" });
    await expect(log.locator(".event-stop_unconfirmed").first()).toContainText(
      "停止未确认",
    );
    await expect(log.locator(".event-stop_confirmed").first()).toContainText(
      "停止已确认",
    );
    await expect(log.locator(".event-stopped")).toHaveCount(0);
    await second.page.screenshot({
      path: info.outputPath("execution-stop-unconfirmed-run-log.png"),
    });
    writeFileSync(
      info.outputPath("execution-stop-unconfirmed-record.json"),
      JSON.stringify(
        { unconfirmed, rechecked, confirmed, prepare, refused, startAfter },
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
    await closeLocal(app);
  }
});

test("KB-245 result bridge end to end: the Runtime reads the original embedded result over host.resource.read in verified chunks", async ({}, info) => {
  test.setTimeout(180_000);
  const f = fixture();
  const { app, ev, records, until, gid, scope } = await connect(
    f,
    info.outputPath("protocol"),
  );
  try {
    const invoked = await ev(
      (host, _port, a) =>
        host.invoke(a.id as string, a.scope as string, {
          actionId: "execution.request",
          objectRef: "project:1",
          payload: { choice: "request", arguments: { readResult: true } },
        }),
      { id: gid, scope },
    );
    const operation = await until(
      async () =>
        (await records()).runtimeOperations.find(
          (o) => o.operationId === invoked.operationId,
        )!,
      (o) =>
        !!o &&
        ["succeeded", "failed", "cancelled", "unknown"].includes(o.status),
    );
    expect(operation.status, operation.reason).toBe("succeeded");
    const execution = (await records()).runtimeExecutions.find(
      (r) => r.portId === "embedded",
    )!;
    expect(execution.state).toBe("completed");
    const { original, readback } = await ev(
      (host, _port, a) => {
        const fs = process.getBuiltinModule("fs"),
          path = process.getBuiltinModule("path");
        const runtime = host
          .records()!
          .runtimeInstances.find((i) => i.instanceId === a.id)!;
        const instanceDir = runtime.launchArgv.find((v) =>
          fs.existsSync(path.join(v, "graph-runtime", "state.json")),
        )!;
        const state = JSON.parse(
          fs.readFileSync(
            path.join(instanceDir, "graph-runtime", "state.json"),
            "utf8",
          ),
        );
        const result = state.executions[a.operationId as string].resultReadback;
        const original = fs.readFileSync(a.file as string).toString("base64");
        return { original, readback: result };
      },
      {
        id: gid,
        operationId: invoked.operationId,
        file: join(
          f.dir,
          "data-executions",
          "evidence",
          recordSegment(execution.executionRef),
          "result.json",
        ),
      },
    );
    expect(readback.evidence).toEqual(execution.resultRef);
    expect(readback.dataBase64).toBe(original);
    const document = JSON.parse(
      Buffer.from(original, "base64").toString("utf8"),
    );
    expect(document.executionRef).toBe(execution.executionRef);
    expect(document.operationId).toBe(execution.operationId);
    expect(document.outcome).toBe("completed");
    expect(Buffer.from(original, "base64").at(-1)).toBe(10);
    const calls = readFileSync(f.claude.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.filter((c) => c.type === "user")).toHaveLength(1);
    writeFileSync(
      info.outputPath("result-readback.json"),
      JSON.stringify(
        {
          executionRef: execution.executionRef,
          operationId: execution.operationId,
          readback,
          invocations: 1,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await closeLocal(app);
  }
});

test("KB-247 terminal queries end to end: failed and unknown executions retain their physical state in frozen schema responses", async ({}, info) => {
  test.setTimeout(180_000);
  const f = fixture();
  const { app, ev, records, until, gid, scope, variant } = await connect(
    f,
    info.outputPath("protocol"),
  );
  try {
    for (const state of ["failed", "unknown"] as const) {
      if (state === "failed") await variant({ expectedImage: "/usr/bin/true" });
      else {
        await variant({ argv: ["--version"] });
        // Existing release seam: wait for this fixture target to exit before release, without forging a persisted record.
        await ev((_host, port) => {
          const options = (
            port as unknown as {
              options: {
                beforeRelease?: (ref: string, pid: number) => Promise<void>;
              };
            }
          ).options;
          options.beforeRelease = async (_ref, pid) => {
            const deadline = Date.now() + 5000;
            for (;;) {
              try {
                process.kill(pid, 0);
              } catch {
                return;
              }
              if (Date.now() > deadline)
                throw new Error("fixture target did not exit");
              await new Promise((r) => setTimeout(r, 20));
            }
          };
        }, {});
      }
      const invoked = await ev(
        (host, _port, a) =>
          host.invoke(a.id as string, a.scope as string, {
            actionId: "execution.request",
            objectRef: "project:1",
            payload: { choice: "request", arguments: {} },
          }),
        { id: gid, scope },
      );
      const operation = await until(
        async () =>
          (await records()).runtimeOperations.find(
            (o) => o.operationId === invoked.operationId,
          )!,
        (o) =>
          !!o &&
          ["succeeded", "failed", "cancelled", "unknown"].includes(o.status),
      );
      expect(operation.status, operation.reason).toBe(state);
      const record = (await records()).runtimeExecutions.find(
        (r) => r.domainOperationId === invoked.operationId,
      )!;
      expect(record.state).toBe(state);
      expect(record.releasedAt).toBeNull();
    }
  } finally {
    await closeLocal(app);
  }
});
