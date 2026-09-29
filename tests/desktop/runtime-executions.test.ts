import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, schemaVersion } from "../../src/service/store";
import {
  contractDigest,
  contractVersion,
  type RuntimeInstallation,
  type RuntimeInstance,
  type RuntimeOperation,
} from "../../src/shared/runtime-host";
import {
  physicalExecutionOf,
  validHostExecutionRecord,
  type HostExecutionRecord,
} from "../../src/shared/runtime-execution";
import { restorePreExecutionFixture } from "./legacy-codex-schema";

function open() {
  mkdirSync(".test-data/disposable", { recursive: true });
  return mkdtempSync(resolve(".test-data/disposable/runtime-executions-"));
}
const digest = "a".repeat(64);
const at = "2026-09-19T10:00:00Z";
function installation(): RuntimeInstallation {
  return {
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
    capabilities: [],
    executionProfileRequirements: [],
    launcher: { launcher: "/usr/bin/true", binaryDigest: digest, version: "1" },
    entrypoint: "graph_fake.py",
    argv: ["${instanceDir}", "${contractDigest}"],
    source: { kind: "offline-import", reference: "test" },
    incompatibility: null,
    checkedFiles: 4,
    expandedBytes: 100,
    importedAt: at,
  };
}
function instance(): RuntimeInstance {
  return {
    instanceId: "instance:one",
    installationId: "installation:one",
    createdAt: at,
    state: "ready",
    incarnationId: "incarnation:a",
    connectionId: "connection:a",
    controlGeneration: "1",
    pid: 4242,
    startedAt: at,
    launchArgv: ["/usr/bin/true"],
    exit: null,
    negotiation: null,
    failure: null,
    health: { result: "ok", reason: "", at },
    updatedAt: at,
  };
}
function record(
  overrides: Partial<HostExecutionRecord> = {},
): HostExecutionRecord {
  return {
    executionRef: "execution:one",
    scopeRef: "scope:project-1",
    state: "reserved",
    connectionRef: "connection:claude-1",
    configurationRevision: "3",
    model: "claude-synthetic",
    requestIdentity: {
      operationId: "op:exec:1",
      requestDigest: "b".repeat(64),
      profileDigest: "c".repeat(64),
    },
    supervisor: { pid: 100, startTime: at, image: "/Applications/App" },
    approvalDecisionRefs: [],
    actualBinding: null,
    stopReason: null,
    accounting: null,
    exit: null,
    observationCompleteness: "unknown",
    resultRef: null,
    reason: "reservation persisted",
    installationId: "installation:one",
    instanceId: "instance:one",
    operationId: "op:exec:1",
    portId: "embedded",
    profileId: "coding-implementer/claude-print-restricted",
    roleIntent: "role:implementer",
    domainNodeRef: "node:review",
    domainOperationId: "op:domain:1",
    resourceHandle: "resource:repo",
    targetBinding: { resourceHandle: "resource:repo", relativePath: "wt" },
    agent: "agent:claude-code",
    connectionId: null,
    executionId: "exec-row-1",
    target: null,
    children: [],
    unregisteredObservations: [],
    releasedAt: null,
    cancelRequestedAt: null,
    exitClassification: null,
    effort: null,
    budget: {
      maxToolCalls: 4,
      maxRunSeconds: 20,
      maxOutputBytes: 1048576,
      cleanupSeconds: 5,
    },
    stopUnconfirmed: null,
    blockedOperations: [],
    recordLocator: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}
function operation(status: RuntimeOperation["status"]): RuntimeOperation {
  return {
    operationId: "op:exec:1",
    installationId: "installation:one",
    instanceId: "instance:one",
    scopeRef: "scope:project-1",
    method: "host.execution.start",
    origin: "runtime",
    idempotencyKey: "intent:exec:1",
    requestDigest: "b".repeat(64),
    request: null,
    status,
    resultCode: null,
    reason: "",
    resultRef: null,
    executionRef: "execution:one",
    revision: "1",
    result: { portId: "embedded", state: "reserved" },
    transport: null,
    errorCode: null,
    recovery: null,
    createdAt: at,
    updatedAt: at,
  };
}
const target = {
  pid: 501,
  uid: 501,
  startSeconds: 1789817961,
  startMicros: 784497,
  path: "/usr/local/bin/claude",
  parent: 100,
  group: 501,
  session: 501,
  registeredAt: at,
};
function seeded() {
  const dir = open();
  const store = new Store(dir);
  for (const command of [
    { type: "runtimeInstall", installation: installation() },
    { type: "runtimeInstanceUpsert", instance: instance() },
  ]) {
    const reply = store.execute(command, "main", "host");
    assert.equal(reply.ok, true, JSON.stringify(reply));
  }
  return { dir, store };
}

test("schema 23 迁移：schema 22 数据库的执行、待处理与事件行原样保留，重开后 kind 约束接受 agent_execution 与 stop_unconfirmed，并留下 schema-22 备份", () => {
  const dir = open();
  const seed = new Store(dir);
  // Later schemas add project organization, interface preferences and the conversation order; the 22 → 23
  // execution migration still runs first.
  assert.equal(schemaVersion, 28);
  seed.close();
  const legacy = new DatabaseSync(join(dir, "state.sqlite"));
  restorePreExecutionFixture(legacy);
  legacy.exec(
    `INSERT INTO executions (id, turn_id, kind, connection_id, attempt, state, created_at) VALUES ('old-check', NULL, 'connection_test', NULL, 1, 'completed', '${at}');
     INSERT INTO run_events (id, execution_id, kind, at, snapshot, payload) VALUES ('ev-1', 'old-check', 'submitted', '${at}', NULL, '{}');
     INSERT INTO pending_items (id, execution_id, kind, state, created_at) VALUES ('pi-1', 'old-check', 'failed_turn', 'open', '${at}');`,
  );
  assert.throws(() =>
    legacy.exec(
      `INSERT INTO executions (id, turn_id, kind, connection_id, attempt, state, created_at) VALUES ('agent', NULL, 'agent_execution', NULL, 1, 'queued', '${at}')`,
    ),
  );
  assert.equal(
    (legacy.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    22,
  );
  legacy.close();
  const store = new Store(dir);
  try {
    assert.equal(
      (
        store.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
      schemaVersion,
    );
    assert.deepEqual(
      store.db
        .prepare("SELECT id, kind, state FROM executions ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      [{ id: "old-check", kind: "connection_test", state: "completed" }],
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM run_events").get()!.n,
      1,
    );
    assert.deepEqual(
      store.db
        .prepare("SELECT id, kind, state FROM pending_items")
        .all()
        .map((row) => ({ ...row })),
      [{ id: "pi-1", kind: "failed_turn", state: "open" }],
    );
    store.db.exec(
      `INSERT INTO executions (id, turn_id, kind, connection_id, attempt, state, created_at) VALUES ('agent', NULL, 'agent_execution', NULL, 1, 'queued', '${at}');
       INSERT INTO pending_items (id, execution_id, kind, state, created_at) VALUES ('pi-2', 'agent', 'stop_unconfirmed', 'open', '${at}');`,
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM runtime_executions").get()!.n,
      0,
    );
    assert.ok(
      readdirSync(resolve(dir, "..")).some((name) =>
        name.startsWith(basename(dir) + "-schema-22-backup-"),
      ),
    );
  } finally {
    store.close();
  }
});

test("执行记录：首次写入必须为预约态并建立业务执行行与已提交事件；放行、终态、停止未确认的事项与事件同一事务提交；快照与权威读取一致", () => {
  const { dir, store } = seeded();
  try {
    assert.equal(validHostExecutionRecord(record()), true);
    const direct = store.execute(
      {
        type: "runtimeExecutionUpsert",
        record: record({ state: "running", releasedAt: at }),
        operation: null,
        event: null,
        pending: null,
      },
      "main",
      "host",
    );
    assert.equal(direct.ok, false);
    assert.equal(!direct.ok && direct.code, "CONFLICT");
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM executions").get()!.n,
      0,
    );
    const reserved = store.execute(
      {
        type: "runtimeExecutionUpsert",
        record: record(),
        operation: operation("accepted"),
        event: {
          kind: "submitted",
          payload: { kind: "agent_execution", roleIntent: "role:implementer" },
        },
        pending: null,
      },
      "main",
      "host",
    );
    assert.equal(reserved.ok, true, JSON.stringify(reserved));
    if (!reserved.ok) return;
    assert.equal(reserved.snapshot.runtimeExecutions.length, 1);
    assert.equal(reserved.snapshot.runtimeExecutions[0].state, "reserved");
    assert.equal(
      reserved.snapshot.runtimeOperations.find(
        (o) => o.operationId === "op:exec:1",
      )?.status,
      "accepted",
    );
    const row = {
      ...(store.db
        .prepare("SELECT kind, state, connection_id FROM executions WHERE id=?")
        .get("exec-row-1") as { kind: string; state: string }),
    };
    assert.deepEqual(row, {
      kind: "agent_execution",
      state: "queued",
      connection_id: null,
    });
    const submitted = reserved.snapshot.events.find(
      (e) => e.executionId === "exec-row-1",
    )!;
    assert.equal(submitted.kind, "submitted");
    assert.equal(submitted.payload.executionRef, "execution:one");
    assert.equal(submitted.connection, null);
    // Same reservation again with another business row: the identity never moves.
    const moved = store.execute(
      {
        type: "runtimeExecutionUpsert",
        record: record({ executionId: "exec-row-2" }),
        operation: null,
        event: null,
        pending: null,
      },
      "main",
      "host",
    );
    assert.equal(!moved.ok && moved.code, "CONFLICT");
    // An operation of another instance is refused and nothing of the transition is written.
    const foreign = store.execute(
      {
        type: "runtimeExecutionUpsert",
        record: record({ state: "running", releasedAt: at, target }),
        operation: { ...operation("running"), instanceId: "instance:two" },
        event: { kind: "started", payload: {} },
        pending: null,
      },
      "main",
      "host",
    );
    assert.equal(!foreign.ok && foreign.code, "CONFLICT");
    assert.equal(
      store.execute(
        { type: "runtimeExecutionRead", executionRef: "execution:one" },
        "main",
        "host",
      ).ok &&
        (
          store.execute(
            { type: "runtimeExecutionRead", executionRef: "execution:one" },
            "main",
            "host",
          ) as { runtimeExecution?: HostExecutionRecord }
        ).runtimeExecution?.state,
      "reserved",
    );
    const running = store.execute(
      {
        type: "runtimeExecutionUpsert",
        record: record({
          state: "running",
          releasedAt: at,
          target,
          observationCompleteness: "complete",
        }),
        operation: operation("running"),
        event: { kind: "started", payload: { pid: 501 } },
        pending: null,
      },
      "main",
      "host",
    );
    assert.equal(running.ok, true, JSON.stringify(running));
    // Release cannot be undone.
    const unreleased = store.execute(
      {
        type: "runtimeExecutionUpsert",
        record: record({ state: "running", target }),
        operation: null,
        event: null,
        pending: null,
      },
      "main",
      "host",
    );
    assert.equal(!unreleased.ok && unreleased.code, "CONFLICT");
    const stopping = store.execute(
      {
        type: "runtimeExecutionUpsert",
        record: record({
          state: "stopping",
          releasedAt: at,
          cancelRequestedAt: at,
          target,
          exit: { code: null, signal: "SIGTERM", pipesClosed: true },
          accounting: {
            toolCalls: 1,
            runSeconds: 3,
            outputBytes: 120,
            waited: true,
            pidGoneAfterExit: true,
          },
          observationCompleteness: "partial",
          reason: "stop unconfirmed: 1 escaped descendant alive",
          stopUnconfirmed: {
            since: at,
            targetIdentity: { pid: 501, startTime: at, image: target.path },
            escaped: [
              {
                identity: { pid: 777, startTime: at, image: "/bin/sleep" },
                session: 777,
                kind: "registered",
              },
            ],
            checks: 0,
            lastCheckedAt: at,
            resolvedAt: null,
          },
          blockedOperations: [
            "release-resource",
            "switch-entry",
            "upgrade-extension",
            "update-application",
          ],
        }),
        operation: null,
        event: {
          kind: "stop_unconfirmed",
          payload: { escaped: [777], blocked: ["release-resource"] },
        },
        pending: "open",
      },
      "main",
      "host",
    );
    assert.equal(stopping.ok, true, JSON.stringify(stopping));
    if (!stopping.ok) return;
    const item = stopping.snapshot.pendingItems.find(
      (p) => p.kind === "stop_unconfirmed",
    )!;
    assert.ok(item);
    assert.equal(item.executionId, "exec-row-1");
    assert.equal(item.executionRef, "execution:one");
    assert.equal(item.turnId, null);
    assert.equal(
      stopping.snapshot.events.filter((e) => e.kind === "stop_unconfirmed")
        .length,
      1,
    );
    assert.equal(
      (
        store.db
          .prepare(
            "SELECT state, stop_requested_at AS s FROM executions WHERE id='exec-row-1'",
          )
          .get() as { state: string; s: string }
      ).state,
      "stopping",
    );
    // A second open is idempotent: still one open item.
    store.execute(
      {
        type: "runtimeExecutionUpsert",
        record: stopping.snapshot.runtimeExecutions[0],
        operation: null,
        event: null,
        pending: "open",
      },
      "main",
      "host",
    );
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM pending_items WHERE kind='stop_unconfirmed' AND state='open'",
        )
        .get()!.n,
      1,
    );
    const confirmed = store.execute(
      {
        type: "runtimeExecutionUpsert",
        record: record({
          ...stopping.snapshot.runtimeExecutions[0],
          state: "stopped",
          stopReason: "cancelled",
          reason: "stop confirmed: escaped descendants exited",
          stopUnconfirmed: {
            ...stopping.snapshot.runtimeExecutions[0].stopUnconfirmed!,
            resolvedAt: at,
          },
          blockedOperations: [],
        }),
        operation: { ...operation("cancelled"), revision: "3" },
        event: { kind: "stop_confirmed", payload: {} },
        pending: "resolve",
      },
      "main",
      "host",
    );
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    if (!confirmed.ok) return;
    assert.equal(
      confirmed.snapshot.pendingItems.some(
        (p) => p.kind === "stop_unconfirmed",
      ),
      false,
    );
    assert.equal(
      confirmed.snapshot.events.filter((e) => e.kind === "stop_confirmed")
        .length,
      1,
    );
    assert.equal(
      (
        store.db
          .prepare(
            "SELECT state, ended_at AS e FROM executions WHERE id='exec-row-1'",
          )
          .get() as { state: string; e: string | null }
      ).e,
      at,
    );
    // Terminal states are final.
    const reopened = store.execute(
      {
        type: "runtimeExecutionUpsert",
        record: record({
          ...confirmed.snapshot.runtimeExecutions[0],
          state: "running",
          stopReason: null,
        }),
        operation: null,
        event: null,
        pending: null,
      },
      "main",
      "host",
    );
    assert.equal(!reopened.ok && reopened.code, "CONFLICT");
    // The renderer can never write execution records.
    const fromRenderer = store.execute(
      {
        type: "runtimeExecutionUpsert",
        record: record({
          executionRef: "execution:two",
          executionId: "exec-row-9",
          operationId: "op:exec:9",
        }),
        operation: null,
        event: null,
        pending: null,
      },
      "main",
    );
    assert.equal(fromRenderer.ok, false);
    const list = store.execute(
      { type: "runtimeExecutionList", instanceId: "instance:one", open: true },
      "main",
      "host",
    );
    assert.equal(list.ok && list.runtimeExecutionList?.length, 0);
    const all = store.execute(
      { type: "runtimeExecutionList", instanceId: null, open: false },
      "main",
      "host",
    );
    assert.equal(all.ok && all.runtimeExecutionList?.length, 1);
    const unknown = store.execute(
      { type: "runtimeExecutionRead", executionRef: "execution:none" },
      "main",
      "host",
    );
    assert.equal(unknown.ok && unknown.runtimeExecution, null);
    const physical = physicalExecutionOf(
      confirmed.snapshot.runtimeExecutions[0],
    );
    assert.deepEqual(Object.keys(physical).length, 16);
    assert.equal(
      (physical as unknown as Record<string, unknown>).target,
      undefined,
    );
    store.close();
    const again = new Store(dir);
    assert.equal(again.snapshot().runtimeExecutions[0].state, "stopped");
    again.close();
  } finally {
    try {
      store.close();
    } catch {
      /* closed above */
    }
  }
});

test("执行记录的结构拒绝：字段缺失、stopped 无 stopReason、reserved 带核算、completed 无 exit、unknown 却 complete、未知实例均不写入", () => {
  const { store } = seeded();
  try {
    const attempts: [string, unknown][] = [
      [
        "missing field",
        (() => {
          const rest: Record<string, unknown> = { ...record() };
          delete rest.budget;
          return rest;
        })(),
      ],
      [
        "stopped without reason",
        record({
          state: "stopped",
          releasedAt: at,
          target,
          exit: { code: 143, signal: null, pipesClosed: true },
        }),
      ],
      [
        "reserved with accounting",
        record({
          accounting: {
            toolCalls: 0,
            runSeconds: 0,
            outputBytes: 0,
            waited: false,
            pidGoneAfterExit: false,
          },
        }),
      ],
      [
        "completed without exit",
        record({ state: "completed", releasedAt: at, target }),
      ],
      [
        "unknown complete",
        record({ state: "unknown", observationCompleteness: "complete" }),
      ],
      ["unknown instance", record({ instanceId: "instance:none" })],
    ];
    for (const [label, bad] of attempts) {
      const reply = store.execute(
        {
          type: "runtimeExecutionUpsert",
          record: bad,
          operation: null,
          event: null,
          pending: null,
        },
        "main",
        "host",
      );
      assert.equal(reply.ok, false, label);
    }
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM runtime_executions").get()!.n,
      0,
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM executions").get()!.n,
      0,
    );
  } finally {
    store.close();
  }
});

