import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../../src/service/store";
import { inspectProjectFolder } from "../../src/main/projects";
import { ProjectAccess } from "../../src/main/project-access";
import { ProjectWorkspace } from "../../src/main/project-work";
import {
  accessLifetimeDays,
  accessOperations,
  validProjectAccessRequest,
  type ProjectAccessReply,
} from "../../src/shared/project-access";
import {
  contractDigest,
  contractVersion,
  runtimeLimits,
  type RuntimeGrant,
  type RuntimeInstallation,
  type RuntimeInstance,
  type RuntimeScope,
} from "../../src/shared/runtime-host";
import { warmSystemGit } from "./git-warmup";

const digest = "a".repeat(64);
const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const capabilities = ["csthink.test.one", "csthink.test.two"];
function installation(): RuntimeInstallation {
  return {
    installationId: "installation:one",
    runtimeId: "runtime:test-access",
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
    capabilities: capabilities.map((id) => ({
      id,
      version: "1",
      schemaDigest: digest,
      required: false,
    })),
    executionProfileRequirements: [],
    launcher: { launcher: "direct", binaryDigest: "", version: "" },
    entrypoint: "bin/runtime",
    argv: ["${instanceDir}"],
    source: { kind: "offline-import", reference: "test" },
    incompatibility: null,
    checkedFiles: 4,
    expandedBytes: 100,
    importedAt: at,
  };
}
function instance(state: RuntimeInstance["state"] = "ready"): RuntimeInstance {
  return {
    instanceId: "instance:one",
    installationId: "installation:one",
    createdAt: at,
    state,
    incarnationId: "incarnation:a",
    connectionId: "connection:a",
    controlGeneration: "1",
    pid: 4242,
    startedAt: at,
    launchArgv: [],
    launchDirectories: {
      runtimeRoot: "/r",
      packageDir: "/r/packages/runtime_test-access/" + digest,
      instanceDir: "/r/instances/instance_one",
    },
    exit: null,
    negotiation: {
      selectedProtocol: { version: contractVersion, contractDigest },
      capabilities: capabilities.map((id) => ({
        id,
        version: "1",
        schemaDigest: digest,
        required: false,
      })),
      executionProfiles: [],
      limits: runtimeLimits,
    },
    failure: null,
    health: { result: "ok", reason: "", at },
    updatedAt: at,
  };
}

before(warmSystemGit);

