import {
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { closeLocal, launchLocal } from "./local-client";
import { goTo } from "./shell";
import { openProvider } from "./provider-ui";
import { buildBundle, newPublisher } from "./runtime-fakes/bundle";
import { graphFakeDir } from "./runtime-fakes/build";
import { GRAPH_CAPABILITY, GRAPH_SCHEMA } from "./runtime-fakes/graph-contract";
import {
  claudeImplementerDigest,
  claudeImplementerProfileId,
  claudeImplementerTools,
} from "../../src/main/execution-claude";
import { modelRefOf } from "../../src/shared/runtime-execution";
import type { RuntimeHost } from "../../src/main/runtime-host";
import type { EmbeddedExecutionPort } from "../../src/main/execution-port";
import type { RuntimeOperation } from "../../src/shared/runtime-host";
import type { HostExecutionRecord } from "../../src/shared/runtime-execution";
import type { RunEvent } from "../../src/shared/protocol";

/**
 * feature-t30 V-17 (OD-327): the real Claude Code Implementer, two executions in a disposable
 * synthetic Git repository and nothing else. One completes, one is cancelled while it runs. The
 * client is the background isolated one on a fresh data root outside the worktree; the person's
 * step is 设置 → 模型 confirm Claude Code and enable the model, the extension is the graph fake
 * importing the bundle and requesting the executions through the Host, exactly as the S-02 to
 * S-05 client scenarios do with the fixture. A spawn observer in the main process refuses any
 * Implementer launch beyond the authorized count and any launch that carries `--max-budget-usd`
 * (the product passes no USD cost cap since spec 0.6 r3 U-19, OD-331); spending is bounded by
 * the requested tool-call and run-time budgets and checked after each run against the reported
 * `total_cost_usd`. The v17-r1 to r3 runs were made before the removal under OD-327's
 * `--max-budget-usd` limits with a third, cap-tripping execution; a run of this entry needs a
 * real-call authorization that covers executions without a hard cap.
 * Evidence stays in CSTHINK_REAL_EVIDENCE_DIR: record projections, run events, the Host result
 * evidence (transcript projections only, no prompt or answer text), the shared observation
 * records and screenshots; the material text itself is recorded as a digest and byte count.
 */
type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = process.env.CSTHINK_REAL_DATA_ROOT;
const evidence = process.env.CSTHINK_REAL_EVIDENCE_DIR;
const evidenceRoot = process.env.CSTHINK_REAL_EVIDENCE_ROOT;
const model = process.env.CSTHINK_REAL_CLAUDE_MODEL;
const outside = (dir: string | undefined) =>
  !!dir && isAbsolute(dir) && relative(resolve("."), dir).startsWith("..");
test.skip(
  !outside(root) ||
    !outside(evidence) ||
    !model ||
    process.env.CSTHINK_REAL_CALLS_AUTHORIZED !== "1" ||
    process.env.CSTHINK_REAL_TASK !== "feature-t30",
  "OD-327 requires the feature-t30 real-call authorization, CSTHINK_REAL_CLAUDE_MODEL, and a data root and a fresh evidence directory outside the worktree",
);
test.setTimeout(25 * 60_000);
test.use({ trace: "off", actionTimeout: 60_000 });

/** The limits of feature-t30/authorization-real-runs.md under CSTHINK_REAL_EVIDENCE_ROOT: launches counted before spawn, reported cost checked after each run. */
const authorized = { executions: 2, perExecutionCapUsd: 0.5, totalUsd: 2 };
/** The material of each execution (the Implementer's working directory is the project's src/). */
const materials = {
  complete:
    "任务：在当前工作目录内创建文件 IMPLEMENTED.md，内容只有一行：implemented by the csthink-assistant Implementer。只使用 Write 工具创建这一个文件，不读取、不修改其他文件。创建后用一句话说明。",
  cancel:
    "任务：在当前工作目录内依次创建 notes-01.md 至 notes-08.md 八个文件。每个文件写入约三百字的中文说明，主题分别为八种常见排序算法的思路、复杂度与适用场景，一个文件一种算法。一次只创建一个文件，等 Write 工具返回后再创建下一个。全部创建后用一句话说明。",
};
const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const materialDigest = (text: string) => ({
  sha256: sha256(text),
  bytes: Buffer.byteLength(text),
});
const until = async <T>(
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  ms: number,
  what: string,
) => {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - start > ms)
      throw new Error(
        `timeout waiting for ${what}: ` + JSON.stringify(value).slice(0, 400),
      );
    await sleep(250);
  }
};
/** Every file under a directory with its size and digest (the synthetic project after the runs). */
function tree(dir: string, base = dir): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name === ".git") continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) Object.assign(out, tree(path, base));
    else
      out[relative(base, path)] = {
        bytes: stat.size,
        sha256: sha256(readFileSync(path)),
      };
  }
  return out;
}
function copyDir(from: string, to: string) {
  if (!existsSync(from)) return false;
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    if (statSync(source).isDirectory()) copyDir(source, join(to, name));
    else copyFileSync(source, join(to, name));
  }
  return true;
}

