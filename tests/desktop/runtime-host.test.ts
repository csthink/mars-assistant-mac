import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../../src/service/store";
import { RuntimeHost } from "../../src/main/runtime-host";
import { RpcFailure } from "../../src/main/runtime-supervisor";
import type { ExecutionPort } from "../../src/main/runtime-execution-port";
import {
  contractDigest,
  contractVersion,
  type RuntimeHostCommand,
  type RuntimeInstallation,
  type RuntimeInstance,
} from "../../src/shared/runtime-host";

/**
 * Runtime-to-host services with a real business Store in-process and a stub
 * connection: grants, decisions, context capture and Host-authority reads, and the
 * execution port dispatch (no port in the product build, a stub port for the
 * reservation, query and cancel bookkeeping).
 */
mkdirSync(".test-data/disposable", { recursive: true });
const sha256 = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
const digest = "a".repeat(64);
const installation: RuntimeInstallation = {
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
  argv: [],
  source: { kind: "offline-import", reference: "test" },
  incompatibility: null,
  checkedFiles: 4,
  expandedBytes: 100,
  importedAt: "2026-09-19T00:00:00Z",
};
const instance = (id: string): RuntimeInstance => ({
  instanceId: id,
  installationId: "installation:one",
  createdAt: "2026-09-19T00:00:00Z",
  state: "ready",
  incarnationId: "incarnation:a",
  connectionId: "connection:" + id,
  controlGeneration: "1",
  pid: null,
  startedAt: null,
  launchArgv: [],
  exit: null,
  negotiation: null,
  failure: null,
  health: null,
  updatedAt: "2026-09-19T00:00:00Z",
});
type Inbound = (
  connection: unknown,
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
function harness() {
  const dir = mkdtempSync(resolve(".test-data/disposable/runtime-host-unit-"));
  const store = new Store(join(dir));
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let chunks:
    ((params: Record<string, unknown>) => Record<string, unknown>) | null =
    null;
  const host = new RuntimeHost({
    runtimeRoot: join(dir, "runtimes"),
    descriptor: {
      platform: "darwin-arm64",
      osVersion: "27.0",
      electronExecutable: process.execPath,
      pythonCandidates: [],
    },
    request: async (command: RuntimeHostCommand) =>
      store.execute(command, "main", "host"),
    records: () => store.snapshot(),
  });
  const context = (instanceId: string) => ({
    protocolVersion: contractVersion,
    contractDigest,
    controlGeneration: "1",
    installationId: "installation:one",
    instanceId,
    incarnationId: "incarnation:a",
    connectionId: "connection:" + instanceId,
  });
  const connection = (instanceId: string) => ({
    context: context(instanceId),
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "runtime.resource.read" && chunks) return chunks(params);
      throw new Error("unexpected call " + method);
    },
  });
  const inbound = (host as unknown as { inbound: Inbound }).inbound.bind(
    host,
  ) as Inbound;
  const seed = () => {
    store.execute({ type: "runtimeInstall", installation }, "main", "host");
    store.execute(
      { type: "runtimeInstanceUpsert", instance: instance("instance:one") },
      "main",
      "host",
    );
    store.execute(
      { type: "runtimeInstanceUpsert", instance: instance("instance:two") },
      "main",
      "host",
    );
    store.execute(
      {
        type: "runtimeResourceRegister",
        resource: {
          handle: "resource:dir",
          kind: "directory",
          path: dir,
          registeredAt: "2026-09-19T00:00:00Z",
        },
      },
      "main",
      "host",
    );
    for (const [instanceId, scopeRef] of [
      ["instance:one", "scope:a"],
      ["instance:one", "scope:b"],
      ["instance:two", "scope:c"],
    ])
      store.execute(
        {
          type: "runtimeScopeUpsert",
          scope: {
            instanceId,
            installationId: "installation:one",
            scopeRef,
            bindingRef: "binding:" + scopeRef.slice(6),
            resourceHandle: "resource:dir",
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
  };
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      assert.ok(
        error instanceof RpcFailure,
        "RpcFailure expected, got " + String(error),
      );
      return error;
    }
    assert.fail("call succeeded unexpectedly");
  };
  return {
    dir,
    store,
    host,
    inbound,
    connection,
    seed,
    failure,
    calls,
    setChunks: (fn: typeof chunks) => (chunks = fn),
  };
}

test("host.grants.get returns only this instance's grants with their current status and never mints one; host.decision.get proves the absence of an unknown record; malformed requests are refused", async () => {
  const h = harness();
  try {
    h.seed();
    const one = await h.host.grant(
      "instance:one",
      "scope:a",
      "csthink.test.list-confirm",
      "directory.read",
      "test",
    );
    const expired = await h.host.grant(
      "instance:one",
      "scope:a",
      "csthink.test.list-confirm",
      "directory.write",
      "test",
    );
    h.store.execute(
      {
        type: "runtimeGrantUpsert",
        grant: { ...expired, expiresAt: "2020-01-01T00:00:00Z" },
      },
      "main",
      "host",
    );
    const other = await h.host.grant(
      "instance:two",
      "scope:c",
      "csthink.test.list-confirm",
      "directory.read",
      "test",
    );
    const result = await h.inbound(
      h.connection("instance:one"),
      "host.grants.get",
      {
        grantRefs: [
          one.ref,
          expired.ref,
          other.ref,
          { id: "grant:none", revision: "1" },
        ],
      },
    );
    const grants = result.grants as {
      ref: { id: string };
      status: string;
      createdAt?: string;
    }[];
    assert.deepEqual(
      grants.map((g) => [g.ref.id, g.status]).sort(),
      [
        [one.ref.id, "active"],
        [expired.ref.id, "expired"],
      ].sort(),
    );
    assert.equal(
      "createdAt" in grants[0],
      false,
      "bookkeeping fields stay in the Host",
    );
    assert.equal(
      (
        await h.failure(
          h.inbound(h.connection("instance:one"), "host.grants.get", {
            grantRefs: "x",
          }),
        )
      ).code,
      "PRECONDITION_CONFLICT",
    );
    const decision = await h.failure(
      h.inbound(h.connection("instance:one"), "host.decision.get", {
        scopeRef: "scope:a",
        decisionRef: "decision:1",
      }),
    );
    assert.equal(decision.code, "NOT_FOUND");
    assert.equal(
      decision.absenceProven,
      true,
      "the decision index is complete",
    );
    assert.equal(decision.recovery, "review");
    assert.equal(
      (
        await h.failure(
          h.inbound(h.connection("instance:one"), "host.unknown", {}),
        )
      ).code,
      "PRECONDITION_CONFLICT",
    );
    const missing = await h.failure(
      h.inbound(h.connection("instance:one"), "host.context.get", {
        scopeRef: "scope:a",
        operationId: "op:none",
      }),
    );
    assert.equal(missing.code, "NOT_FOUND");
    assert.equal(missing.absenceProven, true);
  } finally {
    h.store.close();
  }
});