/** A real business store and a Host stand-in whose Runtime answers are scripted. */
async function fixture(projects = 1) {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/project-access-"));
  const folder = join(root, "folder");
  const data = join(root, "data");
  mkdirSync(folder);
  mkdirSync(data);
  const store = new Store(data);
  const exec = (c: unknown) => {
    const r = store.execute(c, "main", "host");
    assert.ok(r.ok, JSON.stringify(r));
    return r;
  };
  const info = await inspectProjectFolder(folder);
  const ids = Array.from({ length: projects }, () => randomUUID());
  ids.forEach((id, i) =>
    exec({
      type: "projectCreate",
      id,
      name: i ? "另一个项目" : "接入项目",
      goal: "",
      folder: info,
    }),
  );
  exec({ type: "runtimeInstall", installation: installation() });
  exec({ type: "runtimeInstanceUpsert", instance: instance() });
  const runtime = {
    refuseOpen: "",
    refuseAuthorize: "",
    opened: 0,
    authorized: 0,
  };
  const calls: string[] = [];
  const scopeOf = (instanceId: string, handle: string) =>
    store
      .snapshot()
      .runtimeScopes.find(
        (s) => s.instanceId === instanceId && s.resourceHandle === handle,
      );
  const host = {
    async registerResource(path: string) {
      calls.push("register");
      const real = realpathSync(path);
      const resource = {
        handle:
          "resource:" +
          createHash("sha256").update(real).digest("hex").slice(0, 32),
        kind: "directory" as const,
        path: real,
        registeredAt: at,
      };
      exec({ type: "runtimeResourceRegister", resource });
      return resource;
    },
    async openScope(instanceId: string, handle: string) {
      calls.push("open");
      if (runtime.refuseOpen)
        throw Object.assign(new Error(runtime.refuseOpen), {
          code: "PERMISSION_DENIED",
        });
      runtime.opened += 1;
      const scope: RuntimeScope = scopeOf(instanceId, handle) ?? {
        instanceId,
        installationId: "installation:one",
        scopeRef: "scope:one",
        bindingRef: "binding:one",
        resourceHandle: handle,
        state: "inactive",
        grantRefs: [],
        freshness: "missing",
        cursor: null,
        revision: null,
        snapshotId: null,
        subscriptionId: null,
        lastError: null,
        updatedAt: at,
      };
      exec({ type: "runtimeScopeUpsert", scope });
      return scope;
    },
    async grantBatch(
      instanceId: string,
      scopeRef: string,
      pairs: { capability: string; operation: string }[],
      purpose: string,
      lifetimeMs: number,
    ) {
      calls.push("grantBatch");
      const scope = store
        .snapshot()
        .runtimeScopes.find((s) => s.scopeRef === scopeRef)!;
      const expiresAt = new Date(Date.now() + lifetimeMs)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
      const grants: RuntimeGrant[] = pairs.map((p) => ({
        ref: { id: "grant:" + randomUUID(), revision: "1" },
        installationId: "installation:one",
        instanceId,
        scopeRef,
        resourceHandle: scope.resourceHandle,
        capability: p.capability,
        operation: p.operation,
        executionRef: null,
        bundleDigest: digest,
        expiresAt,
        status: "active",
        purpose,
        createdAt: at,
        revokedAt: null,
      }));
      exec({ type: "runtimeGrantBatch", grants });
      return grants;
    },
    async authorize(instanceId: string, scopeRef: string) {
      calls.push("authorize");
      if (runtime.refuseAuthorize)
        throw Object.assign(new Error(runtime.refuseAuthorize), {
          code: "PERMISSION_DENIED",
        });
      runtime.authorized += 1;
      const s = store.snapshot();
      const scope = s.runtimeScopes.find((x) => x.scopeRef === scopeRef)!;
      const grantRefs = s.runtimeGrants
        .filter(
          (g) =>
            g.instanceId === instanceId &&
            g.scopeRef === scopeRef &&
            g.status === "active",
        )
        .map((g) => g.ref);
      const next: RuntimeScope = {
        ...scope,
        state: grantRefs.length ? "active" : "inactive",
        grantRefs,
      };
      delete next.counts;
      exec({ type: "runtimeScopeUpsert", scope: next });
      return next;
    },
    async revokeGrants(instanceId: string, grantIds: string[]) {
      calls.push("revokeGrants");
      const grants = store
        .snapshot()
        .runtimeGrants.filter(
          (g) => g.instanceId === instanceId && grantIds.includes(g.ref.id),
        )
        .map((g) => ({ ...g, status: "revoked" as const, revokedAt: at }));
      exec({ type: "runtimeGrantBatch", grants });
      return grants.length;
    },
    async sync() {
      calls.push("sync");
    },
  };
  const access = new ProjectAccess({
    snapshot: () => store.snapshot(),
    host: host as never,
  });
  const ask = (c: Parameters<ProjectAccess["request"]>[0]) =>
    access.request(c) as Promise<ProjectAccessReply>;
  return { root, folder, store, exec, ids, runtime, calls, ask, info };
}

