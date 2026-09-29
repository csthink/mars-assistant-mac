import { DatabaseSync } from "node:sqlite";
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/service/store";
import { inspectProjectFolder } from "../../src/main/projects";
import { ProjectWorkspace } from "../../src/main/project-work";
import { readProjection } from "../../src/service/runtime-store";
import { readRoleBinding } from "../../src/service/runtime-executions";
import {
  contractVersion,
  contractDigest,
  runtimeLimits,
  type RuntimeInstallation,
  type RuntimeInstance,
  type RuntimeScope,
  type RuntimeGrant,
  type RuntimeOperation,
} from "../../src/shared/runtime-host";
import type { ProjectRequest } from "../../src/shared/project-work";
import type { ExecutionProfile } from "../../src/main/runtime-execution-port";
import { claudeImplementerProfileId } from "../../src/main/execution-claude";
import { codexReviewerProfileId } from "../../src/main/execution-codex";
import { warmSystemGit } from "./git-warmup";
const digest = "a".repeat(64),
  at = new Date().toISOString();
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

before(warmSystemGit);

async function fixture() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/project-work-")),
    folder = join(root, "folder"),
    data = join(root, "data");
  mkdirSync(folder);
  mkdirSync(data);
  const store = new Store(data),
    id = randomUUID(),
    other = randomUUID();
  const host = (c: unknown) => {
    const r = store.execute(c, "main", "host");
    assert.ok(r.ok, JSON.stringify(r));
    return r;
  };
  const info = await inspectProjectFolder(folder);
  for (const pid of [id, other])
    host({
      type: "projectCreate",
      id: pid,
      name: "同名项目",
      goal: "本项目目标",
      folder: info,
    });
  const profiles: ExecutionProfile[] = [
    { id: claudeImplementerProfileId, purpose: "coding-implementer" },
    { id: codexReviewerProfileId, purpose: "review" },
  ].map((p) => ({
    ...p,
    purpose: p.purpose as ExecutionProfile["purpose"],
    version: "1",
    digest,
    trustModel: "current-user",
    programIdentity: {
      launcher: "fixture",
      version: "1",
      binaryDigest: digest,
    },
    nativeApprovalPolicy: "auto-deny",
    configurationDigest: digest,
    capabilities: [],
    limitations: [],
    operations: [],
    maxContextBytes: 100,
    maxToolCalls: 1,
    maxRunSeconds: 1,
  }));
  host({ type: "runtimeInstall", installation: installation() });
  const inst = instance();
  inst.negotiation = {
    selectedProtocol: { version: contractVersion, contractDigest },
    capabilities: [],
    executionProfiles: profiles.map(({ id, version, digest }) => ({
      id,
      version,
      digest,
    })),
    limits: runtimeLimits,
  };
  host({ type: "runtimeInstanceUpsert", instance: inst });
  host({
    type: "runtimeResourceRegister",
    resource: {
      handle: "resource:repo",
      kind: "directory",
      path: info.canonicalPath,
      registeredAt: at,
    },
  });
  const scope: RuntimeScope = {
    instanceId: inst.instanceId,
    installationId: inst.installationId,
    scopeRef: "scope:one",
    bindingRef: "binding:one",
    resourceHandle: "resource:repo",
    state: "active",
    grantRefs: [{ id: "grant:one", revision: "1" }],
    freshness: "missing",
    cursor: null,
    revision: null,
    snapshotId: null,
    subscriptionId: null,
    lastError: null,
    updatedAt: at,
  };
  host({ type: "runtimeScopeUpsert", scope });
  const grant: RuntimeGrant = {
    ref: { id: "grant:one", revision: "1" },
    installationId: inst.installationId,
    instanceId: inst.instanceId,
    scopeRef: scope.scopeRef,
    resourceHandle: scope.resourceHandle,
    capability: "test",
    operation: "read",
    executionRef: null,
    bundleDigest: digest,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    status: "active",
    purpose: "synthetic",
    createdAt: at,
    revokedAt: null,
  };
  host({ type: "runtimeGrantUpsert", grant });
  function projection(revision: string, snapshotId = "snapshot:" + revision) {
    host({
      type: "runtimeProjectionReplace",
      instanceId: scope.instanceId,
      scopeRef: scope.scopeRef,
      pages: [
        {
          scopeRef: scope.scopeRef,
          snapshotId,
          revision,
          streamId: "stream:one",
          epoch: "epoch:one",
          throughSeq: "0",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          objects: [
            {
              scopeRef: scope.scopeRef,
              objectRef: "object:tasks",
              revision,
              title: "任务清单",
              stateLabel: "任务开发",
              capability: {
                id: "test",
                version: contractVersion,
                schemaDigest: digest,
                required: true,
              },
              view: {
                kind: "list",
                rows: [
                  { id: "task:one", title: "真实投影任务", detail: "待接纳" },
                ],
              },
              evidence: [],
            },
          ],
          actions: [],
          pendingItems: [],
          nextPageToken: null,
        },
      ],
    });
    host({
      type: "runtimeCaughtUp",
      instanceId: scope.instanceId,
      scopeRef: scope.scopeRef,
      streamId: "stream:one",
      epoch: "epoch:one",
      throughSeq: "0",
    });
  }
  projection("1");
  const work = new ProjectWorkspace({
    snapshot: () => store.snapshot(),
    host: {
      projection: async (i, s) => readProjection(store.db, i, s),
      roleBinding: async (i, s, r) => readRoleBinding(store.db, i, s, r),
    },
    profiles: () => profiles,
    save: async (c) => store.execute(c, "main", "host"),
  });
  const request = (
    c:
      | Omit<Extract<ProjectRequest, { type: "bind" }>, "projectId">
      | ProjectRequest,
  ) => work.request("projectId" in c ? c : { ...c, projectId: id });
  const bind = () =>
    request({
      type: "bind",
      instanceId: scope.instanceId,
      scopeRef: scope.scopeRef,
      revision: 0,
    });
  return {
    root,
    folder,
    data,
    store,
    id,
    other,
    host,
    scope,
    grant,
    profiles,
    work,
    request,
    bind,
    projection,
    inst,
  };
}
test("project work: trusted binding rejects forged writes, reused scope, replaced folder and stale authority", async () => {
  const f = await fixture();
  try {
    assert.equal(
      f.store.execute(
        {
          type: "projectWork",
          request: {
            type: "chat",
            projectId: f.id,
            conversationId: randomUUID(),
          },
        },
        "main",
      ).ok,
      false,
    );
    assert.deepEqual(await f.bind(), { ok: true });
    assert.equal(
      (
        await f.work.request({
          type: "bind",
          projectId: f.other,
          instanceId: f.scope.instanceId,
          scopeRef: f.scope.scopeRef,
          revision: 0,
        })
      ).ok,
      false,
    );
    const conversationId = randomUUID();
    assert.equal(
      (await f.work.request({ type: "chat", projectId: f.id, conversationId }))
        .ok,
      true,
    );
    assert.equal(
      (
        await f.work.request({
          type: "chat",
          projectId: f.other,
          conversationId,
        })
      ).ok,
      false,
    );
    const context = {
      type: "context" as const,
      projectId: f.id,
      conversationId,
      objectRef: "object:tasks",
      objectRevision: "1",
      revision: 0,
    };
    renameSync(f.folder, join(f.root, "old"));
    mkdirSync(f.folder);
    assert.equal((await f.work.request(context)).ok, false);
    f.host({
      type: "runtimeGrantUpsert",
      grant: { ...f.grant, status: "revoked", revokedAt: at },
    });
    const view = await f.work.request({ type: "read", projectId: f.id });
    assert.ok(view.ok && view.view);
    assert.match(view.view.unavailable, /授权/);
    assert.equal(view.view.projection?.objects.length, 1);
  } finally {
    f.store.close();
  }
});
test("project work: after an action succeeds the object awaits its projection until the binding moves or a later full snapshot shows the Runtime kept it; each read decides from the records alone (KB-308)", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.bind(), { ok: true });
    const read = async () => {
      const r = await f.request({ type: "read", projectId: f.id });
      assert.ok(r.ok && r.view, JSON.stringify(r));
      return r.view.awaiting;
    };
    let n = 0;
    const invoke = (status: RuntimeOperation["status"], binding: string) => {
      n += 1;
      const operation: RuntimeOperation = {
        operationId: `op:${n}`,
        installationId: f.inst.installationId,
        instanceId: f.scope.instanceId,
        scopeRef: f.scope.scopeRef,
        method: "runtime.action.invoke",
        origin: "host",
        idempotencyKey: `key:${n}`,
        requestDigest: digest,
        request: {
          actionId: "task.accept",
          objectRef: "object:tasks",
          expectedRevision: binding,
          candidateRef: null,
          payload: {},
        },
        status,
        resultCode: null,
        reason: "",
        resultRef: null,
        executionRef: null,
        revision: null,
        result: null,
        transport: "answered",
        errorCode: null,
        recovery: null,
        createdAt: new Date(Date.parse(at) + n * 1000).toISOString(),
        updatedAt: at,
      };
      f.host({ type: "runtimeOperationUpsert", operation });
      return operation.operationId;
    };
    assert.deepEqual(await read(), []);
    // Answered before the projection events: the object still shows revision 1, the binding consumed.
    const first = invoke("succeeded", "1");
    const held = [
      {
        objectRef: "object:tasks",
        operationId: first,
        actionId: "task.accept",
      },
    ];
    assert.deepEqual(await read(), held);
    assert.deepEqual(await read(), held);
    // The events arrive: the object moves past the binding.
    f.projection("2");
    assert.deepEqual(await read(), []);
    // A newer action that did not succeed does not hold the object; one that succeeded does.
    invoke("failed", "2");
    assert.deepEqual(await read(), []);
    const kept = invoke("succeeded", "2");
    assert.deepEqual(await read(), [
      { objectRef: "object:tasks", operationId: kept, actionId: "task.accept" },
    ]);
    // A Runtime that keeps the binding after a success: a full snapshot taken after the success
    // was seen (重新同步 or a reconnection) is the way out; the same snapshot never is.
    f.projection("2", "snapshot:after-success");
    assert.deepEqual(await read(), []);
    assert.deepEqual(await read(), []);
    // A fresh workspace (an application restart) first sees it under the current snapshot.
    const restarted = new ProjectWorkspace({
      snapshot: () => f.store.snapshot(),
      host: {
        projection: async (i, s) => readProjection(f.store.db, i, s),
        roleBinding: async (i, s, r) => readRoleBinding(f.store.db, i, s, r),
      },
      profiles: () => f.profiles,
      save: async (c) => f.store.execute(c, "main", "host"),
    });
    const again = await restarted.request({ type: "read", projectId: f.id });
    assert.ok(again.ok && again.view);
    assert.equal(again.view.awaiting.length, 1);
    f.projection("2", "snapshot:resync");
    const resynced = await restarted.request({ type: "read", projectId: f.id });
    assert.ok(resynced.ok && resynced.view);
    assert.deepEqual(resynced.view.awaiting, []);
  } finally {
    f.store.close();
  }
});
test("project work: role selection checks negotiated tuple, provider, model and effort without launching agents", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.bind()).ok, true);
    for (const provider of ["codex", "claude"] as const)
      f.host({
        type: provider === "codex" ? "configureCodex" : "configureClaude",
        model: provider + "-synthetic",
        configuration: {
          provider: provider === "codex" ? "openai" : "firstParty",
          endpoint: "synthetic",
          authentication: provider === "codex" ? "chatgpt" : "subscription",
          identity: digest,
          fingerprint: digest,
          instructions: [],
          configurationInstructions: [],
        },
        effort: {
          levels: ["low", "high"],
          defaultLevel: "low",
          source:
            provider === "codex" ? "codex-model-list" : "claude-initialize",
          recordedAt: at,
        },
      });
    const claude = f.store
        .snapshot()
        .connections.find((c) => c.provider === "claude")!,
      codex = f.store
        .snapshot()
        .connections.find((c) => c.provider === "codex")!;
    const choose = {
      type: "role" as const,
      projectId: f.id,
      role: "implementer" as const,
      connectionId: claude.id,
      model: claude.model,
      effort: "high",
      expectedUpdatedAt: null,
    };
    assert.equal(
      (
        await f.work.request({
          ...choose,
          connectionId: codex.id,
          model: codex.model,
        })
      ).ok,
      false,
    );
    assert.equal(
      (await f.work.request({ ...choose, effort: "unknown" })).ok,
      false,
    );
    assert.equal((await f.work.request(choose)).ok, true);
    assert.equal(
      readRoleBinding(
        f.store.db,
        f.scope.instanceId,
        f.scope.scopeRef,
        "role:implementer",
      )?.effort,
      "high",
    );
    assert.equal((await f.work.request(choose)).ok, false);
    f.profiles[1].digest = "b".repeat(64);
    assert.equal(
      (
        await f.work.request({
          ...choose,
          role: "reviewer",
          connectionId: codex.id,
          model: codex.model,
        })
      ).ok,
      false,
    );
    f.profiles[1].digest = digest;
    f.store.db
      .prepare("UPDATE connection_models SET enabled=0 WHERE connection_id=?")
      .run(codex.id);
    assert.equal(
      (
        await f.work.request({
          ...choose,
          role: "reviewer",
          connectionId: codex.id,
          model: codex.model,
        })
      ).ok,
      false,
    );
    assert.equal(f.store.snapshot().runtimeExecutions.length, 0);
  } finally {
    f.store.close();
  }
});
test("project work: explicit context versions, independent drafts and immutable turn context survive selection changes and reject revocation", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.bind()).ok, true);
    const conversationId = randomUUID(),
      second = randomUUID();
    for (const id of [conversationId, second])
      assert.equal(
        (
          await f.work.request({
            type: "chat",
            projectId: f.id,
            conversationId: id,
          })
        ).ok,
        true,
      );
    const context = {
      type: "context" as const,
      projectId: f.id,
      conversationId,
      objectRef: "object:tasks",
      objectRevision: "1",
      revision: 0,
    };
    assert.equal(
      (await f.work.request({ ...context, projectId: f.other })).ok,
      false,
    );
    assert.equal((await f.work.request(context)).ok, true);
    assert.ok(
      f.store.execute(
        {
          type: "saveDraft",
          id: conversationId,
          text: "保留草稿",
          revision: 0,
        },
        "main",
      ).ok,
    );
    assert.equal(
      f.store.snapshot().conversations.find((c) => c.id === second)?.draft,
      "",
    );
    const connectionId = randomUUID();
    assert.ok(
      f.store.execute(
        {
          type: "upsertConnection",
          id: connectionId,
          name: "synthetic",
          provider: "custom",
          baseUrl: "http://127.0.0.1:1/v1",
          model: "synthetic",
          secretRef: randomUUID(),
          imageInput: "unknown",
          contextChars: null,
          revision: 0,
        },
        "main",
      ).ok,
    );
    const send = {
      type: "submitTurn",
      requestId: randomUUID(),
      conversationId,
      connectionId,
      model: "synthetic",
      text: "保留草稿",
      projectContextRevision: 1,
    };
    assert.equal(
      f.store.execute({ ...send, projectContextRevision: 0 }, "main").ok,
      false,
    );
    f.projection("2");
    assert.equal(f.store.execute(send, "main").ok, false);
    assert.equal(
      f.store.snapshot().conversations.find((c) => c.id === conversationId)
        ?.draft,
      "保留草稿",
    );
    assert.equal(
      (await f.work.request({ ...context, revision: 1, objectRevision: "2" }))
        .ok,
      true,
    );
    assert.equal(
      f.store.execute({ ...send, projectContextRevision: 2 }, "main").ok,
      true,
    );
    const turn = f.store.snapshot().activeTurns[0];
    const loaded = f.store.execute(
      { type: "loadTurnContext", executionId: turn.executionId },
      "main",
      "host",
    );
    assert.ok(loaded.ok && loaded.projectContext);
    assert.equal(JSON.parse(loaded.projectContext).object.revision, "2");
    assert.ok(!loaded.projectContext.includes(f.folder));
    f.projection("3");
    const again = f.store.execute(
      { type: "loadTurnContext", executionId: turn.executionId },
      "main",
      "host",
    );
    assert.ok(again.ok);
    assert.equal(again.projectContext, loaded.projectContext);
    f.host({
      type: "runtimeGrantUpsert",
      grant: { ...f.grant, status: "revoked", revokedAt: at },
    });
    assert.equal(
      f.store.execute(
        { type: "loadTurnContext", executionId: turn.executionId },
        "main",
        "host",
      ).ok,
      false,
    );
    const before = f.store.snapshot().projects;
    f.store.close();
    const reopened = new Store(f.data);
    assert.deepEqual(reopened.snapshot().projects, before);
    assert.equal(
      reopened.db
        .prepare("SELECT count(*) AS n FROM project_turn_contexts")
        .get()?.n,
      1,
    );
    for (const action of ["delete", "purge"] as const) {
      const conv = reopened
        .snapshot()
        .conversations.find((c) => c.id === conversationId)!;
      assert.ok(
        reopened.execute(
          {
            type: "organizeConversation",
            id: conversationId,
            action,
            revision: conv.organizationRevision,
            confirmed: true,
          },
          "main",
        ).ok,
      );
    }
    assert.equal(
      reopened.db
        .prepare("SELECT count(*) AS n FROM project_turn_contexts")
        .get()?.n,
      0,
    );
    reopened.close();
  } finally {
    try {
      f.store.close();
    } catch {
      /* already closed */
    }
  }
});

