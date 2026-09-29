import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Icon } from "./icons";
import { COLUMN, type ColumnLayout } from "./column-layout";

/**
 * The main window's navigation shell: the rail (always present), the sidebar (folded, expanded or floated over
 * the centre), the centre title row and the right column frame. The menu bar panel keeps its own navigation.
 */
export type MainView = "chat" | "widgets" | "projects" | "pending" | "records";

export interface PendingBadge {
  /** Unresolved items as the pending page counts them; kept from the last snapshot while disconnected. */
  count: number;
  connected: boolean;
}

/** Content width of the window, following resizes. */
export function useWindowWidth() {
  const [width, setWidth] = useState(() => innerWidth);
  useEffect(() => {
    const resize = () => setWidth(innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return width;
}

/** True while a modal dialog or a floating menu is open anywhere in the page. */
export function useOverlayOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () =>
      setOpen(
        !!document.querySelector(
          "dialog[open], .conversation-menu, .project-menu",
        ),
      );
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => observer.disconnect();
  }, []);
  return open;
}

export function Rail({
  view,
  home,
  pending,
  sidebarFolded,
  overlay,
  sidebarButton,
  avatar,
  onHome,
  onNavigate,
  onSidebar,
  onSettings,
}: {
  view: MainView;
  /** The centre shows the new-conversation landing page. */
  home: boolean;
  pending: PendingBadge;
  sidebarFolded: boolean;
  overlay: boolean;
  sidebarButton: RefObject<HTMLButtonElement | null>;
  avatar: RefObject<HTMLButtonElement | null>;
  onHome: () => void;
  onNavigate: (view: MainView) => void;
  onSidebar: () => void;
  onSettings: () => void;
}) {
  const pendingLabel =
    "待处理" +
    (pending.count ? `，${pending.count} 项未解决` : "") +
    (pending.connected ? "" : "，未连接");
  const item = (
    name: string,
    icon: string,
    current: boolean,
    run: () => void,
    extra?: { label?: string; badge?: ReactNode },
  ) => (
    <button
      className={`rail-item ${current ? "active" : ""}`}
      aria-current={current ? "page" : undefined}
      aria-label={extra?.label}
      onClick={run}
    >
      <span className="rail-icon">
        <Icon name={icon} />
        {extra?.badge}
      </span>
      <span className="rail-label">{name}</span>
    </button>
  );
  return (
    <nav className="rail" aria-label="全局导航">
      <div className="rail-top">
        <span className="brand-mark" aria-hidden="true">
          <Icon name="spark" />
        </span>
      </div>
      <div className="rail-nav">
        {item("主页", "home", view === "chat" && home, onHome)}
        {item("控件", "grid", view === "widgets", () => onNavigate("widgets"))}
        {item(
          "待处理",
          "inbox",
          view === "pending",
          () => onNavigate("pending"),
          {
            label: pendingLabel,
            badge:
              pending.count > 0 ? (
                <span className="rail-badge" aria-hidden="true">
                  {pending.count > 99 ? "99+" : pending.count}
                </span>
              ) : undefined,
          },
        )}
        {item("记录", "note", view === "records", () => onNavigate("records"))}
        {sidebarFolded && (
          <>
            <span className="rail-sep" aria-hidden="true" />
            <button
              ref={sidebarButton}
              className="rail-item"
              aria-label="展开侧栏"
              aria-expanded={overlay}
              aria-controls="main-sidebar"
              onClick={onSidebar}
            >
              <span className="rail-icon">
                <Icon name="sidebar" />
              </span>
              <span className="rail-label">侧栏</span>
            </button>
          </>
        )}
      </div>
      <button
        ref={avatar}
        className="rail-avatar"
        aria-label="我，个人空间，打开设置"
        aria-haspopup="dialog"
        onClick={onSettings}
      >
        我
      </button>
    </nav>
  );
}

