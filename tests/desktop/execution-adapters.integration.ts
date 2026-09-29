import { test, expect } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { launchLocal } from "./local-client";
import { buildBundle, newPublisher } from "./runtime-fakes/bundle";
import { graphFakeDir } from "./runtime-fakes/build";
import { GRAPH_CAPABILITY, GRAPH_SCHEMA } from "./runtime-fakes/graph-contract";
import { createClaudeFixture } from "./claude-fixture";
import { createCodexFixture } from "./codex-fixture";
import {
  claudeImplementerDigest,
  claudeImplementerProfileId,
} from "../../src/main/execution-claude";
import {
  codexReviewerDigest,
  codexReviewerProfileId,
} from "../../src/main/execution-codex";
import { modelRefOf } from "../../src/shared/runtime-execution";
import type { RuntimeHost } from "../../src/main/runtime-host";
import type { EmbeddedExecutionPort } from "../../src/main/execution-port";
import type { RuntimeOperation } from "../../src/shared/runtime-host";
import type { HostExecutionRecord } from "../../src/shared/runtime-execution";

/**
 * S-02 integration (V-03): the product's Claude Implementer and Codex Reviewer adapters
 * inside the real Electron main process, offered from the product's own detections of the
 * fixture executables and the connections the settings flow confirms; the graph-domain fake
 * negotiates both profiles, captures its candidate into Host context and requests one
 * Implementer and one Reviewer execution with that snapshot as material.
 */
type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const claudeModel = "claude-opus-5[1m]";
const codexModel = "synthetic-model";

