import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { Store, schemaVersion } from "../../src/service/store";
import {
  contractDigest,
  contractVersion,
  extensionState,
  type RuntimeInstallation,
  type RuntimeInstance,
} from "../../src/shared/runtime-host";

function open() {
  mkdirSync(".test-data/disposable", { recursive: true });
  return mkdtempSync(resolve(".test-data/disposable/runtime-store-"));
}
const digest = "a".repeat(64);
function installation(
  overrides: Partial<RuntimeInstallation> = {},
): RuntimeInstallation {
  return {
    installationId: "installation:one",
    runtimeId: "runtime:test-list",
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
        id: "csthink.test.list-confirm",
        version: contractVersion,
        schemaDigest: digest,
        required: true,
      },
    ],
    executionProfileRequirements: [],
    launcher: { launcher: "/usr/bin/true", binaryDigest: digest, version: "1" },
    entrypoint: "list-fake.cjs",
    argv: ["${instanceDir}", "${contractDigest}"],
    source: { kind: "offline-import", reference: "test" },
    incompatibility: null,
    checkedFiles: 4,
    expandedBytes: 100,
    importedAt: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}
function instance(overrides: Partial<RuntimeInstance> = {}): RuntimeInstance {
  return {
    instanceId: "instance:one",
    installationId: "installation:one",
    createdAt: "2026-09-19T00:00:00Z",
    state: "ready",
    incarnationId: "incarnation:a",
    connectionId: "connection:a",
    controlGeneration: "1",
    pid: 4242,
    startedAt: "2026-09-19T00:00:01Z",
    launchArgv: ["/usr/bin/true", "list-fake.cjs"],
    exit: null,
    negotiation: {
      selectedProtocol: { version: contractVersion, contractDigest },
      capabilities: [],
      executionProfiles: [],
      limits: {
        frameBytes: 1,
        depth: 1,
        members: 1,
        inFlight: 1,
        bufferBytes: 1,
        eventWindow: 1,
        pageObjects: 1,
        textCharacters: 1,
      },
    },
    failure: null,
    health: { result: "ok", reason: "", at: "2026-09-19T00:00:02Z" },
    updatedAt: "2026-09-19T00:00:02Z",
    ...overrides,
  };
}

test("安装与实例记录：主进程报告的记录原样进入快照，实例可更新，重开数据库后仍在；schema 版本为 28", () => {
  const dir = open();
  let store = new Store(dir);
  assert.equal(schemaVersion, 28);
  const fresh = store.snapshot();
  assert.deepEqual(fresh.runtimeInstallations, []);
  assert.deepEqual(fresh.runtimeInstances, []);
  const installed = store.execute(
    { type: "runtimeInstall", installation: installation() },
    "main",
    "host",
  );
  assert.equal(installed.ok, true);
  const started = store.execute(
    {
      type: "runtimeInstanceUpsert",
      instance: instance({ state: "starting", health: null }),
    },
    "main",
    "host",
  );
  assert.equal(
    started.ok && started.snapshot.runtimeInstances[0].state,
    "starting",
  );
  const ready = store.execute(
    { type: "runtimeInstanceUpsert", instance: instance() },
    "main",
    "host",
  );
  assert.equal(ready.ok && ready.snapshot.runtimeInstances.length, 1);
  assert.equal(
    ready.ok && ready.snapshot.runtimeInstances[0].health?.result,
    "ok",
  );
  assert.equal(ready.ok && ready.snapshot.revision > fresh.revision, true);
  store.close();
  store = new Store(dir);
  const reopened = store.snapshot();
  assert.deepEqual(reopened.runtimeInstallations, [installation()]);
  assert.deepEqual(reopened.runtimeInstances, [instance()]);
  assert.equal(
    extensionState(
      reopened.runtimeInstallations[0],
      reopened.runtimeInstances[0],
    ).state,
    "available",
  );
  store.close();
});

test("拒绝路径：renderer 不能提交安装或实例记录；重复安装身份冲突；实例指向不存在的安装、缺字段或未知状态被拒绝且不改动数据", () => {
  const store = new Store(open());
  const fromRenderer = store.execute(
    { type: "runtimeInstall", installation: installation() },
    "main",
    "renderer",
  );
  assert.equal(fromRenderer.ok, false);
  assert.equal(!fromRenderer.ok && fromRenderer.code, "INVALID_COMMAND");
  assert.equal(store.snapshot().runtimeInstallations.length, 0);
  assert.equal(
    store.execute(
      { type: "runtimeInstall", installation: installation() },
      "main",
      "host",
    ).ok,
    true,
  );
  const duplicate = store.execute(
    { type: "runtimeInstall", installation: installation({ version: "2" }) },
    "main",
    "host",
  );
  assert.equal(!duplicate.ok && duplicate.code, "CONFLICT");
  assert.equal(store.snapshot().runtimeInstallations[0].version, "1");
  const orphan = store.execute(
    {
      type: "runtimeInstanceUpsert",
      instance: instance({ installationId: "installation:none" }),
    },
    "main",
    "host",
  );
  assert.equal(!orphan.ok && orphan.code, "NOT_FOUND");
  const malformed = store.execute(
    {
      type: "runtimeInstanceUpsert",
      instance: { ...instance(), state: "flying" },
    },
    "main",
    "host",
  );
  assert.equal(!malformed.ok && malformed.code, "INVALID_COMMAND");
  const missing = store.execute(
    {
      type: "runtimeInstanceUpsert",
      instance: { ...instance(), health: { result: "ok" } },
    },
    "main",
    "host",
  );
  assert.equal(!missing.ok && missing.code, "INVALID_COMMAND");
  const badInstallation = store.execute(
    {
      type: "runtimeInstall",
      installation: {
        ...installation({ installationId: "installation:two" }),
        incompatibility: { code: "MADE_UP", reasons: [] },
      },
    },
    "main",
    "host",
  );
  assert.equal(!badInstallation.ok && badInstallation.code, "INVALID_COMMAND");
  assert.equal(store.snapshot().runtimeInstances.length, 0);
  assert.equal(store.snapshot().runtimeInstallations.length, 1);
  // An instance may not be moved to another installation by a later upsert.
  assert.equal(
    store.execute(
      {
        type: "runtimeInstall",
        installation: installation({
          installationId: "installation:two",
          runtimeId: "runtime:other",
        }),
      },
      "main",
      "host",
    ).ok,
    true,
  );
  assert.equal(
    store.execute(
      { type: "runtimeInstanceUpsert", instance: instance() },
      "main",
      "host",
    ).ok,
    true,
  );
  const moved = store.execute(
    {
      type: "runtimeInstanceUpsert",
      instance: instance({
        installationId: "installation:two",
        state: "exited",
      }),
    },
    "main",
    "host",
  );
  assert.equal(!moved.ok && moved.code, "CONFLICT");
  assert.equal(
    store.snapshot().runtimeInstances[0].installationId,
    "installation:one",
  );
  assert.equal(store.snapshot().runtimeInstances[0].state, "ready");
  store.close();
});