export function Sidebar({
  overlay,
  sidebarRef,
  foldButton,
  connected,
  busy,
  view,
  projectCount,
  onFold,
  onNew,
  onSearch,
  onProjects,
  recent,
}: {
  overlay: boolean;
  sidebarRef: RefObject<HTMLElement | null>;
  foldButton: RefObject<HTMLButtonElement | null>;
  connected: boolean;
  busy: boolean;
  view: MainView;
  projectCount: number;
  onFold: () => void;
  onNew: () => void;
  onSearch: () => void;
  onProjects: () => void;
  recent: ReactNode;
}) {
  return (
    <aside
      ref={sidebarRef}
      id="main-sidebar"
      className="sidebar"
      aria-label="侧栏"
      data-overlay={overlay ? "true" : undefined}
    >
      <div className="side-top">
        <span className="side-title">Assistant</span>
        <button
          ref={foldButton}
          className="icon-button side-fold"
          aria-label="折叠侧栏"
          title="折叠侧栏"
          onClick={onFold}
        >
          <Icon name="sidebar" />
        </button>
      </div>
      <div className="side-fixed">
        <button
          className="nav-item"
          disabled={!connected || busy}
          onClick={onNew}
        >
          <Icon name="compose" />
          <span className="nav-label">新建聊天</span>
        </button>
        <button className="nav-item" title="Command + K" onClick={onSearch}>
          <Icon name="search" />
          <span className="nav-label">搜索</span>
          <kbd aria-hidden="true">⌘K</kbd>
        </button>
      </div>
      <div className="side-scroll">
        <section className="nav-section" aria-labelledby="side-projects-title">
          <div className="section-head">
            <h2 id="side-projects-title" className="section-title">
              项目
            </h2>
          </div>
          <button
            className="nav-item"
            aria-current={view === "projects" ? "page" : undefined}
            onClick={onProjects}
          >
            <Icon name="folder" />
            <span className="nav-label">全部项目 · {projectCount}</span>
          </button>
        </section>
        {recent}
      </div>
    </aside>
  );
}

/** The recent list in the sidebar with its own title-only filter (never a global search). */
export function RecentChats({
  onFilter,
  children,
}: {
  onFilter: (value: string) => void;
  children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [searching, setSearching] = useState(false);
  const [draft, setDraft] = useState("");
  const composing = useRef(false);
  const opened = useRef(false);
  useEffect(() => {
    if (searching && opened.current) input.current?.focus();
    opened.current = true;
  }, [searching]);
  const toggle = () => {
    if (searching) {
      setDraft("");
      onFilter("");
    }
    setSearching(!searching);
  };
  return (
    <section
      className="nav-section recent-chats"
      aria-label="最近聊天"
      id="recent-chats"
    >
      <div className="section-head">
        <h2 className="section-title">最近聊天</h2>
        <button
          className="icon-button"
          aria-label="搜索最近聊天"
          aria-expanded={searching}
          aria-controls="history-query-row"
          onClick={toggle}
        >
          <Icon name="search" />
        </button>
      </div>
      <label
        id="history-query-row"
        className="history-search"
        hidden={!searching}
      >
        <Icon name="search" />
        <input
          ref={input}
          aria-label="搜索最近聊天"
          placeholder="搜索最近聊天"
          value={draft}
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value);
            if (!composing.current) onFilter(event.target.value);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            onFilter(event.currentTarget.value);
          }}
        />
      </label>
      <div className="history-results">{children}</div>
    </section>
  );
}

/** The centre title row for a conversation or the new-conversation page, with the right column switch. */
export function CenterHeader({
  children,
  rightOpen,
  toggle,
  onToggle,
}: {
  children: ReactNode;
  rightOpen: boolean;
  toggle: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
}) {
  return (
    <header className="center-header">
      <div className="center-title">{children}</div>
      <button
        ref={toggle}
        className="icon-button panel-toggle"
        aria-label={rightOpen ? "收起右栏" : "打开右栏"}
        title={rightOpen ? "收起右栏" : "打开右栏"}
        aria-expanded={rightOpen}
        aria-controls="right-panel"
        onClick={onToggle}
      >
        <Icon name="panelRight" />
      </button>
    </header>
  );
}

export interface RightTab {
  id: string;
  name: string;
  icon: string;
  body: ReactNode;
}

/**
 * The right column frame: its owner, widen, take over and close, the content tabs of the current object and
 * the tab body. The separator on its left edge sets the width by pointer or keyboard.
 */
