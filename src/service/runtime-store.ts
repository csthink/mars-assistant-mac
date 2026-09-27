/**
 * Runtime Host persistence in the business service (the single SQLite writer):
 * verified installations, the primary instance of each with its last known process,
 * negotiation, failure and health records, registered resources, scopes with their
 * projection sync state, the projection itself (objects, actions, pending items held
 * in generations that are swapped atomically), applied event identities for
 * duplicate and conflict detection, grants and operations. The supervisor in the
 * main process reports every transition as a host command; the renderer only reads
 * the snapshot. Records are stored as validated JSON columns keyed by their identities.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { StoreError } from "./errors";
import {
  applyExecutionUpsert,
  applyRoleBindingUpsert,
  executionSnapshot,
  listExecutions,
  readExecution,
  readRoleBinding,
} from "./runtime-executions";
import type {
  HostExecutionRecord,
  RuntimeRoleBinding,
} from "../shared/runtime-execution";
import {
  canonicalJson,
  compareSeq,
  nextSeq,
  validRuntimeInstallation,
  validRuntimeInstance,
  type EventOutcome,
  type ProjectionEvent,
  type RuntimeContextSnapshot,
  type RuntimeDecision,
  type RuntimeGrant,
  type RuntimeHostCommand,
  type RuntimeInstallation,
  type RuntimeInstance,
  type RuntimeOperation,
  type RuntimeProjection,
  type RuntimeResource,
  type RuntimeScope,
  type RuntimeSnapshot,
  type SnapshotPage,
  type WireOperation,
  type OperationKey,
} from "../shared/runtime-host";

export const runtimeSchema = `
CREATE TABLE runtime_installations (
  installation_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  record TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE INDEX runtime_installations_runtime ON runtime_installations(runtime_id, imported_at);
CREATE TABLE runtime_instances (
  instance_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES runtime_installations(installation_id),
  record TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX runtime_instances_installation ON runtime_instances(installation_id);
CREATE TABLE runtime_resources (
  handle TEXT PRIMARY KEY,
  record TEXT NOT NULL,
  registered_at TEXT NOT NULL
);
CREATE TABLE runtime_scopes (
  instance_id TEXT NOT NULL REFERENCES runtime_instances(instance_id),
  scope_ref TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  record TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(instance_id, scope_ref)
);
CREATE TABLE runtime_projection_objects (
  instance_id TEXT NOT NULL, scope_ref TEXT NOT NULL, generation INTEGER NOT NULL,
  object_ref TEXT NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY(instance_id, scope_ref, generation, object_ref)
);
CREATE TABLE runtime_projection_actions (
  instance_id TEXT NOT NULL, scope_ref TEXT NOT NULL, generation INTEGER NOT NULL,
  action_key TEXT NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY(instance_id, scope_ref, generation, action_key)
);
CREATE TABLE runtime_projection_pending (
  instance_id TEXT NOT NULL, scope_ref TEXT NOT NULL, generation INTEGER NOT NULL,
  item_ref TEXT NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY(instance_id, scope_ref, generation, item_ref)
);
CREATE TABLE runtime_events (
  instance_id TEXT NOT NULL, scope_ref TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
  event_id TEXT NOT NULL, digest TEXT NOT NULL, applied_at TEXT NOT NULL,
  PRIMARY KEY(instance_id, scope_ref, epoch, seq)
);
CREATE TABLE runtime_grants (
  grant_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES runtime_instances(instance_id),
  scope_ref TEXT NOT NULL,
  record TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX runtime_grants_scope ON runtime_grants(instance_id, scope_ref);
CREATE TABLE runtime_operations (
  operation_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES runtime_instances(instance_id),
  scope_ref TEXT NOT NULL,
  method TEXT NOT NULL,
  idempotency_key TEXT,
  record TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  touched INTEGER NOT NULL
);
CREATE INDEX runtime_operations_instance ON runtime_operations(instance_id, touched);
CREATE TABLE runtime_context_snapshots (
  handle TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES runtime_instances(instance_id),
  scope_ref TEXT NOT NULL,
  record TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX runtime_operations_key ON runtime_operations(instance_id, scope_ref, method, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE runtime_decisions (
  decision_ref TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES runtime_instances(instance_id),
  scope_ref TEXT NOT NULL,
  domain_operation_id TEXT NOT NULL UNIQUE REFERENCES runtime_operations(operation_id),
  record TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX runtime_decisions_instance ON runtime_decisions(instance_id, created_at);
`;

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const digestOf = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
/** Applied event identities kept per scope for duplicate and conflict detection. */
const retainedEvents = 512;
const retainedOperations = 50;