test("context capture copies authorized runtime evidence into immutable Host snapshots and host.resource.read serves them only within the same scope with a usable grant; refusals: inactive scope, uncovered source, digest mismatch, cross-scope, revoked grant, key conflict", async () => {
  const h = harness();
  try {
    h.seed();
    const bytes = Buffer.from("证据内容 evidence bytes ".repeat(20000), "utf8");
    const source = {
      authority: "runtime",
      resourceHandle: "resource:dir",
      scopeRef: "scope:a",
      objectRef: "entry:e1",
      revision: "rev:3",
      mediaType: "text/plain",
      bytes: bytes.length,
      digest: sha256(bytes),
    };
    h.setChunks((params) => {
      const offset = params.offset as number;
      const length = params.length as number;
      const slice = bytes.subarray(offset, offset + length);
      return {
        resourceHandle: source.resourceHandle,
        revision: source.revision,
        offset,
        dataBase64: slice.toString("base64"),
        eof: offset + slice.length >= bytes.length,
        digest: source.digest,
      };
    });
    const capture = (overrides: Record<string, unknown> = {}) => ({
      operationId: "op:cap-1",
      idempotencyKey: "key:cap-1",
      requestDigest: "c".repeat(64),
      scopeRef: "scope:a",
      domainOperationId: "op:domain-1",
      sources: [source],
      grantRefs: [] as unknown[],
      ...overrides,
    });
    // No grant covers the source resource: refused before any read.
    assert.equal(
      (
        await h.failure(
          h.inbound(
            h.connection("instance:one"),
            "host.context.capture",
            capture(),
          ),
        )
      ).code,
      "PERMISSION_DENIED",
    );
    assert.equal(h.calls.length, 0);
    const grant = await h.host.grant(
      "instance:one",
      "scope:a",
      "csthink.test.list-confirm",
      "directory.read",
      "test",
    );
    const receipt = await h.inbound(
      h.connection("instance:one"),
      "host.context.capture",
      capture({ grantRefs: [grant.ref] }),
    );
    assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
    assert.equal(receipt.domainOperationId, "op:domain-1");
    const snapshots = receipt.snapshots as {
      source: unknown;
      snapshot: Record<string, unknown>;
    }[];
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].snapshot.authority, "host");
    assert.equal(snapshots[0].snapshot.digest, source.digest);
    assert.equal(snapshots[0].snapshot.bytes, bytes.length);
    assert.ok(
      h.calls.filter((c) => c.method === "runtime.resource.read").length >= 2,
      "bounded chunks",
    );
    const stored = h.store.snapshot().runtimeContextSnapshots[0];
    assert.equal(
      readFileSync(join(h.dir, "runtimes", "context", stored.file)).equals(
        bytes,
      ),
      true,
    );
    // The lost-answer path: same key and digest returns the stored receipt without reading again; another digest conflicts.
    const before = h.calls.length;
    assert.deepEqual(
      await h.inbound(
        h.connection("instance:one"),
        "host.context.capture",
        capture({ grantRefs: [grant.ref] }),
      ),
      receipt,
    );
    assert.equal(h.calls.length, before);
    assert.deepEqual(
      await h.inbound(h.connection("instance:one"), "host.context.get", {
        scopeRef: "scope:a",
        operationId: "op:cap-1",
      }),
      receipt,
    );
    assert.equal(
      (
        await h.failure(
          h.inbound(
            h.connection("instance:one"),
            "host.context.capture",
            capture({ grantRefs: [grant.ref], requestDigest: "d".repeat(64) }),
          ),
        )
      ).code,
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(
      (
        await h.failure(
          h.inbound(h.connection("instance:one"), "host.context.get", {
            scopeRef: "scope:b",
            operationId: "op:cap-1",
          }),
        )
      ).code,
      "PERMISSION_DENIED",
    );
    // Host-authority read of the snapshot: same scope with the grant succeeds chunk by chunk; the digest is the full content digest.
    const evidence = snapshots[0].snapshot;
    const first = await h.inbound(
      h.connection("instance:one"),
      "host.resource.read",
      {
        scopeRef: "scope:a",
        evidence,
        grantRefs: [grant.ref],
        offset: 0,
        length: 16,
      },
    );
    assert.equal(
      Buffer.from(first.dataBase64 as string, "base64").toString("utf8"),
      bytes.subarray(0, 16).toString("utf8"),
    );
    assert.equal(first.eof, false);
    assert.equal(first.digest, source.digest);
    const last = await h.inbound(
      h.connection("instance:one"),
      "host.resource.read",
      {
        scopeRef: "scope:a",
        evidence,
        grantRefs: [grant.ref],
        offset: bytes.length - 5,
        length: 100,
      },
    );
    assert.equal(last.eof, true);
    // Refusals: runtime authority, other scope (C-08), other instance, stale revision, revoked grant.
    assert.equal(
      (
        await h.failure(
          h.inbound(h.connection("instance:one"), "host.resource.read", {
            scopeRef: "scope:a",
            evidence: source,
            grantRefs: [grant.ref],
            offset: 0,
            length: 16,
          }),
        )
      ).code,
      "PERMISSION_DENIED",
    );
    assert.equal(
      (
        await h.failure(
          h.inbound(h.connection("instance:one"), "host.resource.read", {
            scopeRef: "scope:b",
            evidence: { ...evidence, scopeRef: "scope:b" },
            grantRefs: [grant.ref],
            offset: 0,
            length: 16,
          }),
        )
      ).code,
      "PERMISSION_DENIED",
    );
    const foreign = await h.failure(
      h.inbound(h.connection("instance:two"), "host.resource.read", {
        scopeRef: "scope:c",
        evidence: { ...evidence, scopeRef: "scope:c" },
        grantRefs: [],
        offset: 0,
        length: 16,
      }),
    );
    assert.equal(foreign.code, "NOT_FOUND");
    assert.equal(foreign.absenceProven, true);
    assert.equal(
      (
        await h.failure(
          h.inbound(h.connection("instance:one"), "host.resource.read", {
            scopeRef: "scope:a",
            evidence: { ...evidence, revision: "rev:9" },
            grantRefs: [grant.ref],
            offset: 0,
            length: 16,
          }),
        )
      ).code,
      "PRECONDITION_CONFLICT",
    );
    h.store.execute(
      {
        type: "runtimeGrantUpsert",
        grant: {
          ...grant,
          ref: { id: grant.ref.id, revision: "2" },
          status: "revoked",
          revokedAt: "2026-09-19T01:00:00Z",
        },
      },
      "main",
      "host",
    );
    assert.equal(
      (
        await h.failure(
          h.inbound(h.connection("instance:one"), "host.resource.read", {
            scopeRef: "scope:a",
            evidence,
            grantRefs: [grant.ref],
            offset: 0,
            length: 16,
          }),
        )
      ).code,
      "PERMISSION_REVOKED",
    );
    // A source whose bytes do not match the declared digest fails the capture and leaves no snapshot.
    const grant2 = await h.host.grant(
      "instance:one",
      "scope:a",
      "csthink.test.list-confirm",
      "directory.read",
      "test",
    );
    h.setChunks((params) => ({
      resourceHandle: source.resourceHandle,
      revision: source.revision,
      offset: params.offset,
      dataBase64: Buffer.from("tampered").toString("base64"),
      eof: true,
      digest: source.digest,
    }));
    const failed = await h.inbound(
      h.connection("instance:one"),
      "host.context.capture",
      capture({
        operationId: "op:cap-2",
        idempotencyKey: "key:cap-2",
        grantRefs: [grant2.ref],
      }),
    );
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.snapshots, []);
    assert.equal(h.store.snapshot().runtimeContextSnapshots.length, 1);
    assert.equal(
      h.store
        .snapshot()
        .runtimeOperations.find((o) => o.operationId === "op:cap-2")
        ?.resultCode,
      "SOURCE_UNRESOLVED",
    );
    // An inactive scope refuses capture outright.
    h.store.execute(
      {
        type: "runtimeScopeUpsert",
        scope: {
          ...h.store
            .snapshot()
            .runtimeScopes.find((s) => s.scopeRef === "scope:b")!,
          counts: undefined,
          state: "inactive",
        },
      },
      "main",
      "host",
    );
    assert.equal(
      (
        await h.failure(
          h.inbound(
            h.connection("instance:one"),
            "host.context.capture",
            capture({
              operationId: "op:cap-3",
              idempotencyKey: "key:cap-3",
              scopeRef: "scope:b",
              sources: [{ ...source, scopeRef: "scope:b" }],
              grantRefs: [grant2.ref],
            }),
          ),
        )
      ).code,
      "PERMISSION_DENIED",
    );
  } finally {
    h.store.close();
  }
});

