import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { launchLocal } from "./local-client";
import { buildBundle, newPublisher } from "./runtime-fakes/bundle";
import {
  buildFake,
  fakeAgentPortEntry,
  fakeAgentScript,
  graphFakeDir,
  listFakeEntry,
} from "./runtime-fakes/build";
import { LIST_CAPABILITY, LIST_SCHEMA } from "./runtime-fakes/list-contract";
import { GRAPH_CAPABILITY, GRAPH_SCHEMA } from "./runtime-fakes/graph-contract";
import { fakeAgentProfile } from "./runtime-fakes/fake-agent-port";
import {
  defaultPythonCandidates,
  digestOf,
  resolveLauncher,
} from "../../src/main/runtime-admission";
import type { RuntimeHost } from "../../src/main/runtime-host";
import type {
  RuntimeOperation,
  RuntimeSnapshot,
} from "../../src/shared/runtime-host";

/**
 * S-05 (冻结组合表第 5 行, J-02 Host side): the production Runtime Host inside the real
 * Electron main process drives the Coding graph-domain fake (Python, python3 launcher) and
 * the non-Coding list-domain fake (TypeScript, electron-node launcher) through the
 * validation-plan scenarios C-01 to C-15. The test execution port runs fake_agent.py.
 * Every connection's transcript is written to a unique output directory and the coverage
 * report script must pass on them: 28 methods, runtime.event and the 15 observed error
 * codes with Host-side frames, every frame valid against the 0.1.0 schema.
 */
