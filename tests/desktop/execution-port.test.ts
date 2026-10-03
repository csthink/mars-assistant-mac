import { test } from "node:test";
import { assertExecutionView } from "./runtime-fakes/execution-schema";
import fs from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Store } from "../../src/service/store";
import { RuntimeHost } from "../../src/main/runtime-host";
import { RpcFailure } from "../../src/main/runtime-supervisor";
import { EmbeddedExecutionPort } from "../../src/main/execution-port";
import {
  FIXTURE_PROFILE as profile,
  FixtureAdapter,
} from "./runtime-fakes/fixture-adapter";
import {
  gitCommonDir,
  readExecutionRecords,
  recordSegment,
} from "../../src/main/execution-record";
import {
  ProcessObserver,
  registration,
} from "../../src/main/execution-process";
import {
  contractDigest,
  contractVersion,
  type RuntimeHostCommand,
  type RuntimeInstallation,
  type RuntimeInstance,
  type RuntimeOperation,
} from "../../src/shared/runtime-host";
import {
  physicalExecutionKeys,
  type HostExecutionRecord,
} from "../../src/shared/runtime-execution";
import { createClaudeFixture } from "./claude-fixture";
import { buildProcessHelper } from "./process-helper";

/**
 * The embedded port's release order, records and exit classification with the fixture
 * `claude` executable as the target and a test adapter in place of the Claude adapter
 * (S-02 supplies the real one). The Host is real (business Store in-process), so every
 * transition goes through the same runtimeExecutionUpsert the product uses.
 */
mkdirSync(".test-data/disposable", { recursive: true });
const digest = "a".repeat(64);
const installation: RuntimeInstallation = {
  installationId: "installation:one",
  runtimeId: "runtime:test-graph",
  version: "1",
  publisherId: "publisher:csthink-test",
  publicKeyDigest: digest,
  artifactDigest: digest,
  releaseRecordDigest: digest,
  manifestDigest: digest,
  permissionProfileDigest: digest,
  platform: "darwin-arm64",
  minimumOs: "26.6.2",
  dataFormat: "test.f1",
  protocols: [{ version: contractVersion, contractDigest }],
  capabilities: [
    {
      id: "csthink.test.graph",
      version: contractVersion,
      schemaDigest: digest,
      required: true,
    },
  ],
  executionProfileRequirements: [],
  launcher: { launcher: "/usr/bin/true", binaryDigest: digest, version: "1" },
  entrypoint: "graph_fake.py",
  argv: [],
  source: { kind: "offline-import", reference: "test" },
  incompatibility: null,
  checkedFiles: 4,
  expandedBytes: 100,
  importedAt: "2026-09-19T00:00:00Z",
};
const instance: RuntimeInstance = {
  instanceId: "instance:one",
  installationId: "installation:one",
  createdAt: "2026-09-19T00:00:00Z",
  state: "ready",
  incarnationId: "incarnation:a",
  connectionId: "connection:instance:one",
  controlGeneration: "1",
  pid: null,
  startedAt: null,
  launchArgv: [],
  exit: null,
  negotiation: null,
  failure: null,
  health: null,
  updatedAt: "2026-09-19T00:00:00Z",
};

function harness() {
  const dir = mkdtempSync(resolve(".test-data/disposable/execution-port-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const fixture = createClaudeFixture(join(dir, "fixture"));
  const helper = join(dir, "identity");
  buildProcessHelper(helper);
  mkdirSync(join(dir, "data"));
  const store = new Store(join(dir, "data"));
  // Query fault seams preserve the Store's terminal-state and revocation invariants.
  const query: {
    execution?: HostExecutionRecord | null;
    operation?: RuntimeOperation | null;
    unavailable: boolean;
    beforeRead: (() => void) | null;
  } = { unavailable: false, beforeRead: null };
  const host = new RuntimeHost({
    runtimeRoot: join(dir, "runtimes"),
    descriptor: {
      platform: "darwin-arm64",
      osVersion: "27.0",
      electronExecutable: process.execPath,
      pythonCandidates: [],
    },
    request: async (command: RuntimeHostCommand) => {
      if (
        ["runtimeExecutionRead", "runtimeOperationRead"].includes(command.type)
      ) {
        if (query.unavailable) throw new Error("simulated unavailable index");
        query.beforeRead?.();
      }
      const reply = store.execute(command, "main", "host");
      if (
        command.type === "runtimeExecutionRead" &&
        query.execution !== undefined
      )
        return { ...reply, runtimeExecution: query.execution };
      if (
        command.type === "runtimeOperationRead" &&
        query.operation !== undefined
      )
        return { ...reply, runtimeOperation: query.operation };
      return reply;
    },
    records: () => store.snapshot(),
  });
  const adapter = new FixtureAdapter(fixture.binary, join(dir, "home"));
  mkdirSync(join(dir, "home"));
  const seams: {
    beforeRelease: ((ref: string, pid: number) => Promise<void>) | null;
  } = { beforeRelease: null };
  const port = new EmbeddedExecutionPort({
    helper,
    adapters: [adapter],
    evidenceRoot: join(dir, "executions", "evidence"),
    recordFallbackRoot: join(dir, "executions", "records"),
    hostImage: process.execPath,
    beforeRelease: (ref, pid) =>
      seams.beforeRelease?.(ref, pid) ?? Promise.resolve(),
  });
  host.registerExecutionPort(port);
  store.execute({ type: "runtimeInstall", installation }, "main", "host");
  store.execute({ type: "runtimeInstanceUpsert", instance }, "main", "host");
  store.execute(
    {
      type: "runtimeResourceRegister",
      resource: {
        handle: "resource:repo",
        kind: "directory",
        path: repo,
        registeredAt: "2026-09-19T00:00:00Z",
      },
    },
    "main",
    "host",
  );
  store.execute(
    {
      type: "runtimeScopeUpsert",
      scope: {
        instanceId: "instance:one",
        installationId: "installation:one",
        scopeRef: "scope:a",
        bindingRef: "binding:a",
        resourceHandle: "resource:repo",
        state: "active",
        grantRefs: [],
        freshness: "current",
        cursor: null,
        revision: null,
        snapshotId: null,
        subscriptionId: null,
        lastError: null,
        updatedAt: "2026-09-19T00:00:00Z",
      },
    },
    "main",
    "host",
  );
  const connection = {
    context: {
      protocolVersion: contractVersion,
      contractDigest,
      controlGeneration: "1",
      installationId: "installation:one",
      instanceId: "instance:one",
      incarnationId: "incarnation:a",
      connectionId: "connection:instance:one",
    },
    call: async () => {
      throw new Error("unexpected call");
    },
  };
  type Inbound = (
    c: unknown,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  const inbound = (host as unknown as { inbound: Inbound }).inbound.bind(
    host,
  ) as Inbound;
  return {
    dir,
    repo,
    fixture,
    helper,
    store,
    host,
    port,
    adapter,
    connection,
    inbound,
    seams,
    query,
  };
}
async function grantOf(h: ReturnType<typeof harness>) {
  await h.port.refreshProfiles();
  return h.host.grant(
    "instance:one",
    "scope:a",
    "csthink.test.graph",
    "graph.execute",
    "test",
  );
}
function startRequest(
  grantRef: { id: string; revision: string },
  n: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    operationId: "op:exec-" + n,
    idempotencyKey: "key:exec-" + n,
    requestDigest: String(n).padStart(64, "0"),
    scopeRef: "scope:a",
    profileId: profile.id,
    profileDigest: profile.digest,
    domainOperationId: "op:domain-" + n,
    domainNodeRef: "node:implement",
    roleIntent: "implementer",
    resourceHandle: "resource:repo",
    targetBinding: { resourceHandle: "resource:repo", relativePath: "src" },
    connectionRef: "connection:x",
    configurationRevision: "1",
    model: "claude-synthetic",
    executionBinding: {
      profileDigest: profile.digest,
      agent: "agent:claude",
      model: "claude-synthetic",
      modelVendor: "vendor:anthropic",
      routeVendor: null,
      credentialRef: "credential:none",
      configurationRevision: "1",
    },
    constraints: [],
    decisionRef: null,
    grantRefs: [grantRef],
    contextRefs: [],
    budget: {
      maxToolCalls: 4,
      maxRunSeconds: 20,
      maxOutputBytes: 1048576,
      cleanupSeconds: 2,
    },
    ...overrides,
  };
}
async function until<T>(
  read: () => T | Promise<T>,
  ok: (value: T) => boolean,
  ms = 8000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - start > ms)
      throw new Error("timeout: " + JSON.stringify(value).slice(0, 300));
    await wait(50);
  }
}
const recordOf = (h: ReturnType<typeof harness>, ref: string) =>
  h.store.snapshot().runtimeExecutions.find((r) => r.executionRef === ref)!;

