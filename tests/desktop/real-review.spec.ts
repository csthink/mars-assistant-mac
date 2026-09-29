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
  codexReviewerDigest,
  codexReviewerPermissionProfile,
  codexReviewerProfileId,
} from "../../src/main/execution-codex";
import { modelRefOf } from "../../src/shared/runtime-execution";
import type { RuntimeHost } from "../../src/main/runtime-host";
import type { EmbeddedExecutionPort } from "../../src/main/execution-port";
import type { RuntimeOperation } from "../../src/shared/runtime-host";
import type { HostExecutionRecord } from "../../src/shared/runtime-execution";
import type { RunEvent } from "../../src/shared/protocol";

/**
 * feature-t30 V-18 (OD-327): the real Codex Reviewer, two executions and nothing else. One
 * completes with the single native read-only approval for the material directory, one is
 * cancelled while its turn runs and stops through turn/interrupt. The client is the background
 * isolated one on a fresh data root outside the worktree; the person's step is 设置 → 模型
 * confirm Codex and enable the model; the extension is the graph fake requiring the Reviewer
 * profile and requesting the executions through the Host, as the S-02 client scenario does with
 * the fixture. A spawn observer in the main process records every `codex app-server` process
 * (the inventory and restricted inspections as well as the targets) with the JSON-RPC methods
 * the product writes to its stdin, and refuses a third `turn/start`, so no product retry could
 * start more turns than authorized. Evidence stays in CSTHINK_REAL_EVIDENCE_DIR: record
 * projections, run events, the process log, the Host result evidence, the shared observation
 * records and screenshots; the material text is recorded as a digest and byte count.
 */
type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = process.env.CSTHINK_REAL_DATA_ROOT;
const evidence = process.env.CSTHINK_REAL_EVIDENCE_DIR;
const evidenceRoot = process.env.CSTHINK_REAL_EVIDENCE_ROOT;
/** Optional: the Codex model to review with; the connection's default model otherwise. */
const chosenModel = process.env.CSTHINK_REAL_CODEX_MODEL;
const outside = (dir: string | undefined) =>
  !!dir && isAbsolute(dir) && relative(resolve("."), dir).startsWith("..");
test.skip(
  !outside(root) ||
    !outside(evidence) ||
    process.env.CSTHINK_REAL_CALLS_AUTHORIZED !== "1" ||
    process.env.CSTHINK_REAL_TASK !== "feature-t30",
  "OD-327 requires the feature-t30 real-call authorization and a data root and a fresh evidence directory outside the worktree",
);
test.setTimeout(30 * 60_000);
test.use({ trace: "off", actionTimeout: 60_000 });

