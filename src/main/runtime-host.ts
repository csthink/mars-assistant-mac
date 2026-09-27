/**
 * Runtime Host services in the main process (Contract "方法及数据结构", "Projection、
 * 证据与合法操作", "快照、事件与竞争"): resource registration, scope binding and
 * authorization, snapshot paging into a projection generation, subscription with
 * replacement, event application and acknowledgement, Host-issued operations, the
 * runtime-to-host services (grants, context capture, resource read, decisions) and
 * the execution port dispatch. Every persistent fact goes through the business
 * service; this class keeps only per-connection sync state.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { digestOf, sha256 } from "./runtime-admission";
import {
  executionStartProblems,
  ExecutionResultReadError,
  validPreflightRequest,
  type ExecutionContext,
  type ExecutionMaterial,
  type ExecutionPort,
  type ExecutionProfile,
  type ExecutionStartRequest,
  type ExecutionTransition,
} from "./runtime-execution-port";
import {
  physicalExecutionOf,
  terminalPhysicalStates,
  validExecutionBudget,
  validHostEvidenceRef,
  type BlockedOperation,
  type HostEvidenceRef,
  type HostExecutionRecord,
  type PhysicalState,
} from "../shared/runtime-execution";
import {
  CallError,
  RpcFailure,
  RuntimeSupervisor,
  type RuntimeConnection,
  type SupervisorOptions,
} from "./runtime-supervisor";
import type { Reply } from "../shared/protocol";
import {
  compareSeq,
  recoveries,
  runtimeLimits,
  validCaughtUpEvent,
  validEvidenceRef,
  validGrantRef,
  validProjectionEvent,
  validRef,
  validSnapshotPage,
  validUpgradeState,
  validWireOperation,
  wireDecision,
  wireGrant,
  type GrantRef,
  type OperationKey,
  type ProjectionAction,
  type Recovery,
  type RuntimeContextSnapshot,
  type RuntimeDecision,
  type RuntimeGrant,
  type RuntimeHostCommand,
  type RuntimeInstance,
  type RuntimeOperation,
  type RuntimeProjection,
  type RuntimeResource,
  type RuntimeScope,
  type RuntimeSnapshot,
  type SnapshotPage,
  type UpgradeState,
  type WireOperation,
} from "../shared/runtime-host";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const future = (ms: number) =>
  new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, "Z");
export const grantLifetimeMs = 30 * 86_400_000;
const resyncAttempts = 3;
const readChunkBytes = 262_144;
/** Instance-level lifecycle and upgrade methods use the Contract's fixed internal scope. */
const instanceScope = "instance";
const terminal = (status: RuntimeOperation["status"]) =>
  status === "succeeded" || status === "failed" || status === "cancelled";
/** Host barrier record kept on the prepare operation (Contract: Host 本地屏障和领域持久屏障必须同时存在). */
export interface HostBarrier {
  established: boolean;
  checks: { id: string; passed: boolean; detail: string }[];
  establishedAt: string | null;
  releasedAt: string | null;
}
export interface UpgradeOperation extends RuntimeOperation {
  result: {
    hostBarrier: HostBarrier;
    upgrade: UpgradeState | null;
    /** prepared, non-empty barrierRef, zero protected references and exact identities (Contract "升级与迁移"). */
    proceedable: boolean;
  };
}

export interface HostOptions extends Omit<
  SupervisorOptions,
  "report" | "inbound" | "hooks" | "executionProfiles"
> {
  /** Host command to the business service; the reply carries the new snapshot and any read result. */
  request: (command: RuntimeHostCommand) => Promise<Reply>;
  /** The latest business snapshot's runtime records (the renderer sees the same records). */
  records: () => RuntimeSnapshot | undefined;
}
interface ScopeSync {
  instanceId: string;
  scopeRef: string;
  subscriptionId: string | null;
  queue: Promise<void>;
  syncing: Promise<void> | null;
  resyncs: number;
  ignoredEvents: number;
}