function scopeRow(db: DatabaseSync, instanceId: string, scopeRef: string) {
  const row = db
    .prepare(
      "SELECT generation, record FROM runtime_scopes WHERE instance_id=? AND scope_ref=?",
    )
    .get(instanceId, scopeRef) as
    { generation: number; record: string } | undefined;
  return row
    ? {
        generation: row.generation,
        scope: JSON.parse(row.record) as RuntimeScope,
      }
    : null;
}
function saveScope(db: DatabaseSync, scope: RuntimeScope, generation: number) {
  const { counts: _counts, ...stored } = scope;
  void _counts;
  db.prepare(
    `INSERT INTO runtime_scopes (instance_id, scope_ref, generation, record, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(instance_id, scope_ref) DO UPDATE SET generation=excluded.generation, record=excluded.record, updated_at=excluded.updated_at`,
  ).run(
    scope.instanceId,
    scope.scopeRef,
    generation,
    JSON.stringify(stored),
    stored.updatedAt,
  );
}
function requireInstance(db: DatabaseSync, instanceId: string) {
  const row = db
    .prepare(
      "SELECT installation_id AS installationId FROM runtime_instances WHERE instance_id=?",
    )
    .get(instanceId) as { installationId: string } | undefined;
  if (!row) throw new StoreError("NOT_FOUND", "实例记录不存在。");
  return row;
}

/** Cross-page consistency of a snapshot before it may replace the current generation. */
function snapshotProblems(scopeRef: string, pages: SnapshotPage[]): string[] {
  const problems: string[] = [];
  const first = pages[0];
  for (const [index, page] of pages.entries()) {
    if (page.scopeRef !== scopeRef)
      problems.push(`page ${index} belongs to ${page.scopeRef}`);
    for (const field of [
      "snapshotId",
      "revision",
      "streamId",
      "epoch",
      "throughSeq",
    ] as const)
      if (page[field] !== first[field])
        problems.push(`page ${index} ${field} differs from page 0`);
    if (index < pages.length - 1 && page.nextPageToken === null)
      problems.push(`page ${index} ends the snapshot early`);
  }
  if (pages[pages.length - 1].nextPageToken !== null)
    problems.push("last page is not final");
  const objects = new Set<string>();
  const actions = new Set<string>();
  const items = new Set<string>();
  for (const page of pages) {
    for (const o of page.objects) {
      if (o.scopeRef !== scopeRef) problems.push(`object ${o.objectRef} scope`);
      if (objects.has(o.objectRef))
        problems.push(`duplicate object ${o.objectRef}`);
      objects.add(o.objectRef);
    }
    for (const a of page.actions) {
      if (a.scopeRef !== scopeRef) problems.push(`action ${a.actionId} scope`);
      const key = a.actionId + "@" + a.objectRef;
      if (actions.has(key)) problems.push(`duplicate action ${key}`);
      actions.add(key);
    }
    for (const p of page.pendingItems) {
      if (p.scopeRef !== scopeRef) problems.push(`pending ${p.itemRef} scope`);
      if (items.has(p.itemRef))
        problems.push(`duplicate pending item ${p.itemRef}`);
      items.add(p.itemRef);
    }
  }
  for (const page of pages) {
    for (const a of page.actions)
      if (!objects.has(a.objectRef))
        problems.push(
          `action ${a.actionId} targets unknown object ${a.objectRef}`,
        );
    for (const p of page.pendingItems)
      if (!objects.has(p.objectRef))
        problems.push(
          `pending item ${p.itemRef} targets unknown object ${p.objectRef}`,
        );
  }
  return problems;
}

function replaceProjection(
  db: DatabaseSync,
  instanceId: string,
  scopeRef: string,
  pages: SnapshotPage[],
) {
  const current = scopeRow(db, instanceId, scopeRef);
  if (!current)
    throw new StoreError("NOT_FOUND", "scope 尚未登记，不能装入快照。");
  const problems = snapshotProblems(scopeRef, pages);
  if (problems.length)
    throw new StoreError(
      "INVALID_COMMAND",
      "快照不一致，未替换 projection：" + problems.slice(0, 5).join("；"),
    );
  const generation = current.generation + 1;
  const insertObject = db.prepare(
    "INSERT INTO runtime_projection_objects (instance_id, scope_ref, generation, object_ref, record) VALUES (?,?,?,?,?)",
  );
  const insertAction = db.prepare(
    "INSERT INTO runtime_projection_actions (instance_id, scope_ref, generation, action_key, record) VALUES (?,?,?,?,?)",
  );
  const insertPending = db.prepare(
    "INSERT INTO runtime_projection_pending (instance_id, scope_ref, generation, item_ref, record) VALUES (?,?,?,?,?)",
  );
  for (const page of pages) {
    for (const o of page.objects)
      insertObject.run(
        instanceId,
        scopeRef,
        generation,
        o.objectRef,
        JSON.stringify(o),
      );
    for (const a of page.actions)
      insertAction.run(
        instanceId,
        scopeRef,
        generation,
        a.actionId + "@" + a.objectRef,
        JSON.stringify(a),
      );
    for (const p of page.pendingItems)
      insertPending.run(
        instanceId,
        scopeRef,
        generation,
        p.itemRef,
        JSON.stringify(p),
      );
  }
  for (const table of [
    "runtime_projection_objects",
    "runtime_projection_actions",
    "runtime_projection_pending",
  ])
    db.prepare(
      `DELETE FROM ${table} WHERE instance_id=? AND scope_ref=? AND generation<>?`,
    ).run(instanceId, scopeRef, generation);
  // A new snapshot is a new basis: earlier applied-event identities no longer describe this projection.
  db.prepare(
    "DELETE FROM runtime_events WHERE instance_id=? AND scope_ref=?",
  ).run(instanceId, scopeRef);
  const first = pages[0];
  const scope: RuntimeScope = {
    ...current.scope,
    freshness: "syncing",
    cursor: {
      streamId: first.streamId,
      epoch: first.epoch,
      seq: first.throughSeq,
    },
    revision: first.revision,
    snapshotId: first.snapshotId,
    subscriptionId: null,
    lastError: null,
    updatedAt: nowIso(),
  };
  saveScope(db, scope, generation);
}

