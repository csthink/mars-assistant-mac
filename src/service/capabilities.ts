import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { StoreError } from "./errors";
import { assertConversationAvailable } from "./organization";
import {
  authorizationWindowMs,
  grantLifetimeMs,
  readToolName,
  toolResultLimit,
  type CapabilityCommand,
  type CapabilityHostCommand,
  type Permission,
  type PermissionBlocker,
  type ToolOperation,
  type ToolState,
} from "../shared/capabilities";
import type { ConnectionSnapshot } from "../shared/protocol";

/** No new external write handler is registered here. Journal identities survive subject deletion. */
export const capabilitySchema = `ALTER TABLE turns ADD COLUMN material_mode TEXT NOT NULL DEFAULT 'inline' CHECK(material_mode IN ('inline','tools'));
CREATE TABLE capability_permissions (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, connection_id TEXT NOT NULL,
 base_url TEXT NOT NULL, model TEXT NOT NULL, attachment_id TEXT NOT NULL, sha256 TEXT NOT NULL,
 purpose TEXT NOT NULL, execution_id TEXT, revision INTEGER NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), expires_at TEXT NOT NULL,
 conversation_title TEXT NOT NULL, connection_name TEXT NOT NULL, attachment_name TEXT NOT NULL
);
CREATE TABLE tool_operations (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id), call_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL, connection_snapshot TEXT NOT NULL, attachment_id TEXT NOT NULL,
 sha256 TEXT NOT NULL, attachment_name TEXT NOT NULL, conversation_title TEXT NOT NULL, purpose TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','approved','executing','completed','denied','cancelled','expired','failed','unknown','acknowledged')),
 revision INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, permission_id TEXT REFERENCES capability_permissions(id),
 permission_revision INTEGER, created_at TEXT NOT NULL, UNIQUE(execution_id,call_id)
);`;
const permissionColumns = `id,conversation_id AS conversationId,conversation_title AS conversationTitle,connection_id AS connectionId,connection_name AS connectionName,base_url AS baseUrl,model,attachment_id AS attachmentId,attachment_name AS attachmentName,sha256,purpose,execution_id AS executionId,revision,enabled,expires_at AS expiresAt`;
const operationColumns = `id,execution_id AS executionId,call_id AS callId,conversation_id AS conversationId,conversation_title AS conversationTitle,json_extract(connection_snapshot,'$.name') AS connectionName,json_extract(connection_snapshot,'$.baseUrl') AS baseUrl,json_extract(connection_snapshot,'$.model') AS model,attachment_id AS attachmentId,attachment_name AS attachmentName,sha256,purpose,state,revision,expires_at AS expiresAt,permission_id AS permissionId,permission_revision AS permissionRevision`;
const fail = (message: string): never => {
  throw new StoreError("CONFLICT", message);
};
function operation(db: DatabaseSync, id: string) {
  const row = db
    .prepare(`SELECT ${operationColumns} FROM tool_operations WHERE id=?`)
    .get(id) as unknown as ToolOperation | undefined;
  if (!row) return fail("读取操作不存在。");
  return row;
}
function permission(db: DatabaseSync, id: string) {
  const p = db
    .prepare(
      `SELECT ${permissionColumns} FROM capability_permissions WHERE id=?`,
    )
    .get(id) as unknown as Permission | undefined;
  if (!p) return fail("授权不存在。");
  return p;
}
function subject(db: DatabaseSync, executionId: string) {
  const row = db
    .prepare(
      `SELECT e.state,t.id AS turnId,t.conversation_id AS conversationId,t.connection_snapshot AS snapshot,t.material_mode AS mode,c.title FROM executions e JOIN turns t ON t.id=e.turn_id JOIN conversations c ON c.id=t.conversation_id WHERE e.id=? AND e.kind='turn' AND e.attempt=(SELECT MAX(attempt) FROM executions WHERE turn_id=t.id)`,
    )
    .get(executionId) as
    | {
        state: string;
        turnId: string;
        conversationId: string;
        snapshot: string;
        mode: string;
        title: string;
      }
    | undefined;
  if (
    !row ||
    !["running", "awaiting_authorization"].includes(row.state) ||
    row.mode !== "tools"
  )
    return fail("该执行未启用按需读取，已停止或已被新的尝试替代。");
  assertConversationAvailable(db, row.conversationId);
  const connection = JSON.parse(row.snapshot) as ConnectionSnapshot;
  const current = db
    .prepare("SELECT enabled,base_url,revision FROM connections WHERE id=?")
    .get(connection.connectionId);
  if (
    !current?.enabled ||
    current.base_url !== connection.baseUrl ||
    current.revision !== connection.revision
  )
    return fail("执行连接已变更，不能继续使用旧读取请求。");
  return { ...row, connection };
}
function target(db: DatabaseSync, executionId: string, attachmentId: string) {
  const s = subject(db, executionId);
  const a = db
    .prepare(
      `SELECT a.id,a.name,a.sha256,a.size,a.status,a.kind,a.chars FROM attachments a JOIN message_attachments ma ON ma.attachment_id=a.id JOIN messages m ON m.id=ma.message_id WHERE m.turn_id=? AND m.role='user' AND a.id=?`,
    )
    .get(s.turnId, attachmentId) as
    | {
        id: string;
        name: string;
        sha256: string;
        size: number;
        status: string;
        kind: string;
        chars: number;
      }
    | undefined;
  if (
    !a ||
    a.status !== "ready" ||
    !["text", "markdown", "pdf"].includes(a.kind) ||
    !/^[0-9a-f]{64}$/.test(a.sha256)
  )
    return fail("工具只能读取本回合明确选定且可读的文本资料版本。");
  if (a.chars > toolResultLimit)
    return fail(
      `资料正文超过按需读取上限${toolResultLimit}字符，请缩减资料后重新选择。`,
    );
  return { s, a };
}
function append(
  db: DatabaseSync,
  o: ToolOperation,
  state: string,
  now: string,
) {
  const snap = db
    .prepare("SELECT connection_snapshot FROM tool_operations WHERE id=?")
    .get(o.id)!.connection_snapshot;
  db.prepare(
    "INSERT INTO run_events(id,execution_id,kind,at,snapshot,payload) VALUES(?,?,'capability_changed',?,?,?)",
  ).run(
    randomUUID(),
    o.executionId,
    now,
    String(snap),
    JSON.stringify({
      operationId: o.id,
      attachmentName: o.attachmentName,
      state,
    }),
  );
}
function update(
  db: DatabaseSync,
  o: ToolOperation,
  state: ToolState,
  now: string,
) {
  db.prepare(
    "UPDATE tool_operations SET state=?,revision=revision+1 WHERE id=?",
  ).run(state, o.id);
  append(db, o, state, now);
}
function permissionBlocker(
  db: DatabaseSync,
  p: Permission,
): PermissionBlocker | null {
  if (
    p.executionId &&
    !["running", "awaiting_authorization"].includes(
      String(
        db.prepare("SELECT state FROM executions WHERE id=?").get(p.executionId)
          ?.state,
      ),
    )
  )
    return "execution_ended";
  const conv = db
    .prepare("SELECT deleted_at,purged_at FROM conversations WHERE id=?")
    .get(p.conversationId);
  if (!conv || conv.deleted_at || conv.purged_at) return "conversation_deleted";
  const c = db
    .prepare("SELECT base_url,enabled FROM connections WHERE id=?")
    .get(p.connectionId);
  if (!c?.enabled) return "connection_unavailable";
  if (c.base_url !== p.baseUrl) return "destination_changed";
  if (
    !db
      .prepare(
        "SELECT 1 FROM connection_models WHERE connection_id=? AND model_id=? AND enabled=1",
      )
      .get(p.connectionId, p.model)
  )
    return "model_unavailable";
  const a = db
    .prepare("SELECT sha256,status FROM attachments WHERE id=?")
    .get(p.attachmentId);
  if (a?.sha256 !== p.sha256 || a?.status !== "ready")
    return "material_unavailable";
  return null;
}
function validPermission(db: DatabaseSync, p: Permission, now: string) {
  return (
    !!p.enabled &&
    Date.parse(p.expiresAt) > Date.parse(now) &&
    permissionBlocker(db, p) === null
  );
}
function checkPermission(db: DatabaseSync, o: ToolOperation, now: string) {
  const { s, a } = target(db, o.executionId, o.attachmentId);
  if (a.sha256 !== o.sha256 || !o.permissionId)
    return fail("资料版本或授权已失效。");
  const p = permission(db, o.permissionId);
  if (
    !validPermission(db, p, now) ||
    p.revision !== o.permissionRevision ||
    p.conversationId !== s.conversationId ||
    p.connectionId !== s.connection.connectionId ||
    p.baseUrl !== s.connection.baseUrl ||
    p.model !== s.connection.model ||
    p.attachmentId !== a.id ||
    p.sha256 !== a.sha256 ||
    (p.executionId !== null && p.executionId !== o.executionId)
  )
    return fail("授权已撤销、过期或不覆盖当前读取；正文未返回。");
  return { s, a };
}
export function capabilitySnapshot(
  db: DatabaseSync,
  now = new Date().toISOString(),
) {
  const permissions = (
    db
      .prepare(
        `SELECT ${permissionColumns} FROM capability_permissions ORDER BY rowid DESC`,
      )
      .all() as unknown as Permission[]
  ).map((p) => ({
    ...p,
    enabled: Boolean(p.enabled),
    valid: validPermission(db, p, now),
    blocker: permissionBlocker(db, p),
  }));
  const toolOperations = db
    .prepare(
      `SELECT ${operationColumns} FROM tool_operations ORDER BY rowid DESC LIMIT 200`,
    )
    .all() as unknown as ToolOperation[];
  return { permissions, toolOperations };
}
function restoreRunning(db: DatabaseSync, executionId: string) {
  if (
    !db
      .prepare(
        "SELECT 1 FROM tool_operations WHERE execution_id=? AND state='pending'",
      )
      .get(executionId)
  ) {
    db.prepare(
      "UPDATE executions SET state='running' WHERE id=? AND state='awaiting_authorization'",
    ).run(executionId);
    db.prepare(
      "UPDATE turns SET state='running' WHERE id=(SELECT turn_id FROM executions WHERE id=?) AND state='awaiting_authorization'",
    ).run(executionId);
  }
}
/** Called only after the Store has authenticated the host channel, inside its transaction. */
export function applyCapabilityHost(
  db: DatabaseSync,
  root: string,
  c: CapabilityHostCommand,
  now: string,
): { toolOperationId?: string; toolText?: string } {
  if (c.type === "requestTool") {
    if (c.tool !== readToolName) return fail("未知工具未执行。");
    let args: unknown;
    try {
      args = JSON.parse(c.arguments);
    } catch {
      return fail("工具参数不是完整JSON，未执行。");
    }
    if (
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      Object.keys(args).join(",") !== "attachmentId" ||
      typeof (args as { attachmentId?: unknown }).attachmentId !== "string"
    )
      return fail("读取只接受attachmentId，不接受路径、主体或额外参数。");
    const attachmentId = (args as { attachmentId: string }).attachmentId;
    const { s, a } = target(db, c.executionId, attachmentId);
    const prior = db
      .prepare(
        "SELECT id,attachment_id FROM tool_operations WHERE execution_id=? AND call_id=?",
      )
      .get(c.executionId, c.callId);
    if (prior) {
      if (prior.attachment_id !== attachmentId)
        return fail("工具调用身份已用于其他参数，未执行。");
      return { toolOperationId: String(prior.id) };
    }
    const count = db
      .prepare("SELECT count(*) AS n FROM tool_operations WHERE execution_id=?")
      .get(c.executionId)!.n;
    if (Number(count) >= 20) return fail("本回合读取次数已达上限。");
    const id = randomUUID();
    db.prepare(
      `INSERT INTO tool_operations(id,execution_id,call_id,conversation_id,connection_snapshot,attachment_id,sha256,attachment_name,conversation_title,purpose,state,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
    ).run(
      id,
      c.executionId,
      c.callId,
      s.conversationId,
      s.snapshot,
      a.id,
      a.sha256,
      a.name,
      s.title,
      "读取本回合选定资料，供当前模型回答问题",
      new Date(Date.parse(now) + authorizationWindowMs).toISOString(),
      now,
    );
    const p = (
      db
        .prepare(
          `SELECT ${permissionColumns} FROM capability_permissions WHERE conversation_id=? AND connection_id=? AND base_url=? AND model=? AND attachment_id=? AND sha256=? AND (execution_id IS NULL OR execution_id=?) ORDER BY rowid DESC`,
        )
        .all(
          s.conversationId,
          s.connection.connectionId,
          s.connection.baseUrl,
          s.connection.model,
          a.id,
          a.sha256,
          c.executionId,
        ) as unknown as Permission[]
    ).find((p) => validPermission(db, p, now));
    if (p)
      db.prepare(
        "UPDATE tool_operations SET state='approved',permission_id=?,permission_revision=? WHERE id=?",
      ).run(p.id, p.revision, id);
    else {
      db.prepare(
        "UPDATE executions SET state='awaiting_authorization' WHERE id=?",
      ).run(c.executionId);
      db.prepare(
        "UPDATE turns SET state='awaiting_authorization' WHERE id=?",
      ).run(s.turnId);
    }
    append(db, operation(db, id), p ? "approved" : "pending", now);
    return { toolOperationId: id };
  }
  const o = operation(db, c.id);
  if (o.executionId !== c.executionId) return fail("操作不属于当前执行主体。");
  if (c.type === "failTool") {
    if (["pending", "approved", "executing"].includes(o.state)) {
      update(db, o, "failed", now);
      restoreRunning(db, o.executionId);
    }
    return {};
  }
  const { a } = checkPermission(db, o, now);
  if (c.type === "beginTool") {
    if (o.state !== "approved")
      return fail("读取未获批准或已经执行，不能重放。");
    update(db, o, "executing", now);
    return {};
  }
  if (o.state !== "executing")
    return fail("读取不处于待确认执行状态，不能重复获取正文。");
  // Open the immutable copy without following symlinks; verify the opened object, never a path prefix.
  const fd = openSync(
    join(root, "attachments", a.sha256),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size !== a.size || st.size > 20 * 1024 * 1024)
      return fail("资料副本身份或大小不一致，正文未返回。");
    const bytes = readFileSync(fd);
    if (createHash("sha256").update(bytes).digest("hex") !== a.sha256)
      return fail("资料副本摘要不一致，正文未返回。");
  } finally {
    closeSync(fd);
  }
  const t = db
    .prepare("SELECT text FROM attachment_texts WHERE attachment_id=?")
    .get(a.id);
  if (
    typeof t?.text !== "string" ||
    t.text.length > toolResultLimit ||
    t.text.length !== a.chars
  )
    return fail("资料正文缺失或超限，未返回。");
  update(db, o, "completed", now);
  return { toolText: t.text };
}
export function applyCapabilityCommand(
  db: DatabaseSync,
  c: CapabilityCommand,
  now: string,
) {
  if (c.type === "setPermission") {
    const p = permission(db, c.id);
    if (p.revision !== c.revision)
      return fail("授权已被另一操作更改，请重新核对。");
    if (
      Date.parse(c.confirmUntil) <= Date.parse(now) ||
      Date.parse(c.confirmUntil) > Date.parse(now) + authorizationWindowMs
    )
      return fail("权限确认已过期，请重新打开确认。");
    if (c.enabled) {
      if (
        !validPermission(
          db,
          { ...p, enabled: true, expiresAt: c.expiresAt },
          now,
        ) ||
        p.executionId !== null ||
        Date.parse(c.expiresAt) > Date.parse(now) + grantLifetimeMs
      )
        return fail("主体、对象或授权期限无效，不能重新开启。");
    }
    db.prepare(
      "UPDATE capability_permissions SET enabled=?,expires_at=?,revision=revision+1 WHERE id=?",
    ).run(Number(c.enabled), c.enabled ? c.expiresAt : p.expiresAt, p.id);
    const ops = db
      .prepare(
        `SELECT ${operationColumns} FROM tool_operations WHERE permission_id=? AND state IN ('pending','approved','executing')`,
      )
      .all(p.id) as unknown as ToolOperation[];
    for (const o of ops) {
      update(db, o, "cancelled", now);
      restoreRunning(db, o.executionId);
    }
    const last = db
      .prepare(
        "SELECT id FROM tool_operations WHERE permission_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(p.id);
    if (last)
      append(
        db,
        operation(db, String(last.id)),
        c.enabled ? "permission_enabled" : "permission_revoked",
        now,
      );
    return;
  }
  const o = operation(db, c.id);
  if (o.revision !== c.revision)
    return fail("读取请求已变化，请重新核对当前状态。");
  if (c.type === "acknowledgeToolResult") {
    if (o.state !== "unknown") return fail("该操作不需要结果核对。");
    update(db, o, "acknowledged", now);
    return;
  }
  if (o.state !== "pending" || Date.parse(o.expiresAt) <= Date.parse(now))
    return fail("请求已经结束或确认已过期，不能授权旧操作。");
  const { s, a } = target(db, o.executionId, o.attachmentId);
  if (a.sha256 !== o.sha256) return fail("目标版本已经改变。");
  if (c.action === "deny" || c.action === "cancel")
    update(db, o, c.action === "deny" ? "denied" : "cancelled", now);
  else {
    const until = Date.parse(c.expiresAt);
    if (
      until <= Date.parse(now) ||
      until >
        Date.parse(now) +
          (c.action === "once" ? authorizationWindowMs : grantLifetimeMs)
    )
      return fail("授权期限无效，请重新核对。");
    const id = randomUUID();
    db.prepare(
      `INSERT INTO capability_permissions(id,conversation_id,connection_id,base_url,model,attachment_id,sha256,purpose,execution_id,enabled,expires_at,conversation_title,connection_name,attachment_name) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
    ).run(
      id,
      s.conversationId,
      s.connection.connectionId,
      s.connection.baseUrl,
      s.connection.model,
      a.id,
      a.sha256,
      o.purpose,
      c.action === "once" ? o.executionId : null,
      c.expiresAt,
      s.title,
      s.connection.name,
      a.name,
    );
    db.prepare(
      "UPDATE tool_operations SET permission_id=?,permission_revision=0 WHERE id=?",
    ).run(id, o.id);
    update(db, o, "approved", now);
  }
  restoreRunning(db, o.executionId);
}
/** Recovery is a state settlement, never a dispatcher. A started operation with no result stays unknown. */
export function settleCapabilities(db: DatabaseSync, now: string) {
  const ops = db
    .prepare(
      `SELECT ${operationColumns} FROM tool_operations WHERE state IN ('pending','approved','executing') OR (state='completed' AND execution_id IN (SELECT id FROM executions WHERE state IN ('running','awaiting_authorization')))`,
    )
    .all() as unknown as ToolOperation[];
  let count = 0;
  for (const o of ops) {
    const state = db
      .prepare("SELECT state FROM executions WHERE id=?")
      .get(o.executionId)?.state;
    const stopped = !["running", "awaiting_authorization"].includes(
      String(state),
    );
    // Keep a confirmed read completed, but publish expired scope while its provider continuation is still active.
    if (o.state === "completed") {
      try {
        checkPermission(db, o, now);
      } catch {
        count++;
      }
      continue;
    }
    let next: ToolState | undefined;
    if (stopped) next = o.state === "executing" ? "unknown" : "cancelled";
    else if (
      o.state === "pending" &&
      Date.parse(o.expiresAt) <= Date.parse(now)
    )
      next = "expired";
    else if (o.permissionId) {
      try {
        checkPermission(db, o, now);
      } catch {
        next = "cancelled";
      }
    }
    if (next) {
      update(db, o, next, now);
      restoreRunning(db, o.executionId);
      count++;
    }
  }
  return count;
}
