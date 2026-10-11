import {
  validWidgetGenerationCommand,
  validWidgetGenerationHostCommand,
  type WidgetGenerationCommand,
  type WidgetGenerationHostCommand,
  type WidgetGenerationSnapshot,
  type GenerationContext,
  type GenerationTask,
  type WidgetStopEvidence,
} from "./widget-generation";
import type { BuiltWidget } from "./widget";
import type {
  ProjectEvidenceRequest,
  ProjectEvidenceReply,
} from "./project-evidence";
import type {
  ProjectActionRequest,
  ProjectActionReply,
} from "./project-actions";
import type { ProjectRequest, ProjectWorkReply } from "./project-work";
import type {
  ProjectAccessReply,
  ProjectAccessRequest,
} from "./project-access";
import {
  validRuntimeHostCommand,
  type EventOutcome,
  type RuntimeControl,
  type RuntimeCopyTarget,
  type RuntimeHostCommand,
  type RuntimeImportReply,
  type RuntimeInstallation,
  type RuntimeContextSnapshot,
  type RuntimeDecision,
  type RuntimeGrant,
  type RuntimeInstance,
  type RuntimeOperation,
  type RuntimeProjection,
  type RuntimeResource,
  type RuntimeScope,
} from "./runtime-host";
import type {
  HostExecutionRecord,
  RuntimeRoleBinding,
} from "./runtime-execution";
import type { WidgetControl, WidgetSignal, WidgetUIReply } from "./widget-ui";
import {
  validWidgetHostCommand,
  type WidgetHostCommand,
  type WidgetPreview,
} from "./widget-store";
import type { WidgetReply } from "./widget-runtime";
import {
  validClaudePath,
  validClaudeModel,
  validClaudeRun,
  validClaudeConnection,
  type ClaudeRun,
  type ClaudeConnection,
  type ClaudeSetupReply,
  type ClaudeSettings,
  type ClaudeStatus,
} from "./claude";
import {
  validCodexConnection,
  validCodexPath,
  type CodexSettings,
  validCodexRun,
  type CodexRun,
  type CodexConnection,
  type CodexSetupReply,
} from "./codex";
import type { CodexStatus } from "./codex";
import {
  validCapabilityCommand,
  validCapabilityHostCommand,
  type CapabilityCommand,
  type CapabilityHostCommand,
  type Permission,
  type ToolOperation,
} from "./capabilities";
import type { SearchReply, SearchRequest } from "./search";
import {
  validProjectCommand,
  validProjectHostCommand,
  type Project,
  type ProjectCommand,
  type ProjectHostCommand,
  type ProjectUndo,
  type ProjectCreateInput,
  type ProjectFolderReply,
} from "./projects";
export type Surface = "main" | "panel";
/** Where the shown title comes from: the person's own name, the first user message, or the default name. */
export type TitleSource = "manual" | "first-message" | "default";
export const titleSourceLabels: Record<TitleSource, string> = {
  manual: "用户命名",
  "first-message": "取自首条消息",
  default: "默认名称",
};
export interface Conversation {
  id: string;
  title: string;
  titleSource: TitleSource;
  /** Creation time; null for conversations created before it was recorded (never inferred from activity). */
  createdAt: string | null;
  /** Position in creation order (larger is newer); set for every row, including old ones. */
  creationOrder: number;
  /**
   * Not yet used: no messages, no draft text, no draft attachments, no project, no own name, not pinned and not
   * archived. It is the new-conversation page and not listed; starting a new conversation reuses it.
   */
  unused: boolean;
  titleRevision: number;
  organizationRevision: number;
  pinnedAt: string | null;
  unread: boolean;
  archivedAt: string | null;
  deletedAt: string | null;
  retainUntil: string | null;
  draft: string;
  revision: number;
  updatedAt: string;
  /** Last saved message, shortened for the list; empty when there is none. */
  preview: string;
  messageCount: number;
  /** Explicit connection for this conversation; null means the default connection. */
  connectionId: string | null;
  modelId: string | null;
  /** Chosen reasoning effort level for this conversation; null follows the model's recorded default. */
  effort: string | null;
  /** Provider of the most recent submitted turn, including unfinished history. */
  lastProvider: Provider | null;
  lastDestination: string | null;
  grantedConnections: string[];
  /** Providers the user has confirmed may receive this conversation's history. */
  grantedProviders: Provider[];
}
/** An object in the mixed pinned section. */
export interface PinnedRef {
  kind: "conversation" | "project";
  id: string;
}
export const conversationActions = [
  "pin",
  "unpin",
  "unread",
  "read",
  "archive",
  "unarchive",
  "delete",
  "restore",
  "extend",
  "purge",
] as const;
export type ConversationAction = (typeof conversationActions)[number];
export type Provider =
  | "zhipu"
  | "deepseek"
  | "openrouter"
  | "siliconflow"
  | "custom"
  | "codex"
  | "claude";
export const providers: Provider[] = [
  "zhipu",
  "deepseek",
  "openrouter",
  "siliconflow",
  "custom",
];
// Preset addresses only prefill a new connection; saved addresses are never overwritten.
export const presets: Record<
  Provider,
  { label: string; baseUrl: string; scope: string }
> = {
  claude: {
    label: "Claude Code",
    baseUrl: "",
    scope: "使用本机 Claude Code 的认证与模型配置。",
  },
  codex: {
    label: "Codex",
    baseUrl: "",
    scope: "使用本机 Codex 的认证与模型配置。",
  },
  zhipu: {
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
    scope: "智谱通用 API；编码套餐使用独立入口，本预设不覆盖套餐。",
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    scope: "DeepSeek OpenAI 兼容接口。",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    scope: "指定模型，不配置备用模型路由。",
  },
  siliconflow: {
    label: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    scope: "中国区地址；其他区域需自行填写。",
  },
  custom: {
    label: "自定义",
    baseUrl: "",
    scope: "任何 Chat Completions 兼容服务；地址由你填写。",
  },
};
/** Result of the last explicit model list fetch; "unknown" until one has run. */
export type ModelList =
  | { state: "unknown" }
  | { state: "fetched"; models: string[]; fetchedAt: string }
  | { state: "failed"; error: string; failedAt: string };