// ---------------------------------------------------------------- S-02: scopes, projection generations, events, grants, operations

const capability = {
  id: "csthink.test.list-confirm",
  version: contractVersion,
  schemaDigest: digest,
  required: true,
};
function object(
  objectRef: string,
  revision = "rev:1",
  scopeRef = "scope:list-1",
) {
  return {
    scopeRef,
    objectRef,
    revision,
    title: "对象 " + objectRef,
    stateLabel: "ok",
    capability,
    view: { kind: "list", rows: [{ id: "a", title: "标题", detail: "细节" }] },
    evidence: [],
  };
}
function action(
  actionId: string,
  objectRef: string,
  enabled = true,
  scopeRef = "scope:list-1",
) {
  return {
    scopeRef,
    actionId,
    objectRef,
    capability,
    label: actionId,
    expectedRevision: "rev:1",
    candidateRef: null,
    payloadSchemaDigest: digest,
    enabled,
    disabledReason: enabled ? "" : "容量耗尽",
    disabledCode: enabled ? null : "CAPACITY_EXHAUSTED",
    requiresHumanDecision: false,
  };
}
function pending(
  itemRef: string,
  objectRef: string,
  status: "pending" | "processed" = "pending",
  scopeRef = "scope:list-1",
) {
  return {
    scopeRef,
    itemRef,
    revision: "rev:1",
    objectRef,
    capability,
    title: "事项 " + itemRef,
    typeId: "confirm-entry",
    typeLabel: "确认条目",
    status,
    pendingSince: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    processedAt: status === "processed" ? "2026-09-19T00:01:00Z" : null,
    blocking: status === "pending",
    actionIds: status === "pending" ? ["entry.confirm"] : [],
    evidence: [],
  };
}
function page(overrides: Record<string, unknown> = {}) {
  return {
    scopeRef: "scope:list-1",
    snapshotId: "snapshot:1",
    revision: "rev:1",
    streamId: "stream:list",
    epoch: "epoch:1",
    throughSeq: "3",
    expiresAt: "2026-09-19T00:01:00Z",
    objects: [object("directory:root"), object("entry:e1")],
    actions: [
      action("entry.create", "directory:root"),
      action("entry.confirm", "entry:e1", false),
    ],
    pendingItems: [pending("pending:e1", "entry:e1")],
    nextPageToken: null,
    ...overrides,
  };
}
function event(
  seq: string,
  kind: string,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    subscriptionId: "subscription:1",
    eventId: "event:1:" + seq,
    scopeRef: "scope:list-1",
    streamId: "stream:list",
    epoch: "epoch:1",
    seq,
    domainRevision: "rev:" + seq,
    causationId: null,
    kind,
    payload,
    ...overrides,
  };
}
const scope = (overrides: Record<string, unknown> = {}) => ({
  instanceId: "instance:one",
  installationId: "installation:one",
  scopeRef: "scope:list-1",
  bindingRef: "binding:one",
  resourceHandle: "resource:dir",
  state: "inactive",
  grantRefs: [],
  freshness: "missing",
  cursor: null,
  revision: null,
  snapshotId: null,
  subscriptionId: null,
  lastError: null,
  updatedAt: "2026-09-19T00:00:00Z",
  ...overrides,
});
function seeded() {
  const store = new Store(open());
  const host = (command: unknown) => store.execute(command, "main", "host");
  assert.equal(
    host({ type: "runtimeInstall", installation: installation() }).ok,
    true,
  );
  assert.equal(
    host({ type: "runtimeInstanceUpsert", instance: instance() }).ok,
    true,
  );
  assert.equal(
    host({
      type: "runtimeResourceRegister",
      resource: {
        handle: "resource:dir",
        kind: "directory",
        path: "/tmp/x",
        registeredAt: "2026-09-19T00:00:00Z",
      },
    }).ok,
    true,
  );
  assert.equal(host({ type: "runtimeScopeUpsert", scope: scope() }).ok, true);
  return { store, host };
}
const scopeOf = (store: Store) => store.snapshot().runtimeScopes[0];
const projectionOf = (host: (c: unknown) => ReturnType<Store["execute"]>) => {
  const reply = host({
    type: "runtimeProjectionRead",
    instanceId: "instance:one",
    scopeRef: "scope:list-1",
  });
  if (!reply.ok) throw new Error(reply.message);
  return reply.runtimeProjection!;
};