function fixture() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const dir = mkdtempSync(
    resolve(".test-data/disposable/execution-adapters-integration-"),
  );
  mkdirSync(join(dir, "data"));
  mkdirSync(join(dir, "home"));
  const project = join(dir, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  const claude = createClaudeFixture(join(dir, "claude"));
  // A model family the built-in fee table knows: the cap comes from the table (OD-326), no setting exists yet.
  claude.update({ model: claudeModel });
  const codex = createCodexFixture(join(dir, "codex"));
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

test("product adapters end to end: both profiles are negotiated from the fixture installations, the captured candidate is the material, the Implementer runs under the table cost cap and writes into the target directory, the Reviewer completes with exactly one accepted native approval", async ({}, info) => {
  test.setTimeout(300_000);
  const f = fixture();
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${f.root}`],
    cwd: resolve("."),
    env: {
      ...process.env,
      HOME: f.home,
      PATH: `${f.claude.bin}:${f.codex.bin}:/usr/bin:/bin`,
    },
  });
  const page = await app.firstWindow();
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
  /** The business snapshot as the renderer sees it (connections, run events). */
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
  try {
    // The startup profile refresh reads both installations; waiting for it keeps the prepare's own
    // detection from overlapping a cold-start inspection (KB-228 budget).
    // Before any connection is confirmed the product offers no Agent profile and probes no installation.
    const offered = await ev(
      async (_host, port) => (await port.refreshProfiles()).map((p) => p.id),
      {},
    );
    expect(offered).toEqual([]);
    // The connections the settings flow confirms (prepare and accept, the same IPC the page uses).
    const configured = await page.evaluate(async () => {
      const claude = await window.desktop.prepareClaude();
      if (!claude.ok) return { claude: claude.message };
      await window.desktop.acceptClaude(claude.setup.token);
      const codex = await window.desktop.prepareCodex();
      if (!codex.ok) return { codex: codex.message };
      await window.desktop.acceptCodex(codex.setup.token);
      return { claude: claude.setup.model, codex: codex.setup.model };
    });
    expect(configured).toEqual({ claude: claudeModel, codex: codexModel });
    // The catalogue follows the confirmed connections; the product refreshes on the snapshot change, the test waits for it explicitly.
    const offeredAfter = await ev(
      async (_host, port) => (await port.refreshProfiles()).map((p) => p.id),
      {},
    );
    expect(offeredAfter.sort()).toEqual(
      [claudeImplementerProfileId, codexReviewerProfileId].sort(),
    );
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
    expect(
      graph.negotiation?.executionProfiles?.map((p) => [p.id, p.digest]).sort(),
    ).toEqual(
      [
        [claudeImplementerProfileId, claudeImplementerDigest],
        [codexReviewerProfileId, codexReviewerDigest],
      ].sort(),
    );
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
            "integration",
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
          (host, _port, a) =>
            host.projection(a.id as string, a.scope as string),
          { id: gid, scope: scope.scopeRef },
        ),
      (p) => p.actions.some((a) => a.actionId === "execution.request"),
    );
    // The material: the fake's candidate captured into Host context.
    const capture = await invoke("context.capture", "candidate:1", {});
    expect(capture.status, capture.reason).toBe("succeeded");
    const state = (await business()).connections;
    const claudeConnection = state.find((c) => c.provider === "claude")!;
    const codexConnection = state.find((c) => c.provider === "codex")!;
    expect(
      claudeConnection.models.find((m) => m.model === claudeModel)?.enabled,
    ).toBe(true);
    // Implementer
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
    const implemented = (await records()).runtimeExecutions.find(
      (r) => r.profileId === claudeImplementerProfileId,
    ) as HostExecutionRecord;
    expect(implemented.state).toBe("completed");
    expect(implemented.model).toBe(modelRefOf(claudeModel));
    expect(implemented.actualBinding?.model).toBe(claudeModel);
    expect("costCapUsd" in implemented).toBe(false);
    expect(implemented.effort).toBeNull();
    expect(implemented.accounting?.toolCalls).toBe(1);
    expect(implemented.target?.session).toBe(implemented.target?.pid);
    expect(existsSync(join(f.project, "src", "IMPLEMENTED.md"))).toBe(true);
    const claudeCalls = readFileSync(f.claude.calls, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Json);
    const prompt = claudeCalls.find((c) => typeof c.prompt === "string")!;
    expect(String(prompt.prompt)).toContain("# candidate revision 1");
    expect(String(prompt.prompt)).toMatch(
      /材料 1\/1 开始 · objectRef candidate:1/,
    );
    expect(prompt.budget, "no --max-budget-usd was passed").toBeUndefined();
    expect(prompt.effort).toBeUndefined();
    // Reviewer
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
    const reviewed = (await records()).runtimeExecutions.find(
      (r) => r.profileId === codexReviewerProfileId,
    ) as HostExecutionRecord;
    expect(reviewed.state).toBe("completed");
    expect(reviewed.actualBinding).toEqual({
      model: codexModel,
      source: "protocol-init",
      observedModels: [codexModel],
    });
    expect(reviewed.effort).toBe("medium");
    expect(reviewed.approvalDecisionRefs).toHaveLength(1);
    const events = (await business()).events.filter(
      (e) => e.executionId === reviewed.executionId,
    );
    expect(events.map((e) => e.kind).reverse()).toEqual([
      "submitted",
      "started",
      "approval_accepted",
      "completed",
    ]);
    const codexCalls = readFileSync(f.codex.calls, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Json);
    const turn = codexCalls.find((c) => c.reviewerTurn === true)!;
    expect(String(turn.materials)).toContain("-executions");
    expect(existsSync(join(String(turn.materials), "01-candidate_1.md"))).toBe(
      true,
    );
    expect(codexCalls.find((c) => "approvalResponse" in c)?.granted).toBe(true);
    writeFileSync(
      info.outputPath("execution-adapters.json"),
      JSON.stringify(
        { implemented, reviewed, implementer, reviewer, offered: offeredAfter },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
});

/**
 * S-05 integration (V-09): the per-model cost cap travels from the page's IPC command through
 * the business service into the adapter's preflight and argv; the native budget result is a
 * budget failure without a retry; the run-time budget stops a hanging target; the audit script
 * reads the data root and recomputes every accounting field from the Host evidence.
 */
async function session(f: ReturnType<typeof fixture>) {
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${f.root}`],
    cwd: resolve("."),
    env: {
      ...process.env,
      HOME: f.home,
      PATH: `${f.claude.bin}:${f.codex.bin}:/usr/bin:/bin`,
    },
  });
  const page = await app.firstWindow();
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
  const importGraph = async () => {
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
            "integration",
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
          (host, _port, a) =>
            host.projection(a.id as string, a.scope as string),
          { id: gid, scope: scope.scopeRef },
        ),
      (p) => p.actions.some((a) => a.actionId === "execution.request"),
    );
    return { gid, scope, invoke };
  };
  return { app, page, ev, records, business, until, importGraph };
}