test("角色选择记录：需要已有实例与连接，可覆盖更新并按 (instance, scope, role) 读取；缺失读作 null", () => {
  const { store } = seeded();
  try {
    const missingConnection = store.execute(
      {
        type: "runtimeRoleBindingUpsert",
        binding: {
          instanceId: "instance:one",
          scopeRef: "scope:project-1",
          roleIntent: "role:implementer",
          connectionId: "conn-none",
          model: "m",
          effort: null,
          updatedAt: at,
        },
      },
      "main",
      "host",
    );
    assert.equal(!missingConnection.ok && missingConnection.code, "NOT_FOUND");
    const connectionId = randomUUID();
    const created = store.execute(
      {
        type: "upsertConnection",
        id: connectionId,
        name: "DeepSeek",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "claude-synthetic",
        secretRef: null,
        imageInput: "unknown",
        contextChars: null,
        revision: 0,
      },
      "main",
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    const saved = store.execute(
      {
        type: "runtimeRoleBindingUpsert",
        binding: {
          instanceId: "instance:one",
          scopeRef: "scope:project-1",
          roleIntent: "role:implementer",
          connectionId,
          model: "claude-synthetic",
          effort: "high",
          updatedAt: at,
        },
      },
      "main",
      "host",
    );
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const read = store.execute(
      {
        type: "runtimeRoleBindingRead",
        instanceId: "instance:one",
        scopeRef: "scope:project-1",
        roleIntent: "role:implementer",
      },
      "main",
      "host",
    );
    assert.equal(read.ok && read.runtimeRoleBinding?.effort, "high");
    const none = store.execute(
      {
        type: "runtimeRoleBindingRead",
        instanceId: "instance:one",
        scopeRef: "scope:project-1",
        roleIntent: "role:reviewer",
      },
      "main",
      "host",
    );
    assert.equal(none.ok && none.runtimeRoleBinding, null);
  } finally {
    store.close();
  }
});

test("重开数据库：业务服务的启动恢复只把回合类执行标为已中断，停止未确认的 Agent 执行行保持 stopping、不追加已中断事件、不建立回合中断事项，事项与事件在重开后保持", () => {
  const { dir, store } = seeded();
  const upsert = (command: Parameters<Store["execute"]>[0], label: string) => {
    const reply = store.execute(command, "main", "host");
    assert.equal(reply.ok, true, label + ": " + JSON.stringify(reply));
  };
  upsert(
    {
      type: "runtimeExecutionUpsert",
      record: record(),
      operation: operation("accepted"),
      event: { kind: "submitted", payload: {} },
      pending: null,
    },
    "reserved",
  );
  upsert(
    {
      type: "runtimeExecutionUpsert",
      record: record({ state: "running", releasedAt: at, target }),
      operation: operation("running"),
      event: { kind: "started", payload: {} },
      pending: null,
    },
    "running",
  );
  upsert(
    {
      type: "runtimeExecutionUpsert",
      record: record({
        state: "stopping",
        releasedAt: at,
        cancelRequestedAt: at,
        target,
        exit: { code: null, signal: "SIGTERM", pipesClosed: true },
        accounting: {
          toolCalls: 1,
          runSeconds: 3,
          outputBytes: 120,
          waited: true,
          pidGoneAfterExit: true,
        },
        observationCompleteness: "partial",
        reason: "stop unconfirmed: 1 escaped descendant alive",
        stopUnconfirmed: {
          since: at,
          targetIdentity: { pid: 501, startTime: at, image: target.path },
          escaped: [
            {
              identity: { pid: 777, startTime: at, image: "/bin/sleep" },
              session: 777,
              kind: "registered",
            },
          ],
          checks: 0,
          lastCheckedAt: at,
          resolvedAt: null,
        },
        blockedOperations: [
          "release-resource",
          "switch-entry",
          "upgrade-extension",
          "update-application",
        ],
      }),
      operation: null,
      event: { kind: "stop_unconfirmed", payload: { escaped: [777] } },
      pending: "open",
    },
    "stopping",
  );
  // A turn-type execution left open is the service's own to interrupt.
  store.db
    .prepare(
      "INSERT INTO executions (id, turn_id, kind, connection_id, attempt, state, created_at) VALUES ('open-check', NULL, 'connection_test', NULL, 1, 'running', ?)",
    )
    .run(at);
  store.close();
  const reopened = new Store(dir);
  try {
    const snapshot = reopened.snapshot();
    const agent = snapshot.runtimeExecutions.find(
      (r) => r.executionRef === "execution:one",
    )!;
    assert.equal(agent.state, "stopping");
    const rows = (
      reopened.db
        .prepare("SELECT id, state FROM executions ORDER BY id")
        .all() as { id: string; state: string }[]
    ).map((r) => ({ id: r.id, state: r.state }));
    assert.deepEqual(rows, [
      { id: "exec-row-1", state: "stopping" },
      { id: "open-check", state: "interrupted" },
    ]);
    const kinds = (executionId: string) =>
      snapshot.events
        .filter((e) => e.executionId === executionId)
        .map((e) => e.kind)
        .reverse();
    assert.deepEqual(kinds("exec-row-1"), [
      "submitted",
      "started",
      "stop_unconfirmed",
    ]);
    assert.deepEqual(kinds("open-check"), ["interrupted"]);
    // The check execution has no turn, so it gets no item (as before); the Host item is the only one.
    assert.deepEqual(
      snapshot.pendingItems.map((p) => [p.executionId, p.kind, p.state]),
      [["exec-row-1", "stop_unconfirmed", "open"]],
    );
  } finally {
    reopened.close();
  }
});