test("execution services: without a port preflight is unsupported and start is refused; with a registered port the reservation is persisted before the target starts, and get, cancel and operation.get answer from the records; unknown references prove absence", async () => {
  const h = harness();
  try {
    h.seed();
    const grant = await h.host.grant(
      "instance:one",
      "scope:a",
      "csthink.test.list-confirm",
      "graph.execute",
      "test",
    );
    const binding = {
      profileDigest: "e".repeat(64),
      agent: "agent:fake",
      model: "model:fake",
      modelVendor: "vendor:fake",
      routeVendor: null,
      credentialRef: "credential:none",
      configurationRevision: "1",
    };
    const preflight = {
      scopeRef: "scope:a",
      profileId: "profile:fake",
      profileDigest: "e".repeat(64),
      connectionRef: "connection:x",
      configurationRevision: "1",
      executionBinding: binding,
      constraints: [
        {
          kind: "tool",
          value: "read-only",
          enforcer: "agent",
          guarantee: "agent-declared",
        },
      ],
    };
    const unsupported = await h.inbound(
      h.connection("instance:one"),
      "host.execution.preflight",
      preflight,
    );
    assert.equal(unsupported.status, "unsupported");
    assert.equal(
      (unsupported.checks as { id: string; passed: boolean }[])[0].passed,
      false,
    );
    const start = (overrides: Record<string, unknown> = {}) => ({
      operationId: "op:exec-1",
      idempotencyKey: "key:exec-1",
      requestDigest: "f".repeat(64),
      scopeRef: "scope:a",
      profileId: "profile:fake",
      profileDigest: "e".repeat(64),
      domainOperationId: "op:domain-1",
      domainNodeRef: "node:implement",
      roleIntent: "implementer",
      resourceHandle: "resource:dir",
      targetBinding: { resourceHandle: "resource:dir", relativePath: "src" },
      connectionRef: "connection:x",
      configurationRevision: "1",
      model: "model:fake",
      executionBinding: binding,
      constraints: [],
      decisionRef: null,
      grantRefs: [grant.ref],
      contextRefs: [],
      budget: {
        maxToolCalls: 1,
        maxRunSeconds: 1,
        maxOutputBytes: 1,
        cleanupSeconds: 1,
      },
      ...overrides,
    });
    assert.equal(
      (
        await h.failure(
          h.inbound(
            h.connection("instance:one"),
            "host.execution.start",
            start(),
          ),
        )
      ).code,
      "UNSUPPORTED_CAPABILITY",
    );
    assert.equal(
      (
        await h.failure(
          h.inbound(
            h.connection("instance:one"),
            "host.execution.start",
            start({
              targetBinding: {
                resourceHandle: "resource:dir",
                relativePath: "../escape",
              },
            }),
          ),
        )
      ).code,
      "PRECONDITION_CONFLICT",
    );
    assert.equal(
      (
        await h.failure(
          h.inbound(
            h.connection("instance:one"),
            "host.execution.start",
            start({ executionBinding: { ...binding, model: "model:other" } }),
          ),
        )
      ).code,
      "PRECONDITION_CONFLICT",
    );
    assert.equal(
      (
        await h.failure(
          h.inbound(
            h.connection("instance:one"),
            "host.execution.start",
            start({
              constraints: [
                {
                  kind: "tool",
                  value: "x",
                  enforcer: "agent",
                  guarantee: "interface-enforced",
                },
              ],
            }),
          ),
        )
      ).code,
      "PRECONDITION_CONFLICT",
    );
    assert.equal(
      (
        await h.failure(
          h.inbound(
            h.connection("instance:one"),
            "host.execution.start",
            start({ grantRefs: [] }),
          ),
        )
      ).code,
      "PERMISSION_DENIED",
    );
    assert.equal(
      h.store.snapshot().runtimeOperations.length,
      0,
      "refusals leave no operation",
    );
    // A stub port: the reservation is persisted before start, and the physical record is answered by the port.
    const events: string[] = [];
    const port: ExecutionPort = {
      id: "port:stub",
      profiles: () => [
        {
          id: "profile:fake",
          version: "1",
          digest: "e".repeat(64),
          trustModel: "current-user",
          purpose: "coding-implementer",
          programIdentity: {
            launcher: "/usr/bin/true",
            binaryDigest: digest,
            version: "1",
          },
          nativeApprovalPolicy: "auto-deny",
          configurationDigest: digest,
          capabilities: [],
          limitations: [],
          operations: ["graph.execute"],
          maxContextBytes: 1024,
          maxToolCalls: 1,
          maxRunSeconds: 1,
        },
      ],
      preflight: async () => [{ id: "binary", passed: true, detail: "ok" }],
      start: async (executionRef) => {
        events.push(
          "start:" +
            h.store
              .snapshot()
              .runtimeOperations.find((o) => o.executionRef === executionRef)
              ?.status,
        );
        return { status: "running", state: "running" };
      },
      get: async (executionRef) => ({
        executionRef,
        scopeRef: "scope:a",
        state: "running",
      }),
      cancel: async () => {
        events.push("cancel");
        return { status: "succeeded", reason: "stopped" };
      },
    };
    h.host.registerExecutionPort(port);
    assert.equal(
      (
        await h.inbound(
          h.connection("instance:one"),
          "host.execution.preflight",
          preflight,
        )
      ).status,
      "supported",
    );
    const accepted = await h.inbound(
      h.connection("instance:one"),
      "host.execution.start",
      start(),
    );
    assert.equal(accepted.status, "running");
    assert.match(String(accepted.executionRef), /^execution:/);
    assert.deepEqual(
      events,
      ["start:accepted"],
      "the reservation was persisted before the port started",
    );
    assert.deepEqual(
      await h.inbound(
        h.connection("instance:one"),
        "host.execution.start",
        start(),
      ),
      accepted,
      "same key and digest answers the same operation",
    );
    assert.equal(
      (
        await h.failure(
          h.inbound(
            h.connection("instance:one"),
            "host.execution.start",
            start({ requestDigest: "0".repeat(64) }),
          ),
        )
      ).code,
      "IDEMPOTENCY_CONFLICT",
    );
    const physical = await h.inbound(
      h.connection("instance:one"),
      "host.execution.get",
      { scopeRef: "scope:a", executionRef: accepted.executionRef },
    );
    // HostExecutionGetResult is the PhysicalExecution itself, never wrapped.
    assert.equal(physical.state, "running");
    assert.equal("execution" in physical, false);
    assert.equal(
      (
        await h.inbound(h.connection("instance:one"), "host.operation.get", {
          scopeRef: "scope:a",
          operationId: "op:exec-1",
        })
      ).executionRef,
      accepted.executionRef,
    );
    assert.equal(
      (
        await h.failure(
          h.inbound(h.connection("instance:one"), "host.execution.get", {
            scopeRef: "scope:b",
            executionRef: accepted.executionRef,
          }),
        )
      ).code,
      "PERMISSION_DENIED",
    );
    const cancelled = await h.inbound(
      h.connection("instance:one"),
      "host.execution.cancel",
      {
        operationId: "op:cancel-1",
        idempotencyKey: "key:cancel-1",
        requestDigest: "1".repeat(64),
        scopeRef: "scope:a",
        executionRef: accepted.executionRef,
      },
    );
    assert.equal(cancelled.status, "succeeded");
    assert.deepEqual(events, ["start:accepted", "cancel"]);
    const unknown = await h.failure(
      h.inbound(h.connection("instance:one"), "host.operation.get", {
        scopeRef: "scope:a",
        operationId: "op:never",
      }),
    );
    assert.equal(unknown.code, "NOT_FOUND");
    assert.equal(unknown.absenceProven, true);
    assert.equal(
      (
        await h.failure(
          h.inbound(h.connection("instance:one"), "host.execution.cancel", {
            operationId: "op:cancel-2",
            idempotencyKey: "key:cancel-2",
            requestDigest: "2".repeat(64),
            scopeRef: "scope:a",
            executionRef: "execution:none",
          }),
        )
      ).absenceProven,
      true,
    );
    assert.equal(
      existsSync(join(h.dir, "runtimes")),
      false,
      "no package or context directory was created by execution bookkeeping",
    );
  } finally {
    h.store.close();
  }
});

