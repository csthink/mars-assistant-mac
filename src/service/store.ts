import { projectWorkSchema, captureProjectTurn } from "./project-work";
import { widgetSchema, applyWidgetHost } from "./widgets";
import { projectSchema, projectSnapshot, applyProject } from "./projects";
import {
  validProjectCommand,
  validProjectHostCommand,
  type ProjectHostCommand,
  type ProjectUndo,
} from "../shared/projects";
import {
  applyRuntimeHost,
  runtimeSchema,
  runtimeSnapshot,
} from "./runtime-store";
import { migrateRuntimeExecutions } from "./runtime-executions";
import {
  runtimeReadCommands,
  validRuntimeHostCommand,
  type RuntimeHostCommand,
} from "../shared/runtime-host";
import {
  validWidgetHostCommand,
  type WidgetHostCommand,
} from "../shared/widget-store";
import { migrateClaude, configureClaude } from "./claude-connection";
import { claudeSettings, setClaudeSettings } from "./claude-settings";
import {
  codexSettingsSchema,
  codexSettings,
  setCodexSettings,
} from "./codex-settings";
import {
  migrateCodex,
  configureCodex,
  codexRunSchema,
} from "./codex-connection";
import {
  validCapabilityCommand,
  validCapabilityHostCommand,
  type CapabilityHostCommand,
} from "../shared/capabilities";
import {
  capabilitySchema,
  capabilitySnapshot,
  applyCapabilityHost,
  applyCapabilityCommand,
  settleCapabilities,
} from "./capabilities";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  validCommand,
  validHostCommand,
  type Command,
  type Connection,
  type Conversation,
  type HostCommand,
  type Reply,
  type Snapshot,
  type Surface,
} from "../shared/protocol";
import { StoreError } from "./errors";
import { backupBeforeUpgrade } from "./backup";
import {
  applyExtraction,
  attachmentDirectory,
  attachmentSchema,
  attachmentSnapshot,
  importAttachment,
  pendingExtractions,
  readPreview,
  removeDraftAttachment,
  verifyAttachmentDirectory,
} from "./attachments";
import {
  applyHostCommand,
  connectionChecks,
  executionErrorSchema,
  executionPartialSchema,
  executionRebuildSchema,
  executionSchema,
  executionSnapshot,
  mutateTurn,
  recoverInterrupted,
  turnContext,
  type Origin,
} from "./execution";

import { mutateModels, modelRows, recordEffort } from "./models";
import { migrateModels } from "./model-migration";

import {
  migrateTitles,
  renameConversation,
  updateAutomaticTitle,
} from "./titles";

import {
  registerSearchFunctions,
  createSearchIndex,
  rebuildSearchIndex,
} from "./search-index";

import {
  migrateOrganization,
  organizeConversation,
  assertConversationAvailable,
  readConversation,
  unarchiveOnSubmit,
} from "./organization";