/** Latest host execution of a given kind for a connection, derived from executions. */
export interface ConnectionCheck {
  executionId: string;
  state: ExecutionState;
  errorClass: ErrorClass | null;
  errorMessage: string | null;
  createdAt: string;
  endedAt: string | null;
}
/**
 * Capability evidence belongs to one connection/model. Unknown permits a user's
 * image request without claiming support; only explicit refusal blocks it.
 * "declared" is retained for old data, not a new user-facing capability control.
 */
export type ImageInput = "unknown" | "declared" | "verified" | "unsupported";
export const imageInputs: ImageInput[] = [
  "unknown",
  "declared",
  "verified",
  "unsupported",
];
export const imageInputLabels: Record<ImageInput, string> = {
  unknown: "未检测，可直接发送图片",
  declared: "未检测（历史配置），可直接发送图片",
  verified: "支持（已实测）",
  unsupported: "不支持",
};
export function acceptsImages(imageInput: ImageInput) {
  return imageInput !== "unsupported";
}
/** Conservative default budget for history plus material when the user has not filled one in. */
export const defaultContextChars = 200_000;
export const contextCharsMin = 1000;
export const contextCharsMax = 10_000_000;
/**
 * Reasoning effort levels read back from the actual installation for one connection/model.
 * null means unrecorded: the parameter was absent this time, nothing is inferred from
 * versions or other models, and sessions run at the executor's own default.
 */
export interface EffortRecord {
  levels: string[];
  /** One of levels, or null when the installation does not state a default. */
  defaultLevel: string | null;
  source: "claude-initialize" | "codex-model-list";
  recordedAt: string;
}
export const effortLevelLimit = 16;
export const effortSources: EffortRecord["source"][] = [
  "claude-initialize",
  "codex-model-list",
];
export function validEffortLevel(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}
/** Same levels, default and source; the read-back time alone does not make a different record. */
export function sameEffort(
  a: EffortRecord | null,
  b: EffortRecord | null,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.source === b.source &&
    a.defaultLevel === b.defaultLevel &&
    a.levels.length === b.levels.length &&
    a.levels.every((level, i) => level === b.levels[i])
  );
}
export function validEffort(value: unknown): value is EffortRecord | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    Object.keys(r).sort().join(",") ===
      "defaultLevel,levels,recordedAt,source" &&
    Array.isArray(r.levels) &&
    r.levels.length > 0 &&
    r.levels.length <= effortLevelLimit &&
    r.levels.every(validEffortLevel) &&
    new Set(r.levels).size === r.levels.length &&
    (r.defaultLevel === null ||
      (typeof r.defaultLevel === "string" &&
        r.levels.includes(r.defaultLevel))) &&
    effortSources.includes(r.source as EffortRecord["source"]) &&
    typeof r.recordedAt === "string" &&
    !Number.isNaN(Date.parse(r.recordedAt))
  );
}
export interface ConnectionModel {
  codex?: CodexConnection;
  claude?: ClaudeConnection;
  lastTest: ConnectionCheck | null;
  lastProbe: ConnectionCheck | null;
  model: string;
  enabled: boolean;
  imageInput: ImageInput;
  imageInputCheckedAt: string | null;
  contextChars: number | null;
  effort: EffortRecord | null;
}
export interface Connection {
  codex?: CodexConnection;
  claude?: ClaudeConnection;
  id: string;
  name: string;
  provider: Provider;
  baseUrl: string;
  model: string;
  enabled: boolean;
  models: ConnectionModel[];
  /** Random reference into the vault; never the secret itself. */
  secretRef: string | null;
  modelList: ModelList;
  lastTest: ConnectionCheck | null;
  lastModelList: ConnectionCheck | null;
  lastImageProbe: ConnectionCheck | null;
  imageInput: ImageInput;
  imageInputCheckedAt: string | null;
  /** Hand-filled context budget in characters; null means the conservative default. */
  contextChars: number | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export type Appearance = "light" | "dark" | "auto";
/**
 * Local interface preferences of the main window, saved with the appearance in the business settings:
 * whether the person folded the sidebar and the width they gave the right column (null is the default).
 * Whether the right column is open is not a preference; it starts folded.
 */
export interface InterfacePreferences {
  sidebarCollapsed: boolean;
  rightPanelWidth: number | null;
  /** How the pinned section orders its rows: pin time (newest first), last update, or the manual order. */
  pinnedSort: PinnedSort;
  /** Sidebar project rows only; independent of the project list page and manual positions. */
  projectSort: ProjectSort;
  /** Folded section headers of the sidebar: only the header row stays. */
  pinnedFolded: boolean;
  projectsFolded: boolean;
  recentFolded: boolean;
}
export const pinnedSorts = ["pinned", "updated", "manual"] as const;
export type PinnedSort = (typeof pinnedSorts)[number];
export const projectSorts = ["updated", "name", "manual"] as const;
export type ProjectSort = (typeof projectSorts)[number];
export const defaultInterfacePreferences: InterfacePreferences = {
  sidebarCollapsed: false,
  rightPanelWidth: null,
  pinnedSort: "pinned",
  projectSort: "updated",
  pinnedFolded: false,
  projectsFolded: false,
  recentFolded: false,
};
const interfacePreferenceKeys = Object.keys(
  defaultInterfacePreferences,
) as (keyof InterfacePreferences)[];
export const rightPanelWidthRange = { min: 320, max: 2000 } as const;
/** One preference key with a value of the right type and range. */
export function validInterfacePreference(key: unknown, value: unknown) {
  if (
    key === "sidebarCollapsed" ||
    key === "pinnedFolded" ||
    key === "projectsFolded" ||
    key === "recentFolded"
  )
    return typeof value === "boolean";
  if (key === "pinnedSort") return pinnedSorts.includes(value as PinnedSort);
  if (key === "projectSort") return projectSorts.includes(value as ProjectSort);
  if (key === "rightPanelWidth")
    return (
      value === null ||
      (Number.isInteger(value) &&
        (value as number) >= rightPanelWidthRange.min &&
        (value as number) <= rightPanelWidthRange.max)
    );
  return false;
}
/**
 * Reads stored preferences key by key: a key that is missing or not valid takes its default, so one damaged
 * value never changes the other key; keys this version does not know are ignored.
 */
export function readInterfacePreferences(value: unknown): InterfacePreferences {
  const stored =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const result = { ...defaultInterfacePreferences };
  for (const key of Object.keys(result) as (keyof InterfacePreferences)[])
    if (validInterfacePreference(key, stored[key]))
      (result as Record<string, unknown>)[key] = stored[key];
  return result;
}
/** Exactly the known keys with valid values: the form the shell caches and hands to a new window. */
export function validInterfacePreferences(
  value: unknown,
): value is InterfacePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") ===
      [...interfacePreferenceKeys].sort().join(",") &&
    interfacePreferenceKeys.every((key) =>
      validInterfacePreference(key, record[key]),
    )
  );
}
export interface Settings {
  widgetGenerationMinutes: number;
  codex: CodexSettings;
  claude: ClaudeSettings;
  appearance: Appearance;
  interface: InterfacePreferences;
  defaultModelId: string | null;
  defaultConnectionId: string | null;
  telemetryEnabled: boolean;
}
/** Execution states shared by turns and host executions; the last four are terminal. */
export type ExecutionState =
  | "queued"
  | "running"
  | "awaiting_authorization"
  | "stopping"
  | "completed"
  | "stopped"
  | "failed"
  | "interrupted";