const capabilityId = "csthink.test.list-confirm";
const wireCapability = {
  id: capabilityId,
  version: contractVersion,
  schemaDigest: digest,
  required: true,
};
/** A current projection with one action that requires a human decision and one that does not. */
function projectionCurrent(h: ReturnType<typeof harness>, scopeRef: string) {
  const object = (objectRef: string) => ({
    scopeRef,
    objectRef,
    revision: "rev:1",
    title: objectRef,
    stateLabel: "ok",
    capability: wireCapability,
    view: { kind: "list", rows: [{ id: "a", title: "标题", detail: "细节" }] },
    evidence: [],
  });
  const action = (
    actionId: string,
    objectRef: string,
    human: boolean,
    candidateRef: string | null,
  ) => ({
    scopeRef,
    actionId,
    objectRef,
    capability: wireCapability,
    label: actionId,
    expectedRevision: "rev:1",
    candidateRef,
    payloadSchemaDigest: digest,
    enabled: true,
    disabledReason: "",
    disabledCode: null,
    requiresHumanDecision: human,
  });
  for (const command of [
    {
      type: "runtimeProjectionReplace",
      instanceId: "instance:one",
      scopeRef,
      pages: [
        {
          scopeRef,
          snapshotId: "snapshot:1",
          revision: "rev:1",
          streamId: "stream:list",
          epoch: "epoch:1",
          throughSeq: "0",
          expiresAt: "2026-09-19T00:01:00Z",
          objects: [object("directory:root"), object("entry:e1")],
          actions: [
            action("entry.create", "directory:root", false, null),
            action("entry.confirm", "entry:e1", true, "entry-candidate:e1.r1"),
          ],
          pendingItems: [],
          nextPageToken: null,
        },
      ],
    },
    {
      type: "runtimeCaughtUp",
      instanceId: "instance:one",
      scopeRef,
      streamId: "stream:list",
      epoch: "epoch:1",
      throughSeq: "0",
    },
  ])
    assert.equal(h.store.execute(command, "main", "host").ok, true);
  assert.equal(h.host.scope("instance:one", scopeRef)?.freshness, "current");
}