test("release order: the reservation, the exclusive record, the unreleased target, its pinned identity and the release are persisted in that order; the fixture completes and the record, business row, events, evidence and host.execution.get agree", async () => {
  const h = harness();
  try {
    const grant = await grantOf(h);
    const calls = () =>
      readFileSync(h.fixture.calls, "utf8").trim().split("\n").filter(Boolean);
    const accepted = await h.inbound(
      h.connection,
      "host.execution.start",
      startRequest(grant.ref, 1),
    );
    const ref = String(accepted.executionRef);
    assert.equal(accepted.status, "running", JSON.stringify(accepted));
    assert.match(ref, /^execution:/);
    const done = await until(
      () => recordOf(h, ref),
      (r) => r.state !== "running" && r.state !== "reserved",
    );
    assert.equal(done.state, "completed", JSON.stringify(done));
    assert.equal(done.exit?.code, 0);
    assert.equal(done.exit?.pipesClosed, true);
    assert.equal(done.accounting?.waited, true);
    assert.equal(done.accounting?.pidGoneAfterExit, true);
    assert.equal(done.exitClassification, "exited");
    assert.equal(done.observationCompleteness, "complete");
    assert.equal(done.actualBinding?.model, "claude-synthetic");
    assert.equal(done.actualBinding?.source, "protocol-init");
    assert.ok(
      done.target &&
        done.target.pid > 0 &&
        done.target.path === process.execPath,
    );
    assert.equal(done.target?.parent, process.pid);
    assert.equal(
      done.target?.session,
      done.target?.pid,
      "the target is its own session leader",
    );
    assert.ok(
      done.releasedAt && done.supervisor && done.supervisor.pid === process.pid,
    );
    assert.deepEqual(done.blockedOperations, []);
    // The fixture saw exactly one invocation and one user line: released once.
    const lines = calls().map((l) => JSON.parse(l));
    assert.equal(lines.filter((l) => l.args).length, 1);
    assert.equal(lines.filter((l) => l.type === "user").length, 1);
    // Shared observation record in the repository's Git common directory, seq 0..3 in order.
    const common = gitCommonDir(h.repo)!;
    const recordDir = join(
      common,
      "harness",
      "executions",
      recordSegment("op:exec-1"),
    );
    const shared = readExecutionRecords(recordDir);
    assert.deepEqual(shared.problems, []);
    assert.deepEqual(
      shared.records.map((r) => [
        r.seq,
        r.target === null,
        r.released,
        r.exit === null,
      ]),
      [
        ["0", true, false, true],
        ["1", false, false, true],
        ["2", false, true, true],
        ["3", false, true, false],
      ],
    );
    assert.equal(shared.records[3].executionId, ref);
    assert.equal(shared.records[3].target?.pid, done.target?.pid);
    assert.equal(shared.records[3].result?.digest, done.resultRef?.digest);
    assert.match(shared.records[0].bootId, /^boot:/);
    // Host evidence: the result document's digest is the resultRef digest.
    const evidenceDir = join(
      h.dir,
      "executions",
      "evidence",
      recordSegment(ref),
    );
    const result = readFileSync(join(evidenceDir, "result.json"));
    assert.equal(done.resultRef?.bytes, result.length);
    assert.equal(done.resultRef?.objectRef, "execution-result:" + ref);
    assert.ok(existsSync(join(evidenceDir, "transcript.ndjson")));
    // Business row, events and operation.
    const snapshot = h.store.snapshot();
    const events = snapshot.events
      .filter((e) => e.executionId === done.executionId)
      .map((e) => e.kind)
      .reverse();
    assert.deepEqual(events, ["submitted", "started", "completed"]);
    assert.equal(
      (
        h.store.db
          .prepare("SELECT kind, state FROM executions WHERE id=?")
          .get(done.executionId) as { kind: string; state: string }
      ).state,
      "completed",
    );
    const operation = snapshot.runtimeOperations.find(
      (o) => o.operationId === "op:exec-1",
    )!;
    assert.equal(operation.status, "succeeded");
    assert.equal(operation.executionRef, ref);
    const physical = await h.inbound(h.connection, "host.execution.get", {
      scopeRef: "scope:a",
      executionRef: ref,
    });
    assert.deepEqual(
      Object.keys(physical).sort(),
      [...physicalExecutionKeys].sort(),
    );
    assert.equal(physical.state, "completed");
    assertExecutionView({ context: h.connection.context, ...physical });
    const viaOperation = await h.inbound(h.connection, "host.operation.get", {
      scopeRef: "scope:a",
      operationId: "op:exec-1",
    });
    assert.equal(viaOperation.status, "succeeded");
    // A second start with the same key and digest answers the same operation; another digest conflicts.
    const again = await h.inbound(
      h.connection,
      "host.execution.start",
      startRequest(grant.ref, 1),
    );
    assert.equal(again.executionRef, ref);
    await assert.rejects(
      () =>
        h.inbound(
          h.connection,
          "host.execution.start",
          startRequest(grant.ref, 1, { requestDigest: "9".repeat(64) }),
        ),
      (error: unknown) =>
        error instanceof RpcFailure && error.code === "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(
      h.store.snapshot().runtimeExecutions.length,
      1,
      "no second physical execution",
    );
  } finally {
    await h.port.close();
    h.store.close();
  }
});

test("before release: a target that exits first is unknown and never released; a wrong image is refused and the process is ended; an existing record directory refuses the start without spawning", async () => {
  const h = harness();
  try {
    const grant = await grantOf(h);
    const calls = () =>
      readFileSync(h.fixture.calls, "utf8").trim().split("\n").filter(Boolean)
        .length;
    const userLines = () =>
      readFileSync(h.fixture.calls, "utf8")
        .trim()
        .split("\n")
        .filter((l) => l.includes('"type":"user"')).length;
    // Exit before release: the fixture prints its version and exits; the seam holds the release until the pid is gone.
    h.adapter.variant = { argv: ["--version"] };
    h.seams.beforeRelease = async (_ref, pid) => {
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          process.kill(pid, 0);
        } catch {
          return;
        }
        if (Date.now() > deadline) throw new Error("target still alive");
        await wait(20);
      }
    };
    const early = await h.inbound(
      h.connection,
      "host.execution.start",
      startRequest(grant.ref, 2),
    );
    h.seams.beforeRelease = null;
    const earlyRef = String(early.executionRef);
    assert.equal(early.status, "unknown");
    const earlyRecord = await until(
      () => recordOf(h, earlyRef),
      (r) => r.state !== "reserved" && r.state !== "running",
    );
    assert.equal(earlyRecord.state, "unknown", JSON.stringify(earlyRecord));
    assertExecutionView({
      context: h.connection.context,
      ...(await h.inbound(h.connection, "host.execution.get", {
        scopeRef: "scope:a",
        executionRef: earlyRef,
      })),
    });
    assert.equal(earlyRecord.releasedAt, null);
    assert.equal(earlyRecord.observationCompleteness, "partial");
    assert.ok(earlyRecord.target, "the identity was recorded before the exit");
    assert.equal(
      earlyRecord.exit,
      null,
      "no exit facts for an execution that never ran",
    );
    const common = gitCommonDir(h.repo)!;
    const earlyShared = readExecutionRecords(
      join(common, "harness", "executions", recordSegment("op:exec-2")),
    );
    assert.equal(
      earlyShared.records.every((r) => r.released === false),
      true,
    );
    assert.equal(
      h.store
        .snapshot()
        .events.filter((e) => e.executionId === earlyRecord.executionId)
        .map((e) => e.kind)
        .includes("interrupted"),
      true,
    );
    const op2 = h.store
      .snapshot()
      .runtimeOperations.find((o) => o.operationId === "op:exec-2")!;
    assert.equal(op2.status, "unknown");
    // Wrong expected image: identity check fails, nothing is released, the target is ended.
    h.adapter.variant = { expectedImage: "/usr/bin/true" };
    const before = userLines();
    const wrong = await h.inbound(
      h.connection,
      "host.execution.start",
      startRequest(grant.ref, 3),
    );
    const wrongRef = String(wrong.executionRef);
    const wrongRecord = await until(
      () => recordOf(h, wrongRef),
      (r) => r.state !== "reserved",
    );
    assert.equal(wrongRecord.state, "failed");
    assertExecutionView({
      context: h.connection.context,
      ...(await h.inbound(h.connection, "host.execution.get", {
        scopeRef: "scope:a",
        executionRef: wrongRef,
      })),
    });
    assert.equal(wrongRecord.releasedAt, null);
    assert.match(wrongRecord.reason, /identity check failed/);
    assert.equal(
      userLines(),
      before,
      "the fixture received no user line: nothing was released",
    );
    const wrongOp = h.store
      .snapshot()
      .runtimeOperations.find((o) => o.operationId === "op:exec-3")!;
    assert.equal(wrongOp.status, "failed");
    assert.equal(h.port.activeRefs().length, 0);
    // Existing record directory: another writer owns it; refused before any spawn.
    h.adapter.variant = {};
    mkdirSync(
      join(common, "harness", "executions", recordSegment("op:exec-4")),
      { recursive: true },
    );
    const beforeExisting = calls();
    const existing = await h.inbound(
      h.connection,
      "host.execution.start",
      startRequest(grant.ref, 4),
    );
    assert.equal(existing.status, "failed");
    assert.equal(existing.resultCode, "RECORD_EXISTS");
    assert.equal(calls(), beforeExisting);
    const existingRecord = recordOf(h, String(existing.executionRef));
    assert.equal(existingRecord.state, "failed");
    assert.equal(existingRecord.target, null);
  } finally {
    await h.port.close();
    h.store.close();
  }
});