test("快照分页原子替换：跨页不一致、末页非终页、重复身份、目标对象缺失与 scope 不符均拒绝且不改动当前代次；通过后整体替换，新鲜度 syncing，水位为 throughSeq", () => {
  const { store, host } = seeded();
  try {
    assert.equal(scopeOf(store).freshness, "missing");
    assert.deepEqual(scopeOf(store).counts, {
      objects: 0,
      actions: 0,
      actionsEnabled: 0,
      pending: 0,
      blocking: 0,
    });
    const first = host({
      type: "runtimeProjectionReplace",
      instanceId: "instance:one",
      scopeRef: "scope:list-1",
      pages: [page()],
    });
    assert.equal(first.ok, true);
    const after = scopeOf(store);
    assert.equal(after.freshness, "syncing");
    assert.deepEqual(after.cursor, {
      streamId: "stream:list",
      epoch: "epoch:1",
      seq: "3",
    });
    assert.equal(after.revision, "rev:1");
    assert.equal(after.snapshotId, "snapshot:1");
    assert.deepEqual(after.counts, {
      objects: 2,
      actions: 2,
      actionsEnabled: 1,
      pending: 1,
      blocking: 1,
    });
    const rejected: [string, unknown[]][] = [
      [
        "snapshotId differs",
        [
          page({ nextPageToken: "page:1:1" }),
          page({ snapshotId: "snapshot:2" }),
        ],
      ],
      [
        "throughSeq differs",
        [
          page({ nextPageToken: "page:1:1" }),
          page({ throughSeq: "4", objects: [], actions: [], pendingItems: [] }),
        ],
      ],
      [
        "early end",
        [
          page({ nextPageToken: null }),
          page({ objects: [], actions: [], pendingItems: [] }),
        ],
      ],
      ["last not final", [page({ nextPageToken: "page:1:1" })]],
      [
        "duplicate object",
        [
          page({
            objects: [object("directory:root"), object("directory:root")],
            actions: [],
            pendingItems: [],
          }),
        ],
      ],
      [
        "duplicate action",
        [
          page({
            actions: [
              action("entry.create", "directory:root"),
              action("entry.create", "directory:root"),
            ],
            pendingItems: [],
          }),
        ],
      ],
      [
        "duplicate pending",
        [
          page({
            pendingItems: [
              pending("pending:e1", "entry:e1"),
              pending("pending:e1", "entry:e1"),
            ],
          }),
        ],
      ],
      [
        "action targets unknown object",
        [
          page({
            actions: [action("entry.confirm", "entry:missing")],
            pendingItems: [],
          }),
        ],
      ],
      [
        "pending targets unknown object",
        [page({ pendingItems: [pending("pending:x", "entry:missing")] })],
      ],
      [
        "foreign scope object",
        [
          page({
            objects: [object("directory:root", "rev:1", "scope:other")],
            actions: [],
            pendingItems: [],
          }),
        ],
      ],
      [
        "page for another scope",
        [
          page({
            scopeRef: "scope:other",
            objects: [object("directory:root", "rev:1", "scope:other")],
            actions: [],
            pendingItems: [],
          }),
        ],
      ],
      [
        "too many rows",
        [
          page({
            objects: Array.from({ length: 101 }, (_, i) =>
              object("entry:" + i),
            ),
            actions: [],
            pendingItems: [],
          }),
        ],
      ],
      [
        "disabled action without code",
        [
          page({
            actions: [
              {
                ...action("entry.create", "directory:root", false),
                disabledCode: null,
              },
            ],
            pendingItems: [],
          }),
        ],
      ],
      [
        "processed pending still blocking",
        [
          page({
            pendingItems: [
              {
                ...pending("pending:e1", "entry:e1", "processed"),
                blocking: true,
              },
            ],
          }),
        ],
      ],
      [
        "unknown view kind",
        [
          page({
            objects: [
              {
                ...object("directory:root"),
                view: { kind: "script", src: "x" },
              },
            ],
            actions: [],
            pendingItems: [],
          }),
        ],
      ],
    ];
    for (const [name, pages] of rejected) {
      const reply = host({
        type: "runtimeProjectionReplace",
        instanceId: "instance:one",
        scopeRef: "scope:list-1",
        pages,
      });
      assert.equal(reply.ok, false, name + " must be rejected");
      assert.equal(!reply.ok && reply.code, "INVALID_COMMAND", name);
    }
    // The current generation is untouched by every refusal.
    assert.deepEqual(scopeOf(store).counts, {
      objects: 2,
      actions: 2,
      actionsEnabled: 1,
      pending: 1,
      blocking: 1,
    });
    assert.equal(scopeOf(store).snapshotId, "snapshot:1");
    // A later two-page snapshot replaces everything at once.
    const second = host({
      type: "runtimeProjectionReplace",
      instanceId: "instance:one",
      scopeRef: "scope:list-1",
      pages: [
        page({
          snapshotId: "snapshot:2",
          revision: "rev:9",
          throughSeq: "9",
          objects: [object("directory:root", "rev:9")],
          actions: [],
          pendingItems: [],
          nextPageToken: "page:2:1",
        }),
        page({
          snapshotId: "snapshot:2",
          revision: "rev:9",
          throughSeq: "9",
          objects: [object("entry:e2", "rev:9")],
          actions: [action("entry.organize", "entry:e2")],
          pendingItems: [],
        }),
      ],
    });
    assert.equal(second.ok, true);
    assert.deepEqual(
      projectionOf(host).objects.map((o) => o.objectRef),
      ["directory:root", "entry:e2"],
    );
    assert.deepEqual(
      projectionOf(host).actions.map((a) => a.actionId),
      ["entry.organize"],
    );
    assert.deepEqual(scopeOf(store).cursor, {
      streamId: "stream:list",
      epoch: "epoch:1",
      seq: "9",
    });
    assert.equal(scopeOf(store).counts?.pending, 0);
  } finally {
    store.close();
  }
});