test("S-03 Host services without a live connection: a decision and its Invoke commit together and host.decision.get answers it only to the owning scope; revoking a grant or a decision takes effect from the record; expiry is marked before the next operation; the Host upgrade barrier refuses preparation while an execution is in flight and refuses user actions while it holds", async () => {
  const h = harness();
  try {
    h.seed();
    projectionCurrent(h, "scope:a");
    const grant = await h.host.grant(
      "instance:one",
      "scope:a",
      capabilityId,
      "directory.read",
      "unit",
    );
    h.store.execute(
      {
        type: "runtimeScopeUpsert",
        scope: {
          ...h.host.scope("instance:one", "scope:a")!,
          grantRefs: [grant.ref],
          counts: undefined,
        },
      },
      "main",
      "host",
    );
    // decide: record and pending Invoke persist before the send; the send fails here (no connection) and is recorded as refused.
    const decided = await h.host.decide("instance:one", "scope:a", {
      actionId: "entry.confirm",
      objectRef: "entry:e1",
      payload: { choice: "confirm" },
      evidence: [],
      actorRef: "actor:mars",
    });
    assert.equal(
      decided.decision.domainOperationId,
      decided.operation.operationId,
    );
    assert.equal(
      decided.decision.requestDigest,
      decided.operation.requestDigest,
    );
    assert.equal(decided.decision.candidateRef, "entry-candidate:e1.r1");
    assert.equal(decided.operation.transport, "refused");
    assert.equal(decided.operation.errorCode, "PRECONDITION_CONFLICT");
    assert.equal(decided.operation.recovery, "reconnect");
    assert.equal(h.store.snapshot().runtimeDecisions.length, 1);
    assert.equal(
      h.store.snapshot().runtimeOperations[0].request?.decisionRef,
      decided.decision.decisionRef,
    );
    const record = await h.inbound(
      h.connection("instance:one"),
      "host.decision.get",
      { scopeRef: "scope:a", decisionRef: decided.decision.decisionRef },
    );
    assert.deepEqual(
      Object.keys(record).sort(),
      [
        "actionId",
        "actorRef",
        "candidateRef",
        "decisionRef",
        "domainOperationId",
        "evidence",
        "expectedRevision",
        "method",
        "objectRef",
        "recordedAt",
        "requestDigest",
        "scopeRef",
        "source",
        "status",
      ],
      "the wire record carries no Host bookkeeping",
    );
    assert.equal(record.status, "valid");
    assert.equal(record.source, "host-trusted-ui");
    const otherScope = await h.failure(
      h.inbound(h.connection("instance:one"), "host.decision.get", {
        scopeRef: "scope:b",
        decisionRef: decided.decision.decisionRef,
      }),
    );
    assert.equal(otherScope.code, "PERMISSION_DENIED");
    const otherInstance = await h.failure(
      h.inbound(h.connection("instance:two"), "host.decision.get", {
        scopeRef: "scope:c",
        decisionRef: decided.decision.decisionRef,
      }),
    );
    assert.equal(otherInstance.code, "NOT_FOUND");
    assert.equal(otherInstance.absenceProven, true);
    // A revoked decision: the record answers revoked and a retransmission of its Invoke never leaves the Host.
    const revokedDecision = await h.host.revokeDecision(
      "instance:one",
      decided.decision.decisionRef,
    );
    assert.equal(revokedDecision.status, "revoked");
    assert.equal(
      (
        await h.inbound(h.connection("instance:one"), "host.decision.get", {
          scopeRef: "scope:a",
          decisionRef: decided.decision.decisionRef,
        })
      ).status,
      "revoked",
    );
    const resent = await h.host.resend(
      "instance:one",
      decided.operation.operationId,
    );
    assert.equal(resent.transport, "refused");
    assert.equal(resent.errorCode, "PERMISSION_REVOKED");
    assert.equal(resent.recovery, "review");
    assert.equal(h.calls.length, 0, "nothing was sent through the connection");
    // Grant revocation without a connection: the record is revoked at once, the scope drops the ref, re-authorization happens on resume.
    const revoked = await h.host.revokeGrant("instance:one", grant.ref.id);
    assert.equal(revoked.grant.status, "revoked");
    assert.ok(revoked.grant.revokedAt);
    assert.deepEqual(revoked.scope?.grantRefs, []);
    assert.equal(
      (
        (
          await h.inbound(h.connection("instance:one"), "host.grants.get", {
            grantRefs: [grant.ref],
          })
        ).grants as { status: string }[]
      )[0].status,
      "revoked",
    );
    const twice = await h.host.revokeGrant("instance:one", grant.ref.id);
    assert.equal(twice.grant.revokedAt, revoked.grant.revokedAt);
    const unknownGrant = await h.failure(
      h.host.revokeGrant("instance:one", "grant:none"),
    );
    assert.equal(unknownGrant.code, "NOT_FOUND");
    // Expiry: a grant past its expiry is marked expired before the next Host-issued operation.
    const short = await h.host.grant(
      "instance:one",
      "scope:a",
      capabilityId,
      "directory.read",
      "unit",
      1,
    );
    h.store.execute(
      {
        type: "runtimeScopeUpsert",
        scope: {
          ...h.host.scope("instance:one", "scope:a")!,
          grantRefs: [short.ref],
          counts: undefined,
        },
      },
      "main",
      "host",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const refreshed = await h.failure(
      h.host.invoke("instance:one", "scope:a", {
        actionId: "entry.create",
        objectRef: "directory:root",
        payload: { choice: "create" },
      }),
    );
    assert.equal(
      refreshed.code,
      "PRECONDITION_CONFLICT",
      "the set must be replaced before the action, and there is no connection to do it",
    );
    assert.equal(
      h.store.snapshot().runtimeGrants.find((g) => g.ref.id === short.ref.id)
        ?.status,
      "expired",
    );
    assert.equal(h.calls.length, 0, "no Invoke left the Host");
    h.store.execute(
      {
        type: "runtimeScopeUpsert",
        scope: {
          ...h.host.scope("instance:one", "scope:a")!,
          grantRefs: [],
          counts: undefined,
        },
      },
      "main",
      "host",
    );
    // Host upgrade barrier: an execution in flight blocks the preparation before anything is sent.
    h.store.execute(
      {
        type: "runtimeOperationUpsert",
        operation: {
          operationId: "op:exec-1",
          installationId: "installation:one",
          instanceId: "instance:one",
          scopeRef: "scope:a",
          method: "host.execution.start",
          origin: "runtime",
          idempotencyKey: "key:exec-1",
          requestDigest: digest,
          request: null,
          status: "running",
          resultCode: null,
          reason: "",
          resultRef: null,
          executionRef: "execution:1",
          revision: "2",
          result: { portId: "port:test" },
          transport: null,
          errorCode: null,
          recovery: null,
          createdAt: "2026-09-19T00:00:00Z",
          updatedAt: "2026-09-19T00:00:00Z",
        },
      },
      "main",
      "host",
    );
    const target = { bundleDigest: "b".repeat(64), dataFormat: "test.f2" };
    const blocked = await h.host.upgradePrepare("instance:one", target);
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.resultCode, "HOST_BARRIER");
    assert.equal(blocked.transport, null);
    assert.equal(blocked.result.hostBarrier.established, false);
    assert.deepEqual(
      blocked.result.hostBarrier.checks.map((c) => [c.id, c.passed]),
      [
        ["physical-execution", false],
        ["pending-request", true],
        ["version-reference", true],
      ],
    );
    assert.equal(h.calls.length, 0);
    h.store.execute(
      {
        type: "runtimeOperationUpsert",
        operation: {
          ...(await h.store
            .snapshot()
            .runtimeOperations.find((o) => o.operationId === "op:exec-1")!),
          status: "succeeded",
        },
      },
      "main",
      "host",
    );
    // With the checks passed the Host barrier is established and the prepare is sent; here the send is refused
    // (no connection), which leaves the barrier unresolved: user actions and a second preparation are refused.
    const unresolved = await h.host.upgradePrepare("instance:one", target);
    assert.equal(unresolved.result.hostBarrier.established, true);
    assert.equal(unresolved.transport, "refused");
    assert.equal(unresolved.result.proceedable, false);
    const held = await h.failure(
      h.host.invoke("instance:one", "scope:a", {
        actionId: "entry.create",
        objectRef: "directory:root",
        payload: { choice: "create" },
      }),
    );
    assert.equal(held.code, "PRECONDITION_CONFLICT");
    assert.match(held.message, /upgrade barrier/);
    const second = await h.host.upgradePrepare("instance:one", target);
    assert.equal(second.resultCode, "HOST_BARRIER");
    assert.equal(
      second.result.hostBarrier.checks.find((c) => c.id === "version-reference")
        ?.passed,
      false,
    );
    const notProceedable = await h.failure(
      h.host.upgradeRelease("instance:one", unresolved.operationId, "restored"),
    );
    assert.equal(notProceedable.code, "PRECONDITION_CONFLICT");
    const noSuchUpgrade = await h.failure(
      h.host.upgradeGet("instance:one", "op:none"),
    );
    assert.equal(noSuchUpgrade.code, "NOT_FOUND");
    assert.equal(noSuchUpgrade.absenceProven, true);
  } finally {
    h.store.close();
  }
});