test("restart recovery classifies persisted executions without re-running anything: unreleased becomes unknown; a released target still alive is not adopted and not signalled; a released target that exited with nothing left is unknown", async () => {
  const h = harness();
  const survivor = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    const grant = await grantOf(h);
    // Seed records through the Host's own reservation path, then rewrite them as a crashed Host would leave them.
    h.adapter.variant = { argv: ["--version"] };
    const seeded: string[] = [];
    for (const n of [5, 6, 7]) {
      const reply = await h.inbound(
        h.connection,
        "host.execution.start",
        startRequest(grant.ref, n),
      );
      seeded.push(String(reply.executionRef));
      // The seeds must have left the port entirely (terminal record, no live entry) before they are rewritten.
      await until(
        () => ({
          state: recordOf(h, String(reply.executionRef)).state,
          live: h.port.activeRefs().length,
        }),
        (v) =>
          ["unknown", "failed", "completed", "stopped"].includes(v.state) &&
          v.live === 0,
      );
    }
    const observer = new ProcessObserver(h.helper);
    const alive = registration(await observer.inspect(survivor.pid!), {
      uid: process.getuid!(),
    });
    // A target that has already exited: a real pid whose start time nobody will match again.
    const gone = spawn(process.execPath, ["-e", "setTimeout(()=>{},300)"], {
      stdio: "ignore",
    });
    const goneReg = registration(await observer.inspect(gone.pid!), {
      uid: process.getuid!(),
    });
    await once(gone, "exit");
    const rewrite = (ref: string, patch: Partial<HostExecutionRecord>) => {
      const current = recordOf(h, ref);
      const next = { ...current, ...patch };
      h.store.db
        .prepare(
          "UPDATE runtime_executions SET state=?, record=? WHERE execution_ref=?",
        )
        .run(next.state, JSON.stringify(next), ref);
    };
    rewrite(seeded[0], {
      state: "reserved",
      target: null,
      releasedAt: null,
      exit: null,
      accounting: null,
      actualBinding: null,
      observationCompleteness: "unknown",
      exitClassification: null,
      resultRef: null,
    });
    rewrite(seeded[1], {
      state: "running",
      target: { ...alive },
      releasedAt: "2026-09-19T00:00:00Z",
      exit: null,
      accounting: null,
      exitClassification: null,
      resultRef: null,
      observationCompleteness: "complete",
    });
    rewrite(seeded[2], {
      state: "running",
      target: goneReg,
      releasedAt: "2026-09-19T00:00:00Z",
      exit: null,
      accounting: null,
      exitClassification: null,
      resultRef: null,
      observationCompleteness: "complete",
    });
    const open = await h.host.executionList(null, true);
    assert.equal(open.length, 3);
    const outcomes = await h.port.recover(open, (record) =>
      h.host.executionContext(record),
    );
    assert.deepEqual(
      outcomes.map((o) => o.state),
      ["unknown", "unknown", "unknown"],
    );
    const after = h.store.snapshot().runtimeExecutions;
    assert.match(
      after.find((r) => r.executionRef === seeded[0])!.reason,
      /before the target was released/,
    );
    assert.match(
      after.find((r) => r.executionRef === seeded[1])!.reason,
      /not adopted/,
    );
    assert.match(
      after.find((r) => r.executionRef === seeded[2])!.reason,
      /cannot be read back/,
    );
    assert.doesNotThrow(
      () => process.kill(survivor.pid!, 0),
      "the live target was not signalled",
    );
    const events = h.store
      .snapshot()
      .events.filter((e) => e.kind === "interrupted");
    assert.ok(events.length >= 3);
    assert.equal((await h.host.executionList(null, true)).length, 0);
  } finally {
    try {
      survivor.kill("SIGKILL");
    } catch {
      /* gone */
    }
    await h.port.close();
    h.store.close();
  }
});

// ---------------------------------------------------------------- S-03: cancel, identity-guarded signals, reclaim, exit classification
const resultDocument = (h: ReturnType<typeof harness>, ref: string) =>
  JSON.parse(
    readFileSync(
      join(h.dir, "executions", "evidence", recordSegment(ref), "result.json"),
      "utf8",
    ),
  ) as {
    signals: {
      label: string;
      stage: string;
      pid: number;
      sent: boolean;
      reason: string;
      classification: string;
    }[];
  };
const eventKinds = (h: ReturnType<typeof harness>, executionId: string) =>
  h.store
    .snapshot()
    .events.filter((e) => e.executionId === executionId)
    .map((e) => e.kind)
    .reverse();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const fixtureCalls = (h: ReturnType<typeof harness>) =>
  readFileSync(h.fixture.calls, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
/** A fixture `claude` started outside the port in its own session: "another terminal's Agent", same uid and image. */
function spectator(h: ReturnType<typeof harness>) {
  const child = spawn(
    h.fixture.binary,
    [
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "text",
      "--model",
      "claude-synthetic",
      "--session-id",
      "spectator",
    ],
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      cwd: h.fixture.root,
      env: { PATH: "/usr/bin:/bin" },
    },
  );
  child.stdin!.end("spectator\n");
  child.unref();
  return child;
}
function cancelRequest(ref: string, n: number) {
  return {
    operationId: "op:cancel-" + n,
    idempotencyKey: "key:cancel-" + n,
    requestDigest: String(n).padStart(64, "c"),
    scopeRef: "scope:a",
    executionRef: ref,
  };
}

