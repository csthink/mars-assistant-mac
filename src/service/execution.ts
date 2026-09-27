import { validateProjectTurn } from "./project-work";
import type { RuntimeHostCommand } from "../shared/runtime-host";
import type { WidgetHostCommand } from "../shared/widget-store";
import { requireClaudeEnabled } from "./claude-settings";
import { requireCodexEnabled } from "./codex-settings";
import type { CapabilityHostCommand } from "../shared/capabilities";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  stateLabels,
  terminalStates,
  type Command,
  type ConnectionCheck,
  type ConnectionSnapshot,
  type EffortRecord,
  type EventKind,
  type ExecutionState,
  type HostCommand,
  type ImageInput,
  type Message,
  type PendingItem,
  type RunEvent,
  type Snapshot,
  type Turn,
  type TurnAttachment,
} from "../shared/protocol";
import { selectedModel } from "./models";
import { StoreError } from "./errors";
import {
  attachDraftToMessage,
  checkSubmission,
  turnAttachments,
} from "./attachments";

/**
 * Schema version 4: turns, executions, pending items and append-only run events.
 * Current state lives in executions/turns; run_events only ever grows.
 */
export const executionSchema = `CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  turn_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_conversation ON messages(conversation_id, created_at);
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  request_id TEXT NOT NULL UNIQUE,
  connection_snapshot TEXT NOT NULL,
  state TEXT NOT NULL,
  partial_text TEXT NOT NULL DEFAULT '',
  error_class TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  turn_id TEXT REFERENCES turns(id),
  kind TEXT NOT NULL CHECK(kind IN ('turn','connection_test','model_list')),
  connection_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  stop_requested_at TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX executions_turn ON executions(turn_id, attempt);
CREATE TABLE pending_items (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  kind TEXT NOT NULL CHECK(kind IN ('interrupted_turn','failed_turn')),
  state TEXT NOT NULL CHECK(state IN ('open','resolved')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  snapshot TEXT,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER run_events_no_update BEFORE UPDATE ON run_events
  BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events
  BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;`;
/** Schema version 5: host executions record their own failure classification. */
export const executionErrorSchema = `ALTER TABLE executions ADD COLUMN error_class TEXT;
ALTER TABLE executions ADD COLUMN error_message TEXT;`;
/** Schema version 6: each attempt keeps its own delivered text so a retry starts clean. */
export const executionPartialSchema = `ALTER TABLE executions ADD COLUMN partial_text TEXT NOT NULL DEFAULT '';`;
/** Schema version 9: the executions table is rebuilt so its kind CHECK admits the image probe. */
export const executionRebuildSchema = `CREATE TABLE executions_v9 (
  id TEXT PRIMARY KEY,
  turn_id TEXT REFERENCES turns(id),
  kind TEXT NOT NULL CHECK(kind IN ('turn','connection_test','model_list','image_probe')),
  connection_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  stop_requested_at TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  error_class TEXT,
  error_message TEXT,
  partial_text TEXT NOT NULL DEFAULT ''
);
INSERT INTO executions_v9 (id, turn_id, kind, connection_id, attempt, state, last_seq, stop_requested_at, created_at, ended_at, error_class, error_message, partial_text)
  SELECT id, turn_id, kind, connection_id, attempt, state, last_seq, stop_requested_at, created_at, ended_at, error_class, error_message, partial_text FROM executions;
DROP TABLE executions;
ALTER TABLE executions_v9 RENAME TO executions;
CREATE INDEX executions_turn ON executions(turn_id, attempt);`;

interface ExecutionRow {
  id: string;
  turnId: string | null;
  kind:
    | "turn"
    | "connection_test"
    | "model_list"
    | "image_probe"
    | "agent_execution";
  connectionId: string | null;
  attempt: number;
  state: ExecutionState;
  lastSeq: number;
  connectionSnapshot: string | null;
}
const executionColumns =
  "e.id, e.turn_id AS turnId, e.kind, e.connection_id AS connectionId, e.attempt, e.state, e.last_seq AS lastSeq, COALESCE(t.connection_snapshot,(SELECT snapshot FROM run_events WHERE execution_id=e.id AND kind='submitted' ORDER BY seq LIMIT 1)) AS connectionSnapshot";

export type Origin = "renderer" | "host";
export type TurnCommand = Extract<
  Command,
  { type: "submitTurn" | "stopExecution" | "resolvePending" }
>;

