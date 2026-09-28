import "./tokens.css";
import {
  RecordFilters,
  initialRecordQuery,
  matchesRecord,
  recordScope,
} from "./record-query";
import {
  ProjectPendingList,
  ProjectRunLog,
  useProjectProjections,
} from "./project-pending";
import { WidgetWorkspace } from "./widgets";
import { Projects } from "./projects";
import {
  PermissionSettings,
  TrustBoundaryNotice,
  ToolPending,
  ToolHistory,
} from "./capabilities";
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { useBusiness } from "./state";
import { ConnectionSettings } from "./connections";
import { Transcript, activeTurn } from "./chat";
import { pendingLabels, PendingList, ResolvedStops, RunLog } from "./records";
import { stopConfirmed, stopUnconfirmed } from "./host-execution-fact";
import type { HostExecutionRecord } from "../shared/runtime-execution";
import { AttachmentPreviewPanel, DraftAttachments } from "./attachments";
import {
  attachmentsPerTurn,
  eventLabels,
  presets,
  stateLabels,
  type Attachment,
  type AttachmentPreview,
} from "../shared/protocol";
import { SearchDialog, SearchIndexSettings } from "./search";
import type { SearchHit } from "../shared/search";
import {
  applyInitialAppearance,
  useAppearance,
  AppearanceSettings,
} from "./appearance";
import { useOrganization } from "./organization";
import { RenameDialog } from "./conversation-title";
import { Icon } from "./icons";
import {
  HomeHeader,
  ProfileMenu,
  RecentChatsPopover,
  usePopover,
  type Page,
} from "./shell";
import { ExtensionGrants, ExtensionSettings } from "./extensions";
import "./style.css";

const settingTabs = [
  "通用",
  "模型",
  "最近删除",
  "扩展管理",
  "访问权限",
  "数据保留",
  "数据与隐私",
];
/** The extension category's content title is "扩展" (RUNTIME-01); other categories keep their name. */
const settingTitles: Record<string, string> = { 扩展管理: "扩展" };
const suggestions = [
  ["解释一个概念", "把复杂的问题说清楚", "帮我解释一个概念："],
  ["整理一段文字", "提炼重点，调整表达", "帮我整理这段文字："],
  ["比较几个方案", "从不同角度做出选择", "帮我比较这些方案："],
  ["创建一个控件", "将想法变成常用工具", "我想创建一个控件："],
];
/**
 * An explicit re-read of the snapshot for a list page (V-19 r1: the push channel keeps the view
 * current, but a person wants a button and visible feedback): the button is disabled while the
 * snapshot is re-read, then the time of the last refresh stays next to it.
 */