test("cancel: a hanging target is interrupted natively, then SIGTERM by identity; its same-session child is reclaimed after the exit; the record shows stopReason cancelled, the signaled classification and pidGoneAfterExit; a same-uid same-image process in another session is never signalled; a second cancel of the stopped execution answers the terminal state without rewriting it", async () => {
  const h = harness();
  h.fixture.update({ implementer: "hang", implementerChildren: 1 });
  // "Another terminal's Agent": the same fixture in the same state (it hangs with a child of its own), in its own session.
  const other = spectator(h);
  const childrenOf = (parent: number) =>
    fixtureCalls(h)
      .filter((c) => typeof c.child === "number" && c.parent === parent)
      .map((c) => c.child as number);
  try {
    const grant = await grantOf(h);
    h.adapter.variant = { print: true };
    const accepted = await h.inbound(
      h.connection,
      "host.execution.start",
      startRequest(grant.ref, 11),
    );
    const ref = String(accepted.executionRef);
    assert.equal(accepted.status, "running", JSON.stringify(accepted));
    const targetPid = recordOf(h, ref).target!.pid;
    // The child inside the target's session is registered by the periodic scan before the cancel.
    const childPid = (
      await until(
        () => childrenOf(targetPid),
        (c) => c.length === 1,
      )
    )[0];
    await until(
      () => recordOf(h, ref),
      (r) => !!r && r.children.some((c) => c.pid === childPid),
    );
    assert.ok(alive(other.pid!), "the spectator runs before the cancel");
    const cancelled = await h.inbound(
      h.connection,
      "host.execution.cancel",
      cancelRequest(ref, 1),
    );
    assert.equal(cancelled.status, "succeeded", JSON.stringify(cancelled));
    assert.match(String(cancelled.reason), /SIGTERM/);
    const done = await until(
      () => recordOf(h, ref),
      (r) => r.state !== "running" && r.state !== "stopping",
    );
    assert.equal(done.state, "stopped", JSON.stringify(done));
    assert.equal(done.stopReason, "cancelled");
    assert.ok(done.cancelRequestedAt);
    assert.equal(done.exit?.signal, "SIGTERM");
    assert.equal(done.exit?.code, null);
    assert.equal(done.exit?.pipesClosed, true);
    assert.equal(done.accounting?.waited, true);
    assert.equal(done.accounting?.pidGoneAfterExit, true);
    assert.equal(done.exitClassification, "signaled");
    assert.equal(done.observationCompleteness, "complete");
    assert.equal(done.stopUnconfirmed, null);
    assert.deepEqual(done.blockedOperations, []);
    assert.ok(
      done.children.some((c) => c.pid === childPid),
      "the same-session child was registered",
    );
    assert.equal(alive(childPid), false, "the child was reclaimed");
    assert.ok(alive(other.pid!), "the other terminal's process survived");
    const signals = resultDocument(h, ref).signals;
    assert.deepEqual(
      signals.map((s) => [
        s.stage,
        s.pid === done.target!.pid
          ? "target"
          : s.pid === childPid
            ? "child"
            : "other",
        s.sent,
      ]),
      [
        ["TERM", "target", true],
        ["TERM", "child", true],
      ],
    );
    assert.ok(signals.every((s) => s.pid !== other.pid));
    assert.deepEqual(eventKinds(h, done.executionId), [
      "submitted",
      "started",
      "stop_requested",
      "stopped",
    ]);
    const snapshot = h.store.snapshot();
    assert.equal(
      snapshot.runtimeOperations.find((o) => o.operationId === "op:exec-11")
        ?.status,
      "cancelled",
    );
    assert.equal(
      snapshot.runtimeOperations.find((o) => o.operationId === "op:cancel-1")
        ?.status,
      "succeeded",
    );
    assert.equal(
      (
        h.store.db
          .prepare("SELECT state FROM executions WHERE id=?")
          .get(done.executionId) as { state: string }
      ).state,
      "stopped",
    );
    const physical = await h.inbound(h.connection, "host.execution.get", {
      scopeRef: "scope:a",
      executionRef: ref,
    });
    assert.equal(physical.state, "stopped");
    assert.equal(physical.stopReason, "cancelled");
    // Idempotent: the same cancel answers the same operation; a new cancel of the stopped execution reports the terminal state and changes nothing.
    const again = await h.inbound(
      h.connection,
      "host.execution.cancel",
      cancelRequest(ref, 1),
    );
    assert.equal(again.operationId, "op:cancel-1");
    const late = await h.inbound(
      h.connection,
      "host.execution.cancel",
      cancelRequest(ref, 2),
    );
    assert.equal(late.status, "succeeded");
    assert.match(String(late.reason), /already stopped/);
    assert.deepEqual(recordOf(h, ref), done, "the record was not rewritten");
    assert.deepEqual(eventKinds(h, done.executionId), [
      "submitted",
      "started",
      "stop_requested",
      "stopped",
    ]);
  } finally {
    for (const pid of [other.pid!, ...childrenOf(other.pid!)])
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    await h.port.close();
    h.store.close();
  }
});

test("cancel: when the target's exit is handled before the helper's SIGTERM reply, the cancel still answers SIGTERM sent by identity (how signal), not an exit on the interrupt", async () => {
  const h = harness();
  // The helper sends SIGTERM by identity and answers; its "term" reply reaches the port 50 ms
  // later, so the target's exit (the hanging fixture ends on SIGTERM at once) is handled first.
  const real = h.helper + ".real";
  renameSync(h.helper, real);
  const delayed = h.helper + ".delayed";
  writeFileSync(
    delayed,
    "#!/bin/sh\n" +
      `out=$('${real}' "$@")\n` +
      "code=$?\n" +
      '[ "$1" = term ] && /bin/sleep 0.05\n' +
      "printf '%s\\n' \"$out\"\n" +
      "exit $code\n",
    { mode: 0o755 },
  );
  renameSync(delayed, h.helper);
  // The port's own answer carries how the stop began; the Host's reply forwards only its reason.
  const answers: { how?: unknown }[] = [];
  const cancel = h.port.cancel.bind(h.port);
  h.port.cancel = async (executionRef, operationId) => {
    const answer = await cancel(executionRef, operationId);
    answers.push(answer as { how?: unknown });
    return answer;
  };
  h.fixture.update({ implementer: "hang" });
  try {
    const grant = await grantOf(h);
    h.adapter.variant = { print: true };
    const accepted = await h.inbound(
      h.connection,
      "host.execution.start",
      startRequest(grant.ref, 16),
    );
    const ref = String(accepted.executionRef);
    assert.equal(accepted.status, "running", JSON.stringify(accepted));
    const cancelled = await h.inbound(
      h.connection,
      "host.execution.cancel",
      cancelRequest(ref, 7),
    );
    assert.equal(cancelled.status, "succeeded", JSON.stringify(cancelled));
    assert.match(
      String(cancelled.reason),
      /^cancel persisted; SIGTERM sent by identity to pid \d+$/,
    );
    assert.deepEqual(
      answers.map((a) => a.how),
      ["signal"],
    );
    const done = await until(
      () => recordOf(h, ref),
      (r) => r.state !== "running" && r.state !== "stopping",
    );
    assert.equal(done.state, "stopped", JSON.stringify(done));
    assert.equal(done.stopReason, "cancelled");
    assert.equal(done.exit?.signal, "SIGTERM");
    assert.deepEqual(
      resultDocument(h, ref).signals.map((s) => [s.stage, s.sent]),
      [["TERM", true]],
    );
  } finally {
    await h.port.close();
    h.store.close();
  }
});

test("cancel: a target that ignores SIGTERM is SIGKILLed after the cleanup budget; meanwhile host.execution.get reports stopping with the cancel time; a target that completed first answers the cancel as completed and is not rewritten", async () => {
  const h = harness();
  try {
    const grant = await grantOf(h);
    h.adapter.variant = { print: true };
    h.fixture.update({ implementer: "ignoreTerm" });
    const accepted = await h.inbound(
      h.connection,
      "host.execution.start",
      startRequest(grant.ref, 12),
    );
    const ref = String(accepted.executionRef);
    assert.equal(accepted.status, "running", JSON.stringify(accepted));
    const targetPid = recordOf(h, ref).target!.pid;
    await until(
      () =>
        fixtureCalls(h).some(
          (c) => c.ignoringTerm === true && c.pid === targetPid,
        ),
      (v) => v,
    );
    const before = Date.now();
    const cancelled = await h.inbound(
      h.connection,
      "host.execution.cancel",
      cancelRequest(ref, 3),
    );
    assert.equal(cancelled.status, "succeeded", JSON.stringify(cancelled));
    // The cancel answers once the stop is under way, not after the exit: the physical state is stopping.
    const stopping = recordOf(h, ref);
    assert.equal(stopping.state, "stopping", JSON.stringify(stopping));
    assert.ok(stopping.cancelRequestedAt);
    assert.equal(stopping.stopUnconfirmed, null);
    const physical = await h.inbound(h.connection, "host.execution.get", {
      scopeRef: "scope:a",
      executionRef: ref,
    });
    assert.equal(physical.state, "stopping");
    const done = await until(
      () => recordOf(h, ref),
      (r) => r.state !== "running" && r.state !== "stopping",
      15_000,
    );
    assert.ok(
      Date.now() - before >= 2000,
      "the KILL waited for the cleanup budget (2 s)",
    );
    assert.equal(done.state, "stopped", JSON.stringify(done));
    assert.equal(done.stopReason, "cancelled");
    assert.equal(done.exit?.signal, "SIGKILL");
    assert.equal(done.exitClassification, "signaled");
    assert.equal(done.accounting?.pidGoneAfterExit, true);
    assert.equal(done.observationCompleteness, "complete");
    assert.ok(
      fixtureCalls(h).some(
        (c) => c.ignoredSignal === "SIGTERM" && c.pid === targetPid,
      ),
      "the target saw and ignored SIGTERM",
    );
    assert.deepEqual(
      resultDocument(h, ref).signals.map((s) => [s.stage, s.sent]),
      [
        ["TERM", true],
        ["KILL", true],
      ],
    );
    // Completed first: the cancel does not rewrite the completed execution.
    h.fixture.update({ implementer: "normal" });
    const completed = await h.inbound(
      h.connection,
      "host.execution.start",
      startRequest(grant.ref, 13),
    );
    const completedRef = String(completed.executionRef);
    const finished = await until(
      () => recordOf(h, completedRef),
      (r) => r.state !== "running" && r.state !== "reserved",
    );
    assert.equal(finished.state, "completed", JSON.stringify(finished));
    const late = await h.inbound(
      h.connection,
      "host.execution.cancel",
      cancelRequest(completedRef, 4),
    );
    assert.equal(late.status, "succeeded");
    assert.match(String(late.reason), /already completed/);
    assert.deepEqual(recordOf(h, completedRef), finished);
    assert.equal(recordOf(h, completedRef).cancelRequestedAt, null);
    assert.deepEqual(eventKinds(h, finished.executionId), [
      "submitted",
      "started",
      "completed",
    ]);
    assert.equal(
      h.store
        .snapshot()
        .runtimeOperations.find((o) => o.operationId === "op:exec-13")?.status,
      "succeeded",
    );
  } finally {
    await h.port.close();
    h.store.close();
  }
});