test("项目接入正常路径：登记只记录文件夹身份，打开范围得到未授权 scope，核对的授权范围按摘要绑定并在同一事务建立全部授权，scope 变为已授权", async () => {
  const f = await fixture();
  const projectId = f.ids[0];
  let r = await f.ask({ type: "read", projectId });
  assert.ok(r.ok);
  assert.equal(r.view.resource, null);
  assert.equal(r.view.folder.path, f.info.canonicalPath);
  assert.equal(r.view.instances.length, 1);
  assert.equal(r.view.instances[0].ready, true);
  assert.equal(r.view.instances[0].instanceDir, "/r/instances/instance_one");
  assert.equal(r.view.instances[0].proposal, null, "no scope, no proposal");
  // Opening before registering is refused with the actual reason.
  r = await f.ask({ type: "open", projectId, instanceId: "instance:one" });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.message : "", /请先登记项目文件夹/);
  r = await f.ask({ type: "register", projectId });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.view.resource?.path, f.info.canonicalPath);
  assert.match(r.message ?? "", /未读取或修改文件夹内容/);
  // Registering again is a no-op, not a second resource.
  r = await f.ask({ type: "register", projectId });
  assert.ok(r.ok);
  assert.equal(f.store.snapshot().runtimeResources.length, 1);
  r = await f.ask({ type: "open", projectId, instanceId: "instance:one" });
  assert.ok(r.ok, JSON.stringify(r));
  const entry = r.view.instances[0];
  assert.equal(entry.scope?.state, "inactive");
  assert.equal(entry.scope?.activeGrants, 0);
  assert.deepEqual(entry.proposal?.capabilities, capabilities);
  assert.deepEqual(entry.proposal?.operations, {
    read: [...accessOperations.read],
    act: [...accessOperations.act],
  });
  assert.equal(entry.proposal?.lifetimeDays, accessLifetimeDays);
  assert.equal(entry.proposal?.folder, f.info.canonicalPath);
  r = await f.ask({
    type: "authorize",
    projectId,
    instanceId: "instance:one",
    scopeRef: entry.scope!.scopeRef,
    proposalDigest: entry.proposalDigest!,
  });
  assert.ok(r.ok, JSON.stringify(r));
  const grants = f.store.snapshot().runtimeGrants;
  assert.equal(grants.length, capabilities.length * 8);
  assert.equal(new Set(grants.map((g) => g.createdAt)).size, 1);
  assert.equal(new Set(grants.map((g) => g.expiresAt)).size, 1);
  assert.ok(grants.every((g) => g.purpose === "项目仓库治理接入：接入项目"));
  const days = (Date.parse(grants[0].expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > accessLifetimeDays - 0.01 && days <= accessLifetimeDays);
  assert.deepEqual(
    [...new Set(grants.map((g) => g.operation))].sort(),
    [...accessOperations.read, ...accessOperations.act].sort(),
  );
  assert.equal(r.view.instances[0].scope?.state, "active");
  assert.equal(r.view.instances[0].scope?.activeGrants, grants.length);
  assert.deepEqual(f.calls, [
    "register",
    "open",
    "grantBatch",
    "authorize",
    "sync",
  ]);
});

test("项目接入授权到期与撤销：没有可用授权时说明最近一次是到期还是撤销及其时间，重新核对后以新的授权引用恢复", async () => {
  const f = await fixture();
  const projectId = f.ids[0];
  const iso = (ms: number) =>
    new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  await f.ask({ type: "register", projectId });
  let r = await f.ask({ type: "open", projectId, instanceId: "instance:one" });
  assert.ok(r.ok, JSON.stringify(r));
  let entry = r.view.instances[0];
  assert.equal(entry.scope?.ended, null, "never authorized: nothing ended");
  const authorize = () =>
    f.ask({
      type: "authorize",
      projectId,
      instanceId: "instance:one",
      scopeRef: entry.scope!.scopeRef,
      proposalDigest: entry.proposalDigest!,
    });
  r = await authorize();
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.view.instances[0].scope?.ended, null);
  const first = f.store.snapshot().runtimeGrants;
  // The period runs out before the Host has marked the grants: they no longer count and the view says expired.
  const past = iso(Date.now() - 60_000);
  f.exec({
    type: "runtimeGrantBatch",
    grants: first.map((g) => ({ ...g, expiresAt: past })),
  });
  r = await f.ask({ type: "read", projectId });
  assert.ok(r.ok);
  entry = r.view.instances[0];
  assert.equal(entry.scope?.activeGrants, 0);
  assert.equal(entry.scope?.expiresAt, null);
  assert.deepEqual(entry.scope?.ended, { reason: "expired", at: past });
  assert.ok(entry.proposal, "a new review is offered");
  // A new review re-authorizes with new references; the expired ones are not revived.
  r = await authorize();
  assert.ok(r.ok, JSON.stringify(r));
  entry = r.view.instances[0];
  assert.equal(entry.scope?.state, "active");
  assert.equal(entry.scope?.activeGrants, first.length);
  assert.equal(entry.scope?.ended, null);
  const second = f.store
    .snapshot()
    .runtimeGrants.filter((g) => !first.some((o) => o.ref.id === g.ref.id));
  assert.equal(second.length, first.length);
  // Revoked later: the most recent end is the revocation, not the earlier expiry.
  const revokedAt = iso(Date.now());
  f.exec({
    type: "runtimeGrantBatch",
    grants: second.map((g) => ({
      ...g,
      status: "revoked" as const,
      revokedAt,
    })),
  });
  r = await f.ask({ type: "read", projectId });
  assert.ok(r.ok);
  assert.deepEqual(r.view.instances[0].scope?.ended, {
    reason: "revoked",
    at: revokedAt,
  });
});