test("事件序号规则：下一序号应用并推进水位；重复且相同忽略；同序号不同内容为冲突并标 stale；跳号为 gap 并标 stale 且保留 projection；新 epoch 要求完整快照；caughtUp 只在水位追平时才 current", () => {
  const { store, host } = seeded();
  try {
    const apply = (e: unknown) => {
      const reply = host({
        type: "runtimeEventApply",
        instanceId: "instance:one",
        scopeRef: "scope:list-1",
        event: e,
      });
      if (!reply.ok) throw new Error(reply.message);
      return reply.runtimeEvent;
    };
    assert.equal(
      apply(event("1", "object.upsert", object("entry:e9"))),
      "no-projection",
    );
    assert.equal(
      host({
        type: "runtimeProjectionReplace",
        instanceId: "instance:one",
        scopeRef: "scope:list-1",
        pages: [page()],
      }).ok,
      true,
    );
    // Replay after the watermark: 4 applies, then caughtUp marks current.
    assert.equal(
      apply(event("4", "object.upsert", object("entry:e2", "rev:4"))),
      "applied",
    );
    assert.equal(scopeOf(store).cursor?.seq, "4");
    assert.equal(scopeOf(store).revision, "rev:4");
    assert.equal(projectionOf(host).objects.length, 3);
    assert.equal(
      host({
        type: "runtimeCaughtUp",
        instanceId: "instance:one",
        scopeRef: "scope:list-1",
        streamId: "stream:list",
        epoch: "epoch:1",
        throughSeq: "5",
      }).ok,
      true,
    );
    assert.equal(
      scopeOf(store).freshness,
      "syncing",
      "caughtUp beyond the cursor keeps syncing",
    );
    assert.equal(
      host({
        type: "runtimeCaughtUp",
        instanceId: "instance:one",
        scopeRef: "scope:list-1",
        streamId: "stream:list",
        epoch: "epoch:1",
        throughSeq: "4",
      }).ok,
      true,
    );
    assert.equal(scopeOf(store).freshness, "current");
    // Duplicate delivery of an applied event is ignored; an older seq never applied is ignored too.
    assert.equal(
      apply(event("4", "object.upsert", object("entry:e2", "rev:4"))),
      "duplicate",
    );
    assert.equal(
      apply(event("2", "object.upsert", object("entry:e0"))),
      "duplicate",
    );
    assert.equal(scopeOf(store).freshness, "current");
    // Removals, action and pending upserts, operation.changed all occupy sequence numbers.
    assert.equal(
      apply(event("5", "action.upsert", action("entry.organize", "entry:e2"))),
      "applied",
    );
    assert.equal(
      apply(event("6", "pending.upsert", pending("pending:e2", "entry:e2"))),
      "applied",
    );
    assert.equal(
      apply(event("7", "pending.remove", { itemRef: "pending:e1" })),
      "applied",
    );
    assert.equal(
      apply(event("8", "action.remove", { actionId: "entry.confirm" })),
      "applied",
    );
    assert.equal(
      apply(event("9", "object.remove", { objectRef: "entry:e1" })),
      "applied",
    );
    assert.equal(
      apply(
        event("10", "operation.changed", {
          operationId: "op:1",
          scopeRef: "scope:list-1",
          requestDigest: digest,
          status: "succeeded",
          resultRef: null,
          executionRef: null,
          reason: "created e2",
          resultCode: null,
          revision: "op-rev:1",
        }),
      ),
      "applied",
    );
    const projection = projectionOf(host);
    assert.deepEqual(
      projection.objects.map((o) => o.objectRef),
      ["directory:root", "entry:e2"],
    );
    assert.deepEqual(
      projection.actions.map((a) => a.actionId),
      ["entry.create", "entry.organize"],
    );
    assert.deepEqual(
      projection.pendingItems.map((p) => p.itemRef),
      ["pending:e2"],
    );
    const operation = store
      .snapshot()
      .runtimeOperations.find((o) => o.operationId === "op:1")!;
    assert.equal(operation.origin, "runtime");
    assert.equal(operation.status, "succeeded");
    assert.equal(scopeOf(store).cursor?.seq, "10");
    // Same identity, different content: conflict stops the sync.
    assert.equal(
      apply(
        event("10", "operation.changed", {
          operationId: "op:1",
          scopeRef: "scope:list-1",
          requestDigest: digest,
          status: "failed",
          resultRef: null,
          executionRef: null,
          reason: "x",
          resultCode: "ACCEPT_ABORTED",
          revision: "op-rev:2",
        }),
      ),
      "conflict",
    );
    assert.equal(scopeOf(store).freshness, "stale");
    assert.equal(scopeOf(store).lastError?.code, "PROTOCOL");
    assert.equal(
      store.snapshot().runtimeOperations.find((o) => o.operationId === "op:1")!
        .status,
      "succeeded",
      "a conflicting event changes nothing",
    );
    // A fresh snapshot restores the basis; then a gap pauses again and keeps the projection.
    assert.equal(
      host({
        type: "runtimeProjectionReplace",
        instanceId: "instance:one",
        scopeRef: "scope:list-1",
        pages: [
          page({
            snapshotId: "snapshot:3",
            throughSeq: "12",
            revision: "rev:12",
          }),
        ],
      }).ok,
      true,
    );
    assert.equal(scopeOf(store).freshness, "syncing");
    assert.equal(
      apply(event("14", "object.upsert", object("entry:e5"))),
      "gap",
    );
    assert.equal(scopeOf(store).freshness, "stale");
    assert.equal(scopeOf(store).lastError?.code, "RESYNC_REQUIRED");
    assert.equal(scopeOf(store).cursor?.seq, "12");
    assert.equal(
      projectionOf(host).objects.length,
      2,
      "the projection survives a gap",
    );
    // A different epoch or stream never continues the old log.
    assert.equal(
      apply(
        event("13", "object.upsert", object("entry:e5"), { epoch: "epoch:2" }),
      ),
      "epoch",
    );
    assert.equal(
      apply(
        event("13", "object.upsert", object("entry:e5"), {
          streamId: "stream:other",
        }),
      ),
      "epoch",
    );
    // Events for another scope are refused as a conflict, and malformed events never reach the store.
    assert.equal(
      apply(
        event(
          "13",
          "object.upsert",
          object("entry:e5", "rev:13", "scope:other"),
          { scopeRef: "scope:other" },
        ),
      ),
      "conflict",
    );
    const malformed = host({
      type: "runtimeEventApply",
      instanceId: "instance:one",
      scopeRef: "scope:list-1",
      event: event("13", "object.upsert", { objectRef: "x" }),
    });
    assert.equal(!malformed.ok && malformed.code, "INVALID_COMMAND");
  } finally {
    store.close();
  }
});

