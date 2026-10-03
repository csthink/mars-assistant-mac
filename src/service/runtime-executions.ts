/**
 * Physical Agent execution persistence (feature-t30). The embedded execution port in the
 * main process reports every transition as one `runtimeExecutionUpsert`; the business
 * service commits the record, the start or cancel operation that moves with it, the run
 * event and the pending item in one transaction (architecture "执行记录、待处理事项与运行
 * 事件": 同一短事务更新执行状态、创建或解决待处理事项并追加对应运行事件). The first upsert
 * creates the business `executions` row (kind agent_execution) the events and pending
 * items hang on; run events stay append-only.
 */
import { activeModelCount, assertQueueSpace } from "./widget-generation";
import { generationLimits } from "../shared/widget-generation";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { StoreError } from "./errors";
import {
  physicalStates,
  terminalPhysicalStates,
  validHostExecutionRecord,
  validRuntimeRoleBinding,
  type HostExecutionRecord,
  type PhysicalState,
  type RuntimeRoleBinding,
  modelRefOf,
} from "../shared/runtime-execution";
import type { ExecutionState, ConnectionSnapshot } from "../shared/protocol";
import type { RuntimeOperation } from "../shared/runtime-host";

export const runtimeExecutionSchema = `
CREATE TABLE runtime_executions (
  execution_ref TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES runtime_instances(instance_id),
  scope_ref TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  resource_handle TEXT NOT NULL,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(id),
  state TEXT NOT NULL,
  record TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  touched INTEGER NOT NULL
);
CREATE INDEX runtime_executions_instance ON runtime_executions(instance_id, touched);
CREATE INDEX runtime_executions_resource ON runtime_executions(resource_handle, state);
CREATE TABLE runtime_role_bindings (
  instance_id TEXT NOT NULL REFERENCES runtime_instances(instance_id),
  scope_ref TEXT NOT NULL,
  role_intent TEXT NOT NULL,
  record TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, scope_ref, role_intent)
);
`;

/**
 * Schema 23: agent executions become an execution kind and stop-unconfirmed a pending
 * item kind. Both CHECK constraints need a table rebuild; the current table definitions
 * are read from sqlite_master so every earlier column survives unchanged.
 */
export function migrateRuntimeExecutions(db: DatabaseSync) {
  const rebuild = (
    table: string,
    marker: string,
    replacement: string,
    indexes: string,
  ) => {
    const schema = String(
      (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(table) as { sql: string }
      ).sql,
    );
    if (!schema.includes(marker))
      throw new Error(table + " schema lacks " + marker);
    const temporary = table + "_v23";
    db.exec(
      schema
        .replace(
          new RegExp('CREATE TABLE ["`]?' + table + '["`]?'),
          "CREATE TABLE " + temporary,
        )
        .replace(marker, replacement),
    );
    db.exec(
      `INSERT INTO ${temporary} SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${temporary} RENAME TO ${table}; ${indexes}`,
    );
  };
  rebuild(
    "executions",
    "'conversation_action'",
    "'conversation_action','agent_execution'",
    "CREATE INDEX executions_turn ON executions(turn_id, attempt);",
  );
  rebuild(
    "pending_items",
    "'failed_turn'",
    "'failed_turn','stop_unconfirmed'",
    "",
  );
  db.exec(runtimeExecutionSchema);
}

const businessState: Record<PhysicalState, ExecutionState> = {
  queued: "queued",
  reserved: "queued",
  running: "running",
  stopping: "stopping",
  stopped: "stopped",
  completed: "completed",
  failed: "failed",
  unknown: "interrupted",
};
const isTerminal = (state: PhysicalState) =>
  terminalPhysicalStates.includes(state);

export function readExecution(
  db: DatabaseSync,
  executionRef: string,
): HostExecutionRecord | null {
  const row = db
    .prepare("SELECT record FROM runtime_executions WHERE execution_ref=?")
    .get(executionRef) as { record: string } | undefined;
  return row ? (JSON.parse(row.record) as HostExecutionRecord) : null;
}
export function listExecutions(
  db: DatabaseSync,
  instanceId: string | null,
  open: boolean,
): HostExecutionRecord[] {
  const rows = (
    instanceId
      ? db
          .prepare(
            "SELECT record FROM runtime_executions WHERE instance_id=? ORDER BY touched DESC",
          )
          .all(instanceId)
      : db
          .prepare(
            "SELECT record FROM runtime_executions ORDER BY touched DESC",
          )
          .all()
  ) as { record: string }[];
  return rows
    .map((row) => JSON.parse(row.record) as HostExecutionRecord)
    .filter((record) => !open || !isTerminal(record.state));
}
/** Every execution of one resource that is stop-unconfirmed or otherwise still holds the resource (RUNTIME-04 blocked operations). */
export function protectingExecutions(
  db: DatabaseSync,
  resourceHandle: string | null,
): HostExecutionRecord[] {
  return listExecutions(db, null, true).filter(
    (record) =>
      (resourceHandle === null || record.resourceHandle === resourceHandle) &&
      record.blockedOperations.length > 0,
  );
}
export function readRoleBinding(
  db: DatabaseSync,
  instanceId: string,
  scopeRef: string,
  roleIntent: string,
): RuntimeRoleBinding | null {
  const row = db
    .prepare(
      "SELECT record FROM runtime_role_bindings WHERE instance_id=? AND scope_ref=? AND role_intent=?",
    )
    .get(instanceId, scopeRef, roleIntent) as { record: string } | undefined;
  return row ? (JSON.parse(row.record) as RuntimeRoleBinding) : null;
}