// ---------------------------------------------------------------- S-04 (feature-t30): stop unconfirmed blocks release, entry switch and upgrades
test("S-04 stop unconfirmed holds the Host's references: the upgrade barrier's physical-execution check names the unconfirmed stop, quiesce (the handoff path) and the supervisor's handoff shutdown are refused PRECONDITION_CONFLICT with reason stop-unconfirmed; revoking a grant on the resource takes effect at once (OD-329 b), reconnect and reverify are not refused; once the Host has confirmed the stop every one of them is allowed again", async () => {
  const h = harness();
  try {
    h.seed();
    const grant = await h.host.grant(
      "instance:one",
      "scope:a",
      "csthink.test.list-confirm",
      "list.read",
      "S-04",
    );
    const at = "2026-09-19T01:00:00Z";
    const base = {
      executionRef: "execution:s04",
      scopeRef: "scope:a",
      state: "reserved" as const,
      connectionRef: "connection:claude-1",
      configurationRevision: "1",
      model: "claude-synthetic",
      requestIdentity: {
        operationId: "op:exec-s04",
        requestDigest: "d".repeat(64),
        profileDigest: "c".repeat(64),
      },
      supervisor: null,
      approvalDecisionRefs: [],
      actualBinding: null,
      stopReason: null,
      accounting: null,
      exit: null,
      observationCompleteness: "unknown" as const,
      resultRef: null,
      reason: "reservation persisted",
      installationId: "installation:one",
      instanceId: "instance:one",
      operationId: "op:exec-s04",
      portId: "embedded",
      profileId: "coding-implementer/claude-print-restricted",
      roleIntent: "role:implementer",
      domainNodeRef: "node:implement",
      domainOperationId: "op:domain-s04",
      resourceHandle: "resource:dir",
      targetBinding: null,
      agent: "agent:claude-code",
      connectionId: null,
      executionId: "exec-row-s04",
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
    };
    const operation = (status: "accepted" | "running" | "cancelled") => ({
      operationId: "op:exec-s04",
      installationId: "installation:one",
      instanceId: "instance:one",
      scopeRef: "scope:a",
      method: "host.execution.start" as const,
      origin: "runtime" as const,
      idempotencyKey: "key:exec-s04",
      requestDigest: "d".repeat(64),
      request: null,
      status,
      resultCode: null,
      reason: "",
      resultRef: null,
      executionRef: "execution:s04",
      revision: status === "accepted" ? "1" : status === "running" ? "2" : "3",
      result: { portId: "embedded" },
      transport: null,
      errorCode: null,
      recovery: null,
      createdAt: at,
      updatedAt: at,
    });
    const upsert = (command: RuntimeHostCommand) => {
      const reply = h.store.execute(command, "main", "host");
      assert.equal(reply.ok, true, JSON.stringify(reply));
    };
    const target = {
      pid: 4242,
      uid: 501,
      startSeconds: 1000,
      startMicros: 0,
      path: "/opt/claude",
      parent: 1,
      group: 4242,
      session: 4242,
      registeredAt: at,
    };
    upsert({
      type: "runtimeExecutionUpsert",
      record: base,
      operation: operation("accepted"),
      event: { kind: "submitted", payload: {} },
      pending: null,
    });
    upsert({
      type: "runtimeExecutionUpsert",
      record: {
        ...base,
        state: "running",
        target,
        releasedAt: at,
        observationCompleteness: "complete",
        reason: "released",
      },
      operation: operation("running"),
      event: { kind: "started", payload: { pid: 4242 } },
      pending: null,
    });
    const escaped = {
      identity: {
        pid: 4243,
        startTime: "2026-09-19T01:00:01Z",
        image: "/bin/sleep",
      },
      session: 4243,
      kind: "registered" as const,
    };
    upsert({
      type: "runtimeExecutionUpsert",
      record: {
        ...base,
        state: "stopping",
        target,
        releasedAt: at,
        cancelRequestedAt: at,
        exit: { code: null, signal: "SIGTERM", pipesClosed: true },
        exitClassification: "children-remaining",
        observationCompleteness: "partial",
        reason:
          "stop unconfirmed after cancelled: 1 process(es) outside the target session still alive (4243)",
        stopUnconfirmed: {
          since: at,
          targetIdentity: {
            pid: 4242,
            startTime: "2026-09-19T01:00:00Z",
            image: "/opt/claude",
          },
          escaped: [escaped],
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
      },
      operation: null,
      event: { kind: "stop_unconfirmed", payload: { escaped: [4243] } },
      pending: "open",
    });
    assert.equal(
      (await h.host.stopUnconfirmedExecutions())
        .map((r) => r.executionRef)
        .join(),
      "execution:s04",
    );
    // (a) The upgrade barrier: the physical-execution check fails and its detail names the unconfirmed stop.
    const target2 = { bundleDigest: "b".repeat(64), dataFormat: "test.f2" };
    const blocked = await h.host.upgradePrepare("instance:one", target2);
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.resultCode, "HOST_BARRIER");
    const physical = blocked.result.hostBarrier.checks.find(
      (c) => c.id === "physical-execution",
    )!;
    assert.equal(physical.passed, false);
    assert.match(physical.detail, /stop unconfirmed/);
    assert.match(physical.detail, /execution:s04/);
    assert.equal(h.calls.length, 0, "nothing was sent to the Runtime");
    // (c) The handoff path: quiesce and the supervisor's shutdown are refused before anything is persisted or sent.
    const quiesce = await h.failure(h.host.quiesce("instance:one", "handoff"));
    assert.equal(quiesce.code, "PRECONDITION_CONFLICT");
    assert.match(quiesce.message, /stop-unconfirmed/);
    assert.equal(quiesce.recovery, "query");
    assert.equal(
      h.store
        .snapshot()
        .runtimeOperations.filter((o) => o.method === "runtime.quiesce").length,
      0,
      "no quiesce operation was persisted",
    );
    const shutdown = await h.failure(
      h.host.supervisor.shutdown("instance:one", "handoff"),
    );
    assert.equal(shutdown.code, "PRECONDITION_CONFLICT");
    assert.match(shutdown.message, /stop-unconfirmed/);
    // OD-329 (b): revocation is the person's safety control and is never held by a lingering process.
    const revoke = await h.host.revokeGrant("instance:one", grant.ref.id);
    assert.equal(revoke.grant.status, "revoked");
    assert.equal(
      h.store.snapshot().runtimeGrants.find((g) => g.ref.id === grant.ref.id)!
        .status,
      "revoked",
    );
    // The held references are those of the instance; another instance over another resource is free.
    h.store.execute(
      {
        type: "runtimeResourceRegister",
        resource: {
          handle: "resource:other",
          kind: "directory",
          path: h.dir,
          registeredAt: at,
        },
      },
      "main",
      "host",
    );
    h.store.execute(
      {
        type: "runtimeScopeUpsert",
        scope: {
          instanceId: "instance:two",
          installationId: "installation:one",
          scopeRef: "scope:d",
          bindingRef: "binding:d",
          resourceHandle: "resource:other",
          state: "active",
          grantRefs: [],
          freshness: "current",
          cursor: null,
          revision: null,
          snapshotId: null,
          subscriptionId: null,
          lastError: null,
          updatedAt: at,
        },
      },
      "main",
      "host",
    );
    const other = await h.host.grant(
      "instance:two",
      "scope:d",
      "csthink.test.list-confirm",
      "list.read",
      "S-04 other",
    );
    const revokedOther = await h.host.revokeGrant("instance:two", other.ref.id);
    assert.equal(revokedOther.grant.status, "revoked");
    // Health checks and reconnection are not handoffs: neither is refused (no live process here, so null).
    assert.equal(await h.host.supervisor.reconnect("instance:one"), null);
    assert.equal(await h.host.supervisor.reverify("instance:one"), null);
    // The Host confirms the stop: the references are released and every operation is allowed again.
    upsert({
      type: "runtimeExecutionUpsert",
      record: {
        ...base,
        state: "stopped",
        stopReason: "cancelled",
        target,
        releasedAt: at,
        cancelRequestedAt: at,
        exit: { code: null, signal: "SIGTERM", pipesClosed: true },
        exitClassification: "children-remaining",
        observationCompleteness: "complete",
        reason:
          "stop confirmed: every process outside the target session has exited",
        stopUnconfirmed: {
          since: at,
          targetIdentity: {
            pid: 4242,
            startTime: "2026-09-19T01:00:00Z",
            image: "/opt/claude",
          },
          escaped: [escaped],
          checks: 1,
          lastCheckedAt: "2026-09-19T01:00:05Z",
          resolvedAt: "2026-09-19T01:00:05Z",
        },
        blockedOperations: [],
        updatedAt: "2026-09-19T01:00:05Z",
      },
      operation: operation("cancelled"),
      event: { kind: "stop_confirmed", payload: { checks: 1 } },
      pending: "resolve",
    });
    assert.equal((await h.host.stopUnconfirmedExecutions()).length, 0);
    const prepared = await h.host.upgradePrepare("instance:one", target2);
    assert.equal(
      prepared.result.hostBarrier.checks.find(
        (c) => c.id === "physical-execution",
      )!.passed,
      true,
    );
    // quiesce reaches the send (no connection here: refused transport), no longer a precondition conflict.
    const quiesced = await h.host.quiesce("instance:one", "handoff");
    assert.equal(quiesced.method, "runtime.quiesce");
    assert.notEqual(quiesced.transport, null);
    const again = await h.host.grant(
      "instance:one",
      "scope:a",
      "csthink.test.list-confirm",
      "list.read",
      "S-04 again",
    );
    const revoked = await h.host.revokeGrant("instance:one", again.ref.id);
    assert.equal(revoked.grant.status, "revoked");
  } finally {
    h.store.close();
  }
});