test("real Claude Code Implementer (V-17): one execution completes with the init read-back and an accounting the audit agrees with, one is cancelled while running and stops by identity; no launch carries --max-budget-usd and the reported costs stay within the authorization", async ({}, info) => {
  if (!evidenceRoot)
    throw Error("CSTHINK_REAL_EVIDENCE_ROOT must name the evidence directory");
  mkdirSync(evidence!, { recursive: true });
  const budgetPath = join(evidence!, "budget.json");
  // A spent evidence directory is never reused: the file is created exclusively.
  writeFileSync(
    budgetPath,
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        authorized,
        launches: [],
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  const result: Json = {
    result: "NOT RUN",
    validation: "V-17",
    authorization: join(evidenceRoot, "feature-t30/authorization-real-runs.md"),
    model,
    modelRef: modelRefOf(model!),
    profile: {
      id: claudeImplementerProfileId,
      digest: claudeImplementerDigest,
      tools: [...claudeImplementerTools],
    },
    materials: Object.fromEntries(
      Object.entries(materials).map(([k, v]) => [k, materialDigest(v)]),
    ),
    runs: {} as Record<string, Json>,
  };
  const runs = result.runs as Record<string, Json>;
  // The disposable target: a synthetic Git repository beside the evidence, never a personal project.
  const workspace = join(evidence!, "workspace");
  const project = join(workspace, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  const graph = buildBundle(join(workspace, "graph-bundle"), newPublisher(), {
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
  const executionsRoot = join(dirname(root!), `${basename(root!)}-executions`);
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  let closed = false;
  const shutdown = async () => {
    if (app && !closed) {
      closed = true;
      await closeLocal(app);
    }
  };
  try {
    app = await launchLocal({
      args: [resolve("."), `--data-root=${root}`],
      cwd: resolve("."),
      // The real environment: the person's HOME, PATH and login state reach the product unchanged.
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    });
    page = await app.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    const ev = <A extends Json, R>(
      fn: (
        host: RuntimeHost,
        port: EmbeddedExecutionPort,
        arg: A,
      ) => Promise<R> | R,
      arg: A,
    ): Promise<R> =>
      app!.evaluate(
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
      const reply = await page!.evaluate(() =>
        window.desktop.command({ type: "snapshot" }),
      );
      if (!reply.ok || !reply.snapshot) throw new Error("snapshot unavailable");
      return reply.snapshot;
    };
    // The spawn observer: every Implementer launch (print mode with --safe-mode and a tool set) is
    // counted in budget.json; a launch beyond the authorized count, or one that carries a USD cost
    // cap, throws inside spawn, which the port records as an accept failure instead of running.
    await app.evaluate(
      ({ app: _app }, guard) => {
        void _app;
        const req = process.mainModule!.require as NodeRequire;
        const cp = req(
          "node:child_process",
        ) as typeof import("node:child_process");
        const fs = req("node:fs") as typeof import("node:fs");
        const original = cp.spawn;
        const state = { launches: [] as Json[] };
        (globalThis as unknown as { t30Real: typeof state }).t30Real = state;
        const argAfter = (argv: string[], flag: string) => {
          const i = argv.indexOf(flag);
          return i >= 0 ? (argv[i + 1] ?? null) : null;
        };
        (cp as { spawn: unknown }).spawn = function (
          this: unknown,
          file: unknown,
          args: unknown,
          options: unknown,
        ) {
          const argv = Array.isArray(args) ? args.map(String) : [];
          if (
            argv.includes("-p") &&
            argv.includes("--safe-mode") &&
            argv.includes("--tools")
          ) {
            const budget = JSON.parse(
              fs.readFileSync(guard.budgetPath, "utf8"),
            ) as {
              launches: Json[];
            };
            if (budget.launches.length >= guard.maxLaunches)
              throw new Error(
                `OD-327 guard: ${guard.maxLaunches} Implementer launches already made`,
              );
            if (argv.includes("--max-budget-usd"))
              throw new Error(
                "OD-331 guard: the product passed --max-budget-usd, which spec 0.6 r3 U-19 removed",
              );
            const cwd = (options as { cwd?: string } | undefined)?.cwd ?? null;
            const entry: Json = {
              at: new Date().toISOString(),
              executable: String(file),
              costCapArgument: false,
              model: argAfter(argv, "--model"),
              tools: argAfter(argv, "--tools"),
              permissionMode: argAfter(argv, "--permission-mode"),
              permissionPrompts: argAfter(argv, "--permission-prompts"),
              restricted: argv.includes("--restricted"),
              safeMode: argv.includes("--safe-mode"),
              settings: argAfter(argv, "--settings"),
              mcpConfig: argAfter(argv, "--mcp-config"),
              effort: argAfter(argv, "--effort"),
              systemPromptPassed: argv.includes("--system-prompt"),
              argvCount: argv.length,
              cwdBasename: cwd ? cwd.split("/").slice(-2).join("/") : null,
              detached:
                (options as { detached?: boolean } | undefined)?.detached ===
                true,
            };
            budget.launches.push(entry);
            fs.writeFileSync(guard.budgetPath, JSON.stringify(budget, null, 2));
            state.launches.push(entry);
          }
          return (original as (...a: unknown[]) => unknown).apply(this, [
            file,
            args,
            options,
          ]);
        };
        return "installed";
      },
      {
        budgetPath,
        maxLaunches: authorized.executions,
      },
    );
    // 设置 → 模型: the person confirms the real Claude Code and enables the model.
    const section = await openProvider(page, "Claude Code");
    const configure = section.getByRole("button", {
      name: "配置 Claude Code",
      exact: true,
    });
    if (await configure.isVisible().catch(() => false)) {
      await configure.click();
      const setup = page.getByRole("region", { name: "确认 Claude Code 连接" });
      await expect(setup).toBeVisible();
      // Personal rule sources need the person's consent before the origin can be confirmed.
      const consent = setup.getByRole("checkbox");
      if (await consent.count()) await consent.first().check();
      await setup
        .getByRole("button", { name: "确认配置 Claude Code", exact: true })
        .click();
      await expect(section.getByText("已配置", { exact: true })).toBeVisible();
    }
    const toggle = section.getByRole("checkbox", {
      name: `启用模型 ${model}`,
      exact: true,
    });
    await expect(toggle).toBeVisible();
    if (!(await toggle.isChecked())) {
      await toggle.click();
      await expect(toggle).toBeChecked();
    }
    await page.screenshot({ path: join(evidence!, "settings-claude.png") });
    const row = section.getByRole("group", { name: `模型 ${model}` });
    // No cost cap control on the model row (OD-331).
    await expect(row).not.toContainText("费用上限");
    const connection = (await business()).connections.find(
      (c) => c.provider === "claude",
    )!;
    expect(connection).toBeTruthy();
    result.connection = {
      provider: connection.provider,
      revision: connection.revision,
      authentication: connection.claude?.authentication ?? null,
      models: connection.models.map((m) => ({
        model: m.model,
        enabled: m.enabled,
      })),
    };
    await until(
      async () =>
        ev(
          async (_host, port) =>
            (await port.refreshProfiles()).map((p) => p.id),
          {},
        ),
      (ids) => ids.includes(claudeImplementerProfileId),
      60_000,
      "the Implementer profile offer",
    );
    // The extension: imported, its scope authorized on the synthetic project.
    const installationId = await ev(
      async (host, _port, a) => {
        const imported = await host.supervisor.importBundle(
          a.bundle as string,
          "desktop",
        );
        if (!imported.ok) throw new Error(JSON.stringify(imported));
        return imported.installationId;
      },
      { bundle: graph.dir },
    );
    const instance = await until(
      async () =>
        (await records()).runtimeInstances.find(
          (i) => i.installationId === installationId,
        )!,
      (i) => !!i && (i.state === "ready" || i.state === "failed"),
      120_000,
      "the graph instance",
    );
    expect(instance.state, JSON.stringify(instance.failure)).toBe("ready");
    const gid = instance.instanceId;
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
      { id: gid, project },
    );
    const start = (actionId: string, objectRef: string, args: Json) =>
      ev(
        (host, _port, a) =>
          host.invoke(a.id as string, a.scope as string, {
            actionId: a.actionId as string,
            objectRef: a.objectRef as string,
            payload: { choice: "request", arguments: a.args },
          }),
        { id: gid, scope: scope.scopeRef, actionId, objectRef, args },
      );
    const settled = (operationId: string, ms: number) =>
      until(
        async () =>
          (await records()).runtimeOperations.find(
            (o) => o.operationId === operationId,
          ) ?? null,
        (o) =>
          !!o &&
          ["succeeded", "failed", "cancelled", "unknown"].includes(o.status),
        ms,
        `operation ${operationId}`,
      ) as Promise<RuntimeOperation>;
    const projection = () =>
      ev(
        (host, _port, a) => host.projection(a.id as string, a.scope as string),
        { id: gid, scope: scope.scopeRef },
      );
    const revisionOf = async () =>
      (await projection()).actions.find((a) => a.actionId === "context.capture")
        ?.expectedRevision ?? null;
    /**
     * Every action here changes the domain's state, so its revision moves; the Host learns the
     * new revision from the event that follows the answer. An invoke built before that event
     * arrives carries a stale expectedRevision and the domain refuses it (r2 stopped this way), so
     * after each settled operation the projection is awaited until the revision has moved.
     */
    const caughtUp = async (before: string | null) => {
      await ev(
        (host, _port, a) =>
          host.awaitCurrent(a.id as string, a.scope as string),
        { id: gid, scope: scope.scopeRef },
      );
      await until(
        revisionOf,
        (rev) => rev !== before,
        15_000,
        `the projection to move past ${before}`,
      );
    };
    const invoke = async (actionId: string, objectRef: string, args: Json) => {
      const before = await revisionOf();
      const operation = await settled(
        (await start(actionId, objectRef, args)).operationId,
        400_000,
      );
      await caughtUp(before);
      return operation;
    };
    await until(
      projection,
      (p) => p.actions.some((a) => a.actionId === "execution.request"),
      60_000,
      "the execution.request action",
    );
    const binding = {
      connectionRef: "connection:" + connection.id,
      configurationRevision: String(connection.revision),
      model: modelRefOf(model!),
      agent: "agent:claude-code",
      modelVendor: "vendor:anthropic",
      roleIntent: "role:implementer",
      domainNodeRef: "node:implement",
      targetBinding: {
        resourceHandle: scope.resourceHandle,
        relativePath: "src",
      },
    };
    const requestArgs = {
      profileId: claudeImplementerProfileId,
      preflight: true,
      contextFromCapture: true,
      maxRunSeconds: 300,
      waitSeconds: 330,
      binding,
    };
    /** The material for the next execution: revised into the candidate, then captured into Host context. */
    const material = async (text: string) => {
      expect(
        (await invoke("candidate.revise", "candidate:1", { text })).status,
      ).toBe("succeeded");
      expect((await invoke("context.capture", "candidate:1", {})).status).toBe(
        "succeeded",
      );
    };
    const recordOf = async (executionRef: string) =>
      (await records()).runtimeExecutions.find(
        (r) => r.executionRef === executionRef,
      ) as HostExecutionRecord;
    const eventsOf = async (record: HostExecutionRecord) =>
      (await business()).events
        .filter((e) => e.executionId === record.executionId)
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({
          seq: e.seq,
          kind: e.kind,
          at: e.at,
          connection: e.connection
            ? { provider: e.connection.provider, model: e.connection.model }
            : null,
          payload: e.payload,
        })) as unknown as RunEvent[];
    const launches = () =>
      app!.evaluate(
        () =>
          (globalThis as unknown as { t30Real: { launches: Json[] } }).t30Real
            .launches,
      );
    const hostEvidence = (record: HostExecutionRecord) =>
      join(executionsRoot, "evidence", record.executionRef.replace(/:/g, "-"));
    const terminal = (r: HostExecutionRecord | null) =>
      !!r && ["completed", "failed", "stopped", "unknown"].includes(r.state);
    const newest = async (previous: Set<string>) =>
      (await records()).runtimeExecutions.find(
        (r) => !previous.has(r.executionRef),
      ) ?? null;

    // ---- Run 1: completes.
    {
      const before = new Set(
        (await records()).runtimeExecutions.map((r) => r.executionRef),
      );
      await material(materials.complete);
      const launched = (await launches()).length;
      const operation = await invoke(
        "execution.request",
        "project:1",
        requestArgs,
      );
      const record = await until(
        async () => newest(before),
        (r) => terminal(r),
        60_000,
        "run 1 terminal record",
      );
      const run: Json = {
        operation,
        record,
        events: await eventsOf(record!),
        launches: (await launches()).slice(launched),
        project: tree(join(project, "src")),
      };
      runs.complete = run;
      expect(operation.status, operation.reason).toBe("succeeded");
      expect(record!.state).toBe("completed");
      expect("costCapUsd" in record!).toBe(false);
      expect(record!.actualBinding?.model).toBeTruthy();
      expect(record!.accounting?.toolCalls).toBeGreaterThanOrEqual(1);
      expect(record!.exit).toMatchObject({ code: 0, signal: null });
      expect(run.launches).toHaveLength(1);
      expect((run.launches as Json[])[0]).toMatchObject({
        costCapArgument: false,
        model,
        tools: [...claudeImplementerTools].join(","),
        permissionMode: "acceptEdits",
        permissionPrompts: "none",
        restricted: true,
        safeMode: true,
        detached: true,
      });
      const written = join(project, "src", "IMPLEMENTED.md");
      expect(existsSync(written)).toBe(true);
      expect(readFileSync(written, "utf8")).toContain(
        "implemented by the csthink-assistant Implementer",
      );
    }
    // ---- Run 2: cancelled while it runs.
    {
      const before = new Set(
        (await records()).runtimeExecutions.map((r) => r.executionRef),
      );
      await material(materials.cancel);
      const launched = (await launches()).length;
      const revisionBefore = await revisionOf();
      const invoked = await start(
        "execution.request",
        "project:1",
        requestArgs,
      );
      // Released and the target registered; the record carries the init read-back only at settlement,
      // so the extension cancels a few seconds after the release (the real init frame arrives within
      // one or two seconds, the first model reply later) and the settled record must show the read-back.
      const running = await until(
        async () => newest(before),
        (r) => !!r && r.state === "running" && r.target !== null,
        120_000,
        "run 2 running with its target",
      );
      await sleep(4_000);
      const cancelled = await ev(
        (host, _port, a) =>
          host.cancel(
            a.id as string,
            a.scope as string,
            a.operationId as string,
          ),
        { id: gid, scope: scope.scopeRef, operationId: invoked.operationId },
      );
      const record = await until(
        async () => recordOf(running!.executionRef),
        (r) => terminal(r),
        180_000,
        "run 2 terminal record",
      );
      const operation = await settled(invoked.operationId, 120_000);
      await caughtUp(revisionBefore);
      const run: Json = {
        operation,
        cancel: cancelled.cancel,
        runningSnapshot: {
          state: running!.state,
          target: running!.target,
          actualBinding: running!.actualBinding,
          releasedAt: running!.releasedAt,
        },
        record,
        events: await eventsOf(record),
        launches: (await launches()).slice(launched),
      };
      runs.cancel = run;
      expect(cancelled.cancel.status).toBe("succeeded");
      expect(record.state).toBe("stopped");
      expect(record.stopReason).toBe("cancelled");
      // The real CLI handles SIGTERM itself and exits with code 143 (KB-217); the fixture dies by the signal.
      expect(
        record.exit?.signal === "SIGTERM" || record.exit?.code === 143,
        JSON.stringify(record.exit),
      ).toBe(true);
      expect(["signaled", "exited"]).toContain(record.exitClassification);
      expect(record.cancelRequestedAt).toBeTruthy();
      expect(record.actualBinding?.model).toBeTruthy();
      expect(operation.status).toBe("cancelled");
      expect(run.launches).toHaveLength(1);
      const kinds = (run.events as RunEvent[]).map((e) => e.kind);
      expect(kinds).toContain("stop_requested");
      expect(kinds).toContain("stopped");
      expect(kinds).not.toContain("completed");
    }
    // The whole authorization: two launches, none with a cap argument; the reported costs are checked below.
    const all = await launches();
    expect(all).toHaveLength(authorized.executions);
    for (const launch of all) expect(launch.costCapArgument).toBe(false);
    // 运行记录: the two executions as a person sees them, and the record detail of each.
    await goTo(page, "运行记录");
    const log = page.getByRole("list", { name: "运行事件" });
    await expect(log).toContainText("Implementer 执行");
    await page.screenshot({
      path: join(evidence!, "run-log.png"),
      fullPage: true,
    });
    const short = (r: HostExecutionRecord) =>
      r.executionRef.replace(/^execution:/, "").slice(0, 8);
    const fact = page.getByRole("region", { name: "Host 执行事实" });
    for (const [name, kind] of [
      ["complete", "completed"],
      ["cancel", "stopped"],
    ] as const) {
      const record = runs[name].record as HostExecutionRecord;
      const event = log
        .locator(".event-" + kind)
        .filter({ hasText: short(record) });
      await expect(event).toHaveCount(1);
      await event.getByRole("button", { name: "查看执行记录" }).click();
      await expect(fact).toBeVisible();
      await fact.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(evidence!, `run-log-${name}-detail.png`),
        fullPage: true,
      });
      await event.getByRole("button", { name: "收起执行记录" }).click();
    }
    // Host result evidence (transcript projections, no text) and the shared observation records.
    for (const name of ["complete", "cancel"] as const) {
      const record = runs[name].record as HostExecutionRecord;
      const copied = copyDir(
        hostEvidence(record),
        join(evidence!, "host-evidence", name),
      );
      const shared = join(
        project,
        ".git",
        "harness",
        "executions",
        record.requestIdentity.operationId.replace(/[^A-Za-z0-9._-]/g, "-"),
      );
      const sharedCopied = copyDir(
        shared,
        join(evidence!, "shared-record", name),
      );
      runs[name].evidenceCopied = { host: copied, shared: sharedCopied };
      expect(copied, `Host evidence of ${name}`).toBe(true);
      const document = JSON.parse(
        readFileSync(join(hostEvidence(record), "result.json"), "utf8"),
      ) as Json;
      runs[name].resultDocument = document;
      const transcript = readFileSync(
        join(hostEvidence(record), "transcript.ndjson"),
        "utf8",
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Json);
      runs[name].transcript = transcript;
      const init = transcript.find(
        (t) => t.type === "system" && t.subtype === "init",
      );
      expect(init, `${name}: init frame`).toBeTruthy();
      expect([...(init!.tools as string[])].sort()).toEqual(
        [...claudeImplementerTools].sort(),
      );
      expect(init!.permissionMode).toBe("acceptEdits");
      expect(init!.model).toBe(record.actualBinding?.model);
      const settledResult = transcript.find((t) => t.type === "result");
      if (name === "complete") {
        expect(settledResult).toMatchObject({
          subtype: "success",
          is_error: false,
        });
        expect(document.resultCode ?? null).toBeNull();
      }
      if (name === "cancel") {
        expect(settledResult).toBeUndefined();
        // Stopped by identity: exactly the registered target got the TERM, as the signal ledger records.
        const signals = document.signals as Json[];
        expect(signals.filter((s) => s.stage === "TERM" && s.sent)).toEqual([
          expect.objectContaining({
            pid: record.target!.pid,
            label: "stop:cancelled",
          }),
        ]);
      }
    }
    // Reported spend: the completed execution's total_cost_usd (a cancelled execution reports none).
    const completedResult = (runs.complete.transcript as Json[]).find(
      (t) => t.type === "result",
    );
    const completeCost =
      typeof completedResult?.total_cost_usd === "number"
        ? completedResult.total_cost_usd
        : null;
    result.reportedCostUsd = {
      complete: completeCost,
      cancel: null,
      sum: completeCost ?? 0,
    };
    expect(
      completeCost,
      "the completed execution reports its cost",
    ).not.toBeNull();
    expect(completeCost!).toBeLessThanOrEqual(authorized.perExecutionCapUsd);
    expect((result.reportedCostUsd as { sum: number }).sum).toBeLessThanOrEqual(
      authorized.totalUsd,
    );
    await shutdown();
    // The audit over the data root, once the client has released the database.
    const audit = spawnSync(
      process.execPath,
      [
        "scripts/execution-audit.mjs",
        "--data-root",
        root!,
        "--out",
        join(evidence!, "execution-audit.json"),
      ],
      { encoding: "utf8", cwd: resolve(".") },
    );
    result.audit = {
      status: audit.status,
      stdout: audit.stdout.slice(0, 4000),
      stderr: audit.stderr.slice(0, 4000),
    };
    expect(audit.status, audit.stderr + audit.stdout).toBe(0);
    const report = JSON.parse(
      readFileSync(join(evidence!, "execution-audit.json"), "utf8"),
    ) as {
      passed: boolean;
      executions: { executionRef: string; recomputed: Json }[];
    };
    expect(report.passed).toBe(true);
    for (const name of ["complete", "cancel"] as const) {
      const record = runs[name].record as HostExecutionRecord;
      const audited = report.executions.find(
        (e) => e.executionRef === record.executionRef,
      );
      expect(audited, `${name} audited`).toBeTruthy();
      expect(audited!.recomputed).toEqual(record.accounting);
    }
    result.result = "PASS";
  } catch (error) {
    result.result = "FAIL";
    result.error = (
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    ).replace(/\x1b\[[0-9;]*m/g, "");
    // The records as they stand at the failure, so a stop that never settled is still evidence.
    if (app && !closed)
      result.recordsAtFailure = await app
        .evaluate(
          () =>
            (
              globalThis as unknown as { runtimeHost: RuntimeHost }
            ).runtimeHost.records()?.runtimeExecutions,
        )
        .catch((e: Error) => "unavailable: " + e.message);
    throw error;
  } finally {
    result.budget = JSON.parse(readFileSync(budgetPath, "utf8"));
    result.finishedAt = new Date().toISOString();
    writeFileSync(
      join(evidence!, "result.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    void info;
    await shutdown();
  }
});