test("cancel: a descendant that escaped into its own session is never signalled and makes the stop unconfirmed (stopping, the escaped identity, the four blocked operations); a lost observer after the exit is recorded as observer-lost and unknown, never as an exit", async () => {
  const h = harness();
  let escapedPid = 0;
  let hangingPid = 0;
  try {
    const grant = await grantOf(h);
    h.adapter.variant = { print: true };
    h.fixture.update({ implementer: "hang", implementerEscaped: 1 });
    const accepted = await h.inbound(
      h.connection,
      "host.execution.start",
      startRequest(grant.ref, 14),
    );
    const ref = String(accepted.executionRef);
    assert.equal(accepted.status, "running", JSON.stringify(accepted));
    const targetPid = recordOf(h, ref).target!.pid;
    escapedPid = (await until(
      () =>
        fixtureCalls(h).find(
          (c) => typeof c.escaped === "number" && c.parent === targetPid,
        ) ?? null,
      (c) => c !== null,
    ))!.escaped as number;
    await until(
      () => recordOf(h, ref),
      (r) => !!r && r.children.some((c) => c.pid === escapedPid),
    );
    const cancelled = await h.inbound(
      h.connection,
      "host.execution.cancel",
      cancelRequest(ref, 5),
    );
    assert.equal(cancelled.status, "succeeded", JSON.stringify(cancelled));
    const unconfirmed = await until(
      () => recordOf(h, ref),
      (r) => r.exit !== null,
    );
    assert.equal(unconfirmed.state, "stopping", JSON.stringify(unconfirmed));
    assert.equal(unconfirmed.stopReason, null);
    assert.equal(unconfirmed.exitClassification, "children-remaining");
    assert.equal(unconfirmed.observationCompleteness, "partial");
    assert.equal(unconfirmed.accounting?.pidGoneAfterExit, true);
    assert.deepEqual(
      unconfirmed.stopUnconfirmed?.escaped.map((e) => [
        e.identity.pid,
        e.kind,
        e.session === escapedPid,
      ]),
      [[escapedPid, "registered", true]],
    );
    assert.deepEqual(unconfirmed.blockedOperations, [
      "release-resource",
      "switch-entry",
      "upgrade-extension",
      "update-application",
    ]);
    assert.ok(alive(escapedPid), "the escaped process was not signalled");
    assert.ok(
      resultDocument(h, ref).signals.every((s) => s.pid !== escapedPid),
      "no signal row names the escaped process",
    );
    assert.deepEqual(eventKinds(h, unconfirmed.executionId), [
      "submitted",
      "started",
      "stop_requested",
      "stop_unconfirmed",
    ]);
    assert.equal(
      h.store
        .snapshot()
        .pendingItems.filter(
          (p) => p.kind === "stop_unconfirmed" && p.state === "open",
        ).length,
      1,
    );
    // A stopping-unconfirmed execution still owns the domain slot. Rejection is before acceptance.
    await assert.rejects(
      h.inbound(
        h.connection,
        "host.execution.start",
        startRequest(grant.ref, 15),
      ),
      /容量已满/,
    );
    assert.equal(h.store.snapshot().runtimeExecutions.length, 1);
    // This fixture owns the escaped process. Its actual exit, observed by the production watcher,
    // releases the slot; a request can only be accepted after that confirmation.
    process.kill(escapedPid, "SIGKILL");
    await until(
      () => recordOf(h, ref),
      (r) => r.state === "stopped",
      10_000,
    );
    escapedPid = 0;
    assert.equal(openStopItems(h).length, 0);
    // Observer lost: the helper stops answering after the target was released; the exit that follows cannot be confirmed.
    h.fixture.update({ implementer: "hang", implementerEscaped: 0 });
    const second = await h.inbound(
      h.connection,
      "host.execution.start",
      startRequest(grant.ref, 15),
    );
    const secondRef = String(second.executionRef);
    assert.equal(second.status, "running", JSON.stringify(second));
    hangingPid = recordOf(h, secondRef).target!.pid;
    const broken = h.helper + ".broken";
    writeFileSync(broken, "#!/bin/sh\nsleep 3\n", { mode: 0o755 });
    renameSync(broken, h.helper);
    const lost = await h.inbound(
      h.connection,
      "host.execution.cancel",
      cancelRequest(secondRef, 6),
    );
    assert.equal(lost.status, "unknown", JSON.stringify(lost));
    const unknown = await until(
      () => recordOf(h, secondRef),
      (r) => r.state !== "running" && r.state !== "stopping",
      20_000,
    );
    assert.equal(unknown.state, "unknown", JSON.stringify(unknown));
    assert.equal(unknown.exitClassification, "observer-lost");
    assert.equal(unknown.observationCompleteness, "partial");
    assert.equal(unknown.stopReason, null);
    assert.ok(
      alive(hangingPid),
      "nothing was signalled without an observation",
    );
    assert.ok(
      unknown.reason.includes("observer"),
      "the reason names the lost observer: " + unknown.reason,
    );
    assert.equal(h.port.activeRefs().length, 0);
  } finally {
    for (const pid of [escapedPid, hangingPid])
      try {
        if (pid) process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    await h.port.close();
    h.store.close();
  }
});

// ---------------------------------------------------------------- S-04: stop unconfirmed, automatic release, recheck, PID reuse, restart
/** Starts a hanging target with one escaped descendant, cancels it and returns the stop-unconfirmed record. */
async function stopUnconfirmedOf(
  h: ReturnType<typeof harness>,
  n: number,
  escapedSeconds: number,
) {
  const grant = await grantOf(h);
  h.adapter.variant = { print: true };
  h.fixture.update({
    implementer: "hang",
    implementerEscaped: 1,
    implementerEscapedSeconds: escapedSeconds,
  });
  const accepted = await h.inbound(
    h.connection,
    "host.execution.start",
    startRequest(grant.ref, n),
  );
  const ref = String(accepted.executionRef);
  assert.equal(accepted.status, "running", JSON.stringify(accepted));
  const targetPid = recordOf(h, ref).target!.pid;
  const escapedPid = (await until(
    () =>
      fixtureCalls(h).find(
        (c) => typeof c.escaped === "number" && c.parent === targetPid,
      ) ?? null,
    (c) => c !== null,
  ))!.escaped as number;
  await until(
    () => recordOf(h, ref),
    (r) => !!r && r.children.some((c) => c.pid === escapedPid),
  );
  const cancelled = await h.inbound(
    h.connection,
    "host.execution.cancel",
    cancelRequest(ref, n),
  );
  assert.equal(cancelled.status, "succeeded", JSON.stringify(cancelled));
  const unconfirmed = await until(
    () => recordOf(h, ref),
    (r) => r.exit !== null,
  );
  assert.equal(unconfirmed.state, "stopping", JSON.stringify(unconfirmed));
  assert.ok(unconfirmed.stopUnconfirmed, "the stop is unconfirmed");
  return { ref, targetPid, escapedPid, grant, record: unconfirmed };
}
const openStopItems = (h: ReturnType<typeof harness>) =>
  h.store
    .snapshot()
    .pendingItems.filter(
      (p) => p.kind === "stop_unconfirmed" && p.state === "open",
    );
const pendingRows = (h: ReturnType<typeof harness>, executionId: string) =>
  h.store.db
    .prepare(
      "SELECT kind, state, resolved_at AS resolvedAt FROM pending_items WHERE execution_id=? ORDER BY rowid",
    )
    .all(executionId) as {
    kind: string;
    state: string;
    resolvedAt: string | null;
  }[];

test("stop unconfirmed: the escaped process's own exit releases the stop with no click (stopped, stopReason cancelled, stop_confirmed appended, the pending item resolved, blocked operations cleared) and no 已停止 event is written in between; an explicit recheck counts while the periodic ones do not; the item refuses retry and dismiss because it is not a decision", async () => {
  const h = harness();
  let escapedPid = 0;
  try {
    const started = await stopUnconfirmedOf(h, 20, 7);
    escapedPid = started.escapedPid;
    const { ref, record } = started;
    assert.equal(record.stopUnconfirmed!.checks, 0);
    assert.equal(record.stopUnconfirmed!.resolvedAt, null);
    assert.equal(openStopItems(h).length, 1);
    assert.ok(
      !eventKinds(h, record.executionId).includes("stopped"),
      "no 已停止 while the stop is unconfirmed",
    );
    // An explicit recheck (the pending item's action) is one more observation and counts.
    const explicit = await h.port.recheck(ref, h.host.executionContext(record));
    assert.equal(explicit?.state, "stopping");
    assert.equal(explicit?.stopUnconfirmed?.checks, 1);
    assert.ok(
      alive(escapedPid),
      "the recheck never signals the escaped process",
    );
    // The Host's own periodic observations advance lastCheckedAt but not the explicit count.
    const before = recordOf(h, ref).stopUnconfirmed!.lastCheckedAt;
    const periodic = await until(
      () => recordOf(h, ref),
      (r) => r.stopUnconfirmed!.lastCheckedAt !== before,
      5000,
    );
    assert.equal(periodic.stopUnconfirmed!.checks, 1);
    assert.equal(periodic.state, "stopping");
    // Not a decision: the business resolve command refuses both actions and the item stays open.
    const item = openStopItems(h)[0];
    for (const action of ["retry", "dismiss"] as const) {
      const reply = h.store.execute(
        { type: "resolvePending", id: item.id, action },
        "main",
        "renderer",
      );
      assert.equal(reply.ok, false, action + " must be refused");
      assert.match(
        (reply as { message: string }).message,
        /停止未确认|自动解除/,
        "the refusal explains that the item resolves by itself",
      );
    }
    assert.equal(openStopItems(h).length, 1);
    // The escaped process exits on its own; the Host observes it and releases without any further call.
    const confirmed = await until(
      () => recordOf(h, ref),
      (r) => r.state !== "stopping",
      20_000,
    );
    assert.equal(confirmed.state, "stopped", JSON.stringify(confirmed));
    assert.equal(confirmed.stopReason, "cancelled");
    assert.equal(confirmed.observationCompleteness, "complete");
    assert.deepEqual(confirmed.blockedOperations, []);
    assert.equal(confirmed.stopUnconfirmed!.checks, 1);
    assert.ok(confirmed.stopUnconfirmed!.resolvedAt, "resolvedAt is set");
    assert.ok(!alive(escapedPid), "the escaped process is gone by itself");
    assert.deepEqual(eventKinds(h, confirmed.executionId), [
      "submitted",
      "started",
      "stop_requested",
      "stop_unconfirmed",
      "stop_confirmed",
    ]);
    const confirmedEvent = h.store
      .snapshot()
      .events.find(
        (e) =>
          e.executionId === confirmed.executionId &&
          e.kind === "stop_confirmed",
      )!;
    assert.equal(confirmedEvent.payload.checks, 1);
    assert.equal(confirmedEvent.payload.escaped, 1);
    assert.equal(openStopItems(h).length, 0);
    assert.deepEqual(
      pendingRows(h, confirmed.executionId).map((r) => [r.kind, r.state]),
      [["stop_unconfirmed", "resolved"]],
    );
    assert.ok(pendingRows(h, confirmed.executionId)[0].resolvedAt);
    // The business row follows: stopped, ended.
    const row = h.store.db
      .prepare("SELECT state, ended_at AS endedAt FROM executions WHERE id=?")
      .get(confirmed.executionId) as { state: string; endedAt: string | null };
    assert.equal(row.state, "stopped");
    assert.ok(row.endedAt);
    // host.execution.get after the release: stopped with the reason, no longer partial.
    const got = await h.inbound(h.connection, "host.execution.get", {
      scopeRef: "scope:a",
      executionRef: ref,
    });
    assert.equal(got.state, "stopped");
    assert.equal(got.stopReason, "cancelled");
  } finally {
    try {
      if (escapedPid) process.kill(escapedPid, "SIGKILL");
    } catch {
      /* gone */
    }
    await h.port.close();
    h.store.close();
  }
});

test("stop unconfirmed: an escaped pid whose registered identity no longer matches (PID reuse) counts as exited and releases the stop; the live process that now owns the pid is never signalled", async () => {
  const h = harness();
  let escapedPid = 0;
  try {
    const started = await stopUnconfirmedOf(h, 21, 60);
    escapedPid = started.escapedPid;
    const { ref, record } = started;
    // As if the pid had been reused: the registered identity (start time) differs from what the observer sees now.
    const child = record.children.find((c) => c.pid === escapedPid)!;
    const reused: HostExecutionRecord = {
      ...record,
      children: record.children.map((c) =>
        c.pid === escapedPid
          ? { ...c, startSeconds: c.startSeconds - 7200 }
          : c,
      ),
    };
    h.store.db
      .prepare("UPDATE runtime_executions SET record=? WHERE execution_ref=?")
      .run(JSON.stringify(reused), ref);
    assert.notEqual(child.startSeconds, reused.children[0].startSeconds);
    const confirmed = await until(
      () => recordOf(h, ref),
      (r) => r.state !== "stopping",
      8000,
    );
    assert.equal(confirmed.state, "stopped", JSON.stringify(confirmed));
    assert.equal(confirmed.stopReason, "cancelled");
    assert.deepEqual(confirmed.blockedOperations, []);
    assert.ok(
      alive(escapedPid),
      "the process that owns the pid now was not signalled",
    );
    assert.ok(
      resultDocument(h, ref).signals.every((s) => s.pid !== escapedPid),
      "no signal row names the pid",
    );
    assert.deepEqual(eventKinds(h, confirmed.executionId).slice(-2), [
      "stop_unconfirmed",
      "stop_confirmed",
    ]);
    assert.equal(openStopItems(h).length, 0);
  } finally {
    try {
      if (escapedPid) process.kill(escapedPid, "SIGKILL");
    } catch {
      /* gone */
    }
    await h.port.close();
    h.store.close();
  }
});

test("stop unconfirmed survives a restart: a new port resumes watching the persisted record without a new event, the item stays open, and the escaped process's later exit is confirmed by the new port; a running record whose target is gone but whose registered descendant lives on outside the session becomes stop unconfirmed on recovery", async () => {
  const h = harness();
  let escapedPid = 0;
  const survivor = spawn("/bin/sleep", ["60"], {
    detached: true,
    stdio: "ignore",
  });
  survivor.unref();
  let successor: EmbeddedExecutionPort | null = null;
  try {
    // Build the historical record while capacity is free, then recreate the crashed state below.
    h.adapter.variant = { argv: ["--version"] };
    const seeded = await h.inbound(
      h.connection,
      "host.execution.start",
      startRequest((await grantOf(h)).ref, 23),
    );
    const seededRef = String(seeded.executionRef);
    await until(
      () => ({
        state: recordOf(h, seededRef).state,
        live: h.port.activeRefs().length,
      }),
      (v) =>
        ["unknown", "failed", "completed", "stopped"].includes(v.state) &&
        v.live === 0,
    );
    const started = await stopUnconfirmedOf(h, 22, 12);
    escapedPid = started.escapedPid;
    const { ref, record } = started;
    // The application quits: the port stops watching; the record and the item stay.
    await h.port.close();
    const eventsBefore = eventKinds(h, record.executionId);
    assert.deepEqual(eventsBefore.at(-1), "stop_unconfirmed");
    assert.equal(openStopItems(h).length, 1);
    // A crashed Host's running record: the target is gone, its registered descendant (own session) lives.
    const observer = new ProcessObserver(h.helper);
    const escapedReg = registration(await observer.inspect(survivor.pid!), {
      uid: process.getuid!(),
    });
    const gone = spawn(process.execPath, ["-e", "setTimeout(()=>{},200)"], {
      stdio: "ignore",
    });
    const goneReg = registration(await observer.inspect(gone.pid!), {
      uid: process.getuid!(),
    });
    await once(gone, "exit");
    const current = recordOf(h, seededRef);
    const crashed: HostExecutionRecord = {
      ...current,
      state: "running",
      target: goneReg,
      children: [escapedReg],
      releasedAt: "2026-09-19T00:00:00Z",
      exit: null,
      accounting: null,
      exitClassification: null,
      resultRef: null,
      observationCompleteness: "complete",
    };
    h.store.db
      .prepare(
        "UPDATE runtime_executions SET state=?, record=? WHERE execution_ref=?",
      )
      .run("running", JSON.stringify(crashed), seededRef);
    // The next start of the application: a fresh port recovers from the records.
    successor = new EmbeddedExecutionPort({
      helper: h.helper,
      adapters: [h.adapter],
      evidenceRoot: join(h.dir, "executions", "evidence"),
      recordFallbackRoot: join(h.dir, "executions", "records"),
      hostImage: process.execPath,
    });
    const open = await h.host.executionList(null, true);
    const outcomes = await successor.recover(open, (r) =>
      h.host.executionContext(r),
    );
    assert.deepEqual(
      outcomes.map((o) => [o.executionRef, o.state]).sort(),
      [
        [ref, "stopping"],
        [seededRef, "stopping"],
      ].sort(),
    );
    // The resumed record: unchanged, no new event, item still open, watching continues.
    const resumed = recordOf(h, ref);
    assert.equal(resumed.state, "stopping");
    assert.deepEqual(eventKinds(h, resumed.executionId), eventsBefore);
    assert.equal(openStopItems(h).length, 2);
    // The recovered crash: stop unconfirmed with the escaped identity, an event with recovery: true and an open item.
    const recovered = recordOf(h, seededRef);
    assert.equal(recovered.state, "stopping");
    assert.deepEqual(
      recovered.stopUnconfirmed?.escaped.map((e) => [e.identity.pid, e.kind]),
      [[survivor.pid!, "registered"]],
    );
    assert.deepEqual(recovered.blockedOperations, [
      "release-resource",
      "switch-entry",
      "upgrade-extension",
      "update-application",
    ]);
    assert.equal(
      eventKinds(h, recovered.executionId).at(-1),
      "stop_unconfirmed",
    );
    assert.ok(
      alive(survivor.pid!),
      "the escaped descendant was not signalled on recovery",
    );
    // The first execution's escaped process exits on its own; the successor confirms it.
    const confirmed = await until(
      () => recordOf(h, ref),
      (r) => r.state !== "stopping",
      25_000,
    );
    assert.equal(confirmed.state, "stopped", JSON.stringify(confirmed));
    assert.equal(confirmed.stopReason, "cancelled");
    assert.equal(eventKinds(h, confirmed.executionId).at(-1), "stop_confirmed");
    assert.equal(openStopItems(h).length, 1);
    assert.equal(recordOf(h, seededRef).state, "stopping");
  } finally {
    for (const pid of [escapedPid, survivor.pid!])
      try {
        if (pid) process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    await successor?.close();
    await h.port.close();
    h.store.close();
  }
});

/** KB-245: the Runtime consumes fixed Host bytes through the real Host and port. */
async function completedResult(h: ReturnType<typeof harness>, n = 90) {
  const grant = await grantOf(h);
  const accepted = await h.inbound(
    h.connection,
    "host.execution.start",
    startRequest(grant.ref, n),
  );
  const record = await until(
    () => recordOf(h, String(accepted.executionRef)),
    (r) => r.state === "completed",
  );
  assert.ok(record.resultRef);
  const file = join(
    h.dir,
    "executions",
    "evidence",
    recordSegment(record.executionRef),
    "result.json",
  );
  const bytes = readFileSync(file);
  const read = (overrides: Record<string, unknown> = {}) =>
    h.inbound(h.connection, "host.resource.read", {
      scopeRef: "scope:a",
      evidence: record.resultRef,
      grantRefs: [grant.ref],
      offset: 0,
      length: 65536,
      ...overrides,
    });
  const refuse = async (
    code: string,
    overrides: Record<string, unknown> = {},
    absenceProven = false,
  ) => {
    await assert.rejects(
      () => read(overrides),
      (error: unknown) => {
        assert.ok(error instanceof RpcFailure);
        assert.equal(error.code, code, error.message);
        assert.equal(error.absenceProven, absenceProven);
        assert.ok(!error.message.includes(h.dir), "never expose a host path");
        return true;
      },
    );
  };
  return { grant, record, file, bytes, read, refuse };
}

test("KB-245 result bytes: complete immutable chunks, distinct executions sharing a resource, authoritative lookup and restart without rediscovery or replay", async () => {
  const h = harness();
  try {
    const a = await completedResult(h);
    const b = await completedResult(h, 91);
    assert.equal(
      a.record.resultRef!.resourceHandle,
      b.record.resultRef!.resourceHandle,
    );
    assert.notEqual(
      a.record.resultRef!.objectRef,
      b.record.resultRef!.objectRef,
    );
    const before = readFileSync(h.fixture.calls);
    // Display snapshots intentionally omit both executions and their operations.
    const records = h.host.records.bind(h.host);
    h.host.records = () => ({
      ...records()!,
      runtimeExecutions: [],
      runtimeOperations: [],
    });
    for (const item of [a, b]) {
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < item.bytes.length; offset += 127) {
        const chunk = await item.read({ offset, length: 127 });
        const bytes = Buffer.from(chunk.dataBase64 as string, "base64");
        assert.deepEqual(
          Object.keys(chunk).sort(),
          [
            "resourceHandle",
            "revision",
            "offset",
            "dataBase64",
            "eof",
            "digest",
          ].sort(),
        );
        assert.equal(chunk.resourceHandle, item.record.resourceHandle);
        assert.equal(chunk.revision, item.record.resultRef!.revision);
        assert.equal(chunk.digest, item.record.resultRef!.digest);
        assert.equal(chunk.offset, offset);
        assert.equal(chunk.eof, offset + bytes.length === item.bytes.length);
        assert.equal(bytes.length, Math.min(127, item.bytes.length - offset));
        chunks.push(bytes);
      }
      assert.deepEqual(Buffer.concat(chunks), item.bytes);
      assert.equal(
        item.bytes.at(-1),
        10,
        "original trailing newline is preserved",
      );
      const end = await item.read({ offset: item.bytes.length });
      assert.equal(end.dataBase64, "");
      assert.equal(end.eof, true);
    }
    // Multi-byte text and a file spanning multiple hashing buffers are returned byte-for-byte.
    const large = Buffer.from(
      JSON.stringify({
        ...JSON.parse(a.bytes.toString("utf8")),
        evidence: { answer: "汉🙂".repeat(15000) },
      }) + "\n",
    );
    const largeRef = {
      ...a.record.resultRef!,
      bytes: large.length,
      digest: createHash("sha256").update(large).digest("hex"),
    };
    const operation = h.store
      .snapshot()
      .runtimeOperations.find((o) => o.operationId === a.record.operationId)!;
    h.query.execution = { ...a.record, resultRef: largeRef };
    h.query.operation = { ...operation, resultRef: largeRef };
    writeFileSync(a.file, large);
    const largeChunks: Buffer[] = [];
    for (let offset = 0; offset < large.length; offset += 65536) {
      const chunk = await a.read({ evidence: largeRef, offset, length: 65536 });
      largeChunks.push(Buffer.from(chunk.dataBase64 as string, "base64"));
    }
    assert.deepEqual(Buffer.concat(largeChunks), large);
    delete h.query.execution;
    delete h.query.operation;
    writeFileSync(a.file, a.bytes);
    await h.port.close();
    const reopened = new EmbeddedExecutionPort({
      helper: h.helper,
      adapters: [],
      evidenceRoot: join(h.dir, "executions", "evidence"),
      recordFallbackRoot: join(h.dir, "executions", "records"),
      hostImage: process.execPath,
    });
    h.host.registerExecutionPort(reopened);
    try {
      for (const item of [a, b]) {
        assert.equal(await reopened.get(item.record.executionRef), null);
        const view = await h.inbound(h.connection, "host.execution.get", {
          scopeRef: "scope:a",
          executionRef: item.record.executionRef,
        });
        assertExecutionView({ context: h.connection.context, ...view });
        assert.equal(view.state, "completed");
        assert.deepEqual(view.resultRef, item.record.resultRef);
        assert.deepEqual(view.requestIdentity, item.record.requestIdentity);
      }
      assert.deepEqual(
        Buffer.from((await a.read()).dataBase64 as string, "base64"),
        a.bytes,
      );
      assert.deepEqual(
        Buffer.from((await b.read()).dataBase64 as string, "base64"),
        b.bytes,
      );
      assert.deepEqual(
        readFileSync(h.fixture.calls),
        before,
        "read does not discover, start or replay a target",
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await h.port.close();
    h.store.close();
  }
});

test("KB-245 authorization and identity: every chunk rechecks scope, installation, full evidence, current grants and valid offsets before disclosure", async () => {
  const h = harness();
  try {
    const a = await completedResult(h);
    const ref = a.record.resultRef!;
    for (const patch of [
      { revision: "2" },
      { mediaType: "text/plain" },
      { digest: "0".repeat(64) },
      { bytes: ref.bytes + 1 },
    ])
      await a.refuse("PRECONDITION_CONFLICT", {
        evidence: { ...ref, ...patch },
      });
    await a.refuse("PERMISSION_DENIED", {
      evidence: { ...ref, authority: "runtime" },
    });
    await a.refuse("PERMISSION_DENIED", {
      evidence: { ...ref, resourceHandle: "resource:other" },
    });
    await a.refuse("PERMISSION_DENIED", {
      evidence: { ...ref, scopeRef: "scope:other" },
    });
    await a.refuse("PERMISSION_DENIED", {
      scopeRef: "scope:other",
      evidence: { ...ref, scopeRef: "scope:other" },
    });
    for (const offset of [-1, 0.5, ref.bytes + 1])
      await a.refuse("PRECONDITION_CONFLICT", { offset });
    for (const length of [0, 0.5, 262145])
      await a.refuse("PRECONDITION_CONFLICT", { length });
    await a.refuse("PERMISSION_DENIED", { grantRefs: [] });
    await a.refuse("PERMISSION_REVOKED", {
      grantRefs: [{ ...a.grant.ref, revision: "99" }],
    });
    await a.refuse(
      "NOT_FOUND",
      { evidence: { ...ref, objectRef: "execution-result:execution:absent" } },
      true,
    );
    const records = h.host.records.bind(h.host);
    const putGrant = (patch: Partial<typeof a.grant>) => {
      h.host.records = () => ({
        ...records()!,
        runtimeGrants: records()!.runtimeGrants.map((g) =>
          g.ref.id === a.grant.ref.id ? { ...a.grant, ...patch } : g,
        ),
      });
    };
    for (const patch of [
      { expiresAt: "2000-01-01T00:00:00Z" },
      { status: "revoked" as const },
    ]) {
      await a.read({ length: 1 });
      putGrant(patch);
      await a.refuse("PERMISSION_REVOKED", { offset: 1 });
      await a.refuse("PERMISSION_REVOKED", {
        evidence: { ...ref, objectRef: "execution-result:execution:absent" },
      });
      putGrant({});
    }
    h.host.records = () => ({
      ...records()!,
      runtimeScopes: records()!.runtimeScopes.map((s) => ({
        ...s,
        state: "inactive" as const,
      })),
    });
    await a.refuse("PERMISSION_DENIED");
    await a.refuse("PERMISSION_DENIED", {
      evidence: { ...ref, objectRef: "execution-result:execution:absent" },
    });
    h.host.records = () => ({
      ...records()!,
      runtimeInstances: [{ ...instance, installationId: "installation:other" }],
    });
    await a.refuse("PERMISSION_DENIED");
    h.host.records = records;
    // A revoke while the authoritative query is awaited is enforced before any byte or absence answer.
    h.query.beforeRead = () => putGrant({ status: "revoked" });
    await a.refuse("PERMISSION_REVOKED");
    h.query.beforeRead = null;
    h.host.records = records;
    await a.read();
  } finally {
    await h.port.close();
    h.store.close();
  }
});

test("KB-245 refusals: original execution state, unavailable indexes and storage, changed bytes and symlink substitution never produce successful result chunks", async () => {
  const h = harness();
  try {
    const a = await completedResult(h);
    const operation = h.store
      .snapshot()
      .runtimeOperations.find((o) => o.operationId === a.record.operationId)!;
    const set = (
      patch: Partial<HostExecutionRecord>,
      opPatch: Partial<typeof operation> = {},
    ) => {
      h.query.execution = { ...a.record, ...patch };
      h.query.operation = { ...operation, ...opPatch };
    };
    for (const state of [
      "queued",
      "reserved",
      "running",
      "stopping",
      "unknown",
    ] as const) {
      set(
        {
          state,
          stopReason: state === "stopping" ? "cancelled" : null,
          actualBinding: null,
          accounting: null,
          exit: null,
          observationCompleteness: "partial",
          cancelRequestedAt:
            state === "stopping" ? new Date().toISOString() : null,
        },
        { status: state === "unknown" ? "unknown" : "running" },
      );
      await a.refuse("RESULT_UNKNOWN");
    }
    set(
      { state: "stopped", stopReason: "cancelled", resultRef: null },
      { status: "cancelled", resultRef: null },
    );
    await a.refuse("CANCELLED");
    set(
      { state: "failed", resultRef: null },
      { status: "failed", resultRef: null },
    );
    await a.refuse("EXECUTION_FAILED");
    set({ resultRef: null });
    await a.refuse("RESULT_UNKNOWN");
    set({}, { resultRef: { ...a.record.resultRef!, revision: "2" } });
    await a.refuse("RESULT_UNKNOWN");
    set({ portId: "missing" });
    await a.refuse("RESULT_UNKNOWN");
    set({ instanceId: "instance:other" });
    await a.refuse("PERMISSION_DENIED");
    set({});
    h.query.operation = null;
    await a.refuse("RESULT_UNKNOWN");
    h.query.operation = operation;
    h.query.unavailable = true;
    await a.refuse("RESULT_UNKNOWN");
    h.query.unavailable = false;
    // Exchange the parent directory between lstat and open, then restore its inode.
    // O_NOFOLLOW_ANY must prevent the actual open, not merely detect a changed final path.
    const outside = join(h.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "result.json"), a.bytes);
    const parent = join(a.file, "..");
    const originalOpen = fs.openSync;
    let intercepted = 0,
      openedOutside = false;
    fs.openSync = (path, flags, mode) => {
      if (path !== a.file) return originalOpen(path, flags, mode);
      intercepted++;
      renameSync(parent, parent + ".race");
      symlinkSync(outside, parent);
      try {
        const fd = originalOpen(path, flags, mode);
        openedOutside = true;
        return fd;
      } finally {
        rmSync(parent);
        renameSync(parent + ".race", parent);
      }
    };
    try {
      await a.refuse("INTEGRITY_MISMATCH");
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(intercepted, 1);
    assert.equal(openedOutside, false);
    // Missing physical bytes cannot prove that an accepted execution never existed.
    renameSync(a.file, a.file + ".saved");
    await a.refuse("RESULT_UNKNOWN");
    symlinkSync(a.file + ".saved", a.file);
    await a.refuse("INTEGRITY_MISMATCH");
    rmSync(a.file);
    renameSync(a.file + ".saved", a.file);
    for (const bytes of [
      a.bytes.subarray(1),
      Buffer.concat([a.bytes, Buffer.from("x")]),
      Buffer.from(a.bytes),
    ]) {
      if (bytes.length === a.bytes.length) bytes[0] ^= 1;
      writeFileSync(a.file, bytes);
      await a.refuse("INTEGRITY_MISMATCH");
    }
    writeFileSync(a.file, a.bytes);
    const dir = join(a.file, "..");
    renameSync(dir, dir + ".saved");
    symlinkSync(dir + ".saved", dir);
    await a.refuse("INTEGRITY_MISMATCH");
    rmSync(dir);
    renameSync(dir + ".saved", dir);
    await a.read({ length: 1 });
    const modified = Buffer.from(a.bytes);
    modified[modified.length - 1] ^= 1;
    writeFileSync(a.file, modified);
    await a.refuse("INTEGRITY_MISMATCH", { offset: 1, length: 1 });
    writeFileSync(a.file, a.bytes);
    await a.read();
  } finally {
    await h.port.close();
    h.store.close();
  }
});

test("KB-247 execution query: active running and stopping views obey the frozen schema, preserve request identity and never disclose internal fields; terminal fallback stays identical", async () => {
  const h = harness();
  h.fixture.update({ implementer: "ignoreTerm" });
  h.adapter.variant = { print: true };
  try {
    const grant = await grantOf(h);
    const accepted = await h.inbound(
      h.connection,
      "host.execution.start",
      startRequest(grant.ref, 71),
    );
    const ref = String(accepted.executionRef);
    const get = () =>
      h.inbound(h.connection, "host.execution.get", {
        scopeRef: "scope:a",
        executionRef: ref,
      });
    const running = await get();
    assert.equal(running.state, "running");
    assertExecutionView({ context: h.connection.context, ...running });
    assert.deepEqual(await h.port.get(ref), running);
    assert.ok(
      recordOf(h, ref).target,
      "the private process identity is still persisted",
    );
    await assert.rejects(
      () =>
        h.inbound(h.connection, "host.execution.get", {
          scopeRef: "scope:other",
          executionRef: ref,
        }),
      (e: unknown) => e instanceof RpcFailure && e.code === "PERMISSION_DENIED",
    );
    await assert.rejects(
      () =>
        h.inbound(h.connection, "host.execution.get", {
          scopeRef: "scope:a",
          executionRef: "execution:missing",
        }),
      (e: unknown) => e instanceof RpcFailure && e.code === "NOT_FOUND",
    );
    await until(
      () => fixtureCalls(h),
      (calls) => calls.some((c) => c.ignoringTerm === true),
    );
    const cancelling = h.inbound(
      h.connection,
      "host.execution.cancel",
      cancelRequest(ref, 71),
    );
    const stopping = await until(get, (r) => r.state === "stopping");
    assertExecutionView({ context: h.connection.context, ...stopping });
    assert.deepEqual(stopping.requestIdentity, running.requestIdentity);
    assert.equal(
      running.state,
      "running",
      "the returned view is independent of later transitions",
    );
    await cancelling;
    await until(
      () => h.port.get(ref),
      (r) => r === null,
    );
    const stopped = await get();
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.stopReason, "cancelled");
    assertExecutionView({ context: h.connection.context, ...stopped });
    assert.deepEqual(stopped.requestIdentity, running.requestIdentity);
    assert.deepEqual(Object.keys(stopped).sort(), Object.keys(running).sort());
  } finally {
    await h.port.close();
    h.store.close();
  }
});