test("OD-416 授权批次：grantBatch 在同一事务建立一次核对的全部授权（同一创建时间与期限），未知 scope 拒绝且不写入；revokeGrants 一次撤销整批并只替换一次授权集合，未知授权拒绝且不撤销任何一项", async () => {
  const h = harness();
  h.seed();
  const pairs = [
    { capability: "csthink.test.one", operation: "runtime.snapshot.open" },
    { capability: "csthink.test.one", operation: "runtime.action.invoke" },
    { capability: "csthink.test.two", operation: "runtime.snapshot.open" },
  ];
  const refused = await h.failure(
    h.host.grantBatch("instance:one", "scope:none", pairs, "unit"),
  );
  assert.equal(refused.code, "NOT_FOUND");
  assert.equal(h.store.snapshot().runtimeGrants.length, 0);
  const grants = await h.host.grantBatch(
    "instance:one",
    "scope:a",
    pairs,
    "项目仓库治理接入：单元",
    86_400_000,
  );
  assert.equal(grants.length, 3);
  const stored = h.store.snapshot().runtimeGrants;
  assert.equal(stored.length, 3);
  assert.equal(new Set(stored.map((g) => g.createdAt)).size, 1);
  assert.equal(new Set(stored.map((g) => g.expiresAt)).size, 1);
  assert.ok(stored.every((g) => g.resourceHandle === "resource:dir"));
  assert.ok(stored.every((g) => g.status === "active"));
  // One authorization id for the batch, kept by the Host and never sent to the Runtime.
  assert.equal(new Set(stored.map((g) => g.authorizationId)).size, 1);
  assert.match(stored[0].authorizationId ?? "", /^authorization:/);
  const wire = (await h.inbound(
    h.connection("instance:one"),
    "host.grants.get",
    {
      grantRefs: grants.map((g) => g.ref),
    },
  )) as { grants: Record<string, unknown>[] };
  assert.equal(wire.grants.length, 3);
  assert.ok(wire.grants.every((g) => !("authorizationId" in g)));
  assert.ok(wire.grants.every((g) => !("createdAt" in g)));
  // Revoking with one unknown id changes nothing.
  const unknown = await h.failure(
    h.host.revokeGrants("instance:one", [grants[0].ref.id, "grant:unknown"]),
  );
  assert.equal(unknown.code, "NOT_FOUND");
  assert.ok(
    h.store.snapshot().runtimeGrants.every((g) => g.status === "active"),
  );
  // No live connection: the batch is revoked from the record and the scope keeps no revoked reference.
  h.store.execute(
    {
      type: "runtimeScopeUpsert",
      scope: {
        ...h.store
          .snapshot()
          .runtimeScopes.find((s) => s.scopeRef === "scope:a")!,
        grantRefs: grants.map((g) => g.ref),
      },
    },
    "main",
    "host",
  );
  const count = await h.host.revokeGrants(
    "instance:one",
    grants.map((g) => g.ref.id),
  );
  assert.equal(count, 3);
  const after = h.store.snapshot();
  assert.ok(after.runtimeGrants.every((g) => g.status === "revoked"));
  assert.equal(new Set(after.runtimeGrants.map((g) => g.revokedAt)).size, 1);
  assert.deepEqual(
    after.runtimeScopes.find((s) => s.scopeRef === "scope:a")!.grantRefs,
    [],
  );
  // A revoked batch cannot be revived through the batch command either.
  const revive = h.store.execute(
    {
      type: "runtimeGrantBatch",
      grants: after.runtimeGrants.map((g) => ({
        ...g,
        status: "active" as const,
        revokedAt: null,
      })),
    },
    "main",
    "host",
  );
  assert.equal(!revive.ok && revive.code, "CONFLICT");
  assert.ok(
    h.store.snapshot().runtimeGrants.every((g) => g.status === "revoked"),
  );
});
