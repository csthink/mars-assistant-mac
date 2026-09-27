import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Icon } from "./icons";

/** The five pages share one set of visible names across the main window and the panel; nothing persists them. */
export type Page = "聊天" | "工作台" | "待处理" | "运行记录" | "设置";
/** Pages on which the chat tool group (new, recent, search) is shown, following the prototype's home header. */
const toolPages: Page[] = ["聊天", "工作台", "设置"];
export type Popover = "profile" | "recent";

export interface PendingBadge {
  /** Unresolved items as the pending page counts them; kept from the last snapshot while disconnected. */
  count: number;
  connected: boolean;
}

/** A menu or dialog owned by another component is open: popovers leave Escape and outside clicks to it. */
function ownedByOverlay(target?: EventTarget | null) {
  if (document.querySelector("dialog[open]")) return true;
  const node = target instanceof Element ? target : null;
  return (
    !!node?.closest(".conversation-menu, .menu-dismiss") ||
    !!document.querySelector(".conversation-menu")
  );
}

/**
 * Non-modal anchored popover: closes on Escape (focus returns to the trigger) and on pointerdown outside
 * itself and its trigger; clicks inside never close it. Repositions under its anchor on resize.
 */
function useAnchoredPopover({
  open,
  trigger,
  popover,
  onClose,
  place,
}: {
  open: boolean;
  trigger: RefObject<HTMLElement | null>;
  popover: RefObject<HTMLElement | null>;
  onClose: (restoreFocus: boolean) => void;
  place: (anchor: DOMRect, box: HTMLElement) => void;
}) {
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (anchor && popover.current) place(anchor, popover.current);
    };
    reposition();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [open, trigger, popover, place]);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        popover.current?.contains(target) ||
        trigger.current?.contains(target) ||
        ownedByOverlay(event.target)
      )
        return;
      onClose(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (ownedByOverlay(event.target)) return;
      event.preventDefault();
      onClose(true);
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", key);
    };
  }, [open, trigger, popover, onClose]);
}

function placeBelowRight(anchor: DOMRect, box: HTMLElement) {
  const width = box.offsetWidth;
  box.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
  box.style.top = `${anchor.bottom + 10}px`;
  box.style.maxHeight = `${Math.max(0, innerHeight - anchor.bottom - 18)}px`;
}
function placeBelowLeft(anchor: DOMRect, box: HTMLElement) {
  const group = document
    .querySelector(".home-history-actions")
    ?.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(group?.left ?? anchor.left, innerWidth - box.offsetWidth - 8),
  );
  const top = (group?.bottom ?? anchor.bottom) + 14;
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.maxHeight = `${Math.max(0, innerHeight - top - 16)}px`;
  box.style.setProperty(
    "--history-arrow",
    `${Math.max(20, Math.min(anchor.left + anchor.width / 2 - left - 8, box.offsetWidth - 36))}px`,
  );
}

/** Roving focus inside a menu: arrows wrap, Home/End jump, Enter and Space activate the focused item. */
function menuKeys(event: ReactKeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    ),
  );
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
          items.length;
  items[next]?.focus();
}

export function HomeHeader({
  page,
  onNavigate,
  connected,
  busy,
  onNew,
  onSearch,
  popover,
  onToggle,
  pending,
  recentTrigger,
  avatarTrigger,
}: {
  page: Page;
  onNavigate: (page: Page) => void;
  connected: boolean;
  busy: boolean;
  onNew: () => void;
  onSearch: () => void;
  popover: Popover | undefined;
  onToggle: (popover: Popover) => void;
  pending: PendingBadge;
  recentTrigger: RefObject<HTMLButtonElement | null>;
  avatarTrigger: RefObject<HTMLButtonElement | null>;
}) {
  const label =
    "我，个人空间" +
    (pending.count ? `，${pending.count} 项待处理` : "") +
    (pending.connected ? "" : "，未连接");
  const tools = toolPages.includes(page);
  return (
    <header className={`home-header ${tools ? "" : "home-header-compact"}`}>
      {tools ? (
        <div className="home-history-actions">
          <button
            className="home-tool"
            aria-label="新建对话"
            disabled={!connected || busy}
            onClick={onNew}
          >
            <Icon name="compose" />
            <span>新建</span>
          </button>
          <span className="home-divider" aria-hidden="true" />
          <button
            ref={recentTrigger}
            id="history-trigger"
            className="home-tool history-trigger"
            aria-controls="home-history"
            aria-expanded={popover === "recent"}
            onClick={() => onToggle("recent")}
          >
            <Icon name="clock" />
            <span>最近聊天</span>
          </button>
          <button
            className="home-tool home-global-search"
            aria-label="全局搜索"
            title="Command + K"
            onClick={onSearch}
          >
            <Icon name="search" />
            <span>搜索</span>
            <kbd>⌘ K</kbd>
          </button>
        </div>
      ) : (
        <div className="home-history-placeholder" aria-hidden="true" />
      )}
      <nav className="home-nav" aria-label="主要页面">
        {(
          [
            ["聊天", "chat"],
            ["工作台", "grid"],
          ] as [Page, string][]
        ).map(([name, icon]) => (
          <button
            key={name}
            className={page === name ? "selected" : ""}
            aria-current={page === name ? "page" : undefined}
            onClick={() => onNavigate(name)}
          >
            <Icon name={icon} />
            <span>{name}</span>
          </button>
        ))}
      </nav>
      <div className="home-account">
        <button
          ref={avatarTrigger}
          id="profile-trigger"
          className="home-avatar"
          aria-label={label}
          aria-haspopup="menu"
          aria-controls="profile-menu"
          aria-expanded={popover === "profile"}
          onClick={() => onToggle("profile")}
        >
          我
          {pending.count > 0 && (
            <i className="profile-pending-dot" aria-hidden="true" />
          )}
        </button>
      </div>
    </header>
  );
}