/** The limits of feature-t30/authorization-real-runs.md under CSTHINK_REAL_EVIDENCE_ROOT: one completed turn, one cancelled turn. */
const authorized = { turns: 2 };
/** The material of each execution: a small synthetic snippet to review, never a personal file. */
const materials = {
  complete:
    "评审请求：下面是一个用于分页的函数，请指出其中的缺陷并给出结论。\n\n```python\ndef page(items, size, index):\n    start = index * size\n    end = start + size + 1\n    return items[start:end]\n```\n\n调用方约定 index 从 0 开始，每页恰好 size 个元素。",
  cancel:
    "评审请求：下面是一个合并两个已排序列表的函数，请逐行说明它的正确性、复杂度和边界条件，并给出结论。\n\n```python\ndef merge(a, b):\n    i = j = 0\n    out = []\n    while i < len(a) and j < len(b):\n        if a[i] <= b[j]:\n            out.append(a[i]); i += 1\n        else:\n            out.append(b[j]); j += 1\n    out.extend(a[i:])\n    out.extend(b[j:])\n    return out\n```",
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
/** One `codex app-server` process as the spawn observer records it. */
interface ObservedProcess {
  index: number;
  at: string;
  pid: number | null;
  executable: string;
  restricted: boolean;
  /** The product's connection verification against its own local synthetic provider (never the real model). */
  contractProvider: boolean;
  overrides: number;
  cwdBasename: string | null;
  detached: boolean;
  methods: { method: string; at: string }[];
  turnStarts: number;
  interrupts: number;
}

test("real Codex Reviewer (V-18): one execution completes with exactly one native read-only approval of the material directory and its answer in the result evidence, one is cancelled while its turn runs and stops through turn/interrupt; the inspection and target processes are recorded apart", async ({}, info) => {
  if (!evidenceRoot)
    throw Error("CSTHINK_REAL_EVIDENCE_ROOT must name the evidence directory");
  mkdirSync(evidence!, { recursive: true });
  const budgetPath = join(evidence!, "budget.json");
  // A spent evidence directory is never reused: the file is created exclusively.
  writeFileSync(
    budgetPath,
    JSON.stringify(
      { startedAt: new Date().toISOString(), authorized, processes: [] },
      null,
      2,
    ),
    { flag: "wx" },
  );
  const result: Json = {
    result: "NOT RUN",
    validation: "V-18",
    authorization: join(evidenceRoot, "feature-t30/authorization-real-runs.md"),
    profile: { id: codexReviewerProfileId, digest: codexReviewerDigest },
    materials: Object.fromEntries(
      Object.entries(materials).map(([k, v]) => [k, materialDigest(v)]),
    ),
    runs: {} as Record<string, Json>,
  };
  const runs = result.runs as Record<string, Json>;
  // The scope resource: a synthetic Git repository beside the evidence (the Reviewer has no target binding; the shared record lives in its Git common directory).
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
          id: codexReviewerProfileId,
          version: "1",
          digest: codexReviewerDigest,
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
      // The real environment: the person's HOME, PATH, USER and Codex login state reach the product unchanged.
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
    // The spawn observer: every `codex app-server` process (detection, inventory and restricted
    // inspections, targets) is logged with the methods the product writes to its stdin; the third
    // turn/start throws inside the write, which the adapter records as a failure before any model turn.
    await app.evaluate(
      ({ app: _app }, guard) => {
        void _app;
        const req = process.mainModule!.require as NodeRequire;
        const cp = req(
          "node:child_process",
        ) as typeof import("node:child_process");
        const fs = req("node:fs") as typeof import("node:fs");
        const original = cp.spawn;
        const state = { processes: [] as ObservedProcess[], turnStarts: 0 };
        (globalThis as unknown as { t30Review: typeof state }).t30Review =
          state;
        const persist = () => {
          const budget = JSON.parse(
            fs.readFileSync(guard.budgetPath, "utf8"),
          ) as Json;
          budget.processes = state.processes;
          budget.turnStarts = state.turnStarts;
          fs.writeFileSync(guard.budgetPath, JSON.stringify(budget, null, 2));
        };
        (cp as { spawn: unknown }).spawn = function (
          this: unknown,
          file: unknown,
          args: unknown,
          options: unknown,
        ) {
          const argv = Array.isArray(args) ? args.map(String) : [];
          const child = (
            original as (...a: unknown[]) => ReturnType<typeof cp.spawn>
          ).apply(this, [file, args, options]);
          if (!argv.includes("app-server")) return child;
          const cwd = (options as { cwd?: string } | undefined)?.cwd ?? null;
          const entry: ObservedProcess = {
            index: state.processes.length,
            at: new Date().toISOString(),
            pid: child.pid ?? null,
            executable: String(file),
            restricted: argv.includes(
              `default_permissions="${guard.permissionProfile}"`,
            ),
            contractProvider: argv.some((a) =>
              a.startsWith("model_providers.csthink_contract="),
            ),
            overrides: argv.filter((a) => a === "-c").length,
            cwdBasename: cwd ? cwd.split("/").slice(-2).join("/") : null,
            detached:
              (options as { detached?: boolean } | undefined)?.detached ===
              true,
            methods: [],
            turnStarts: 0,
            interrupts: 0,
          };
          state.processes.push(entry);
          persist();
          const stdin = child.stdin;
          if (stdin) {
            const write = stdin.write.bind(stdin);
            let buffer = "";
            (stdin as { write: unknown }).write = function (
              chunk: unknown,
              ...rest: unknown[]
            ) {
              buffer += String(chunk);
              let end;
              while ((end = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                let message: { method?: string } | null = null;
                try {
                  message = JSON.parse(line) as { method?: string };
                } catch {
                  continue;
                }
                if (!message || typeof message.method !== "string") continue;
                entry.methods.push({
                  method: message.method,
                  at: new Date().toISOString(),
                });
                // Only a Reviewer target's turn reaches the real model; the connection verification's turns go to the product's local synthetic provider.
                if (message.method === "turn/start" && entry.restricted) {
                  if (state.turnStarts >= guard.maxTurns) {
                    persist();
                    throw new Error(
                      `OD-327 guard: ${guard.maxTurns} Reviewer turns already started`,
                    );
                  }
                  state.turnStarts += 1;
                  entry.turnStarts += 1;
                }
                if (message.method === "turn/interrupt") entry.interrupts += 1;
                persist();
              }
              return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
            };
          }
          return child;
        };
        return "installed";
      },
      {
        budgetPath,
        maxTurns: authorized.turns,
        permissionProfile: codexReviewerPermissionProfile,
      },
    );
    const observed = () =>
      app!.evaluate(
        () =>
          (
            globalThis as unknown as {
              t30Review: { processes: ObservedProcess[] };
            }
          ).t30Review.processes,
      );
    // 设置 → 模型: the person confirms the real Codex and enables the model.
    const section = await openProvider(page, "Codex");
    const configure = section.getByRole("button", {
      name: "配置 Codex",
      exact: true,
    });
    // The detection (app-server initialize, account and model/list, 5 s per request) can time out on a
    // busy machine; the person then presses 重新检测 Codex, as the message says. Up to three attempts.
    let detections = 0;
    for (; detections < 3; detections++) {
      const enabled = await expect(configure)
        .toBeEnabled({ timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (enabled) break;
      await section
        .getByRole("button", { name: "重新检测 Codex", exact: true })
        .click();
      await sleep(2_000);
    }
    result.detectionAttempts = detections + 1;
    if (await configure.isVisible().catch(() => false)) {
      await expect(configure).toBeEnabled({ timeout: 60_000 });
      await configure.click();
      const setup = page.getByRole("region", { name: "确认 Codex 连接" });
      await expect(setup).toBeVisible();
      // Personal rule sources need the person's consent before the origin can be confirmed.
      const consent = setup.getByRole("checkbox");
      if (await consent.count()) await consent.first().check();
      await setup
        .getByRole("button", { name: "确认配置 Codex", exact: true })
        .click();
      await expect(section.getByText("已配置", { exact: true })).toBeVisible();
    }
    let connection = (await business()).connections.find(
      (c) => c.provider === "codex",
    )!;
    expect(connection).toBeTruthy();
    const model = chosenModel ?? connection.model;
    const toggle = section.getByRole("checkbox", {
      name: `启用模型 ${model}`,
      exact: true,
    });
    await expect(toggle).toBeVisible();
    if (!(await toggle.isChecked())) {
      await toggle.click();
      await expect(toggle).toBeChecked();
      connection = (await business()).connections.find(
        (c) => c.provider === "codex",
      )!;
    }
    await page.screenshot({ path: join(evidence!, "settings-codex.png") });
    const modelEntry = connection.models.find((m) => m.model === model)!;
    expect(modelEntry?.enabled, `${model} enabled`).toBe(true);
    result.model = model;
    result.modelRef = modelRefOf(model);
    result.connection = {
      provider: connection.provider,
      revision: connection.revision,
      defaultModel: connection.model,
      authentication: connection.codex?.authentication ?? null,
      models: connection.models.map((m) => ({
        model: m.model,
        enabled: m.enabled,
        effort: m.effort,
      })),
    };
    await until(
      async () =>
        ev(
          async (_host, port) =>
            (await port.refreshProfiles()).map((p) => p.id),
          {},
        ),
      (ids) => ids.includes(codexReviewerProfileId),
      120_000,
      "the Reviewer profile offer",
    );
    // The extension: imported with the Reviewer profile as its requirement, its scope authorized on the synthetic project.
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
    /** After each settled operation the projection is awaited until its revision has moved (see real-execution.spec.ts). */
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
        700_000,
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
    const requestArgs = {
      profileId: codexReviewerProfileId,
      preflight: true,
      contextFromCapture: true,
      maxRunSeconds: 600,
      waitSeconds: 630,
      binding: {
        connectionRef: "connection:" + connection.id,
        configurationRevision: String(connection.revision),
        model: modelRefOf(model),
        agent: "agent:codex",
        modelVendor: "vendor:openai",
        roleIntent: "role:reviewer",
        domainNodeRef: "node:review",
      },
    };
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
    const hostEvidence = (record: HostExecutionRecord) =>
      join(executionsRoot, "evidence", record.executionRef.replace(/:/g, "-"));
    const terminal = (r: HostExecutionRecord | null) =>
      !!r && ["completed", "failed", "stopped", "unknown"].includes(r.state);
    const newest = async (previous: Set<string>) =>
      (await records()).runtimeExecutions.find(
        (r) => !previous.has(r.executionRef),
      ) ?? null;

    // ---- Run 1: completes with the one native approval.
    {
      const before = new Set(
        (await records()).runtimeExecutions.map((r) => r.executionRef),
      );
      await material(materials.complete);
      const seen = (await observed()).length;
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
      const processes = (await observed()).slice(seen);
      const run: Json = {
        operation,
        record,
        events: await eventsOf(record!),
        processes,
      };
      runs.complete = run;
      expect(operation.status, operation.reason).toBe("succeeded");
      expect(record!.state).toBe("completed");
      expect(record!.approvalDecisionRefs).toHaveLength(1);
      expect(record!.actualBinding?.model).toBeTruthy();
      expect(record!.accounting?.toolCalls).toBeGreaterThanOrEqual(1);
      const target = processes.find((p) => p.pid === record!.target?.pid);
      expect(target, "the target app-server was observed").toBeTruthy();
      expect(target!.restricted).toBe(true);
      expect(target!.turnStarts).toBe(1);
      expect(target!.interrupts).toBe(0);
      // The release is initialize; config/read is verified again before the thread exists; one turn follows.
      const order = target!.methods.map((m) => m.method);
      const at = (method: string) => order.indexOf(method);
      expect(at("initialize")).toBe(0);
      expect(at("config/read")).toBeGreaterThan(at("initialize"));
      expect(at("thread/start")).toBeGreaterThan(at("config/read"));
      expect(at("turn/start")).toBeGreaterThan(at("thread/start"));
      expect(order.filter((m) => m === "thread/start")).toHaveLength(1);
      // The inspections are other processes, restricted like the target but without a thread.
      const inspections = processes.filter(
        (p) => p.pid !== record!.target?.pid,
      );
      expect(inspections.length).toBeGreaterThanOrEqual(1);
      for (const p of inspections) expect(p.turnStarts).toBe(0);
      const kinds = (run.events as RunEvent[]).map((e) => e.kind);
      expect(kinds).toContain("approval_accepted");
      expect(kinds).toContain("completed");
    }
    // ---- Run 2: cancelled while its turn runs.
    {
      const before = new Set(
        (await records()).runtimeExecutions.map((r) => r.executionRef),
      );
      await material(materials.cancel);
      const seen = (await observed()).length;
      const revisionBefore = await revisionOf();
      const invoked = await start(
        "execution.request",
        "project:1",
        requestArgs,
      );
      const running = await until(
        async () => newest(before),
        (r) => !!r && r.state === "running" && r.target !== null,
        180_000,
        "run 2 running with its target",
      );
      // The turn has been started on the target's stdin, then a few seconds of the model's work before the cancel.
      await until(
        async () =>
          (await observed()).find((p) => p.pid === running!.target?.pid) ??
          null,
        (p) => !!p && p.turnStarts === 1,
        120_000,
        "turn/start on the run 2 target",
      );
      await sleep(5_000);
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
      const processes = (await observed()).slice(seen);
      const run: Json = {
        operation,
        cancel: cancelled.cancel,
        runningSnapshot: {
          state: running!.state,
          target: running!.target,
          releasedAt: running!.releasedAt,
        },
        record,
        events: await eventsOf(record),
        processes,
      };
      runs.cancel = run;
      expect(cancelled.cancel.status).toBe("succeeded");
      expect(record.state).toBe("stopped");
      expect(record.stopReason).toBe("cancelled");
      expect(record.cancelRequestedAt).toBeTruthy();
      expect(operation.status).toBe("cancelled");
      const target = processes.find((p) => p.pid === record.target?.pid);
      expect(target, "the target app-server was observed").toBeTruthy();
      expect(target!.turnStarts).toBe(1);
      expect(target!.interrupts).toBe(1);
      const kinds = (run.events as RunEvent[]).map((e) => e.kind);
      expect(kinds).toContain("stop_requested");
      expect(kinds).toContain("stopped");
      expect(kinds).not.toContain("completed");
    }
    // The whole authorization: two Reviewer turns started in total; the connection verification's turns went to the local synthetic provider.
    const all = await observed();
    expect(all.reduce((n, p) => n + p.turnStarts, 0)).toBe(authorized.turns);
    for (const p of all)
      if (!p.restricted)
        expect(
          p.methods.every((m) => m.method !== "turn/start") ||
            p.contractProvider,
          `process ${p.index} started a turn outside the Reviewer profile and the contract provider`,
        ).toBe(true);
    result.processes = all;
    // 运行记录: the two executions as a person sees them, and the record detail of each.
    await goTo(page, "运行记录");
    const log = page.getByRole("list", { name: "运行事件" });
    await expect(log).toContainText("Reviewer 执行");
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
    // Host result evidence and the shared observation records.
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
      const ev2 = document.evidence as Json;
      // The inspection processes are recorded apart from the target, with their own pids.
      const inspections = ev2.inspections as { pid: number | null }[];
      expect(inspections.length).toBeGreaterThanOrEqual(1);
      for (const p of inspections) expect(p.pid).not.toBe(record.target?.pid);
      if (name === "complete") {
        expect(document.outcome).toBe("completed");
        expect(ev2.turnStatus).toBe("completed");
        // Codex 0.155.1 phases its messages: any commentary before exactly one final answer.
        expect(ev2.messagePhases).toMatchObject({
          finalAnswer: 1,
          unphased: 0,
        });
        expect(ev2.answerBytes as number).toBeGreaterThan(0);
        expect(sha256(String(ev2.answer))).toBe(ev2.answerDigest);
        const approvals = ev2.approvals as Json[];
        expect(approvals).toHaveLength(1);
        expect(approvals[0]).toMatchObject({ decision: "accepted" });
        expect(record.approvalDecisionRefs).toEqual([approvals[0].ref]);
        expect((ev2.readback as Json).model).toBe(record.actualBinding?.model);
      }
      if (name === "cancel") {
        expect(document.stopReason).toBe("cancelled");
        expect(["interrupted", null]).toContain(ev2.turnStatus ?? null);
      }
    }
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
    if (app && !closed) {
      result.recordsAtFailure = await app
        .evaluate(
          () =>
            (
              globalThis as unknown as { runtimeHost: RuntimeHost }
            ).runtimeHost.records()?.runtimeExecutions,
        )
        .catch((e: Error) => "unavailable: " + e.message);
      result.processesAtFailure = await app
        .evaluate(
          () =>
            (globalThis as unknown as { t30Review?: { processes: unknown } })
              .t30Review?.processes ?? null,
        )
        .catch((e: Error) => "unavailable: " + e.message);
    }
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
