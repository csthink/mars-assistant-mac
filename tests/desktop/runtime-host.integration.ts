import { test, expect, type ElectronApplication } from "@playwright/test";
import { launchLocal } from "./local-client";
import { buildBundle, newPublisher } from "./runtime-fakes/bundle";
import { buildFake, listFakeEntry } from "./runtime-fakes/build";
import { LIST_CAPABILITY, LIST_SCHEMA } from "./runtime-fakes/list-contract";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RuntimeHost } from "../../src/main/runtime-host";
import { digestOf } from "../../src/main/runtime-admission";
import type { RuntimeSnapshot } from "../../src/shared/runtime-host";

/**
 * Drives the production Runtime Host inside the real Electron main process (exposed by
 * the background entry) against the list-domain fake: resources, scopes, grants,
 * snapshot paging, subscription replacement, event ordering rules, acknowledgements,
 * Host-issued operations with lost answers and recovery, reconnect and resume.
 */
type Host = RuntimeHost;
declare global {
  var runtimeHost: Host;
}
function fixture() {
  mkdirSync(".test-data/disposable", { recursive: true });
  const dir = mkdtempSync(resolve(".test-data/disposable/runtime-host-"));
  mkdirSync(join(dir, "data"));
  mkdirSync(join(dir, "project"));
  const bundle = buildBundle(join(dir, "bundle"), newPublisher(), {
    runtimeId: "runtime:test-list",
    version: "1",
    entrypoint: "list-fake.cjs",
    entrypointBytes: buildFake(listFakeEntry),
    launcher: "electron-node",
    argv: ["${instanceDir}", "${contractDigest}"],
    capabilities: [{ capability: LIST_CAPABILITY, schema: LIST_SCHEMA }],
  });
  return {
    dir,
    root: join(dir, "data"),
    project: join(dir, "project"),
    bundle: bundle.dir,
  };
}
async function launch(root: string) {
  const app = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
    cwd: resolve("."),
  });
  const page = await app.firstWindow();
  await expect(
    page
      .locator(".home-header")
      .getByRole("button", { name: "新建对话", exact: true }),
  ).toBeEnabled();
  return app;
}
/** The Host reads the same snapshot records the renderer sees. */
const records = (app: ElectronApplication) =>
  app.evaluate(() => globalThis.runtimeHost.records() as RuntimeSnapshot);
/** The list domain's event stream as its state file records it: every event the domain has written. */
const domainStream = (r: RuntimeSnapshot) =>
  (
    JSON.parse(
      readFileSync(
        join(r.runtimeInstances[0].launchArgv[2], "list-runtime", "state.json"),
        "utf8",
      ),
    ) as { stream: { streamId: string; epoch: string; seq: number } }
  ).stream;
/**
 * Waits until the projection is current and the Host scope's cursor has reached the last event the
 * domain has written (all events of the transactions so far applied). A cursor that has not moved for
 * a moment does not show this: the next event of the same transaction can still be on its way.
 */