test("授权、操作与资源记录的拒绝路径：授权身份字段不能改写、撤销后不能恢复、修订只能递增；操作身份/方法/摘要不能改写、幂等键冲突；资源句柄改路径与 scope 改绑均冲突", () => {
  const { store, host } = seeded();
  try {
    const grant = (overrides: Record<string, unknown> = {}) => ({
      ref: { id: "grant:1", revision: "1" },
      installationId: "installation:one",
      instanceId: "instance:one",
      scopeRef: "scope:list-1",
      resourceHandle: "resource:dir",
      capability: capability.id,
      operation: "directory.read",
      executionRef: null,
      bundleDigest: digest,
      expiresAt: "2026-10-19T00:00:00Z",
      status: "active",
      purpose: "test",
      createdAt: "2026-09-19T00:00:00Z",
      revokedAt: null,
      ...overrides,
    });
    assert.equal(host({ type: "runtimeGrantUpsert", grant: grant() }).ok, true);
    assert.equal(
      !host({
        type: "runtimeGrantUpsert",
        grant: grant({ operation: "directory.write" }),
      }).ok,
      true,
    );
    assert.equal(
      host({
        type: "runtimeGrantUpsert",
        grant: grant({
          ref: { id: "grant:1", revision: "2" },
          status: "revoked",
          revokedAt: "2026-09-19T01:00:00Z",
        }),
      }).ok,
      true,
    );
    const revived = host({
      type: "runtimeGrantUpsert",
      grant: grant({ ref: { id: "grant:1", revision: "3" }, status: "active" }),
    });
    assert.equal(!revived.ok && revived.code, "CONFLICT");
    const older = host({
      type: "runtimeGrantUpsert",
      grant: grant({
        ref: { id: "grant:1", revision: "1" },
        status: "revoked",
        revokedAt: "2026-09-19T01:00:00Z",
      }),
    });
    assert.equal(!older.ok && older.code, "CONFLICT");
    assert.equal(store.snapshot().runtimeGrants[0].status, "revoked");
    const operation = (overrides: Record<string, unknown> = {}) => ({
      operationId: "op:host-1",
      installationId: "installation:one",
      instanceId: "instance:one",
      scopeRef: "scope:list-1",
      method: "runtime.action.invoke",
      origin: "host",
      idempotencyKey: "key:1",
      requestDigest: digest,
      request: { actionId: "entry.create" },
      status: "unknown",
      resultCode: null,
      reason: "",
      resultRef: null,
      executionRef: null,
      revision: null,
      result: null,
      transport: "sent",
      errorCode: null,
      recovery: null,
      createdAt: "2026-09-19T00:00:00Z",
      updatedAt: "2026-09-19T00:00:00Z",
      ...overrides,
    });
    assert.equal(
      host({ type: "runtimeOperationUpsert", operation: operation() }).ok,
      true,
    );
    assert.equal(
      host({
        type: "runtimeOperationUpsert",
        operation: operation({
          status: "succeeded",
          transport: "answered",
          revision: "op-rev:1",
        }),
      }).ok,
      true,
    );
    const rewritten = host({
      type: "runtimeOperationUpsert",
      operation: operation({ requestDigest: "b".repeat(64) }),
    });
    assert.equal(!rewritten.ok && rewritten.code, "CONFLICT");
    const keyClash = host({
      type: "runtimeOperationUpsert",
      operation: operation({ operationId: "op:host-2" }),
    });
    assert.equal(!keyClash.ok && keyClash.code, "CONFLICT");
    assert.equal(store.snapshot().runtimeOperations.length, 1);
    const moved = host({
      type: "runtimeResourceRegister",
      resource: {
        handle: "resource:dir",
        kind: "directory",
        path: "/tmp/y",
        registeredAt: "2026-09-19T00:00:00Z",
      },
    });
    assert.equal(!moved.ok && moved.code, "CONFLICT");
    const rebound = host({
      type: "runtimeScopeUpsert",
      scope: scope({ bindingRef: "binding:two" }),
    });
    assert.equal(!rebound.ok && rebound.code, "CONFLICT");
    const unregistered = host({
      type: "runtimeScopeUpsert",
      scope: scope({
        scopeRef: "scope:list-2",
        resourceHandle: "resource:none",
      }),
    });
    assert.equal(!unregistered.ok && unregistered.code, "NOT_FOUND");
    assert.equal(store.snapshot().runtimeScopes.length, 1);
  } finally {
    store.close();
  }
});