test("项目接入拒绝与恢复：扩展拒绝打开范围时不留 scope 并说明原因，恢复后可打开；授权摘要不符或能力变化时拒绝且不建立授权；扩展拒绝授权时本次授权全部撤回", async () => {
  const f = await fixture();
  const projectId = f.ids[0];
  await f.ask({ type: "register", projectId });
  f.runtime.refuseOpen =
    "no instance binding file: hp-binding.json is absent from the instance directory";
  let r = await f.ask({ type: "open", projectId, instanceId: "instance:one" });
  assert.equal(r.ok, false);
  assert.match(
    !r.ok ? r.message : "",
    /扩展未打开项目范围（PERMISSION_DENIED：no instance binding file/,
  );
  assert.equal(f.store.snapshot().runtimeScopes.length, 0);
  // The binding is written and the extension reconnected: the same step now succeeds.
  f.runtime.refuseOpen = "";
  r = await f.ask({ type: "open", projectId, instanceId: "instance:one" });
  assert.ok(r.ok, JSON.stringify(r));
  const entry = r.view.instances[0];
  // A digest that is not the reviewed proposal is refused before any grant is written.
  r = await f.ask({
    type: "authorize",
    projectId,
    instanceId: "instance:one",
    scopeRef: entry.scope!.scopeRef,
    proposalDigest: "b".repeat(64),
  });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.message : "", /授权范围已变化/);
  assert.equal(f.store.snapshot().runtimeGrants.length, 0);
  // The negotiated capabilities change after the review: the old digest no longer matches.
  const changed = instance();
  changed.negotiation!.capabilities = changed.negotiation!.capabilities.slice(
    0,
    1,
  );
  f.exec({ type: "runtimeInstanceUpsert", instance: changed });
  r = await f.ask({
    type: "authorize",
    projectId,
    instanceId: "instance:one",
    scopeRef: entry.scope!.scopeRef,
    proposalDigest: entry.proposalDigest!,
  });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.message : "", /授权范围已变化/);
  assert.equal(f.store.snapshot().runtimeGrants.length, 0);
  // The Runtime refuses the authorization: the batch is revoked, nothing stays usable.
  f.runtime.refuseAuthorize = "grant set incomplete";
  const current = r.view!.instances[0];
  r = await f.ask({
    type: "authorize",
    projectId,
    instanceId: "instance:one",
    scopeRef: current.scope!.scopeRef,
    proposalDigest: current.proposalDigest!,
  });
  assert.equal(r.ok, false);
  assert.match(
    !r.ok ? r.message : "",
    /扩展拒绝授权，已撤回本次授权记录（PERMISSION_DENIED：grant set incomplete）/,
  );
  const grants = f.store.snapshot().runtimeGrants;
  assert.equal(grants.length, 8);
  assert.ok(grants.every((g) => g.status === "revoked"));
  assert.equal(r.view?.instances[0].scope?.activeGrants, 0);
  // Recovered: a new reviewed authorization mints new references.
  f.runtime.refuseAuthorize = "";
  r = await f.ask({
    type: "authorize",
    projectId,
    instanceId: "instance:one",
    scopeRef: current.scope!.scopeRef,
    proposalDigest: r.view!.instances[0].proposalDigest!,
  });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(
    f.store.snapshot().runtimeGrants.filter((g) => g.status === "active")
      .length,
    8,
  );
});