/**
 * Applies one data event under the Contract's ordering rules. The projection change
 * and the cursor advance commit in the caller's transaction; the ack is sent only
 * after the commit. Outcomes other than "applied" leave the projection untouched and,
 * for conflict, gap and epoch, mark the scope stale.
 */
function applyEvent(
  db: DatabaseSync,
  instanceId: string,
  scopeRef: string,
  event: ProjectionEvent,
): EventOutcome {
  const current = scopeRow(db, instanceId, scopeRef);
  if (!current || !current.scope.cursor) return "no-projection";
  const { scope, generation } = current;
  const cursor = scope.cursor!;
  const stale = (code: string, message: string): void => {
    saveScope(
      db,
      {
        ...scope,
        freshness: "stale",
        lastError: { code, message, at: nowIso() },
        updatedAt: nowIso(),
      },
      generation,
    );
  };
  if (event.scopeRef !== scopeRef) {
    stale("PROTOCOL", `event ${event.eventId} names scope ${event.scopeRef}`);
    return "conflict";
  }
  if (event.streamId !== cursor.streamId || event.epoch !== cursor.epoch) {
    stale(
      "RESYNC_REQUIRED",
      `event ${event.eventId} belongs to ${event.streamId}/${event.epoch}, projection follows ${cursor.streamId}/${cursor.epoch}`,
    );
    return "epoch";
  }
  const digest = digestOf({
    kind: event.kind,
    payload: event.payload,
    domainRevision: event.domainRevision,
    causationId: event.causationId,
  });
  const order = compareSeq(event.seq, cursor.seq);
  if (order <= 0) {
    const applied = db
      .prepare(
        "SELECT event_id AS eventId, digest FROM runtime_events WHERE instance_id=? AND scope_ref=? AND epoch=? AND seq=?",
      )
      .get(instanceId, scopeRef, event.epoch, Number(event.seq)) as
      { eventId: string; digest: string } | undefined;
    if (!applied) return "duplicate";
    if (applied.eventId === event.eventId && applied.digest === digest)
      return "duplicate";
    stale(
      "PROTOCOL",
      `event seq ${event.seq} arrived twice with different identity or content`,
    );
    return "conflict";
  }
  if (event.seq !== nextSeq(cursor.seq)) {
    stale(
      "RESYNC_REQUIRED",
      `event seq ${event.seq} skips ahead of ${cursor.seq}`,
    );
    return "gap";
  }
  const payload = event.payload;
  switch (event.kind) {
    case "object.upsert":
      db.prepare(
        "INSERT OR REPLACE INTO runtime_projection_objects (instance_id, scope_ref, generation, object_ref, record) VALUES (?,?,?,?,?)",
      ).run(
        instanceId,
        scopeRef,
        generation,
        payload.objectRef as string,
        JSON.stringify(payload),
      );
      break;
    case "object.remove":
      db.prepare(
        "DELETE FROM runtime_projection_objects WHERE instance_id=? AND scope_ref=? AND generation=? AND object_ref=?",
      ).run(instanceId, scopeRef, generation, payload.objectRef as string);
      break;
    case "action.upsert":
      db.prepare(
        "INSERT OR REPLACE INTO runtime_projection_actions (instance_id, scope_ref, generation, action_key, record) VALUES (?,?,?,?,?)",
      ).run(
        instanceId,
        scopeRef,
        generation,
        `${payload.actionId}@${payload.objectRef}`,
        JSON.stringify(payload),
      );
      break;
    case "action.remove":
      db.prepare(
        "DELETE FROM runtime_projection_actions WHERE instance_id=? AND scope_ref=? AND generation=? AND action_key LIKE ?",
      ).run(instanceId, scopeRef, generation, `${payload.actionId}@%`);
      break;
    case "pending.upsert":
      db.prepare(
        "INSERT OR REPLACE INTO runtime_projection_pending (instance_id, scope_ref, generation, item_ref, record) VALUES (?,?,?,?,?)",
      ).run(
        instanceId,
        scopeRef,
        generation,
        payload.itemRef as string,
        JSON.stringify(payload),
      );
      break;
    case "pending.remove":
      db.prepare(
        "DELETE FROM runtime_projection_pending WHERE instance_id=? AND scope_ref=? AND generation=? AND item_ref=?",
      ).run(instanceId, scopeRef, generation, payload.itemRef as string);
      break;
    case "operation.changed":
      recordRuntimeOperation(
        db,
        instanceId,
        scopeRef,
        payload as unknown as WireOperation,
      );
      break;
  }
  db.prepare(
    "INSERT INTO runtime_events (instance_id, scope_ref, epoch, seq, event_id, digest, applied_at) VALUES (?,?,?,?,?,?,?)",
  ).run(
    instanceId,
    scopeRef,
    event.epoch,
    Number(event.seq),
    event.eventId,
    digest,
    nowIso(),
  );
  db.prepare(
    `DELETE FROM runtime_events WHERE instance_id=? AND scope_ref=? AND seq <= (
       SELECT seq FROM runtime_events WHERE instance_id=? AND scope_ref=? ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
  ).run(instanceId, scopeRef, instanceId, scopeRef, retainedEvents);
  saveScope(
    db,
    {
      ...scope,
      cursor: { ...cursor, seq: event.seq },
      revision: event.domainRevision,
      updatedAt: nowIso(),
    },
    generation,
  );
  return "applied";
}
/** An operation the Runtime reports (invoke reply, operation.changed, operation.get) merges into the Host's record. */
export function recordRuntimeOperation(
  db: DatabaseSync,
  instanceId: string,
  scopeRef: string,
  wire: WireOperation,
) {
  const existing = db
    .prepare("SELECT record FROM runtime_operations WHERE operation_id=?")
    .get(wire.operationId) as { record: string } | undefined;
  const installation = requireInstance(db, instanceId);
  const at = nowIso();
  const previous = existing
    ? (JSON.parse(existing.record) as RuntimeOperation)
    : null;
  if (previous && previous.instanceId !== instanceId)
    throw new StoreError("CONFLICT", "操作记录属于另一个实例。");
  if (
    previous &&
    previous.scopeRef !== wire.scopeRef &&
    previous.scopeRef !== scopeRef
  )
    throw new StoreError("CONFLICT", "操作记录属于另一个 scope。");
  const record: RuntimeOperation = previous
    ? {
        ...previous,
        status: wire.status,
        resultCode: wire.resultCode,
        reason: wire.reason,
        resultRef: wire.resultRef,
        executionRef: wire.executionRef,
        revision: wire.revision,
        updatedAt: at,
      }
    : {
        operationId: wire.operationId,
        installationId: installation.installationId,
        instanceId,
        scopeRef: wire.scopeRef,
        method: "runtime.event",
        origin: "runtime",
        idempotencyKey: null,
        requestDigest: wire.requestDigest,
        request: null,
        status: wire.status,
        resultCode: wire.resultCode,
        reason: wire.reason,
        resultRef: wire.resultRef,
        executionRef: wire.executionRef,
        revision: wire.revision,
        result: null,
        transport: null,
        errorCode: null,
        recovery: null,
        createdAt: at,
        updatedAt: at,
      };
  upsertOperation(db, record);
}
/** Authoritative operation lookup by id, else by dedupe key; the table keeps every operation. */
export function readOperation(
  db: DatabaseSync,
  instanceId: string,
  operationId: string | null,
  key: OperationKey | null,
): RuntimeOperation | null {
  const byId = operationId
    ? (db
        .prepare(
          "SELECT record FROM runtime_operations WHERE operation_id=? AND instance_id=?",
        )
        .get(operationId, instanceId) as { record: string } | undefined)
    : undefined;
  const row =
    byId ??
    (key
      ? (db
          .prepare(
            "SELECT record FROM runtime_operations WHERE instance_id=? AND scope_ref=? AND method=? AND idempotency_key=?",
          )
          .get(instanceId, key.scopeRef, key.method, key.idempotencyKey) as
          { record: string } | undefined)
      : undefined);
  return row ? (JSON.parse(row.record) as RuntimeOperation) : null;
}
/** Operations of one instance filtered by method; open keeps non-terminal ones and unresolved Host requests. */
export function listOperations(
  db: DatabaseSync,
  instanceId: string,
  methods: string[],
  open: boolean,
): RuntimeOperation[] {
  const rows = db
    .prepare(
      "SELECT record FROM runtime_operations WHERE instance_id=? ORDER BY touched DESC",
    )
    .all(instanceId) as { record: string }[];
  return rows
    .map((row) => JSON.parse(row.record) as RuntimeOperation)
    .filter((o) => methods.length === 0 || methods.includes(o.method))
    .filter(
      (o) =>
        !open ||
        !["succeeded", "failed", "cancelled"].includes(o.status) ||
        o.transport === "sent" ||
        o.transport === "lost",
    );
}
export function readDecision(
  db: DatabaseSync,
  instanceId: string,
  decisionRef: string,
): RuntimeDecision | null {
  const row = db
    .prepare(
      "SELECT record FROM runtime_decisions WHERE decision_ref=? AND instance_id=?",
    )
    .get(decisionRef, instanceId) as { record: string } | undefined;
  return row ? (JSON.parse(row.record) as RuntimeDecision) : null;
}
/** Every write advances a store-wide counter so "newest first" is exact even within one second. */
function upsertOperation(db: DatabaseSync, operation: RuntimeOperation) {
  const touched =
    (
      db
        .prepare(
          "SELECT COALESCE(MAX(touched), 0) AS n FROM runtime_operations",
        )
        .get() as { n: number }
    ).n + 1;
  db.prepare(
    `INSERT INTO runtime_operations (operation_id, instance_id, scope_ref, method, idempotency_key, record, created_at, updated_at, touched) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(operation_id) DO UPDATE SET record=excluded.record, updated_at=excluded.updated_at, touched=excluded.touched`,
  ).run(
    operation.operationId,
    operation.instanceId,
    operation.scopeRef,
    operation.method,
    operation.idempotencyKey,
    JSON.stringify(operation),
    operation.createdAt,
    operation.updatedAt,
    touched,
  );
}

export interface RuntimeHostResult {
  runtimeEvent?: EventOutcome;
  runtimeProjection?: RuntimeProjection;
  runtimeOperation?: RuntimeOperation | null;
  runtimeDecision?: RuntimeDecision | null;
  runtimeOperationList?: RuntimeOperation[];
  runtimeExecution?: HostExecutionRecord | null;
  runtimeExecutionList?: HostExecutionRecord[];
  runtimeRoleBinding?: RuntimeRoleBinding | null;
}
export function applyRuntimeHost(
  db: DatabaseSync,
  command: RuntimeHostCommand,
): RuntimeHostResult {
  switch (command.type) {
    case "runtimeInstall": {
      const installation = command.installation;
      if (!validRuntimeInstallation(installation))
        throw new StoreError("INVALID_COMMAND", "安装记录无效，未写入。");
      if (
        db
          .prepare(
            "SELECT 1 FROM runtime_installations WHERE installation_id=?",
          )
          .get(installation.installationId)
      )
        throw new StoreError("CONFLICT", "安装记录已存在，不能覆盖。");
      // One recorded identity per runtimeId and version (KB-278 item 6): changed bytes need a new version number,
      // and the same bytes are the installation already recorded.
      for (const row of db
        .prepare("SELECT record FROM runtime_installations WHERE runtime_id=?")
        .all(installation.runtimeId) as { record: string }[]) {
        const recorded = JSON.parse(row.record) as RuntimeInstallation;
        if (recorded.version !== installation.version) continue;
        throw new StoreError(
          "CONFLICT",
          recorded.artifactDigest === installation.artifactDigest &&
            recorded.releaseRecordDigest === installation.releaseRecordDigest
            ? "该运行包版本已安装，未新建安装记录。"
            : "同一运行包版本已以不同字节安装；变更字节须使用新版本号，未写入。",
        );
      }
      db.prepare(
        "INSERT INTO runtime_installations (installation_id, runtime_id, artifact_digest, record, imported_at) VALUES (?,?,?,?,?)",
      ).run(
        installation.installationId,
        installation.runtimeId,
        installation.artifactDigest,
        JSON.stringify(installation),
        installation.importedAt,
      );
      return {};
    }
    case "runtimeInstanceUpsert": {
      const instance = command.instance;
      if (!validRuntimeInstance(instance))
        throw new StoreError("INVALID_COMMAND", "实例记录无效，未写入。");
      if (
        !db
          .prepare(
            "SELECT 1 FROM runtime_installations WHERE installation_id=?",
          )
          .get(instance.installationId)
      )
        throw new StoreError("NOT_FOUND", "实例所属的安装记录不存在。");
      const owner = db
        .prepare(
          "SELECT installation_id AS id FROM runtime_instances WHERE instance_id=?",
        )
        .get(instance.instanceId) as { id: string } | undefined;
      if (owner && owner.id !== instance.installationId)
        throw new StoreError("CONFLICT", "实例不能改属另一个安装记录。");
      db.prepare(
        `INSERT INTO runtime_instances (instance_id, installation_id, record, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(instance_id) DO UPDATE SET record=excluded.record, updated_at=excluded.updated_at`,
      ).run(
        instance.instanceId,
        instance.installationId,
        JSON.stringify(instance),
        instance.updatedAt,
      );
      return {};
    }
    case "runtimeResourceRegister": {
      const resource = command.resource;
      const existing = db
        .prepare("SELECT record FROM runtime_resources WHERE handle=?")
        .get(resource.handle) as { record: string } | undefined;
      if (existing) {
        if (
          (JSON.parse(existing.record) as RuntimeResource).path !==
          resource.path
        )
          throw new StoreError("CONFLICT", "资源句柄已绑定另一个路径。");
        return {};
      }
      db.prepare(
        "INSERT INTO runtime_resources (handle, record, registered_at) VALUES (?,?,?)",
      ).run(resource.handle, JSON.stringify(resource), resource.registeredAt);
      return {};
    }
    case "runtimeScopeUpsert": {
      const scope = command.scope;
      const instance = requireInstance(db, scope.instanceId);
      if (instance.installationId !== scope.installationId)
        throw new StoreError("CONFLICT", "scope 的安装记录与实例不符。");
      if (
        !db
          .prepare("SELECT 1 FROM runtime_resources WHERE handle=?")
          .get(scope.resourceHandle)
      )
        throw new StoreError("NOT_FOUND", "scope 绑定的资源未登记。");
      const current = scopeRow(db, scope.instanceId, scope.scopeRef);
      if (
        current &&
        (current.scope.bindingRef !== scope.bindingRef ||
          current.scope.resourceHandle !== scope.resourceHandle)
      )
        throw new StoreError(
          "CONFLICT",
          "scope 不能改绑另一个资源或绑定身份。",
        );
      // The sync fields are owned by the projection commands; a scope upsert carries binding, authorization and subscription state.
      const merged: RuntimeScope = current
        ? {
            ...current.scope,
            state: scope.state,
            grantRefs: scope.grantRefs,
            subscriptionId: scope.subscriptionId,
            freshness: scope.freshness,
            lastError: scope.lastError,
            updatedAt: scope.updatedAt,
          }
        : {
            ...scope,
            cursor: null,
            revision: null,
            snapshotId: null,
            freshness: "missing",
          };
      saveScope(db, merged, current?.generation ?? 0);
      return {};
    }
    case "runtimeProjectionReplace":
      replaceProjection(
        db,
        command.instanceId,
        command.scopeRef,
        command.pages,
      );
      return {};
    case "runtimeEventApply":
      return {
        runtimeEvent: applyEvent(
          db,
          command.instanceId,
          command.scopeRef,
          command.event,
        ),
      };
    case "runtimeCaughtUp": {
      const current = scopeRow(db, command.instanceId, command.scopeRef);
      if (!current || !current.scope.cursor)
        throw new StoreError("NOT_FOUND", "scope 没有 projection。");
      const cursor = current.scope.cursor;
      // Current only when the replay reached the cursor without a gap; otherwise the scope keeps syncing.
      const caughtUp =
        cursor.streamId === command.streamId &&
        cursor.epoch === command.epoch &&
        compareSeq(command.throughSeq, cursor.seq) <= 0;
      if (current.scope.freshness === "syncing" && caughtUp)
        saveScope(
          db,
          { ...current.scope, freshness: "current", updatedAt: nowIso() },
          current.generation,
        );
      return {};
    }
    case "runtimeOperationUpsert": {
      const operation = command.operation;
      const instance = requireInstance(db, operation.instanceId);
      if (instance.installationId !== operation.installationId)
        throw new StoreError("CONFLICT", "操作的安装记录与实例不符。");
      const existing = db
        .prepare("SELECT record FROM runtime_operations WHERE operation_id=?")
        .get(operation.operationId) as { record: string } | undefined;
      if (existing) {
        const previous = JSON.parse(existing.record) as RuntimeOperation;
        if (
          previous.instanceId !== operation.instanceId ||
          previous.requestDigest !== operation.requestDigest ||
          previous.method !== operation.method
        )
          throw new StoreError(
            "CONFLICT",
            "操作身份、方法或请求摘要不能改写。",
          );
      }
      if (operation.idempotencyKey) {
        const holder = db
          .prepare(
            "SELECT operation_id AS id FROM runtime_operations WHERE instance_id=? AND scope_ref=? AND method=? AND idempotency_key=?",
          )
          .get(
            operation.instanceId,
            operation.scopeRef,
            operation.method,
            operation.idempotencyKey,
          ) as { id: string } | undefined;
        if (holder && holder.id !== operation.operationId)
          throw new StoreError("CONFLICT", "幂等键已被另一个操作使用。");
      }
      upsertOperation(db, operation);
      return {};
    }
    case "runtimeGrantBatch":
      // The surrounding command transaction makes the batch all-or-nothing.
      for (const grant of command.grants)
        applyRuntimeHost(db, { type: "runtimeGrantUpsert", grant });
      return {};
    case "runtimeGrantUpsert": {
      const grant = command.grant;
      const instance = requireInstance(db, grant.instanceId);
      if (instance.installationId !== grant.installationId)
        throw new StoreError("CONFLICT", "授权的安装记录与实例不符。");
      const existing = db
        .prepare("SELECT record FROM runtime_grants WHERE grant_id=?")
        .get(grant.ref.id) as { record: string } | undefined;
      if (existing) {
        const previous = JSON.parse(existing.record) as RuntimeGrant;
        // Only the lifecycle moves: identity, subject, capability, operation and resource are immutable, and a revoked grant never returns.
        for (const key of [
          "instanceId",
          "scopeRef",
          "resourceHandle",
          "capability",
          "operation",
          "bundleDigest",
          "createdAt",
          "purpose",
          "authorizationId",
        ] as const)
          if (previous[key] !== grant[key])
            throw new StoreError("CONFLICT", "授权记录的身份字段不能改写。");
        if (previous.status !== "active" && grant.status === "active")
          throw new StoreError(
            "CONFLICT",
            "已撤销或过期的授权不能恢复，请建立新的授权。",
          );
        if (
          grant.ref.revision !== previous.ref.revision &&
          Number(grant.ref.revision) <= Number(previous.ref.revision)
        )
          throw new StoreError("CONFLICT", "授权修订只能递增。");
      }
      db.prepare(
        `INSERT INTO runtime_grants (grant_id, instance_id, scope_ref, record, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(grant_id) DO UPDATE SET record=excluded.record`,
      ).run(
        grant.ref.id,
        grant.instanceId,
        grant.scopeRef,
        JSON.stringify(grant),
        grant.createdAt,
      );
      return {};
    }
    case "runtimeContextSnapshotUpsert": {
      const snapshot = command.snapshot;
      const instance = requireInstance(db, snapshot.instanceId);
      if (instance.installationId !== snapshot.installationId)
        throw new StoreError("CONFLICT", "上下文快照的安装记录与实例不符。");
      if (
        db
          .prepare("SELECT 1 FROM runtime_context_snapshots WHERE handle=?")
          .get(snapshot.handle)
      )
        throw new StoreError("CONFLICT", "上下文快照是不可变记录，不能覆盖。");
      db.prepare(
        "INSERT INTO runtime_context_snapshots (handle, instance_id, scope_ref, record, created_at) VALUES (?,?,?,?,?)",
      ).run(
        snapshot.handle,
        snapshot.instanceId,
        snapshot.scopeRef,
        JSON.stringify(snapshot),
        snapshot.createdAt,
      );
      return {};
    }
    case "runtimeDecisionRecord": {
      const { decision, operation } = command;
      const instance = requireInstance(db, decision.instanceId);
      if (
        instance.installationId !== decision.installationId ||
        operation.instanceId !== decision.instanceId ||
        operation.installationId !== decision.installationId
      )
        throw new StoreError("CONFLICT", "决定记录的安装或实例与操作不符。");
      if (!scopeRow(db, decision.instanceId, decision.scopeRef))
        throw new StoreError("NOT_FOUND", "决定记录指向不存在的 scope。");
      // The record binds exactly the Invoke it authorizes: same scope, operation identity, digest and action semantics.
      const request = operation.request ?? {};
      if (
        operation.scopeRef !== decision.scopeRef ||
        operation.method !== decision.method ||
        operation.origin !== "host" ||
        operation.operationId !== decision.domainOperationId ||
        operation.requestDigest !== decision.requestDigest ||
        request.decisionRef !== decision.decisionRef ||
        request.actionId !== decision.actionId ||
        request.objectRef !== decision.objectRef ||
        (request.candidateRef ?? null) !== decision.candidateRef ||
        request.expectedRevision !== decision.expectedRevision
      )
        throw new StoreError("CONFLICT", "决定记录与待发送请求不一致。");
      if (decision.status !== "valid")
        throw new StoreError("CONFLICT", "新建的决定记录只能是 valid。");
      if (
        db
          .prepare("SELECT 1 FROM runtime_decisions WHERE decision_ref=?")
          .get(decision.decisionRef)
      )
        throw new StoreError("CONFLICT", "决定记录是不可变记录，不能覆盖。");
      if (
        db
          .prepare("SELECT 1 FROM runtime_operations WHERE operation_id=?")
          .get(operation.operationId)
      )
        throw new StoreError("CONFLICT", "决定必须与新的待发送请求一起建立。");
      const holder = db
        .prepare(
          "SELECT operation_id AS id FROM runtime_operations WHERE instance_id=? AND scope_ref=? AND method=? AND idempotency_key=?",
        )
        .get(
          operation.instanceId,
          operation.scopeRef,
          operation.method,
          operation.idempotencyKey,
        ) as { id: string } | undefined;
      if (holder)
        throw new StoreError("CONFLICT", "幂等键已被另一个操作使用。");
      upsertOperation(db, operation);
      db.prepare(
        "INSERT INTO runtime_decisions (decision_ref, instance_id, scope_ref, domain_operation_id, record, created_at) VALUES (?,?,?,?,?,?)",
      ).run(
        decision.decisionRef,
        decision.instanceId,
        decision.scopeRef,
        decision.domainOperationId,
        JSON.stringify(decision),
        decision.recordedAt,
      );
      return {};
    }
    case "runtimeDecisionRevoke": {
      const decision = readDecision(
        db,
        command.instanceId,
        command.decisionRef,
      );
      if (!decision) throw new StoreError("NOT_FOUND", "决定记录不存在。");
      // Revocation appends the status; the confirmed content stays as recorded, and a second revoke changes nothing.
      if (decision.status === "revoked") return {};
      const revoked: RuntimeDecision = {
        ...decision,
        status: "revoked",
        revokedAt: command.revokedAt,
      };
      db.prepare(
        "UPDATE runtime_decisions SET record=? WHERE decision_ref=?",
      ).run(JSON.stringify(revoked), decision.decisionRef);
      return {};
    }
    case "runtimeProjectionRead":
      return {
        runtimeProjection: readProjection(
          db,
          command.instanceId,
          command.scopeRef,
        ),
      };
    case "runtimeOperationRead":
      return {
        runtimeOperation: readOperation(
          db,
          command.instanceId,
          command.operationId,
          command.key,
        ),
      };
    case "runtimeDecisionRead":
      return {
        runtimeDecision: readDecision(
          db,
          command.instanceId,
          command.decisionRef,
        ),
      };
    case "runtimeOperationList":
      return {
        runtimeOperationList: listOperations(
          db,
          command.instanceId,
          command.methods,
          command.open,
        ),
      };
    case "runtimeExecutionUpsert":
      applyExecutionUpsert(db, command, (operation) =>
        upsertOperation(db, operation),
      );
      return {};
    case "runtimeExecutionRead":
      return { runtimeExecution: readExecution(db, command.executionRef) };
    case "runtimeExecutionList":
      return {
        runtimeExecutionList: listExecutions(
          db,
          command.instanceId,
          command.open,
        ),
      };
    case "runtimeRoleBindingUpsert":
      applyRoleBindingUpsert(db, command.binding);
      return {};
    case "runtimeRoleBindingRead":
      return {
        runtimeRoleBinding: readRoleBinding(
          db,
          command.instanceId,
          command.scopeRef,
          command.roleIntent,
        ),
      };
  }
}

export function readProjection(
  db: DatabaseSync,
  instanceId: string,
  scopeRef: string,
): RuntimeProjection {
  const current = scopeRow(db, instanceId, scopeRef);
  if (!current) throw new StoreError("NOT_FOUND", "scope 尚未登记。");
  const rows = (table: string, order: string) =>
    (
      db
        .prepare(
          `SELECT record FROM ${table} WHERE instance_id=? AND scope_ref=? AND generation=? ORDER BY ${order}`,
        )
        .all(instanceId, scopeRef, current.generation) as { record: string }[]
    ).map((r) => JSON.parse(r.record));
  return {
    objects: rows("runtime_projection_objects", "object_ref"),
    actions: rows("runtime_projection_actions", "action_key"),
    pendingItems: rows("runtime_projection_pending", "item_ref"),
  };
}

export function runtimeSnapshot(db: DatabaseSync): RuntimeSnapshot {
  const parse = <T>(sql: string) =>
    (db.prepare(sql).all() as { record: string }[]).map(
      (row) => JSON.parse(row.record) as T,
    );
  const scopes = (
    db
      .prepare(
        "SELECT instance_id AS instanceId, scope_ref AS scopeRef, generation, record FROM runtime_scopes ORDER BY instance_id, scope_ref",
      )
      .all() as {
      instanceId: string;
      scopeRef: string;
      generation: number;
      record: string;
    }[]
  ).map((row) => {
    const scope = JSON.parse(row.record) as RuntimeScope;
    const count = (table: string, extra = "") =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM ${table} WHERE instance_id=? AND scope_ref=? AND generation=?${extra}`,
          )
          .get(row.instanceId, row.scopeRef, row.generation) as { n: number }
      ).n;
    return {
      ...scope,
      counts: {
        objects: count("runtime_projection_objects"),
        actions: count("runtime_projection_actions"),
        actionsEnabled: count(
          "runtime_projection_actions",
          " AND json_extract(record,'$.enabled')=1",
        ),
        pending: count(
          "runtime_projection_pending",
          " AND json_extract(record,'$.status')='pending'",
        ),
        blocking: count(
          "runtime_projection_pending",
          " AND json_extract(record,'$.blocking')=1",
        ),
      },
    };
  });
  const operations = db
    .prepare(
      "SELECT instance_id AS instanceId, record FROM runtime_operations ORDER BY touched DESC",
    )
    .all() as { instanceId: string; record: string }[];
  const bounded = <T>(rows: { instanceId: string; record: string }[]) => {
    const perInstance = new Map<string, number>();
    const recent: T[] = [];
    for (const row of rows) {
      const n = perInstance.get(row.instanceId) ?? 0;
      if (n >= retainedOperations) continue;
      perInstance.set(row.instanceId, n + 1);
      recent.push(JSON.parse(row.record) as T);
    }
    return recent;
  };
  const decisions = db
    .prepare(
      "SELECT instance_id AS instanceId, record FROM runtime_decisions ORDER BY rowid DESC",
    )
    .all() as { instanceId: string; record: string }[];
  return {
    runtimeInstallations: parse<RuntimeInstallation>(
      "SELECT record FROM runtime_installations ORDER BY imported_at, installation_id",
    ),
    runtimeInstances: parse<RuntimeInstance>(
      "SELECT record FROM runtime_instances ORDER BY instance_id",
    ),
    runtimeResources: parse<RuntimeResource>(
      "SELECT record FROM runtime_resources ORDER BY registered_at, handle",
    ),
    runtimeScopes: scopes,
    runtimeGrants: parse<RuntimeGrant>(
      "SELECT record FROM runtime_grants ORDER BY created_at, grant_id",
    ),
    runtimeOperations: bounded<RuntimeOperation>(operations),
    runtimeDecisions: bounded<RuntimeDecision>(decisions),
    runtimeContextSnapshots: parse<RuntimeContextSnapshot>(
      "SELECT record FROM runtime_context_snapshots ORDER BY created_at, handle",
    ),
    runtimeExecutions: executionSnapshot(db, retainedOperations),
  };
}