test("人工决定记录：与待发送 Invoke 同一事务建立，身份、摘要、动作字段任一不一致即拒绝且两者都不写入；记录不可覆盖，撤销只追加状态；按 decisionRef、operationId、幂等键与方法的权威读取不受快照上限影响", () => {
  const { store, host } = seeded();
  try {
    const operation = (overrides: Record<string, unknown> = {}) => ({
      operationId: "op:decided-1",
      installationId: "installation:one",
      instanceId: "instance:one",
      scopeRef: "scope:list-1",
      method: "runtime.action.invoke",
      origin: "host",
      idempotencyKey: "key:decided-1",
      requestDigest: digest,
      request: {
        operationId: "op:decided-1",
        idempotencyKey: "key:decided-1",
        scopeRef: "scope:list-1",
        actionId: "entry.confirm",
        objectRef: "entry:e1",
        expectedRevision: "rev:3",
        candidateRef: "entry-candidate:e1.r3",
        grantRefs: [],
        payload: { choice: "confirm" },
        decisionRef: "decision:1",
      },
      status: "unknown",
      resultCode: null,
      reason: "",
      resultRef: null,
      executionRef: null,
      revision: null,
      result: null,
      transport: "sent",
      errorCode: null,
      recovery: null,
      createdAt: "2026-09-19T00:00:00Z",
      updatedAt: "2026-09-19T00:00:00Z",
      ...overrides,
    });
    const decision = (overrides: Record<string, unknown> = {}) => ({
      decisionRef: "decision:1",
      installationId: "installation:one",
      instanceId: "instance:one",
      scopeRef: "scope:list-1",
      domainOperationId: "op:decided-1",
      method: "runtime.action.invoke",
      requestDigest: digest,
      actionId: "entry.confirm",
      objectRef: "entry:e1",
      candidateRef: "entry-candidate:e1.r3",
      expectedRevision: "rev:3",
      evidence: [],
      actorRef: "actor:mars",
      source: "host-trusted-ui",
      recordedAt: "2026-09-19T00:00:00Z",
      status: "valid",
      revokedAt: null,
      ...overrides,
    });
    // Every mismatch between the record and the request is refused before either row exists.
    for (const [label, bad] of [
      ["digest", decision({ requestDigest: "b".repeat(64) })],
      ["operation", decision({ domainOperationId: "op:other" })],
      ["action", decision({ actionId: "entry.create" })],
      ["candidate", decision({ candidateRef: null })],
      ["revision", decision({ expectedRevision: "rev:2" })],
      ["scope", decision({ scopeRef: "scope:list-9" })],
      [
        "status",
        decision({ status: "revoked", revokedAt: "2026-09-19T00:00:01Z" }),
      ],
    ] as const) {
      const reply = host({
        type: "runtimeDecisionRecord",
        decision: bad,
        operation: operation(),
      });
      assert.equal(reply.ok, false, label + " must be refused");
      assert.equal(store.snapshot().runtimeDecisions.length, 0, label);
      assert.equal(store.snapshot().runtimeOperations.length, 0, label);
    }
    // The request's decisionRef must name this record.
    assert.equal(
      host({
        type: "runtimeDecisionRecord",
        decision: decision(),
        operation: operation({
          request: { ...operation().request, decisionRef: "decision:2" },
        }),
      }).ok,
      false,
    );
    assert.equal(
      host({
        type: "runtimeDecisionRecord",
        decision: decision(),
        operation: operation(),
      }).ok,
      true,
    );
    assert.equal(store.snapshot().runtimeDecisions[0].status, "valid");
    assert.equal(
      store.snapshot().runtimeOperations[0].operationId,
      "op:decided-1",
    );
    // Immutable: the same decisionRef and the same pending operation cannot be re-recorded.
    const again = host({
      type: "runtimeDecisionRecord",
      decision: decision({ actorRef: "actor:other" }),
      operation: operation({
        operationId: "op:decided-2",
        idempotencyKey: "key:decided-2",
        request: { ...operation().request, operationId: "op:decided-2" },
      }),
    });
    assert.equal(!again.ok && again.code, "CONFLICT");
    const reused = host({
      type: "runtimeDecisionRecord",
      decision: decision({ decisionRef: "decision:2" }),
      operation: operation({
        request: { ...operation().request, decisionRef: "decision:2" },
      }),
    });
    assert.equal(!reused.ok && reused.code, "CONFLICT");
    // Revocation appends the status; the confirmed content is unchanged and a second revoke changes nothing.
    assert.equal(
      host({
        type: "runtimeDecisionRevoke",
        instanceId: "instance:one",
        decisionRef: "decision:1",
        revokedAt: "2026-09-19T02:00:00Z",
      }).ok,
      true,
    );
    const revoked = store.snapshot().runtimeDecisions[0];
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revokedAt, "2026-09-19T02:00:00Z");
    assert.equal(revoked.actorRef, "actor:mars");
    assert.equal(revoked.requestDigest, digest);
    assert.equal(
      host({
        type: "runtimeDecisionRevoke",
        instanceId: "instance:one",
        decisionRef: "decision:1",
        revokedAt: "2026-09-19T03:00:00Z",
      }).ok,
      true,
    );
    assert.equal(
      store.snapshot().runtimeDecisions[0].revokedAt,
      "2026-09-19T02:00:00Z",
    );
    const unknown = host({
      type: "runtimeDecisionRevoke",
      instanceId: "instance:one",
      decisionRef: "decision:none",
      revokedAt: "2026-09-19T03:00:00Z",
    });
    assert.equal(!unknown.ok && unknown.code, "NOT_FOUND");
    // Authoritative reads: by decisionRef (other instance sees nothing), by operationId, by key, and the open list.
    const read = (command: unknown) => {
      const reply = host(command);
      if (!reply.ok) throw new Error(reply.message);
      return reply;
    };
    assert.equal(
      read({
        type: "runtimeDecisionRead",
        instanceId: "instance:one",
        decisionRef: "decision:1",
      }).runtimeDecision?.status,
      "revoked",
    );
    assert.equal(
      read({
        type: "runtimeDecisionRead",
        instanceId: "instance:two",
        decisionRef: "decision:1",
      }).runtimeDecision,
      null,
    );
    assert.equal(
      read({
        type: "runtimeOperationRead",
        instanceId: "instance:one",
        operationId: "op:decided-1",
        key: null,
      }).runtimeOperation?.idempotencyKey,
      "key:decided-1",
    );
    assert.equal(
      read({
        type: "runtimeOperationRead",
        instanceId: "instance:one",
        operationId: null,
        key: {
          scopeRef: "scope:list-1",
          method: "runtime.action.invoke",
          idempotencyKey: "key:decided-1",
        },
      }).runtimeOperation?.operationId,
      "op:decided-1",
    );
    assert.equal(
      read({
        type: "runtimeOperationRead",
        instanceId: "instance:one",
        operationId: "op:none",
        key: null,
      }).runtimeOperation,
      null,
    );
    // Sixty more operations push the decided one out of the bounded snapshot; the store still answers.
    for (let i = 0; i < 60; i++)
      assert.equal(
        host({
          type: "runtimeOperationUpsert",
          operation: operation({
            operationId: "op:filler-" + i,
            idempotencyKey: "key:filler-" + i,
            request: null,
            status: "succeeded",
            transport: "answered",
            updatedAt: "2026-09-19T01:00:" + String(i).padStart(2, "0") + "Z",
          }),
        }).ok,
        true,
        "filler " + i,
      );
    assert.equal(store.snapshot().runtimeOperations.length, 50);
    assert.equal(
      store
        .snapshot()
        .runtimeOperations.some((o) => o.operationId === "op:decided-1"),
      false,
    );
    assert.equal(
      read({
        type: "runtimeOperationRead",
        instanceId: "instance:one",
        operationId: "op:decided-1",
        key: null,
      }).runtimeOperation?.operationId,
      "op:decided-1",
    );
    const open = read({
      type: "runtimeOperationList",
      instanceId: "instance:one",
      methods: [],
      open: true,
    }).runtimeOperationList!;
    assert.deepEqual(
      open.map((o) => o.operationId),
      ["op:decided-1"],
      "only the unanswered operation is open",
    );
    assert.equal(
      read({
        type: "runtimeOperationList",
        instanceId: "instance:one",
        methods: ["runtime.action.invoke"],
        open: false,
      }).runtimeOperationList!.length,
      61,
    );
    // Reads are refused from the renderer and with malformed shapes.
    assert.equal(
      store.execute(
        {
          type: "runtimeOperationRead",
          instanceId: "instance:one",
          operationId: "op:decided-1",
          key: null,
        },
        "main",
        "renderer",
      ).ok,
      false,
    );
    assert.equal(
      host({
        type: "runtimeOperationRead",
        instanceId: "instance:one",
        operationId: null,
        key: null,
      }).ok,
      false,
    );
  } finally {
    store.close();
  }
});