/** The connection snapshot stored on the execution's run events, when the connection still exists. */
function connectionSnapshot(
  db: DatabaseSync,
  record: HostExecutionRecord,
): ConnectionSnapshot | null {
  if (!record.connectionId) return null;
  const row = db
    .prepare(
      "SELECT id AS connectionId,name,provider,base_url AS baseUrl,revision FROM connections WHERE id=?",
    )
    .get(record.connectionId) as
    Omit<ConnectionSnapshot, "model" | "effort"> | undefined;
  if (!row) return null;
  // The record carries the Contract ref; the snapshot names the connection's own model id behind it.
  const models = db
    .prepare(
      "SELECT model_id AS model FROM connection_models WHERE connection_id=?",
    )
    .all(record.connectionId) as { model: string }[];
  const model =
    models.find((m) => modelRefOf(m.model) === record.model)?.model ??
    record.model;
  return { ...row, model, effort: record.effort };
}

export function applyExecutionUpsert(
  db: DatabaseSync,
  command: {
    record: HostExecutionRecord;
    operation: RuntimeOperation | null;
    event: { kind: string; payload: Record<string, unknown> } | null;
    pending: "open" | "resolve" | null;
  },
  upsertOperation: (operation: RuntimeOperation) => void,
) {
  const record = command.record;
  if (!validHostExecutionRecord(record))
    throw new StoreError("INVALID_COMMAND", "执行记录无效，未写入。");
  if (
    !db
      .prepare("SELECT 1 FROM runtime_instances WHERE instance_id=?")
      .get(record.instanceId)
  )
    throw new StoreError("NOT_FOUND", "执行所属的实例不存在。");
  const existing = readExecution(db, record.executionRef);
  const occupied = ["reserved", "running", "stopping"];
  if (
    occupied.includes(record.state) &&
    (!existing || !occupied.includes(existing.state))
  ) {
    const domain = Number(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM runtime_executions WHERE state IN ('reserved','running','stopping')",
        )
        .get()!.n,
    );
    if (
      domain >= generationLimits.domain ||
      activeModelCount(db) >= generationLimits.active
    )
      throw new StoreError(
        "CONFLICT",
        "领域执行或全局模型容量已满，执行未接受。",
      );
  }
  if (!existing && record.state === "queued") assertQueueSpace(db);
  if (existing) {
    // The identity of an execution never moves: same instance, operation, business row and request identity.
    if (
      existing.instanceId !== record.instanceId ||
      existing.operationId !== record.operationId ||
      existing.executionId !== record.executionId ||
      existing.requestIdentity.requestDigest !==
        record.requestIdentity.requestDigest
    )
      throw new StoreError("CONFLICT", "执行记录的身份不能改变。");
    if (isTerminal(existing.state) && existing.state !== record.state)
      throw new StoreError("CONFLICT", "已到终态的执行不能改为其他状态。");
    if (
      !physicalStates.includes(record.state) ||
      (existing.releasedAt && !record.releasedAt)
    )
      throw new StoreError("CONFLICT", "执行状态回退，未写入。");
  } else {
    if (record.state !== "reserved" && record.state !== "queued")
      throw new StoreError(
        "CONFLICT",
        "执行记录必须从预约状态开始，不能直接写入运行或终态。",
      );
    if (
      db.prepare("SELECT 1 FROM executions WHERE id=?").get(record.executionId)
    )
      throw new StoreError("CONFLICT", "业务执行行已存在，不能复用。");
    db.prepare(
      "INSERT INTO executions (id, turn_id, kind, connection_id, attempt, state, created_at) VALUES (?,NULL,'agent_execution',?,1,?,?)",
    ).run(
      record.executionId,
      record.connectionId &&
        db
          .prepare("SELECT 1 FROM connections WHERE id=?")
          .get(record.connectionId)
        ? record.connectionId
        : null,
      businessState[record.state],
      record.createdAt,
    );
  }
  if (command.operation) {
    if (
      command.operation.instanceId !== record.instanceId ||
      (command.operation.method !== "host.execution.start" &&
        command.operation.method !== "host.execution.cancel") ||
      (command.operation.method === "host.execution.start" &&
        command.operation.operationId !== record.operationId)
    )
      throw new StoreError("CONFLICT", "操作记录与执行不属于同一请求。");
    upsertOperation(command.operation);
  }
  const touched =
    (
      db
        .prepare(
          "SELECT COALESCE(MAX(touched), 0) AS n FROM runtime_executions",
        )
        .get() as { n: number }
    ).n + 1;
  db.prepare(
    `INSERT INTO runtime_executions (execution_ref, instance_id, scope_ref, operation_id, resource_handle, execution_id, state, record, created_at, updated_at, touched) VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(execution_ref) DO UPDATE SET state=excluded.state, record=excluded.record, updated_at=excluded.updated_at, touched=excluded.touched`,
  ).run(
    record.executionRef,
    record.instanceId,
    record.scopeRef,
    record.operationId,
    record.resourceHandle,
    record.executionId,
    record.state,
    JSON.stringify(record),
    record.createdAt,
    record.updatedAt,
    touched,
  );
  const ended = isTerminal(record.state) ? record.updatedAt : null;
  db.prepare(
    "UPDATE executions SET state=?, ended_at=COALESCE(ended_at, ?), stop_requested_at=COALESCE(stop_requested_at, ?) WHERE id=?",
  ).run(
    businessState[record.state],
    ended,
    record.cancelRequestedAt,
    record.executionId,
  );
  const snapshot = connectionSnapshot(db, record);
  if (command.event) {
    db.prepare(
      "INSERT INTO run_events (id, execution_id, kind, at, snapshot, payload) VALUES (?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      record.executionId,
      command.event.kind,
      record.updatedAt,
      snapshot ? JSON.stringify(snapshot) : null,
      JSON.stringify({
        executionRef: record.executionRef,
        agent: record.agent,
        model: record.model,
        ...command.event.payload,
      }),
    );
  }
  if (command.pending === "open") {
    if (
      !db
        .prepare(
          "SELECT 1 FROM pending_items WHERE execution_id=? AND kind='stop_unconfirmed' AND state='open'",
        )
        .get(record.executionId)
    )
      db.prepare(
        "INSERT INTO pending_items (id, execution_id, kind, state, created_at) VALUES (?,?,'stop_unconfirmed','open',?)",
      ).run(randomUUID(), record.executionId, record.updatedAt);
  } else if (command.pending === "resolve") {
    db.prepare(
      "UPDATE pending_items SET state='resolved', resolved_at=? WHERE execution_id=? AND kind='stop_unconfirmed' AND state='open'",
    ).run(record.updatedAt, record.executionId);
  }
}
export function applyRoleBindingUpsert(
  db: DatabaseSync,
  binding: RuntimeRoleBinding,
) {
  if (!validRuntimeRoleBinding(binding))
    throw new StoreError("INVALID_COMMAND", "角色选择记录无效，未写入。");
  if (
    !db
      .prepare("SELECT 1 FROM runtime_instances WHERE instance_id=?")
      .get(binding.instanceId)
  )
    throw new StoreError("NOT_FOUND", "角色选择所属的实例不存在。");
  if (
    !db
      .prepare("SELECT 1 FROM connections WHERE id=?")
      .get(binding.connectionId)
  )
    throw new StoreError("NOT_FOUND", "角色选择引用的连接不存在。");
  db.prepare(
    `INSERT INTO runtime_role_bindings (instance_id, scope_ref, role_intent, record, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(instance_id, scope_ref, role_intent) DO UPDATE SET record=excluded.record, updated_at=excluded.updated_at`,
  ).run(
    binding.instanceId,
    binding.scopeRef,
    binding.roleIntent,
    JSON.stringify(binding),
    binding.updatedAt,
  );
}
/** Newest first, bounded per instance like operations. */
export function executionSnapshot(
  db: DatabaseSync,
  retained: number,
): HostExecutionRecord[] {
  const rows = db
    .prepare(
      "SELECT instance_id AS instanceId, record FROM runtime_executions ORDER BY touched DESC",
    )
    .all() as { instanceId: string; record: string }[];
  const perInstance = new Map<string, number>();
  const recent: HostExecutionRecord[] = [];
  for (const row of rows) {
    const n = perInstance.get(row.instanceId) ?? 0;
    if (n >= retained) continue;
    perInstance.set(row.instanceId, n + 1);
    recent.push(JSON.parse(row.record) as HostExecutionRecord);
  }
  return recent;
}