export const terminalStates: ExecutionState[] = [
  "completed",
  "stopped",
  "failed",
  "interrupted",
];
export const stateLabels: Record<ExecutionState, string> = {
  queued: "等待执行",
  running: "生成中",
  awaiting_authorization: "等待授权",
  stopping: "停止中",
  completed: "已完成",
  stopped: "已停止",
  failed: "失败",
  interrupted: "已中断",
};
export type ErrorClass =
  | "permission"
  | "auth"
  | "address"
  | "protocol"
  | "network"
  | "model"
  | "rate_limit"
  | "provider"
  | "stream"
  | "stop_timeout"
  | "unsupported"
  | "context"
  | "budget";
export const errorClasses: ErrorClass[] = [
  "permission",
  "auth",
  "address",
  "protocol",
  "network",
  "model",
  "rate_limit",
  "provider",
  "stream",
  "stop_timeout",
  "unsupported",
  "context",
  "budget",
];
/** Non-secret copy of the connection fixed when a turn is submitted. */
export interface ConnectionSnapshot {
  codex?: CodexConnection;
  claude?: ClaudeConnection;
  connectionId: string;
  name: string;
  provider: Provider;
  baseUrl: string;
  model: string;
  revision: number;
  /** Level passed to the executor for this turn; null means no parameter, the executor's own default. */
  effort: string | null;
}
export interface Message {
  id: string;
  conversationId: string;
  turnId: string | null;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
export interface Turn {
  materialMode: "inline" | "tools";
  id: string;
  conversationId: string;
  requestId: string;
  connection: ConnectionSnapshot;
  state: ExecutionState;
  partialText: string;
  errorClass: ErrorClass | null;
  errorMessage: string | null;
  /** Latest execution attempt for this turn; stop targets it. */
  executionId: string;
  attempt: number;
  /** History images left out because the connection has not confirmed image input. */
  omittedImages: number;
  createdAt: string;
  endedAt: string | null;
}
/** stop_unconfirmed is a Host fact, not a decision: its only action is a recheck (RUNTIME-04, LOG-02). */
export type PendingKind =
  "interrupted_turn" | "failed_turn" | "stop_unconfirmed";
export interface PendingItem {
  id: string;
  executionId: string;
  turnId: string | null;
  conversationId: string | null;
  /** The physical execution behind an agent execution's item (feature-t30), else null. */
  executionRef: string | null;
  kind: PendingKind;
  state: "open" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
}
export type EventKind =
  | "native_session"
  | "capability_changed"
  | "conversation_changed"
  | "data_migrated"
  | "submitted"
  | "started"
  | "stop_requested"
  | "stopped"
  | "completed"
  | "failed"
  | "interrupted"
  | "late_result"
  | "stop_timeout"
  | "retried"
  | "pending_resolved"
  | "stop_unconfirmed"
  | "stop_confirmed"
  | "approval_accepted"
  | "approval_rejected";
export const eventLabels: Record<EventKind, string> = {
  native_session: "本地会话关联",
  capability_changed: "资料读取与授权",
  conversation_changed: "对话已整理",
  data_migrated: "模型数据已迁移",
  submitted: "已提交",
  started: "开始执行",
  stop_requested: "请求停止",
  stopped: "已停止",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  late_result: "迟到结果",
  stop_timeout: "停止超时",
  retried: "重试",
  pending_resolved: "待处理已处理",
  stop_unconfirmed: "停止未确认",
  stop_confirmed: "停止已确认",
  approval_accepted: "批准已放行",
  approval_rejected: "批准已拒绝",
};
export const errorClassLabels: Record<ErrorClass, string> = {
  permission: "权限未满足",
  auth: "认证失败",
  address: "地址错误",
  protocol: "协议不兼容",
  network: "网络错误",
  model: "模型不可用",
  rate_limit: "限流或额度不足",
  provider: "提供方拒绝",
  stream: "输出中断",
  stop_timeout: "停止超时",
  unsupported: "能力不支持",
  context: "超出模型上下文或请求限制",
  budget: "预算超限",
};
export interface RunEvent {
  seq: number;
  id: string;
  executionId: string;
  kind: EventKind;
  at: string;
  connection: ConnectionSnapshot | null;
  payload: Record<string, unknown>;
}
/** File kinds accepted as material; anything else is recorded as unreadable, never guessed. */
export type AttachmentKind = "text" | "markdown" | "pdf" | "png" | "jpeg";
export const attachmentKinds: AttachmentKind[] = [
  "text",
  "markdown",
  "pdf",
  "png",
  "jpeg",
];
export const attachmentKindLabels: Record<AttachmentKind, string> = {
  text: "文本",
  markdown: "Markdown",
  pdf: "PDF",
  png: "PNG",
  jpeg: "JPEG",
};
export type AttachmentStatus = "importing" | "ready" | "unreadable";
/** Why a selected file cannot be used; each code has one user-facing explanation. */
export type AttachmentReason =
  | "unsupported_format"
  | "too_large"
  | "encrypted"
  | "damaged"
  | "no_text"
  | "decode_failed"
  | "text_too_long"
  | "extraction_timeout"
  | "image_invalid"
  | "image_too_large"
  | "copy_missing";
export const attachmentReasons: AttachmentReason[] = [
  "unsupported_format",
  "too_large",
  "encrypted",
  "damaged",
  "no_text",
  "decode_failed",
  "text_too_long",
  "extraction_timeout",
  "image_invalid",
  "image_too_large",
  "copy_missing",
];
export const attachmentReasonLabels: Record<AttachmentReason, string> = {
  unsupported_format:
    "未支持的格式。仅支持文本、Markdown、含文本的 PDF、PNG 与 JPEG。",
  too_large: "文件超过 20 MB 上限，未保存副本。",
  encrypted: "PDF 已加密，无法提取正文。",
  damaged: "文件已损坏或不是有效的 PDF。",
  no_text: "PDF 没有可提取的文本，可能是扫描件；当前不支持 OCR。",
  decode_failed: "文件不是有效的 UTF-8 文本。",
  text_too_long: "正文超过提取上限（2 MiB 字符）。",
  extraction_timeout: "提取超时（30 秒），已停止。",
  image_invalid: "图片无法识别，文件头与格式不符。",
  image_too_large: "图片任一边超过 8192 像素。",
  copy_missing: "副本缺失，请移除后重新选择文件。",
};
/** Product limits from D-02; provider limits are checked separately. */
export const attachmentSizeLimit = 20 * 1024 * 1024;
export const attachmentsPerTurn = 5;
export const attachmentTextLimit = 2 * 1024 * 1024;
export const imageSideLimit = 8192;
export interface Attachment {
  id: string;
  /** SHA-256 of the saved copy; the copy is the version that was or will be sent. */
  sha256: string;
  name: string;
  kind: AttachmentKind;
  size: number;
  status: AttachmentStatus;
  reason: AttachmentReason | null;
  chars: number | null;
  pages: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
}
/** A selected but not yet sent attachment of a conversation's composer. */
export interface DraftAttachment {
  conversationId: string;
  attachmentId: string;
  position: number;
}
/** The fixed version a submitted user message carries. */
export interface MessageAttachment {
  messageId: string;
  attachmentId: string;
  position: number;
}
export interface Snapshot {
  widgetGeneration?: WidgetGenerationSnapshot;
  projects: Project[];
  permissions: Permission[];
  toolOperations: ToolOperation[];
  revision: number;
  rootId: string;
  dataRoot: string;
  conversations: Conversation[];
  /** Manual order of the pinned section, first to last; pinned objects missing here come first. */
  pinnedOrder: PinnedRef[];
  connections: Connection[];
  settings: Settings;
  selected: Record<Surface, string | null>;
  /** Messages and turns of the conversations currently selected on either surface. */
  messages: Message[];
  turns: Turn[];
  /** Attachments referenced by the selected conversations' drafts and messages. */
  attachments: Attachment[];
  draftAttachments: DraftAttachment[];
  messageAttachments: MessageAttachment[];
  /** Every turn not yet in a terminal state, across all conversations. */
  activeTurns: Turn[];
  /** Open pending items, newest first. */
  pendingItems: PendingItem[];
  /** Resolved Host items are read from persistent storage; the active count remains pendingItems. */
  resolvedPendingItems?: PendingItem[];
  /** Most recent run events, newest first, bounded. */
  events: RunEvent[];
  /** Runtime Host installations and their primary instances (feature-t29). */
  runtimeInstallations: RuntimeInstallation[];
  runtimeInstances: RuntimeInstance[];
  runtimeResources: RuntimeResource[];
  runtimeScopes: RuntimeScope[];
  runtimeGrants: RuntimeGrant[];
  /** Newest first, bounded per instance. */
  runtimeOperations: RuntimeOperation[];
  /** Newest first, bounded per instance; the store keeps every record. */
  runtimeDecisions: RuntimeDecision[];
  runtimeContextSnapshots: RuntimeContextSnapshot[];
  /** Physical Agent executions, newest first, bounded per instance (feature-t30). */
  runtimeExecutions: HostExecutionRecord[];
}
export interface ConnectionInput {
  id: string;
  name: string;
  provider: Provider;
  baseUrl: string;
  model: string;
  secretRef: string | null;
  imageInput: ImageInput;
  contextChars: number | null;
  revision: number;
  clearDefault?: boolean;
}
export type Command =
  | WidgetGenerationCommand
  | ProjectCommand
  | CapabilityCommand
  | {
      type: "setCodexSettings" | "setClaudeSettings";
      enabled: boolean;
      path: string | null;
      revision: number;
    }
  | { type: "setAppearance"; appearance: Appearance }
  | {
      type: "setInterfacePreference";
      key: "sidebarCollapsed";
      value: boolean;
    }
  | {
      type: "setInterfacePreference";
      key: "rightPanelWidth";
      value: number | null;
    }
  | {
      type: "setInterfacePreference";
      key: "pinnedFolded" | "projectsFolded" | "recentFolded";
      value: boolean;
    }
  | {
      type: "setInterfacePreference";
      key: "pinnedSort";
      value: PinnedSort;
    }
  | {
      type: "setInterfacePreference";
      key: "projectSort";
      value: ProjectSort;
    }
  | {
      /** Moves a pinned object before another one (null: to the end) in the manual order. */
      type: "movePinned";
      kind: PinnedRef["kind"];
      id: string;
      before: PinnedRef | null;
      /** The moved object's organization revision. */
      revision: number;
    }
  | { type: "newConversation"; id: string }
  | {
      type: "organizeConversation";
      id: string;
      action: ConversationAction;
      revision: number;
      confirmed: boolean;
    }
  | {
      type: "grantConnectionScope";
      conversationId: string;
      connectionId: string;
      baseUrl: string;
    }
  | {
      type: "setConnectionEnabled";
      id: string;
      enabled: boolean;
      revision: number;
      clearDefault: boolean;
    }
  | {
      type: "upsertModel";
      id: string;
      model: string;
      enabled: boolean;
      imageInput: ImageInput;
      contextChars: number | null;
      revision: number;
    }
  | { type: "deleteModel"; id: string; model: string; revision: number }
  | { type: "rebuildSearchIndex" }
  | { type: "snapshot" }
  | { type: "create"; id: string }
  | { type: "select"; id: string }
  | { type: "renameConversation"; id: string; title: string; revision: number }
  | { type: "saveDraft"; id: string; text: string; revision: number }
  | ({ type: "upsertConnection" } & ConnectionInput)
  | { type: "deleteConnection"; id: string }
  | { type: "setDefaultConnection"; id: string | null; model?: string }
  | {
      type: "submitTurn";
      projectContextRevision?: number;
      materialMode?: "inline" | "tools";
      requestId: string;
      conversationId: string;
      connectionId: string;
      model?: string;
      text: string;
    }
  | { type: "stopExecution"; executionId: string }
  | { type: "resolvePending"; id: string; action: "dismiss" | "retry" }
  | { type: "setTelemetry"; enabled: boolean }
  | {
      type: "chooseConnection";
      conversationId: string;
      connectionId: string | null;
      model?: string;
    }
  | { type: "chooseEffort"; conversationId: string; effort: string | null }
  | { type: "grantProviderScope"; conversationId: string; provider: Provider }
  | {
      type: "removeDraftAttachment";
      conversationId: string;
      attachmentId: string;
    }
  /** Read-only: the first characters of an attachment's extracted text for the preview panel. */
  | { type: "readAttachmentPreview"; attachmentId: string };
export const attachmentPreviewLimit = 4000;
export interface AttachmentPreview {
  attachmentId: string;
  text: string;
  chars: number;
}
/** What the extraction worker reports back; the business service turns it into a row update. */
export type ExtractionOutcome =
  | { ok: true; text: string; pages: number | null }
  | { ok: false; reason: AttachmentReason };
export type CheckKind = "connection_test" | "model_list" | "image_probe";
export const checkKinds: CheckKind[] = [
  "connection_test",
  "model_list",
  "image_probe",
];
/** Material of one saved user message as handed to the host for a request. */
export interface TurnAttachment {
  deferred?: boolean;
  messageId: string;
  id: string;
  name: string;
  kind: AttachmentKind;
  sha256: string;
  /** Extracted text for text kinds; null for images. */
  text: string | null;
  /** Repository-root relative copy location for images; null for text kinds. */
  copy: string | null;
  /** False for a history image the current connection may not receive. */
  send: boolean;
}
/** Adapter reports from the host process; never accepted from a renderer. */
export type HostCommand =
  | WidgetGenerationHostCommand
  | ProjectHostCommand
  | WidgetHostCommand
  | CapabilityHostCommand
  | RuntimeHostCommand
  | { type: "recordClaudeRun"; executionId: string; run: ClaudeRun }
  | {
      type: "configureClaude";
      model: string;
      configuration: ClaudeConnection;
      effort?: EffortRecord | null;
    }
  | { type: "recordCodexRun"; executionId: string; run: CodexRun }
  | {
      type: "configureCodex";
      model: string;
      configuration: CodexConnection;
      effort?: EffortRecord | null;
    }
  /** Effort records read back by the latest successful detection; absent confirmed models become unrecorded. */
  | {
      type: "recordEffort";
      provider: "codex" | "claude";
      efforts: Record<string, EffortRecord | null>;
    }
  | { type: "exportConversation"; id: string }
  | {
      type: "createExecution";
      executionId: string;
      kind: CheckKind;
      connectionId: string;
      model?: string;
    }
  /** A file the user picked in the host's dialog; the exact path is opened once, read-only. */
  | {
      type: "importAttachment";
      conversationId: string;
      attachmentId: string;
      path: string;
      name: string;
    }
  /** Result of the restricted extraction worker for one attachment copy. */
  | {
      type: "reportExtraction";
      attachmentId: string;
      outcome: ExtractionOutcome;
    }
  | {
      type: "reportModels";
      executionId: string;
      seq: number;
      models: string[];
    }
  | { type: "beginExecution"; executionId: string }
  /** Read-only: messages of the turn's conversation up to its own user message. */
  | { type: "loadTurnContext"; executionId: string }
  | { type: "reportStopTimeout"; executionId: string }
  /** The provider rejected image content for this execution's connection. */
  | { type: "reportImageUnsupported"; executionId: string }
  /** The host gave up waiting for an execution (for example at quit); it becomes interrupted. */
  | { type: "reportInterrupted"; executionId: string }
  | { type: "reportDelta"; executionId: string; seq: number; text: string }
  | { type: "reportFinished"; executionId: string; seq: number }
  | {
      type: "reportFailed";
      executionId: string;
      seq: number;
      errorClass: ErrorClass;
      message: string;
    }
  | { type: "reportStopped"; executionId: string; seq: number };
export type FailureCode =
  | "INVALID_COMMAND"
  | "CONFLICT"
  | "NOT_FOUND"
  | "WRITE_FAILED"
  | "UNAVAILABLE"
  | "ROOT_LOCKED"
  | "INVALID_ROOT";
export type Reply =
  | {
      ok: true;
      snapshot: Snapshot;
      generationContext?: GenerationContext;
      generationTask?: GenerationTask;
      generatedBuild?: BuiltWidget;
      generationStopEvidence?: WidgetStopEvidence;
      widget?: WidgetReply;
      widgetPreview?: WidgetPreview;
      messages?: Message[];
      attachments?: TurnAttachment[];
      codexRun?: CodexRun;
      claudeRun?: ClaudeRun;
      preview?: AttachmentPreview;
      markdown?: string;
      toolOperationId?: string;
      toolText?: string;
      projectContext?: string | null;
      projectId?: string;
      projectUndo?: ProjectUndo;
      /** Outcome of one applied projection event (runtimeEventApply). */
      runtimeEvent?: EventOutcome;
      /** Current projection of one scope (runtimeProjectionRead). */
      runtimeProjection?: RuntimeProjection;
      /** Authoritative lookup results (runtimeOperationRead, runtimeDecisionRead): null proves absence. */
      runtimeOperation?: RuntimeOperation | null;
      runtimeDecision?: RuntimeDecision | null;
      /** Operations matching a runtimeOperationList query, newest first, unbounded. */
      runtimeOperationList?: RuntimeOperation[];
      /** Physical execution lookups (feature-t30): null proves absence. */
      runtimeExecution?: HostExecutionRecord | null;
      runtimeExecutionList?: HostExecutionRecord[];
      runtimeRoleBinding?: RuntimeRoleBinding | null;
    }
  | { ok: false; code: FailureCode; message: string };
export type SecretFailure =
  | "ENCRYPTION_UNAVAILABLE"
  | "VAULT_UNREADABLE"
  | "VAULT_WRITE_FAILED"
  | "INVALID_SECRET"
  | "UNAVAILABLE";
export type SecretReply =
  | { ok: true; secretRef: string }
  | { ok: false; code: SecretFailure; message: string };
export interface Status {
  connected: boolean;
  message: string;
}
export interface DesktopBridge {
  projectEvidence: (
    input: ProjectEvidenceRequest,
  ) => Promise<ProjectEvidenceReply>;
  projectAction: (request: ProjectActionRequest) => Promise<ProjectActionReply>;
  projectWork: (request: ProjectRequest) => Promise<ProjectWorkReply>;
  /** Project repository governance access: register the folder, open the scope, authorize after review. */
  projectAccess: (request: ProjectAccessRequest) => Promise<ProjectAccessReply>;
  pickProjectFolder: () => Promise<ProjectFolderReply>;
  retryProjectFolder: () => Promise<ProjectFolderReply>;
  cancelProjectFolder: () => Promise<{ ok: true }>;
  createProject: (input: ProjectCreateInput) => Promise<Reply>;
  widgetEnabled: boolean;
  widgetControl: (command: WidgetControl) => Promise<WidgetUIReply>;
  widgetOcclude: (slot?: string) => void;
  onWidgetLayout: (
    callback: (signal: import("./widget-ui").WidgetLayoutSignal) => void,
  ) => () => void;
  onWidgetDisplayInput: (
    callback: (
      signal: { generation: string } & (
        | { kind: "hover" | "focus"; value: boolean }
        | { kind: "scroll"; x: number; y: number }
      ),
    ) => void,
  ) => () => void;
  onWidgetStatus: (callback: (signal: WidgetSignal) => void) => () => void;
  onWidgetVisibility: (callback: (visible: boolean) => void) => () => void;
  onWidgetRestore: (callback: () => void) => () => void;
  onWidgetSearch: (callback: () => void) => () => void;
  detectCodex: () => Promise<CodexStatus>;
  detectClaude: () => Promise<ClaudeStatus>;
  prepareClaude: (model?: string) => Promise<ClaudeSetupReply>;
  acceptClaude: (token: string) => Promise<Reply>;
  prepareCodex: (model?: string) => Promise<CodexSetupReply>;
  acceptCodex: (token: string) => Promise<Reply>;
  surface: Surface;
  /** The saved appearance known when the window was created, before the first snapshot; absent when unknown. */
  appearance?: Appearance;
  /** The saved interface preferences known when the window was created, before the first snapshot; absent when unknown. */
  interface?: InterfacePreferences;
  copyConversation: (
    id: string,
    kind: "link" | "markdown",
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  search: (request: SearchRequest) => Promise<SearchReply>;
  cancelSearch: () => Promise<void>;
  command: (command: Command) => Promise<Reply>;
  subscribe: (callback: (snapshot: Snapshot) => void) => () => void;
  onStatus: (callback: (status: Status) => void) => () => void;
  reportDirty: (dirty: boolean) => void;
  openMain: (conversationId?: string) => Promise<void>;
  reconnect: () => Promise<void>;
  onOpenConversation: (callback: () => void) => () => void;
  /** Encrypts the secret in the host and returns a random reference; the secret never returns. */
  saveSecret: (secret: string) => Promise<SecretReply>;
  /** Removes a reference that was never committed to a connection. */
  discardSecret: (secretRef: string) => Promise<void>;
  /** Starts a host-run connection test or model list fetch bound to a new execution. */
  runConnectionCheck: (
    kind: CheckKind,
    connectionId: string,
    model?: string,
  ) => Promise<CheckReply>;
  /** Opens the host file dialog; every chosen file is imported for this conversation's draft. */
  pickAttachments: (conversationId: string) => Promise<PickReply>;
  /** Opens the host directory dialog and admits the chosen runtime bundle (offline import). */
  importRuntimeBundle: () => Promise<RuntimeImportReply>;
  /** Reconnect or re-verify one runtime instance; the outcome arrives through the snapshot. */
  runtimeControl: (
    command: RuntimeControl,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Copies one persisted runtime fact (instance directory, package directory, key digest, resource handle) to the clipboard. */
  copyRuntimeValue: (
    target: RuntimeCopyTarget,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
}
export type CheckReply =
  | { ok: true; executionId: string }
  | { ok: false; code: SecretFailure | FailureCode; message: string };
export type PickReply =
  | { ok: true; imported: number; failures: string[] }
  | { ok: false; code: FailureCode; message: string };
/** Names come from the dialog; a name is stored as shown, never as a path. */
export function validAttachmentName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !value.includes("/") &&
    !value.includes("\0") &&
    value === value.trim()
  );
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validId(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}
export const secretLimit = 4096;
/** Bearer tokens travel in an HTTP header, so only visible ASCII is accepted. */
export function validSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= secretLimit &&
    /^[\x21-\x7e]+$/.test(value)
  );
}
/** Absolute https address, or http only for this machine's loopback. Credentials in the URL are rejected. */
export function baseUrlProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "请填写 Base URL。";
  if (value.length > 2000 || value !== value.trim())
    return "Base URL 格式无效。";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Base URL 必须是完整的绝对地址，例如 https://api.example.com/v1。";
  }
  if (url.username || url.password)
    return "Base URL 不能包含账号或密码，密钥请填写在 API key 中。";
  if (url.hash) return "Base URL 不能包含片段标识。";
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && loopback) return null;
  return "Base URL 必须使用 https；仅本机 127.0.0.1 或 localhost 允许 http。";
}
export function validModel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9_.:/-]+(?:\[[A-Za-z0-9]+\])?$/.test(value)
  );
}
export function validConnectionInput(value: unknown): value is ConnectionInput {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    validId(c.id) &&
    typeof c.name === "string" &&
    c.name.trim().length > 0 &&
    c.name.length <= 80 &&
    c.name === c.name.trim() &&
    providers.includes(c.provider as Provider) &&
    baseUrlProblem(c.baseUrl) === null &&
    typeof c.model === "string" &&
    (c.model === "" || validModel(c.model)) &&
    (c.secretRef === null || validId(c.secretRef)) &&
    imageInputs.includes(c.imageInput as ImageInput) &&
    (c.contextChars === null ||
      (Number.isSafeInteger(c.contextChars) &&
        Number(c.contextChars) >= contextCharsMin &&
        Number(c.contextChars) <= contextCharsMax)) &&
    Number.isSafeInteger(c.revision) &&
    Number(c.revision) >= 0
  );
}
export function validCommand(value: unknown): value is Command {
  if (validWidgetGenerationCommand(value)) return true;
  if (validProjectCommand(value)) return true;
  if (validCapabilityCommand(value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  const keys = Object.keys(c).sort().join(",");
  if (c.type === "snapshot" || c.type === "rebuildSearchIndex")
    return keys === "type";
  if (c.type === "organizeConversation")
    return (
      keys === "action,confirmed,id,revision,type" &&
      validId(c.id) &&
      conversationActions.includes(c.action as ConversationAction) &&
      typeof c.confirmed === "boolean" &&
      Number.isSafeInteger(c.revision) &&
      Number(c.revision) >= 0
    );
  if (c.type === "renameConversation")
    return (
      keys === "id,revision,title,type" &&
      validId(c.id) &&
      typeof c.title === "string" &&
      c.title.trim().length > 0 &&
      [...c.title.trim()].length <= 80 &&
      !/[\u0000-\u001f\u007f]/u.test(c.title) &&
      Number.isSafeInteger(c.revision) &&
      Number(c.revision) >= 0
    );
  if (
    c.type === "create" ||
    c.type === "newConversation" ||
    c.type === "select" ||
    c.type === "deleteConnection"
  )
    return keys === "id,type" && validId(c.id);
  if (c.type === "movePinned") {
    const before = c.before as Record<string, unknown> | null;
    return (
      keys === "before,id,kind,revision,type" &&
      (c.kind === "conversation" || c.kind === "project") &&
      validId(c.id) &&
      (before === null ||
        (!!before &&
          typeof before === "object" &&
          !Array.isArray(before) &&
          Object.keys(before).sort().join(",") === "id,kind" &&
          (before.kind === "conversation" || before.kind === "project") &&
          validId(before.id) &&
          (before.id !== c.id || before.kind !== c.kind))) &&
      Number.isSafeInteger(c.revision) &&
      Number(c.revision) >= 0
    );
  }
  if (c.type === "setConnectionEnabled")
    return (
      keys === "clearDefault,enabled,id,revision,type" &&
      validId(c.id) &&
      typeof c.enabled === "boolean" &&
      typeof c.clearDefault === "boolean" &&
      Number.isSafeInteger(c.revision) &&
      Number(c.revision) >= 0
    );
  if (c.type === "deleteModel")
    return (
      keys === "id,model,revision,type" &&
      validId(c.id) &&
      validModel(c.model) &&
      Number.isSafeInteger(c.revision) &&
      Number(c.revision) >= 0
    );
  if (c.type === "upsertModel")
    return (
      keys === "contextChars,enabled,id,imageInput,model,revision,type" &&
      validId(c.id) &&
      validModel(c.model) &&
      typeof c.enabled === "boolean" &&
      imageInputs.includes(c.imageInput as ImageInput) &&
      (c.contextChars === null ||
        (Number.isSafeInteger(c.contextChars) &&
          Number(c.contextChars) >= contextCharsMin &&
          Number(c.contextChars) <= contextCharsMax)) &&
      Number.isSafeInteger(c.revision) &&
      Number(c.revision) >= 0
    );
  if (c.type === "setDefaultConnection")
    return (
      (keys === "id,type" ||
        (keys === "id,model,type" && validModel(c.model))) &&
      (c.id === null || validId(c.id))
    );
  if (c.type === "submitTurn") {
    const submitKeys = keys
      .split(",")
      .filter((k) => k !== "projectContextRevision")
      .join(",");
    return (
      (c.projectContextRevision === undefined ||
        (Number.isSafeInteger(c.projectContextRevision) &&
          Number(c.projectContextRevision) >= 0)) &&
      ([
        "connectionId,conversationId,requestId,text,type",
        "connectionId,conversationId,materialMode,requestId,text,type",
      ].includes(submitKeys) ||
        ([
          "connectionId,conversationId,model,requestId,text,type",
          "connectionId,conversationId,materialMode,model,requestId,text,type",
        ].includes(submitKeys) &&
          validModel(c.model))) &&
      (c.materialMode === undefined ||
        c.materialMode === "inline" ||
        c.materialMode === "tools") &&
      validId(c.requestId) &&
      validId(c.conversationId) &&
      validId(c.connectionId) &&
      typeof c.text === "string" &&
      c.text.trim().length > 0 &&
      c.text.length <= 100_000
    );
  }
  if (c.type === "stopExecution")
    return keys === "executionId,type" && validId(c.executionId);
  if (c.type === "setCodexSettings" || c.type === "setClaudeSettings")
    return (
      keys === "enabled,path,revision,type" &&
      typeof c.enabled === "boolean" &&
      (c.type === "setClaudeSettings"
        ? validClaudePath(c.path)
        : validCodexPath(c.path)) &&
      Number.isSafeInteger(c.revision) &&
      Number(c.revision) >= 0
    );
  if (c.type === "setAppearance")
    return (
      keys === "appearance,type" &&
      ["light", "dark", "auto"].includes(String(c.appearance))
    );
  if (c.type === "setInterfacePreference")
    return (
      keys === "key,type,value" && validInterfacePreference(c.key, c.value)
    );
  if (c.type === "setTelemetry")
    return keys === "enabled,type" && typeof c.enabled === "boolean";
  if (c.type === "chooseEffort")
    return (
      keys === "conversationId,effort,type" &&
      validId(c.conversationId) &&
      (c.effort === null || validEffortLevel(c.effort))
    );
  if (c.type === "chooseConnection")
    return (
      (keys === "connectionId,conversationId,type" ||
        (keys === "connectionId,conversationId,model,type" &&
          validModel(c.model))) &&
      validId(c.conversationId) &&
      (c.connectionId === null || validId(c.connectionId))
    );
  if (c.type === "grantConnectionScope")
    return (
      keys === "baseUrl,connectionId,conversationId,type" &&
      validId(c.conversationId) &&
      validId(c.connectionId) &&
      typeof c.baseUrl === "string" &&
      // Local executors carry no address; the store still requires the exact stored value.
      (c.baseUrl === "" || !baseUrlProblem(c.baseUrl))
    );
  if (c.type === "grantProviderScope")
    return (
      keys === "conversationId,provider,type" &&
      validId(c.conversationId) &&
      providers.includes(c.provider as Provider)
    );
  if (c.type === "removeDraftAttachment")
    return (
      keys === "attachmentId,conversationId,type" &&
      validId(c.conversationId) &&
      validId(c.attachmentId)
    );
  if (c.type === "readAttachmentPreview")
    return keys === "attachmentId,type" && validId(c.attachmentId);
  if (c.type === "resolvePending")
    return (
      keys === "action,id,type" &&
      validId(c.id) &&
      (c.action === "dismiss" || c.action === "retry")
    );
  if (c.type === "upsertConnection")
    return (
      (keys ===
        "baseUrl,contextChars,id,imageInput,model,name,provider,revision,secretRef,type" ||
        (keys ===
          "baseUrl,clearDefault,contextChars,id,imageInput,model,name,provider,revision,secretRef,type" &&
          typeof c.clearDefault === "boolean")) &&
      validConnectionInput(c)
    );
  return (
    c.type === "saveDraft" &&
    keys === "id,revision,text,type" &&
    validId(c.id) &&
    typeof c.text === "string" &&
    c.text.length <= 100_000 &&
    Number.isSafeInteger(c.revision) &&
    Number(c.revision) >= 0
  );
}
export function validHostCommand(value: unknown): value is HostCommand {
  if (validWidgetGenerationHostCommand(value)) return true;
  if (validProjectHostCommand(value)) return true;
  if (validWidgetHostCommand(value)) return true;
  if (validCapabilityHostCommand(value)) return true;
  if (validRuntimeHostCommand(value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (c.type === "exportConversation")
    return Object.keys(c).sort().join(",") === "id,type" && validId(c.id);
  const keys = Object.keys(c).sort().join(",");
  if (c.type === "recordClaudeRun")
    return (
      keys === "executionId,run,type" &&
      validId(c.executionId) &&
      validClaudeRun(c.run)
    );
  if (c.type === "configureClaude")
    return (
      (keys === "configuration,model,type" ||
        (keys === "configuration,effort,model,type" &&
          validEffort(c.effort))) &&
      validClaudeModel(c.model) &&
      validClaudeConnection(c.configuration)
    );
  if (c.type === "recordEffort") {
    if (
      keys !== "efforts,provider,type" ||
      !["codex", "claude"].includes(String(c.provider)) ||
      !c.efforts ||
      typeof c.efforts !== "object" ||
      Array.isArray(c.efforts)
    )
      return false;
    const entries = Object.entries(c.efforts as Record<string, unknown>);
    return (
      entries.length <= 5000 &&
      entries.every(
        ([model, effort]) =>
          (c.provider === "claude"
            ? validClaudeModel(model)
            : validModel(model)) && validEffort(effort),
      )
    );
  }
  if (c.type === "recordCodexRun")
    return (
      keys === "executionId,run,type" &&
      validId(c.executionId) &&
      validCodexRun(c.run)
    );
  if (c.type === "configureCodex")
    return (
      (keys === "configuration,model,type" ||
        (keys === "configuration,effort,model,type" &&
          validEffort(c.effort))) &&
      validModel(c.model) &&
      validCodexConnection(c.configuration)
    );
  if (c.type === "importAttachment")
    return (
      keys === "attachmentId,conversationId,name,path,type" &&
      validId(c.conversationId) &&
      validId(c.attachmentId) &&
      typeof c.path === "string" &&
      c.path.startsWith("/") &&
      c.path.length <= 4096 &&
      !c.path.includes("\0") &&
      validAttachmentName(c.name)
    );
  if (c.type === "reportExtraction") {
    if (keys !== "attachmentId,outcome,type" || !validId(c.attachmentId))
      return false;
    const outcome = c.outcome as Record<string, unknown> | null;
    if (!outcome || typeof outcome !== "object") return false;
    const outcomeKeys = Object.keys(outcome).sort().join(",");
    if (outcome.ok === true)
      return (
        outcomeKeys === "ok,pages,text" &&
        typeof outcome.text === "string" &&
        outcome.text.length <= attachmentTextLimit &&
        (outcome.pages === null ||
          (Number.isSafeInteger(outcome.pages) && Number(outcome.pages) >= 0))
      );
    return (
      outcome.ok === false &&
      outcomeKeys === "ok,reason" &&
      attachmentReasons.includes(outcome.reason as AttachmentReason)
    );
  }
  if (!validId(c.executionId)) return false;
  if (
    c.type === "beginExecution" ||
    c.type === "loadTurnContext" ||
    c.type === "reportStopTimeout" ||
    c.type === "reportImageUnsupported" ||
    c.type === "reportInterrupted"
  )
    return keys === "executionId,type";
  if (c.type === "createExecution")
    return (
      (keys === "connectionId,executionId,kind,type" ||
        (keys === "connectionId,executionId,kind,model,type" &&
          validModel(c.model))) &&
      validId(c.connectionId) &&
      checkKinds.includes(c.kind as CheckKind)
    );
  const seq = Number.isSafeInteger(c.seq) && Number(c.seq) >= 1;
  if (c.type === "reportModels")
    return (
      keys === "executionId,models,seq,type" &&
      seq &&
      Array.isArray(c.models) &&
      c.models.length <= 5000 &&
      c.models.every((m) => typeof m === "string" && m.length <= 200)
    );
  if (c.type === "reportDelta")
    return (
      keys === "executionId,seq,text,type" &&
      seq &&
      typeof c.text === "string" &&
      c.text.length <= 1_000_000
    );
  if (c.type === "reportFinished" || c.type === "reportStopped")
    return keys === "executionId,seq,type" && seq;
  return (
    c.type === "reportFailed" &&
    keys === "errorClass,executionId,message,seq,type" &&
    seq &&
    errorClasses.includes(c.errorClass as ErrorClass) &&
    typeof c.message === "string" &&
    c.message.length <= 2000
  );
}