const quiescent = async (app: ElectronApplication, ms = 10_000) => {
  const start = Date.now();
  for (;;) {
    const r = await records(app);
    const scope = r.runtimeScopes[0];
    if (scope?.freshness === "current" && scope.cursor) {
      const stream = domainStream(r);
      if (
        scope.cursor.streamId === stream.streamId &&
        scope.cursor.epoch === stream.epoch &&
        Number(scope.cursor.seq) === stream.seq
      )
        return r;
    }
    if (Date.now() - start > ms)
      throw new Error(
        "projection did not settle: " + JSON.stringify(scope).slice(0, 300),
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const until = async <T>(
  read: () => Promise<T>,
  predicate: (v: T) => boolean,
  ms = 10_000,
) => {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() - start > ms)
      throw new Error("timeout: " + JSON.stringify(value).slice(0, 400));
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("runtime host: resource, scope, grant, authorize, snapshot paging and subscription bring the projection to current; invokes flow through events and acks; lost answers recover by operation query", async () => {
  const f = fixture();
  const app = await launch(f.root);
  try {
    const setup = await app.evaluate(
      async ({ app: _app }, { bundle, project }) => {
        void _app;
        const host = globalThis.runtimeHost;
        const imported = await host.supervisor.importBundle(
          bundle,
          "integration",
        );
        if (!imported.ok) throw new Error(JSON.stringify(imported));
        const instances = host.supervisor.installationsList();
        const instanceId = host.records()!.runtimeInstances[0].instanceId;
        const resource = await host.registerResource(project);
        const scope = await host.openScope(instanceId, resource.handle);
        const grant = await host.grant(
          instanceId,
          scope.scopeRef,
          "csthink.test.list-confirm",
          "directory.read",
          "integration test",
        );
        const authorized = await host.authorize(instanceId, scope.scopeRef);
        await host.sync(instanceId, scope.scopeRef);
        return {
          installations: instances.length,
          instanceId,
          scopeRef: scope.scopeRef,
          openedState: scope.state,
          authorizedState: authorized.state,
          grantId: grant.ref.id,
          resourceHandle: resource.handle,
        };
      },
      { bundle: f.bundle, project: f.project },
    );
    expect(setup.installations).toBe(1);
    expect(setup.openedState).toBe("inactive");
    expect(setup.authorizedState).toBe("active");
    const { instanceId, scopeRef } = setup;
    const current = await until(
      () => records(app),
      (r) => r.runtimeScopes[0]?.freshness === "current",
    );
    const scope = current.runtimeScopes[0];
    expect(scope.state).toBe("active");
    expect(scope.grantRefs).toEqual([{ id: setup.grantId, revision: "1" }]);
    expect(scope.cursor).toEqual({
      streamId: "stream:list",
      epoch: "epoch:1",
      seq: "0",
    });
    expect(scope.counts).toEqual({
      objects: 1,
      actions: 2,
      actionsEnabled: 2,
      pending: 0,
      blocking: 0,
    });
    expect(scope.subscriptionId).toBe("subscription:1");
    // Invoke: the operation is persisted, answered, and its events arrive in order and are acknowledged.
    const created = await app.evaluate(
      ({ app: _app }, { instanceId, scopeRef }) => {
        void _app;
        return globalThis.runtimeHost.invoke(instanceId, scopeRef, {
          actionId: "entry.create",
          objectRef: "directory:root",
          payload: {
            choice: "create",
            arguments: { title: "第一条", group: "inbox" },
          },
        });
      },
      { instanceId, scopeRef },
    );
    expect(created.status).toBe("succeeded");
    expect(created.transport).toBe("answered");
    expect(created.origin).toBe("host");
    expect(created.reason).toBe("created e1");
    const afterCreate = await quiescent(app);
    expect(afterCreate.runtimeScopes[0].counts).toEqual({
      objects: 2,
      actions: 4,
      actionsEnabled: 4,
      pending: 1,
      blocking: 1,
    });
    expect(Number(afterCreate.runtimeScopes[0].cursor?.seq)).toBeGreaterThan(0);
    const operation = afterCreate.runtimeOperations.find(
      (o) => o.operationId === created.operationId,
    )!;
    expect(operation.status).toBe("succeeded");
    expect(operation.revision).toBe("op-rev:1");
    const projection = await app.evaluate(
      ({ app: _app }, { instanceId, scopeRef }) => {
        void _app;
        return globalThis.runtimeHost.projection(instanceId, scopeRef);
      },
      { instanceId, scopeRef },
    );
    expect(projection.objects.map((o) => o.objectRef)).toEqual([
      "directory:root",
      "entry:e1",
    ]);
    expect(projection.pendingItems[0]).toMatchObject({
      itemRef: "pending:e1",
      status: "pending",
      blocking: true,
    });
    // A disabled or unknown action is refused before anything leaves the Host; a stale projection pauses actions.
    const refused = await app.evaluate(
      async ({ app: _app }, { instanceId, scopeRef }) => {
        void _app;
        try {
          await globalThis.runtimeHost.invoke(instanceId, scopeRef, {
            actionId: "entry.explode",
            objectRef: "directory:root",
            payload: { choice: "create" },
          });
          return null;
        } catch (error) {
          return {
            code: (error as { code: string }).code,
            recovery: (error as { recovery: string }).recovery,
          };
        }
      },
      { instanceId, scopeRef },
    );
    expect(refused).toEqual({
      code: "PRECONDITION_CONFLICT",
      recovery: "resync",
    });
    // Retransmission keeps the original key and intent: the Runtime answers the original result, the Host record stays one operation.
    const again = await app.evaluate(
      ({ app: _app }, { instanceId, operationId }) => {
        void _app;
        return globalThis.runtimeHost.resend(instanceId, operationId);
      },
      { instanceId, operationId: created.operationId },
    );
    expect(again.status).toBe("succeeded");
    expect(again.reason).toBe("created e1");
    expect(
      (await records(app)).runtimeOperations.filter((o) => o.origin === "host"),
    ).toHaveLength(1);
    // Lost answer: the fake drops the reply; the Host records the loss and the query recovers the real result (C-03).
    const instanceDir = (await records(app)).runtimeInstances[0].launchArgv[2];
    writeFileSync(
      join(instanceDir, "fault.json"),
      JSON.stringify({ dropResponse: "runtime.action.invoke" }),
    );
    const lost = await app.evaluate(
      ({ app: _app }, { instanceId, scopeRef }) => {
        void _app;
        return globalThis.runtimeHost.invoke(instanceId, scopeRef, {
          actionId: "entry.create",
          objectRef: "directory:root",
          payload: {
            choice: "create",
            arguments: { title: "第二条", group: "later" },
          },
        });
      },
      { instanceId, scopeRef },
    );
    expect(lost.transport).toBe("lost");
    expect(lost.errorCode).toBe("TIMEOUT");
    expect(lost.status).toBe("unknown");
    writeFileSync(join(instanceDir, "fault.json"), "{}");
    const recovered = await app.evaluate(
      ({ app: _app }, { instanceId, scopeRef, operationId }) => {
        void _app;
        return globalThis.runtimeHost.operationGet(
          instanceId,
          scopeRef,
          operationId,
        );
      },
      { instanceId, scopeRef, operationId: lost.operationId },
    );
    expect(recovered.error).toBeNull();
    expect(recovered.operation?.status).toBe("succeeded");
    expect(recovered.operation?.reason).toBe("created e2");
    const settled = await quiescent(app);
    expect(settled.runtimeScopes[0].counts?.objects).toBe(3);
    // The Runtime never proved a made-up operation as accepted: NOT_FOUND with absenceProven.
    const missing = await app.evaluate(
      ({ app: _app }, { instanceId, scopeRef }) => {
        void _app;
        return globalThis.runtimeHost.operationGet(
          instanceId,
          scopeRef,
          "op:never",
        );
      },
      { instanceId, scopeRef },
    );
    expect(missing.error).toEqual({ code: "NOT_FOUND", absenceProven: true });
  } finally {
    await app.close();
  }
});

test("runtime host: duplicate events are ignored, a skipped sequence pauses and resyncs, a second subscription replaces the first, and a killed process leaves scopes stale until reconnect resumes them", async () => {
  const f = fixture();
  const app = await launch(f.root);
  try {
    const ids = await app.evaluate(
      async ({ app: _app }, { bundle, project }) => {
        void _app;
        const host = globalThis.runtimeHost;
        const imported = await host.supervisor.importBundle(
          bundle,
          "integration",
        );
        if (!imported.ok) throw new Error(JSON.stringify(imported));
        const instanceId = host.records()!.runtimeInstances[0].instanceId;
        const resource = await host.registerResource(project);
        const scope = await host.openScope(instanceId, resource.handle);
        await host.grant(
          instanceId,
          scope.scopeRef,
          "csthink.test.list-confirm",
          "directory.read",
          "integration test",
        );
        await host.authorize(instanceId, scope.scopeRef);
        await host.sync(instanceId, scope.scopeRef);
        return { instanceId, scopeRef: scope.scopeRef };
      },
      { bundle: f.bundle, project: f.project },
    );
    const { instanceId, scopeRef } = ids;
    await until(
      () => records(app),
      (r) => r.runtimeScopes[0]?.freshness === "current",
    );
    const instanceDir = (await records(app)).runtimeInstances[0].launchArgv[2];
    const invoke = (title: string) =>
      app.evaluate(
        ({ app: _app }, { instanceId, scopeRef, title }) => {
          void _app;
          return globalThis.runtimeHost.invoke(instanceId, scopeRef, {
            actionId: "entry.create",
            objectRef: "directory:root",
            payload: { choice: "create", arguments: { title, group: "inbox" } },
          });
        },
        { instanceId, scopeRef, title },
      );
    // Duplicate delivery of seq 1: applied once, projection and cursor advance once.
    writeFileSync(
      join(instanceDir, "fault.json"),
      JSON.stringify({ duplicateEvent: "1" }),
    );
    expect((await invoke("重复")).status).toBe("succeeded");
    const afterDuplicate = await quiescent(app);
    expect(afterDuplicate.runtimeScopes[0].counts?.objects).toBe(2);
    const seqAfterDuplicate = Number(
      afterDuplicate.runtimeScopes[0].cursor?.seq,
    );
    expect(afterDuplicate.runtimeScopes[0].freshness).toBe("current");
    // A skipped sequence: the gap marks the scope stale and pauses actions; the automatic resync restores current with the full projection.
    const nextSeq = String(seqAfterDuplicate + 1);
    writeFileSync(
      join(instanceDir, "fault.json"),
      JSON.stringify({ skipEvent: nextSeq }),
    );
    expect((await invoke("跳号")).status).toBe("succeeded");
    // The gap is observed first (stale), then the automatic resync restores current from a fresh snapshot.
    await until(
      () => records(app),
      (r) => r.runtimeScopes[0]?.snapshotId !== "snapshot:1",
      15_000,
    );
    const resynced = await quiescent(app, 15_000);
    expect(resynced.runtimeScopes[0].counts?.objects).toBe(3);
    expect(resynced.runtimeScopes[0].snapshotId).not.toBe("snapshot:1");
    expect(Number(resynced.runtimeScopes[0].cursor?.seq)).toBeGreaterThan(
      seqAfterDuplicate,
    );
    const state = await app.evaluate(
      ({ app: _app }, { instanceId, scopeRef }) => {
        void _app;
        return globalThis.runtimeHost.syncState(instanceId, scopeRef);
      },
      { instanceId, scopeRef },
    );
    expect(state?.resyncs).toBe(0);
    expect(state?.subscriptionId).not.toBe("subscription:1");
    writeFileSync(join(instanceDir, "fault.json"), "{}");
    // An explicit second sync replaces the subscription; the Runtime names the replaced one and the Host follows only the new one.
    const before = (await records(app)).runtimeScopes[0].subscriptionId;
    await app.evaluate(
      ({ app: _app }, { instanceId, scopeRef }) => {
        void _app;
        return globalThis.runtimeHost.sync(instanceId, scopeRef);
      },
      { instanceId, scopeRef },
    );
    const replaced = await until(
      () => records(app),
      (r) =>
        r.runtimeScopes[0]?.freshness === "current" &&
        r.runtimeScopes[0]?.subscriptionId !== before,
    );
    expect(replaced.runtimeScopes[0].subscriptionId).not.toBe(before);
    expect((await invoke("替换后")).status).toBe("succeeded");
    expect((await quiescent(app)).runtimeScopes[0].counts?.objects).toBe(4);
    // Process loss: the scope goes stale with the real reason and actions are refused; reconnect resumes scope, grants and projection.
    process.kill((await records(app)).runtimeInstances[0].pid!, "SIGKILL");
    const stale = await until(
      () => records(app),
      (r) => r.runtimeScopes[0]?.freshness === "stale",
    );
    expect(stale.runtimeScopes[0].lastError?.code).toBe("RUNTIME_EXITED");
    const paused = await app.evaluate(
      async ({ app: _app }, { instanceId, scopeRef }) => {
        void _app;
        try {
          await globalThis.runtimeHost.invoke(instanceId, scopeRef, {
            actionId: "entry.create",
            objectRef: "directory:root",
            payload: { choice: "create" },
          });
          return null;
        } catch (error) {
          return (error as { code: string }).code;
        }
      },
      { instanceId, scopeRef },
    );
    expect(paused).toBe("RESYNC_REQUIRED");
    await app.evaluate(
      ({ app: _app }, { instanceId }) => {
        void _app;
        return globalThis.runtimeHost.supervisor.reconnect(instanceId);
      },
      { instanceId },
    );
    const resumed = await until(
      () => records(app),
      (r) =>
        r.runtimeScopes[0]?.freshness === "current" &&
        r.runtimeInstances[0]?.state === "ready",
      15_000,
    );
    expect(resumed.runtimeScopes[0].state).toBe("active");
    expect(resumed.runtimeScopes[0].counts?.objects).toBe(4);
    expect(resumed.runtimeInstances[0].controlGeneration).toBe("2");
    expect((await invoke("重连后")).status).toBe("succeeded");
    expect((await quiescent(app)).runtimeScopes[0].counts?.objects).toBe(5);
  } finally {
    await app.close();
  }
});

test("runtime host: revocation replaces the authorization set at once and re-authorization mints a new reference; a human decision is recorded with its Invoke and checked by the Runtime; cancel never rewrites a completed target; tombstones, BUSY retry-later and key conflicts follow the Contract; upgrade preparation is blocked by protected references and fixed, then prepared, recovered after a lost answer and released", async () => {
  test.setTimeout(120_000);
  const f = fixture();
  const app = await launch(f.root);
  /** Runs a Host call in the main process; the function source travels as a string with its plain-data argument. */
  const evaluate = <A extends Record<string, unknown>, R>(
    fn: (host: RuntimeHost, arg: A) => Promise<R> | R,
    arg: A,
  ): Promise<R> =>
    app.evaluate(
      ({ app: _app }, { fn, arg }) => {
        void _app;
        return (
          new Function("host", "arg", "return (" + fn + ")(host, arg)") as (
            host: RuntimeHost,
            arg: unknown,
          ) => Promise<R> | R
        )(globalThis.runtimeHost, arg);
      },
      { fn: fn.toString(), arg: arg as Record<string, unknown> },
    ) as Promise<R>;
  const failure = <A extends Record<string, unknown>>(
    fn: (host: RuntimeHost, arg: A) => Promise<unknown>,
    arg: A,
  ) =>
    evaluate(
      async (host, { fn, arg }) => {
        try {
          await (
            new Function("host", "arg", "return (" + fn + ")(host, arg)") as (
              host: RuntimeHost,
              arg: unknown,
            ) => Promise<unknown>
          )(host, arg);
          return null;
        } catch (error) {
          const e = error as {
            code: string;
            recovery: string;
            message: string;
          };
          return { code: e.code, recovery: e.recovery, message: e.message };
        }
      },
      { fn: fn.toString(), arg: arg as Record<string, unknown> },
    );
  try {
    const ids = await evaluate(
      async (host, { bundle, project }) => {
        const imported = await host.supervisor.importBundle(
          bundle,
          "integration",
        );
        if (!imported.ok) throw new Error(JSON.stringify(imported));
        const instanceId = host.records()!.runtimeInstances[0].instanceId;
        const resource = await host.registerResource(project);
        const scope = await host.openScope(instanceId, resource.handle);
        const grant = await host.grant(
          instanceId,
          scope.scopeRef,
          "csthink.test.list-confirm",
          "directory.read",
          "integration test",
        );
        await host.authorize(instanceId, scope.scopeRef);
        await host.sync(instanceId, scope.scopeRef);
        await host.awaitCurrent(instanceId, scope.scopeRef);
        return { instanceId, scopeRef: scope.scopeRef, grantA: grant.ref.id };
      },
      { bundle: f.bundle, project: f.project },
    );
    const { instanceId, scopeRef } = ids;
    const instanceDir = (await records(app)).runtimeInstances[0].launchArgv[2];
    const fault = (value: Record<string, unknown>) =>
      writeFileSync(join(instanceDir, "fault.json"), JSON.stringify(value));
    const invoke = (title: string) =>
      evaluate(
        async (host, { instanceId, scopeRef, title }) => {
          await host.awaitCurrent(instanceId, scopeRef);
          return host.invoke(instanceId, scopeRef, {
            actionId: "entry.create",
            objectRef: "directory:root",
            payload: { choice: "create", arguments: { title, group: "inbox" } },
          });
        },
        { instanceId, scopeRef, title },
      );
    const created = await invoke("第一条");
    expect(created.status).toBe("succeeded");
    await quiescent(app);
    // A human action without a decision is refused by the Runtime before any effect (review).
    const undecided = await evaluate(
      (host, { instanceId, scopeRef }) =>
        host.invoke(instanceId, scopeRef, {
          actionId: "entry.confirm",
          objectRef: "entry:e1",
          payload: { choice: "confirm" },
        }),
      { instanceId, scopeRef },
    );
    expect(undecided.transport).toBe("refused");
    expect(undecided.errorCode).toBe("PERMISSION_DENIED");
    expect(undecided.recovery).toBe("review");
    // The trusted entry records the decision with the exact Invoke; the Runtime reads it back and confirms.
    const decided = await evaluate(
      (host, { instanceId, scopeRef }) =>
        host.decide(instanceId, scopeRef, {
          actionId: "entry.confirm",
          objectRef: "entry:e1",
          payload: { choice: "confirm" },
          evidence: [],
          actorRef: "actor:integration",
        }),
      { instanceId, scopeRef },
    );
    expect(decided.operation.status).toBe("succeeded");
    expect(decided.operation.reason).toBe("confirmed");
    expect(decided.decision.domainOperationId).toBe(
      decided.operation.operationId,
    );
    expect(decided.decision.status).toBe("valid");
    const confirmed = await quiescent(app);
    expect(confirmed.runtimeScopes[0].counts?.pending).toBe(0);
    expect(confirmed.runtimeDecisions[0].decisionRef).toBe(
      decided.decision.decisionRef,
    );
    // Cancel of a completed target: the cancel operation succeeds, the target stays completed.
    const cancelled = await evaluate(
      (host, { instanceId, scopeRef, target }) =>
        host.cancel(instanceId, scopeRef, target),
      { instanceId, scopeRef, target: created.operationId },
    );
    expect(cancelled.cancel.method).toBe("runtime.operation.cancel");
    expect(cancelled.cancel.status).toBe("succeeded");
    expect(cancelled.cancel.reason).toBe("target already terminal");
    expect(cancelled.target?.status).toBe("succeeded");
    expect(cancelled.target?.reason).toBe("created e1");
    const cancelAgain = await evaluate(
      (host, { instanceId, operationId }) =>
        host.resend(instanceId, operationId),
      { instanceId, operationId: cancelled.cancel.operationId },
    );
    expect(cancelAgain.status).toBe("succeeded");
    expect(cancelAgain.operationId).toBe(cancelled.cancel.operationId);
    const hostOps = (r: RuntimeSnapshot) =>
      r.runtimeOperations.filter((o) => o.origin === "host");
    expect(hostOps(await records(app))).toHaveLength(4);
    // BUSY without acceptance: recorded as refused with retry-later; the retry keeps the same key and digest.
    fault({ busy: "runtime.action.invoke" });
    const busy = await invoke("忙时");
    expect(busy.transport).toBe("refused");
    expect(busy.errorCode).toBe("BUSY");
    expect(busy.recovery).toBe("retry-later");
    fault({});
    const retried = await evaluate(
      (host, { instanceId, operationId }) =>
        host.resend(instanceId, operationId),
      { instanceId, operationId: busy.operationId },
    );
    expect(retried.operationId).toBe(busy.operationId);
    expect(retried.requestDigest).toBe(busy.requestDigest);
    expect(retried.status).toBe("succeeded");
    expect(retried.reason).toBe("created e2");
    await quiescent(app);
    // Tombstone after a lost answer: the query cannot prove absence, the retransmission answers unknown, no new operation.
    fault({
      dropResponse: "runtime.action.invoke",
      retireAfter: "entry.create",
    });
    const retired = await invoke("退役");
    expect(retired.transport).toBe("lost");
    fault({});
    const unknown = await evaluate(
      (host, { instanceId, scopeRef, operationId }) =>
        host.operationGet(instanceId, scopeRef, operationId),
      { instanceId, scopeRef, operationId: retired.operationId },
    );
    expect(unknown.error).toEqual({
      code: "RESULT_UNKNOWN",
      absenceProven: false,
    });
    expect(unknown.operation?.status).toBe("unknown");
    expect(unknown.operation?.recovery).toBe("query");
    const tombstone = await evaluate(
      (host, { instanceId, operationId }) =>
        host.resend(instanceId, operationId),
      { instanceId, operationId: retired.operationId },
    );
    expect(tombstone.transport).toBe("answered");
    expect(tombstone.status).toBe("unknown");
    expect(tombstone.reason).toBe("result retired to a tombstone");
    const afterTombstone = await quiescent(app);
    expect(afterTombstone.runtimeScopes[0].counts?.objects).toBe(4);
    expect(
      hostOps(afterTombstone).filter(
        (o) => o.method === "runtime.action.invoke",
      ),
    ).toHaveLength(5);
    // Same key, another digest: the Runtime answers IDEMPOTENCY_CONFLICT (driven on the raw connection; the Host never builds such a request).
    const forgedBody = {
      ...retried.request!,
      payload: {
        choice: "create",
        arguments: { title: "另一个意图", group: "inbox" },
      },
    };
    const forged = {
      ...forgedBody,
      requestDigest: digestOf({
        method: "runtime.action.invoke",
        ...forgedBody,
      }),
    };
    const conflict = await evaluate(
      async (host, { instanceId, forged }) => {
        try {
          await host.supervisor
            .connectionOf(instanceId)!
            .call("runtime.action.invoke", forged);
          return null;
        } catch (error) {
          return {
            code: (error as { code: string }).code,
            recovery: (error as { data: { recovery: string } }).data?.recovery,
          };
        }
      },
      { instanceId, forged },
    );
    expect(conflict).toEqual({
      code: "IDEMPOTENCY_CONFLICT",
      recovery: "review",
    });
    // Revocation: the set is replaced at once (inactive when empty), a retransmission citing the grant is refused locally,
    // the Runtime answers PERMISSION_REVOKED when the old request is replayed on the raw connection after re-authorization.
    const revoked = await evaluate(
      (host, { instanceId, grantA }) => host.revokeGrant(instanceId, grantA),
      { instanceId, grantA: ids.grantA },
    );
    expect(revoked.grant.status).toBe("revoked");
    expect(revoked.scope?.state).toBe("inactive");
    expect(revoked.scope?.grantRefs).toEqual([]);
    const denied = await failure(
      (host, { instanceId, scopeRef }) =>
        host.invoke(instanceId, scopeRef, {
          actionId: "entry.create",
          objectRef: "directory:root",
          payload: { choice: "create" },
        }),
      { instanceId, scopeRef },
    );
    expect(denied).toMatchObject({
      code: "PERMISSION_DENIED",
      recovery: "reauthorize",
    });
    const replayed = await evaluate(
      (host, { instanceId, operationId }) =>
        host.resend(instanceId, operationId),
      { instanceId, operationId: created.operationId },
    );
    expect(replayed.transport).toBe("refused");
    expect(replayed.errorCode).toBe("PERMISSION_REVOKED");
    const reauthorized = await evaluate(
      async (host, { instanceId, scopeRef }) => {
        const grant = await host.grant(
          instanceId,
          scopeRef,
          "csthink.test.list-confirm",
          "directory.read",
          "integration test (re-authorized)",
        );
        const scope = await host.authorize(instanceId, scopeRef);
        return { grantB: grant.ref.id, scope };
      },
      { instanceId, scopeRef },
    );
    expect(reauthorized.grantB).not.toBe(ids.grantA);
    expect(reauthorized.scope.state).toBe("active");
    expect(reauthorized.scope.grantRefs).toEqual([
      { id: reauthorized.grantB, revision: "1" },
    ]);
    const grants = (await records(app)).runtimeGrants;
    expect(grants.map((g) => g.status).sort()).toEqual(["active", "revoked"]);
    expect(grants.find((g) => g.ref.id === ids.grantA)?.status).toBe("revoked");
    const runtimeRevoked = await evaluate(
      async (host, { instanceId, operationId }) => {
        const op = host
          .records()!
          .runtimeOperations.find((o) => o.operationId === operationId)!;
        try {
          await host.supervisor
            .connectionOf(instanceId)!
            .call("runtime.action.invoke", {
              ...op.request!,
              requestDigest: op.requestDigest,
            });
          return null;
        } catch (error) {
          return { code: (error as { code: string }).code };
        }
      },
      { instanceId, operationId: created.operationId },
    );
    expect(runtimeRevoked).toEqual({ code: "PERMISSION_REVOKED" });
    expect((await invoke("重新授权后")).status).toBe("succeeded");
    await quiescent(app);
    // Upgrade: an unconfirmed entry is a protected reference; blocked is fixed even when retransmitted.
    const target = { bundleDigest: "b".repeat(64), dataFormat: "test.f2" };
    const blocked = await evaluate(
      (host, { instanceId, target }) => host.upgradePrepare(instanceId, target),
      { instanceId, target },
    );
    expect(blocked.result.hostBarrier.established).toBe(true);
    expect(blocked.result.upgrade?.status).toBe("blocked");
    expect(blocked.result.upgrade?.barrierRef).toBeNull();
    expect(
      blocked.result.upgrade?.protectedReferences.map((r) => r.objectRef),
    ).toEqual(expect.arrayContaining(["entry:e2"]));
    expect(blocked.result.proceedable).toBe(false);
    expect(blocked.result.hostBarrier.releasedAt).not.toBeNull();
    const blockedAgain = await evaluate(
      (host, { instanceId, operationId }) =>
        host.resend(instanceId, operationId),
      { instanceId, operationId: blocked.operationId },
    );
    expect((blockedAgain as typeof blocked).result.upgrade?.status).toBe(
      "blocked",
    );
    // Confirm every entry through the trusted entry, then prepare: the answer is dropped, the record is recovered, the barrier holds.
    const pendingRefs = (
      await evaluate(
        (host, { instanceId, scopeRef }) =>
          host.projection(instanceId, scopeRef),
        { instanceId, scopeRef },
      )
    ).pendingItems
      .filter((item) => item.status === "pending")
      .map((item) => item.objectRef);
    expect(pendingRefs).toEqual(["entry:e2", "entry:e3", "entry:e4"]);
    for (const objectRef of pendingRefs) {
      // Each confirmation's events settle before the next decision reads the projection.
      await quiescent(app);
      const confirmed = await evaluate(
        (host, { instanceId, scopeRef, objectRef }) =>
          host.decide(instanceId, scopeRef, {
            actionId: "entry.confirm",
            objectRef,
            payload: { choice: "confirm" },
            evidence: [],
            actorRef: "actor:integration",
          }),
        { instanceId, scopeRef, objectRef },
      );
      expect(confirmed.operation.status).toBe("succeeded");
    }
    expect((await quiescent(app)).runtimeScopes[0].counts?.pending).toBe(0);
    fault({ dropResponse: "runtime.upgrade.prepare" });
    const lostPrepare = await evaluate(
      (host, { instanceId, target }) => host.upgradePrepare(instanceId, target),
      { instanceId, target },
    );
    fault({});
    expect(lostPrepare.transport).toBe("lost");
    expect(lostPrepare.result.upgrade).toBeNull();
    const held = await failure(
      (host, { instanceId, scopeRef }) =>
        host.invoke(instanceId, scopeRef, {
          actionId: "entry.create",
          objectRef: "directory:root",
          payload: { choice: "create" },
        }),
      { instanceId, scopeRef },
    );
    expect(held?.code).toBe("PRECONDITION_CONFLICT");
    expect(held?.message).toContain("upgrade barrier");
    const recovered = await evaluate(
      (host, { instanceId, operationId }) =>
        host.upgradeGet(instanceId, operationId),
      { instanceId, operationId: lostPrepare.operationId },
    );
    expect(recovered.result.upgrade?.status).toBe("prepared");
    expect(recovered.result.upgrade?.barrierRef).toMatch(/^barrier:/);
    expect(recovered.result.proceedable).toBe(true);
    const wrongDisposition = await failure(
      (host, { instanceId, operationId }) =>
        host.upgradeRelease(instanceId, operationId, "activated"),
      { instanceId, operationId: lostPrepare.operationId },
    );
    expect(wrongDisposition?.code).toBe("PRECONDITION_CONFLICT");
    const released = await evaluate(
      (host, { instanceId, operationId }) =>
        host.upgradeRelease(instanceId, operationId, "restored"),
      { instanceId, operationId: lostPrepare.operationId },
    );
    expect(released.release.method).toBe("runtime.upgrade.release");
    expect(released.release.status).toBe("succeeded");
    expect(released.prepare.result.upgrade?.status).toBe("released");
    expect(released.prepare.result.upgrade?.releasedDomainRevision).toMatch(
      /^rev:/,
    );
    expect(released.prepare.result.hostBarrier.releasedAt).not.toBeNull();
    expect((await invoke("释放后")).status).toBe("succeeded");
  } finally {
    await app.close();
  }
});