type Host = RuntimeHost;
type Json = Record<string, unknown>;
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const dir = mkdtempSync(resolve(".test-data/disposable/runtime-scenarios-"));
  mkdirSync(join(dir, "data"));
  mkdirSync(join(dir, "graph-project"));
  mkdirSync(join(dir, "list-project"));
  mkdirSync(join(dir, "transcripts"));
  mkdirSync(join(dir, "executions"));
  const python = resolveLauncher(
    "python3",
    {
      platform: "darwin-arm64",
      osVersion: "27.0",
      electronExecutable: process.execPath,
      pythonCandidates: defaultPythonCandidates(),
      publisherPins: new Map(),
    },
    false,
  );
  if (!python.identity) throw new Error(python.reasons.join("; "));
  const profile = fakeAgentProfile(python.identity);
  const publisher = newPublisher();
  const list = buildBundle(join(dir, "list-bundle"), publisher, {
    runtimeId: "runtime:test-list",
    version: "1",
    entrypoint: "list-fake.cjs",
    entrypointBytes: buildFake(listFakeEntry),
    launcher: "electron-node",
    argv: ["${instanceDir}", "${contractDigest}"],
    capabilities: [{ capability: LIST_CAPABILITY, schema: LIST_SCHEMA }],
  });
  const graphSpec = {
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
          id: profile.id,
          version: profile.version,
          digest: profile.digest,
        },
      },
    ],
  };
  const graph = buildBundle(join(dir, "graph-bundle"), publisher, graphSpec);
  // C-02 probe: the same profile id with another digest is incompatible (UNSUPPORTED_CAPABILITY at initialize).
  const probe = buildBundle(join(dir, "graph-probe-bundle"), publisher, {
    ...graphSpec,
    runtimeId: "runtime:test-graph-probe",
    executionProfileRequirements: [
      {
        capabilityId: GRAPH_CAPABILITY.id,
        profile: {
          id: profile.id,
          version: profile.version,
          digest: "f".repeat(64),
        },
      },
    ],
  });
  // The port bundle is loaded inside the Electron main process through createRequire.
  const portFile = join(dir, "fake-agent-port.cjs");
  writeFileSync(portFile, buildFake(fakeAgentPortEntry));
  return {
    dir,
    root: join(dir, "data"),
    transcripts: join(dir, "transcripts"),
    executions: join(dir, "executions"),
    graphProject: join(dir, "graph-project"),
    listProject: join(dir, "list-project"),
    listBundle: list.dir,
    graphBundle: graph.dir,
    graphProbeBundle: probe.dir,
    graphDigest: graph.artifactDigest,
    portFile,
    python: python.identity,
    profile,
  };
}
async function launch(root: string, transcripts: string) {
  const app = await launchLocal({
    args: [
      resolve("."),
      `--data-root=${root}`,
      `--runtime-transcripts=${transcripts}`,
    ],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  await expect(
    page
      .locator("#main-sidebar")
      .getByRole("button", { name: "新建聊天", exact: true }),
  ).toBeEnabled();
  return app;
}

test("runtime host scenarios C-01 to C-15: both domain fakes on the production Host, every method, runtime.event and the 15 observed error codes with valid Host-side frames", async ({}, info) => {
  test.setTimeout(600_000);
  const f = fixture();
  const app = await launch(f.root, f.transcripts);
  const checks: Record<string, unknown> = {};
  /** Runs a Host call in the main process; the function source travels as a string with its plain-data argument. */
  const ev = <A extends Record<string, unknown>, R>(
    fn: (host: Host, arg: A) => Promise<R> | R,
    arg: A,
  ): Promise<R> =>
    app.evaluate(
      ({ app: _app }, { fn, arg }) => {
        void _app;
        return (
          new Function("host", "arg", "return (" + fn + ")(host, arg)") as (
            host: Host,
            arg: unknown,
          ) => Promise<R> | R
        )((globalThis as unknown as { runtimeHost: Host }).runtimeHost, arg);
      },
      { fn: fn.toString(), arg: arg as Record<string, unknown> },
    ) as Promise<R>;
  const codeOf = <A extends Record<string, unknown>>(
    fn: (host: Host, arg: A) => Promise<unknown>,
    arg: A,
  ) =>
    ev(
      async (host, { fn, arg }) => {
        try {
          await (
            new Function("host", "arg", "return (" + fn + ")(host, arg)") as (
              host: Host,
              arg: unknown,
            ) => Promise<unknown>
          )(host, arg);
          return "OK";
        } catch (error) {
          return (error as { code: string }).code;
        }
      },
      { fn: fn.toString(), arg: arg as Record<string, unknown> },
    );
  const records = () => ev((host) => host.records() as RuntimeSnapshot, {});
  /** A raw request on the live connection, bypassing the Host's own checks (the Contract's Runtime answer is under test). */
  const raw = (
    instanceId: string,
    method: string,
    params: Json,
    options: Json = {},
  ) =>
    ev(
      async (host, a) => {
        try {
          const result = await host.supervisor
            .connectionOf(a.instanceId as string)!
            .call(
              a.method as string,
              a.params as Json,
              a.options as { raw?: boolean },
            );
          return { ok: true as const, result };
        } catch (error) {
          const e = error as { code: string; data?: Json; message: string };
          return {
            ok: false as const,
            code: e.code,
            data: e.data ?? null,
            message: e.message,
          };
        }
      },
      { instanceId, method, params, options },
    );
  const scopeOf = async (instanceId: string) =>
    (await records()).runtimeScopes.find((s) => s.instanceId === instanceId)!;
  /**
   * The domain's own revision and event stream from its state file. The projection has settled
   * when the actions the Host offers carry that revision and the Host scope's cursor has reached
   * the stream's last sequence number. The revision alone does not show that a transaction is
   * fully applied: the root action's upsert comes before the transaction's later events (the list
   * domain's pending.upsert), so a poll can match it in the middle of the transaction.
   */
  const domainRevision = new Map<
    string,
    {
      revision: () => string;
      scopeRef: () => string;
      stream: () => { streamId: string; epoch: string; seq: number };
    }
  >();
  const settle = async (instanceId: string, ms = 30_000) => {
    const start = Date.now();
    for (;;) {
      const scope = await scopeOf(instanceId);
      const domain = domainRevision.get(instanceId);
      if (scope?.freshness === "current" && domain) {
        const expected = domain.revision();
        const projection = await ev(
          (host, a) => host.projection(a.id as string, a.scope as string),
          { id: instanceId, scope: domain.scopeRef() },
        );
        const rootActions = projection.actions.filter(
          (a) =>
            a.objectRef === "project:1" || a.objectRef === "directory:root",
        );
        // Every event the domain has written (its stream's seq) has been applied to the Host scope.
        const stream = domain.stream();
        if (
          rootActions.length &&
          rootActions.every((a) => a.expectedRevision === expected) &&
          scope.cursor?.streamId === stream.streamId &&
          scope.cursor?.epoch === stream.epoch &&
          Number(scope.cursor?.seq) === Number(stream.seq)
        )
          return scope;
      } else if (scope?.freshness === "current" && !domain) return scope;
      if (Date.now() - start > ms)
        throw new Error(
          "projection did not settle: " + JSON.stringify(scope).slice(0, 300),
        );
      await sleep(200);
    }
  };
  const until = async <T>(
    read: () => Promise<T>,
    predicate: (v: T) => boolean,
    ms = 20_000,
  ) => {
    const start = Date.now();
    for (;;) {
      const value = await read();
      if (predicate(value)) return value;
      if (Date.now() - start > ms)
        throw new Error("timeout: " + JSON.stringify(value).slice(0, 400));
      await sleep(100);
    }
  };
  const operation = async (operationId: string) =>
    (await records()).runtimeOperations.find(
      (o) => o.operationId === operationId,
    ) ?? null;
  const fault = (instanceDir: string, value: Json) =>
    writeFileSync(join(instanceDir, "fault.json"), JSON.stringify(value));
  const graphState = (instanceDir: string) =>
    JSON.parse(
      readFileSync(join(instanceDir, "graph-runtime", "state.json"), "utf8"),
    ) as Json;
  try {
    // ---------------------------------------------------------------- setup: port, both bundles, both scopes
    await ev(
      (host, a) => {
        const loaded = process
          .getBuiltinModule("module")
          .createRequire(a.portFile as string)(a.portFile as string) as {
          FakeAgentPort: new (
            options: Json,
          ) => import("./runtime-fakes/fake-agent-port").FakeAgentPort;
        };
        const port = new loaded.FakeAgentPort({
          program: a.python,
          agentScript: a.agentScript,
          workDir: a.workDir,
        });
        (globalThis as unknown as { fakeAgentPort: unknown }).fakeAgentPort =
          port;
        host.registerExecutionPort(port);
      },
      {
        portFile: f.portFile,
        python: f.python,
        agentScript: fakeAgentScript,
        workDir: f.executions,
      },
    );
    const port = <R>(
      fn: (
        port: import("./runtime-fakes/fake-agent-port").FakeAgentPort,
        arg: Json,
      ) => R,
      arg: Json = {},
    ) =>
      ev(
        (_host, a) =>
          (
            new Function("port", "arg", "return (" + a.fn + ")(port, arg)") as (
              port: unknown,
              arg: unknown,
            ) => R
          )(
            (globalThis as unknown as { fakeAgentPort: unknown }).fakeAgentPort,
            a.arg,
          ),
        { fn: fn.toString(), arg },
      );
    // C-02 probes on the graph bundle before the main connection: protocol identity, profile digest, missing profile.
    const probes: Record<string, string> = {};
    const setupGraph = async () => {
      const imported = await ev(
        (host, a) =>
          host.supervisor.importBundle(a.bundle as string, "scenario"),
        { bundle: f.graphBundle },
      );
      if (!imported.ok) throw new Error(JSON.stringify(imported));
      return imported.installationId;
    };
    const graphInstallation = await setupGraph();
    const graph = await until(
      async () =>
        (await records()).runtimeInstances.find(
          (i) => i.installationId === graphInstallation,
        )!,
      (i) => i.state === "ready" || i.state === "failed",
    );
    expect(graph.state, JSON.stringify(graph.failure)).toBe("ready");
    const instanceDir = (argv: string[]) =>
      argv.find((a) => a.includes("/instances/"))!;
    const gid = graph.instanceId;
    const gdir = instanceDir(graph.launchArgv);
    domainRevision.set(gid, {
      revision: () => "rev:" + String(graphState(gdir).revision),
      scopeRef: () => gscope,
      stream: () =>
        graphState(gdir).stream as {
          streamId: string;
          epoch: string;
          seq: number;
        },
    });
    // Probe: the fake refuses a protocol it cannot match; the Host records the negotiation failure (no ready).
    fault(gdir, { rejectProtocol: true });
    await ev((host, a) => host.supervisor.reconnect(a.id as string), {
      id: gid,
    });
    const refusedVersion = await until(
      async () =>
        (await records()).runtimeInstances.find((i) => i.instanceId === gid)!,
      (i) => i.state === "failed" || i.state === "ready",
    );
    probes.version = refusedVersion.failure?.code ?? refusedVersion.state;
    fault(gdir, {});
    await ev((host, a) => host.supervisor.reconnect(a.id as string), {
      id: gid,
    });
    await until(
      async () =>
        (await records()).runtimeInstances.find((i) => i.instanceId === gid)!,
      (i) => i.state === "ready",
    );
    // Probe: a bundle requiring the profile under another digest; the fake refuses at initialize (same id, different digest).
    const probeInstallation = await ev(
      async (host, a) => {
        const imported = await host.supervisor.importBundle(
          a.bundle as string,
          "scenario",
        );
        if (!imported.ok) throw new Error(JSON.stringify(imported));
        return imported.installationId;
      },
      { bundle: f.graphProbeBundle },
    );
    const probeInstance = await until(
      async () =>
        (await records()).runtimeInstances.find(
          (i) => i.installationId === probeInstallation,
        )!,
      (i) => i.state === "failed" || i.state === "ready",
    );
    probes.profileDigest = probeInstance.failure?.code ?? probeInstance.state;
    checks["C-02-probes"] = probes;
    expect(probes.version).toBe("UNSUPPORTED_VERSION");
    expect(probes.profileDigest).toBe("UNSUPPORTED_CAPABILITY");
    const listInstallation = await ev(
      async (host, a) => {
        const imported = await host.supervisor.importBundle(
          a.bundle as string,
          "scenario",
        );
        if (!imported.ok) throw new Error(JSON.stringify(imported));
        return imported.installationId;
      },
      { bundle: f.listBundle },
    );
    const list = await until(
      async () =>
        (await records()).runtimeInstances.find(
          (i) => i.installationId === listInstallation,
        )!,
      (i) => i.state === "ready",
    );
    const lid = list.instanceId;
    const ldir = instanceDir(list.launchArgv);
    domainRevision.set(lid, {
      revision: () =>
        "rev:" +
        String(
          (
            JSON.parse(
              readFileSync(join(ldir, "list-runtime", "state.json"), "utf8"),
            ) as Json
          ).revision,
        ),
      scopeRef: () => listScope,
      stream: () =>
        (
          JSON.parse(
            readFileSync(join(ldir, "list-runtime", "state.json"), "utf8"),
          ) as Json
        ).stream as { streamId: string; epoch: string; seq: number },
    });
    // Zero-grant scope: opened, inactive, and the Runtime refuses a snapshot before authorization (PERMISSION_DENIED).
    const opened = await ev(
      async (host, a) => {
        const resource = await host.registerResource(a.project as string);
        const scope = await host.openScope(a.id as string, resource.handle);
        return { scope, resource };
      },
      { id: gid, project: f.graphProject },
    );
    expect(opened.scope.state).toBe("inactive");
    const denied = await raw(gid, "runtime.snapshot.open", {
      scopeRef: opened.scope.scopeRef,
    });
    expect(denied.ok ? "OK" : denied.code).toBe("PERMISSION_DENIED");
    const gscope = opened.scope.scopeRef;
    const gresource = opened.resource.handle;
    // The graph fake binds one resource per instance: a second binding is refused with RESOURCE_LIMIT and nothing is recorded.
    const second = await codeOf(
      async (host, a) => {
        const resource = await host.registerResource(a.project as string);
        await host.openScope(a.id as string, resource.handle);
      },
      { id: gid, project: f.listProject },
    );
    expect(second).toBe("RESOURCE_LIMIT");
    expect(
      (await records()).runtimeScopes.filter((s) => s.instanceId === gid),
    ).toHaveLength(1);
    const grants = await ev(
      async (host, a) => {
        const read = await host.grant(
          a.id as string,
          a.scope as string,
          "csthink.test.graph",
          "graph.read",
          "scenario",
        );
        const execute = await host.grant(
          a.id as string,
          a.scope as string,
          "csthink.test.graph",
          "graph.execute",
          "scenario",
        );
        const authorized = await host.authorize(
          a.id as string,
          a.scope as string,
        );
        await host.sync(a.id as string, a.scope as string);
        await host.awaitCurrent(a.id as string, a.scope as string);
        return {
          read: read.ref,
          execute: execute.ref,
          state: authorized.state,
        };
      },
      { id: gid, scope: gscope },
    );
    expect(grants.state).toBe("active");
    const listScope = await ev(
      async (host, a) => {
        const resource = await host.registerResource(a.project as string);
        const scope = await host.openScope(a.id as string, resource.handle);
        await host.grant(
          a.id as string,
          scope.scopeRef,
          "csthink.test.list-confirm",
          "directory.read",
          "scenario",
        );
        await host.authorize(a.id as string, scope.scopeRef);
        await host.sync(a.id as string, scope.scopeRef);
        await host.awaitCurrent(a.id as string, scope.scopeRef);
        return scope.scopeRef;
      },
      { id: lid, project: f.listProject },
    );
    const negotiated = (await records()).runtimeInstances.find(
      (i) => i.instanceId === gid,
    )!.negotiation!;
    expect(negotiated.capabilities.map((c) => c.id)).toEqual([
      "csthink.test.graph",
    ]);
    expect(negotiated.executionProfiles).toEqual([
      { id: f.profile.id, version: "1", digest: f.profile.digest },
    ]);
    /** A Host-issued action on the graph domain after the projection settled. */
    const gact = async (
      actionId: string,
      objectRef: string,
      choice: string,
      args: Json = {},
    ) => {
      await settle(gid);
      return ev(
        (host, a) =>
          host.invoke(a.id as string, a.scope as string, {
            actionId: a.actionId as string,
            objectRef: a.objectRef as string,
            payload: { choice: a.choice, arguments: a.args },
          }),
        { id: gid, scope: gscope, actionId, objectRef, choice, args },
      );
    };
    const lact = async (
      actionId: string,
      objectRef: string,
      choice: string,
      args: Json = {},
    ) => {
      await settle(lid);
      return ev(
        (host, a) =>
          host.invoke(a.id as string, a.scope as string, {
            actionId: a.actionId as string,
            objectRef: a.objectRef as string,
            payload: { choice: a.choice, arguments: a.args },
          }),
        { id: lid, scope: listScope, actionId, objectRef, choice, args },
      );
    };
    /** Waits until the graph domain reports the operation terminal through operation.changed events. */
    const gwait = (operationId: string) =>
      until(
        () => operation(operationId),
        (o) =>
          !!o &&
          ["succeeded", "failed", "cancelled", "unknown"].includes(o.status),
        60_000,
      ) as Promise<RuntimeOperation>;

    // ---------------------------------------------------------------- C-01 encoding round trip and invalid frames in both directions
    await test.step("C-01", async () => {
      const args = {
        text: '中文\n换行 "quoted" \\ tab\t',
        big: "9007199254740993",
        nested: { emoji: "😀", accent: "é", list: [1, 2.5, null, true] },
      };
      const round = await gact(
        "text.roundtrip",
        "project:1",
        "roundtrip",
        args,
      );
      expect(round.status).toBe("succeeded");
      const domainDigest = round.reason.replace("arguments-digest:", "");
      expect(domainDigest).toBe(digestOf(args));
      const created = await lact("entry.create", "directory:root", "create", {
        title: "条目 “一” \n",
        group: "inbox",
      });
      expect(created.status).toBe("succeeded");
      await settle(gid);
      const projection = await ev(
        (host, a) => host.projection(a.id as string, a.scope as string),
        { id: gid, scope: gscope },
      );
      const row = (
        projection.objects.find((o) => o.objectRef === "project:1")!.view as {
          rows: { id: string; detail: string }[];
        }
      ).rows.find((r) => r.id === "text")!;
      expect(row.detail).toBe(args.text);
      // Host → Runtime: seven invalid frames are answered with parse/invalid-request errors before dispatch; the connection stays usable.
      const bad: Record<string, Buffer> = {
        bom: Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(
            '{"jsonrpc":"2.0","id":"h:x","method":"runtime.health","params":{}}\n',
          ),
        ]),
        utf8: Buffer.concat([
          Buffer.from(
            '{"jsonrpc":"2.0","id":"h:x","method":"runtime.health","params":{"x":"',
          ),
          Buffer.from([0xff, 0xfe]),
          Buffer.from('"}}\n'),
        ]),
        dupkey: Buffer.from(
          '{"jsonrpc":"2.0","jsonrpc":"2.0","id":"h:x","method":"runtime.health","params":{}}\n',
        ),
        array: Buffer.from(
          '[{"jsonrpc":"2.0","id":"h:x","method":"runtime.health"}]\n',
        ),
        nan: Buffer.from(
          '{"jsonrpc":"2.0","id":"h:x","method":"runtime.health","params":{"n":NaN}}\n',
        ),
        "nonobject-params": Buffer.from(
          '{"jsonrpc":"2.0","id":"h:x","method":"runtime.health","params":[]}\n',
        ),
        depth: Buffer.from(
          '{"jsonrpc":"2.0","id":"h:x","method":"runtime.health","params":' +
            '{"a":'.repeat(40) +
            "1" +
            "}".repeat(40) +
            "}\n",
        ),
      };
      const toRuntime: Record<string, number | null> = {};
      for (const [kind, bytes] of Object.entries(bad)) {
        const before = (await ev(
          (host, a) =>
            host.supervisor.connectionOf(a.id as string)!.orphanReplies.length,
          { id: gid },
        )) as number;
        await ev(
          (host, a) => {
            host.supervisor
              .connectionOf(a.id as string)!
              .child!.stdin!.write(Buffer.from(a.bytes as string, "base64"));
          },
          { id: gid, bytes: bytes.toString("base64") },
        );
        const replies = await until(
          () =>
            ev(
              (host, a) =>
                host.supervisor.connectionOf(a.id as string)!.orphanReplies,
              { id: gid },
            ),
          (r) => r.length > before,
        );
        toRuntime[kind] = replies[before]?.code ?? null;
      }
      expect(
        Object.values(toRuntime).every((c) => c === -32700 || c === -32600),
        JSON.stringify(toRuntime),
      ).toBe(true);
      const health = await raw(gid, "runtime.health", {});
      expect(health.ok && (health.result as Json).health).toBe("ready");
      // Runtime → Host: the same seven kinds are refused by the Host before dispatch and recorded as rejections.
      const fromRuntime: Record<string, number | undefined> = {};
      for (const kind of [
        "bom",
        "utf8",
        "dupkey",
        "array",
        "nan",
        "nonobject-params",
        "depth",
      ]) {
        const before = (await ev(
          (host, a) =>
            host.supervisor.connectionOf(a.id as string)!.frameRejections
              .length,
          { id: gid },
        )) as number;
        await gact("emit.badframe", "project:1", "inject", { kind });
        const rejections = await until(
          () =>
            ev(
              (host, a) =>
                host.supervisor.connectionOf(a.id as string)!.frameRejections,
              { id: gid },
            ),
          (r) => r.length > before,
        );
        fromRuntime[kind] = rejections[before]?.rpcCode;
      }
      expect(
        Object.values(fromRuntime).every((c) => c === -32700 || c === -32600),
        JSON.stringify(fromRuntime),
      ).toBe(true);
      // An oversized frame closes only that connection; scopes stay stale and Host operations are kept.
      const opsBefore = (await records()).runtimeOperations.length;
      await gact("emit.badframe", "project:1", "inject", { kind: "oversize" });
      const exited = await until(
        async () =>
          (await records()).runtimeInstances.find((i) => i.instanceId === gid)!,
        (i) => i.state === "exited",
      );
      expect((await scopeOf(gid)).freshness).toBe("stale");
      expect((await records()).runtimeOperations.length).toBeGreaterThanOrEqual(
        opsBefore,
      );
      await ev((host, a) => host.supervisor.reconnect(a.id as string), {
        id: gid,
      });
      await until(
        async () => await scopeOf(gid),
        (s) => s.freshness === "current",
      );
      checks["C-01"] = {
        domainDigest,
        toRuntime,
        fromRuntime,
        oversize: exited.failure?.code,
      };
    });

    // ---------------------------------------------------------------- C-03 lost answers and idempotency
    await test.step("C-03", async () => {
      const revBefore = graphState(gdir).revision as number;
      fault(gdir, { dropResponse: "runtime.action.invoke" });
      const lost = await gact("text.roundtrip", "project:1", "roundtrip", {
        text: "lost answer",
      });
      fault(gdir, {});
      expect(lost.transport).toBe("lost");
      const queried = await ev(
        (host, a) =>
          host.operationGet(a.id as string, a.scope as string, a.op as string),
        { id: gid, scope: gscope, op: lost.operationId },
      );
      const again = await ev(
        (host, a) => host.resend(a.id as string, a.op as string),
        { id: gid, op: lost.operationId },
      );
      expect(queried.operation?.status).toBe("succeeded");
      expect(again.operationId).toBe(lost.operationId);
      expect(again.status).toBe("succeeded");
      expect((graphState(gdir).revision as number) - revBefore).toBe(1);
      // The capture answer is lost on the runtime side: host.context.get recovers the same operationId and mapping.
      fault(gdir, { ignoreHostAnswer: "host.context.capture" });
      const cap = await gact("context.capture", "candidate:1", "capture");
      const capOp = await gwait(cap.operationId);
      fault(gdir, {});
      expect(capOp.status).toBe("succeeded");
      const captures = (await records()).runtimeOperations.filter(
        (o) => o.method === "host.context.capture",
      );
      expect(captures).toHaveLength(1);
      expect((await records()).runtimeContextSnapshots).toHaveLength(1);
      // The start answer is lost: host.operation.get recovers the executionRef, no second physical execution.
      await port((p) => p.plan({ vector: "valid" }));
      fault(gdir, { ignoreHostAnswer: "host.execution.start" });
      const exec = await gact("execution.request", "project:1", "request");
      const execOp = await gwait(exec.operationId);
      fault(gdir, {});
      expect(execOp.status).toBe("succeeded");
      expect((await port((p) => p.executions.size)) as number).toBe(1);
      expect(
        (await records()).runtimeOperations.filter(
          (o) => o.method === "host.execution.start",
        ),
      ).toHaveLength(1);
      // Same key with another payload, and the same key with another grant revision: IDEMPOTENCY_CONFLICT.
      const k1 = await gact("text.roundtrip", "project:1", "roundtrip", {
        text: "k1",
      });
      const body = {
        ...k1.request!,
        payload: { choice: "roundtrip", arguments: { text: "k1-changed" } },
      };
      delete (body as Json).requestDigest;
      const payloadConflict = await raw(gid, "runtime.action.invoke", {
        ...body,
        requestDigest: digestOf({ method: "runtime.action.invoke", ...body }),
      });
      // A grant re-issued by the Host is a new reference: the old key with the new grant set is another intent.
      const extra = await ev(
        async (host, a) => {
          const grant = await host.grant(
            a.id as string,
            a.scope as string,
            "csthink.test.graph",
            "graph.read",
            "scenario extra",
          );
          await host.authorize(a.id as string, a.scope as string);
          return grant.ref;
        },
        { id: gid, scope: gscope },
      );
      const bodyRev = { ...k1.request!, grantRefs: [extra, grants.execute] };
      delete (bodyRev as Json).requestDigest;
      const revConflict = await raw(gid, "runtime.action.invoke", {
        ...bodyRev,
        requestDigest: digestOf({
          method: "runtime.action.invoke",
          ...bodyRev,
        }),
      });
      await ev(
        async (host, a) => host.revokeGrant(a.id as string, a.grant as string),
        { id: gid, grant: extra.id },
      );
      expect(payloadConflict.ok ? "OK" : payloadConflict.code).toBe(
        "IDEMPOTENCY_CONFLICT",
      );
      expect(revConflict.ok ? "OK" : revConflict.code).toBe(
        "IDEMPOTENCY_CONFLICT",
      );
      checks["C-03"] = {
        queried: queried.operation?.status,
        capture: capOp.status,
        execution: execOp.status,
        payloadConflict: payloadConflict.ok ? null : payloadConflict.code,
        revConflict: revConflict.ok ? null : revConflict.code,
      };
    });

    // ---------------------------------------------------------------- C-04 crash after the domain write, projection rebuild, pending item identity
    await test.step("C-04", async () => {
      const before = await ev(
        (host, a) => host.projection(a.id as string, a.scope as string),
        { id: gid, scope: gscope },
      );
      const pendingBefore = before.pendingItems.find(
        (i) => i.itemRef === "pending:review",
      )!;
      const countsBefore = (await scopeOf(gid)).counts!;
      const candidateRevBefore = graphState(gdir).candidateRevision as number;
      fault(gdir, { crashAfterWrite: "candidate.revise" });
      const crashed = await gact("candidate.revise", "candidate:1", "revise", {
        text: "revised once",
      });
      fault(gdir, {});
      expect(crashed.transport).toBe("lost");
      const exited = await until(
        async () =>
          (await records()).runtimeInstances.find((i) => i.instanceId === gid)!,
        (i) => i.state === "exited",
      );
      expect(exited.exit?.code).toBe(3);
      await ev((host, a) => host.supervisor.reconnect(a.id as string), {
        id: gid,
      });
      await until(
        async () => await scopeOf(gid),
        (s) => s.freshness === "current",
      );
      const op = await ev(
        (host, a) =>
          host.operationGet(a.id as string, a.scope as string, a.op as string),
        { id: gid, scope: gscope, op: crashed.operationId },
      );
      const replay = await ev(
        (host, a) => host.resend(a.id as string, a.op as string),
        { id: gid, op: crashed.operationId },
      );
      expect(op.operation?.status).toBe("succeeded");
      expect(replay.operationId).toBe(crashed.operationId);
      expect(graphState(gdir).candidateRevision).toBe(candidateRevBefore + 1);
      // Rebuild: a fresh full synchronisation replaces the projection without touching the domain file.
      const stateShaBefore = sha256(
        readFileSync(join(gdir, "graph-runtime", "state.json")),
      );
      const objectsBefore = JSON.stringify(
        (
          await ev(
            (host, a) => host.projection(a.id as string, a.scope as string),
            { id: gid, scope: gscope },
          )
        ).objects,
      );
      await ev((host, a) => host.sync(a.id as string, a.scope as string), {
        id: gid,
        scope: gscope,
      });
      await settle(gid);
      const rebuilt = await ev(
        (host, a) => host.projection(a.id as string, a.scope as string),
        { id: gid, scope: gscope },
      );
      const pendingAfter = rebuilt.pendingItems.find(
        (i) => i.itemRef === "pending:review",
      )!;
      expect(JSON.stringify(rebuilt.objects)).toBe(objectsBefore);
      expect(
        sha256(readFileSync(join(gdir, "graph-runtime", "state.json"))),
      ).toBe(stateShaBefore);
      expect(pendingAfter.pendingSince).toBe(pendingBefore.pendingSince);
      expect(pendingAfter.typeId).toBe(pendingBefore.typeId);
      expect(pendingAfter.blocking).toBe(true);
      expect(pendingAfter.status).toBe("pending");
      const countsAfter = (await scopeOf(gid)).counts!;
      expect(countsAfter.pending).toBe(countsBefore.pending);
      expect(countsAfter.blocking).toBe(1);
      checks["C-04"] = {
        exit: exited.exit?.code,
        op: op.operation?.status,
        candidateRevision: graphState(gdir).candidateRevision,
        pendingSince: pendingAfter.pendingSince,
      };
    });

    // ---------------------------------------------------------------- C-05 paging
    await test.step("C-05", async () => {
      // Pages: the graph fake pages three items at a time; the Host reads them under one snapshot revision.
      const first = await raw(gid, "runtime.snapshot.open", {
        scopeRef: gscope,
      });
      expect(first.ok).toBe(true);
      const page0 = first.result as Json;
      expect(page0.nextPageToken).not.toBeNull();
      const again1 = await raw(gid, "runtime.snapshot.next", {
        scopeRef: gscope,
        snapshotId: page0.snapshotId,
        pageToken: page0.nextPageToken,
      });
      const again2 = await raw(gid, "runtime.snapshot.next", {
        scopeRef: gscope,
        snapshotId: page0.snapshotId,
        pageToken: page0.nextPageToken,
      });
      expect(again1.ok && again2.ok).toBe(true);
      const strip = (v: Json) => {
        const { context: _c, ...rest } = v;
        void _c;
        return JSON.stringify(rest);
      };
      expect(strip(again1.result as Json)).toBe(strip(again2.result as Json));
      // A write between the last page and the subscription arrives through replay, never mixed into the pages.
      const counterBefore = graphState(gdir).counter as number;
      fault(gdir, { mutateAfterSnapshot: true });
      await ev((host, a) => host.sync(a.id as string, a.scope as string), {
        id: gid,
        scope: gscope,
      });
      fault(gdir, {});
      await settle(gid);
      const projection = await ev(
        (host, a) => host.projection(a.id as string, a.scope as string),
        { id: gid, scope: gscope },
      );
      const counter = (
        projection.objects.find((o) => o.objectRef === "project:1")!.view as {
          rows: { id: string; detail: string }[];
        }
      ).rows.find((r) => r.id === "counter")!.detail;
      expect(Number(counter)).toBe(counterBefore + 1);
      expect((await scopeOf(gid)).freshness).toBe("current");
      // Lease expiry: the second page fails with RESYNC_REQUIRED and the Host never splices pages of different snapshots.
      // A synchronisation still running (for example one a replay gap started) would be joined by host.sync and
      // finish on its own snapshot, so it is completed before the lease fault is set.
      await ev((host, a) => host.sync(a.id as string, a.scope as string), {
        id: gid,
        scope: gscope,
      });
      await settle(gid);
      fault(gdir, { snapshotLease: 0 });
      const snapshotBefore = (await scopeOf(gid)).snapshotId;
      const expired = await codeOf(
        (host, a) => host.sync(a.id as string, a.scope as string),
        { id: gid, scope: gscope },
      );
      fault(gdir, {});
      expect(expired).toBe("RESYNC_REQUIRED");
      const stale = await scopeOf(gid);
      expect(stale.snapshotId).toBe(snapshotBefore);
      await ev((host, a) => host.sync(a.id as string, a.scope as string), {
        id: gid,
        scope: gscope,
      });
      await settle(gid);
      checks["C-05"] = { samePage: true, replayedCounter: counter, expired };
    });

    // ---------------------------------------------------------------- C-06 event stream
    await test.step("C-06", async () => {
      const syncState = () =>
        ev((host, a) => host.syncState(a.id as string, a.scope as string), {
          id: gid,
          scope: gscope,
        });
      const rejections = async () =>
        (await ev(
          (host, a) =>
            host.supervisor.connectionOf(a.id as string)!.contextRejections,
          { id: gid },
        )) as number;
      type Seen = {
        scope: Awaited<ReturnType<typeof scopeOf>>;
        sync: Awaited<ReturnType<typeof syncState>>;
        rejections: number;
      };
      /**
       * Sends one crafted event behind the inject action's own events and returns what the Host shows
       * once `handled` holds: each outcome is read when the Host has visibly handled the event, not after
       * a fixed pause that a slower commit of the events before it can outlast.
       */
      const inject = async (
        vector: string,
        handled: (seen: Seen) => boolean,
        extra: Json = {},
      ) => {
        await gact("inject.events", "project:1", "inject", {
          vector,
          ...extra,
        });
        return until(
          async () => ({
            scope: await scopeOf(gid),
            sync: await syncState(),
            rejections: await rejections(),
          }),
          handled,
        );
      };
      /** The Host scope's cursor is at the last event the domain has written (its stream's seq). */
      const applied = (scope: Seen["scope"]) => {
        const stream = domainRevision.get(gid)!.stream();
        return (
          scope.cursor?.streamId === stream.streamId &&
          scope.cursor?.epoch === stream.epoch &&
          Number(scope.cursor?.seq) === Number(stream.seq)
        );
      };
      const outcomes: Json = {};
      // A duplicate changes nothing the Host shows: it is read once the events it repeats are applied.
      const dup = await inject(
        "duplicate",
        (s) => s.scope.freshness !== "current" || applied(s.scope),
      );
      outcomes.duplicate = dup.scope.freshness;
      const tamper = await inject(
        "tamper",
        (s) => s.scope.freshness !== "current",
      );
      outcomes.tamper = tamper.scope.lastError?.code ?? tamper.scope.freshness;
      const paused = await codeOf(
        (host, a) =>
          host.invoke(a.id as string, a.scope as string, {
            actionId: "text.roundtrip",
            objectRef: "project:1",
            payload: {
              choice: "roundtrip",
              arguments: { text: "while stale" },
            },
          }),
        { id: gid, scope: gscope },
      );
      await ev((host, a) => host.sync(a.id as string, a.scope as string), {
        id: gid,
        scope: gscope,
      });
      await settle(gid);
      // A skipped sequence makes the Host resynchronise: the subscription that feeds the projection is replaced.
      const sidBeforeGap = (await scopeOf(gid)).subscriptionId!;
      const afterGap = (
        await inject(
          "gap",
          (s) =>
            s.scope.freshness === "current" &&
            s.scope.subscriptionId !== sidBeforeGap,
        )
      ).scope;
      outcomes.gap =
        afterGap.subscriptionId !== sidBeforeGap ? "resynced" : "missing";
      const oldSid = afterGap.subscriptionId!;
      await ev((host, a) => host.sync(a.id as string, a.scope as string), {
        id: gid,
        scope: gscope,
      });
      await settle(gid);
      const newSid = (await scopeOf(gid)).subscriptionId!;
      expect(newSid).not.toBe(oldSid);
      const ignoredBefore = (await syncState())!.ignoredEvents;
      const oldSub = await inject(
        "old-subscription",
        (s) => s.sync!.ignoredEvents > ignoredBefore,
        { sid: oldSid },
      );
      outcomes.oldSubscription =
        oldSub.sync!.ignoredEvents > ignoredBefore ? "ignored" : "missing";
      // An event of another epoch makes the Host take a full snapshot on a new subscription.
      const sidBeforeOldEpoch = (await scopeOf(gid)).subscriptionId!;
      const oldEpoch = await inject(
        "old-epoch",
        (s) =>
          s.scope.freshness === "current" &&
          s.scope.subscriptionId !== sidBeforeOldEpoch,
      );
      outcomes.oldEpoch = oldEpoch.scope.freshness;
      const rejectedBefore = await rejections();
      const oldContext = await inject(
        "old-context",
        (s) => s.rejections > rejectedBefore,
      );
      outcomes.oldContext =
        oldContext.rejections > rejectedBefore ? "rejected" : "missing";
      await gact("epoch.rotate", "project:1", "rotate");
      const rotated = await until(
        async () => await scopeOf(gid),
        (s) => s.freshness === "current" && s.cursor?.epoch === "epoch:2",
        30_000,
      );
      expect(outcomes.duplicate).toBe("current");
      expect(outcomes.tamper).toBe("PROTOCOL");
      expect(paused).toBe("RESYNC_REQUIRED");
      expect(outcomes.gap).toBe("resynced");
      expect(outcomes.oldSubscription).toBe("ignored");
      expect(outcomes.oldEpoch).toBe("current");
      expect(outcomes.oldContext).toBe("rejected");
      checks["C-06"] = { ...outcomes, paused, epoch: rotated.cursor?.epoch };
    });

    // ---------------------------------------------------------------- C-07 projection transaction and lost ack
    await test.step("C-07", async () => {
      // The Host applies each event and its cursor in one SQLite transaction (store level, verified in unit tests);
      // here the acknowledgement answer is lost: the Host records the loss, the next acknowledgement covers the
      // same sequence again, and the domain state does not change.
      const seqBefore = Number((await scopeOf(gid)).cursor!.seq);
      fault(gdir, { dropResponse: "runtime.events.ack" });
      const text = await gact("text.roundtrip", "project:1", "roundtrip", {
        text: "ack lost",
      });
      expect(text.status).toBe("succeeded");
      await until(
        async () => await scopeOf(gid),
        (s) => Number(s.cursor?.seq ?? 0) > seqBefore,
      );
      fault(gdir, {});
      const stateBefore = sha256(
        readFileSync(join(gdir, "graph-runtime", "state.json")),
      );
      const seq = (await scopeOf(gid)).cursor!.seq;
      const sid = (await scopeOf(gid)).subscriptionId!;
      const a1 = await raw(gid, "runtime.events.ack", {
        subscriptionId: sid,
        streamId: "stream:graph",
        epoch: "epoch:2",
        seq,
      });
      const a2 = await raw(gid, "runtime.events.ack", {
        subscriptionId: sid,
        streamId: "stream:graph",
        epoch: "epoch:2",
        seq,
      });
      expect(a1.ok && a2.ok).toBe(true);
      expect((a1.result as Json).acknowledgedSeq).toBe(
        (a2.result as Json).acknowledgedSeq,
      );
      expect(
        sha256(readFileSync(join(gdir, "graph-runtime", "state.json"))),
      ).toBe(stateBefore);
      const projection = await ev(
        (host, a) => host.projection(a.id as string, a.scope as string),
        { id: gid, scope: gscope },
      );
      expect(
        (
          projection.objects.find((o) => o.objectRef === "project:1")!.view as {
            rows: { id: string; detail: string }[];
          }
        ).rows.find((r) => r.id === "text")!.detail,
      ).toBe("ack lost");
      checks["C-07"] = { ackSeq: (a1.result as Json).acknowledgedSeq };
    });

    // ---------------------------------------------------------------- C-08 revocation, three entries, decisions, foreign snapshot
    await test.step("C-08", async () => {
      // Three entries of one intent: the persisted request is retransmitted concurrently; one effect.
      const revBefore = graphState(gdir).candidateRevision as number;
      const triple = await gact("candidate.revise", "candidate:1", "revise", {
        text: "triple",
      });
      expect(
        triple.status,
        JSON.stringify([
          triple.reason,
          triple.request?.expectedRevision,
          graphState(gdir).revision,
          (await scopeOf(gid)).revision,
        ]),
      ).toBe("succeeded");
      const three = await ev(
        (host, a) =>
          Promise.all([
            host.resend(a.id as string, a.op as string),
            host.resend(a.id as string, a.op as string),
            host.resend(a.id as string, a.op as string),
          ]),
        { id: gid, op: triple.operationId },
      );
      expect(
        three.every(
          (r) =>
            r.operationId === triple.operationId && r.status === "succeeded",
        ),
        JSON.stringify(
          three.map((r) => [r.status, r.transport, r.errorCode, r.reason]),
        ),
      ).toBe(true);
      expect(graphState(gdir).candidateRevision).toBe(revBefore + 1);
      // A decision is recorded while the Runtime refuses the Invoke (BUSY): the record exists, the effect does not.
      await settle(gid);
      fault(gdir, { busy: "runtime.action.invoke" });
      const decided = await ev(
        (host, a) =>
          host.decide(a.id as string, a.scope as string, {
            actionId: "candidate.review",
            objectRef: "candidate:1",
            payload: { choice: "review", arguments: {} },
            evidence: [],
            actorRef: "actor:scenario",
          }),
        { id: gid, scope: gscope },
      );
      fault(gdir, {});
      expect(decided.operation.errorCode).toBe("BUSY");
      expect(graphState(gdir).reviewed).toBe(false);
      // The decided request replayed with another payload: the Runtime reads the record and refuses the digest mismatch.
      const tampered = {
        ...decided.operation.request!,
        payload: {
          choice: "review",
          arguments: { note: "changed after the decision" },
        },
      };
      delete (tampered as Json).requestDigest;
      const digestMismatch = await raw(gid, "runtime.action.invoke", {
        ...tampered,
        requestDigest: digestOf({
          method: "runtime.action.invoke",
          ...tampered,
        }),
      });
      expect(digestMismatch.ok ? "OK" : digestMismatch.code).toBe(
        "PERMISSION_DENIED",
      );
      // The candidate changes after the decision: the decided Invoke is stale, the old confirmation never replaces the current candidate.
      const revised = await gact("candidate.revise", "candidate:1", "revise", {
        text: "changed after decision",
      });
      expect(revised.status).toBe("succeeded");
      await settle(gid);
      const staleCandidate = await ev(
        (host, a) => host.resend(a.id as string, a.op as string),
        { id: gid, op: decided.operation.operationId },
      );
      expect(staleCandidate.errorCode).toBe("PRECONDITION_CONFLICT");
      const decidedAgain = await ev(
        (host, a) =>
          host.decide(a.id as string, a.scope as string, {
            actionId: "candidate.review",
            objectRef: "candidate:1",
            payload: { choice: "review", arguments: {} },
            evidence: [],
            actorRef: "actor:scenario",
          }),
        { id: gid, scope: gscope },
      );
      expect(decidedAgain.operation.status).toBe("succeeded");
      expect(graphState(gdir).reviewed).toBe(true);
      // Capture, readback through host.resource.read, and a foreign scope's attempt to read the copied snapshot.
      const capture = await gact("context.capture", "candidate:1", "capture");
      const capOp = await gwait(capture.operationId);
      expect(capOp.status).toBe("succeeded");
      const receipt = Object.values(
        graphState(gdir).captures as Record<string, Json>,
      ).pop()!;
      const readback = await gact(
        "context.readback",
        "candidate:1",
        "readback",
      );
      const readbackOp = await gwait(readback.operationId);
      expect(readbackOp.status).toBe("succeeded");
      expect(readbackOp.reason).toMatch(/matches/);
      const foreign = await lact(
        "entry.read-foreign",
        "directory:root",
        "read-foreign",
        { evidence: (receipt.snapshots as Json[])[0].snapshot },
      );
      // Another instance never sees the handle: the Host answers as if it did not exist (NOT_FOUND), a foreign scope of the same instance is PERMISSION_DENIED (unit test).
      expect(foreign.status).toBe("failed");
      expect(["NOT_FOUND", "PERMISSION_DENIED"]).toContain(foreign.resultCode);
      // Revoking the read grant blocks the next domain access at once; the Runtime re-checks the Host on each access.
      await settle(gid);
      const revokedRead = await ev(
        (host, a) => host.revokeGrant(a.id as string, a.grant as string),
        { id: gid, grant: grants.read.id },
      );
      expect(revokedRead.scope?.state).toBe("inactive");
      const denied = await codeOf(
        (host, a) =>
          host.invoke(a.id as string, a.scope as string, {
            actionId: "text.roundtrip",
            objectRef: "project:1",
            payload: {
              choice: "roundtrip",
              arguments: { text: "after revoke" },
            },
          }),
        { id: gid, scope: gscope },
      );
      expect(denied).toBe("PERMISSION_DENIED");
      const reissued = await ev(
        async (host, a) => {
          const read = await host.grant(
            a.id as string,
            a.scope as string,
            "csthink.test.graph",
            "graph.read",
            "scenario re-issued",
          );
          await host.authorize(a.id as string, a.scope as string);
          return read.ref;
        },
        { id: gid, scope: gscope },
      );
      grants.read = reissued;
      await ev((host, a) => host.sync(a.id as string, a.scope as string), {
        id: gid,
        scope: gscope,
      });
      await settle(gid);
      // The domain forwards an execute grant it obtained earlier; it was revoked in the meantime: the Host refuses the physical execution with PERMISSION_REVOKED.
      const revokedExecute = grants.execute;
      await ev(
        (host, a) => host.revokeGrant(a.id as string, a.grant as string),
        { id: gid, grant: revokedExecute.id },
      );
      grants.execute = await ev(
        async (host, a) => {
          const execute = await host.grant(
            a.id as string,
            a.scope as string,
            "csthink.test.graph",
            "graph.execute",
            "scenario re-issued",
          );
          await host.authorize(a.id as string, a.scope as string);
          return execute.ref;
        },
        { id: gid, scope: gscope },
      );
      await ev((host, a) => host.sync(a.id as string, a.scope as string), {
        id: gid,
        scope: gscope,
      });
      // No plan is queued: the Host refuses before the port is reached, so no target may be created.
      const execAfterRevoke = await gact(
        "execution.request",
        "project:1",
        "request",
        { grantRefs: [grants.read, revokedExecute] },
      );
      const execOp = await gwait(execAfterRevoke.operationId);
      expect(execOp.status).toBe("failed");
      expect(execOp.resultCode).toBe("PERMISSION_REVOKED");
      expect((await port((p) => p.plans.length)) as number).toBe(0);
      checks["C-08"] = {
        triple: three.length,
        digestMismatch: digestMismatch.ok ? null : digestMismatch.code,
        staleCandidate: staleCandidate.errorCode,
        reviewed: decidedAgain.operation.status,
        foreign: foreign.resultCode,
        denied,
        revokedExecution: execOp.resultCode,
      };
    });

    // ---------------------------------------------------------------- C-09 completion versus cancellation
    await test.step("C-09", async () => {
      await port((p) => p.plan({ vector: "hang" }));
      const hang = await gact("execution.request", "project:1", "request");
      await until(
        () => operation(hang.operationId),
        (o) => o?.status === "running",
      );
      const cancel = await ev(
        (host, a) =>
          host.cancel(a.id as string, a.scope as string, a.op as string),
        { id: gid, scope: gscope, op: hang.operationId },
      );
      expect(cancel.cancel.status).toBe("succeeded");
      const hangOp = await gwait(hang.operationId);
      expect(hangOp.status).toBe("cancelled");
      const hangExec = (await records()).runtimeOperations.find(
        (o) =>
          o.method === "host.execution.start" &&
          (o.request as Json).domainOperationId === hang.operationId,
      )!;
      const physical = await port((p, a) => p.settled(a.ref as string), {
        ref: hangExec.executionRef!,
      });
      expect(physical?.view.state).toBe("stopped");
      expect(physical?.view.stopReason).toBe("cancelled");
      // Completion first: a later cancel reports the terminal target and does not rewrite it.
      await port((p) => p.plan({ vector: "valid" }));
      const done = await gact("execution.request", "project:1", "request", {
        preflight: true,
      });
      const doneOp = await gwait(done.operationId);
      expect(doneOp.status).toBe("succeeded");
      const late = await ev(
        (host, a) =>
          host.cancel(a.id as string, a.scope as string, a.op as string),
        { id: gid, scope: gscope, op: done.operationId },
      );
      expect(late.cancel.reason).toMatch(/already terminal/);
      expect(late.target?.status).toBe("succeeded");
      // Lost cancel answer: the query and the retransmission keep the one cancel operation; the cancelled result reads as CANCELLED.
      await port((p) => p.plan({ vector: "hang" }));
      const hang2 = await gact("execution.request", "project:1", "request");
      await until(
        () => operation(hang2.operationId),
        (o) => o?.status === "running",
      );
      fault(gdir, { dropResponse: "runtime.operation.cancel" });
      const dropped = await ev(
        (host, a) =>
          host.cancel(a.id as string, a.scope as string, a.op as string),
        { id: gid, scope: gscope, op: hang2.operationId },
      );
      fault(gdir, {});
      expect(dropped.cancel.transport).toBe("lost");
      const cancelOp = await ev(
        (host, a) =>
          host.operationGet(a.id as string, a.scope as string, a.op as string),
        { id: gid, scope: gscope, op: dropped.cancel.operationId },
      );
      const resent = await ev(
        (host, a) => host.resend(a.id as string, a.op as string),
        { id: gid, op: dropped.cancel.operationId },
      );
      expect(cancelOp.operation?.status).toBe("succeeded");
      expect(resent.operationId).toBe(dropped.cancel.operationId);
      const hang2Op = await gwait(hang2.operationId);
      expect(hang2Op.status).toBe("cancelled");
      const cancelledRef = {
        authority: "runtime",
        resourceHandle: gresource,
        scopeRef: gscope,
        objectRef: "execution-result:" + hang.operationId,
        revision: "rev:1",
        mediaType: "text/plain",
        bytes: 0,
        digest: sha256(""),
      };
      const cancelledRead = await raw(gid, "runtime.resource.read", {
        scopeRef: gscope,
        evidence: cancelledRef,
        grantRefs: [grants.read],
        offset: 0,
        length: 16,
      });
      expect(cancelledRead.ok ? "OK" : cancelledRead.code).toBe("CANCELLED");
      checks["C-09"] = {
        cancelFirst: {
          op: hangOp.status,
          physical: physical?.view.state,
          stopReason: physical?.view.stopReason,
        },
        completeFirst: late.cancel.reason,
        lostCancel: cancelOp.operation?.status,
        cancelledRead: cancelledRead.ok ? null : cancelledRead.code,
      };
    });

    // ---------------------------------------------------------------- C-10 bounded behaviour
    await test.step("C-10", async () => {
      // In-flight bound: the Host queues beyond the negotiated limit, so the Runtime never sees more than 32 requests at once,
      // and a Runtime that does not accept a request answers BUSY with retry-later.
      fault(gdir, { slowHealth: 0.3 });
      const burst = await ev(
        async (host, a) => {
          const connection = host.supervisor.connectionOf(a.id as string)!;
          const results = await Promise.all(
            Array.from({ length: 40 }, () =>
              connection
                .call("runtime.health")
                .then(() => "OK")
                .catch((e: { code: string }) => e.code),
            ),
          );
          return results;
        },
        { id: gid },
      );
      fault(gdir, {});
      expect(burst.every((c) => c === "OK")).toBe(true);
      const maxInFlight = Number(
        readFileSync(join(gdir, "graph-runtime", "max-in-flight.txt"), "utf8"),
      );
      expect(maxInFlight).toBeLessThanOrEqual(32);
      expect(maxInFlight).toBeGreaterThan(1);
      fault(gdir, { busy: "runtime.action.invoke" });
      const busy = await gact("text.roundtrip", "project:1", "roundtrip", {
        text: "busy",
      });
      fault(gdir, {});
      expect(busy.errorCode).toBe("BUSY");
      expect(busy.recovery).toBe("retry-later");
      const retried = await ev(
        (host, a) => host.resend(a.id as string, a.op as string),
        { id: gid, op: busy.operationId },
      );
      expect(retried.status).toBe("succeeded");
      // stderr flood: bounded diagnostics, the process stays healthy.
      await gact("stderr.flood", "project:1", "inject");
      await sleep(1500);
      const healthAfterFlood = await raw(gid, "runtime.health", {});
      expect(
        healthAfterFlood.ok && (healthAfterFlood.result as Json).health,
      ).toBe("ready");
      // Bidirectional wait: while the Runtime waits on a capture that makes the Host read it back slowly, health is still answered.
      fault(gdir, { slowRead: 1.0 });
      const waiting = gact("wait.capture", "candidate:1", "capture");
      await sleep(300);
      const healthWhileWaiting = await raw(gid, "runtime.health", {});
      const waitOp = await gwait((await waiting).operationId);
      fault(gdir, {});
      expect(
        healthWhileWaiting.ok && (healthWhileWaiting.result as Json).health,
      ).toBe("ready");
      expect(waitOp.status).toBe("succeeded");
      // Event window: with acknowledgements ignored the Runtime delivers at most 128 unacknowledged frames; a resync recovers the rest.
      await settle(gid);
      const seqBefore = Number((await scopeOf(gid)).cursor!.seq);
      fault(gdir, { ignoreAcks: true });
      await gact("inject.events", "project:1", "inject", {
        vector: "flood:150",
      });
      // The Runtime writes every frame the window lets through before it answers the invoke, and the
      // transcript records each frame as it arrives: delivery is read once the Host has applied the last
      // event frame of this subscription, not after a fixed pause.
      const transcript = await ev(
        (host, a) =>
          host.supervisor.connectionOf(a.id as string)!.spec.transcriptPath!,
        { id: gid },
      );
      const subscriptionId = (await scopeOf(gid)).subscriptionId;
      const lastDelivered = Math.max(
        ...readFileSync(transcript, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { direction: string; value: Json })
          .filter(
            (r) =>
              r.direction === "runtime-to-host" &&
              r.value.method === "runtime.event",
          )
          .map((r) => (r.value.params as { event: Json }).event)
          .filter(
            (e) =>
              e.subscriptionId === subscriptionId && typeof e.seq === "string",
          )
          .map((e) => Number(e.seq)),
      );
      const reached = await until(
        async () => await scopeOf(gid),
        (s) => Number(s.cursor!.seq) >= lastDelivered,
      );
      const delivered = Number(reached.cursor!.seq) - seqBefore;
      fault(gdir, {});
      expect(delivered).toBeLessThanOrEqual(128);
      expect(delivered).toBeGreaterThan(100);
      await ev((host, a) => host.sync(a.id as string, a.scope as string), {
        id: gid,
        scope: gscope,
      });
      const caught = await settle(gid);
      expect(Number(caught.cursor!.seq) - seqBefore).toBeGreaterThanOrEqual(
        150,
      );
      // Endless line: the Host closes only that connection; the list domain still answers.
      await gact("emit.badframe", "project:1", "inject", {
        kind: "never-newline",
      });
      await until(
        async () =>
          (await records()).runtimeInstances.find((i) => i.instanceId === gid)!,
        (i) => i.state === "exited",
      );
      const listHealth = await raw(lid, "runtime.health", {});
      expect(listHealth.ok && (listHealth.result as Json).health).toBe("ready");
      await ev((host, a) => host.supervisor.reconnect(a.id as string), {
        id: gid,
      });
      await until(
        async () => await scopeOf(gid),
        (s) => s.freshness === "current",
      );
      checks["C-10"] = {
        maxInFlight,
        busy: busy.errorCode,
        retried: retried.status,
        healthWhileWaiting: (healthWhileWaiting.result as Json)?.health,
        eventWindow: {
          delivered,
          after: Number(caught.cursor!.seq) - seqBefore,
        },
      };
    });

    // ---------------------------------------------------------------- C-11 controllers
    await test.step("C-11", async () => {
      const oldContext = await ev(
        (host, a) => host.supervisor.connectionOf(a.id as string)!.context,
        { id: gid },
      );
      // The process is lost; a second writer takes the domain lock before the Host's new incarnation, which is refused with WRITER_CONFLICT.
      const pid = (await records()).runtimeInstances.find(
        (i) => i.instanceId === gid,
      )!.pid!;
      process.kill(pid, "SIGKILL");
      await until(
        async () =>
          (await records()).runtimeInstances.find((i) => i.instanceId === gid)!,
        (i) => i.state === "exited",
      );
      const holder = spawn(
        f.python.launcher,
        ["-B", join(graphFakeDir, "graph_fake.py"), "hold-lock", gdir],
        { stdio: ["pipe", "pipe", "inherit"] },
      );
      await new Promise<void>((resolve) =>
        holder.stdout.once("data", () => resolve()),
      );
      await ev((host, a) => host.supervisor.reconnect(a.id as string), {
        id: gid,
      });
      const refused = await until(
        async () =>
          (await records()).runtimeInstances.find((i) => i.instanceId === gid)!,
        (i) => i.state === "failed",
      );
      expect(refused.failure?.code).toBe("WRITER_CONFLICT");
      holder.stdin.end();
      await new Promise<void>((resolve) =>
        holder.once("exit", () => resolve()),
      );
      await ev((host, a) => host.supervisor.reconnect(a.id as string), {
        id: gid,
      });
      const back = await until(
        async () => await scopeOf(gid),
        (s) => s.freshness === "current",
      );
      void back;
      // A late request of the old incarnation carries the old context: PERMISSION_DENIED, the generation moved on.
      const late = await raw(
        gid,
        "runtime.operation.get",
        { context: oldContext, scopeRef: gscope, operationId: "op:none" },
        { raw: true },
      );
      expect(late.ok ? "OK" : late.code).toBe("PERMISSION_DENIED");
      const newContext = await ev(
        (host, a) => host.supervisor.connectionOf(a.id as string)!.context,
        { id: gid },
      );
      expect(newContext!.controlGeneration).not.toBe(
        oldContext!.controlGeneration,
      );
      checks["C-11"] = {
        secondWriter: refused.failure?.code,
        late: late.ok ? null : late.code,
        generations: [
          oldContext!.controlGeneration,
          newContext!.controlGeneration,
        ],
      };
    });

    // ---------------------------------------------------------------- C-12 upgrade barrier on the list domain
    await test.step("C-12", async () => {
      const target = { bundleDigest: "b".repeat(64), dataFormat: "test.f2" };
      const blocked = await ev(
        (host, a) =>
          host.upgradePrepare(
            a.id as string,
            a.target as { bundleDigest: string; dataFormat: string },
          ),
        { id: lid, target },
      );
      expect(blocked.result.upgrade?.status).toBe("blocked");
      const blockedAgain = await ev(
        (host, a) => host.resend(a.id as string, a.op as string),
        { id: lid, op: blocked.operationId },
      );
      expect(
        (blockedAgain.result as Json).upgrade &&
          ((blockedAgain.result as Json).upgrade as Json).status,
      ).toBe("blocked");
      // Confirm every pending entry through the trusted entry, then prepare: prepared with a barrier that survives a restart.
      for (;;) {
        await settle(lid);
        const pending = (
          await ev(
            (host, a) => host.projection(a.id as string, a.scope as string),
            { id: lid, scope: listScope },
          )
        ).pendingItems.filter((i) => i.status === "pending");
        if (!pending.length) break;
        const decidedEntry = await ev(
          (host, a) =>
            host.decide(a.id as string, a.scope as string, {
              actionId: "entry.confirm",
              objectRef: a.objectRef as string,
              payload: { choice: "confirm" },
              evidence: [],
              actorRef: "actor:scenario",
            }),
          { id: lid, scope: listScope, objectRef: pending[0].objectRef },
        );
        expect(decidedEntry.operation.status).toBe("succeeded");
      }
      const prepared = await ev(
        (host, a) =>
          host.upgradePrepare(
            a.id as string,
            a.target as { bundleDigest: string; dataFormat: string },
          ),
        { id: lid, target },
      );
      expect(prepared.result.proceedable).toBe(true);
      const held = await codeOf(
        (host, a) =>
          host.invoke(a.id as string, a.scope as string, {
            actionId: "entry.create",
            objectRef: "directory:root",
            payload: { choice: "create" },
          }),
        { id: lid, scope: listScope },
      );
      expect(held).toBe("PRECONDITION_CONFLICT");
      const quiesced = await ev(
        (host, a) => host.quiesce(a.id as string, "upgrade prepared"),
        { id: lid },
      );
      expect(quiesced.status).toBe("succeeded");
      // Crash before activation: the persisted domain barrier still refuses a user action on the raw connection after the restart.
      const pid = (await records()).runtimeInstances.find(
        (i) => i.instanceId === lid,
      )!.pid!;
      process.kill(pid, "SIGKILL");
      await until(
        async () =>
          (await records()).runtimeInstances.find((i) => i.instanceId === lid)!,
        (i) => i.state === "exited",
      );
      await ev((host, a) => host.supervisor.reconnect(a.id as string), {
        id: lid,
      });
      await until(
        async () => await scopeOf(lid),
        (s) => s.freshness === "current",
      );
      const recovered = await ev(
        (host, a) => host.upgradeGet(a.id as string, a.op as string),
        { id: lid, op: prepared.operationId },
      );
      expect(recovered.result.upgrade?.status).toBe("prepared");
      const scopeAfter = await scopeOf(lid);
      const create = {
        operationId: "op:barrier-probe",
        idempotencyKey: "key:barrier-probe",
        scopeRef: listScope,
        actionId: "entry.create",
        objectRef: "directory:root",
        expectedRevision: (
          await ev(
            (host, a) => host.projection(a.id as string, a.scope as string),
            { id: lid, scope: listScope },
          )
        ).actions.find((x) => x.actionId === "entry.create")!.expectedRevision,
        candidateRef: null,
        grantRefs: scopeAfter.grantRefs,
        payload: { choice: "create", arguments: { title: "probe" } },
        decisionRef: null,
      };
      const barrierProbe = await raw(lid, "runtime.action.invoke", {
        ...create,
        requestDigest: digestOf({ method: "runtime.action.invoke", ...create }),
      });
      expect(barrierProbe.ok ? "OK" : barrierProbe.code).toBe(
        "PRECONDITION_CONFLICT",
      );
      // Release with the wrong identity is refused by the Runtime; the restored release reads back the released revision.
      const wrong = await raw(
        lid,
        "runtime.upgrade.release",
        (() => {
          const body = {
            operationId: "op:release-wrong",
            idempotencyKey: "key:release-wrong",
            prepareOperationId: prepared.operationId,
            barrierRef: recovered.result.upgrade!.barrierRef,
            disposition: "restored",
            runningBundleDigest: "c".repeat(64),
            dataFormat: "test.f1",
          };
          return {
            ...body,
            requestDigest: digestOf({
              method: "runtime.upgrade.release",
              ...body,
            }),
          };
        })(),
      );
      expect(wrong.ok ? "OK" : wrong.code).toBe("INTEGRITY_MISMATCH");
      const released = await ev(
        (host, a) =>
          host.upgradeRelease(a.id as string, a.op as string, "restored"),
        { id: lid, op: prepared.operationId },
      );
      expect(released.prepare.result.upgrade?.status).toBe("released");
      expect(released.prepare.result.upgrade?.releasedDomainRevision).toMatch(
        /^rev:/,
      );
      const after = await lact("entry.create", "directory:root", "create", {
        title: "after release",
        group: "inbox",
      });
      expect(after.status).toBe("succeeded");
      checks["C-12"] = {
        blocked: blocked.result.upgrade?.status,
        prepared: prepared.result.proceedable,
        barrierProbe: barrierProbe.ok ? null : barrierProbe.code,
        wrongRelease: wrong.ok ? null : wrong.code,
        released: released.prepare.result.upgrade?.status,
      };
    });

    // ---------------------------------------------------------------- C-13 unknown results
    await test.step("C-13", async () => {
      const nf = await raw(gid, "runtime.operation.get", {
        scopeRef: gscope,
        operationId: "op:never",
      });
      fault(gdir, { indexLost: true });
      const lost = await raw(gid, "runtime.operation.get", {
        scopeRef: gscope,
        operationId: "op:never",
      });
      fault(gdir, {});
      expect(nf.ok ? "OK" : nf.code).toBe("NOT_FOUND");
      expect(nf.ok ? null : nf.data?.absenceProven).toBe(true);
      expect(lost.ok ? "OK" : lost.code).toBe("RESULT_UNKNOWN");
      expect(lost.ok ? null : lost.data?.absenceProven).toBe(false);
      const old = await gact("text.roundtrip", "project:1", "roundtrip", {
        text: "to be retired",
      });
      await gact("ops.tombstone", "project:1", "tombstone", {
        operationId: old.operationId,
      });
      const retired = await ev(
        (host, a) =>
          host.operationGet(a.id as string, a.scope as string, a.op as string),
        { id: gid, scope: gscope, op: old.operationId },
      );
      expect(retired.error?.code).toBe("RESULT_UNKNOWN");
      expect(retired.operation?.status).toBe("succeeded");
      expect(retired.operation?.recovery).toBe("query");
      const sameKey = await ev(
        (host, a) => host.resend(a.id as string, a.op as string),
        { id: gid, op: old.operationId },
      );
      expect(sameKey.status).toBe("succeeded");
      expect(sameKey.reason).toMatch(/tombstone/);
      const other = {
        ...old.request!,
        payload: { choice: "roundtrip", arguments: { text: "other" } },
      };
      delete (other as Json).requestDigest;
      const otherPayload = await raw(gid, "runtime.action.invoke", {
        ...other,
        requestDigest: digestOf({ method: "runtime.action.invoke", ...other }),
      });
      expect(otherPayload.ok ? "OK" : otherPayload.code).toBe(
        "IDEMPOTENCY_CONFLICT",
      );
      // Permanent unknown: the observation channel is lost after init; the execution and the operation stay unknown, no new execution on retry.
      await port((p) => p.plan({ vector: "valid", observeLoss: true }));
      const unknown = await gact("execution.request", "project:1", "request");
      const unknownOp = await gwait(unknown.operationId);
      expect(unknownOp.status).toBe("unknown");
      const execCount = (await port((p) => p.executions.size)) as number;
      const retry = await ev(
        (host, a) => host.resend(a.id as string, a.op as string),
        { id: gid, op: unknown.operationId },
      );
      expect(retry.operationId).toBe(unknown.operationId);
      expect(retry.status).toBe("unknown");
      expect((await port((p) => p.executions.size)) as number).toBe(execCount);
      checks["C-13"] = {
        notFound: nf.ok ? null : nf.data?.absenceProven,
        indexLost: lost.ok ? null : lost.code,
        tombstone: retired.error?.code,
        sameKey: sameKey.status,
        otherPayload: otherPayload.ok ? null : otherPayload.code,
        unknownExecution: unknownOp.status,
      };
    });

    // ---------------------------------------------------------------- C-14 two domains on one Host
    await test.step("C-14", async () => {
      const created = await lact("entry.create", "directory:root", "create", {
        title: "second",
        group: "later",
      });
      await settle(lid);
      const projection = await ev(
        (host, a) => host.projection(a.id as string, a.scope as string),
        { id: lid, scope: listScope },
      );
      const entry = projection.objects
        .filter((o) => o.objectRef.startsWith("entry:"))
        .pop()!;
      const organized = await lact(
        "entry.organize",
        entry.objectRef,
        "organize",
        { group: "done" },
      );
      const illegalList = await lact(
        "entry.create",
        "directory:root",
        "execute-shell",
      );
      const illegalGraph = await codeOf(
        (host, a) =>
          host.invoke(a.id as string, a.scope as string, {
            actionId: "candidate.delete",
            objectRef: "candidate:1",
            payload: { choice: "delete" },
          }),
        { id: gid, scope: gscope },
      );
      expect(created.status).toBe("succeeded");
      expect(organized.status).toBe("succeeded");
      expect(illegalList.errorCode).toBe("PRECONDITION_CONFLICT");
      expect(illegalGraph).toBe("PRECONDITION_CONFLICT");
      // Both processes lost at once: each domain recovers into a current projection; the graph domain still knows nothing about op:none.
      for (const id of [gid, lid]) {
        const pid = (await records()).runtimeInstances.find(
          (i) => i.instanceId === id,
        )!.pid!;
        process.kill(pid, "SIGKILL");
      }
      for (const id of [gid, lid]) {
        await until(
          async () =>
            (await records()).runtimeInstances.find(
              (i) => i.instanceId === id,
            )!,
          (i) => i.state === "exited",
        );
        await ev((host, a) => host.supervisor.reconnect(a.id as string), {
          id,
        });
        await until(
          async () => await scopeOf(id),
          (s) => s.freshness === "current",
        );
      }
      const listOp = await ev(
        (host, a) =>
          host.operationGet(a.id as string, a.scope as string, a.op as string),
        { id: lid, scope: listScope, op: organized.operationId },
      );
      const graphNone = await raw(gid, "runtime.operation.get", {
        scopeRef: gscope,
        operationId: "op:none",
      });
      expect(listOp.operation?.status).toBe("succeeded");
      expect(graphNone.ok ? "OK" : graphNone.code).toBe("NOT_FOUND");
      const graphProjection = await ev(
        (host, a) => host.projection(a.id as string, a.scope as string),
        { id: gid, scope: gscope },
      );
      expect(
        graphProjection.objects.find((o) => o.objectRef === "candidate:1")!
          .stateLabel,
      ).toBe("accepted");
      checks["C-14"] = {
        list: {
          created: created.status,
          organized: organized.status,
          afterCrash: listOp.operation?.status,
        },
        illegalList: illegalList.errorCode,
        illegalGraph,
        graphCandidate: "accepted",
      };
    });

    // ---------------------------------------------------------------- C-15 r3 fields: stopped accounting equals the transcript, EXECUTION_FAILED
    await test.step("C-15", async () => {
      const stoppedRef = (await port(
        (p) =>
          [...p.executions.entries()].find(
            ([, e]) =>
              e.view.state === "stopped" && e.view.stopReason === "cancelled",
          )?.[0],
      )) as string | undefined;
      expect(stoppedRef).toBeTruthy();
      const stopped = (await port((p, a) => p.record(a.ref as string), {
        ref: stoppedRef!,
      }))!;
      // The Host's start operation followed the physical stop the domain observed through host.execution.get.
      const startRecord = (await records()).runtimeOperations.find(
        (o) =>
          o.method === "host.execution.start" && o.executionRef === stoppedRef,
      );
      expect(startRecord?.status).toBe("cancelled");
      const lines = readFileSync(stopped.transcript, "utf8")
        .split("\n")
        .filter(Boolean);
      const toolCalls = lines
        .map((l) => {
          try {
            return JSON.parse(l) as Json;
          } catch {
            return null;
          }
        })
        .filter((frame) => frame?.type === "assistant")
        .reduce(
          (n, frame) =>
            n +
            ((frame!.message as Json).content as Json[]).filter(
              (c) => c.type === "tool_use",
            ).length,
          0,
        );
      const bytes = statSync(stopped.transcript).size;
      const accounting = stopped.view.accounting as Json;
      expect(stopped.view.stopReason).toBe("cancelled");
      expect(accounting.outputBytes).toBe(bytes);
      expect(accounting.toolCalls).toBe(toolCalls);
      expect(accounting.waited).toBe(true);
      expect(accounting.pidGoneAfterExit).toBe(true);
      expect((stopped.view.actualBinding as Json).source).toBe("protocol-init");
      await port((p) => p.plan({ vector: "fail" }));
      const failed = await gact("execution.request", "project:1", "request");
      const failedOp = await gwait(failed.operationId);
      expect(failedOp.status).toBe("failed");
      const ref = {
        authority: "runtime",
        resourceHandle: gresource,
        scopeRef: gscope,
        objectRef: "execution-result:" + failed.operationId,
        revision: "rev:1",
        mediaType: "text/plain",
        bytes: 0,
        digest: sha256(""),
      };
      const failedRead = await raw(gid, "runtime.resource.read", {
        scopeRef: gscope,
        evidence: ref,
        grantRefs: [grants.read],
        offset: 0,
        length: 16,
      });
      expect(failedRead.ok ? "OK" : failedRead.code).toBe("EXECUTION_FAILED");
      const completedOp = (await records()).runtimeOperations.find(
        (o) => o.method === "host.execution.start" && o.status === "succeeded",
      )!;
      const domainOp = (completedOp.request as Json)
        .domainOperationId as string;
      const okText =
        ((graphState(gdir).executions as Record<string, Json>)[domainOp]
          ?.resultText as string) ?? "";
      const okRead = await raw(gid, "runtime.resource.read", {
        scopeRef: gscope,
        evidence: {
          ...ref,
          objectRef: "execution-result:" + domainOp,
          bytes: Buffer.byteLength(okText),
          digest: sha256(okText),
        },
        grantRefs: [grants.read],
        offset: 0,
        length: 4096,
      });
      expect(okRead.ok).toBe(true);
      expect(
        Buffer.from(
          (okRead.result as Json).dataBase64 as string,
          "base64",
        ).toString(),
      ).toBe(okText);
      checks["C-15"] = {
        stopReason: stopped.view.stopReason,
        accounting,
        transcriptBytes: bytes,
        failedRead: failedRead.ok ? null : failedRead.code,
      };
    });

    // ---------------------------------------------------------------- orderly quiesce and shutdown, then the coverage report
    const quiesced = await ev(
      (host, a) => host.quiesce(a.id as string, "end of scenarios"),
      { id: gid },
    );
    expect(quiesced.status).toBe("succeeded");
    writeFileSync(
      info.outputPath("scenario-checks.json"),
      JSON.stringify(checks, null, 2) + "\n",
    );
  } finally {
    await app.close();
  }
  // The coverage report runs on the transcripts the Host wrote; shutdown frames arrive with app.close().
  const reportPath = info.outputPath("host-coverage.json");
  let output = "";
  let exitCode = 0;
  try {
    output = execFileSync(
      process.execPath,
      [
        resolve("scripts/runtime-host-coverage.mjs"),
        "--transcripts",
        f.transcripts,
        "--out",
        reportPath,
      ],
      { encoding: "utf8" },
    );
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string };
    exitCode = e.status;
    output = (e.stdout ?? "") + (e.stderr ?? "");
  }
  // The transcripts themselves are evidence: one zip next to the report (raw evidence is archived outside the checkout).
  execFileSync("zip", [
    "-q",
    "-j",
    info.outputPath("transcripts.zip"),
    ...readdirSync(f.transcripts).map((name) => join(f.transcripts, name)),
  ]);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    passed: boolean;
    methods: { missing: string[] };
    codes: { missing: string[] };
    problems: string[];
    frames: { notifications: Record<string, number> };
  };
  expect(report.methods.missing, output).toEqual([]);
  expect(report.codes.missing, output).toEqual([]);
  expect(report.problems, output).toEqual([]);
  expect(report.frames.notifications["runtime.event"]).toBeGreaterThan(0);
  expect(report.passed).toBe(true);
  expect(exitCode).toBe(0);
});