test("卡片状态推导：不兼容、协商拒绝、退出/停止、协商中、健康未完成、健康超时/失败、降级各自映射；健康正常但任一已授权 scope 过期或同步中为待核实并说明 scope，未授权的 stale scope 不影响可用", () => {
  const base = instance();
  const scope = (
    overrides: Partial<{
      state: "active" | "inactive";
      freshness: "missing" | "syncing" | "current" | "stale";
      lastError: { code: string; message: string; at: string } | null;
    }> = {},
  ) => ({
    scopeRef: "scope:list-1",
    state: "active" as const,
    freshness: "current" as const,
    lastError: null,
    ...overrides,
  });
  const derive = (
    patch: Partial<ReturnType<typeof instance>>,
    scopes: ReturnType<typeof scope>[] = [],
  ) => extensionState(installation(), { ...base, ...patch }, scopes);
  assert.equal(
    extensionState(
      {
        ...installation(),
        incompatibility: { code: "UNSUPPORTED_VERSION", reasons: ["平台"] },
      },
      base,
    ).state,
    "incompatible",
  );
  assert.equal(extensionState(installation(), undefined).state, "unverified");
  assert.equal(
    derive({ failure: { code: "INTEGRITY_MISMATCH", message: "x", at: "t" } })
      .state,
    "incompatible",
  );
  assert.deepEqual(derive({ state: "exited", failure: null }), {
    state: "connection-error",
    reason: "进程已退出",
  });
  assert.equal(derive({ state: "stopped" }).state, "connection-error");
  assert.equal(derive({ state: "starting", health: null }).state, "unverified");
  assert.equal(derive({ health: null }).state, "unverified");
  assert.deepEqual(
    derive({ health: { result: "timeout", reason: "no answer", at: "t" } }),
    { state: "connection-error", reason: "健康检查超时：no answer" },
  );
  assert.equal(
    derive({ health: { result: "failed", reason: "", at: "t" } }).state,
    "connection-error",
  );
  assert.equal(
    derive({ health: { result: "degraded", reason: "slow", at: "t" } }).state,
    "unverified",
  );
  assert.equal(derive({}).state, "available");
  assert.equal(derive({}, [scope()]).state, "available");
  assert.deepEqual(derive({}, [scope({ freshness: "syncing" })]), {
    state: "unverified",
    reason: "scope:list-1 的项目投影正在同步，尚未取得完整状态",
  });
  assert.deepEqual(
    derive({}, [
      scope({
        freshness: "stale",
        lastError: { code: "RUNTIME_EXITED", message: "进程已退出", at: "t" },
      }),
    ]),
    {
      state: "unverified",
      reason: "scope:list-1 的项目投影已过期（RUNTIME_EXITED：进程已退出）",
    },
  );
  // A scope that is not authorized keeps its old projection; it does not make the card unverified.
  assert.equal(
    derive({}, [scope({ state: "inactive", freshness: "stale" })]).state,
    "available",
  );
  // Scope freshness never upgrades a worse instance state.
  assert.equal(
    derive({ state: "exited" }, [scope({ freshness: "stale" })]).state,
    "connection-error",
  );
});