export function ProfileMenu({
  page,
  pending,
  trigger,
  onNavigate,
  onClose,
}: {
  page: Page;
  pending: PendingBadge;
  trigger: RefObject<HTMLButtonElement | null>;
  onNavigate: (page: Page) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const box = useRef<HTMLElement>(null);
  useAnchoredPopover({
    open: true,
    trigger,
    popover: box,
    onClose,
    place: placeBelowRight,
  });
  useEffect(() => {
    box.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus({ preventScroll: true });
  }, []);
  const item = (name: Page, icon: string, suffix?: ReactNode) => (
    <button
      role="menuitem"
      className={`profile-menu-item ${page === name ? "selected" : ""}`}
      aria-current={page === name ? "page" : undefined}
      onClick={() => {
        onNavigate(name);
        onClose(false);
      }}
    >
      <Icon name={icon} />
      <span>{name === "运行记录" ? "记录" : name}</span>
      {suffix}
    </button>
  );
  return (
    <section
      ref={box}
      id="profile-menu"
      className="profile-menu"
      aria-label="个人空间"
    >
      <div className="profile-menu-heading">
        <span className="profile-menu-avatar" aria-hidden="true">
          我
        </span>
        <div>
          <strong>个人空间</strong>
          <small>保存在这台 Mac 上</small>
        </div>
      </div>
      <div role="menu" aria-label="个人空间操作" onKeyDown={menuKeys}>
        {item(
          "待处理",
          "inbox",
          <span
            className="profile-menu-count"
            aria-label={`${pending.count} 项待处理${pending.connected ? "" : "，未连接"}`}
          >
            {pending.count}
          </span>,
        )}
        {item("运行记录", "note")}
        <div className="profile-menu-divider" role="separator" />
        {item("设置", "settings")}
      </div>
    </section>
  );
}

export function RecentChatsPopover({
  trigger,
  onClose,
  filter,
  onFilter,
  children,
}: {
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: (restoreFocus: boolean) => void;
  /** Committed title filter; the popover keeps the raw input while an IME composition is in progress. */
  filter: string;
  onFilter: (value: string) => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const [searching, setSearching] = useState(false);
  const [draft, setDraft] = useState(filter);
  const composing = useRef(false);
  useAnchoredPopover({
    open: true,
    trigger,
    popover: box,
    onClose,
    place: placeBelowLeft,
  });
  // As in the prototype, opening moves focus into the popover (its search toggle) so Tab reaches the rows.
  useEffect(() => {
    searchToggle.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (searching) input.current?.focus({ preventScroll: true });
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
      ref={box}
      id="home-history"
      className="home-history"
      aria-label="最近聊天"
    >
      <div className="history-heading">
        <h2>最近聊天</h2>
        <button
          ref={searchToggle}
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

/** Keeps a popover's open state and returns focus to the trigger when a keyboard close asks for it. */
export function usePopover() {
  const [open, setOpen] = useState<Popover>();
  const current = useRef<Popover>(undefined);
  current.current = open;
  const recentTrigger = useRef<HTMLButtonElement>(null);
  const avatarTrigger = useRef<HTMLButtonElement>(null);
  const close = (restoreFocus: boolean) => {
    if (restoreFocus)
      (current.current === "recent"
        ? recentTrigger
        : avatarTrigger
      ).current?.focus({ preventScroll: true });
    setOpen(undefined);
  };
  const toggle = (popover: Popover) =>
    setOpen(current.current === popover ? undefined : popover);
  return { open, close, toggle, recentTrigger, avatarTrigger };
}