function terminal(state: ExecutionState) {
  return terminalStates.includes(state);
}
function execution(db: DatabaseSync, id: string): ExecutionRow | undefined {
  return db
    .prepare(
      `SELECT ${executionColumns} FROM executions e LEFT JOIN turns t ON t.id = e.turn_id WHERE e.id=?`,
    )
    .get(id) as ExecutionRow | undefined;
}
function appendEvent(
  db: DatabaseSync,
  row: ExecutionRow,
  kind: EventKind,
  at: string,
  payload: Record<string, unknown> = {},
) {
  db.prepare(
    "INSERT INTO run_events (id, execution_id, kind, at, snapshot, payload) VALUES (?,?,?,?,?,?)",
  ).run(
    randomUUID(),
    row.id,
    kind,
    at,
    row.connectionSnapshot,
    JSON.stringify(payload),
  );
}
function setState(
  db: DatabaseSync,
  row: ExecutionRow,
  state: ExecutionState,
  at: string,
  extra: { errorClass?: string; errorMessage?: string } = {},
) {
  const ended = terminal(state) ? at : null;
  db.prepare(
    "UPDATE executions SET state=?, ended_at=?, error_class=COALESCE(?, error_class), error_message=COALESCE(?, error_message) WHERE id=?",
  ).run(
    state,
    ended,
    extra.errorClass ?? null,
    extra.errorMessage ?? null,
    row.id,
  );
  if (row.turnId)
    db.prepare(
      "UPDATE turns SET state=?, ended_at=?, error_class=COALESCE(?, error_class), error_message=COALESCE(?, error_message) WHERE id=?",
    ).run(
      state,
      ended,
      extra.errorClass ?? null,
      extra.errorMessage ?? null,
      row.turnId,
    );
}
function openPending(
  db: DatabaseSync,
  row: ExecutionRow,
  kind: PendingItem["kind"],
  at: string,
) {
  if (row.kind !== "turn") return;
  const open = db
    .prepare(
      "SELECT 1 FROM pending_items WHERE execution_id=? AND state='open'",
    )
    .get(row.id);
  if (open) return;
  db.prepare(
    "INSERT INTO pending_items (id, execution_id, kind, state, created_at) VALUES (?,?,?,'open',?)",
  ).run(randomUUID(), row.id, kind, at);
}

