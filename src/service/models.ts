import { requireClaudeEnabled } from "./claude-settings";
import { requireCodexEnabled } from "./codex-settings";
import type { DatabaseSync } from "node:sqlite";
import {
  validEffort,
  type Command,
  type ConnectionModel,
  type EffortRecord,
  type ImageInput,
} from "../shared/protocol";
import { StoreError } from "./errors";

/** Stored records are re-validated on read; anything unparseable is simply unrecorded. */
export function parseEffort(value: unknown): EffortRecord | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return validEffort(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
export function modelRows(db: DatabaseSync, id: string): ConnectionModel[] {
  return db
    .prepare(
      "SELECT claude_json AS claudeJson,codex_json AS codexJson,effort_json AS effortJson,model_id AS model,enabled,image_input AS imageInput,image_input_checked_at AS imageInputCheckedAt,context_chars AS contextChars FROM connection_models WHERE connection_id=? ORDER BY rowid",
    )
    .all(id)
    .map(({ codexJson, claudeJson, effortJson, ...r }) => ({
      ...r,
      ...(claudeJson ? { claude: JSON.parse(String(claudeJson)) } : {}),
      ...(codexJson ? { codex: JSON.parse(String(codexJson)) } : {}),
      effort: parseEffort(effortJson),
      enabled: r.enabled === 1,
      ...Object.fromEntries(
        (
          [
            ["lastTest", "connection_test"],
            ["lastProbe", "image_probe"],
          ] as const
        ).map(([field, kind]) => [
          field,
          db
            .prepare(
              `SELECT e.id AS executionId,e.state,e.error_class AS errorClass,e.error_message AS errorMessage,e.created_at AS createdAt,e.ended_at AS endedAt FROM executions e JOIN run_events r ON r.execution_id=e.id AND r.kind='submitted' WHERE e.connection_id=? AND e.kind=? AND json_extract(r.snapshot,'$.model')=? AND json_extract(r.snapshot,'$.revision')=(SELECT revision FROM connections WHERE id=e.connection_id) ORDER BY e.rowid DESC LIMIT 1`,
            )
            .get(id, kind, String(r.model)) ?? null,
        ]),
      ),
    })) as unknown as ConnectionModel[];
}
interface Row {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  secret_ref: string | null;
  codex_json: string | null;
  model: string;
  enabled: number;
  revision: number;
}
function connection(db: DatabaseSync, id: string) {
  const row = db
    .prepare("SELECT * FROM connections WHERE id=?")
    .get(id) as unknown as Row | undefined;
  if (!row) throw new StoreError("NOT_FOUND", "该提供方不存在，操作未执行。");
  return row;
}
function defaults(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT default_connection_id AS id,default_model_id AS model FROM settings WHERE id=1",
    )
    .get() as { id: string | null; model: string | null };
}
function active(db: DatabaseSync, id: string) {
  if (
    db
      .prepare(
        "SELECT 1 FROM widget_generation_tasks WHERE json_extract(connection,'$.connectionId')=? AND state NOT IN ('completed','stopped','failed','interrupted')",
      )
      .get(id)
  )
    throw new StoreError(
      "CONFLICT",
      "该连接正被控件生成任务使用，请等待或先停止。",
    );
  if (
    db
      .prepare(
        "SELECT 1 FROM executions WHERE connection_id=? AND state NOT IN ('completed','stopped','failed','interrupted')",
      )
      .get(id)
  )
    throw new StoreError(
      "CONFLICT",
      "该连接正在被执行中的回合或检查使用。请等待结束或先停止，再修改。",
    );
}
function revision(row: Row, value: number) {
  if (row.revision !== value)
    throw new StoreError(
      "CONFLICT",
      "该连接已在另一入口更新。当前输入已保留，请重新打开后核对。",
    );
}
function bump(db: DatabaseSync, id: string) {
  db.prepare(
    "UPDATE connections SET revision=revision+1,updated_at=? WHERE id=?",
  ).run(new Date().toISOString(), id);
}
function releaseDefault(db: DatabaseSync, id: string, confirmed: boolean) {
  if (defaults(db).id !== id) return;
  if (!confirmed)
    throw new StoreError(
      "CONFLICT",
      "该提供方含默认模型。请先选择其他默认模型，或确认取消默认；不会自动切换账户。",
    );
  db.exec(
    "UPDATE settings SET default_connection_id=NULL,default_model_id=NULL WHERE id=1",
  );
}
function writeModel(
  db: DatabaseSync,
  id: string,
  model: string,
  enabled: boolean,
  imageInput: ImageInput,
  contextChars: number | null,
) {
  const old = modelRows(db, id).find((m) => m.model === model);
  if (imageInput === "verified" && old?.imageInput !== "verified")
    throw new StoreError(
      "CONFLICT",
      "“支持（已实测）”只能通过“检测图片能力”得到。",
    );
  const d = defaults(db);
  if (!enabled && d.id === id && d.model === model)
    throw new StoreError("CONFLICT", "这是默认模型，请先把其他模型设为默认。");
  db.prepare(
    `INSERT INTO connection_models (connection_id,model_id,enabled,image_input,context_chars) VALUES (?,?,?,?,?) ON CONFLICT(connection_id,model_id) DO UPDATE SET enabled=excluded.enabled,image_input=excluded.image_input,image_input_checked_at=CASE WHEN connection_models.image_input=excluded.image_input THEN connection_models.image_input_checked_at ELSE NULL END,context_chars=excluded.context_chars`,
  ).run(id, model, Number(enabled), imageInput, contextChars);
}
export function selectedModel(
  db: DatabaseSync,
  id: string,
  model?: string,
  requireReady = true,
) {
  const c = connection(db, id);
  if (c.provider === "claude") requireClaudeEnabled(db);
  if (c.provider === "codex") requireCodexEnabled(db);
  const m = modelRows(db, id).find((m) => m.model === (model ?? c.model));
  if (!m)
    throw new StoreError(
      "CONFLICT",
      "所选连接没有模型 ID 或模型已移除，请在设置中添加模型。",
    );
  if (c.provider === "claude" && !m.claude)
    throw new StoreError(
      "CONFLICT",
      "该 Claude Code 模型尚未确认来源，请在设置中核对并添加。",
    );
  if (c.provider === "codex" && !m.codex)
    throw new StoreError(
      "CONFLICT",
      "该 Codex 模型尚未确认来源，请在设置中核对并添加。",
    );
  if (
    requireReady &&
    (!c.enabled ||
      !m.enabled ||
      (c.provider === "codex"
        ? !m.codex
        : c.provider === "claude"
          ? !m.claude
          : !c.secret_ref))
  )
    throw new StoreError(
      "CONFLICT",
      "该模型不可用。请启用提供方、保存密钥并勾选模型后重试。",
    );
  return {
    connectionId: c.id,
    name: c.name,
    provider: c.provider,
    baseUrl: c.base_url,
    model: m.model,
    revision: c.revision,
    ...(m.claude ? { claude: m.claude } : {}),
    ...(m.codex ? { codex: m.codex } : {}),
    imageInput: m.imageInput,
    contextChars: m.contextChars,
    effort: c.provider === "codex" || c.provider === "claude" ? m.effort : null,
  };
}
/**
 * Replace the records of one local executor's confirmed models with the latest read-back.
 * Models missing from the read-back become unrecorded; API providers never hold a record.
 */