function RefreshControl({
  label,
  connected,
  reload,
}: {
  label: string;
  connected: boolean;
  reload: () => Promise<void>;
}) {
  const [state, setState] = useState<string | null>(null);
  return (
    <div className="row page-heading-actions">
      <span className="quiet" role="status" aria-live="polite">
        {state === "busy" ? "正在刷新…" : state ? `已刷新 ${state}` : ""}
      </span>
      <button
        className="icon-button"
        aria-label={label}
        title="刷新"
        disabled={!connected || state === "busy"}
        onClick={() => {
          setState("busy");
          void reload().finally(() => {
            setState(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
          });
        }}
      >
        <Icon name="refresh" />
      </button>
    </div>
  );
}
function App() {
  const model = useBusiness();
  const { snapshot, status } = model;
  const projectProjections = useProjectProjections(snapshot, status.connected);
  const [pendingQuery, setPendingQuery] = useState(initialRecordQuery),
    [runQuery, setRunQuery] = useState({
      ...initialRecordQuery,
      order: "newest",
    });
  const hostPending = (snapshot?.pendingItems ?? [])
    .filter((item) => {
      const execution = snapshot?.runtimeExecutions.find(
        (r) => r.executionRef === item.executionRef,
      );
      return matchesRecord(pendingQuery, {
        text: [
          item.kind,
          pendingLabels[item.kind],
          item.conversationId,
          snapshot?.conversations.find((c) => c.id === item.conversationId)
            ?.title,
          execution?.domainNodeRef,
        ].join(" "),
        scope: recordScope(
          snapshot!,
          item.conversationId,
          execution?.instanceId,
          execution?.scopeRef,
        ),
        type: `host:${item.kind}`,
        blocking: item.kind === "stop_unconfirmed",
      });
    })
    .sort((a, b) =>
      pendingQuery.order === "blocking" &&
      (a.kind === "stop_unconfirmed") !== (b.kind === "stop_unconfirmed")
        ? Number(b.kind === "stop_unconfirmed") -
          Number(a.kind === "stop_unconfirmed")
        : pendingQuery.order === "newest"
          ? b.createdAt.localeCompare(a.createdAt)
          : a.createdAt.localeCompare(b.createdAt),
    );
  const queriedTools = (snapshot?.toolOperations ?? []).filter((o) =>
    matchesRecord(pendingQuery, {
      text: [o.conversationTitle, o.attachmentName, o.purpose].join(" "),
      scope: recordScope(snapshot!, o.conversationId),
      type: "host:tool-authorization",
      blocking: true,
    }),
  );
  const queriedStops = (snapshot?.runtimeExecutions ?? []).filter((r) =>
    matchesRecord(pendingQuery, {
      text: [r.executionRef, r.domainNodeRef, "停止未确认"].join(" "),
      scope: recordScope(snapshot!, null, r.instanceId, r.scopeRef),
      type: "host:stop_unconfirmed",
      blocking: false,
    }),
  );
  const queriedEvents = (snapshot?.events ?? [])
    .filter((e) => {
      const execution = snapshot?.runtimeExecutions.find(
        (r) => r.executionRef === e.payload.executionRef,
      );
      return (
        matchesRecord(runQuery, {
          text: `${eventLabels[e.kind]} ${JSON.stringify(e)}`,
          scope: recordScope(
            snapshot!,
            snapshot!.turns.find((t) => t.executionId === e.executionId)
              ?.conversationId ??
              (typeof e.payload.conversationId === "string"
                ? e.payload.conversationId
                : null),
            execution?.instanceId,
            execution?.scopeRef,
          ),
          type: `host:${e.kind}`,
        }) &&
        (runQuery.days === "all" ||
          Date.parse(e.at) >= Date.now() - Number(runQuery.days) * 86400000)
      );
    })
    .sort((a, b) =>
      runQuery.order === "oldest"
        ? a.at.localeCompare(b.at)
        : b.at.localeCompare(a.at),
    );

  const domainPendingCount = projectProjections.reduce(
    (n, e) =>
      n +
      (e.view?.projection?.pendingItems.filter((i) => i.status === "pending")
        .length ?? 0),
    0,
  );
  function openProjectSource(projectId: string, objectRef: string) {
    sessionStorage.setItem("project-selected", projectId);
    sessionStorage.setItem(`project-object:${projectId}`, objectRef);
    setWorkbenchTab("projects");
    setPage("工作台");
  }

  useAppearance(snapshot?.settings.appearance);
  const panel = window.desktop.surface === "panel";
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => window.desktop.onWidgetSearch(() => setSearchOpen(true)), []);
  const [searchTarget, setSearchTarget] = useState<{
    conversationId: string;
    messageId: string;
    query: string;
  }>();
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      // An IME composition owns the keyboard until it commits (UI-01: no shortcut fires mid-composition).
      if (event.isComposing) return;
      if (event.metaKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const [renameId, setRenameId] = useState<string>();
  const renameTarget = snapshot?.conversations.find((c) => c.id === renameId);
  const [page, setPage] = useState<Page>(panel ? "工作台" : "聊天");
  const [workbenchTab, setWorkbenchTab] = useState<"projects" | "widgets">(
    panel ? "widgets" : "projects",
  );
  useEffect(() => {
    document.title = panel ? "工作台助手" : "csthink-assistant";
    return window.desktop.onOpenConversation(() => setPage("聊天"));
  }, [panel]);
  const [readOnlyView, setReadOnlyView] = useState<string>();
  useEffect(() => {
    if (status.connected) setReadOnlyView(undefined);
  }, [status.connected]);
  const [tab, setTab] = useState("模型");
  const [notice, setNotice] = useState("");
  const popover = usePopover();
  const [recentFilter, setRecentFilter] = useState("");
  // The in-list filter lives only while the popover is open; reopening starts from the full list.
  useEffect(() => {
    if (popover.open !== "recent") setRecentFilter("");
  }, [popover.open]);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [telemetryDraft, setTelemetryDraft] = useState<boolean | null>(null);
  async function resolvePending(id: string, action: "retry" | "dismiss") {
    if (pendingBusy) return;
    setPendingBusy(true);
    const reply = await window.desktop.command({
      type: "resolvePending",
      id,
      action,
    });
    setPendingBusy(false);
    if (!reply.ok) setNotice(reply.message);
  }
  /** 重新检查 on a stop-unconfirmed item: one more observation by the Host; the release itself is automatic. */
  async function recheckExecution(record: HostExecutionRecord) {
    if (pendingBusy) return;
    setPendingBusy(true);
    try {
      const reply = await window.desktop.runtimeControl({
        type: "recheckExecution",
        executionRef: record.executionRef,
      });
      if (!reply.ok) setNotice(reply.message);
    } finally {
      setPendingBusy(false);
    }
  }
  /** Executions whose stop the Host has not confirmed: they hold the extension and application update entries (UI-03). */
  const heldStops = (snapshot?.runtimeExecutions ?? []).filter(stopUnconfirmed);
  const id =
    readOnlyView ??
    snapshot?.selected[window.desktop.surface] ??
    snapshot?.selected.main ??
    undefined;
  const current = snapshot?.conversations.find(
    (c) => c.id === id && !c.deletedAt,
  );
  const local = id ? model.drafts.get(id) : undefined;
  const text = local?.text ?? current?.draft ?? "";
  const defaultConnection = snapshot?.connections.find(
    (c) => c.id === snapshot.settings.defaultConnectionId,
  );
  const conversationMessages =
    snapshot?.messages.filter((m) => m.conversationId === id) ?? [];
  const conversationTurns =
    snapshot?.turns.filter((t) => t.conversationId === id) ?? [];
  const running = activeTurn(conversationTurns);
  const attachmentById = new Map(
    (snapshot?.attachments ?? []).map((a) => [a.id, a]),
  );
  const draftAttachments = (snapshot?.draftAttachments ?? [])
    .filter((link) => link.conversationId === id)
    .sort((a, b) => a.position - b.position)
    .map((link) => attachmentById.get(link.attachmentId))
    .filter((a): a is Attachment => !!a);
  const importingAttachment = draftAttachments.find(
    (a) => a.status === "importing",
  );
  const unreadableAttachment = draftAttachments.find(
    (a) => a.status === "unreadable",
  );
  const [picking, setPicking] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  async function pickAttachments() {
    if (!id || picking) return;
    setPicking(true);
    setNotice("");
    const reply = await window.desktop.pickAttachments(id);
    setPicking(false);
    if (!reply.ok) setNotice(reply.message);
    else if (reply.failures.length) setNotice(reply.failures.join("\n"));
  }
  async function removeAttachment(attachment: Attachment) {
    if (!id || attachmentBusy) return;
    setAttachmentBusy(true);
    const reply = await window.desktop.command({
      type: "removeDraftAttachment",
      conversationId: id,
      attachmentId: attachment.id,
    });
    setAttachmentBusy(false);
    if (!reply.ok) setNotice(reply.message);
  }
  const [previewId, setPreviewId] = useState<string>();
  const [previewText, setPreviewText] = useState<AttachmentPreview | null>(
    null,
  );
  const previewAttachment = previewId
    ? attachmentById.get(previewId)
    : undefined;
  function openAttachment(attachment: Attachment) {
    setPreviewId(attachment.id);
    setPreviewText(null);
    const textual =
      attachment.kind === "text" ||
      attachment.kind === "markdown" ||
      attachment.kind === "pdf";
    if (attachment.status !== "ready" || !textual) return;
    void window.desktop
      .command({ type: "readAttachmentPreview", attachmentId: attachment.id })
      .then((reply) => {
        if (reply.ok && reply.preview) setPreviewText(reply.preview);
        else if (!reply.ok) setNotice(reply.message);
      });
  }
  // A removed or replaced attachment closes its preview instead of showing stale metadata.
  useEffect(() => {
    if (previewId && !attachmentById.has(previewId)) setPreviewId(undefined);
  });
  // The conversation's explicit choice wins; a deleted choice falls back to the default visibly.
  const chosenConnection = current?.connectionId
    ? snapshot?.connections.find((c) => c.id === current.connectionId)
    : undefined;
  const baseConnection = chosenConnection ?? defaultConnection;
  const chosenModel = chosenConnection
    ? (current?.modelId ?? chosenConnection.model)
    : (snapshot?.settings.defaultModelId ?? defaultConnection?.model);
  const modelEntry = baseConnection?.models.find(
    (m) => m.model === chosenModel && m.enabled,
  );
  // The level control follows the conversation's resolved connection/model; API models never carry a record.
  const effortRecord =
    baseConnection &&
    (baseConnection.provider === "codex" ||
      baseConnection.provider === "claude")
      ? (modelEntry?.effort ?? null)
      : null;
  const activeConnection =
    baseConnection?.enabled &&
    (baseConnection.provider === "codex"
      ? snapshot?.settings.codex.enabled && modelEntry?.codex
      : baseConnection.provider === "claude"
        ? snapshot?.settings.claude.enabled && modelEntry?.claude
        : baseConnection.secretRef) &&
    modelEntry
      ? { ...baseConnection, ...modelEntry }
      : undefined;
  const canSend =
    !!current &&
    status.connected &&
    !model.switching &&
    !running &&
    !!activeConnection &&
    !importingAttachment &&
    !unreadableAttachment &&
    text.trim().length > 0;
  const sendTitle = !current
    ? "先新建对话"
    : !activeConnection
      ? "请先选择可用模型"
      : running
        ? `上一回合${stateLabels[running.state]}，结束后才能继续发送`
        : unreadableAttachment
          ? `“${unreadableAttachment.name}”不可读，请先移除它`
          : importingAttachment
            ? `正在提取“${importingAttachment.name}”，请稍候`
            : text.trim()
              ? "发送（Enter）"
              : "输入内容后发送";
  // Sending a conversation to a provider other than the one that answered last needs one explicit confirmation.
  const crossProvider =
    !!current &&
    !!activeConnection &&
    current.lastDestination !== null &&
    current.lastDestination !==
      `${activeConnection.id}|${activeConnection.baseUrl}` &&
    !current.grantedConnections.includes(
      `${activeConnection.id}|${activeConnection.baseUrl}`,
    );
  const [scopeConfirm, setScopeConfirm] = useState<{
    conversationId: string;
    connection: NonNullable<typeof activeConnection>;
  }>();
  async function send() {
    if (!id || !canSend || !activeConnection) return;
    if (crossProvider) {
      setScopeConfirm({ conversationId: id, connection: activeConnection });
      return;
    }
    await model.submit(id, activeConnection.id, activeConnection.model);
    setTimeout(() => textarea.current?.focus(), 0);
  }
  async function confirmScope() {
    if (!scopeConfirm) return;
    const target = scopeConfirm.connection;
    if (
      id !== scopeConfirm.conversationId ||
      activeConnection?.id !== target.id ||
      activeConnection.model !== target.model ||
      activeConnection.baseUrl !== target.baseUrl
    ) {
      setScopeConfirm(undefined);
      setNotice("对话或目标模型已变化，请重新核对发送范围。");
      return;
    }
    const granted = await window.desktop.command({
      type: "grantConnectionScope",
      conversationId: scopeConfirm.conversationId,
      connectionId: target.id,
      baseUrl: target.baseUrl,
    });
    setScopeConfirm(undefined);
    if (!granted.ok) {
      setNotice(granted.message);
      return;
    }
    await model.submit(scopeConfirm.conversationId, target.id, target.model);
    setTimeout(() => textarea.current?.focus(), 0);
  }
  // Material that would travel with a cross-provider send: history messages' material plus this draft's.
  const materialScope = (() => {
    const messageIds = new Set(conversationMessages.map((m) => m.id));
    const carried = (snapshot?.messageAttachments ?? [])
      .filter((link) => messageIds.has(link.messageId))
      .map((link) => attachmentById.get(link.attachmentId))
      .filter((a): a is Attachment => !!a);
    const all = [...carried, ...draftAttachments];
    const images = all.filter(
      (a) => a.kind === "png" || a.kind === "jpeg",
    ).length;
    return all.length
      ? `，连同 ${all.length} 份资料（其中 ${images} 张图片）`
      : "";
  })();
  const historyRange = (() => {
    if (!conversationMessages.length) return "";
    const first = new Date(conversationMessages[0].createdAt);
    const last = new Date(
      conversationMessages[conversationMessages.length - 1].createdAt,
    );
    const format = (d: Date) => d.toLocaleString("zh-CN", { hour12: false });
    return `${format(first)} 至 ${format(last)}`;
  })();
  useEffect(() => {
    if (!searchTarget?.messageId.startsWith("turn-")) return;
    const turnId = searchTarget.messageId.slice(5);
    const message = conversationMessages.find(
      (m) => m.role === "assistant" && m.turnId === turnId,
    );
    if (message) setSearchTarget({ ...searchTarget, messageId: message.id });
  }, [conversationMessages, searchTarget]);
  const saveLabel = local?.error
    ? "尚未保存"
    : local?.dirty
      ? "正在保存…"
      : current
        ? "草稿已保存"
        : "草稿保存在本机";
  async function openSearchHit(hit: SearchHit, query: string) {
    const selected = await model.select(hit.conversationId);
    if (!selected) return false;
    setReadOnlyView(undefined);
    setPage("聊天");
    setSearchTarget(
      hit.messageId
        ? {
            conversationId: hit.conversationId,
            messageId: hit.messageId,
            query,
          }
        : undefined,
    );
    return true;
  }
  async function newConversation() {
    setSearchTarget(undefined);
    const created = await model.create();
    if (created) {
      setPage("聊天");
      setTimeout(() => textarea.current?.focus(), 0);
    }
  }
  async function suggestion(value: string) {
    const target = id ?? (await model.create());
    if (target) {
      model.edit(target, value);
      setPage("聊天");
      setTimeout(() => textarea.current?.focus(), 0);
    }
  }
  const organization = useOrganization({
    page,
    snapshot,
    connected: status.connected && !model.switching,
    currentId: id,
    dirty: (target) => !!model.drafts.get(target)?.dirty,
    select: async (target) => {
      if (!status.connected) {
        setReadOnlyView(target);
        setSearchTarget(undefined);
        popover.close(false);
        setPage("聊天");
        return true;
      }
      const ok = await model.select(target);
      if (ok) {
        setReadOnlyView(undefined);
        setSearchTarget(undefined);
        popover.close(false);
        setPage("聊天");
      }
      return ok;
    },
    rename: setRenameId,
    notice: setNotice,
    filter: popover.open === "recent" ? recentFilter : "",
  });
  const conversationList = organization.list;
  const chatProject = snapshot?.projects.find((p) =>
    p.chats.some((c) => c.conversationId === id),
  );
  const projectContext = chatProject?.chats.find(
    (c) => c.conversationId === id,
  )?.context;
  const composer = (
    <div className="composer-wrap">
      {chatProject && (
        <section className="project-chat-summary" aria-label="项目对话上下文">
          <strong>项目：{chatProject.name}</strong>
          <span>
            {projectContext
              ? `当前讨论：${projectContext.title} · ${projectContext.revision}`
              : "当前讨论：项目名称与目标"}
          </span>
          <small>发送包含本对话历史、项目名称与目标及所选对象信息。</small>
          <button
            className="button"
            onClick={() => {
              if (panel) {
                void window.desktop.openMain(id);
                return;
              }
              sessionStorage.setItem("project-selected", chatProject.id);
              if (id)
                sessionStorage.setItem(`project-chat:${chatProject.id}`, id);
              setWorkbenchTab("projects");
              setPage("工作台");
            }}
          >
            {panel ? "在主窗口查看" : "打开项目"}
          </button>
        </section>
      )}
      {local?.error && (
        <div role="alert" className="draft-error">
          <strong>{local.error}</strong>
          <p>本机已保存：{current?.draft || "空草稿"}</p>
          <div className="row">
            <button
              disabled={!status.connected || local.saving}
              onClick={() => id && model.retry(id)}
            >
              用当前输入保存
            </button>
            <button
              disabled={local.saving}
              onClick={() => id && model.adopt(id)}
            >
              采用已保存版本
            </button>
          </div>
        </div>
      )}
      {previewAttachment && (
        <AttachmentPreviewPanel
          attachment={previewAttachment}
          preview={
            previewText?.attachmentId === previewAttachment.id
              ? previewText
              : null
          }
          onClose={() => setPreviewId(undefined)}
        />
      )}
      {scopeConfirm && current && (
        <div
          role="alertdialog"
          aria-label="跨提供方发送确认"
          className="scope-confirm"
        >
          <strong>
            {`本次将使用 ${scopeConfirm.connection.name}（${presets[scopeConfirm.connection.provider].label} · ${scopeConfirm.connection.model}）回答`}
          </strong>
          <p>
            {`该对话上一次使用${current.lastProvider ? presets[current.lastProvider].label : "其他提供方"}。确认后会把已保存的 ${conversationMessages.length} 条消息（${historyRange}）${materialScope}连同本次输入发送给${presets[scopeConfirm.connection.provider].label}；该提供方地址以后不再询问。取消则保留输入与资料，不发送任何内容。`}
          </p>
          <div className="row">
            <button
              className="button primary"
              onClick={() => {
                void confirmScope();
              }}
            >
              确认发送
            </button>
            <button
              className="button"
              onClick={() => setScopeConfirm(undefined)}
            >
              取消
            </button>
          </div>
        </div>
      )}
      <ToolHistory
        operations={(snapshot?.toolOperations ?? []).filter(
          (o) => o.conversationId === id,
        )}
      />
      {running?.state === "awaiting_authorization" && (
        <button className="button" onClick={() => setPage("待处理")}>
          到待处理确认资料读取
        </button>
      )}
      <div className="composer">
        <DraftAttachments
          attachments={draftAttachments}
          disabled={!status.connected || attachmentBusy || !!running}
          onRemove={(attachment) => {
            void removeAttachment(attachment);
          }}
          onOpen={openAttachment}
        />
        <textarea
          ref={textarea}
          aria-label="输入草稿"
          placeholder={
            current
              ? "输入想法，草稿会自动保存在本机…"
              : "点击“新建对话”，开始记录想法…"
          }
          value={text}
          readOnly={!current || !status.connected || model.switching}
          maxLength={100000}
          onChange={(e) => id && model.edit(id, e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline; a composing IME only commits its text.
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              !composing.current
            ) {
              e.preventDefault();
              void send();
            }
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
        />
        <div className="composer-tools">
          {snapshot?.connections.length ? (
            <div className="composer-model-picker">
              <label className="connection-choice">
                <Icon name="link" />
                <select
                  aria-label="本次连接"
                  value={
                    current?.connectionId
                      ? `${current.connectionId}::${current.modelId ?? chosenConnection?.model ?? ""}`
                      : ""
                  }
                  disabled={
                    !current ||
                    !status.connected ||
                    !!running ||
                    model.switching
                  }
                  onChange={(event) => {
                    if (id) void model.chooseConnection(id, event.target.value);
                  }}
                >
                  <option value="">
                    {defaultConnection
                      ? `默认：${defaultConnection.name} · ${snapshot?.settings.defaultModelId ?? defaultConnection.model}`
                      : "默认连接未选择"}
                  </option>
                  {current?.connectionId &&
                    !baseConnection?.models.some(
                      (m) => m.model === chosenModel,
                    ) && (
                      <option
                        value={`${current.connectionId}::${current.modelId ?? chosenConnection?.model ?? ""}`}
                        disabled
                      >
                        原模型不可用，请重新选择
                      </option>
                    )}
                  {snapshot.connections.map((c) => {
                    return c.models.length ? (
                      <optgroup key={c.id} label={c.name}>
                        {c.models.map((m) => {
                          const reason =
                            !c.enabled ||
                            (c.provider === "codex" &&
                              !snapshot.settings.codex.enabled) ||
                            (c.provider === "claude" &&
                              !snapshot.settings.claude.enabled)
                              ? "提供方已停用"
                              : !m.enabled
                                ? "模型已停用"
                                : c.provider === "codex"
                                  ? !m.codex
                                    ? "待确认来源"
                                    : ""
                                  : c.provider === "claude"
                                    ? !m.claude
                                      ? "待确认来源"
                                      : ""
                                    : !c.secretRef
                                      ? "未配置密钥"
                                      : "";
                          return (
                            <option
                              key={`${c.id}::${m.model}`}
                              value={`${c.id}::${m.model}`}
                              disabled={!!reason}
                            >
                              {c.name} · {m.model}
                              {reason ? ` · ${reason}` : ""}
                            </option>
                          );
                        })}
                      </optgroup>
                    ) : null;
                  })}
                </select>
              </label>
              <label
                className="connection-choice effort-choice"
                title={
                  effortRecord
                    ? undefined
                    : "该模型未记录推理强度档位，按模型默认执行"
                }
              >
                <Icon name="gauge" />
                <select
                  aria-label="推理强度"
                  value={current?.effort ?? ""}
                  disabled={
                    !effortRecord ||
                    !current ||
                    !status.connected ||
                    !!running ||
                    model.switching
                  }
                  onChange={(event) => {
                    if (id)
                      void model.chooseEffort(id, event.target.value || null);
                  }}
                >
                  {effortRecord ? (
                    <>
                      <option value="">
                        推理 · 默认
                        {effortRecord.defaultLevel
                          ? `（${effortRecord.defaultLevel}）`
                          : "（未记录）"}
                      </option>
                      {current?.effort &&
                        !effortRecord.levels.includes(current.effort) && (
                          <option value={current.effort} disabled>
                            原档位 {current.effort} 不可用，请重新选择
                          </option>
                        )}
                      {effortRecord.levels.map((level) => (
                        <option key={level} value={level}>
                          推理 · {level}
                        </option>
                      ))}
                    </>
                  ) : (
                    <option value="">推理 · 未记录</option>
                  )}
                </select>
              </label>
            </div>
          ) : (
            <button
              className="connection-choice"
              onClick={() => {
                setPage("设置");
                setTab("模型");
              }}
            >
              <Icon name="link" />
              <span>未配置模型连接</span>
            </button>
          )}
          <span className="spacer" />
          <button
            className="icon-button"
            aria-label="添加资料"
            disabled={
              !current ||
              !status.connected ||
              picking ||
              !!running ||
              draftAttachments.length >= attachmentsPerTurn
            }
            title={
              !current
                ? "先新建对话"
                : draftAttachments.length >= attachmentsPerTurn
                  ? `每回合最多 ${attachmentsPerTurn} 个资料`
                  : "选择文本、Markdown、PDF、PNG 或 JPEG 文件（每个不超过 20 MB）"
            }
            onClick={() => {
              void pickAttachments();
            }}
          >
            <Icon name="plus" />
          </button>
          {running && running.state !== "stopping" ? (
            <button
              className="send"
              aria-label="停止回合"
              title="停止当前回合"
              onClick={() => {
                void model.stop(running.executionId);
              }}
            >
              <Icon name="close" />
            </button>
          ) : (
            <button
              className="send"
              aria-label="发送消息"
              disabled={!canSend}
              title={sendTitle}
              onClick={() => {
                void send();
              }}
            >
              <Icon name="arrow" />
            </button>
          )}
        </div>
      </div>
      <div className="composer-foot">
        <span role="status" data-testid="save-state">
          {saveLabel}
        </span>
        <span role="status" data-testid="turn-state">
          {running
            ? `${stateLabels[running.state]} · ${running.connection.name}`
            : activeConnection
              ? "Enter 发送，Shift + Enter 换行"
              : "选择可用模型后即可提问"}
        </span>
      </div>
    </div>
  );
  function emptyPage(
    title: string,
    description: string,
    icon: string,
    action?: { label: string; run: () => void },
  ) {
    return (
      <div className="empty">
        <div className="empty-icon">
          <Icon name={icon} />
        </div>
        <h2>{title}</h2>
        <p>{description}</p>
        {action && (
          <button className="button" onClick={action.run}>
            {action.label}
          </button>
        )}
      </div>
    );
  }
  function content() {
    if (page === "聊天")
      return (
        <div className="chat-layout">
          {!panel && current && conversationMessages.length > 0 && (
            <div className="home-chat-title">
              <button
                className="conversation-title"
                aria-label="修改对话名称"
                title={current.title}
                disabled={!status.connected || model.switching}
                onClick={() => setRenameId(current.id)}
              >
                {current.title}
              </button>
              <button
                className="icon-button conversation-menu-trigger"
                aria-label="当前对话菜单"
                disabled={!status.connected}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  organization.openMenu(current, rect.left, rect.bottom);
                }}
              >
                ⋯
              </button>
            </div>
          )}
          <div className="messages">
            {conversationMessages.length > 0 ? (
              <Transcript
                focus={
                  searchTarget?.conversationId === id ? searchTarget : undefined
                }
                onClearFocus={() => setSearchTarget(undefined)}
                messages={conversationMessages}
                turns={conversationTurns}
                attachments={snapshot?.attachments ?? []}
                messageAttachments={snapshot?.messageAttachments ?? []}
                onStop={(executionId) => {
                  void model.stop(executionId);
                }}
                onOpenAttachment={openAttachment}
              />
            ) : (
              <div className="welcome">
                <div className="large-mark">
                  <Icon name="spark" />
                </div>
                <h1>有什么可以帮你？</h1>
                <p>聊聊想法，整理资料，或为自己做一个小工具。</p>
                <div className="suggestions">
                  {suggestions.map(([title, detail, value], index) => (
                    <button
                      key={title}
                      className="suggestion"
                      disabled={!status.connected || model.switching}
                      onClick={() => {
                        void suggestion(value);
                      }}
                    >
                      <Icon name={["spark", "edit", "list", "grid"][index]} />
                      <span>
                        {title}
                        <small>{detail}</small>
                      </span>
                    </button>
                  ))}
                </div>
                {!current && (
                  <button
                    className="button start-conversation"
                    disabled={!status.connected || model.switching}
                    onClick={() => {
                      void newConversation();
                    }}
                  >
                    <Icon name="plus" />
                    新建对话
                  </button>
                )}
              </div>
            )}
          </div>
          {composer}
        </div>
      );
    if (page === "工作台")
      return (
        <div className="page">
          <div className="page-heading">
            <div>
              <h1>工作台</h1>
              <p>你的常用工具，都在这里。</p>
            </div>
            {(panel || workbenchTab === "widgets") && (
              <button className="button" disabled title="控件生成尚未开放">
                <Icon name="plus" />
                添加控件
              </button>
            )}
          </div>
          {!panel && (
            <div
              className="workbench-tabs"
              role="tablist"
              aria-label="工作台内容"
            >
              <button
                role="tab"
                aria-selected={workbenchTab === "projects"}
                onClick={() => setWorkbenchTab("projects")}
              >
                项目
              </button>
              <button
                role="tab"
                aria-selected={workbenchTab === "widgets"}
                onClick={() => setWorkbenchTab("widgets")}
              >
                控件
              </button>
            </div>
          )}
          {!panel && workbenchTab === "projects" ? (
            <Projects
              snapshot={snapshot}
              connected={status.connected}
              model={model}
              onOpenSettings={(target) => {
                setPage("设置");
                setTab(target);
              }}
            />
          ) : window.desktop.widgetEnabled ? (
            <WidgetWorkspace
              occluded={searchOpen}
              connected={status.connected}
            />
          ) : (
            emptyPage(
              "工作台还是空的",
              "从一个想法开始。控件生成开放后，你可以在聊天中创建自己的工具。",
              "grid",
              { label: "到聊天记录想法", run: () => setPage("聊天") },
            )
          )}
        </div>
      );
    if (page === "待处理")
      return (
        <div className="page record-page">
          <div className="page-heading">
            <div>
              <h1>待处理</h1>
              <p>需要你确认或继续处理的事项。</p>
            </div>
            <RefreshControl
              label="刷新待处理"
              connected={status.connected}
              reload={model.reload}
            />
          </div>
          {snapshot && (
            <RecordFilters
              query={pendingQuery}
              change={setPendingQuery}
              snapshot={snapshot}
              pending
              types={[
                ...projectProjections.flatMap((e) =>
                  (e.view?.projection?.pendingItems ?? []).map(
                    (i): [string, string] => [
                      `runtime:${i.capability.id}:${i.typeId}`,
                      i.typeLabel,
                    ],
                  ),
                ),
                ...snapshot.pendingItems.map((i): [string, string] => [
                  `host:${i.kind}`,
                  i.kind === "stop_unconfirmed"
                    ? "停止未确认"
                    : i.kind === "failed_turn"
                      ? "回合失败"
                      : "回合被中断",
                ]),
                ...(snapshot.runtimeExecutions.some(stopConfirmed)
                  ? [
                      ["host:stop_unconfirmed", "停止未确认"] as [
                        string,
                        string,
                      ],
                    ]
                  : []),
                ...(snapshot.toolOperations.length
                  ? [
                      ["host:tool-authorization", "资料读取授权"] as [
                        string,
                        string,
                      ],
                    ]
                  : []),
              ]}
            />
          )}
          <p className="quiet">
            全部未解决：
            {domainPendingCount +
              (snapshot?.pendingItems.length ?? 0) +
              (snapshot?.toolOperations.filter(
                (o) => o.state === "pending" || o.state === "unknown",
              ).length ?? 0)}{" "}
            · 阻塞：
            {projectProjections.reduce(
              (n, e) =>
                n +
                (e.view?.projection?.pendingItems.filter(
                  (i) => i.status === "pending" && i.blocking,
                ).length ?? 0),
              0,
            ) +
              heldStops.length +
              (snapshot?.toolOperations.filter(
                (o) => o.state === "pending" || o.state === "unknown",
              ).length ?? 0)}
          </p>
          {projectProjections.length > 0 && (
            <ProjectPendingList
              entries={projectProjections}
              refresh={() => void model.reload()}
              onOpen={openProjectSource}
              query={pendingQuery}
            />
          )}
          {pendingQuery.tab === "pending" && (
            <>
              <ToolPending
                operations={queriedTools}
                connected={status.connected}
                onOpen={(conversationId) => {
                  void model.select(conversationId);
                  setPage("聊天");
                }}
              />
              {hostPending.length && snapshot ? (
                <PendingList
                  items={hostPending}
                  executions={snapshot.runtimeExecutions}
                  connections={snapshot.connections}
                  busy={!status.connected || pendingBusy}
                  onRetry={(item) => {
                    void resolvePending(item.id, "retry");
                  }}
                  onDismiss={(item) => {
                    void resolvePending(item.id, "dismiss");
                  }}
                  onRecheck={(record) => {
                    void recheckExecution(record);
                  }}
                  onOpen={(conversationId) => {
                    void model.select(conversationId);
                    setPage("聊天");
                  }}
                />
              ) : projectProjections.length >
                0 ? null : snapshot?.toolOperations.some(
                  (o) => o.state === "pending" || o.state === "unknown",
                ) ? null : snapshot?.runtimeExecutions.some(stopConfirmed) ? (
                <p className="quiet pending-empty-line">
                  没有待处理事项。失败或中断的回合、授权与恢复事项会出现在这里。
                </p>
              ) : (
                emptyPage(
                  "没有待处理事项",
                  "失败或中断的回合、授权与恢复事项会出现在这里。",
                  "inbox",
                )
              )}
            </>
          )}
          {snapshot && pendingQuery.tab === "processed" && (
            <ResolvedStops
              executions={queriedStops}
              connections={snapshot.connections}
            />
          )}
        </div>
      );
    if (page === "运行记录")
      return (
        <div className="page record-page">
          <div className="page-heading">
            <div>
              <h1>运行记录</h1>
              <p>查看每次执行实际发生的事件。</p>
            </div>
            <RefreshControl
              label="刷新运行记录"
              connected={status.connected}
              reload={model.reload}
            />
          </div>
          {snapshot && (
            <RecordFilters
              query={runQuery}
              change={setRunQuery}
              snapshot={snapshot}
              types={[
                ...Object.entries(eventLabels).map(
                  ([id, label]): [string, string] => [`host:${id}`, label],
                ),
                ["runtime:trace", "Runtime 记录"],
              ]}
            />
          )}
          <ProjectRunLog
            entries={projectProjections}
            onOpen={openProjectSource}
            query={runQuery}
          />
          {snapshot?.events.length ? (
            <RunLog
              events={queriedEvents}
              executions={snapshot.runtimeExecutions}
              connections={snapshot.connections}
            />
          ) : projectProjections.some((e) =>
              e.view?.projection?.objects.some(
                (o) =>
                  o.view.kind === "trace" &&
                  Array.isArray(o.view.entries) &&
                  o.view.entries.length > 0,
              ),
            ) ? null : (
            emptyPage(
              "还没有运行记录",
              "当前尚未执行模型或控件任务。历史事件将在执行后保留。",
              "list",
            )
          )}
        </div>
      );
    return (
      <div className="page settings-page">
        <div className="page-heading">
          <div>
            <h1>设置</h1>
            <p>管理连接、偏好与本地数据。</p>
          </div>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            {settingTabs.map((name) => (
              <button
                key={name}
                aria-current={tab === name ? "page" : undefined}
                className={tab === name ? "active" : ""}
                onClick={() => setTab(name)}
              >
                {name}
              </button>
            ))}
          </nav>
          <section className="settings-content" aria-label={tab}>
            <h2>{settingTitles[tab] ?? tab}</h2>
            {tab === "扩展管理" && (
              <ExtensionSettings
                snapshot={snapshot}
                connected={status.connected}
              />
            )}
            {tab === "模型" && (
              <ConnectionSettings snapshot={snapshot} status={status} />
            )}
            {tab === "通用" && (
              <>
                <AppearanceSettings
                  value={snapshot?.settings.appearance ?? "light"}
                  connected={status.connected}
                />
                <div className="setting-row">
                  <div>
                    <strong>开机启动</strong>
                    <p>尚未开放，未修改系统登录项。</p>
                  </div>
                  <input
                    type="checkbox"
                    className="setting-switch"
                    disabled
                    aria-label="开机启动"
                    checked={false}
                    readOnly
                  />
                </div>
                <div className="setting-row" data-testid="app-update-row">
                  <div>
                    <strong>应用更新</strong>
                    {heldStops.length > 0 && (
                      <p
                        className="setting-issue"
                        role="status"
                        data-testid="app-update-blocked"
                      >
                        有一次已取消的执行还剩进程没退出，等它退出后才能更新（
                        {heldStops.length} 项，见待处理）。
                      </p>
                    )}
                    <p>尚未配置更新来源。</p>
                  </div>
                  <button
                    className="button"
                    disabled
                    title={
                      heldStops.length > 0
                        ? "有一次已取消的执行还剩进程没退出，等它退出后才能更新"
                        : undefined
                    }
                  >
                    检查更新
                  </button>
                </div>
              </>
            )}
            {tab === "访问权限" && (
              <>
                <TrustBoundaryNotice />
                <PermissionSettings
                  permissions={snapshot?.permissions ?? []}
                  connected={status.connected}
                  onHistory={() => setPage("运行记录")}
                  onModels={() => setTab("模型")}
                />
                <ExtensionGrants
                  snapshot={snapshot}
                  connected={status.connected}
                />
              </>
            )}
            {tab === "最近删除" && organization.trash}
            {tab === "数据与隐私" && (
              <>
                <SearchIndexSettings connected={status.connected} />
                <div className="setting-row">
                  <div>
                    <strong>业务数据目录</strong>
                    <p className="data-path">
                      {snapshot?.dataRoot ?? "尚未读取"}
                    </p>
                  </div>
                </div>
                <p className="info">
                  对话与已确认的草稿保存于本机。API
                  密钥经系统加密保存在业务数据之外的独立存储，当前已保存{" "}
                  {snapshot?.connections.filter((c) => c.secretRef).length ?? 0}{" "}
                  个密钥。
                </p>
                <div className="setting-row">
                  <div>
                    <strong>可选诊断统计</strong>
                    <p>
                      默认关闭。本版本没有任何统计上报实现，开启只保存你的选择；模型调用所需的请求与统计无关。
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    className="setting-switch"
                    checked={
                      telemetryDraft ??
                      snapshot?.settings.telemetryEnabled ??
                      false
                    }
                    disabled={!status.connected}
                    aria-label="可选诊断统计"
                    onChange={(event) => {
                      // Optimistic until the business service confirms; a failure reverts and explains.
                      const enabled = event.target.checked;
                      setTelemetryDraft(enabled);
                      void window.desktop
                        .command({ type: "setTelemetry", enabled })
                        .then((reply) => {
                          setTelemetryDraft(null);
                          if (!reply.ok) setNotice(reply.message);
                        });
                    }}
                  />
                </div>
                <button className="button" disabled>
                  迁移数据目录
                </button>
              </>
            )}
          </section>
        </div>
      </div>
    );
  }
  const pending = {
    count:
      domainPendingCount +
      (snapshot?.pendingItems.length ?? 0) +
      (snapshot?.toolOperations ?? []).filter(
        (o) => o.state === "pending" || o.state === "unknown",
      ).length,
    connected: status.connected,
  };
  function navigate(target: Page) {
    popover.close(false);
    setPage(target);
    if (target === "设置") setTab("通用");
  }
  return (
    <div className={`app ${panel ? "panel-app" : ""}`}>
      {organization.overlays}
      {searchOpen && (
        <SearchDialog
          onClose={() => setSearchOpen(false)}
          onOpen={openSearchHit}
        />
      )}
      {renameTarget && (
        <RenameDialog
          key={renameTarget.id}
          conversation={renameTarget}
          onClose={() => setRenameId(undefined)}
        />
      )}
      {!panel && popover.open === "profile" && (
        <ProfileMenu
          page={page}
          pending={pending}
          trigger={popover.avatarTrigger}
          onNavigate={navigate}
          onClose={popover.close}
        />
      )}
      {!panel && popover.open === "recent" && (
        <RecentChatsPopover
          trigger={popover.recentTrigger}
          onClose={popover.close}
          filter={recentFilter}
          onFilter={setRecentFilter}
        >
          {conversationList}
        </RecentChatsPopover>
      )}
      <main className="shell">
        {!panel && (
          <HomeHeader
            page={page}
            onNavigate={navigate}
            connected={status.connected}
            busy={model.switching}
            onNew={() => {
              popover.close(false);
              void newConversation();
            }}
            onSearch={() => {
              popover.close(false);
              setSearchOpen(true);
            }}
            popover={popover.open}
            onToggle={popover.toggle}
            pending={pending}
            recentTrigger={popover.recentTrigger}
            avatarTrigger={popover.avatarTrigger}
          />
        )}
        {panel && (
          <>
            <header className="topbar">
              <div className="breadcrumb">
                {page === "聊天" && (
                  <button
                    className="icon-button"
                    disabled={!status.connected || model.switching}
                    aria-label="新建对话"
                    onClick={() => {
                      void newConversation();
                    }}
                  >
                    <Icon name="edit" />
                  </button>
                )}
                {page === "聊天" && current ? (
                  <button
                    className="conversation-title"
                    aria-label="修改对话名称"
                    title={current.title}
                    disabled={!status.connected || model.switching}
                    onClick={() => setRenameId(current.id)}
                  >
                    {current.title}
                  </button>
                ) : (
                  <strong>工作台助手</strong>
                )}
                {page === "聊天" && current && (
                  <button
                    className="icon-button conversation-menu-trigger"
                    aria-label="当前对话菜单"
                    disabled={!status.connected}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      organization.openMenu(current, rect.left, rect.bottom);
                    }}
                  >
                    ⋯
                  </button>
                )}
              </div>
              <div className="top-actions">
                <button
                  className="icon-button"
                  aria-label="搜索对话"
                  onClick={() => setSearchOpen(true)}
                >
                  <Icon name="search" />
                </button>
                <button
                  className="icon-button"
                  aria-label="在主窗口打开原对话"
                  onClick={() => {
                    void window.desktop.openMain(id);
                  }}
                >
                  <Icon name="panel" />
                </button>
              </div>
            </header>
            <nav className="panel-nav" aria-label="面板导航">
              {(["工作台", "聊天", "待处理", "设置"] as Page[]).map((name) => (
                <button
                  key={name}
                  className={page === name ? "active" : ""}
                  aria-current={page === name ? "page" : undefined}
                  onClick={() => setPage(name)}
                >
                  {name}
                </button>
              ))}
            </nav>
            {page === "聊天" && (
              <label className="panel-conversations">
                对话
                <select
                  aria-label="选择对话"
                  value={id ?? ""}
                  disabled={!status.connected || model.switching}
                  onChange={(e) => {
                    void model.select(e.target.value);
                  }}
                >
                  {!snapshot?.conversations.length && (
                    <option value="">还没有对话</option>
                  )}
                  {snapshot?.conversations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title} · {c.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        {!status.connected && (
          <div className="service-error" role="alert">
            <span>{status.message}</span>
            <button
              onClick={() => {
                void window.desktop.reconnect();
              }}
            >
              重新连接
            </button>
          </div>
        )}
        {model.actionError && (
          <div className="service-error" role="alert">
            <span>{model.actionError}</span>
            <button onClick={model.clearActionError}>关闭提示</button>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button
              className="icon-button"
              aria-label="关闭提示"
              onClick={() => setNotice("")}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        <div className="viewport">{content()}</div>
      </main>
    </div>
  );
}
applyInitialAppearance();
createRoot(document.getElementById("root")!).render(<App />);