test("project work: schema 24 migration preserves project identities and drafts; permanent conversation deletion clears context copies", async () => {
  const f = await fixture();
  try {
    const projectBefore = f.store
      .snapshot()
      .projects.map(({ runtime: _r, chats: _c, ...p }) => {
        void _r;
        void _c;
        return p;
      });
    const conversationId = randomUUID();
    assert.ok(
      f.store.execute({ type: "create", id: conversationId }, "main").ok,
    );
    assert.ok(
      f.store.execute(
        {
          type: "saveDraft",
          id: conversationId,
          text: "迁移前草稿",
          revision: 0,
        },
        "main",
      ).ok,
    );
    f.store.close();
    const db = new DatabaseSync(join(f.data, "state.sqlite"));
    db.exec(
      "DROP TABLE project_turn_contexts;DROP TABLE project_chats;DROP TABLE project_runtime;PRAGMA user_version=24",
    );
    db.close();
    const migrated = new Store(f.data);
    try {
      assert.equal(
        migrated.db.prepare("PRAGMA user_version").get()?.user_version,
        26,
      );
      assert.deepEqual(
        migrated.snapshot().projects.map(({ runtime: _r, chats: _c, ...p }) => {
          void _r;
          void _c;
          return p;
        }),
        projectBefore,
      );
      assert.equal(
        migrated.snapshot().conversations.find((c) => c.id === conversationId)
          ?.draft,
        "迁移前草稿",
      );
      const chat = randomUUID();
      assert.ok(
        migrated.execute(
          {
            type: "projectWork",
            request: { type: "chat", projectId: f.id, conversationId: chat },
          },
          "main",
          "host",
        ).ok,
      );
      const c = () =>
        migrated.snapshot().conversations.find((c) => c.id === chat)!;
      assert.ok(
        migrated.execute(
          {
            type: "organizeConversation",
            id: chat,
            action: "delete",
            revision: c().organizationRevision,
            confirmed: true,
          },
          "main",
        ).ok,
      );
      assert.ok(
        migrated.execute(
          {
            type: "organizeConversation",
            id: chat,
            action: "purge",
            revision: c().organizationRevision,
            confirmed: true,
          },
          "main",
        ).ok,
      );
      assert.equal(
        migrated.snapshot().projects.find((p) => p.id === f.id)?.chats.length,
        0,
      );
    } finally {
      migrated.close();
    }
  } finally {
    try {
      f.store.close();
    } catch {
      /* closed */
    }
  }
});