export class RuntimeHost {
  readonly supervisor: RuntimeSupervisor;
  private syncs = new Map<string, ScopeSync>();
  private ports = new Map<string, ExecutionPort>();
  constructor(private readonly options: HostOptions) {
    this.supervisor = new RuntimeSupervisor({
      runtimeRoot: options.runtimeRoot,
      descriptor: options.descriptor,
      catalogPins: options.catalogPins,
      transcriptsDir: options.transcriptsDir,
      healthIntervalMs: options.healthIntervalMs,
      report: async (command) => (await options.request(command)).ok,
      inbound: (connection, method, params) =>
        this.inbound(connection, method, params),
      executionProfiles: () =>
        this.profiles() as unknown as Record<string, unknown>[],
      hooks: {
        ready: (instance) => void this.resumeScopes(instance.instanceId),
        exit: (instance) =>
          void this.markInstanceStale(instance.instanceId, "进程已退出"),
        event: (instance, event) => this.onEvent(instance, event),
        handoffBlock: (instanceId) =>
          this.stopUnconfirmedBlock("switch-entry", { instanceId }),
      },
    });
  }
  // ---------------------------------------------------------------- records
  /** The persisted runtime records of the latest business snapshot. */
  records() {
    return this.options.records();
  }
  private async report(command: RuntimeHostCommand) {
    const reply = await this.options.request(command);
    if (!reply.ok)
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "business service refused " + command.type + ": " + reply.message,
      );
    return reply;
  }
  scope(instanceId: string, scopeRef: string) {
    return (
      this.records()?.runtimeScopes.find(
        (s) => s.instanceId === instanceId && s.scopeRef === scopeRef,
      ) ?? null
    );
  }
  private installationOf(instanceId: string) {
    const instance = this.records()?.runtimeInstances.find(
      (i) => i.instanceId === instanceId,
    );
    return instance
      ? (this.records()?.runtimeInstallations.find(
          (i) => i.installationId === instance.installationId,
        ) ?? null)
      : null;
  }
  private connection(instanceId: string): RuntimeConnection {
    const connection = this.supervisor.connectionOf(instanceId);
    if (!connection || connection.exit || !connection.context)
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "instance has no ready connection",
        { recovery: "reconnect" },
      );
    return connection;
  }
  private grantsOf(instanceId: string, scopeRef: string) {
    return (this.records()?.runtimeGrants ?? []).filter(
      (g) => g.instanceId === instanceId && g.scopeRef === scopeRef,
    );
  }
  /** A grant is usable only while active and unexpired; expiry is checked before every use, never cached. */
  private usableGrant(grant: RuntimeGrant) {
    return (
      grant.status === "active" && Date.parse(grant.expiresAt) > Date.now()
    );
  }
  /**
   * The grant among the cited refs that covers a resource. A cited grant that exists
   * but is revoked or expired answers PERMISSION_REVOKED; no covering grant at all
   * answers PERMISSION_DENIED (Contract: 撤权后不能借重传泄漏旧结果).
   */
  private coveringGrant(
    instanceId: string,
    scopeRef: string,
    refs: GrantRef[],
    resourceHandle: string,
    extra: { operationId?: string | null },
  ): RuntimeGrant {
    const scoped = this.grantsOf(instanceId, scopeRef);
    // Citing a grant that was revoked or expired is refused outright, whatever else the request cites.
    const dead = scoped.find(
      (g) => refs.some((r) => r.id === g.ref.id) && !this.usableGrant(g),
    );
    if (dead)
      throw new RpcFailure(
        "PERMISSION_REVOKED",
        "the cited grant " +
          dead.ref.id +
          " is " +
          (dead.status === "active" ? "expired" : dead.status),
        {
          scopeRef,
          operationId: extra.operationId ?? null,
          recovery: "reauthorize",
        },
      );
    const cited = scoped.filter(
      (g) =>
        g.resourceHandle === resourceHandle &&
        refs.some((r) => r.id === g.ref.id),
    );
    const usable = cited.find((g) =>
      refs.some((r) => r.id === g.ref.id && r.revision === g.ref.revision),
    );
    if (usable) return usable;
    if (cited.length)
      throw new RpcFailure(
        "PERMISSION_REVOKED",
        "the cited grant on " + resourceHandle + " is at another revision",
        {
          scopeRef,
          operationId: extra.operationId ?? null,
          recovery: "reauthorize",
        },
      );
    throw new RpcFailure(
      "PERMISSION_DENIED",
      "no cited grant covers " + resourceHandle,
      {
        scopeRef,
        operationId: extra.operationId ?? null,
        recovery: "reauthorize",
      },
    );
  }
  /** Authoritative operation lookup in the store (the snapshot is bounded per instance). */
  private async operationRead(
    instanceId: string,
    operationId: string | null,
    key: OperationKey | null = null,
  ): Promise<RuntimeOperation | null> {
    const reply = await this.report({
      type: "runtimeOperationRead",
      instanceId,
      operationId,
      key,
    });
    return reply.ok ? (reply.runtimeOperation ?? null) : null;
  }
  private async operationList(
    instanceId: string,
    methods: string[],
    open: boolean,
  ): Promise<RuntimeOperation[]> {
    const reply = await this.report({
      type: "runtimeOperationList",
      instanceId,
      methods,
      open,
    });
    return reply.ok ? (reply.runtimeOperationList ?? []) : [];
  }
  private async decisionRead(
    instanceId: string,
    decisionRef: string,
  ): Promise<RuntimeDecision | null> {
    const reply = await this.report({
      type: "runtimeDecisionRead",
      instanceId,
      decisionRef,
    });
    return reply.ok ? (reply.runtimeDecision ?? null) : null;
  }
  // ---------------------------------------------------------------- resources, scopes, grants
  /** Registers a directory as an authorizable resource identity; the handle is opaque and stable per real path. */
  async registerResource(path: string): Promise<RuntimeResource> {
    if (
      !path.startsWith("/") ||
      !existsSync(path) ||
      !statSync(path).isDirectory()
    )
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "resource must be an existing directory",
      );
    const real = realpathSync(path);
    const resource: RuntimeResource = {
      handle: "resource:" + sha256(real).slice(0, 32),
      kind: "directory",
      path: real,
      registeredAt: nowIso(),
    };
    await this.report({ type: "runtimeResourceRegister", resource });
    return resource;
  }
  /** scope.open binds a resource identity and returns inactive; no resource is read until authorized. */
  async openScope(
    instanceId: string,
    resourceHandle: string,
  ): Promise<RuntimeScope> {
    const installation = this.installationOf(instanceId);
    if (!installation)
      throw new RpcFailure("NOT_FOUND", "unknown instance", {
        absenceProven: true,
      });
    if (
      !this.records()?.runtimeResources.some((r) => r.handle === resourceHandle)
    )
      throw new RpcFailure("NOT_FOUND", "resource is not registered", {
        absenceProven: true,
      });
    const connection = this.connection(instanceId);
    const bindingRef =
      "binding:" + sha256(instanceId + "|" + resourceHandle).slice(0, 32);
    const result = await connection.call("runtime.scope.open", {
      binding: { bindingRef, resourceHandle, expiresAt: future(3_600_000) },
    });
    if (
      !validRef(result.scopeRef) ||
      result.bindingRef !== bindingRef ||
      result.state !== "inactive"
    )
      throw new RpcFailure(
        "INTEGRITY_MISMATCH",
        "scope.open result does not repeat the binding",
      );
    const existing = this.scope(instanceId, result.scopeRef);
    if (
      existing &&
      (existing.bindingRef !== bindingRef ||
        existing.resourceHandle !== resourceHandle)
    )
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "scopeRef is already bound to another resource",
      );
    const scope: RuntimeScope = existing
      ? { ...existing, updatedAt: nowIso() }
      : {
          instanceId,
          installationId: installation.installationId,
          scopeRef: result.scopeRef,
          bindingRef,
          resourceHandle,
          state: "inactive",
          grantRefs: [],
          freshness: "missing",
          cursor: null,
          revision: null,
          snapshotId: null,
          subscriptionId: null,
          lastError: null,
          updatedAt: nowIso(),
        };
    delete scope.counts;
    await this.report({ type: "runtimeScopeUpsert", scope });
    return scope;
  }
  /**
   * Establishes a Grant bound to installation, instance, scope, resource, capability,
   * operation and expiry. Re-authorizing after a revocation goes through here again:
   * a new reference is minted, the revoked record never returns.
   */
  async grant(
    instanceId: string,
    scopeRef: string,
    capability: string,
    operation: string,
    purpose: string,
    lifetimeMs = grantLifetimeMs,
  ): Promise<RuntimeGrant> {
    const scope = this.scope(instanceId, scopeRef);
    const installation = this.installationOf(instanceId);
    if (!scope || !installation)
      throw new RpcFailure("NOT_FOUND", "unknown scope", {
        absenceProven: true,
      });
    const grant: RuntimeGrant = {
      ref: { id: "grant:" + randomUUID(), revision: "1" },
      installationId: installation.installationId,
      instanceId,
      scopeRef,
      resourceHandle: scope.resourceHandle,
      capability,
      operation,
      executionRef: null,
      bundleDigest: installation.artifactDigest,
      expiresAt: future(lifetimeMs),
      status: "active",
      purpose,
      createdAt: nowIso(),
      revokedAt: null,
    };
    await this.report({ type: "runtimeGrantUpsert", grant });
    return grant;
  }
  /**
   * Revocation takes effect the moment the revoked status is persisted: every controlled
   * call re-reads the grant. The Runtime's authorization set is then replaced with the
   * remaining usable grants; if the connection is down the replacement happens on resume.
   */
  async revokeGrant(
    instanceId: string,
    grantId: string,
  ): Promise<{ grant: RuntimeGrant; scope: RuntimeScope | null }> {
    const grant = (this.records()?.runtimeGrants ?? []).find(
      (g) => g.instanceId === instanceId && g.ref.id === grantId,
    );
    if (!grant)
      throw new RpcFailure("NOT_FOUND", "unknown grant", {
        absenceProven: true,
      });
    // OD-329 (b): revocation is the person's safety control and always takes effect, also while a
    // cancelled execution's process lingers; the held references are enforced at the handoff and upgrade paths.
    const revoked: RuntimeGrant =
      grant.status === "active"
        ? { ...grant, status: "revoked", revokedAt: nowIso() }
        : grant;
    if (revoked !== grant)
      await this.report({ type: "runtimeGrantUpsert", grant: revoked });
    let scope: RuntimeScope | null = null;
    try {
      scope = await this.authorize(instanceId, grant.scopeRef);
    } catch {
      // No ready connection: the persisted revocation already blocks new access; resume re-authorizes.
      const held = this.scope(instanceId, grant.scopeRef);
      if (held)
        await this.markScope(instanceId, grant.scopeRef, {
          grantRefs: held.grantRefs.filter((r) => r.id !== grantId),
        });
      scope = this.scope(instanceId, grant.scopeRef);
    }
    return { grant: revoked, scope };
  }
  /**
   * One reviewed authorization: every (capability, operation) pair becomes a Grant with
   * the same purpose, creation time and expiry, written in one transaction.
   */
  async grantBatch(
    instanceId: string,
    scopeRef: string,
    pairs: { capability: string; operation: string }[],
    purpose: string,
    lifetimeMs = grantLifetimeMs,
  ): Promise<RuntimeGrant[]> {
    const scope = this.scope(instanceId, scopeRef);
    const installation = this.installationOf(instanceId);
    if (!scope || !installation)
      throw new RpcFailure("NOT_FOUND", "unknown scope", {
        absenceProven: true,
      });
    const createdAt = nowIso();
    const expiresAt = future(lifetimeMs);
    const authorizationId = "authorization:" + randomUUID();
    const grants: RuntimeGrant[] = pairs.map(({ capability, operation }) => ({
      ref: { id: "grant:" + randomUUID(), revision: "1" },
      installationId: installation.installationId,
      instanceId,
      scopeRef,
      resourceHandle: scope.resourceHandle,
      capability,
      operation,
      executionRef: null,
      bundleDigest: installation.artifactDigest,
      expiresAt,
      status: "active",
      purpose,
      createdAt,
      revokedAt: null,
      authorizationId,
    }));
    await this.report({ type: "runtimeGrantBatch", grants });
    return grants;
  }
  /**
   * Revokes several grants of one instance in one transaction, then replaces the
   * Runtime's authorization set once per affected scope (same rules as revokeGrant).
   */
  async revokeGrants(instanceId: string, grantIds: string[]) {
    const all = (this.records()?.runtimeGrants ?? []).filter(
      (g) => g.instanceId === instanceId && grantIds.includes(g.ref.id),
    );
    if (all.length !== grantIds.length)
      throw new RpcFailure("NOT_FOUND", "unknown grant", {
        absenceProven: true,
      });
    const at = nowIso();
    const revoked = all
      .filter((g) => g.status === "active")
      .map((g) => ({ ...g, status: "revoked" as const, revokedAt: at }));
    if (revoked.length)
      await this.report({ type: "runtimeGrantBatch", grants: revoked });
    for (const scopeRef of new Set(all.map((g) => g.scopeRef))) {
      try {
        await this.authorize(instanceId, scopeRef);
      } catch {
        const held = this.scope(instanceId, scopeRef);
        if (held)
          await this.markScope(instanceId, scopeRef, {
            grantRefs: held.grantRefs.filter((r) => !grantIds.includes(r.id)),
          });
      }
    }
    return revoked.length;
  }
  /**
   * Expiry check before the next Host-issued operation: grants that passed their
   * expiry are marked expired and, when the usable set differs from what the Runtime
   * holds, the set is replaced (Contract: 过期由 Host 在下一操作前检查并同样替换集合).
   */
  private async refreshGrants(
    instanceId: string,
    scopeRef: string,
  ): Promise<RuntimeScope> {
    const scope = this.scope(instanceId, scopeRef);
    if (!scope)
      throw new RpcFailure("NOT_FOUND", "unknown scope", {
        absenceProven: true,
      });
    const now = Date.now();
    for (const g of this.grantsOf(instanceId, scopeRef))
      if (g.status === "active" && Date.parse(g.expiresAt) <= now)
        await this.report({
          type: "runtimeGrantUpsert",
          grant: { ...g, status: "expired" },
        });
    const usable = this.grantsOf(instanceId, scopeRef)
      .filter((g) => this.usableGrant(g))
      .map((g) => g.ref.id + "@" + g.ref.revision)
      .sort();
    const held = scope.grantRefs.map((r) => r.id + "@" + r.revision).sort();
    if (usable.join(",") === held.join(",")) return scope;
    return this.authorize(instanceId, scopeRef);
  }
  /** scope.authorize replaces the Runtime's authorization set with the currently usable grants. */
  async authorize(instanceId: string, scopeRef: string): Promise<RuntimeScope> {
    const scope = this.scope(instanceId, scopeRef);
    if (!scope)
      throw new RpcFailure("NOT_FOUND", "unknown scope", {
        absenceProven: true,
      });
    const grantRefs = this.grantsOf(instanceId, scopeRef)
      .filter((g) => this.usableGrant(g))
      .map((g) => g.ref);
    const connection = this.connection(instanceId);
    const result = await connection.call("runtime.scope.authorize", {
      scopeRef,
      grantRefs,
    });
    if (
      result.scopeRef !== scopeRef ||
      (result.state !== "active" && result.state !== "inactive")
    )
      throw new RpcFailure(
        "INTEGRITY_MISMATCH",
        "scope.authorize result is malformed",
      );
    const next: RuntimeScope = {
      ...scope,
      state: result.state,
      grantRefs,
      updatedAt: nowIso(),
    };
    delete next.counts;
    await this.report({ type: "runtimeScopeUpsert", scope: next });
    return next;
  }
  // ---------------------------------------------------------------- snapshot, subscription, events
  private syncOf(instanceId: string, scopeRef: string) {
    const key = instanceId + "|" + scopeRef;
    let sync = this.syncs.get(key);
    if (!sync) {
      sync = {
        instanceId,
        scopeRef,
        subscriptionId: null,
        queue: Promise.resolve(),
        syncing: null,
        resyncs: 0,
        ignoredEvents: 0,
      };
      this.syncs.set(key, sync);
    }
    return sync;
  }
  private async markScope(
    instanceId: string,
    scopeRef: string,
    patch: Partial<RuntimeScope>,
  ) {
    const scope = this.scope(instanceId, scopeRef);
    if (!scope) return;
    const next: RuntimeScope = { ...scope, ...patch, updatedAt: nowIso() };
    delete next.counts;
    await this.report({ type: "runtimeScopeUpsert", scope: next });
  }
  private async markInstanceStale(instanceId: string, message: string) {
    for (const scope of this.records()?.runtimeScopes.filter(
      (s) => s.instanceId === instanceId,
    ) ?? []) {
      const sync = this.syncOf(instanceId, scope.scopeRef);
      sync.subscriptionId = null;
      if (scope.freshness === "current" || scope.freshness === "syncing")
        await this.markScope(instanceId, scope.scopeRef, {
          freshness: "stale",
          subscriptionId: null,
          lastError: { code: "RUNTIME_EXITED", message, at: nowIso() },
        });
    }
  }
  /** After a (re)connection the full state is fetched before any operation is offered again. */
  private async resumeScopes(instanceId: string) {
    for (const scope of this.records()?.runtimeScopes.filter(
      (s) => s.instanceId === instanceId,
    ) ?? []) {
      try {
        await this.openScope(instanceId, scope.resourceHandle);
        const authorized = await this.authorize(instanceId, scope.scopeRef);
        if (authorized.state === "active")
          await this.sync(instanceId, scope.scopeRef);
      } catch (error) {
        await this.markScope(instanceId, scope.scopeRef, {
          freshness: "stale",
          lastError: {
            code: (error as RpcFailure).code ?? "PROTOCOL",
            message: (error as Error).message,
            at: nowIso(),
          },
        });
      }
    }
  }
  /**
   * Full synchronisation: every snapshot page is fetched under one snapshotId, the
   * generation is replaced atomically, then the subscription starts at the watermark.
   * RESYNC_REQUIRED restarts from a fresh snapshot a bounded number of times.
   */
  sync(instanceId: string, scopeRef: string): Promise<void> {
    const sync = this.syncOf(instanceId, scopeRef);
    if (sync.syncing) return sync.syncing;
    sync.syncing = this.runSync(sync).finally(() => {
      sync.syncing = null;
    });
    return sync.syncing;
  }
  private async runSync(sync: ScopeSync) {
    const { instanceId, scopeRef } = sync;
    for (let attempt = 1; ; attempt++) {
      try {
        const connection = this.connection(instanceId);
        const limits =
          this.supervisor.instanceOf(instanceId)?.negotiation?.limits ??
          runtimeLimits;
        const pages: SnapshotPage[] = [];
        let page = await connection.call("runtime.snapshot.open", { scopeRef });
        for (;;) {
          if (!validSnapshotPage(page, limits) || page.scopeRef !== scopeRef)
            throw new RpcFailure(
              "INTEGRITY_MISMATCH",
              "snapshot page is malformed or names another scope",
            );
          pages.push(page);
          if (page.nextPageToken === null) break;
          if (pages.length > 10_000)
            throw new RpcFailure(
              "RESOURCE_LIMIT",
              "snapshot has too many pages",
            );
          page = await connection.call("runtime.snapshot.next", {
            scopeRef,
            snapshotId: pages[0].snapshotId,
            pageToken: page.nextPageToken,
          });
        }
        sync.subscriptionId = null;
        await this.report({
          type: "runtimeProjectionReplace",
          instanceId,
          scopeRef,
          pages,
        });
        const first = pages[0];
        const subscribed = await connection.call("runtime.events.subscribe", {
          scopeRef,
          snapshotId: first.snapshotId,
          streamId: first.streamId,
          epoch: first.epoch,
          afterSeq: first.throughSeq,
        });
        if (
          !validRef(subscribed.subscriptionId) ||
          !(
            subscribed.replacedSubscriptionId === null ||
            validRef(subscribed.replacedSubscriptionId)
          )
        )
          throw new RpcFailure(
            "INTEGRITY_MISMATCH",
            "subscribe result is malformed",
          );
        // From here only this subscription may feed the projection; a replaced one is ignored even if it still delivers.
        sync.subscriptionId = subscribed.subscriptionId;
        sync.resyncs = 0;
        await this.markScope(instanceId, scopeRef, {
          subscriptionId: subscribed.subscriptionId,
          lastError: null,
        });
        return;
      } catch (error) {
        const code =
          error instanceof CallError || error instanceof RpcFailure
            ? error.code
            : "PROTOCOL";
        if (code === "RESYNC_REQUIRED" && attempt < resyncAttempts) continue;
        await this.markScope(instanceId, scopeRef, {
          freshness: "stale",
          subscriptionId: null,
          lastError: { code, message: (error as Error).message, at: nowIso() },
        });
        throw error;
      }
    }
  }
  private onEvent(instance: RuntimeInstance, event: Json) {
    const scopeRef = typeof event.scopeRef === "string" ? event.scopeRef : null;
    if (!scopeRef) return;
    const sync = this.syncOf(instance.instanceId, scopeRef);
    sync.queue = sync.queue
      .then(() => this.applyEvent(sync, event))
      .catch(() => undefined);
  }
  private async applyEvent(sync: ScopeSync, event: Json) {
    const { instanceId, scopeRef } = sync;
    // Only the current subscription feeds the projection; events of a replaced or unknown subscription are ignored.
    if (!sync.subscriptionId || event.subscriptionId !== sync.subscriptionId) {
      sync.ignoredEvents += 1;
      return;
    }
    if (validCaughtUpEvent(event)) {
      await this.report({
        type: "runtimeCaughtUp",
        instanceId,
        scopeRef,
        streamId: event.streamId,
        epoch: event.epoch,
        throughSeq: event.throughSeq,
      });
      return;
    }
    const limits =
      this.supervisor.instanceOf(instanceId)?.negotiation?.limits ??
      runtimeLimits;
    if (!validProjectionEvent(event, limits)) {
      await this.markScope(instanceId, scopeRef, {
        freshness: "stale",
        lastError: {
          code: "PROTOCOL",
          message: "malformed event " + String(event.eventId ?? ""),
          at: nowIso(),
        },
      });
      sync.subscriptionId = null;
      return;
    }
    const reply = await this.report({
      type: "runtimeEventApply",
      instanceId,
      scopeRef,
      event,
    });
    const outcome = reply.ok ? reply.runtimeEvent : undefined;
    if (outcome === "applied") {
      // The ack follows the committed projection and cursor; a lost ack only causes a harmless redelivery.
      try {
        const connection = this.connection(instanceId);
        await connection.call("runtime.events.ack", {
          subscriptionId: event.subscriptionId,
          streamId: event.streamId,
          epoch: event.epoch,
          seq: event.seq,
        });
      } catch {
        /* Redelivery is deduplicated by the applied event identity. */
      }
      return;
    }
    if (outcome === "gap" || outcome === "epoch") {
      // Actions pause with the stale mark; a fresh snapshot is fetched a bounded number of times.
      sync.subscriptionId = null;
      if (sync.resyncs < resyncAttempts) {
        sync.resyncs += 1;
        void this.sync(instanceId, scopeRef).catch(() => undefined);
      }
      return;
    }
    if (outcome === "conflict") sync.subscriptionId = null;
  }
  /** Resolves once the scope's projection is current; a stale mark or the deadline rejects. */
  async awaitCurrent(instanceId: string, scopeRef: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const scope = this.scope(instanceId, scopeRef);
      if (scope?.freshness === "current") return scope;
      if (scope?.freshness === "stale")
        throw new RpcFailure(
          scope.lastError?.code ?? "RESYNC_REQUIRED",
          "projection is stale: " + (scope.lastError?.message ?? ""),
          { recovery: "resync" },
        );
      if (Date.now() > deadline)
        throw new RpcFailure(
          "RESYNC_REQUIRED",
          "projection did not become current within " + timeoutMs + "ms",
          { recovery: "resync" },
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  /** Re-verify: an immediate health check and, for active scopes, a fresh full synchronisation. */
  async reverify(instanceId: string) {
    const instance = await this.supervisor.reverify(instanceId);
    if (!instance || instance.state !== "ready") return instance;
    for (const scope of this.records()?.runtimeScopes.filter(
      (s) => s.instanceId === instanceId && s.state === "active",
    ) ?? [])
      await this.sync(instanceId, scope.scopeRef).catch(() => undefined);
    return instance;
  }
  // ---------------------------------------------------------------- Host-issued operations
  async roleBinding(instanceId: string, scopeRef: string, roleIntent: string) {
    const reply = await this.report({
      type: "runtimeRoleBindingRead",
      instanceId,
      scopeRef,
      roleIntent,
    });
    return reply.ok ? (reply.runtimeRoleBinding ?? null) : null;
  }
  async projection(
    instanceId: string,
    scopeRef: string,
  ): Promise<RuntimeProjection> {
    const reply = await this.report({
      type: "runtimeProjectionRead",
      instanceId,
      scopeRef,
    });
    if (!reply.ok || !reply.runtimeProjection)
      throw new RpcFailure("NOT_FOUND", "projection unavailable");
    return reply.runtimeProjection;
  }
  async projectOperations(instanceId: string, scopeRef: string) {
    return (
      await this.operationList(instanceId, ["runtime.action.invoke"], false)
    ).filter((o) => o.scopeRef === scopeRef);
  }
  async projectEvidence(instanceId: string, scopeRef: string, evidence: Json) {
    if (!validEvidenceRef(evidence) || evidence.scopeRef !== scopeRef)
      throw new RpcFailure(
        "PERMISSION_DENIED",
        "证据不属于当前 Runtime scope。",
      );
    if (Number(evidence.bytes) > 2 * 1024 * 1024)
      throw new RpcFailure(
        "RESOURCE_LIMIT",
        "证据超过当前阅读入口的 2 MiB 上限。",
      );
    const scope = await this.refreshGrants(instanceId, scopeRef);
    if (scope.state !== "active")
      throw new RpcFailure("PERMISSION_DENIED", "项目授权已撤销。");
    const bytes = await this.readRuntimeEvidence(
      evidence.authority === "host"
        ? {
            call: async (_method, params = {}) =>
              this.resourceRead(instanceId, params),
          }
        : this.connection(instanceId),
      scopeRef,
      evidence,
      scope.grantRefs,
    );
    const after = await this.refreshGrants(instanceId, scopeRef);
    if (after.state !== "active")
      throw new RpcFailure("PERMISSION_DENIED", "证据读取期间授权已撤销。");
    return bytes;
  }
  private async persistOperation(operation: RuntimeOperation) {
    await this.report({ type: "runtimeOperationUpsert", operation });
  }
  /** A new Host-issued operation record with its identity, key and digest, not yet sent. */
  private newOperation(
    instanceId: string,
    scopeRef: string,
    method: string,
    body: Json,
    fixedOperationId?: string,
  ): { operation: RuntimeOperation; params: Json } {
    const installation = this.installationOf(instanceId);
    if (!installation)
      throw new RpcFailure("NOT_FOUND", "unknown instance", {
        absenceProven: true,
      });
    const operationId = fixedOperationId ?? "op:" + randomUUID();
    const full: Json = {
      operationId,
      idempotencyKey: "key:" + operationId.slice(3),
      ...body,
    };
    const requestDigest = digestOf({ method, ...full });
    const at = nowIso();
    return {
      operation: {
        operationId,
        installationId: installation.installationId,
        instanceId,
        scopeRef,
        method,
        origin: "host",
        idempotencyKey: full.idempotencyKey as string,
        requestDigest,
        request: full,
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
        createdAt: at,
        updatedAt: at,
      },
      params: { ...full, requestDigest },
    };
  }
  /**
   * The exact Invoke an action of the current projection maps to. Actions pause while
   * the projection is not current, while the scope is unauthorized and while the
   * installation is under an upgrade barrier.
   */
  private async buildInvoke(
    instanceId: string,
    scopeRef: string,
    input: {
      actionId: string;
      objectRef: string;
      payload: Json;
      expectedAction?: ProjectionAction;
      expectedGrantsDigest?: string;
      operationId?: string;
    },
    decisionRef: string | null,
  ) {
    const scope = await this.refreshGrants(instanceId, scopeRef);
    if (
      input.expectedGrantsDigest &&
      input.expectedGrantsDigest !== digestOf(scope.grantRefs)
    )
      throw new RpcFailure(
        "PERMISSION_DENIED",
        "用户核对的授权已变化，请重新核对。",
        { scopeRef },
      );
    if (scope.state !== "active")
      throw new RpcFailure("PERMISSION_DENIED", "scope is not authorized", {
        scopeRef,
        recovery: "reauthorize",
      });
    if (scope.freshness !== "current")
      throw new RpcFailure(
        "RESYNC_REQUIRED",
        "projection is " +
          scope.freshness +
          "; actions pause until it is current",
        { scopeRef, recovery: "resync" },
      );
    const barrier = await this.hostBarrier(instanceId);
    if (barrier)
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "the installation is under upgrade barrier " +
          barrier.operationId +
          "; user actions are refused until it is released",
        { scopeRef, operationId: barrier.operationId },
      );
    const projection = await this.projection(instanceId, scopeRef);
    const action: ProjectionAction | undefined = projection.actions.find(
      (a) => a.actionId === input.actionId && a.objectRef === input.objectRef,
    );
    if (!action)
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "action is not offered by the current projection",
        { scopeRef, recovery: "resync" },
      );
    if (
      input.expectedAction &&
      digestOf(input.expectedAction) !== digestOf(action)
    )
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "用户确认的操作或候选已变化，请重新核对。",
        { scopeRef, recovery: "resync" },
      );
    if (!action.enabled)
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "action is disabled: " + (action.disabledCode ?? ""),
        { scopeRef },
      );
    return this.newOperation(
      instanceId,
      scopeRef,
      "runtime.action.invoke",
      {
        scopeRef,
        actionId: action.actionId,
        objectRef: action.objectRef,
        expectedRevision: action.expectedRevision,
        candidateRef: action.candidateRef,
        grantRefs: scope.grantRefs,
        payload: input.payload,
        decisionRef,
      },
      input.operationId,
    );
  }
  /**
   * Invokes an action the current projection offers. The operation identity, key and
   * digest are persisted before the request leaves the Host; the reply or its loss is
   * recorded on the same operation. Actions that require a human decision go through
   * `decide`, which records the decision and the Invoke together.
   */
  async invoke(
    instanceId: string,
    scopeRef: string,
    input: {
      actionId: string;
      objectRef: string;
      payload: Json;
      expectedAction?: ProjectionAction;
      expectedGrantsDigest?: string;
      operationId?: string;
    },
  ): Promise<RuntimeOperation> {
    const { operation, params } = await this.buildInvoke(
      instanceId,
      scopeRef,
      input,
      null,
    );
    await this.persistOperation(operation);
    return this.send(operation, params);
  }
  /**
   * Trusted Host entry for a human decision (Contract "人工决定与可信记录"): the decision
   * reference and the domain operation are allocated, the request semantics fixed and
   * digested, then the DecisionRecord and the pending Invoke commit in one transaction
   * before the Invoke is sent. The evidence refs are what the actor actually viewed.
   */
  async decide(
    instanceId: string,
    scopeRef: string,
    input: {
      actionId: string;
      objectRef: string;
      payload: Json;
      evidence: Json[];
      actorRef: string;
      expectedAction?: ProjectionAction;
      expectedGrantsDigest?: string;
      operationId?: string;
    },
  ): Promise<{ decision: RuntimeDecision; operation: RuntimeOperation }> {
    if (!validRef(input.actorRef))
      throw new RpcFailure("PRECONDITION_CONFLICT", "actorRef malformed");
    if (
      !Array.isArray(input.evidence) ||
      input.evidence.length > 32 ||
      !input.evidence.every(validEvidenceRef)
    )
      throw new RpcFailure("PRECONDITION_CONFLICT", "evidence malformed");
    const decisionRef = "decision:" + randomUUID();
    const { operation, params } = await this.buildInvoke(
      instanceId,
      scopeRef,
      input,
      decisionRef,
    );
    const request = operation.request!;
    const decision: RuntimeDecision = {
      decisionRef,
      installationId: operation.installationId,
      instanceId,
      scopeRef,
      domainOperationId: operation.operationId,
      method: "runtime.action.invoke",
      requestDigest: operation.requestDigest,
      actionId: request.actionId as string,
      objectRef: request.objectRef as string,
      candidateRef: request.candidateRef as string | null,
      expectedRevision: request.expectedRevision as string,
      evidence: input.evidence,
      actorRef: input.actorRef,
      source: "host-trusted-ui",
      recordedAt: operation.createdAt,
      status: "valid",
      revokedAt: null,
    };
    await this.report({ type: "runtimeDecisionRecord", decision, operation });
    return { decision, operation: await this.send(operation, params) };
  }
  /** Revocation appends the status; the confirmed content and any already committed effect stay as history. */
  async revokeDecision(
    instanceId: string,
    decisionRef: string,
  ): Promise<RuntimeDecision> {
    await this.report({
      type: "runtimeDecisionRevoke",
      instanceId,
      decisionRef,
      revokedAt: nowIso(),
    });
    const decision = await this.decisionRead(instanceId, decisionRef);
    if (!decision)
      throw new RpcFailure("NOT_FOUND", "unknown decision", {
        absenceProven: true,
      });
    return decision;
  }
  /**
   * Instance-level quiesce (Contract "升级与迁移": after a proceedable preparation the Host
   * quiesces the Runtime before backup, migration and replacement). Persisted before it is
   * sent like every Host-issued operation; the fixed internal scope is `instance`.
   */
  async quiesce(instanceId: string, reason: string): Promise<RuntimeOperation> {
    // The instance stops accepting and releases its resource control (the first step of the entry
    // switch): refused while a stop on this instance is unconfirmed (RUNTIME-04, OD-329 b).
    const held = await this.stopUnconfirmedBlock("release-resource", {
      instanceId,
    });
    if (held) throw held;
    const { operation, params } = this.newOperation(
      instanceId,
      instanceScope,
      "runtime.quiesce",
      { reason: reason.slice(0, 2048) },
    );
    await this.persistOperation(operation);
    return this.send(operation, params);
  }
  /**
   * Retransmits a Host-issued operation with its original key and intent (Contract:
   * 重传保持原键和意图); the stored request is sent byte for byte, never rebuilt from the
   * current projection. This is also the retry-later path after BUSY / RESOURCE_LIMIT.
   */
  async resend(
    instanceId: string,
    operationId: string,
  ): Promise<RuntimeOperation> {
    const operation = await this.operationRead(instanceId, operationId);
    if (!operation || operation.origin !== "host" || !operation.request)
      throw new RpcFailure("NOT_FOUND", "no Host-issued operation to resend", {
        absenceProven: true,
      });
    const sent: RuntimeOperation = {
      ...operation,
      transport: "sent",
      errorCode: null,
      recovery: null,
      updatedAt: nowIso(),
    };
    await this.persistOperation(sent);
    const params = {
      ...operation.request,
      requestDigest: operation.requestDigest,
    };
    if (operation.method === "runtime.upgrade.prepare")
      return this.sendUpgrade(sent as UpgradeOperation, params);
    return this.send(sent, params);
  }
  /**
   * Cancel is itself an idempotent operation with its own identity. The target's
   * record is re-queried afterwards and never rewritten to cancelled by the Host: a
   * target that completed first stays completed (Contract "幂等、未知结果与取消").
   */
  async cancel(
    instanceId: string,
    scopeRef: string,
    targetOperationId: string,
  ): Promise<{ cancel: RuntimeOperation; target: RuntimeOperation | null }> {
    const target = await this.operationRead(instanceId, targetOperationId);
    if (!target || target.scopeRef !== scopeRef)
      throw new RpcFailure("NOT_FOUND", "no operation to cancel", {
        scopeRef,
        absenceProven: true,
      });
    const { operation, params } = this.newOperation(
      instanceId,
      scopeRef,
      "runtime.operation.cancel",
      { scopeRef, targetOperationId },
    );
    await this.persistOperation(operation);
    const cancel = await this.send(operation, params);
    const queried = await this.operationGet(
      instanceId,
      scopeRef,
      targetOperationId,
    );
    return { cancel, target: queried.operation };
  }
  /** Sends a persisted operation and records the answer, the refusal or the loss of the answer. */
  private async send(
    operation: RuntimeOperation,
    params: Json,
  ): Promise<RuntimeOperation> {
    try {
      // A request that cites a grant is sent only while every cited grant is usable: a revoked or expired
      // grant refuses locally as PERMISSION_REVOKED, so a retransmission never replays lost authority.
      const refs = operation.request?.grantRefs;
      if (Array.isArray(refs))
        for (const ref of refs as GrantRef[])
          this.coveringGrant(
            operation.instanceId,
            operation.scopeRef,
            [ref],
            this.grantsOf(operation.instanceId, operation.scopeRef).find(
              (g) => g.ref.id === ref.id,
            )?.resourceHandle ?? "",
            { operationId: operation.operationId },
          );
      // A new side effect re-checks the decision it cites; a revoked decision never leaves the Host.
      const decisionRef = operation.request?.decisionRef;
      if (typeof decisionRef === "string") {
        const decision = await this.decisionRead(
          operation.instanceId,
          decisionRef,
        );
        if (!decision || decision.status !== "valid")
          throw new RpcFailure(
            "PERMISSION_REVOKED",
            "the decision this request cites is " +
              (decision ? decision.status : "unknown"),
            {
              scopeRef: operation.scopeRef,
              operationId: operation.operationId,
              recovery: "review",
            },
          );
      }
      const connection = this.connection(operation.instanceId);
      const result = await connection.call(operation.method, params);
      if (
        !validWireOperation(result) ||
        result.operationId !== operation.operationId ||
        result.requestDigest !== operation.requestDigest
      )
        throw new RpcFailure(
          "INTEGRITY_MISMATCH",
          "operation result does not repeat the request identity",
        );
      const answered = mergeWire(operation, result, "answered", null);
      await this.persistOperation(answered);
      return answered;
    } catch (error) {
      const { code, recovery } = failureOf(error);
      const lost = code === "TIMEOUT" || code === "RUNTIME_EXITED";
      const failed: RuntimeOperation = {
        ...operation,
        transport: lost ? "lost" : "refused",
        errorCode: code,
        recovery,
        reason: (error as Error).message.slice(0, 2048),
        updatedAt: nowIso(),
      };
      await this.persistOperation(failed);
      return failed;
    }
  }
  /**
   * Queries the owner of an operation. NOT_FOUND with absenceProven means the Runtime's
   * authoritative index proves the request was never accepted; RESULT_UNKNOWN keeps the
   * operation unknown until a later query finds the exact result (never failed by default).
   */
  async operationGet(
    instanceId: string,
    scopeRef: string,
    operationId: string,
  ): Promise<{
    operation: RuntimeOperation | null;
    error: { code: string; absenceProven: boolean } | null;
  }> {
    const existing = await this.operationRead(instanceId, operationId);
    try {
      const result = await this.connection(instanceId).call(
        "runtime.operation.get",
        { scopeRef, operationId },
      );
      if (!validWireOperation(result))
        throw new RpcFailure(
          "INTEGRITY_MISMATCH",
          "operation.get result is malformed",
        );
      if (existing) {
        if (result.requestDigest !== existing.requestDigest)
          throw new RpcFailure(
            "INTEGRITY_MISMATCH",
            "operation.get answers another request digest",
          );
        const merged = mergeWire(existing, result, "answered", null);
        await this.persistOperation(merged);
        return { operation: merged, error: null };
      }
      return { operation: null, error: null };
    } catch (error) {
      const { code, recovery } = failureOf(error);
      const absenceProven =
        error instanceof CallError && error.data?.absenceProven === true;
      if (!existing) return { operation: null, error: { code, absenceProven } };
      const queried: RuntimeOperation = {
        ...existing,
        errorCode: code,
        recovery,
        updatedAt: nowIso(),
        ...(absenceProven
          ? {
              status: "failed",
              reason: "runtime proved the operation was never accepted",
            }
          : {}),
      };
      await this.persistOperation(queried);
      return { operation: queried, error: { code, absenceProven } };
    }
  }
  // ---------------------------------------------------------------- upgrade barrier and protocol client
  /** The active Host barrier of an instance's installation, if a prepare is proceedable or unresolved. */
  private async hostBarrier(
    instanceId: string,
  ): Promise<UpgradeOperation | null> {
    const candidates = (
      await this.operationList(instanceId, ["runtime.upgrade.prepare"], false)
    ).filter((o): o is UpgradeOperation => isRecord(o.result?.hostBarrier));
    for (const o of candidates) {
      const barrier = o.result.hostBarrier;
      if (!barrier.established || barrier.releasedAt) continue;
      const status = o.result.upgrade?.status;
      // blocked is a fixed result and releases the Host barrier; prepared or an unresolved answer keeps it.
      if (status === "blocked" || status === "released") continue;
      return o;
    }
    return null;
  }
  /**
   * Upgrade preparation (Contract "升级与迁移"): the Host establishes its own installation
   * barrier first (no physical execution in flight, no unresolved Host request, no other
   * barrier, source identity equals the installation), then calls the instance-level
   * runtime.upgrade.prepare bound to source and target bundle digests and data formats.
   * Only prepared with a non-empty barrierRef, zero protected references and exact
   * identities is recorded as proceedable; blocked is that operation's fixed result.
   */
  async upgradePrepare(
    instanceId: string,
    target: { bundleDigest: string; dataFormat: string },
  ): Promise<UpgradeOperation> {
    const installation = this.installationOf(instanceId);
    if (!installation)
      throw new RpcFailure("NOT_FOUND", "unknown instance", {
        absenceProven: true,
      });
    if (
      !/^[0-9a-f]{64}$/.test(target.bundleDigest) ||
      !validRef(target.dataFormat)
    )
      throw new RpcFailure("PRECONDITION_CONFLICT", "target malformed");
    const open = await this.operationList(instanceId, [], true);
    const executions = open.filter(
      (o) => o.method === "host.execution.start" && !terminal(o.status),
    );
    const pending = open.filter(
      (o) =>
        o.origin === "host" &&
        o.method !== "runtime.upgrade.prepare" &&
        (o.transport === "sent" ||
          (o.transport === "lost" && o.status === "unknown")),
    );
    const other = await this.hostBarrier(instanceId);
    // A stop-unconfirmed execution is still in flight (its start operation is running) and is named as such:
    // the extension card and the application update entry show the reason (UI-03, RUNTIME-04).
    const unconfirmed = await this.stopUnconfirmedExecutions({ instanceId });
    const checks = [
      {
        id: "physical-execution",
        passed: executions.length === 0 && unconfirmed.length === 0,
        detail: unconfirmed.length
          ? unconfirmed.length +
            " execution(s) stop unconfirmed (" +
            unconfirmed.map((r) => r.executionRef).join(", ") +
            "); the target's processes must exit before the upgrade"
          : executions.length
            ? executions.length + " execution(s) in flight"
            : "no physical execution in flight",
      },
      {
        id: "pending-request",
        passed: pending.length === 0,
        detail: pending.length
          ? pending.map((o) => o.operationId).join(", ") + " unresolved"
          : "no unresolved Host request",
      },
      {
        id: "version-reference",
        passed: other === null,
        detail: other
          ? "barrier " + other.operationId + " already holds the installation"
          : "no other barrier references the installation",
      },
    ];
    const established = checks.every((c) => c.passed);
    const body = {
      sourceBundleDigest: installation.artifactDigest,
      targetBundleDigest: target.bundleDigest,
      sourceDataFormat: installation.dataFormat,
      targetDataFormat: target.dataFormat,
    };
    const built = this.newOperation(
      instanceId,
      instanceScope,
      "runtime.upgrade.prepare",
      body,
    );
    const at = nowIso();
    const operation: UpgradeOperation = {
      ...built.operation,
      result: {
        hostBarrier: {
          established,
          checks,
          establishedAt: established ? at : null,
          releasedAt: null,
        },
        upgrade: null,
        proceedable: false,
      },
      ...(established
        ? {}
        : {
            status: "failed" as const,
            resultCode: "HOST_BARRIER",
            reason: checks
              .filter((c) => !c.passed)
              .map((c) => c.detail)
              .join("; "),
            transport: null,
          }),
    };
    await this.persistOperation(operation);
    if (!established) return operation;
    return this.sendUpgrade(operation, built.params);
  }
  /** Sends prepare (or its retransmission) and records the UpgradeState as the operation's result. */
  private async sendUpgrade(
    operation: UpgradeOperation,
    params: Json,
  ): Promise<UpgradeOperation> {
    try {
      const result = await this.connection(operation.instanceId).call(
        operation.method,
        params,
      );
      return this.recordUpgradeState(operation, result, "answered");
    } catch (error) {
      const { code, recovery } = failureOf(error);
      const lost = code === "TIMEOUT" || code === "RUNTIME_EXITED";
      const failed: UpgradeOperation = {
        ...operation,
        transport: lost ? "lost" : "refused",
        errorCode: code,
        recovery,
        reason: (error as Error).message.slice(0, 2048),
        updatedAt: nowIso(),
      };
      await this.persistOperation(failed);
      return failed;
    }
  }
  private async recordUpgradeState(
    operation: UpgradeOperation,
    result: Json,
    transport: RuntimeOperation["transport"],
  ): Promise<UpgradeOperation> {
    const request = operation.request!;
    if (
      !validUpgradeState(result) ||
      result.operationId !== operation.operationId ||
      result.requestDigest !== operation.requestDigest
    )
      throw new RpcFailure(
        "INTEGRITY_MISMATCH",
        "upgrade state does not repeat the request identity",
        { scopeRef: instanceScope, operationId: operation.operationId },
      );
    const identities =
      result.sourceBundleDigest === request.sourceBundleDigest &&
      result.targetBundleDigest === request.targetBundleDigest &&
      result.sourceDataFormat === request.sourceDataFormat &&
      result.targetDataFormat === request.targetDataFormat;
    const { context: _c, ...upgrade } = result as UpgradeState & {
      context?: unknown;
    };
    void _c;
    const proceedable =
      upgrade.status === "prepared" &&
      upgrade.barrierRef !== null &&
      upgrade.protectedReferences.length === 0 &&
      identities;
    const recorded: UpgradeOperation = {
      ...operation,
      status: upgrade.status === "unknown" ? "unknown" : "succeeded",
      reason: upgrade.reason,
      resultCode: identities ? null : "IDENTITY_MISMATCH",
      revision: upgrade.preparedGeneration,
      result: {
        ...operation.result,
        upgrade,
        proceedable,
        hostBarrier:
          // blocked is fixed: the Host barrier is withdrawn with it; released ends it too.
          upgrade.status === "blocked" || upgrade.status === "released"
            ? {
                ...operation.result.hostBarrier,
                releasedAt: operation.result.hostBarrier.releasedAt ?? nowIso(),
              }
            : operation.result.hostBarrier,
      },
      transport,
      errorCode: null,
      recovery: null,
      updatedAt: nowIso(),
    };
    await this.persistOperation(recorded);
    return recorded;
  }
  private async upgradeOperation(instanceId: string, operationId: string) {
    const operation = await this.operationRead(instanceId, operationId);
    if (
      !operation ||
      operation.method !== "runtime.upgrade.prepare" ||
      !isRecord(operation.result?.hostBarrier)
    )
      throw new RpcFailure("NOT_FOUND", "no upgrade preparation with that id", {
        absenceProven: true,
      });
    return operation as UpgradeOperation;
  }
  /** Recovers the same preparation record after a lost answer; never establishes a new barrier. */
  async upgradeGet(
    instanceId: string,
    operationId: string,
  ): Promise<UpgradeOperation> {
    const operation = await this.upgradeOperation(instanceId, operationId);
    try {
      const result = await this.connection(instanceId).call(
        "runtime.upgrade.get",
        { operationId },
      );
      return this.recordUpgradeState(operation, result, "answered");
    } catch (error) {
      const { code, recovery } = failureOf(error);
      const unresolved: UpgradeOperation = {
        ...operation,
        errorCode: code,
        recovery,
        result: { ...operation.result, proceedable: false },
        updatedAt: nowIso(),
      };
      await this.persistOperation(unresolved);
      return unresolved;
    }
  }
  /**
   * Release after the activation or restore fact is verified: this task performs no
   * installation replacement, so the running bundle must still be the installation's
   * own and the disposition is restored. The Runtime's released revision is read back
   * through runtime.upgrade.get and the Host barrier is lifted only then.
   */
  async upgradeRelease(
    instanceId: string,
    prepareOperationId: string,
    disposition: "activated" | "restored",
  ): Promise<{ release: RuntimeOperation; prepare: UpgradeOperation }> {
    const prepare = await this.upgradeOperation(instanceId, prepareOperationId);
    const installation = this.installationOf(instanceId)!;
    const upgrade = prepare.result.upgrade;
    if (!prepare.result.proceedable || !upgrade?.barrierRef)
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "the preparation is not proceedable; nothing to release",
        { scopeRef: instanceScope, operationId: prepareOperationId },
      );
    const runningBundleDigest = installation.artifactDigest;
    const expected =
      disposition === "activated"
        ? upgrade.targetBundleDigest
        : upgrade.sourceBundleDigest;
    if (runningBundleDigest !== expected)
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "the running bundle is not the " +
          (disposition === "activated" ? "target" : "source") +
          " of this upgrade",
        { scopeRef: instanceScope, operationId: prepareOperationId },
      );
    const { operation, params } = this.newOperation(
      instanceId,
      instanceScope,
      "runtime.upgrade.release",
      {
        prepareOperationId,
        barrierRef: upgrade.barrierRef,
        disposition,
        runningBundleDigest,
        dataFormat:
          disposition === "activated"
            ? upgrade.targetDataFormat
            : upgrade.sourceDataFormat,
      },
    );
    await this.persistOperation(operation);
    const release = await this.send(operation, params);
    const after =
      release.transport === "answered" && release.status === "succeeded"
        ? await this.upgradeGet(instanceId, prepareOperationId)
        : prepare;
    return { release, prepare: after };
  }
  // ---------------------------------------------------------------- execution ports
  registerExecutionPort(port: ExecutionPort) {
    this.ports.set(port.id, port);
  }
  private profiles(): ExecutionProfile[] {
    return [...this.ports.values()].flatMap((port) => port.profiles());
  }
  private portFor(profileId: string, profileDigest: string) {
    for (const port of this.ports.values())
      if (
        port
          .profiles()
          .some((p) => p.id === profileId && p.digest === profileDigest)
      )
        return port;
    return null;
  }
  // ---------------------------------------------------------------- runtime-to-host services
  private async inbound(
    connection: RuntimeConnection,
    method: string,
    params: Json,
  ): Promise<Json> {
    const context = connection.context!;
    const instanceId = context.instanceId;
    const installation = this.installationOf(instanceId);
    if (!installation)
      throw new RpcFailure(
        "PERMISSION_DENIED",
        "connection is not bound to a known instance",
        { recovery: "reconnect" },
      );
    switch (method) {
      case "host.grants.get": {
        if (
          !Array.isArray(params.grantRefs) ||
          params.grantRefs.length > 100 ||
          !params.grantRefs.every(validGrantRef)
        )
          throw new RpcFailure(
            "PRECONDITION_CONFLICT",
            "grantRefs are malformed",
          );
        const refs = params.grantRefs as GrantRef[];
        // Only this instance's grants are visible; the answer states the current status and never mints a grant.
        const grants = (this.records()?.runtimeGrants ?? [])
          .filter(
            (g) =>
              g.instanceId === instanceId &&
              refs.some(
                (r) => r.id === g.ref.id && r.revision === g.ref.revision,
              ),
          )
          .map((g) =>
            wireGrant(
              this.usableGrant(g) || g.status !== "active"
                ? g
                : { ...g, status: "expired" },
            ),
          );
        return { grants };
      }
      case "host.decision.get": {
        if (!validRef(params.scopeRef) || !validRef(params.decisionRef))
          throw new RpcFailure(
            "PRECONDITION_CONFLICT",
            "scopeRef or decisionRef malformed",
          );
        // Visibility is checked on the real connection: only this instance's records exist for it; the
        // decision index is complete, so a missing record is proven absent.
        const decision = await this.decisionRead(
          instanceId,
          params.decisionRef,
        );
        if (!decision)
          throw new RpcFailure(
            "NOT_FOUND",
            "no decision record " + params.decisionRef + " for this instance",
            {
              scopeRef: params.scopeRef,
              absenceProven: true,
              recovery: "review",
            },
          );
        if (decision.scopeRef !== params.scopeRef)
          throw new RpcFailure(
            "PERMISSION_DENIED",
            "decision belongs to another scope",
            { scopeRef: params.scopeRef, recovery: "review" },
          );
        return wireDecision(decision);
      }
      case "host.context.capture":
        return this.contextCapture(
          connection,
          installation.installationId,
          params,
        );
      case "host.context.get": {
        if (!validRef(params.scopeRef) || !validRef(params.operationId))
          throw new RpcFailure(
            "PRECONDITION_CONFLICT",
            "scopeRef or operationId malformed",
          );
        const found = await this.operationRead(instanceId, params.operationId);
        const operation =
          found && found.method === "host.context.capture" ? found : null;
        if (!operation)
          throw new RpcFailure(
            "NOT_FOUND",
            "no capture with that operationId",
            {
              scopeRef: params.scopeRef,
              operationId: params.operationId,
              absenceProven: true,
              recovery: "query",
            },
          );
        if (operation.scopeRef !== params.scopeRef)
          throw new RpcFailure(
            "PERMISSION_DENIED",
            "capture belongs to another scope",
            { scopeRef: params.scopeRef, operationId: params.operationId },
          );
        return receiptOf(operation);
      }
      case "host.resource.read":
        return this.resourceRead(instanceId, params);
      case "host.execution.preflight": {
        if (!validPreflightRequest(params))
          throw new RpcFailure(
            "PRECONDITION_CONFLICT",
            "preflight request is malformed",
          );
        const port = this.portFor(params.profileId, params.profileDigest);
        if (!port)
          return {
            status: "unsupported",
            profileDigest: params.profileDigest,
            checks: [
              {
                id: "execution-profile",
                passed: false,
                detail:
                  "no verified execution profile with this identity is installed",
              },
            ],
            reason:
              "the Host offers no execution profile; feature-t30 installs the embedded execution port",
          };
        const checks = await port.preflight(params);
        return {
          status: checks.every((c) => c.passed) ? "supported" : "unsupported",
          profileDigest: params.profileDigest,
          checks,
          reason: checks
            .filter((c) => !c.passed)
            .map((c) => c.detail)
            .join("; "),
        };
      }
      case "host.execution.start":
        return this.executionStart(
          installation.installationId,
          instanceId,
          params,
        );
      case "host.operation.get": {
        if (!validRef(params.scopeRef) || !validRef(params.operationId))
          throw new RpcFailure(
            "PRECONDITION_CONFLICT",
            "scopeRef or operationId malformed",
          );
        const found = await this.operationRead(instanceId, params.operationId);
        const operation =
          found && found.method.startsWith("host.execution.") ? found : null;
        if (!operation)
          throw new RpcFailure(
            "NOT_FOUND",
            "the Host never accepted that operation",
            {
              scopeRef: params.scopeRef,
              operationId: params.operationId,
              absenceProven: true,
              recovery: "query",
            },
          );
        if (operation.scopeRef !== params.scopeRef)
          throw new RpcFailure(
            "PERMISSION_DENIED",
            "operation belongs to another scope",
            { scopeRef: params.scopeRef, operationId: params.operationId },
          );
        return wireOf(operation);
      }
      case "host.execution.get": {
        if (!validRef(params.scopeRef) || !validRef(params.executionRef))
          throw new RpcFailure(
            "PRECONDITION_CONFLICT",
            "scopeRef or executionRef malformed",
          );
        const operation = (
          await this.operationList(instanceId, ["host.execution.start"], false)
        ).find((o) => o.executionRef === params.executionRef);
        if (!operation)
          throw new RpcFailure(
            "NOT_FOUND",
            "no execution with that reference",
            {
              scopeRef: params.scopeRef,
              absenceProven: true,
              recovery: "query",
            },
          );
        if (operation.scopeRef !== params.scopeRef)
          throw new RpcFailure(
            "PERMISSION_DENIED",
            "execution belongs to another scope",
            { scopeRef: params.scopeRef },
          );
        const port =
          operation.result && typeof operation.result.portId === "string"
            ? this.ports.get(operation.result.portId)
            : null;
        const stored = await this.executionRead(params.executionRef);
        const physical =
          (port ? await port.get(params.executionRef) : null) ??
          (stored ? (physicalExecutionOf(stored) as unknown as Json) : null);
        if (!physical)
          throw new RpcFailure(
            "RESULT_UNKNOWN",
            "the execution port that owns this execution is not registered",
            { scopeRef: params.scopeRef, recovery: "query" },
          );
        // The start operation follows the physical terminal state the Host observed (completed, failed, stopped, unknown).
        const terminalStatus: Record<string, RuntimeOperation["status"]> = {
          completed: "succeeded",
          failed: "failed",
          stopped: "cancelled",
          unknown: "unknown",
        };
        const mapped = terminalStatus[String(physical.state)];
        if (
          mapped &&
          !terminal(operation.status) &&
          operation.status !== mapped
        )
          await this.persistOperation({
            ...operation,
            status: mapped,
            reason:
              typeof physical.reason === "string"
                ? physical.reason
                : operation.reason,
            revision: String(Number(operation.revision ?? "1") + 1),
            result: { ...(operation.result ?? {}), state: physical.state },
            updatedAt: nowIso(),
          });
        // Contract HostExecutionGetResult is the PhysicalExecution itself (plus Context, added by the connection).
        return physical;
      }
      case "host.execution.cancel":
        return this.executionCancel(
          installation.installationId,
          instanceId,
          params,
        );
      default:
        throw new RpcFailure(
          "PRECONDITION_CONFLICT",
          "unknown or wrong-direction method " + method,
        );
    }
  }
  /** Sources must be covered by usable grants of this scope; the Host reads the fixed bytes through runtime.resource.read and stores immutable copies. */
  private async contextCapture(
    connection: RuntimeConnection,
    installationId: string,
    params: Json,
  ): Promise<Json> {
    const instanceId = connection.context!.instanceId;
    for (const key of [
      "operationId",
      "idempotencyKey",
      "scopeRef",
      "domainOperationId",
    ])
      if (!validRef(params[key]))
        throw new RpcFailure("PRECONDITION_CONFLICT", key + " malformed");
    if (
      !Array.isArray(params.sources) ||
      params.sources.length > 32 ||
      !params.sources.every(
        (s) => validEvidenceRef(s) && (s as Json).authority === "runtime",
      )
    )
      throw new RpcFailure("PRECONDITION_CONFLICT", "sources malformed");
    if (
      !Array.isArray(params.grantRefs) ||
      !params.grantRefs.every(validGrantRef)
    )
      throw new RpcFailure("PRECONDITION_CONFLICT", "grantRefs malformed");
    const scopeRef = params.scopeRef as string;
    const operationId = params.operationId as string;
    const scope = this.scope(instanceId, scopeRef);
    if (!scope || scope.state !== "active")
      throw new RpcFailure("PERMISSION_DENIED", "scope is not authorized", {
        scopeRef,
        operationId,
        recovery: "reauthorize",
      });
    const requestDigest = params.requestDigest as string;
    // Dedupe: same key and digest answers the stored receipt; same key with another digest conflicts.
    const existing = await this.operationRead(instanceId, null, {
      scopeRef,
      method: "host.context.capture",
      idempotencyKey: params.idempotencyKey as string,
    });
    if (existing) {
      if (
        existing.requestDigest !== requestDigest ||
        existing.operationId !== operationId
      )
        throw new RpcFailure(
          "IDEMPOTENCY_CONFLICT",
          "same idempotency key with another request or operation",
          { scopeRef, operationId, recovery: "review" },
        );
      return receiptOf(existing);
    }
    const sources = params.sources as Json[];
    for (const source of sources) {
      if (source.scopeRef !== scopeRef)
        throw new RpcFailure(
          "PERMISSION_DENIED",
          "source belongs to another scope",
          { scopeRef, operationId },
        );
      this.coveringGrant(
        instanceId,
        scopeRef,
        params.grantRefs as GrantRef[],
        source.resourceHandle as string,
        { operationId },
      );
    }
    const at = nowIso();
    let operation: RuntimeOperation = {
      operationId,
      installationId,
      instanceId,
      scopeRef,
      method: "host.context.capture",
      origin: "runtime",
      idempotencyKey: params.idempotencyKey as string,
      requestDigest,
      request: {
        domainOperationId: params.domainOperationId,
        sources,
        grantRefs: params.grantRefs,
      },
      status: "accepted",
      resultCode: null,
      reason: "",
      resultRef: null,
      executionRef: null,
      revision: "1",
      result: { domainOperationId: params.domainOperationId, snapshots: [] },
      transport: null,
      errorCode: null,
      recovery: null,
      createdAt: at,
      updatedAt: at,
    };
    // Persist acceptance before any byte is read; a lost answer is recoverable through host.context.get.
    await this.persistOperation(operation);
    const snapshots: Json[] = [];
    try {
      for (const source of sources) {
        const bytes = await this.readRuntimeEvidence(
          connection,
          scopeRef,
          source,
          params.grantRefs as GrantRef[],
        );
        const handle = "context:" + randomUUID();
        const file = join(
          instanceId.replace(/[^A-Za-z0-9._-]/g, "_"),
          handle.slice(8) + ".bin",
        );
        const path = join(this.options.runtimeRoot, "context", file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes, { flag: "wx" });
        const snapshot: RuntimeContextSnapshot = {
          handle,
          instanceId,
          installationId,
          scopeRef,
          operationId,
          domainOperationId: params.domainOperationId as string,
          source,
          objectRef: source.objectRef as string,
          revision: source.revision as string,
          mediaType: source.mediaType as string,
          bytes: bytes.length,
          digest: sha256(bytes),
          file,
          createdAt: nowIso(),
        };
        await this.report({ type: "runtimeContextSnapshotUpsert", snapshot });
        snapshots.push({
          source,
          snapshot: {
            authority: "host",
            resourceHandle: handle,
            scopeRef,
            objectRef: snapshot.objectRef,
            revision: snapshot.revision,
            mediaType: snapshot.mediaType,
            bytes: snapshot.bytes,
            digest: snapshot.digest,
          },
        });
      }
      operation = {
        ...operation,
        status: "succeeded",
        result: { domainOperationId: params.domainOperationId, snapshots },
        revision: "2",
        updatedAt: nowIso(),
      };
    } catch (error) {
      const code =
        error instanceof CallError || error instanceof RpcFailure
          ? error.code
          : "PROTOCOL";
      operation = {
        ...operation,
        status: "failed",
        resultCode:
          code === "TIMEOUT" ? "SOURCE_INDETERMINATE" : "SOURCE_UNRESOLVED",
        reason: (error as Error).message.slice(0, 2048),
        revision: "2",
        updatedAt: nowIso(),
      };
    }
    await this.persistOperation(operation);
    return receiptOf(operation);
  }
  /** Reads one runtime evidence in bounded chunks and verifies length, chunk digests and the full digest. */
  private async readRuntimeEvidence(
    connection: Pick<RuntimeConnection, "call">,
    scopeRef: string,
    evidence: Json,
    grantRefs: GrantRef[],
  ): Promise<Buffer> {
    const expected = evidence.bytes as number;
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const chunk = await connection.call("runtime.resource.read", {
        scopeRef,
        evidence,
        grantRefs,
        offset,
        length: Math.max(1, Math.min(readChunkBytes, expected - offset || 1)),
      });
      if (
        !isRecord(chunk) ||
        typeof chunk.dataBase64 !== "string" ||
        typeof chunk.eof !== "boolean" ||
        chunk.offset !== offset ||
        chunk.digest !== evidence.digest ||
        chunk.revision !== evidence.revision ||
        chunk.resourceHandle !== evidence.resourceHandle
      )
        throw new RpcFailure(
          "INTEGRITY_MISMATCH",
          "resource chunk does not repeat the evidence identity",
        );
      const data = Buffer.from(chunk.dataBase64, "base64");
      parts.push(data);
      offset += data.length;
      if (offset > expected)
        throw new RpcFailure(
          "INTEGRITY_MISMATCH",
          "runtime returned more bytes than the evidence declares",
        );
      if (chunk.eof) break;
      if (data.length === 0)
        throw new RpcFailure("INTEGRITY_MISMATCH", "empty chunk before eof");
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== expected || sha256(bytes) !== evidence.digest)
      throw new RpcFailure(
        "INTEGRITY_MISMATCH",
        "evidence bytes differ from the declared length or digest",
      );
    return bytes;
  }
  /** Host-authority reads: the snapshot inherits its source's scope and grant constraints; other scopes are refused. */
  private async resourceRead(instanceId: string, params: Json): Promise<Json> {
    if (
      !validRef(params.scopeRef) ||
      !validEvidenceRef(params.evidence) ||
      !Array.isArray(params.grantRefs) ||
      !params.grantRefs.every(validGrantRef)
    )
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "resource read request is malformed",
      );
    if (
      !Number.isSafeInteger(params.offset) ||
      (params.offset as number) < 0 ||
      !Number.isSafeInteger(params.length) ||
      (params.length as number) < 1 ||
      (params.length as number) > readChunkBytes
    )
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "offset or length out of range",
      );
    const evidence = params.evidence as Json;
    const scopeRef = params.scopeRef as string;
    if (evidence.authority !== "host")
      throw new RpcFailure(
        "PERMISSION_DENIED",
        "host.resource.read accepts host authority only",
        { scopeRef },
      );
    if (evidence.scopeRef !== scopeRef)
      throw new RpcFailure(
        "PERMISSION_DENIED",
        "evidence belongs to another scope",
        { scopeRef },
      );
    if (String(evidence.objectRef).startsWith("execution-result:"))
      return this.executionResultRead(instanceId, params);
    const snapshot = this.records()?.runtimeContextSnapshots.find(
      (s) => s.handle === evidence.resourceHandle,
    );
    if (!snapshot || snapshot.instanceId !== instanceId)
      throw new RpcFailure("NOT_FOUND", "no host snapshot with that handle", {
        scopeRef,
        absenceProven: true,
      });
    if (snapshot.scopeRef !== scopeRef || evidence.scopeRef !== scopeRef)
      throw new RpcFailure(
        "PERMISSION_DENIED",
        "snapshot belongs to another scope",
        { scopeRef },
      );
    if (
      evidence.revision !== snapshot.revision ||
      evidence.digest !== snapshot.digest ||
      evidence.bytes !== snapshot.bytes ||
      evidence.objectRef !== snapshot.objectRef
    )
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "evidence does not match the fixed snapshot revision",
        { scopeRef, recovery: "resync" },
      );
    // The snapshot inherits the source's constraints: a grant on the source resource is required for every chunk.
    this.coveringGrant(
      instanceId,
      scopeRef,
      params.grantRefs as GrantRef[],
      snapshot.source.resourceHandle as string,
      {},
    );
    const path = join(this.options.runtimeRoot, "context", snapshot.file);
    const bytes = readFileSync(path);
    if (bytes.length !== snapshot.bytes || sha256(bytes) !== snapshot.digest)
      throw new RpcFailure(
        "INTEGRITY_MISMATCH",
        "stored snapshot bytes changed",
        { scopeRef },
      );
    const offset = params.offset as number;
    const slice = bytes.subarray(offset, offset + (params.length as number));
    return {
      resourceHandle: snapshot.handle,
      revision: snapshot.revision,
      offset,
      dataBase64: slice.toString("base64"),
      eof: offset + slice.length >= bytes.length,
      digest: snapshot.digest,
    };
  }
  /** Resolve completed bytes from the authoritative record, never a caller path or the bounded display snapshot. */
  private async executionResultRead(
    instanceId: string,
    params: Json,
  ): Promise<Json> {
    const evidence = params.evidence as unknown as HostEvidenceRef;
    const scopeRef = params.scopeRef as string;
    const executionRef = evidence.objectRef.slice("execution-result:".length);
    const failure = (code: string, message: string, extra: Json = {}) =>
      new RpcFailure(code, message, { scopeRef, recovery: "query", ...extra });
    if (!validRef(executionRef))
      throw failure(
        "PRECONDITION_CONFLICT",
        "invalid execution result identity",
      );
    const authorize = (resourceHandle: string) => {
      const scope = this.scope(instanceId, scopeRef);
      const installation = this.installationOf(instanceId);
      if (
        !scope ||
        scope.state !== "active" ||
        !installation ||
        scope.installationId !== installation.installationId
      )
        throw failure(
          "PERMISSION_DENIED",
          "execution result is outside the active scope",
          { recovery: "reauthorize" },
        );
      const grant = this.coveringGrant(
        instanceId,
        scopeRef,
        params.grantRefs as GrantRef[],
        resourceHandle,
        {},
      );
      if (grant.installationId !== installation.installationId)
        throw failure(
          "PERMISSION_DENIED",
          "result grant belongs to another installation",
          { recovery: "reauthorize" },
        );
      return installation.installationId;
    };
    authorize(evidence.resourceHandle);
    let record: HostExecutionRecord | null;
    let operation: RuntimeOperation | null;
    try {
      record = await this.executionRead(executionRef);
      operation =
        record?.instanceId === instanceId
          ? await this.operationRead(instanceId, record.operationId)
          : null;
    } catch {
      throw failure("RESULT_UNKNOWN", "execution result index is unavailable");
    }
    // Store requests yield to the event loop; revocation and scope changes during lookup
    // must be observed before disclosing a result or proving absence.
    const installationId = authorize(evidence.resourceHandle);
    if (!record)
      throw failure(
        "NOT_FOUND",
        "no execution result record for this instance",
        { absenceProven: true },
      );
    if (
      record.instanceId !== instanceId ||
      record.scopeRef !== scopeRef ||
      record.installationId !== installationId
    )
      throw failure(
        "PERMISSION_DENIED",
        "execution result belongs to another instance or scope",
        { recovery: "reauthorize" },
      );
    authorize(record.resourceHandle);
    if (
      !operation ||
      operation.method !== "host.execution.start" ||
      operation.executionRef !== executionRef ||
      operation.scopeRef !== scopeRef ||
      operation.installationId !== record.installationId ||
      operation.requestDigest !== record.requestIdentity.requestDigest ||
      record.requestIdentity.operationId !== record.operationId
    )
      throw failure(
        "RESULT_UNKNOWN",
        "original execution operation is unavailable or inconsistent",
      );
    if (operation.status === "cancelled")
      throw failure("CANCELLED", "original execution was cancelled");
    if (operation.status === "failed")
      throw failure("EXECUTION_FAILED", "original execution failed");
    if (operation.status !== "succeeded" || record.state !== "completed")
      throw failure("RESULT_UNKNOWN", "execution result is not completed");
    const fixed = record.resultRef;
    if (
      !validHostEvidenceRef(fixed) ||
      !validHostEvidenceRef(operation.resultRef)
    )
      throw failure(
        "RESULT_UNKNOWN",
        "execution has no fixed result reference",
      );
    const same = (ref: HostEvidenceRef) =>
      Object.keys(fixed).every(
        (key) =>
          ref[key as keyof HostEvidenceRef] ===
          fixed[key as keyof HostEvidenceRef],
      );
    if (
      !same(operation.resultRef) ||
      fixed.resourceHandle !== record.resourceHandle ||
      fixed.scopeRef !== record.scopeRef ||
      fixed.objectRef !== "execution-result:" + record.executionRef
    )
      throw failure(
        "RESULT_UNKNOWN",
        "fixed execution result index is inconsistent",
      );
    if (!same(evidence))
      throw failure(
        "PRECONDITION_CONFLICT",
        "evidence differs from the fixed execution result",
        { recovery: "resync" },
      );
    const offset = params.offset as number;
    const length = params.length as number;
    if (offset > fixed.bytes)
      throw failure(
        "PRECONDITION_CONFLICT",
        "offset exceeds the fixed result length",
      );
    const port = this.ports.get(record.portId);
    if (!port?.readResult)
      throw failure(
        "RESULT_UNKNOWN",
        "result reader for the original port is unavailable",
      );
    let data: Buffer;
    try {
      data = port.readResult(record, offset, length);
    } catch (error) {
      if (error instanceof ExecutionResultReadError)
        throw failure(error.code, error.message);
      throw failure("RESULT_UNKNOWN", "fixed result storage is unavailable");
    }
    if (
      !Buffer.isBuffer(data) ||
      data.length !== Math.min(length, fixed.bytes - offset)
    )
      throw failure(
        "INTEGRITY_MISMATCH",
        "result reader returned an invalid chunk",
      );
    return {
      resourceHandle: fixed.resourceHandle,
      revision: fixed.revision,
      offset,
      dataBase64: data.toString("base64"),
      eof: offset + data.length === fixed.bytes,
      digest: fixed.digest,
    };
  }
  /** Validates, persists the reservation and dispatches to the port that owns the profile; without a port the request is refused. */
  private async executionStart(
    installationId: string,
    instanceId: string,
    params: Json,
  ): Promise<Json> {
    const problems = executionStartProblems(params);
    if (problems.length)
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "execution request is malformed: " + problems.slice(0, 4).join("; "),
      );
    const request = params as unknown as ExecutionStartRequest;
    const scope = this.scope(instanceId, request.scopeRef);
    if (!scope || scope.state !== "active")
      throw new RpcFailure("PERMISSION_DENIED", "scope is not authorized", {
        scopeRef: request.scopeRef,
        operationId: request.operationId,
        recovery: "reauthorize",
      });
    const existing = await this.operationRead(instanceId, null, {
      scopeRef: request.scopeRef,
      method: "host.execution.start",
      idempotencyKey: request.idempotencyKey,
    });
    if (existing) {
      if (
        existing.requestDigest !== request.requestDigest ||
        existing.operationId !== request.operationId
      )
        throw new RpcFailure(
          "IDEMPOTENCY_CONFLICT",
          "same idempotency key with another request or operation",
          {
            scopeRef: request.scopeRef,
            operationId: request.operationId,
            recovery: "review",
          },
        );
      return wireOf(existing);
    }
    this.coveringGrant(
      instanceId,
      request.scopeRef,
      request.grantRefs,
      request.resourceHandle,
      { operationId: request.operationId },
    );
    if (request.targetBinding)
      this.coveringGrant(
        instanceId,
        request.scopeRef,
        request.grantRefs,
        request.targetBinding.resourceHandle,
        { operationId: request.operationId },
      );
    const port = this.portFor(request.profileId, request.profileDigest);
    if (!port)
      throw new RpcFailure(
        "UNSUPPORTED_CAPABILITY",
        "no execution port offers profile " + request.profileId,
        { scopeRef: request.scopeRef, operationId: request.operationId },
      );
    const budget = {
      maxOutputBytes: 16_777_216,
      cleanupSeconds: 10,
      ...(request.budget as Record<string, unknown>),
    };
    if (!validExecutionBudget(budget))
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "execution budget out of range",
        { scopeRef: request.scopeRef, operationId: request.operationId },
      );
    // Context materials are Host snapshots of this scope; each is verified against the stored
    // snapshot and the covering grant before the reservation exists, and read once here.
    const materials = request.contextRefs.map((ref) =>
      this.executionMaterial(instanceId, request, ref),
    );
    const executionRef = "execution:" + randomUUID();
    const at = nowIso();
    let operation: RuntimeOperation = {
      operationId: request.operationId,
      installationId,
      instanceId,
      scopeRef: request.scopeRef,
      method: "host.execution.start",
      origin: "runtime",
      idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
      request: params,
      status: "accepted",
      resultCode: null,
      reason: "reservation persisted",
      resultRef: null,
      executionRef,
      revision: "1",
      result: { portId: port.id, state: "reserved" },
      transport: null,
      errorCode: null,
      recovery: null,
      createdAt: at,
      updatedAt: at,
    };
    const connectionId =
      /^connection:(.+)$/.exec(request.connectionRef)?.[1] ?? null;
    const record: HostExecutionRecord = {
      executionRef,
      scopeRef: request.scopeRef,
      state: "reserved",
      connectionRef: request.connectionRef,
      configurationRevision: request.configurationRevision,
      model: request.model,
      requestIdentity: {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        profileDigest: request.profileDigest,
      },
      supervisor: null,
      approvalDecisionRefs: [],
      actualBinding: null,
      stopReason: null,
      accounting: null,
      exit: null,
      observationCompleteness: "unknown",
      resultRef: null,
      reason: "reservation persisted",
      installationId,
      instanceId,
      operationId: request.operationId,
      portId: port.id,
      profileId: request.profileId,
      roleIntent: request.roleIntent,
      domainNodeRef: request.domainNodeRef,
      domainOperationId: request.domainOperationId,
      resourceHandle: request.resourceHandle,
      targetBinding: request.targetBinding,
      agent: request.executionBinding.agent,
      connectionId,
      executionId: randomUUID(),
      target: null,
      children: [],
      unregisteredObservations: [],
      releasedAt: null,
      cancelRequestedAt: null,
      exitClassification: null,
      effort: null,
      budget,
      stopUnconfirmed: null,
      blockedOperations: [],
      recordLocator: null,
      createdAt: at,
      updatedAt: at,
    };
    // The reservation (operation, record, business row and submitted event) is one transaction, before the target is created.
    await this.report({
      type: "runtimeExecutionUpsert",
      record,
      operation,
      event: {
        kind: "submitted",
        payload: {
          kind: "agent_execution",
          profileId: request.profileId,
          roleIntent: request.roleIntent,
          domainNodeRef: request.domainNodeRef,
        },
      },
      pending: null,
    });
    const context = this.executionContext(record, materials);
    let started: Json;
    try {
      started = await port.start(executionRef, request, context);
    } catch (error) {
      started = {
        status: "failed",
        resultCode: "ACCEPT_ABORTED",
        reason: (error as Error).message.slice(0, 2048),
      };
      const current = await this.executionRead(executionRef);
      if (current && !terminalPhysicalStates.includes(current.state))
        await context.transition({
          record: {
            ...current,
            state: "failed",
            reason: started.reason as string,
            observationCompleteness: "complete",
            updatedAt: nowIso(),
          },
          event: {
            kind: "failed",
            payload: { resultCode: "ACCEPT_ABORTED", message: started.reason },
          },
          pending: null,
        });
    }
    // A port that reports transitions has already moved the operation; a port that keeps its own
    // physical memory (the test fake) leaves it at the reservation and the answer moves it here.
    const latest =
      (await this.operationRead(instanceId, request.operationId)) ?? operation;
    if (latest.revision === "1") {
      operation = {
        ...latest,
        status:
          typeof started.status === "string"
            ? (started.status as RuntimeOperation["status"])
            : "running",
        resultCode:
          typeof started.resultCode === "string" ? started.resultCode : null,
        reason:
          typeof started.reason === "string"
            ? started.reason.slice(0, 2048)
            : latest.reason,
        result: { portId: port.id, ...started },
        revision: "2",
        updatedAt: nowIso(),
      };
      await this.persistOperation(operation);
      return wireOf(operation);
    }
    return wireOf(latest);
  }
  // ---------------------------------------------------------------- physical execution records
  async executionRead(
    executionRef: string,
  ): Promise<HostExecutionRecord | null> {
    const reply = await this.report({
      type: "runtimeExecutionRead",
      executionRef,
    });
    return reply.ok ? (reply.runtimeExecution ?? null) : null;
  }
  async executionList(
    instanceId: string | null,
    open: boolean,
  ): Promise<HostExecutionRecord[]> {
    const reply = await this.report({
      type: "runtimeExecutionList",
      instanceId,
      open,
    });
    return reply.ok ? (reply.runtimeExecutionList ?? []) : [];
  }
  /**
   * Executions whose stop is unconfirmed (stopping, the fact recorded, blocked operations
   * held), optionally of one instance or of one resource. RUNTIME-04 keeps their
   * references until the Host has observed every escaped process gone.
   */
  async stopUnconfirmedExecutions(
    filter: { instanceId?: string; resourceHandle?: string } = {},
  ) {
    return (await this.executionList(filter.instanceId ?? null, true)).filter(
      (record) =>
        record.state === "stopping" &&
        record.stopUnconfirmed !== null &&
        record.blockedOperations.length > 0 &&
        (filter.resourceHandle === undefined ||
          record.resourceHandle === filter.resourceHandle),
    );
  }
  /**
   * The refusal a held reference produces: release-resource at quiesce, switch-entry at the
   * supervisor's handoff shutdown, upgrade-extension at the upgrade barrier (update-application
   * has no updater yet and is shown on the general page only). PRECONDITION_CONFLICT with the
   * reason stop-unconfirmed and recovery query (host.execution.get carries the facts); null when
   * nothing is held. Grant revocation is never held (OD-329 b).
   */
  private async stopUnconfirmedBlock(
    operation: BlockedOperation,
    filter: { instanceId?: string; resourceHandle?: string },
  ): Promise<RpcFailure | null> {
    const held = (await this.stopUnconfirmedExecutions(filter)).filter((r) =>
      r.blockedOperations.includes(operation),
    );
    if (held.length === 0) return null;
    return new RpcFailure(
      "PRECONDITION_CONFLICT",
      "stop-unconfirmed: " +
        operation +
        " is refused while " +
        held.length +
        " execution(s) wait for processes outside the target session to exit (" +
        held.map((r) => r.executionRef).join(", ") +
        ")",
      { recovery: "query" },
    );
  }
  /**
   * One context snapshot named by a start request's contextRefs: the same identity, scope and
   * grant checks as host.resource.read, then the stored bytes verified against the digest.
   */
  private executionMaterial(
    instanceId: string,
    request: ExecutionStartRequest,
    ref: Json,
  ): ExecutionMaterial {
    const failure = (
      code: string,
      message: string,
      extra: Json = {},
    ): RpcFailure =>
      new RpcFailure(code, message, {
        scopeRef: request.scopeRef,
        operationId: request.operationId,
        ...extra,
      });
    if (!validHostEvidenceRef(ref) || ref.authority !== "host")
      throw failure(
        "PRECONDITION_CONFLICT",
        "contextRefs must name host evidence (context snapshots)",
      );
    const snapshot = this.records()?.runtimeContextSnapshots.find(
      (s) => s.handle === ref.resourceHandle,
    );
    if (!snapshot || snapshot.instanceId !== instanceId)
      throw failure(
        "NOT_FOUND",
        "no host snapshot with handle " + ref.resourceHandle,
        { absenceProven: true },
      );
    if (
      snapshot.scopeRef !== request.scopeRef ||
      ref.scopeRef !== request.scopeRef
    )
      throw failure("PERMISSION_DENIED", "snapshot belongs to another scope");
    if (
      ref.revision !== snapshot.revision ||
      ref.digest !== snapshot.digest ||
      ref.bytes !== snapshot.bytes ||
      ref.objectRef !== snapshot.objectRef
    )
      throw failure(
        "PRECONDITION_CONFLICT",
        "context evidence does not match the fixed snapshot revision",
        { recovery: "resync" },
      );
    this.coveringGrant(
      instanceId,
      request.scopeRef,
      request.grantRefs,
      snapshot.source.resourceHandle as string,
      { operationId: request.operationId },
    );
    const bytes = readFileSync(
      join(this.options.runtimeRoot, "context", snapshot.file),
    );
    if (bytes.length !== snapshot.bytes || sha256(bytes) !== snapshot.digest)
      throw failure("INTEGRITY_MISMATCH", "stored snapshot bytes changed");
    return { ref: ref as HostEvidenceRef, bytes };
  }
  /** The context a port drives one execution with; every transition commits through the business service. */
  executionContext(
    record: HostExecutionRecord,
    materials: ExecutionMaterial[] = [],
  ): ExecutionContext {
    const resource =
      this.records()?.runtimeResources.find(
        (r) => r.handle === record.resourceHandle,
      ) ?? null;
    return {
      installationId: record.installationId,
      instanceId: record.instanceId,
      record,
      resource,
      connectionId: record.connectionId,
      materials,
      roleBinding: async () => {
        const reply = await this.report({
          type: "runtimeRoleBindingRead",
          instanceId: record.instanceId,
          scopeRef: record.scopeRef,
          roleIntent: record.roleIntent,
        });
        return reply.ok ? (reply.runtimeRoleBinding ?? null) : null;
      },
      current: () => this.executionRead(record.executionRef),
      transition: (update) =>
        this.executionTransition(record.executionRef, update),
    };
  }
  private async executionTransition(
    executionRef: string,
    update: ExecutionTransition,
  ): Promise<HostExecutionRecord> {
    if (update.record.executionRef !== executionRef)
      throw new RpcFailure(
        "PRECONDITION_CONFLICT",
        "transition names another execution",
      );
    const stored = await this.executionRead(executionRef);
    const operation = stored
      ? await this.operationRead(stored.instanceId, stored.operationId)
      : null;
    const operationStatus: Record<PhysicalState, RuntimeOperation["status"]> = {
      queued: "accepted",
      reserved: "accepted",
      running: "running",
      stopping: "running",
      stopped: "cancelled",
      completed: "succeeded",
      failed: "failed",
      unknown: "unknown",
    };
    const moved =
      operation && operation.status !== operationStatus[update.record.state]
        ? {
            ...operation,
            status: operationStatus[update.record.state],
            reason: update.record.reason,
            resultRef: update.record.resultRef as unknown as Json | null,
            resultCode:
              update.record.state === "failed"
                ? ((update.event?.payload.resultCode as string | undefined) ??
                  operation.resultCode ??
                  "EXECUTION_FAILED")
                : operation.resultCode,
            result: {
              ...(operation.result ?? {}),
              state: update.record.state,
              stopReason: update.record.stopReason,
            },
            revision: String(Number(operation.revision ?? "1") + 1),
            updatedAt: update.record.updatedAt,
          }
        : null;
    await this.report({
      type: "runtimeExecutionUpsert",
      record: update.record,
      operation: moved,
      event: update.event,
      pending: update.pending,
    });
    return update.record;
  }
  private async executionCancel(
    installationId: string,
    instanceId: string,
    params: Json,
  ): Promise<Json> {
    for (const key of [
      "operationId",
      "idempotencyKey",
      "scopeRef",
      "executionRef",
    ])
      if (!validRef(params[key]))
        throw new RpcFailure("PRECONDITION_CONFLICT", key + " malformed");
    const scopeRef = params.scopeRef as string;
    const existing = await this.operationRead(instanceId, null, {
      scopeRef,
      method: "host.execution.cancel",
      idempotencyKey: params.idempotencyKey as string,
    });
    if (existing) {
      if (
        existing.requestDigest !== params.requestDigest ||
        existing.operationId !== params.operationId
      )
        throw new RpcFailure(
          "IDEMPOTENCY_CONFLICT",
          "same idempotency key with another request",
          {
            scopeRef,
            operationId: params.operationId as string,
            recovery: "review",
          },
        );
      return wireOf(existing);
    }
    const target = (
      await this.operationList(instanceId, ["host.execution.start"], false)
    ).find((o) => o.executionRef === params.executionRef);
    if (!target)
      throw new RpcFailure("NOT_FOUND", "no execution with that reference", {
        scopeRef,
        operationId: params.operationId as string,
        absenceProven: true,
        recovery: "query",
      });
    if (target.scopeRef !== scopeRef)
      throw new RpcFailure(
        "PERMISSION_DENIED",
        "execution belongs to another scope",
        { scopeRef },
      );
    const port =
      target.result && typeof target.result.portId === "string"
        ? this.ports.get(target.result.portId)
        : null;
    if (!port)
      throw new RpcFailure(
        "RESULT_UNKNOWN",
        "the execution port that owns this execution is not registered",
        { scopeRef, recovery: "query" },
      );
    // Cancel is idempotent against the physical facts: an execution that already reached a
    // terminal state is answered with that state and is never rewritten (a target that
    // completed first stays completed).
    const physical = await this.executionRead(params.executionRef as string);
    const terminal =
      physical && terminalPhysicalStates.includes(physical.state)
        ? physical
        : null;
    const at = nowIso();
    let operation: RuntimeOperation = {
      operationId: params.operationId as string,
      installationId,
      instanceId,
      scopeRef,
      method: "host.execution.cancel",
      origin: "runtime",
      idempotencyKey: params.idempotencyKey as string,
      requestDigest: params.requestDigest as string,
      request: { executionRef: params.executionRef },
      status: "accepted",
      resultCode: null,
      reason: "",
      resultRef: null,
      executionRef: params.executionRef as string,
      revision: "1",
      result: { portId: port.id },
      transport: null,
      errorCode: null,
      recovery: null,
      createdAt: at,
      updatedAt: at,
    };
    await this.persistOperation(operation);
    try {
      const outcome = terminal
        ? {
            status: "succeeded",
            reason:
              "execution already " +
              terminal.state +
              (terminal.stopReason ? " (" + terminal.stopReason + ")" : "") +
              "; not rewritten",
            state: terminal.state,
            stopReason: terminal.stopReason,
            rewritten: false,
          }
        : await port.cancel(
            params.executionRef as string,
            operation.operationId,
          );
      operation = {
        ...operation,
        status:
          typeof outcome.status === "string"
            ? (outcome.status as RuntimeOperation["status"])
            : "succeeded",
        reason: typeof outcome.reason === "string" ? outcome.reason : "",
        result: { portId: port.id, ...outcome },
        revision: "2",
        updatedAt: nowIso(),
      };
    } catch (error) {
      operation = {
        ...operation,
        status: "failed",
        resultCode: "ACCEPT_ABORTED",
        reason: (error as Error).message.slice(0, 2048),
        revision: "2",
        updatedAt: nowIso(),
      };
    }
    await this.persistOperation(operation);
    return wireOf(operation);
  }
  // ---------------------------------------------------------------- diagnostics
  syncState(instanceId: string, scopeRef: string) {
    const sync = this.syncs.get(instanceId + "|" + scopeRef);
    return sync
      ? {
          subscriptionId: sync.subscriptionId,
          resyncs: sync.resyncs,
          ignoredEvents: sync.ignoredEvents,
        }
      : null;
  }
}
/**
 * Merges a wire Operation into the Host record. A terminal result the Host already
 * holds is never regressed to unknown by a tombstone answer (the retired result stays
 * history); the answer is kept in reason and the record points at query for recovery.
 */