test("项目接入的资源身份：文件夹被替换时每一步都拒绝且不登记；同一文件夹的项目范围已由另一项目关联时拒绝打开与授权；实例未就绪时说明实际状态", async () => {
  const f = await fixture(2);
  const [a, b] = f.ids;
  // Another project already linked to the scope of the same folder.
  await f.ask({ type: "register", projectId: a });
  let r = await f.ask({
    type: "open",
    projectId: a,
    instanceId: "instance:one",
  });
  const entry = r.ok ? r.view.instances[0] : undefined;
  r = await f.ask({
    type: "authorize",
    projectId: a,
    instanceId: "instance:one",
    scopeRef: entry!.scope!.scopeRef,
    proposalDigest: entry!.proposalDigest!,
  });
  assert.ok(r.ok, JSON.stringify(r));
  f.exec({
    type: "runtimeScopeUpsert",
    scope: {
      ...f.store.snapshot().runtimeScopes[0],
      freshness: "current",
    },
  });
  const workspace = new ProjectWorkspace({
    snapshot: () => f.store.snapshot(),
    host: {
      projection: async () => null,
      roleBinding: async () => null,
    } as never,
    profiles: () => [],
    save: async (c) => f.store.execute(c, "main", "host"),
  });
  const project = f.store.snapshot().projects.find((p) => p.id === a)!;
  const bound = await workspace.request({
    type: "bind",
    projectId: a,
    instanceId: "instance:one",
    scopeRef: entry!.scope!.scopeRef,
    revision: project.revision,
  });
  assert.ok(bound.ok, JSON.stringify(bound));
  r = await f.ask({ type: "read", projectId: b });
  assert.ok(r.ok);
  assert.equal(r.view.instances[0].scope?.linkedElsewhere?.name, "接入项目");
  assert.equal(r.view.instances[0].scope?.linkedHere, false);
  r = await f.ask({ type: "open", projectId: b, instanceId: "instance:one" });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.message : "", /已由项目“接入项目”关联/);
  // Instance not ready: the reason names the actual state.
  f.exec({ type: "runtimeInstanceUpsert", instance: instance("exited") });
  r = await f.ask({ type: "open", projectId: a, instanceId: "instance:one" });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.message : "", /扩展实例未就绪（连接异常/);
  // The folder is replaced: identity re-check refuses before anything is registered.
  const g = await fixture();
  renameSync(g.folder, g.folder + "-moved");
  mkdirSync(g.folder);
  r = await g.ask({ type: "register", projectId: g.ids[0] });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.message : "", /项目文件夹身份已变化/);
  assert.equal(g.store.snapshot().runtimeResources.length, 0);
  assert.deepEqual(g.calls, []);
});

test("项目接入请求闭集与并发：多余字段、非 UUID 项目、畸形摘要均拒绝；同一项目同时两步只执行一步", async () => {
  const projectId = randomUUID();
  assert.equal(validProjectAccessRequest({ type: "read", projectId }), true);
  assert.equal(
    validProjectAccessRequest({ type: "read", projectId, extra: 1 }),
    false,
  );
  assert.equal(
    validProjectAccessRequest({ type: "read", projectId: "x" }),
    false,
  );
  assert.equal(
    validProjectAccessRequest({
      type: "open",
      projectId,
      instanceId: "instance:one",
    }),
    true,
  );
  assert.equal(
    validProjectAccessRequest({
      type: "authorize",
      projectId,
      instanceId: "instance:one",
      scopeRef: "scope:one",
      proposalDigest: "short",
    }),
    false,
  );
  assert.equal(validProjectAccessRequest({ type: "grant", projectId }), false);
  const f = await fixture();
  const [first, second] = await Promise.all([
    f.ask({ type: "register", projectId: f.ids[0] }),
    f.ask({ type: "register", projectId: f.ids[0] }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(!second.ok ? second.message : "", /上一步接入仍在进行/);
  assert.equal(f.calls.filter((c) => c === "register").length, 1);
});