export function RightPanel({
  owner,
  tabs,
  layout,
  width,
  panelRef,
  takeoverButton,
  onWidth,
  onPreview,
  onTakeover,
  onClose,
}: {
  owner: string;
  tabs: RightTab[];
  layout: ColumnLayout;
  /** The width the right column shows now (a drag in progress or the clamped saved width). */
  width: number;
  panelRef: RefObject<HTMLElement | null>;
  takeoverButton: RefObject<HTMLButtonElement | null>;
  /** Saves a width; null restores the default. */
  onWidth: (width: number | null) => void;
  /** Shows a width while dragging without saving it. */
  onPreview: (width: number | null) => void;
  onTakeover: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(tabs[0]?.id);
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  const drag = useRef<{ x: number; start: number; last: number } | null>(null);
  const clamp = (value: number) =>
    Math.round(Math.min(Math.max(value, layout.rightMin), layout.rightMax));
  const compact = width <= 460;
  const atMax = width >= layout.rightMax;
  function keys(event: ReactKeyboardEvent<HTMLDivElement>) {
    const next =
      event.key === "ArrowLeft"
        ? clamp(width + COLUMN.rightStep)
        : event.key === "ArrowRight"
          ? clamp(width - COLUMN.rightStep)
          : event.key === "Home"
            ? layout.rightMax
            : event.key === "End"
              ? layout.rightMin
              : event.key === "Enter"
                ? null
                : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onWidth(next);
  }
  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, start: width, last: width };
  }
  function move(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const next = clamp(drag.current.start + (drag.current.x - event.clientX));
    drag.current.last = next;
    onPreview(next);
  }
  function up() {
    if (!drag.current) return;
    const { last, start } = drag.current;
    drag.current = null;
    onPreview(null);
    if (last !== start) onWidth(last);
  }
  return (
    <>
      {!layout.takeover && (
        <div
          className="right-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右栏宽度"
          aria-controls="right-panel"
          aria-valuenow={width}
          aria-valuemin={layout.rightMin}
          aria-valuemax={layout.rightMax}
          tabIndex={0}
          onKeyDown={keys}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onDoubleClick={() => onWidth(null)}
        />
      )}
      <aside
        ref={panelRef}
        id="right-panel"
        className="right-panel"
        aria-label="右栏"
        data-takeover={layout.takeover ? "true" : undefined}
        style={layout.takeover ? undefined : { width }}
      >
        <div className="right-head">
          <span className="right-owner" title={owner}>
            所属：{owner}
          </span>
          {!layout.takeover && (
            <button
              className="icon-button"
              aria-label={atMax ? "恢复右栏默认宽度" : "拉宽右栏"}
              title={atMax ? "恢复右栏默认宽度" : "拉宽右栏"}
              onClick={() => onWidth(atMax ? null : layout.rightMax)}
            >
              <Icon name={atMax ? "narrow" : "widen"} />
            </button>
          )}
          {!layout.takeoverOnly && (
            <button
              ref={takeoverButton}
              className="icon-button"
              aria-label={layout.takeover ? "退出接管" : "接管中栏"}
              title={layout.takeover ? "退出接管" : "接管中栏"}
              aria-pressed={layout.takeover}
              onClick={onTakeover}
            >
              <Icon name="takeover" />
            </button>
          )}
          <button
            className="icon-button"
            aria-label="收起右栏"
            title="收起右栏"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="right-tabs" role="tablist" aria-label="右栏内容">
          {tabs.map((t) => {
            const selected = t.id === current?.id;
            return (
              <button
                key={t.id}
                role="tab"
                id={`right-tab-${t.id}`}
                aria-selected={selected}
                aria-controls="right-tabpanel"
                aria-label={t.name}
                title={t.name}
                tabIndex={selected ? 0 : -1}
                onClick={() => setTab(t.id)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft")
                    return;
                  event.preventDefault();
                  const index = tabs.indexOf(t);
                  const next =
                    tabs[
                      (index +
                        (event.key === "ArrowRight" ? 1 : -1) +
                        tabs.length) %
                        tabs.length
                    ];
                  setTab(next.id);
                  document.getElementById(`right-tab-${next.id}`)?.focus();
                }}
              >
                <Icon name={t.icon} />
                {(!compact || selected) && <span>{t.name}</span>}
              </button>
            );
          })}
        </div>
        <div
          className="right-body"
          role="tabpanel"
          id="right-tabpanel"
          aria-labelledby={current ? `right-tab-${current.id}` : undefined}
        >
          {current?.body}
        </div>
      </aside>
    </>
  );
}