export function recordEffort(
  db: DatabaseSync,
  provider: "codex" | "claude",
  efforts: Record<string, EffortRecord | null>,
) {
  const row = db
    .prepare("SELECT id FROM connections WHERE provider=?")
    .get(provider);
  if (!row) return;
  const origin = provider === "codex" ? "codex_json" : "claude_json";
  const rows = db
    .prepare(
      `SELECT model_id AS model FROM connection_models WHERE connection_id=? AND ${origin} IS NOT NULL`,
    )
    .all(String(row.id));
  const write = db.prepare(
    "UPDATE connection_models SET effort_json=? WHERE connection_id=? AND model_id=?",
  );
  for (const entry of rows) {
    const model = String(entry.model);
    const effort = Object.hasOwn(efforts, model) ? efforts[model] : null;
    write.run(effort ? JSON.stringify(effort) : null, String(row.id), model);
  }
}
/** The connection/model a conversation currently sends to: its explicit choice, else the global default. */
export function conversationTarget(
  db: DatabaseSync,
  conversationId: string,
): { connectionId: string; model?: string } | null {
  const row = db
    .prepare(
      "SELECT connection_id AS connectionId,model_id AS modelId FROM conversations WHERE id=?",
    )
    .get(conversationId);
  if (!row) throw new StoreError("NOT_FOUND", "原对话不存在，请重新选择对话。");
  if (row.connectionId)
    return {
      connectionId: String(row.connectionId),
      ...(row.modelId ? { model: String(row.modelId) } : {}),
    };
  const d = defaults(db);
  return d.id
    ? { connectionId: d.id, ...(d.model ? { model: d.model } : {}) }
    : null;
}
export function mutateModels(db: DatabaseSync, c: Command): boolean {
  if (c.type === "setDefaultConnection") {
    if (c.id === null) {
      db.exec(
        "UPDATE settings SET default_connection_id=NULL,default_model_id=NULL WHERE id=1",
      );
      return true;
    }
    const m = selectedModel(db, c.id, c.model);
    db.prepare(
      "UPDATE settings SET default_connection_id=?,default_model_id=? WHERE id=1",
    ).run(c.id, m.model);
    db.prepare("UPDATE connections SET model=? WHERE id=?").run(m.model, c.id);
    return true;
  }
  if (c.type === "chooseConnection") {
    const previous = db
      .prepare(
        "SELECT connection_id AS connectionId,model_id AS modelId FROM conversations WHERE id=?",
      )
      .get(c.conversationId);
    if (!previous)
      throw new StoreError("NOT_FOUND", "原对话不存在，请重新选择对话。");
    const m = c.connectionId
      ? selectedModel(db, c.connectionId, c.model)
      : null;
    const model = m?.model ?? null;
    // Levels belong to one connection/model; a different target never inherits the choice.
    const same =
      previous.connectionId === c.connectionId && previous.modelId === model;
    db.prepare(
      `UPDATE conversations SET connection_id=?,model_id=?${same ? "" : ",effort=NULL"} WHERE id=?`,
    ).run(c.connectionId, model, c.conversationId);
    return true;
  }
  if (c.type === "chooseEffort") {
    const target = conversationTarget(db, c.conversationId);
    if (c.effort !== null) {
      const effort = target
        ? selectedModel(db, target.connectionId, target.model, false).effort
        : null;
      if (!effort)
        throw new StoreError(
          "CONFLICT",
          "当前模型没有推理强度档位记录，按模型默认执行；请先选择有记录的模型。",
        );
      if (!effort.levels.includes(c.effort))
        throw new StoreError(
          "CONFLICT",
          "所选推理强度档位不在当前模型记录的档位集合内，请重新选择。",
        );
    }
    db.prepare("UPDATE conversations SET effort=? WHERE id=?").run(
      c.effort,
      c.conversationId,
    );
    return true;
  }
  if (c.type === "setConnectionEnabled") {
    const row = connection(db, c.id);
    revision(row, c.revision);
    if (!c.enabled) {
      active(db, c.id);
      releaseDefault(db, c.id, c.clearDefault);
    }
    db.prepare("UPDATE connections SET enabled=? WHERE id=?").run(
      Number(c.enabled),
      c.id,
    );
    bump(db, c.id);
    return true;
  }
  if (c.type === "upsertModel" || c.type === "deleteModel") {
    const row = connection(db, c.id);
    revision(row, c.revision);
    active(db, c.id);
    if (c.type === "deleteModel") {
      const d = defaults(db);
      if (d.id === c.id && d.model === c.model)
        throw new StoreError(
          "CONFLICT",
          "这是默认模型，请先把其他模型设为默认。",
        );
      db.prepare(
        "DELETE FROM connection_models WHERE connection_id=? AND model_id=?",
      ).run(c.id, c.model);
    } else
      writeModel(db, c.id, c.model, c.enabled, c.imageInput, c.contextChars);
    const models = modelRows(db, c.id);
    if (!models.some((m) => m.model === row.model && m.enabled))
      db.prepare("UPDATE connections SET model=? WHERE id=?").run(
        models.find((m) => m.enabled)?.model ?? "",
        c.id,
      );
    bump(db, c.id);
    return true;
  }
  if (c.type === "deleteConnection") {
    if (!db.prepare("SELECT 1 FROM connections WHERE id=?").get(c.id))
      return true;
    active(db, c.id);
    releaseDefault(db, c.id, false);
    db.prepare("DELETE FROM connections WHERE id=?").run(c.id);
    return true;
  }
  if (c.type !== "upsertConnection") return false;
  const old = db
    .prepare("SELECT * FROM connections WHERE id=?")
    .get(c.id) as unknown as Row | undefined;
  const oldModel = old
    ? modelRows(db, c.id).find((m) => m.model === old.model)
    : undefined;
  if (c.imageInput === "verified" && oldModel?.imageInput !== "verified")
    throw new StoreError(
      "CONFLICT",
      "“支持（已实测）”只能通过“检测图片能力”得到。",
    );
  if (
    old &&
    old.name === c.name &&
    old.provider === c.provider &&
    old.base_url === c.baseUrl &&
    old.model === c.model &&
    old.secret_ref === c.secretRef &&
    (oldModel?.imageInput ?? "unknown") === c.imageInput &&
    (oldModel?.contextChars ?? null) === c.contextChars
  )
    return true;
  if (old) {
    revision(old, c.revision);
    active(db, c.id);
  } else if (c.revision !== 0)
    throw new StoreError(
      "CONFLICT",
      "该连接已被删除。请重新创建连接，当前输入已保留。",
    );
  if (old && old.provider !== c.provider)
    throw new StoreError(
      "CONFLICT",
      "已有连接不能变更提供方，请添加自定义提供方。",
    );
  if (
    c.provider !== "custom" &&
    db
      .prepare("SELECT 1 FROM connections WHERE provider=? AND id<>?")
      .get(c.provider, c.id)
  )
    throw new StoreError(
      "CONFLICT",
      "该厂商已有提供方。第二个账户或地址请添加自定义提供方。",
    );
  const d = defaults(db);
  if (d.id === c.id && (!c.model || (!c.secretRef && old?.secret_ref)))
    releaseDefault(db, c.id, c.clearDefault === true);
  const now = new Date().toISOString();
  if (!old)
    db.prepare(
      "INSERT INTO connections (id,name,provider,base_url,model,secret_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(c.id, c.name, c.provider, c.baseUrl, c.model, c.secretRef, now, now);
  else
    db.prepare(
      "UPDATE connections SET name=?,base_url=?,model=?,secret_ref=?,revision=revision+1,updated_at=? WHERE id=?",
    ).run(c.name, c.baseUrl, c.model, c.secretRef, now, c.id);
  const endpointChanged =
    old && (old.base_url !== c.baseUrl || old.secret_ref !== c.secretRef);
  if (endpointChanged)
    db.prepare(
      "UPDATE connections SET models_json=NULL,models_error=NULL,models_fetched_at=NULL WHERE id=?",
    ).run(c.id);
  if (endpointChanged)
    db.prepare(
      "UPDATE connection_models SET image_input='unknown',image_input_checked_at=NULL WHERE connection_id=?",
    ).run(c.id);
  if (c.model) {
    const changed = old && old.model !== c.model;
    const capability =
      endpointChanged ||
      (changed && c.imageInput === (oldModel?.imageInput ?? "unknown"))
        ? "unknown"
        : c.imageInput;
    writeModel(db, c.id, c.model, true, capability, c.contextChars);
  }
  if (d.id === c.id && c.model && defaults(db).id === c.id)
    db.prepare("UPDATE settings SET default_model_id=? WHERE id=1").run(
      c.model,
    );
  return true;
}