test("KB-278 第六项与启动记录：同一 runtimeId 同版本只保留一个已记录身份（不同字节与重复记录都拒绝且不写入，新版本照常写入）；实例的启动目录只接受三个绝对路径并随快照保存", () => {
  const dir = open();
  const store = new Store(dir);
  assert.equal(
    store.execute(
      { type: "runtimeInstall", installation: installation() },
      "main",
      "host",
    ).ok,
    true,
  );
  const changed = store.execute(
    {
      type: "runtimeInstall",
      installation: installation({
        installationId: "installation:changed",
        artifactDigest: "b".repeat(64),
      }),
    },
    "main",
    "host",
  );
  assert.equal(!changed.ok && changed.code, "CONFLICT");
  assert.match(!changed.ok ? changed.message : "", /变更字节须使用新版本号/);
  const repeated = store.execute(
    {
      type: "runtimeInstall",
      installation: installation({ installationId: "installation:repeated" }),
    },
    "main",
    "host",
  );
  assert.equal(!repeated.ok && repeated.code, "CONFLICT");
  assert.match(!repeated.ok ? repeated.message : "", /已安装/);
  const other = store.execute(
    {
      type: "runtimeInstall",
      installation: installation({
        installationId: "installation:other-runtime",
        runtimeId: "runtime:test-other",
      }),
    },
    "main",
    "host",
  );
  assert.equal(other.ok, true);
  const next = store.execute(
    {
      type: "runtimeInstall",
      installation: installation({
        installationId: "installation:next",
        version: "2",
        artifactDigest: "c".repeat(64),
      }),
    },
    "main",
    "host",
  );
  assert.equal(next.ok, true);
  assert.deepEqual(
    store
      .snapshot()
      .runtimeInstallations.map((i) => i.installationId)
      .sort(),
    ["installation:next", "installation:one", "installation:other-runtime"],
  );
  const directories = {
    runtimeRoot: "/r",
    packageDir: "/r/packages/runtime_test-list/" + digest,
    instanceDir: "/r/instances/instance_one",
  };
  for (const bad of [
    { ...directories, instanceDir: "relative/instance" },
    { ...directories, extra: "/x" },
    { runtimeRoot: "/r", packageDir: "/p" },
  ]) {
    const refused = store.execute(
      {
        type: "runtimeInstanceUpsert",
        instance: {
          ...instance(),
          launchDirectories: bad,
        } as unknown as RuntimeInstance,
      },
      "main",
      "host",
    );
    assert.equal(!refused.ok && refused.code, "INVALID_COMMAND");
  }
  assert.equal(
    store.execute(
      {
        type: "runtimeInstanceUpsert",
        instance: instance({ launchDirectories: directories }),
      },
      "main",
      "host",
    ).ok,
    true,
  );
  store.close();
  const reopened = new Store(dir);
  assert.deepEqual(
    reopened.snapshot().runtimeInstances[0].launchDirectories,
    directories,
  );
  reopened.close();
});

test("OD-416 授权批次在业务服务中全有或全无：任一授权指向不存在的实例、批内重复身份或空批次都拒绝，已有记录不变", () => {
  const store = new Store(open());
  assert.equal(
    store.execute(
      { type: "runtimeInstall", installation: installation() },
      "main",
      "host",
    ).ok,
    true,
  );
  assert.equal(
    store.execute(
      { type: "runtimeInstanceUpsert", instance: instance() },
      "main",
      "host",
    ).ok,
    true,
  );
  const grant = (id: string, instanceId = "instance:one") => ({
    ref: { id, revision: "1" },
    installationId: "installation:one",
    instanceId,
    scopeRef: "scope:a",
    resourceHandle: "resource:dir",
    capability: "csthink.test.list-confirm",
    operation: "runtime.snapshot.open",
    executionRef: null,
    bundleDigest: digest,
    expiresAt: "2099-01-01T00:00:00Z",
    status: "active" as const,
    purpose: "batch",
    createdAt: "2026-09-24T00:00:00Z",
    revokedAt: null,
  });
  const partial = store.execute(
    {
      type: "runtimeGrantBatch",
      grants: [grant("grant:a"), grant("grant:b", "instance:none")],
    },
    "main",
    "host",
  );
  assert.equal(partial.ok, false);
  assert.equal(store.snapshot().runtimeGrants.length, 0);
  for (const grants of [[], [grant("grant:a"), grant("grant:a")]]) {
    const refused = store.execute(
      { type: "runtimeGrantBatch", grants },
      "main",
      "host",
    );
    assert.equal(!refused.ok && refused.code, "INVALID_COMMAND");
  }
  const fromRenderer = store.execute(
    { type: "runtimeGrantBatch", grants: [grant("grant:a")] },
    "main",
    "renderer",
  );
  assert.equal(fromRenderer.ok, false);
  const ok = store.execute(
    { type: "runtimeGrantBatch", grants: [grant("grant:a"), grant("grant:b")] },
    "main",
    "host",
  );
  assert.equal(ok.ok, true);
  assert.equal(store.snapshot().runtimeGrants.length, 2);
  store.close();
});