function mergeWire(
  operation: RuntimeOperation,
  wire: WireOperation,
  transport: RuntimeOperation["transport"],
  errorCode: string | null,
): RuntimeOperation {
  if (wire.status === "unknown" && terminal(operation.status))
    return {
      ...operation,
      reason: wire.reason,
      transport,
      errorCode,
      recovery: "query",
      updatedAt: nowIso(),
    };
  return {
    ...operation,
    status: wire.status,
    resultCode: wire.resultCode,
    reason: wire.reason,
    resultRef: wire.resultRef,
    executionRef: wire.executionRef,
    revision: wire.revision,
    transport,
    errorCode,
    recovery: null,
    updatedAt: nowIso(),
  };
}
/** Stable code and Contract recovery hint of a failed call; transport failures carry no hint. */
function failureOf(error: unknown): {
  code: string;
  recovery: Recovery | null;
} {
  if (error instanceof CallError) {
    const hint = error.data?.recovery;
    return {
      code: error.code,
      recovery: recoveries.includes(hint as Recovery)
        ? (hint as Recovery)
        : null,
    };
  }
  if (error instanceof RpcFailure)
    return { code: error.code, recovery: error.recovery as Recovery };
  return { code: "PROTOCOL", recovery: null };
}
function wireOf(operation: RuntimeOperation): Json {
  return {
    operationId: operation.operationId,
    scopeRef: operation.scopeRef,
    requestDigest: operation.requestDigest,
    status: operation.status,
    resultRef: operation.resultRef,
    executionRef: operation.executionRef,
    reason: operation.reason,
    resultCode: operation.resultCode,
    revision: operation.revision ?? "1",
  };
}
function receiptOf(operation: RuntimeOperation): Json {
  const result = operation.result ?? {};
  return {
    operationId: operation.operationId,
    scopeRef: operation.scopeRef,
    domainOperationId: result.domainOperationId,
    requestDigest: operation.requestDigest,
    status: operation.status,
    snapshots: operation.status === "succeeded" ? (result.snapshots ?? []) : [],
    reason: operation.reason,
  };
}
export { compareSeq };
