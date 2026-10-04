import "./tokens.css";
import { displayName } from "../shared/app-name";
import { taskRoute, clearTaskRoute } from "./task-route";
import { ProjectColumnsContext } from "./project-columns";
import { refocusWhenReady } from "./modal-focus";
import { useProjectProjections } from "./project-pending";
import { PendingPage } from "./pending-page";
import { RecordsPage } from "./record-page";
import "./record-pages.css";
import { WidgetWorkspace } from "./widgets";
import { useWidgetDrafts } from "./widget-drafts";
import { WidgetCandidatePanel } from "./widget-candidate";
import { WidgetStudio, WidgetTaskCard } from "./widget-studio";
import { Projects } from "./projects";
import { useProjectSidebar } from "./project-sidebar";
import {
  PermissionSettings,
  TrustBoundaryNotice,
  ToolHistory,
} from "./capabilities";
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { useBusiness } from "./state";
import { ConnectionSettings } from "./connections";
import { Transcript, activeTurn } from "./chat";
import { stopUnconfirmed } from "./host-execution-fact";
import type { HostExecutionRecord } from "../shared/runtime-execution";
import { AttachmentPreviewPanel, DraftAttachments } from "./attachments";
import {
  attachmentsPerTurn,
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
import {
  useOrganization,
  type RenameOrigin,
  type Renaming,
} from "./organization";
import { InlineRename, RenameDialog } from "./conversation-title";
import { ArchivedPage } from "./archived-page";
import { ConversationEvents, ConversationFiles } from "./conversation-panel";
import { Icon } from "./icons";
import type { Page } from "./shell";
import {
  CenterHeader,
  Rail,
  RecentChats,
  RightPanel,
  Sidebar,
  useOverlayOpen,
  useWindowWidth,
  type MainView,
} from "./main-shell";
import { columnLayout, expandsAsOverlay } from "./column-layout";
import { WidgetGenerationSettings } from "./widget-generation-settings";
import { SettingsDialog, SettingsNav, settingTitles } from "./settings-dialog";
import {
  defaultInterfacePreferences,
  titleSourceLabels,
  type Command,
  type InterfacePreferences,
} from "../shared/protocol";
import { ExtensionGrants, ExtensionSettings } from "./extensions";
import "./style.css";

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
  const widgetDrafts = useWidgetDrafts(snapshot, model.setExternalDirty);
  const [widgetFull, setWidgetFull] = useState(false);
  const widgetSelected =
    snapshot?.widgetGeneration?.selected?.[window.desktop.surface] ?? undefined;
  const [widgetSection, setWidgetSection] = useState<"widgets" | "drafts">(
    "widgets",
  );
  async function selectWidget(id?: string) {
    const saved = await widgetDrafts.command({
      type: "selectWidgetDraft",
      id: id ?? null,
    });
    if (saved) setRightOpen(!!id);
  }
  async function openWidget(id: string) {
    await go("widgets");
    setWidgetSection("drafts");
    selectWidget(id);
  }
  async function newWidgetFromChat() {
    const id = await widgetDrafts.create(current?.id ?? null);
    if (id) await openWidget(id);
  }
  const widgetEditor = snapshot?.widgetGeneration?.drafts.find(
    (d) => d.id === widgetSelected,
  );
  const projectProjections = useProjectProjections(snapshot, status.connected);
  const [pendingScopeId, setPendingScopeId] = useState<string>("all");
  const [recordScopeId, setRecordScopeId] = useState<string>("all");

  const domainPendingCount = new Set(
    projectProjections.flatMap((entry) =>
      (entry.view?.projection?.pendingItems ?? [])
        .filter((item) => item.status === "pending")
        .map(
          (item) =>
            `${entry.project.runtime?.instanceId}|${item.scopeRef}|${item.itemRef}`,
        ),
    ),
  ).size;
  /** Global unresolved items: the rail badge and the pending page read the same count. */
  const unresolvedCount =
    domainPendingCount +
    (snapshot?.pendingItems.length ?? 0) +
    (snapshot?.toolOperations ?? []).filter(
      (o) => o.state === "pending" || o.state === "unknown",
    ).length;
  function openProjectSource(projectId: string, objectRef: string) {
    sessionStorage.setItem("project-selected", projectId);
    sessionStorage.setItem(`project-object:${projectId}`, objectRef);
    go("projects");
  }

  useAppearance(snapshot?.settings.appearance ?? window.desktop.appearance);
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
        // The search panel never opens on top of another modal dialog.
        if (document.querySelector("dialog[open]")) return;
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  // The menu bar panel renames in a dialog; the main window renames in place (the sidebar row or the centre
  // title) and then returns focus to where renaming started.
  const [renameId, setRenameId] = useState<string>();
  const renameTarget = snapshot?.conversations.find((c) => c.id === renameId);
  const [renaming, setRenaming] = useState<
    Renaming & { returnTo: () => HTMLElement | null; keyboard: boolean }
  >();
  // The menu bar panel keeps its four pages; the main window shows one object in the centre, settings as a
  // dialog and the right column beside it.
  const [page, setPage] = useState<Page>(panel ? "工作台" : "聊天");
  const [view, setView] = useState<MainView>(() =>
    !panel && taskRoute() ? "projects" : "chat",
  );
  const [projectsKey, setProjectsKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => window.desktop.onOpenConversation(() => go("chat")), []);
  const [readOnlyView, setReadOnlyView] = useState<string>();
  useEffect(() => {
    if (status.connected) setReadOnlyView(undefined);
  }, [status.connected]);
  const [tab, setTab] = useState("模型");
  const [notice, setNotice] = useState("");
  const [recentFilter, setRecentFilter] = useState("");
  const width = useWindowWidth();
  const overlayOpen = useOverlayOpen();
  const [rightOpen, setRightOpen] = useState(false);
  useEffect(() => {
    if (view === "widgets" && widgetSelected) setRightOpen(true);
  }, [view, widgetSelected]);
  const [projectAvailable, setProjectAvailable] = useState(false);
  const [projectFull, setProjectFull] = useState(false);
  const [projectPanelHost, setProjectPanelHost] =
    useState<HTMLDivElement | null>(null);
  const [takeover, setTakeover] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  // A preference the person just changed shows at once; it stays for this window when saving fails.
  const [preferenceOverride, setPreferenceOverride] = useState<
    Partial<InterfacePreferences>
  >({});
  const savedPreferences =
    snapshot?.settings.interface ??
    window.desktop.interface ??
    defaultInterfacePreferences;
  const preferences = { ...savedPreferences, ...preferenceOverride };
  useEffect(() => {
    setPreferenceOverride((override) => {
      const next = { ...override };
      for (const key of Object.keys(next) as (keyof InterfacePreferences)[])
        if (next[key] === savedPreferences[key]) delete next[key];
      return Object.keys(next).length === Object.keys(override).length
        ? override
        : next;
    });
  }, [JSON.stringify(savedPreferences)]);
  async function savePreference<K extends keyof InterfacePreferences>(
    key: K,
    value: InterfacePreferences[K],
  ) {
    setPreferenceOverride((override) => ({ ...override, [key]: value }));
    const failed = "界面偏好未保存，本窗口内保持，重启后不会保持。";
    try {
      const reply = await window.desktop.command({
        type: "setInterfacePreference",
        key,
        value,
      } as Command);
      if (!reply.ok) {
        if (key === "projectSort")
          setPreferenceOverride((override) => ({
            ...override,
            projectSort: savedPreferences.projectSort,
          }));
        setNotice(`${failed}${reply.message}`);
      }
    } catch {
      if (key === "projectSort")
        setPreferenceOverride((override) => ({
          ...override,
          projectSort: savedPreferences.projectSort,
        }));
      setNotice(failed);
    }
  }
  const railSidebarButton = useRef<HTMLButtonElement>(null);
  const avatarButton = useRef<HTMLButtonElement>(null);
  const foldButton = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const panelToggle = useRef<HTMLButtonElement>(null);
  const takeoverButton = useRef<HTMLButtonElement>(null);
  const rightPanel = useRef<HTMLElement>(null);
  /** Moves focus after the next render, when the target exists. */
  const focusSoon = (target: () => HTMLElement | null | undefined) =>
    requestAnimationFrame(() => requestAnimationFrame(() => target()?.focus()));
  // The right column belongs to the conversation and the new-conversation page in this version.
  const rightAvailable =
    !panel &&
    (view === "chat" ||
      (view === "widgets" && !!widgetEditor) ||
      (["projects", "pending", "records"].includes(view) && projectAvailable));
  const effectiveRight = rightOpen && rightAvailable;
  const layout = columnLayout({
    width,
    sidebarCollapsed: preferences.sidebarCollapsed,
    rightOpen: effectiveRight,
    rightWidth: dragWidth ?? preferences.rightPanelWidth,
    takeover: takeover && effectiveRight,
  });
  useEffect(() => {
    if (overlay && layout.sidebar === "expanded") setOverlay(false);
  }, [overlay, layout.sidebar]);
  useEffect(() => {
    if (!effectiveRight && takeover) setTakeover(false);
  }, [effectiveRight, takeover]);
  async function go(target: MainView, scope = "all") {
    if (
      view === "widgets" &&
      widgetSelected &&
      target !== "widgets" &&
      !(await widgetDrafts.confirmed(widgetSelected))
    ) {
      setNotice("控件草稿尚未确认保存。输入已保留，请先重试保存。");
      return;
    }
    if (target === "pending") setPendingScopeId(scope);
    if (target === "records") setRecordScopeId(scope);
    if (panel) {
      setPage(
        target === "chat"
          ? "聊天"
          : target === "pending"
            ? "待处理"
            : target === "records"
              ? "运行记录"
              : "工作台",
      );
      return;
    }
    if (target !== "projects") clearTaskRoute();
    setSettingsOpen(false);
    if (overlay) {
      // Opening an object from the floating sidebar folds it and puts focus on the centre title.
      setOverlay(false);
      focusSoon(() =>
        document.querySelector<HTMLElement>(".center [data-center-title]"),
      );
    }
    if (target === "projects") setProjectsKey((key) => key + 1);
    setView(target);
  }
  function openSettings(category: string) {
    setTab(category);
    if (panel) setPage("设置");
    else setSettingsOpen(true);
  }
  function railSidebar() {
    const floats = expandsAsOverlay({ width, rightOpen: effectiveRight });
    if (preferences.sidebarCollapsed) {
      void savePreference("sidebarCollapsed", false);
      if (floats) {
        setOverlay(true);
        focusSoon(() =>
          sidebarRef.current?.querySelector(".side-fixed button"),
        );
      } else focusSoon(() => foldButton.current);
      return;
    }
    const next = !overlay;
    setOverlay(next);
    focusSoon(() =>
      next
        ? sidebarRef.current?.querySelector(".side-fixed button")
        : railSidebarButton.current,
    );
  }
  function foldSidebar() {
    if (overlay) setOverlay(false);
    else void savePreference("sidebarCollapsed", true);
    focusSoon(() => railSidebarButton.current);
  }
  function toggleRight() {
    if (effectiveRight) {
      closeRight();
      return;
    }
    setRightOpen(true);
    focusSoon(() =>
      document.querySelector<HTMLElement>(
        '#right-panel [role="tab"][aria-selected="true"]',
      ),
    );
  }
  function closeRight() {
    setRightOpen(false);
    setTakeover(false);
    focusSoon(() => panelToggle.current);
  }
  // A press outside the floating sidebar folds it again (menus and dialogs opened from it keep it open).
  useEffect(() => {
    if (!overlay) return;
    const press = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        sidebarRef.current?.contains(target) ||
        railSidebarButton.current?.contains(target) ||
        target?.closest(".conversation-menu, .menu-dismiss, dialog") ||
        document.querySelector("dialog[open]")
      )
        return;
      const inside = sidebarRef.current?.contains(document.activeElement);
      setOverlay(false);
      if (inside)
        focusSoon(() =>
          document.activeElement === document.body ||
          sidebarRef.current?.contains(document.activeElement)
            ? railSidebarButton.current
            : null,
        );
    };
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, [overlay]);
  // Escape closes only the innermost layer: menus and dialogs handle their own first, then the floating
  // sidebar, then a right column that took over the centre, then the right column holding focus.
  useEffect(() => {
    if (panel || projectFull) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented)
        return;
      if (
        document.querySelector(
          'dialog[open], .conversation-menu, .project-menu, [role="menu"]',
        )
      )
        return;
      if (overlay) {
        event.preventDefault();
        setOverlay(false);
        focusSoon(() => railSidebarButton.current);
        return;
      }
      if (effectiveRight && layout.takeover && !layout.takeoverOnly) {
        event.preventDefault();
        setTakeover(false);
        focusSoon(() => takeoverButton.current);
        return;
      }
      if (
        effectiveRight &&
        rightPanel.current?.contains(document.activeElement)
      ) {
        event.preventDefault();
        closeRight();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
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
    go("chat");
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
      go("chat");
      setTimeout(() => textarea.current?.focus(), 0);
    }
  }
  async function suggestion(value: string) {
    const target = id ?? (await model.create());
    if (target) {
      model.edit(target, value);
      go("chat");
      setTimeout(() => textarea.current?.focus(), 0);
    }
  }
  /** The new-conversation page: no conversation yet, or the current one has no messages. */
  const home = !current || conversationMessages.length === 0;
  function goHome() {
    // Without the business service no conversation can be created; the current one stays in view.
    if (current && conversationMessages.length > 0 && status.connected)
      void newConversation();
    else go("chat");
  }
  /**
   * Starts renaming. In the panel it opens the rename dialog. In the main window a sidebar menu edits the row in
   * place (or the centre title when the row is not on screen), the centre title and ⌥⌘R edit the centre title;
   * afterwards focus returns to the entry, with a ring when the entry was reached by keyboard.
   */
  function startRename(
    target: string,
    origin: RenameOrigin,
    keyboard: boolean,
    from?: HTMLElement,
  ) {
    if (panel) {
      setRenameId(target);
      return;
    }
    const menuButton = () =>
      document.querySelector<HTMLElement>(
        `#main-sidebar [aria-label="对话菜单 ${target.slice(0, 8)}"]`,
      );
    const rowVisible =
      (origin === "pinned" || origin === "recent") && !!menuButton();
    const previous =
      from ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    const returnTo = rowVisible
      ? menuButton
      : origin === "center"
        ? () =>
            document.querySelector<HTMLElement>(
              ".center .conversation-menu-trigger",
            )
        : origin === "shortcut"
          ? () =>
              previous?.isConnected
                ? previous
                : document.querySelector<HTMLElement>(
                    ".center [data-center-title]",
                  )
          : () =>
              document.querySelector<HTMLElement>(
                ".center [data-center-title]",
              );
    if (!rowVisible && (target !== id || view !== "chat")) {
      // Only the current conversation has a centre title; open it first.
      if (target !== id) return;
      go("chat");
    }
    setRenaming({
      id: target,
      where: rowVisible ? "sidebar" : "center",
      returnTo:
        origin === "center" && from
          ? () =>
              document.querySelector<HTMLElement>(".center [data-center-title]")
          : returnTo,
      keyboard,
    });
  }
  function finishRename() {
    const done = renaming;
    setRenaming(undefined);
    if (done) refocusWhenReady(done.returnTo, done.keyboard);
  }
  async function openConversation(target: string) {
    if (!status.connected) {
      setReadOnlyView(target);
      setSearchTarget(undefined);
      go("chat");
      return true;
    }
    // The current, already read conversation only needs showing; selecting it again (which also marks
    // it read) would be a needless command.
    if (target === id && !readOnlyView && current && !current.unread) {
      setSearchTarget(undefined);
      go("chat");
      return true;
    }
    const ok = await model.select(target);
    if (ok) {
      setReadOnlyView(undefined);
      setSearchTarget(undefined);
      go("chat");
    }
    return ok;
  }
  const projectSidebar = useProjectSidebar({
    snapshot,
    connected: status.connected && !model.switching,
    sort: preferences.projectSort,
    pinnedSort: preferences.pinnedSort,
    open: (projectId) => {
      sessionStorage.setItem("project-selected", projectId);
      go("projects");
    },
    newChat: async (projectId) => {
      const conversationId = crypto.randomUUID();
      try {
        const reply = await window.desktop.projectWork({
          type: "chat",
          projectId,
          conversationId,
        });
        if (!reply.ok) {
          setNotice(reply.message);
          return;
        }
        sessionStorage.setItem("project-selected", projectId);
        sessionStorage.setItem(`project-chat:${projectId}`, conversationId);
        await model.reload();
        await model.select(conversationId);
        go("projects");
      } catch {
        setNotice("项目对话未创建，请重试。");
      }
    },
    notify: setNotice,
  });
  const organization = useOrganization({
    page: panel ? page : view,
    highlightCurrent: panel || view === "chat",
    snapshot,
    connected: status.connected && !model.switching,
    currentId: id,
    dirty: (target) => !!model.drafts.get(target)?.dirty,
    select: openConversation,
    rename: startRename,
    notice: setNotice,
    filter: recentFilter,
    pinnedSort: preferences.pinnedSort,
    renderPinnedProject: projectSidebar.renderPinnedProject,
    renaming: renaming?.where === "sidebar" ? renaming : undefined,
    onRenameDone: finishRename,
    onArchived: panel ? undefined : () => go("archived"),
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
              go("projects");
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
        <button className="button" onClick={() => go("pending")}>
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
              onClick={() => openSettings("模型")}
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
  function chatContent() {
    return (
      <div className="chat-layout">
        {!panel && current?.archivedAt && (
          <div className="archived-banner" role="status">
            <Icon name="archive" />
            <span>这段对话已归档。发送新消息后会自动取消归档。</span>
            <button
              className="button"
              disabled={!status.connected || model.switching}
              onClick={() => {
                void organization.act(current, "unarchive");
              }}
            >
              取消归档
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
                      if (index === 3 && !panel) void newWidgetFromChat();
                      else void suggestion(value);
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
        {!panel && current && (
          <div className="widget-source-tasks">
            {(snapshot?.widgetGeneration?.tasks ?? [])
              .filter(
                (t) =>
                  snapshot?.widgetGeneration?.drafts.find(
                    (d) => d.id === t.draftId,
                  )?.sourceConversationId === current.id,
              )
              .map((task) => (
                <WidgetTaskCard
                  key={task.id}
                  task={task}
                  model={widgetDrafts}
                  onOpen={() => {
                    void openWidget(task.draftId);
                  }}
                />
              ))}
          </div>
        )}
        {composer}
      </div>
    );
  }
  /**
   * The widget page: the main window reaches it from the rail as 控件, the panel from its 工作台 page; the empty
   * state names the page the person is on.
   */
  useEffect(() => {
    if (view !== "widgets" || widgetSelected || widgetSection !== "widgets")
      setWidgetFull(false);
  }, [view, widgetSelected, widgetSection]);
  function widgetsContent(title: string, detail?: string) {
    if (panel && !window.desktop.widgetEnabled)
      return (
        <WidgetStudio
          panel
          snapshot={snapshot}
          connected={status.connected}
          model={widgetDrafts}
          section="widgets"
          onSelect={() => void window.desktop.openMain()}
          onSection={() => void window.desktop.openMain()}
          openSettings={() => void window.desktop.openMain()}
          occluded={searchOpen || overlayOpen || overlay}
        />
      );
    if (window.desktop.widgetEnabled)
      return (
        <div className="page">
          <div className="page-heading">
            <h1 tabIndex={-1} data-center-title>
              {title}
            </h1>
            {detail && <p>{detail}</p>}
          </div>
          {window.desktop.widgetEnabled ? (
            <WidgetWorkspace
              occluded={searchOpen || overlayOpen || overlay}
              connected={status.connected}
            />
          ) : (
            emptyPage(
              "工作台还是空的",
              "在主窗口创建控件，保留后可在工作台查看。",
              "grid",
              {
                label: "打开主窗口",
                run: () => {
                  void window.desktop.openMain();
                },
              },
            )
          )}
        </div>
      );
    return (
      <WidgetStudio
        snapshot={snapshot}
        connected={status.connected}
        model={widgetDrafts}
        selected={widgetSelected}
        section={widgetSection}
        onSelect={selectWidget}
        onSection={setWidgetSection}
        openSettings={() => openSettings("模型")}
        occluded={searchOpen || overlayOpen || overlay}
        full={widgetFull}
        onFull={setWidgetFull}
      />
    );
  }
  function projectsContent() {
    return (
      <div className="page projects-page" data-detail={projectAvailable}>
        <div className="page-heading">
          <div>
            <h1 tabIndex={-1} data-center-title>
              项目
            </h1>
          </div>
        </div>
        <Projects
          key={projectsKey}
          snapshot={snapshot}
          connected={status.connected}
          model={model}
          onOpenSettings={openSettings}
        />
      </div>
    );
  }
  function pendingContent() {
    return (
      <div className="page record-page">
        <div className="page-heading">
          <div>
            <h1 tabIndex={-1} data-center-title>
              待处理
            </h1>
            <p>需要你确认或继续处理的事项。</p>
          </div>
          <RefreshControl
            label="刷新待处理"
            connected={status.connected}
            reload={model.reload}
          />
        </div>
        {snapshot && (
          <PendingPage
            scope={pendingScopeId}
            snapshot={snapshot}
            entries={projectProjections}
            connected={status.connected}
            busy={pendingBusy}
            onRetry={(item) => resolvePending(item.id, "retry")}
            onDismiss={(item) => resolvePending(item.id, "dismiss")}
            onRecheck={(record) => {
              void recheckExecution(record);
            }}
            onOpen={(conversationId) => {
              void model.select(conversationId);
              go("chat");
            }}
            onProject={openProjectSource}
            refresh={() => void model.reload()}
            onRecords={(scope) => {
              go("records", scope);
            }}
          />
        )}
      </div>
    );
  }
  function recordsContent() {
    return (
      <div className="page record-page">
        <div className="page-heading">
          <div>
            <h1 tabIndex={-1} data-center-title>
              运行记录
            </h1>
            <p>查看每次执行实际发生的事件。</p>
          </div>
          <RefreshControl
            label="刷新运行记录"
            connected={status.connected}
            reload={model.reload}
          />
        </div>
        {snapshot && (
          <RecordsPage
            snapshot={snapshot}
            entries={projectProjections}
            scope={recordScopeId}
            onProject={openProjectSource}
            onConversation={(conversationId) => {
              void model.select(conversationId);
              go("chat");
            }}
          />
        )}
      </div>
    );
  }
  /** The content of the chosen settings category; the dialog and the panel's settings page share it. */
  function settingsBody() {
    return (
      <>
        {tab === "扩展管理" && (
          <ExtensionSettings snapshot={snapshot} connected={status.connected} />
        )}
        {tab === "模型" && (
          <ConnectionSettings snapshot={snapshot} status={status} />
        )}
        {tab === "通用" && (
          <>
            <WidgetGenerationSettings
              minutes={snapshot?.settings.widgetGenerationMinutes ?? 10}
              connected={status.connected}
            />
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
              onHistory={() => go("records")}
              onModels={() => setTab("模型")}
            />
            <ExtensionGrants snapshot={snapshot} connected={status.connected} />
          </>
        )}
        {tab === "最近删除" && organization.trash}
        {tab === "数据与隐私" && (
          <>
            <SearchIndexSettings connected={status.connected} />
            <div className="setting-row">
              <div>
                <strong>业务数据目录</strong>
                <p className="data-path">{snapshot?.dataRoot ?? "尚未读取"}</p>
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
                  telemetryDraft ?? snapshot?.settings.telemetryEnabled ?? false
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
      </>
    );
  }
  function panelContent() {
    if (page === "聊天") return chatContent();
    if (page === "工作台")
      return widgetsContent("工作台", "你的常用工具，都在这里。");
    if (page === "待处理") return pendingContent();
    if (page === "运行记录") return recordsContent();
    return (
      <div className="page settings-page">
        <div className="page-heading">
          <div>
            <h1>设置</h1>
            <p>管理连接、偏好与本地数据。</p>
          </div>
        </div>
        <div className="settings-layout">
          <SettingsNav tab={tab} onTab={setTab} />
          <section className="settings-content" aria-label={tab}>
            <h2>{settingTitles[tab] ?? tab}</h2>
            {settingsBody()}
          </section>
        </div>
      </div>
    );
  }
  function mainContent() {
    if (view === "archived")
      return (
        <ArchivedPage
          snapshot={snapshot}
          connected={status.connected && !model.switching}
          counts={organization.counts}
          onOpen={(target) => {
            void openConversation(target);
          }}
          onUnarchive={(c) => organization.act(c, "unarchive")}
        />
      );
    if (view === "widgets") return widgetsContent("控件");
    if (view === "projects") return projectsContent();
    if (view === "pending") return pendingContent();
    if (view === "records") return recordsContent();
    return chatContent();
  }
  const pending = { count: unresolvedCount, connected: status.connected };
  const banners = (
    <>
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
    </>
  );
  if (panel)
    return (
      <div className="app panel-app">
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
        <main className="shell">
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
          {banners}
          <div className="viewport">{panelContent()}</div>
        </main>
      </div>
    );
  const showSidebar = layout.sidebar === "expanded" || overlay;
  // The right column reads the selected conversation's messages, turns and attachments from the snapshot;
  // a conversation viewed read only while disconnected is not in it.
  const panelSource = {
    snapshot,
    conversationId: home ? undefined : id,
    readable:
      status.connected &&
      !readOnlyView &&
      !!id &&
      snapshot?.selected.main === id,
  };
  return (
    <ProjectColumnsContext.Provider
      value={{
        host: projectPanelHost,
        openPending: (scope) => {
          go("pending", scope);
        },
        openRecords: (scope) => {
          go("records", scope);
        },
        open: effectiveRight,
        layout,
        panelRef: rightPanel,
        toggleRef: panelToggle,
        takeoverRef: takeoverButton,
        setAvailable: setProjectAvailable,
        setFull: setProjectFull,
        setOpen: setRightOpen,
        setTakeover,
        toggle: toggleRight,
        close: closeRight,
        width: (value) => {
          void savePreference(
            "rightPanelWidth",
            value === null ? null : Math.round(value),
          );
        },
        preview: setDragWidth,
      }}
    >
      <div
        className="app four-column"
        data-widget-full={widgetFull && view === "widgets" ? "true" : undefined}
        data-project-full={projectFull ? "true" : undefined}
        data-sidebar={layout.sidebar}
        data-overlay={overlay ? "true" : undefined}
        data-right={
          !effectiveRight ? "closed" : layout.takeover ? "takeover" : "open"
        }
      >
        {organization.overlays}
        {projectSidebar.overlays}
        {searchOpen && (
          <SearchDialog
            onClose={() => setSearchOpen(false)}
            onOpen={openSearchHit}
          />
        )}
        {settingsOpen && (
          <SettingsDialog
            tab={tab}
            onTab={setTab}
            onClose={() => setSettingsOpen(false)}
            banners={banners}
          >
            {settingsBody()}
          </SettingsDialog>
        )}
        <Rail
          view={view}
          home={home}
          pending={pending}
          sidebarFolded={layout.sidebar !== "expanded"}
          overlay={overlay}
          sidebarButton={railSidebarButton}
          avatar={avatarButton}
          onHome={goHome}
          onNavigate={go}
          onSidebar={railSidebar}
          onSettings={() => openSettings("通用")}
        />
        {showSidebar && (
          <Sidebar
            overlay={overlay}
            sidebarRef={sidebarRef}
            foldButton={foldButton}
            connected={status.connected}
            busy={model.switching}
            view={view}
            projectCount={
              (snapshot?.projects ?? []).filter((p) => !p.archivedAt).length
            }
            projects={projectSidebar.rows}
            projectSort={preferences.projectSort}
            onProjectSort={(sort) => {
              void savePreference("projectSort", sort);
            }}
            onFold={foldSidebar}
            onNew={() => {
              void newConversation();
            }}
            onSearch={() => setSearchOpen(true)}
            onProjects={() => {
              sessionStorage.removeItem("project-selected");
              go("projects");
            }}
            onCreateProject={projectSidebar.create}
            pinned={organization.pinned}
            pinnedSort={preferences.pinnedSort}
            onPinnedSort={(sort) => {
              void savePreference("pinnedSort", sort);
            }}
            folded={{
              pinned: preferences.pinnedFolded,
              projects: preferences.projectsFolded,
            }}
            onFoldSection={(section) => {
              if (section === "pinned")
                void savePreference("pinnedFolded", !preferences.pinnedFolded);
              else
                void savePreference(
                  "projectsFolded",
                  !preferences.projectsFolded,
                );
            }}
            recent={
              <RecentChats
                onFilter={setRecentFilter}
                folded={preferences.recentFolded}
                onFold={(folded) => {
                  void savePreference("recentFolded", folded);
                }}
              >
                {conversationList}
              </RecentChats>
            }
          />
        )}
        <main className="center" aria-label="中栏">
          {!settingsOpen && banners}
          {view === "chat" && (
            <CenterHeader
              rightOpen={effectiveRight}
              toggle={panelToggle}
              onToggle={toggleRight}
            >
              {current && conversationMessages.length > 0 ? (
                <>
                  {renaming?.where === "center" &&
                  renaming.id === current.id ? (
                    <InlineRename
                      conversation={current}
                      className="center-rename"
                      onClose={finishRename}
                    />
                  ) : (
                    <button
                      className="conversation-title"
                      aria-label="修改对话名称"
                      title={current.title}
                      data-center-title
                      disabled={!status.connected || model.switching}
                      onClick={(event) =>
                        startRename(
                          current.id,
                          "center",
                          event.detail === 0,
                          event.currentTarget,
                        )
                      }
                    >
                      {current.title}
                    </button>
                  )}
                  <small className="title-source" aria-label="标题来源">
                    {titleSourceLabels[current.titleSource]}
                  </small>
                  {(organization.counts.get(current.title) ?? 0) > 1 && (
                    <small className="same-name">
                      同名 {organization.counts.get(current.title)}
                    </small>
                  )}
                  {current.archivedAt && (
                    <small className="archived-tag">已归档</small>
                  )}
                  <button
                    className="icon-button conversation-menu-trigger"
                    aria-label="当前对话菜单"
                    aria-haspopup="menu"
                    disabled={!status.connected}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      organization.openMenu(
                        current,
                        rect.left,
                        rect.bottom,
                        "center",
                        event.currentTarget,
                        event.detail === 0,
                      );
                    }}
                  >
                    ⋯
                  </button>
                </>
              ) : (
                <h1 className="center-heading" tabIndex={-1} data-center-title>
                  新对话
                </h1>
              )}
            </CenterHeader>
          )}
          {view === "widgets" && widgetEditor && (
            <CenterHeader
              rightOpen={effectiveRight}
              toggle={panelToggle}
              onToggle={toggleRight}
            >
              <h1 className="center-heading" tabIndex={-1} data-center-title>
                控件编辑
              </h1>
            </CenterHeader>
          )}
          {view === "archived" && (
            <CenterHeader panelToggle={false}>
              <h1 className="center-heading" tabIndex={-1} data-center-title>
                已归档
              </h1>
              <small className="center-count">
                {organization.archived.length} 段对话
              </small>
            </CenterHeader>
          )}
          <div className="viewport">{mainContent()}</div>
        </main>
        {effectiveRight && view === "chat" && (
          <RightPanel
            owner={current ? `${current.title} · 对话` : "新对话"}
            tabs={[
              {
                id: "files",
                name: "文件",
                icon: "file",
                body: (
                  <ConversationFiles
                    source={panelSource}
                    onOpen={openAttachment}
                  />
                ),
              },
              {
                id: "events",
                name: "事件",
                icon: "activity",
                body: <ConversationEvents source={panelSource} />,
              },
            ]}
            layout={layout}
            width={layout.right}
            panelRef={rightPanel}
            takeoverButton={takeoverButton}
            onWidth={(value) => {
              void savePreference(
                "rightPanelWidth",
                value === null ? null : Math.round(value),
              );
            }}
            onPreview={setDragWidth}
            onTakeover={() => setTakeover(!layout.takeover)}
            onClose={closeRight}
          />
        )}
        {effectiveRight && view === "widgets" && widgetEditor && (
          <RightPanel
            owner={`${widgetEditor.name} · 控件`}
            tabs={[
              {
                id: "preview",
                name: "预览",
                icon: "grid",
                body: (
                  <WidgetCandidatePanel
                    key={widgetEditor.id}
                    snapshot={snapshot!}
                    draft={widgetEditor}
                    model={widgetDrafts}
                    connected={status.connected}
                    occluded={searchOpen || overlayOpen || overlay}
                  />
                ),
              },
              {
                id: "events",
                name: "事件",
                icon: "activity",
                body: (
                  <div className="widget-history">
                    {(snapshot?.widgetGeneration?.tasks ?? [])
                      .filter((t) => t.draftId === widgetEditor.id)
                      .map((task) => (
                        <WidgetTaskCard
                          key={task.id}
                          task={task}
                          model={widgetDrafts}
                        />
                      ))}
                  </div>
                ),
              },
            ]}
            layout={layout}
            width={layout.right}
            panelRef={rightPanel}
            takeoverButton={takeoverButton}
            onWidth={(value) => {
              void savePreference(
                "rightPanelWidth",
                value === null ? null : Math.round(value),
              );
            }}
            onPreview={setDragWidth}
            onTakeover={() => setTakeover(!layout.takeover)}
            onClose={closeRight}
          />
        )}
        <div
          ref={setProjectPanelHost}
          className="project-panel-host"
          hidden={
            !["projects", "pending", "records"].includes(view) ||
            (!effectiveRight && !projectFull)
          }
        />
      </div>
    </ProjectColumnsContext.Provider>
  );
}
// This script runs from the document head, before the body is parsed and before the first paint, so the
// appearance and the window title are set first and the page mounts once the body exists.
applyInitialAppearance();
document.title =
  window.desktop.surface === "panel" ? "工作台助手" : displayName;
document.addEventListener("DOMContentLoaded", () => {
  createRoot(document.getElementById("root")!).render(<App />);
});