export function mutateTurn(
  db: DatabaseSync,
  root: string,
  command: TurnCommand,
  now: string,
) {
  if (command.type === "submitTurn") {
    const existing = db
      .prepare("SELECT id FROM turns WHERE request_id=?")
      .get(command.requestId);
    // A retried submission after a lost acknowledgement confirms the recorded turn.
    if (existing) return;
    const conversation = db
      .prepare("SELECT id,effort FROM conversations WHERE id=?")
      .get(command.conversationId);
    if (!conversation)
      throw new StoreError("NOT_FOUND", "原对话不存在，请重新选择对话。");
    const connection = selectedModel(
      db,
      command.connectionId,
      command.model,
    ) as ConnectionSnapshot & {
      imageInput: ImageInput;
      contextChars: number | null;
      effort: EffortRecord | null;
    };
    const last = db
      .prepare(
        "SELECT connection_snapshot FROM turns WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(command.conversationId);
    if (last) {
      const prior = JSON.parse(
        String(last.connection_snapshot),
      ) as ConnectionSnapshot;
      const destination = `${connection.connectionId}|${connection.baseUrl}`;
      if (`${prior.connectionId}|${prior.baseUrl}` !== destination) {
        const scopes = JSON.parse(
          String(
            db
              .prepare(
                "SELECT granted_connections FROM conversations WHERE id=?",
              )
              .get(command.conversationId)!.granted_connections,
          ),
        ) as string[];
        if (!scopes.includes(destination))
          throw new StoreError(
            "CONFLICT",
            "发送到另一提供方前需要确认历史与资料范围，消息未发送。",
          );
      }
    }
    const { imageInput, contextChars, effort, ...fixed } = connection;
    // The level fixed here is exactly what the session will receive: the conversation's choice,
    // else the recorded default, else nothing. A choice outside the current record is refused
    // rather than silently replaced.
    const chosen =
      typeof conversation.effort === "string" ? conversation.effort : null;
    if (chosen !== null && !effort?.levels.includes(chosen))
      throw new StoreError(
        "CONFLICT",
        "对话所选的推理强度档位已不在当前模型的记录内，请重新选择档位后再发送。",
      );
    const snapshot = {
      ...fixed,
      effort: chosen ?? effort?.defaultLevel ?? null,
    };
    if (command.materialMode === "tools") {
      const selected = db
        .prepare(
          "SELECT a.kind,a.chars FROM draft_attachments d JOIN attachments a ON a.id=d.attachment_id WHERE d.conversation_id=?",
        )
        .all(command.conversationId);
      if (
        !selected.length ||
        selected.some(
          (a) =>
            !["text", "markdown", "pdf"].includes(String(a.kind)) ||
            Number(a.chars) > 64_000,
        )
      )
        throw new StoreError(
          "CONFLICT",
          "按需读取需要选定文本、Markdown或文本PDF，每份正文不超过64000字符；图片请使用随消息发送。",
        );
    }
    // Material limits, readiness, image capability and the context budget are re-checked here, in the transaction.
    const material = checkSubmission(db, root, command.conversationId, {
      imageInput,
      contextChars,
      name: snapshot.name,
      textLength: command.text.length,
    });
    // Turns within one conversation are serial; the previous one must reach a terminal state first.
    const open = db
      .prepare(
        "SELECT id FROM turns WHERE conversation_id=? AND state NOT IN ('completed','stopped','failed','interrupted')",
      )
      .get(command.conversationId);
    if (open)
      throw new StoreError(
        "CONFLICT",
        "当前对话还有回合在执行。请等待它结束或先停止，输入已保留。",
      );
    const turnId = randomUUID(),
      executionId = randomUUID(),
      messageId = randomUUID();
    db.prepare(
      "INSERT INTO messages (id, conversation_id, turn_id, role, content, created_at) VALUES (?,?,?,'user',?,?)",
    ).run(messageId, command.conversationId, turnId, command.text, now);
    // The draft's selected material becomes this message's fixed version in the same transaction.
    const attachmentIds = attachDraftToMessage(
      db,
      command.conversationId,
      messageId,
    );
    db.prepare(
      "INSERT INTO turns (id, conversation_id, request_id, connection_snapshot, state, omitted_images, created_at, material_mode) VALUES (?,?,?,?,'queued',?,?,?)",
    ).run(
      turnId,
      command.conversationId,
      command.requestId,
      JSON.stringify(snapshot),
      material.omittedImages,
      now,
      command.materialMode ?? "inline",
    );
    db.prepare(
      "INSERT INTO executions (id, turn_id, kind, connection_id, attempt, state, created_at) VALUES (?,?,'turn',?,1,'queued',?)",
    ).run(executionId, turnId, snapshot.connectionId, now);
    // The submitted text leaves the draft only inside this same committed transaction.
    db.prepare(
      "UPDATE conversations SET draft='', revision=revision+1, updated_at=? WHERE id=?",
    ).run(now, command.conversationId);
    appendEvent(db, execution(db, executionId)!, "submitted", now, {
      conversationId: command.conversationId,
      turnId,
      attachments: attachmentIds.length,
      omittedImages: material.omittedImages,
    });
    return;
  }
  if (command.type === "stopExecution") {
    const row = execution(db, command.executionId);
    if (!row) throw new StoreError("NOT_FOUND", "该执行不存在。");
    // Idempotent: a repeated stop returns the recorded conclusion without a second event.
    if (terminal(row.state) || row.state === "stopping") return;
    db.prepare("UPDATE executions SET stop_requested_at=? WHERE id=?").run(
      now,
      row.id,
    );
    setState(db, row, "stopping", now);
    appendEvent(db, row, "stop_requested", now, { from: row.state });
    return;
  }
  const pending = db
    .prepare(
      "SELECT id, execution_id AS executionId, kind, state FROM pending_items WHERE id=?",
    )
    .get(command.id) as
    | { id: string; executionId: string; kind: string; state: string }
    | undefined;
  if (!pending) throw new StoreError("NOT_FOUND", "该待处理事项不存在。");
  // A Host execution fact is not a decision (RUNTIME-04, LOG-02): neither retry nor dismiss resolves
  // it; the Host resolves it itself once it has observed the escaped processes gone.
  if (pending.kind === "stop_unconfirmed")
    throw new StoreError(
      "CONFLICT",
      "停止未确认不是需要决定的事项：目标进程退出后自动解除，可用“重新检查”提前观察一次。",
    );
  // Idempotent: a repeated click after the item is resolved returns the recorded outcome.
  if (pending.state === "resolved") return;
  const previous = execution(db, pending.executionId)!;
  if (command.action === "retry") {
    if (
      db
        .prepare(
          "SELECT 1 FROM tool_operations WHERE execution_id=? AND state='unknown'",
        )
        .get(previous.id)
    )
      throw new StoreError(
        "CONFLICT",
        "原执行包含结果不明的读取，请先在待处理中核对结果；不会直接重放旧操作。",
      );
    if (!previous.turnId || !terminal(previous.state))
      throw new StoreError("CONFLICT", "该回合尚未结束，不能重试。");
    const turn = db
      .prepare("SELECT conversation_id AS conversationId FROM turns WHERE id=?")
      .get(previous.turnId) as { conversationId: string };
    const open = db
      .prepare(
        "SELECT id FROM turns WHERE conversation_id=? AND state NOT IN ('completed','stopped','failed','interrupted')",
      )
      .get(turn.conversationId);
    if (open)
      throw new StoreError(
        "CONFLICT",
        "该对话还有回合在执行，请等待它结束后再重试。",
      );
    if (!previous.connectionSnapshot)
      throw new StoreError("CONFLICT", "原回合连接快照缺失，不能重试。");
    const prior = JSON.parse(previous.connectionSnapshot) as ConnectionSnapshot;
    const live = selectedModel(db, prior.connectionId, prior.model);
    if (live.baseUrl !== prior.baseUrl)
      throw new StoreError(
        "CONFLICT",
        "原回合提供方地址已变更。请核对发送范围后重新提问。",
      );
    const attempt = (
      db
        .prepare(
          "SELECT MAX(attempt) AS attempt FROM executions WHERE turn_id=?",
        )
        .get(previous.turnId) as { attempt: number }
    ).attempt;
    const executionId = randomUUID();
    db.prepare(
      "INSERT INTO executions (id, turn_id, kind, connection_id, attempt, state, created_at) VALUES (?,?,'turn',?,?,'queued',?)",
    ).run(
      executionId,
      previous.turnId,
      previous.connectionId,
      attempt + 1,
      now,
    );
    // The turn shows the new attempt; the earlier attempt's text and events stay untouched.
    db.prepare(
      "UPDATE turns SET state='queued', partial_text='', error_class=NULL, error_message=NULL, ended_at=NULL WHERE id=?",
    ).run(previous.turnId);
    appendEvent(db, execution(db, executionId)!, "retried", now, {
      attempt: attempt + 1,
      retryOf: previous.id,
      pendingId: pending.id,
    });
  }
  db.prepare(
    "UPDATE pending_items SET state='resolved', resolved_at=? WHERE id=?",
  ).run(now, pending.id);
  appendEvent(db, previous, "pending_resolved", now, {
    pendingId: pending.id,
    action: command.action,
  });
}

/** Adapter reports are deduplicated by (execution, seq); results after a terminal state only leave a trace. */
export function applyHostCommand(
  db: DatabaseSync,
  command: Exclude<
    HostCommand,
    | CapabilityHostCommand
    | WidgetHostCommand
    | RuntimeHostCommand
    | { type: "projectCreate" | "projectWork" }
    | { type: "importAttachment" }
    | { type: "reportExtraction" }
    | { type: "exportConversation" }
    | { type: "configureCodex" }
    | { type: "configureClaude" }
    | { type: "recordEffort" }
  >,
  now: string,
) {
  if (command.type === "createExecution") {
    if (execution(db, command.executionId)) return;
    const rowConnection = db
      .prepare(
        "SELECT id AS connectionId,name,provider,base_url AS baseUrl,model,revision FROM connections WHERE id=?",
      )
      .get(command.connectionId) as ConnectionSnapshot | undefined;
    if (!rowConnection)
      throw new StoreError("NOT_FOUND", "所选连接不存在，未开始测试。");
    if (rowConnection.provider === "claude") requireClaudeEnabled(db);
    if (rowConnection.provider === "codex") requireCodexEnabled(db);
    const selected =
      command.kind === "model_list"
        ? null
        : selectedModel(db, command.connectionId, command.model, false);
    const connection = selected ?? rowConnection;
    const { connectionId, name, provider, baseUrl, model, revision } =
      connection;
    if (
      db
        .prepare(
          `SELECT 1 FROM executions e JOIN run_events r ON r.execution_id=e.id AND r.kind='submitted' WHERE e.connection_id=? AND e.kind=? AND json_extract(r.snapshot,'$.model')=? AND e.state NOT IN ('completed','stopped','failed','interrupted')`,
        )
        .get(connectionId, command.kind, model)
    )
      throw new StoreError(
        "CONFLICT",
        "该模型的检查正在执行，请等待结束或先取消。",
      );
    db.prepare(
      "INSERT INTO executions (id, turn_id, kind, connection_id, attempt, state, created_at) VALUES (?,NULL,?,?,1,'queued',?)",
    ).run(command.executionId, command.kind, command.connectionId, now);
    const row = execution(db, command.executionId)!;
    // Checks have no conversation choice: they run at the recorded default, or without a level.
    row.connectionSnapshot = JSON.stringify({
      connectionId,
      name,
      provider,
      baseUrl,
      model,
      revision,
      effort: selected?.effort?.defaultLevel ?? null,
      ...(connection.claude ? { claude: connection.claude } : {}),
      ...(connection.codex ? { codex: connection.codex } : {}),
    });
    appendEvent(db, row, "submitted", now, { kind: command.kind });
    return;
  }
  const row = execution(db, command.executionId);
  if (!row) throw new StoreError("NOT_FOUND", "该执行不存在。");
  if (command.type === "recordClaudeRun") {
    if (
      !["turn", "connection_test", "image_probe"].includes(row.kind) ||
      terminal(row.state) ||
      !row.connectionSnapshot
    )
      throw new StoreError("CONFLICT", "回合已结束，Claude 身份未修改。");
    const connection = JSON.parse(row.connectionSnapshot) as ConnectionSnapshot;
    if (
      connection.provider !== "claude" ||
      connection.model !== command.run.model ||
      connection.claude?.fingerprint !== command.run.fingerprint
    )
      throw new StoreError("CONFLICT", "Claude 来源与回合快照不一致。");
    const previous = db
      .prepare("SELECT run_json FROM claude_runs WHERE execution_id=?")
      .get(row.id);
    if (previous) {
      const old = JSON.parse(String(previous.run_json));
      if (
        old.threadId !== command.run.threadId ||
        old.cwd !== command.run.cwd ||
        (old.turnId && old.turnId !== command.run.turnId)
      )
        throw new StoreError(
          "CONFLICT",
          "不能替换已经登记的 Claude 回合身份。",
        );
    }
    db.prepare(
      "INSERT INTO claude_runs(execution_id,run_json) VALUES (?,?) ON CONFLICT(execution_id) DO UPDATE SET run_json=excluded.run_json",
    ).run(row.id, JSON.stringify(command.run));
    appendEvent(db, row, "native_session", now, { claude: command.run });
    return;
  }
  if (command.type === "recordCodexRun") {
    if (
      !["turn", "connection_test", "image_probe"].includes(row.kind) ||
      terminal(row.state) ||
      !row.connectionSnapshot
    )
      throw new StoreError("CONFLICT", "回合已结束，Codex 身份未修改。");
    const connection = JSON.parse(row.connectionSnapshot) as ConnectionSnapshot;
    if (
      connection.provider !== "codex" ||
      connection.model !== command.run.model ||
      connection.codex?.fingerprint !== command.run.fingerprint
    )
      throw new StoreError("CONFLICT", "Codex 来源与回合快照不一致。");
    const previous = db
      .prepare("SELECT run_json FROM codex_runs WHERE execution_id=?")
      .get(row.id);
    if (previous) {
      const old = JSON.parse(String(previous.run_json));
      if (
        old.threadId !== command.run.threadId ||
        old.cwd !== command.run.cwd ||
        (old.turnId && old.turnId !== command.run.turnId)
      )
        throw new StoreError("CONFLICT", "不能替换已经登记的 Codex 回合身份。");
    }
    db.prepare(
      "INSERT INTO codex_runs(execution_id,run_json) VALUES (?,?) ON CONFLICT(execution_id) DO UPDATE SET run_json=excluded.run_json",
    ).run(row.id, JSON.stringify(command.run));
    appendEvent(db, row, "native_session", now, { codex: command.run });
    return;
  }
  // Context loading is answered by the store before reaching mutation.
  if (command.type === "loadTurnContext") return;
  if (command.type === "reportInterrupted") {
    if (terminal(row.state)) return;
    setState(db, row, "interrupted", now);
    appendEvent(db, row, "interrupted", now, { from: row.state, by: "host" });
    openPending(db, row, "interrupted_turn", now);
    return;
  }
  if (command.type === "reportStopTimeout") {
    // The request did not confirm its abort in time; the state stays "stopping" for recovery to settle.
    if (row.state === "stopping") appendEvent(db, row, "stop_timeout", now, {});
    return;
  }
  if (command.type === "reportImageUnsupported") {
    // The provider itself refused image content: that is this connection's measured capability.
    if (row.connectionId && !terminal(row.state))
      markImageInput(db, row, "unsupported", now);
    return;
  }
  if (command.type === "beginExecution") {
    if (row.turnId) validateProjectTurn(db, row.turnId);
    if (row.state === "queued") {
      setState(db, row, "running", now);
      appendEvent(db, row, "started", now);
    } else if (terminal(row.state))
      appendEvent(db, row, "late_result", now, { report: "beginExecution" });
    return;
  }
  if (command.seq <= row.lastSeq) return;
  db.prepare("UPDATE executions SET last_seq=? WHERE id=?").run(
    command.seq,
    row.id,
  );
  if (terminal(row.state)) {
    appendEvent(db, row, "late_result", now, {
      report: command.type,
      seq: command.seq,
    });
    return;
  }
  if (command.type === "reportDelta") {
    db.prepare(
      "UPDATE executions SET partial_text = partial_text || ? WHERE id=?",
    ).run(command.text, row.id);
    if (row.turnId)
      db.prepare(
        "UPDATE turns SET partial_text = partial_text || ? WHERE id=?",
      ).run(command.text, row.turnId);
    if (row.state === "queued") {
      setState(db, row, "running", now);
      appendEvent(db, row, "started", now);
    }
    return;
  }
  if (command.type === "reportModels") {
    if (row.kind === "model_list" && row.connectionId)
      db.prepare(
        "UPDATE connections SET models_json=?, models_fetched_at=?, models_error=NULL WHERE id=?",
      ).run(JSON.stringify(command.models), now, row.connectionId);
    setState(db, row, "completed", now);
    appendEvent(db, row, "completed", now, { models: command.models.length });
    return;
  }
  if (command.type === "reportFinished") {
    if (row.kind === "image_probe" && row.connectionId)
      markImageInput(db, row, "verified", now);
    if (row.turnId) {
      const turn = db
        .prepare(
          "SELECT conversation_id AS conversationId, partial_text AS partialText FROM turns WHERE id=?",
        )
        .get(row.turnId) as { conversationId: string; partialText: string };
      db.prepare(
        "INSERT INTO messages (id, conversation_id, turn_id, role, content, created_at) VALUES (?,?,?,'assistant',?,?)",
      ).run(
        randomUUID(),
        turn.conversationId,
        row.turnId,
        turn.partialText,
        now,
      );
    }
    setState(db, row, "completed", now);
    appendEvent(db, row, "completed", now, { seq: command.seq });
    return;
  }
  if (command.type === "reportFailed") {
    // A failed list fetch records the failure but never clears the hand-filled model.
    if (row.kind === "model_list" && row.connectionId)
      db.prepare(
        "UPDATE connections SET models_json=NULL, models_fetched_at=?, models_error=? WHERE id=?",
      ).run(now, command.message, row.connectionId);
    setState(db, row, "failed", now, {
      errorClass: command.errorClass,
      errorMessage: command.message,
    });
    appendEvent(db, row, "failed", now, {
      errorClass: command.errorClass,
      message: command.message,
    });
    openPending(db, row, "failed_turn", now);
    return;
  }
  setState(db, row, "stopped", now);
  appendEvent(db, row, "stopped", now, { seq: command.seq });
}

/**
 * Startup recovery: nothing of this service can still be running, so every open turn-type
 * execution becomes interrupted. Agent executions (kind agent_execution) are the Host's:
 * their physical facts live in runtime_executions and the port classifies them at its own
 * recovery (a stop-unconfirmed record keeps waiting for its escaped processes), so they
 * are neither marked here nor given an interrupted_turn item (RUNTIME-04).
 */
export function recoverInterrupted(db: DatabaseSync, now: string) {
  const rows = db
    .prepare(
      `SELECT ${executionColumns} FROM executions e LEFT JOIN turns t ON t.id = e.turn_id WHERE e.state NOT IN ('completed','stopped','failed','interrupted') AND e.kind <> 'agent_execution'`,
    )
    .all() as unknown as ExecutionRow[];
  for (const row of rows) {
    setState(db, row, "interrupted", now);
    appendEvent(db, row, "interrupted", now, { from: row.state });
    openPending(db, row, "interrupted_turn", now);
  }
  return rows.length;
}

export function executionSnapshot(
  db: DatabaseSync,
  conversationIds: string[],
): Pick<
  Snapshot,
  "messages" | "turns" | "activeTurns" | "pendingItems" | "events"
> {
  const ids = [...new Set(conversationIds)];
  const marks = ids.map(() => "?").join(",") || "NULL";
  const turnSelect = `SELECT t.id, t.material_mode AS materialMode, t.conversation_id AS conversationId, t.request_id AS requestId, t.connection_snapshot AS connection, t.state, t.partial_text AS partialText, t.error_class AS errorClass, t.error_message AS errorMessage, e.id AS executionId, e.attempt, t.omitted_images AS omittedImages, t.created_at AS createdAt, t.ended_at AS endedAt
         FROM turns t JOIN executions e ON e.turn_id = t.id
         WHERE e.attempt = (SELECT MAX(attempt) FROM executions WHERE turn_id = t.id)`;
  const parseTurns = (
    rows: (Omit<Turn, "connection"> & { connection: string })[],
  ): Turn[] =>
    rows.map((turn) => ({
      ...turn,
      connection: JSON.parse(turn.connection) as ConnectionSnapshot,
    }));
  const messages = db
    .prepare(
      `SELECT id, conversation_id AS conversationId, turn_id AS turnId, role, content, created_at AS createdAt FROM messages WHERE conversation_id IN (${marks}) ORDER BY created_at, rowid`,
    )
    .all(...ids) as unknown as Message[];
  const turns = parseTurns(
    db
      .prepare(
        `${turnSelect} AND t.conversation_id IN (${marks}) ORDER BY t.created_at, t.rowid`,
      )
      .all(...ids) as unknown as (Omit<Turn, "connection"> & {
      connection: string;
    })[],
  );
  const activeTurns = parseTurns(
    db
      .prepare(
        `${turnSelect} AND t.state NOT IN ('completed','stopped','failed','interrupted') ORDER BY t.created_at, t.rowid`,
      )
      .all() as unknown as (Omit<Turn, "connection"> & {
      connection: string;
    })[],
  );
  const pendingItems = db
    .prepare(
      `SELECT p.id, p.execution_id AS executionId, e.turn_id AS turnId, t.conversation_id AS conversationId, x.execution_ref AS executionRef, p.kind, p.state, p.created_at AS createdAt, p.resolved_at AS resolvedAt
       FROM pending_items p JOIN executions e ON e.id = p.execution_id LEFT JOIN turns t ON t.id = e.turn_id LEFT JOIN runtime_executions x ON x.execution_id = e.id
       WHERE p.state='open' ORDER BY p.created_at DESC, p.rowid DESC`,
    )
    .all() as unknown as PendingItem[];
  const events = (
    db
      .prepare(
        "SELECT seq, id, execution_id AS executionId, kind, at, snapshot, payload FROM run_events ORDER BY seq DESC LIMIT 200",
      )
      .all() as unknown as (Omit<RunEvent, "connection" | "payload"> & {
      snapshot: string | null;
      payload: string;
    })[]
  ).map(({ snapshot, payload, ...rest }) => ({
    ...rest,
    connection: snapshot ? (JSON.parse(snapshot) as ConnectionSnapshot) : null,
    payload: JSON.parse(payload) as Record<string, unknown>,
  }));
  return { messages, turns, activeTurns, pendingItems, events };
}

/** Latest connection test and model list execution per connection. */
export function connectionChecks(db: DatabaseSync) {
  const rows = db
    .prepare(
      `SELECT connection_id AS connectionId, kind, id AS executionId, state, error_class AS errorClass, error_message AS errorMessage, created_at AS createdAt, ended_at AS endedAt
       FROM executions e WHERE kind IN ('connection_test','model_list','image_probe')
       AND EXISTS (SELECT 1 FROM run_events r JOIN connections c ON c.id=e.connection_id WHERE r.execution_id=e.id AND r.kind='submitted' AND json_extract(r.snapshot,'$.revision')=c.revision)
       AND rowid = (SELECT MAX(rowid) FROM executions WHERE connection_id = e.connection_id AND kind = e.kind)`,
    )
    .all() as unknown as (ConnectionCheck & {
    connectionId: string;
    kind: "connection_test" | "model_list" | "image_probe";
  })[];
  const result = new Map<
    string,
    {
      lastTest: ConnectionCheck | null;
      lastModelList: ConnectionCheck | null;
      lastImageProbe: ConnectionCheck | null;
    }
  >();
  for (const { connectionId, kind, ...check } of rows) {
    const entry = result.get(connectionId) ?? {
      lastTest: null,
      lastModelList: null,
      lastImageProbe: null,
    };
    if (kind === "connection_test") entry.lastTest = check;
    else if (kind === "model_list") entry.lastModelList = check;
    else entry.lastImageProbe = check;
    result.set(connectionId, entry);
  }
  return result;
}
function markImageInput(
  db: DatabaseSync,
  row: ExecutionRow,
  imageInput: ImageInput,
  at: string,
) {
  if (!row.connectionSnapshot) return;
  const snap = JSON.parse(row.connectionSnapshot) as ConnectionSnapshot;
  db.prepare(
    `UPDATE connection_models SET image_input=?,image_input_checked_at=? WHERE connection_id=? AND model_id=? AND EXISTS(SELECT 1 FROM connections WHERE id=? AND revision=?)`,
  ).run(
    imageInput,
    at,
    snap.connectionId,
    snap.model,
    snap.connectionId,
    snap.revision,
  );
}

/** Messages of the turn's conversation up to and including its own user message, with their material. */
/**
 * History as the user sees it: a stopped, failed or interrupted turn keeps the text it
 * received, so the model gets that text too (marked unfinished) instead of an unanswered
 * question followed by the next one. A retried turn has no partial text until it runs again.
 */
export const unfinishedAnswerNote = (state: ExecutionState) =>
  `（回答未完成：${stateLabels[state]}。）`;
export function withUnfinishedAnswers(
  db: DatabaseSync,
  saved: Message[],
): Message[] {
  const answered = new Set(
    saved
      .filter((m) => m.role === "assistant" && m.turnId)
      .map((m) => m.turnId),
  );
  const out: Message[] = [];
  for (const message of saved) {
    out.push(message);
    if (message.role !== "user" || !message.turnId) continue;
    if (answered.has(message.turnId)) continue;
    const unfinished = db
      .prepare(
        "SELECT state, partial_text AS partialText, ended_at AS endedAt FROM turns WHERE id=? AND state IN ('stopped','failed','interrupted') AND partial_text <> ''",
      )
      .get(message.turnId) as
      | { state: ExecutionState; partialText: string; endedAt: string | null }
      | undefined;
    if (!unfinished) continue;
    out.push({
      id: `unfinished:${message.turnId}`,
      conversationId: message.conversationId,
      turnId: message.turnId,
      role: "assistant",
      content: `${unfinished.partialText}\n\n${unfinishedAnswerNote(unfinished.state)}`,
      createdAt: unfinished.endedAt ?? message.createdAt,
    });
  }
  return out;
}
export function turnContext(
  db: DatabaseSync,
  executionId: string,
): {
  messages: Message[];
  attachments: TurnAttachment[];
  projectContext: string | null;
} {
  const row = execution(db, executionId);
  if (!row || !row.turnId)
    throw new StoreError("NOT_FOUND", "该执行不存在或不属于回合。");
  const turn = db
    .prepare(
      "SELECT conversation_id AS conversationId, created_at AS createdAt FROM turns WHERE id=?",
    )
    .get(row.turnId) as { conversationId: string; createdAt: string };
  const own = db
    .prepare("SELECT rowid FROM messages WHERE turn_id=? AND role='user'")
    .get(row.turnId) as { rowid: number };
  const saved = db
    .prepare(
      "SELECT id, conversation_id AS conversationId, turn_id AS turnId, role, content, created_at AS createdAt FROM messages WHERE conversation_id=? AND rowid <= ? ORDER BY created_at, rowid",
    )
    .all(turn.conversationId, own.rowid) as unknown as Message[];
  const messages = withUnfinishedAnswers(db, saved);
  const connection = row.connectionId
    ? (db
        .prepare(
          "SELECT image_input AS imageInput FROM connection_models WHERE connection_id=? AND model_id=?",
        )
        .get(
          row.connectionId,
          row.connectionSnapshot
            ? (JSON.parse(row.connectionSnapshot) as ConnectionSnapshot).model
            : "",
        ) as { imageInput: ImageInput } | undefined)
    : undefined;
  return {
    messages,
    projectContext: validateProjectTurn(db, row.turnId),
    attachments: turnAttachments(
      db,
      messages.map((m) => m.id),
      connection?.imageInput ?? "unknown",
    ),
  };
}
