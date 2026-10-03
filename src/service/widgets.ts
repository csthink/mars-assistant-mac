import { validWidgetValue } from "../shared/widget";
import type { DatabaseSync } from "node:sqlite";
import { StoreError } from "./errors";
import { widgetCapabilities, type WidgetReply } from "../shared/widget-runtime";
import {
  type WidgetHostCommand,
  type WidgetPreview,
  type WidgetDefinition,
} from "../shared/widget-store";
export const widgetSchema = `
CREATE TABLE widget_previews (
  candidate_id TEXT PRIMARY KEY, widget_id TEXT NOT NULL, version TEXT NOT NULL,
  definition TEXT NOT NULL, config TEXT NOT NULL, config_revision INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}', data_revision INTEGER NOT NULL DEFAULT 0,
  drafts TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE widget_config_drafts (
  candidate_id TEXT NOT NULL REFERENCES widget_previews(candidate_id), field TEXT NOT NULL,
  text TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(candidate_id,field)
);
CREATE TABLE widget_view_state (
  candidate_id TEXT NOT NULL REFERENCES widget_previews(candidate_id), surface TEXT NOT NULL,
  state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(candidate_id,surface)
);
CREATE TABLE widget_instances (
  generation TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES widget_previews(candidate_id),
  widget_id TEXT NOT NULL, version TEXT NOT NULL, surface TEXT NOT NULL
);
`;
function refuse(message: string): never {
  throw new StoreError("INVALID_COMMAND", message);
}
export function readWidgetPreview(
  db: DatabaseSync,
  candidateId: string,
): WidgetPreview {
  const row = db
    .prepare("SELECT * FROM widget_previews WHERE candidate_id=? AND active=1")
    .get(candidateId);
  if (!row) refuse("控件候选已失效，请重新载入。");
  return {
    candidateId,
    widgetId: String(row.widget_id),
    version: String(row.version),
    definition: JSON.parse(String(row.definition)),
    config: JSON.parse(String(row.config)),
    configRevision: Number(row.config_revision),
    configDrafts: Object.fromEntries(
      db
        .prepare(
          "SELECT field,text,revision FROM widget_config_drafts WHERE candidate_id=?",
        )
        .all(candidateId)
        .map((row) => [
          String(row.field),
          { text: String(row.text), revision: Number(row.revision) },
        ]),
    ),
    data: JSON.parse(String(row.data)),
    dataRevision: Number(row.data_revision),
    drafts: JSON.parse(String(row.drafts)),
  };
}
function bounded(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > 60_000)
    refuse("控件数据超过保存限制。");
}
function config(definition: WidgetDefinition, value: Record<string, unknown>) {
  if (
    Object.keys(value).length !== definition.config.length ||
    definition.config.some(
      (field) =>
        !Object.hasOwn(value, field.id) ||
        !validWidgetValue(field, value[field.id]),
    )
  )
    refuse("配置格式无效，输入未提交。");
}
export function applyWidgetHost(
  db: DatabaseSync,
  command: WidgetHostCommand,
): { widget?: WidgetReply; widgetPreview?: WidgetPreview } {
  if (command.type === "widgetCreate") {
    const defaults = Object.fromEntries(
      command.definition.config.map((f) => [f.id, f.default]),
    );
    bounded(defaults);
    db.prepare(
      "INSERT INTO widget_previews(candidate_id,widget_id,version,definition,config) VALUES(?,?,?,?,?)",
    ).run(
      command.candidateId,
      command.widgetId,
      command.version,
      JSON.stringify(command.definition),
      JSON.stringify(defaults),
    );
    return { widgetPreview: readWidgetPreview(db, command.candidateId) };
  }
  if (command.type === "widgetRevoke") {
    db.prepare("DELETE FROM widget_instances WHERE generation=?").run(
      command.generation,
    );
    return {};
  }
  if (command.type === "widgetBind") {
    const i = command.identity,
      preview = readWidgetPreview(db, i.candidateId);
    if (preview.widgetId !== i.widgetId || preview.version !== i.version)
      refuse("控件来源不匹配。");
    db.prepare(
      "INSERT INTO widget_instances(generation,candidate_id,widget_id,version,surface) VALUES(?,?,?,?,?)",
    ).run(i.generation, i.candidateId, i.widgetId, i.version, i.surface);
    return {};
  }
  if (command.type === "widgetRequest") {
    const i = command.identity,
      request = command.request;
    const registration = db
      .prepare(
        "SELECT 1 FROM widget_instances WHERE generation=? AND candidate_id=? AND widget_id=? AND version=? AND surface=?",
      )
      .get(i.generation, i.candidateId, i.widgetId, i.version, i.surface);
    if (!registration) refuse("控件实例已失效，数据未修改。");
    const preview = readWidgetPreview(db, i.candidateId);
    if (
      widgetCapabilities[request.method] !== undefined &&
      !preview.definition.capabilities.includes(
        widgetCapabilities[request.method]!,
      )
    )
      refuse("控件未声明此能力。");
    if (request.method === "readView" || request.method === "writeView") {
      const old = db
        .prepare(
          "SELECT state,revision FROM widget_view_state WHERE candidate_id=? AND surface=?",
        )
        .get(i.candidateId, i.surface);
      const revision = Number(old?.revision ?? 0);
      if (request.method === "readView")
        return {
          widget: {
            ok: true,
            revision,
            value: old
              ? JSON.parse(String(old.state))
              : { scrollX: 0, scrollY: 0, expanded: [], focus: null },
          },
        };
      if (request.revision !== revision)
        refuse("界面状态已改变，旧实例状态未保存。");
      db.prepare(
        "INSERT INTO widget_view_state(candidate_id,surface,state,revision) VALUES(?,?,?,?) ON CONFLICT(candidate_id,surface) DO UPDATE SET state=excluded.state,revision=excluded.revision",
      ).run(
        i.candidateId,
        i.surface,
        JSON.stringify(request.value),
        revision + 1,
      );
      return {
        widget: {
          ok: true,
          revision: revision + 1,
          value: { ...request.value },
        },
      };
    }
    if (request.method === "readConfig")
      return {
        widget: {
          ok: true,
          revision: preview.configRevision,
          value: preview.config,
        },
      };
    if (request.method === "readData")
      return {
        widget: {
          ok: true,
          revision: preview.dataRevision,
          value: preview.data,
        },
      };
    if (request.method === "readDraft")
      return { widget: { ok: true, revision: 0, value: preview.drafts } };
    if (request.method === "writeData") {
      if (request.revision !== preview.dataRevision)
        refuse("数据已在另一入口改变，请重新读取后再保存。");
      bounded(request.value);
      db.prepare(
        "UPDATE widget_previews SET data=?,data_revision=data_revision+1 WHERE candidate_id=?",
      ).run(JSON.stringify(request.value), i.candidateId);
      return {
        widget: {
          ok: true,
          revision: preview.dataRevision + 1,
          value: request.value,
        },
      };
    }
    if (
      request.method !== "writeDraft" ||
      !preview.definition.draftFields.includes(request.field)
    )
      refuse("草稿字段未声明。");
    const old = preview.drafts[request.field];
    if (request.revision !== (old?.revision ?? 0))
      refuse("草稿已在另一入口改变。当前输入尚未保存，请先核对已保存内容。");
    const draft = { text: request.value, revision: request.revision + 1 };
    const drafts = { ...preview.drafts, [request.field]: draft };
    bounded(drafts);
    db.prepare("UPDATE widget_previews SET drafts=? WHERE candidate_id=?").run(
      JSON.stringify(drafts),
      i.candidateId,
    );
    return {
      widget: {
        ok: true,
        revision: draft.revision,
        value: { [request.field]: draft },
      },
    };
  }
  const preview = readWidgetPreview(db, command.candidateId);
  if (command.type === "widgetConfigDraft") {
    if (!preview.definition.config.some((field) => field.id === command.field))
      refuse("配置字段未声明。");
    const old = preview.configDrafts[command.field];
    if (command.revision !== (old?.revision ?? 0))
      refuse("设置草稿已在另一入口改变，当前输入尚未保存。");
    bounded({
      ...preview.configDrafts,
      [command.field]: { text: command.value, revision: command.revision + 1 },
    });
    db.prepare(
      "INSERT INTO widget_config_drafts(candidate_id,field,text,revision) VALUES(?,?,?,?) ON CONFLICT(candidate_id,field) DO UPDATE SET text=excluded.text,revision=excluded.revision",
    ).run(
      command.candidateId,
      command.field,
      command.value,
      command.revision + 1,
    );
    return { widgetPreview: readWidgetPreview(db, command.candidateId) };
  }
  if (command.type === "widgetInspect") return { widgetPreview: preview };
  if (command.type === "widgetDiscard") {
    db.prepare("DELETE FROM widget_instances WHERE candidate_id=?").run(
      command.candidateId,
    );
    db.prepare("UPDATE widget_previews SET active=0 WHERE candidate_id=?").run(
      command.candidateId,
    );
    return {};
  }
  if (command.revision !== preview.configRevision)
    refuse("配置已改变，请重新核对后保存。");
  if (
    Object.keys(command.draftRevisions).length !==
      preview.definition.config.length ||
    preview.definition.config.some(
      (field) =>
        command.draftRevisions[field.id] !==
        (preview.configDrafts[field.id]?.revision ?? 0),
    )
  )
    refuse("设置草稿已改变，请重新核对后保存设置。");
  config(preview.definition, command.value);
  bounded(command.value);
  db.prepare(
    "UPDATE widget_previews SET config=?,config_revision=config_revision+1 WHERE candidate_id=?",
  ).run(JSON.stringify(command.value), command.candidateId);
  return { widgetPreview: readWidgetPreview(db, command.candidateId) };
}