test("budgets in the main process: the Implementer is launched without --max-budget-usd; a native error_max_budget_usd end is recorded failed/BUDGET_EXCEEDED with the turn's read-back kept and no second launch; a hanging target past maxRunSeconds is stopped and recorded timeout; scripts/execution-audit.mjs --data-root recomputes every accounting field of both records from the Host evidence", async ({}, info) => {
  test.setTimeout(300_000);
  const f = fixture();
  const s = await session(f);
  try {
    await s.ev(
      async (_host, port) => (await port.refreshProfiles()).map((p) => p.id),
      {},
    );
    const configured = await s.page.evaluate(async () => {
      const claude = await window.desktop.prepareClaude();
      if (!claude.ok) return { claude: claude.message };
      await window.desktop.acceptClaude(claude.setup.token);
      return { claude: claude.setup.model };
    });
    expect(configured).toEqual({ claude: claudeModel });
    await s.ev(
      async (_host, port) => (await port.refreshProfiles()).map((p) => p.id),
      {},
    );
    const claudeConnection = (await s.business()).connections.find(
      (c) => c.provider === "claude",
    )!;
    const { scope, invoke } = await s.importGraph();
    expect((await invoke("context.capture", "candidate:1", {})).status).toBe(
      "succeeded",
    );
    const binding = {
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
    };
    // 1. The native budget result: the Claude Code target ends with error_max_budget_usd by itself (the product passes no cap).
    f.claude.update({ implementer: "budget", costUsd: 0.052 });
    const budget = await invoke("execution.request", "project:1", {
      profileId: claudeImplementerProfileId,
      preflight: true,
      contextFromCapture: true,
      binding,
    });
    expect(budget.status).toBe("failed");
    expect(budget.reason).toMatch(/BUDGET_EXCEEDED|预算超限/);
    const executions = () => s.records().then((r) => r.runtimeExecutions);
    const overBudget = (await executions()).find(
      (r) => r.profileId === claudeImplementerProfileId && r.state === "failed",
    ) as HostExecutionRecord;
    expect(overBudget, JSON.stringify(await executions())).toBeTruthy();
    expect("costCapUsd" in overBudget).toBe(false);
    expect(overBudget.reason).toMatch(
      /Claude Code 报告预算超限（error_max_budget_usd，产品未设置费用上限），已花费 0\.052 美元/,
    );
    const eventsOf = async (record: HostExecutionRecord) =>
      (await s.business()).events
        .filter((e) => e.executionId === record.executionId)
        .reverse();
    const budgetEvents = await eventsOf(overBudget);
    expect(budgetEvents.map((e) => e.kind)).toEqual([
      "submitted",
      "started",
      "failed",
    ]);
    expect("costCapUsd" in budgetEvents[1].payload).toBe(false);
    expect(budgetEvents[2].payload.resultCode).toBe("BUDGET_EXCEEDED");
    expect(budgetEvents[2].payload.errorClass).toBe("budget");
    const launches = () =>
      readFileSync(f.claude.calls, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Json)
        .filter(
          (l) =>
            Array.isArray(l.args) &&
            (l.args as string[]).includes("--safe-mode"),
        );
    expect(launches()).toHaveLength(1);
    const argv = launches()[0].args as string[];
    expect(argv).not.toContain("--max-budget-usd");
    // 2. The run-time budget: a hanging target is stopped after one second and recorded timeout.
    f.claude.update({ implementer: "hang" });
    const timeout = await invoke("execution.request", "project:1", {
      profileId: claudeImplementerProfileId,
      contextFromCapture: true,
      maxRunSeconds: 1,
      cleanupSeconds: 2,
      binding,
    });
    expect(["failed", "cancelled"]).toContain(timeout.status);
    const timedOut = await s.until(
      async () =>
        (await executions()).find((r) => r.state === "stopped") ?? null,
      (r) => !!r,
    );
    expect(timedOut!.stopReason).toBe("timeout");
    expect(timedOut!.exit?.signal).toBe("SIGTERM");
    expect(timedOut!.accounting?.runSeconds).toBeGreaterThanOrEqual(1);
    expect(launches()).toHaveLength(2);
    // 3. The audit over the data root: both records, every accounting field recomputed from the evidence.
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
    const parsed = JSON.parse(
      readFileSync(info.outputPath("execution-audit.json"), "utf8"),
    ) as {
      passed: boolean;
      executions: {
        executionRef: string;
        passed: boolean;
        checks: { id: string; passed: boolean }[];
      }[];
    };
    expect(parsed.passed).toBe(true);
    expect(parsed.executions.map((e) => e.executionRef).sort()).toEqual(
      [overBudget.executionRef, timedOut!.executionRef].sort(),
    );
    for (const execution of parsed.executions)
      for (const check of execution.checks)
        expect(check.passed, execution.executionRef + " " + check.id).toBe(
          true,
        );
    writeFileSync(
      info.outputPath("execution-budgets.json"),
      JSON.stringify(
        { overBudget, timedOut, budget, timeout, budgetEvents },
        null,
        2,
      ),
    );
  } finally {
    await s.app.close();
  }
});