export { StoreError };
export const schemaVersion = 25;
// Each entry upgrades from its index version to the next; a fresh database runs them all.
// Version 2 adds connections (secrets live in the host vault); version 3 adds settings and model list state.
/** Exported for tests that build a database at an older version. */
export const migrations: Record<number, string | ((db: DatabaseSync) => void)> =
  {
    1: `CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('zhipu','deepseek','openrouter','siliconflow','custom')),
    base_url TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    secret_ref TEXT UNIQUE,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
    2: `ALTER TABLE connections ADD COLUMN models_json TEXT;
  ALTER TABLE connections ADD COLUMN models_fetched_at TEXT;
  ALTER TABLE connections ADD COLUMN models_error TEXT;
  CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK(id=1),
    default_connection_id TEXT REFERENCES connections(id),
    telemetry_enabled INTEGER NOT NULL DEFAULT 0 CHECK(telemetry_enabled IN (0,1))
  );
  INSERT INTO settings VALUES (1,NULL,0);`,
    3: executionSchema,
    4: executionErrorSchema,
    5: executionPartialSchema,
    // Version 7: per-conversation connection choice and confirmed provider scopes.
    6: `ALTER TABLE conversations ADD COLUMN connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL;
  ALTER TABLE conversations ADD COLUMN granted_providers TEXT NOT NULL DEFAULT '[]';`,
    // Version 8: selected material, its content-addressed copies and the messages that carry them.
    7: attachmentSchema,
    // Version 9: per-connection image capability and context budget, omitted history images per turn,
    // and the image probe as a host execution kind (the CHECK constraint needs a table rebuild).
    9: migrateModels,
    12: migrateOrganization,
    13: capabilitySchema,
    14: migrateCodex,
    15: codexRunSchema,
    16: codexSettingsSchema,
    18: migrateClaude,
    19: widgetSchema,
    // Version 21: reasoning effort records per connection/model and the per-conversation choice.
    20: `ALTER TABLE connection_models ADD COLUMN effort_json TEXT;
      ALTER TABLE conversations ADD COLUMN effort TEXT;`,
    // Version 22: Runtime Host installations and instances (feature-t29).
    21: runtimeSchema,
    // Version 23: physical Agent executions, role selections, the agent_execution kind and the stop_unconfirmed pending kind (feature-t30).
    22: migrateRuntimeExecutions,
    // Version 24: local project organization; domain state stays in Runtime projections.
    23: projectSchema,
    24: projectWorkSchema,
    17: `ALTER TABLE connection_models ADD COLUMN codex_json TEXT;
      UPDATE connection_models SET codex_json=(SELECT codex_json FROM connections WHERE connections.id=connection_models.connection_id)
      WHERE connection_id IN (SELECT id FROM connections WHERE provider='codex')
      AND model_id=(SELECT model FROM connections WHERE connections.id=connection_models.connection_id);`,
    // Persist insertion order before any later VACUUM can reassign implicit rowids.
    // Legacy databases have no creation timestamp; never infer it from activity.
    11: `ALTER TABLE conversations ADD COLUMN creation_order INTEGER;
      UPDATE conversations SET creation_order=rowid;
      CREATE UNIQUE INDEX conversations_creation_order ON conversations(creation_order);
      CREATE TRIGGER conversation_creation_order AFTER INSERT ON conversations
      BEGIN
        UPDATE conversations SET creation_order=(SELECT COALESCE(MAX(creation_order),0)+1 FROM conversations)
        WHERE id=NEW.id;
      END;`,
    10: (db) => {
      migrateTitles(db);
      createSearchIndex(db);
    },
    8: (db) => {
      db.exec(`ALTER TABLE connections ADD COLUMN image_input TEXT NOT NULL DEFAULT 'unknown' CHECK(image_input IN ('unknown','declared','verified','unsupported'));
      ALTER TABLE connections ADD COLUMN image_input_checked_at TEXT;
      ALTER TABLE connections ADD COLUMN context_chars INTEGER;
      ALTER TABLE turns ADD COLUMN omitted_images INTEGER NOT NULL DEFAULT 0;
      ${executionRebuildSchema}`);
    },
  };
interface ConnectionRow {
  id: string;
  name: string;
  provider: Connection["provider"];
  baseUrl: string;
  model: string;
  enabled: number;
  secretRef: string | null;
  codexJson: string | null;
  claudeJson: string | null;
  modelsJson: string | null;
  modelsFetchedAt: string | null;
  modelsError: string | null;
  imageInput: Connection["imageInput"];
  imageInputCheckedAt: string | null;
  contextChars: number | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
const connectionColumns =
  "claude_json AS claudeJson,codex_json AS codexJson,id,name,provider,base_url AS baseUrl,model,enabled,secret_ref AS secretRef,models_json AS modelsJson,models_fetched_at AS modelsFetchedAt,models_error AS modelsError,COALESCE((SELECT image_input FROM connection_models WHERE connection_id=connections.id AND model_id=connections.model),'unknown') AS imageInput,(SELECT image_input_checked_at FROM connection_models WHERE connection_id=connections.id AND model_id=connections.model) AS imageInputCheckedAt,(SELECT context_chars FROM connection_models WHERE connection_id=connections.id AND model_id=connections.model) AS contextChars,revision,created_at AS createdAt,updated_at AS updatedAt";
function toConnection(
  row: ConnectionRow,
  checks: ReturnType<typeof connectionChecks>,
  db: DatabaseSync,
): Connection {
  const {
    modelsJson,
    modelsFetchedAt,
    modelsError,
    codexJson,
    claudeJson,
    ...rest
  } = row;
  const check = checks.get(row.id) ?? {
    lastTest: null,
    lastModelList: null,
    lastImageProbe: null,
  };
  const modelList: Connection["modelList"] =
    modelsFetchedAt && modelsJson !== null
      ? {
          state: "fetched",
          models: JSON.parse(modelsJson) as string[],
          fetchedAt: modelsFetchedAt,
        }
      : modelsFetchedAt && modelsError !== null
        ? { state: "failed", error: modelsError, failedAt: modelsFetchedAt }
        : { state: "unknown" };
  const models = modelRows(db, row.id);
  const claude = models.find((m) => m.model === row.model)?.claude;
  const codex = models.find((m) => m.model === row.model)?.codex;
  return {
    ...rest,
    ...(claude
      ? { claude }
      : claudeJson
        ? { claude: JSON.parse(claudeJson) }
        : {}),
    ...(codex ? { codex } : codexJson ? { codex: JSON.parse(codexJson) } : {}),
    enabled: row.enabled === 1,
    models,
    modelList,
    ...check,
  };
}

export class Store {
  readonly db!: DatabaseSync;
  readonly root: string;
  private lock: DatabaseSync;
  constructor(path: string, create = false) {
    process.umask(0o077);
    if (!existsSync(path)) {
      if (!create)
        throw new StoreError(
          "INVALID_ROOT",
          "数据目录不存在。请检查指定目录，应用没有改用其他目录。",
        );
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    this.root = realpathSync(path);
    if (!lstatSync(this.root).isDirectory())
      throw new StoreError("INVALID_ROOT", "数据路径不是目录。");
    for (const name of ["root-lock.sqlite", "state.sqlite"]) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        const file = join(this.root, name + suffix);
        // lstat also rejects dangling symlinks, which existsSync intentionally ignores.
        try {
          if (lstatSync(file).isSymbolicLink())
            throw new StoreError("INVALID_ROOT", "数据库文件不能是符号链接。");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    const original = readdirSync(this.root);
    const known = /^(root-lock|state)\.sqlite(?:-wal|-shm|-journal)?$/;
    if (
      original.some((name) => !known.test(name) && name !== attachmentDirectory)
    )
      throw new StoreError(
        "INVALID_ROOT",
        "目录中包含非本应用数据。请选择独立的空目录。",
      );
    verifyAttachmentDirectory(this.root);
    this.lock = new DatabaseSync(join(this.root, "root-lock.sqlite"));
    try {
      this.lock.exec(
        "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER);",
      );
    } catch {
      this.lock.close();
      throw new StoreError(
        "ROOT_LOCKED",
        "数据目录正由另一个业务进程使用。请关闭该实例后重试。",
      );
    }
    try {
      const existing = existsSync(join(this.root, "state.sqlite"));
      if (!existing && original.includes("root-lock.sqlite"))
        throw new StoreError(
          "INVALID_ROOT",
          "已登记的数据目录缺少业务数据库。请恢复原数据，不创建空工作台。",
        );
      this.db = new DatabaseSync(join(this.root, "state.sqlite"));
      if (existing) {
        const identity = this.db.prepare("PRAGMA application_id").get() as {
          application_id: number;
        };
        const version = this.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        };
        if (
          identity.application_id !== 1129534529 ||
          version.user_version < 1 ||
          version.user_version > schemaVersion
        )
          throw new StoreError(
            "INVALID_ROOT",
            "数据身份或版本不兼容，应用未改写原数据。",
          );
        if (version.user_version < schemaVersion)
          backupBeforeUpgrade(this.db, this.root, version.user_version);
      }
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;",
      );
      if (!existing) {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), root_id TEXT NOT NULL, revision INTEGER NOT NULL);
          CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, draft TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
          CREATE TABLE selections (surface TEXT PRIMARY KEY CHECK(surface IN ('main','panel')), conversation_id TEXT REFERENCES conversations(id));
          INSERT INTO selections VALUES ('main',NULL),('panel',NULL);
          PRAGMA application_id=1129534529; PRAGMA user_version=1;`);
        this.db.prepare("INSERT INTO meta VALUES(1,?,0)").run(randomUUID());
        this.db.exec("COMMIT");
      }
      registerSearchFunctions(this.db);
      for (;;) {
        const current = (
          this.db.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version;
        if (current >= schemaVersion) break;
        const migration = migrations[current];
        if (typeof migration === "string") {
          this.db.exec(
            `BEGIN IMMEDIATE; ${migration} PRAGMA user_version=${current + 1}; COMMIT`,
          );
          continue;
        }
        // A table rebuild follows SQLite's documented procedure: foreign keys off around the transaction,
        // then an explicit integrity check before they are switched back on.
        this.db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
        try {
          migration(this.db);
          const violations = this.db.prepare("PRAGMA foreign_key_check").all();
          if (violations.length) throw new Error("foreign key check failed");
          this.db.exec(`PRAGMA user_version=${current + 1}; COMMIT`);
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        } finally {
          this.db.exec("PRAGMA foreign_keys=ON");
        }
      }
      const version = this.db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (version.user_version !== schemaVersion)
        throw new StoreError(
          "INVALID_ROOT",
          "数据版本不兼容，应用未改写原数据。",
        );
      const integrity = this.db.prepare("PRAGMA quick_check").get() as {
        quick_check: string;
      };
      if (integrity.quick_check !== "ok")
        throw new StoreError(
          "INVALID_ROOT",
          "数据库校验失败。请保留数据并恢复备份。",
        );
      // A fresh process proves nothing is still executing; leave a trace instead of pretending.
      this.db.exec("BEGIN IMMEDIATE");
      if (
        recoverInterrupted(this.db, new Date().toISOString()) +
        settleCapabilities(this.db, new Date().toISOString())
      )
        this.db.exec("UPDATE meta SET revision=revision+1 WHERE id=1");
      this.db.exec("COMMIT");
      this.db.exec("DELETE FROM widget_instances");
      this.snapshot();
      chmodSync(join(this.root, "state.sqlite"), 0o600);
    } catch (error) {
      this.db?.close();
      this.lock.close();
      if (error instanceof StoreError) throw error;
      throw new StoreError(
        "INVALID_ROOT",
        "无法打开业务数据。请检查目录权限与数据库完整性，原数据未被替换。",
      );
    }
  }
  snapshot(): Snapshot {
    const meta = this.db
      .prepare("SELECT root_id AS rootId, revision FROM meta WHERE id=1")
      .get() as { rootId: string; revision: number };
    if (!meta) throw new StoreError("INVALID_ROOT", "数据根身份缺失。");
    const selected: Snapshot["selected"] = { main: null, panel: null };
    for (const row of this.db
      .prepare("SELECT surface, conversation_id AS id FROM selections")
      .all())
      selected[row.surface as Surface] = row.id as string | null;
    const checks = connectionChecks(this.db);
    return {
      ...meta,
      dataRoot: this.root,
      projects: projectSnapshot(this.db),
      selected,
      conversations: (
        this.db
          .prepare(
            `SELECT c.id, c.title, c.title_revision AS titleRevision, c.organization_revision AS organizationRevision, c.pinned_at AS pinnedAt, c.unread, c.archived_at AS archivedAt, c.deleted_at AS deletedAt, c.retain_until AS retainUntil, c.draft, c.revision, c.updated_at AS updatedAt,
             COALESCE((SELECT substr(replace(content, char(10), ' '), 1, 80) FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, rowid DESC LIMIT 1), '') AS preview,
             (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS messageCount,
             c.connection_id AS connectionId, c.model_id AS modelId, c.effort,
             (SELECT json_extract(connection_snapshot, '$.provider') FROM turns WHERE conversation_id = c.id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS lastProvider,
             (SELECT json_extract(connection_snapshot, '$.connectionId') || '|' || json_extract(connection_snapshot, '$.baseUrl') FROM turns WHERE conversation_id=c.id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS lastDestination,
             c.granted_connections AS grantedConnections,c.granted_providers AS grantedProviders
           FROM conversations c WHERE c.purged_at IS NULL ORDER BY (c.pinned_at IS NOT NULL) DESC,c.pinned_at DESC,c.creation_order DESC`,
          )
          .all() as unknown as (Omit<
          Conversation,
          "grantedProviders" | "grantedConnections"
        > & {
          grantedProviders: string;
          grantedConnections: string;
        })[]
      ).map((row) => ({
        ...row,
        unread: Boolean(row.unread),
        grantedConnections: JSON.parse(row.grantedConnections) as string[],
        grantedProviders: JSON.parse(
          row.grantedProviders,
        ) as Conversation["grantedProviders"],
      })),
      connections: (
        this.db
          .prepare(
            `SELECT ${connectionColumns} FROM connections ORDER BY created_at,id`,
          )
          .all() as unknown as ConnectionRow[]
      ).map((row) => toConnection(row, checks, this.db)),
      settings: this.settings(),
      ...capabilitySnapshot(this.db),
      ...executionSnapshot(
        this.db,
        [selected.main, selected.panel].filter((id): id is string => !!id),
      ),
      ...attachmentSnapshot(
        this.db,
        [selected.main, selected.panel].filter((id): id is string => !!id),
      ),
      ...runtimeSnapshot(this.db),
    };
  }
  private settings(): Snapshot["settings"] {
    const row = this.db
      .prepare(
        "SELECT default_connection_id AS defaultConnectionId, default_model_id AS defaultModelId, telemetry_enabled AS telemetryEnabled, appearance FROM settings WHERE id=1",
      )
      .get() as {
      defaultConnectionId: string | null;
      defaultModelId: string | null;
      telemetryEnabled: number;
      appearance: Snapshot["settings"]["appearance"];
    };
    return {
      codex: codexSettings(this.db),
      claude: claudeSettings(this.db),
      defaultConnectionId: row.defaultConnectionId,
      defaultModelId: row.defaultModelId,
      telemetryEnabled: row.telemetryEnabled === 1,
      appearance: row.appearance,
    };
  }
  execute(
    input: unknown,
    surface: Surface,
    origin: Origin = "renderer",
  ): Reply {
    const host = origin === "host" && validHostCommand(input);
    if (
      (!host && (origin !== "renderer" || !validCommand(input))) ||
      !["main", "panel"].includes(surface)
    )
      return {
        ok: false,
        code: "INVALID_COMMAND",
        message: "操作参数无效，数据未修改。",
      };
    if (
      host &&
      validWidgetHostCommand(input) &&
      "identity" in input &&
      input.identity.surface !== surface
    )
      return {
        ok: false,
        code: "INVALID_COMMAND",
        message: "控件入口不匹配。",
      };
    if (!host && input.type === "snapshot")
      return { ok: true, snapshot: this.snapshot() };
    if (!host && input.type === "readAttachmentPreview") {
      try {
        return {
          ok: true,
          snapshot: this.snapshot(),
          preview: readPreview(this.db, input.attachmentId),
        };
      } catch (error) {
        return error instanceof StoreError
          ? { ok: false, code: error.code, message: error.message }
          : { ok: false, code: "WRITE_FAILED", message: "读取资料预览失败。" };
      }
    }
    if (host && input.type === "exportConversation") {
      try {
        assertConversationAvailable(this.db, input.id);
        const title = String(
          this.db
            .prepare("SELECT title FROM conversations WHERE id=?")
            .get(input.id)!.title,
        );
        const messages = this.db
          .prepare(
            "SELECT role,content FROM messages WHERE conversation_id=? ORDER BY created_at,rowid",
          )
          .all(input.id);
        const markdown =
          "# " +
          title +
          "\n\n" +
          messages
            .map(
              (m) =>
                "## " +
                (m.role === "user" ? "用户" : "助手") +
                "\n\n" +
                String(m.content),
            )
            .join("\n\n") +
          "\n";
        return { ok: true, snapshot: this.snapshot(), markdown };
      } catch (error) {
        return error instanceof StoreError
          ? { ok: false, code: error.code, message: error.message }
          : {
              ok: false,
              code: "WRITE_FAILED",
              message: "读取对话失败，剪贴板未修改。",
            };
      }
    }
    if (
      host &&
      (runtimeReadCommands as readonly string[]).includes(input.type)
    ) {
      try {
        return {
          ok: true,
          snapshot: this.snapshot(),
          ...applyRuntimeHost(this.db, input as RuntimeHostCommand),
        };
      } catch (error) {
        return error instanceof StoreError
          ? { ok: false, code: error.code, message: error.message }
          : {
              ok: false,
              code: "WRITE_FAILED",
              message: "读取 projection 失败。",
            };
      }
    }
    if (host && input.type === "loadTurnContext") {
      try {
        return {
          ok: true,
          snapshot: this.snapshot(),
          ...turnContext(this.db, input.executionId),
          ...this.previousCodexRun(input.executionId),
        };
      } catch (error) {
        return error instanceof StoreError
          ? { ok: false, code: error.code, message: error.message }
          : {
              ok: false,
              code: "WRITE_FAILED",
              message: "读取回合上下文失败。",
            };
      }
    }
    try {
      this.db.exec("BEGIN IMMEDIATE");
      let toolResult: {
        projectId?: string;
        projectUndo?: ProjectUndo;
        toolOperationId?: string;
        toolText?: string;
        widget?: import("../shared/widget-runtime").WidgetReply;
        widgetPreview?: import("../shared/widget-store").WidgetPreview;
        runtimeEvent?: import("../shared/runtime-host").EventOutcome;
      } = {};
      if (
        (host && validProjectHostCommand(input)) ||
        (!host && validProjectCommand(input))
      )
        toolResult = applyProject(this.db, input);
      else if (host && validWidgetHostCommand(input))
        toolResult = applyWidgetHost(this.db, input);
      else if (host && validRuntimeHostCommand(input))
        toolResult = applyRuntimeHost(this.db, input);
      else if (host && validCapabilityHostCommand(input))
        toolResult = applyCapabilityHost(
          this.db,
          this.root,
          input,
          new Date().toISOString(),
        );
      else if (host)
        this.applyHost(
          input as Exclude<
            HostCommand,
            | CapabilityHostCommand
            | WidgetHostCommand
            | RuntimeHostCommand
            | ProjectHostCommand
          >,
        );
      else
        this.mutate(
          input as Exclude<
            Command,
            { type: "snapshot" } | { type: "readAttachmentPreview" }
          >,
          surface,
        );
      settleCapabilities(this.db, new Date().toISOString());
      this.db.exec("UPDATE meta SET revision=revision+1 WHERE id=1; COMMIT");
      return { ok: true, snapshot: this.snapshot(), ...toolResult };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* No active transaction after a failed BEGIN. */
      }
      return error instanceof StoreError
        ? { ok: false, code: error.code, message: error.message }
        : {
            ok: false,
            code: "WRITE_FAILED",
            message: String(input.type).endsWith("Connection")
              ? "连接未保存。请保留当前输入，检查磁盘与数据目录后重试。"
              : String(input.type) === "submitTurn"
                ? "消息未发送，没有开始执行。请保留输入，检查磁盘与数据目录后重试。"
                : "变更未保存。请保留当前输入，检查磁盘与数据目录后重试。",
          };
    }
  }
  private mutate(
    command: Exclude<
      Command,
      { type: "snapshot" } | { type: "readAttachmentPreview" }
    >,
    surface: Surface,
  ) {
    if (validCapabilityCommand(command)) {
      applyCapabilityCommand(this.db, command, new Date().toISOString());
      return;
    }
    if (command.type === "organizeConversation") {
      organizeConversation(this.db, command, new Date().toISOString());
      return;
    }
    const target =
      "conversationId" in command
        ? command.conversationId
        : ["select", "saveDraft", "renameConversation"].includes(
              command.type,
            ) && "id" in command
          ? command.id
          : undefined;
    if (target) assertConversationAvailable(this.db, target);
    if (command.type === "resolvePending" && command.action === "retry") {
      const pending = this.snapshot().pendingItems.find(
        (p) => p.id === command.id,
      );
      if (pending?.conversationId)
        assertConversationAvailable(this.db, pending.conversationId);
    }
    if (
      command.type === "submitTurn" ||
      command.type === "stopExecution" ||
      command.type === "resolvePending"
    ) {
      const isNewSubmission =
        command.type === "submitTurn" &&
        !this.db
          .prepare("SELECT 1 FROM turns WHERE request_id=?")
          .get(command.requestId);
      const projectContext =
        isNewSubmission && command.type === "submitTurn"
          ? captureProjectTurn(
              this.db,
              command.conversationId,
              command.projectContextRevision,
            )
          : null;
      mutateTurn(this.db, this.root, command, new Date().toISOString());
      if (projectContext && command.type === "submitTurn") {
        const turn = this.db
          .prepare("SELECT id FROM turns WHERE request_id=?")
          .get(command.requestId)!;
        this.db
          .prepare("INSERT INTO project_turn_contexts VALUES(?,?,?,?)")
          .run(
            turn.id,
            projectContext.projectId,
            JSON.stringify(projectContext.context),
            projectContext.text,
          );
      }
      if (command.type === "submitTurn" && isNewSubmission) {
        updateAutomaticTitle(this.db, command.conversationId);
        unarchiveOnSubmit(
          this.db,
          command.conversationId,
          new Date().toISOString(),
        );
      }
      return;
    }
    if (command.type === "removeDraftAttachment") {
      removeDraftAttachment(
        this.db,
        this.root,
        command.conversationId,
        command.attachmentId,
      );
      return;
    }
    if (command.type === "grantConnectionScope") {
      const c = this.db
        .prepare("SELECT base_url FROM connections WHERE id=?")
        .get(command.connectionId);
      const conv = this.db
        .prepare("SELECT granted_connections FROM conversations WHERE id=?")
        .get(command.conversationId);
      if (!c || !conv)
        throw new StoreError("NOT_FOUND", "连接或对话已不存在，授权未保存。");
      if (c.base_url !== command.baseUrl)
        throw new StoreError(
          "CONFLICT",
          "提供方地址已变化，请重新核对发送范围。",
        );
      const scopes = new Set(
        JSON.parse(String(conv.granted_connections)) as string[],
      );
      scopes.add(`${command.connectionId}|${String(c.base_url)}`);
      this.db
        .prepare("UPDATE conversations SET granted_connections=? WHERE id=?")
        .run(JSON.stringify([...scopes]), command.conversationId);
      return;
    }
    if (mutateModels(this.db, command)) return;
    if (command.type === "grantProviderScope") {
      const row = this.db
        .prepare(
          "SELECT granted_providers AS granted FROM conversations WHERE id=?",
        )
        .get(command.conversationId) as { granted: string } | undefined;
      if (!row)
        throw new StoreError("NOT_FOUND", "原对话不存在，请重新选择对话。");
      const granted = new Set(JSON.parse(row.granted) as string[]);
      granted.add(command.provider);
      this.db
        .prepare("UPDATE conversations SET granted_providers=? WHERE id=?")
        .run(JSON.stringify([...granted]), command.conversationId);
      return;
    }
    if (command.type === "rebuildSearchIndex") {
      rebuildSearchIndex(this.db);
      return;
    }
    if (command.type === "renameConversation") {
      renameConversation(this.db, command.id, command.title, command.revision);
      return;
    }
    if (command.type === "setClaudeSettings") {
      setClaudeSettings(this.db, command);
      return;
    }
    if (command.type === "setCodexSettings") {
      setCodexSettings(this.db, command);
      return;
    }
    if (command.type === "setAppearance") {
      this.db
        .prepare("UPDATE settings SET appearance=? WHERE id=1")
        .run(command.appearance);
      return;
    }
    if (command.type === "setTelemetry") {
      this.db
        .prepare("UPDATE settings SET telemetry_enabled=? WHERE id=1")
        .run(command.enabled ? 1 : 0);
      return;
    }
    if (command.type === "create") {
      if (
        this.db
          .prepare("SELECT 1 FROM conversations WHERE id=?")
          .get(command.id)
      )
        assertConversationAvailable(this.db, command.id);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO conversations (id,title,updated_at) VALUES (?,'新对话',?)",
        )
        .run(command.id, new Date().toISOString());
      this.db
        .prepare("UPDATE selections SET conversation_id=? WHERE surface=?")
        .run(command.id, surface);
      return;
    }
    if (command.type !== "select" && command.type !== "saveDraft")
      throw new StoreError("INVALID_COMMAND", "未知业务命令。");
    const row = this.db
      .prepare("SELECT revision,draft FROM conversations WHERE id=?")
      .get(command.id);
    if (!row)
      throw new StoreError("NOT_FOUND", "原对话不存在，请重新选择对话。");
    if (command.type === "select") {
      readConversation(this.db, command.id, new Date().toISOString());
      this.db
        .prepare("UPDATE selections SET conversation_id=? WHERE surface=?")
        .run(command.id, surface);
      return;
    }
    if (row.revision !== command.revision) {
      // A lost acknowledgement can safely confirm an identical already-committed value.
      if (row.draft === command.text) return;
      throw new StoreError(
        "CONFLICT",
        "另一入口已更新草稿。当前输入已保留，请核对后决定采用哪个版本。",
      );
    }
    this.db
      .prepare(
        "UPDATE conversations SET draft=?,revision=revision+1,updated_at=? WHERE id=?",
      )
      .run(command.text, new Date().toISOString(), command.id);
  }
  private previousCodexRun(executionId: string) {
    const row = this.db
      .prepare(
        "SELECT r.run_json FROM codex_runs r JOIN executions e ON e.id=r.execution_id WHERE e.turn_id=(SELECT turn_id FROM executions WHERE id=?) AND e.id<>? ORDER BY e.attempt DESC LIMIT 1",
      )
      .get(executionId, executionId);
    const claude = this.db
      .prepare(
        "SELECT r.run_json FROM claude_runs r JOIN executions e ON e.id=r.execution_id WHERE e.turn_id=(SELECT turn_id FROM executions WHERE id=?) AND e.id<>? ORDER BY e.attempt DESC LIMIT 1",
      )
      .get(executionId, executionId);
    return {
      ...(row ? { codexRun: JSON.parse(String(row.run_json)) } : {}),
      ...(claude ? { claudeRun: JSON.parse(String(claude.run_json)) } : {}),
    };
  }
  private applyHost(
    command: Exclude<
      HostCommand,
      | CapabilityHostCommand
      | WidgetHostCommand
      | RuntimeHostCommand
      | ProjectHostCommand
    >,
  ) {
    const now = new Date().toISOString();
    if (command.type === "exportConversation") return;
    if (command.type === "configureClaude") {
      configureClaude(
        this.db,
        command.model,
        command.configuration,
        command.effort ?? null,
      );
      return;
    }
    if (command.type === "configureCodex") {
      configureCodex(
        this.db,
        command.model,
        command.configuration,
        command.effort ?? null,
      );
      return;
    }
    if (command.type === "recordEffort") {
      recordEffort(this.db, command.provider, command.efforts);
      return;
    }
    if (command.type === "importAttachment")
      assertConversationAvailable(this.db, command.conversationId);
    if (command.type === "importAttachment")
      importAttachment(this.db, this.root, command, now);
    else if (command.type === "reportExtraction")
      applyExtraction(this.db, command);
    else applyHostCommand(this.db, command, now);
  }
  tickCapabilities(): Snapshot | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = settleCapabilities(this.db, new Date().toISOString());
      if (changed)
        this.db.exec("UPDATE meta SET revision=revision+1 WHERE id=1");
      this.db.exec("COMMIT");
      return changed ? this.snapshot() : undefined;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Text attachments still waiting for the extraction worker. */
  pendingExtractions() {
    return pendingExtractions(this.db);
  }
  close() {
    this.db.close();
    this.lock.exec("COMMIT");
    this.lock.close();
  }
}
