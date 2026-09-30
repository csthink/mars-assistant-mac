import { openModal, refocus } from "./modal-focus";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import type {
  Conversation,
  ConversationAction,
  PinnedRef,
  PinnedSort,
  Snapshot,
} from "../shared/protocol";
import type { Project } from "../shared/projects";
import { pinnedObjects, type PinnedObject } from "./project-lists";
import {
  dateGroupLabels,
  nextMidnight,
  recentGroups,
  sameNameCounts,
} from "./conversation-lists";
import { InlineRename } from "./conversation-title";
import { Icon } from "./icons";
function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    return openModal(ref.current!);
  }, []);
  return (
    <dialog
      ref={ref}
      className="rename-dialog organization-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="organization-heading">
        <h2>{title}</h2>
        <button aria-label="关闭" onClick={close}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
function date(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
/** Last activity: the time of day for today, otherwise the date. */
export function activityTime(value: string) {
  return new Date(value).toLocaleDateString() ===
    new Date().toLocaleDateString()
    ? new Date(value).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : new Date(value).toLocaleDateString("zh-CN", {
        month: "numeric",
        day: "numeric",
      });
}
/** Where a conversation menu was opened: a sidebar row (pinned or recent), the centre title or the panel. */
export type MenuOrigin = "pinned" | "recent" | "center" | "panel";
/** Where renaming starts: a menu (by its origin) or the ⌥⌘R shortcut on the current conversation. */
export type RenameOrigin = MenuOrigin | "shortcut";
/** Inline renaming in progress in the main window: the row in the sidebar or the centre title. */
export interface Renaming {
  id: string;
  where: "sidebar" | "center";
}
/** The current date, moving on at each local midnight so the date groups follow the calendar. */
function useToday() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setTimeout(
      () => setNow(new Date()),
      Math.max(1000, nextMidnight(now) - Date.now() + 1000),
    );
    return () => clearTimeout(timer);
  }, [now]);
  return now;
}
const short = (id: string) => id.slice(0, 8);
const pinnedRef = (row: PinnedObject): PinnedRef => ({
  kind: row.kind,
  id: row.value.id,
});
const pinnedKey = (ref: PinnedRef) => `${ref.kind}:${ref.id}`;
export interface PinnedProjectDrag {
  draggable: boolean;
  over?: "before" | "after";
  dragging: boolean;
  onDragStart: (event: DragEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
  onDragEnd: () => void;
}
export function useOrganization({
  page,
  snapshot,
  connected,
  currentId,
  dirty,
  select,
  rename,
  notice,
  filter = "",
  highlightCurrent = true,
  pinnedSort = "pinned",
  renderPinnedProject,
  renaming,
  onRenameDone,
  onArchived,
}: {
  page: string;
  snapshot: Snapshot | undefined;
  connected: boolean;
  currentId: string | undefined;
  dirty: (id: string) => boolean;
  select: (id: string) => Promise<boolean>;
  /** Starts renaming; keyboard tells whether the entry was reached by keyboard (its focus ring comes back). */
  rename: (id: string, origin: RenameOrigin, keyboard: boolean) => void;
  notice: (message: string) => void;
  /** Title-only filter for the recent list (the sidebar's in-list search); never a global search. */
  filter?: string;
  /** Mark the current conversation's row; off while the centre shows another object. */
  highlightCurrent?: boolean;
  /** Order of the pinned section in the main window. */
  pinnedSort?: PinnedSort;
  renderPinnedProject?: (
    project: Project,
    drag: PinnedProjectDrag,
  ) => ReactNode;
  /** Inline renaming of a sidebar row in the main window. */
  renaming?: Renaming;
  onRenameDone?: () => void;
  /** Opens the archived page in the main window's centre (the panel keeps the archived dialog). */
  onArchived?: () => void;
}) {
  const [menu, setMenu] = useState<{
    id: string;
    x: number;
    y: number;
    origin: MenuOrigin;
    trigger: HTMLElement | null;
    keyboard: boolean;
  }>();
  const [archive, setArchive] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [confirm, setConfirm] = useState<{
    conversation: Conversation;
    action: "delete" | "purge";
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<{
    ref: PinnedRef;
    over?: PinnedRef;
    after?: boolean;
  }>();
  const [undo, setUndo] = useState<{
    id: string;
    page: string;
    currentId: string | undefined;
    revision: number;
  }>();
  const now = useToday();
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(undefined), 5000);
    return () => clearTimeout(timer);
  }, [undo]);
  useEffect(() => {
    if (
      undo &&
      (page !== undo.page ||
        ((snapshot?.revision ?? -1) >= undo.revision &&
          currentId !== undo.currentId))
    )
      setUndo(undefined);
  }, [page, currentId, snapshot?.revision, undo]);
  // A menu closes when the page scrolls or the window changes size (it would no longer sit at its entry).
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (
        event.type === "scroll" &&
        (event.target as Element | null)?.closest?.(".conversation-menu")
      )
        return;
      setMenu(undefined);
    };
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [menu]);
  const target = snapshot?.conversations.find(
    (c) => c.id === menu?.id && !c.deletedAt,
  );
  function openMenu(
    c: Conversation,
    x: number,
    y: number,
    origin: MenuOrigin = "panel",
    trigger: HTMLElement | null = null,
    keyboard = false,
  ) {
    if (!connected) return;
    setError("");
    setCopyOpen(false);
    setMenu({
      id: c.id,
      x: Math.max(8, Math.min(x, innerWidth - 248)),
      y: Math.max(8, Math.min(y, innerHeight - 380)),
      origin,
      trigger,
      keyboard,
    });
  }
  /** Closes the menu and gives focus back to its entry, with a ring only when it was opened by keyboard. */
  function closeMenu() {
    const entry = menu?.trigger;
    const keyboard = menu?.keyboard ?? false;
    setMenu(undefined);
    if (entry?.isConnected)
      requestAnimationFrame(() => refocus(entry, keyboard));
  }
  /** After a row moves between the pinned section and the recent list, focus follows it to its menu button. */
  function followRow(id: string, keyboard: boolean) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        refocus(
          document.querySelector<HTMLElement>(
            `#main-sidebar [aria-label="对话菜单 ${short(id)}"]`,
          ),
          keyboard,
        ),
      ),
    );
  }
  async function act(
    c: Conversation,
    action: ConversationAction,
    confirmed = false,
  ) {
    if (busy || !connected) return false;
    if ((action === "delete" || action === "purge") && dirty(c.id)) {
      setError("当前输入尚未保存，请先处理保存状态。");
      notice("当前输入尚未保存，请先处理保存状态。");
      return false;
    }
    if ((action === "delete" || action === "purge") && !confirmed) {
      setConfirm({ conversation: c, action });
      setMenu(undefined);
      setError("");
      return false;
    }
    const opened = menu;
    setBusy(true);
    setError("");
    try {
      const reply = await window.desktop.command({
        type: "organizeConversation",
        id: c.id,
        action,
        revision: c.organizationRevision,
        confirmed,
      });
      if (!reply.ok) {
        setError(reply.message);
        notice(reply.message);
        return false;
      }
      setMenu(undefined);
      setConfirm(undefined);
      if (
        (action === "pin" || action === "unpin") &&
        opened &&
        (opened.origin === "pinned" || opened.origin === "recent")
      )
        followRow(c.id, opened.keyboard);
      else if (opened?.trigger?.isConnected)
        requestAnimationFrame(() => refocus(opened.trigger, opened.keyboard));
      if (action === "delete") {
        setUndo({
          id: c.id,
          page,
          currentId:
            reply.snapshot.selected[window.desktop.surface] ??
            reply.snapshot.selected.main ??
            undefined,
          revision: reply.snapshot.revision,
        });
      }
      if (action === "restore") setUndo(undefined);
      return true;
    } catch {
      setError("操作未完成，请核对连接后重试。");
      return false;
    } finally {
      setBusy(false);
    }
  }
  /** Moves one pinned object in the shared manual order. */
  async function move(row: PinnedObject, before: PinnedRef | null) {
    if (busy || !connected) return false;
    setBusy(true);
    try {
      const reply = await window.desktop.command({
        type: "movePinned",
        kind: row.kind,
        id: row.value.id,
        before,
        revision:
          row.kind === "conversation"
            ? row.value.organizationRevision
            : row.value.revision,
      });
      if (!reply.ok) {
        notice(`顺序未改变：${reply.message}`);
        return false;
      }
      return true;
    } catch {
      notice("顺序未改变，请核对连接后重试。");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function copy(c: Conversation, kind: "link" | "markdown") {
    const reply = await window.desktop.copyConversation(c.id, kind);
    if (reply.ok) {
      notice(kind === "link" ? "已复制对话链接" : "已复制为 Markdown");
      setMenu(undefined);
    } else notice(reply.message);
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || document.querySelector("dialog[open]") || !connected)
        return;
      if (e.key === "Escape") {
        if (menu) {
          e.preventDefault();
          closeMenu();
        }
        return;
      }
      if (
        menu &&
        e.key === "Tab" &&
        document.activeElement?.closest(".conversation-menu")
      ) {
        setMenu(undefined);
        return;
      }
      const c = snapshot?.conversations.find(
        (c) => c.id === currentId && !c.deletedAt,
      );
      if (!c) return;
      if (e.metaKey && e.altKey && e.code === "KeyR") {
        e.preventDefault();
        rename(c.id, "shortcut", true);
      } else if (e.metaKey && e.altKey && e.code === "KeyP") {
        e.preventDefault();
        void act(c, c.pinnedAt ? "unpin" : "pin");
      } else if (e.metaKey && e.shiftKey && e.code === "KeyU") {
        e.preventDefault();
        void act(c, c.unread ? "read" : "unread");
      } else if (e.metaKey && e.shiftKey && e.code === "KeyA") {
        e.preventDefault();
        void act(c, c.archivedAt ? "unarchive" : "archive");
      } else if (e.metaKey && e.shiftKey && e.code === "KeyC") {
        e.preventDefault();
        void copy(c, "link");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const conversations = snapshot?.conversations ?? [];
  const recent = conversations.filter((c) => !c.archivedAt && !c.deletedAt);
  const archived = conversations.filter((c) => c.archivedAt && !c.deletedAt);
  const deleted = conversations.filter((c) => c.deletedAt);
  const counts = sameNameCounts(conversations);
  const pinned = pinnedObjects(
    conversations,
    snapshot?.projects ?? [],
    pinnedSort,
    snapshot?.pinnedOrder ?? [],
  );
  const manual = pinnedSort === "manual";
  function dropOn(ref: PinnedRef, event: DragEvent) {
    if (!drag || pinnedKey(drag.ref) === pinnedKey(ref)) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    setDrag({ ...drag, over: ref, after });
  }
  async function drop() {
    if (!drag?.over) return setDrag(undefined);
    const moving = pinned.find(
      (row) => pinnedKey(pinnedRef(row)) === pinnedKey(drag.ref),
    );
    const rows = pinned.filter(
      (row) => pinnedKey(pinnedRef(row)) !== pinnedKey(drag.ref),
    );
    const index =
      rows.findIndex(
        (row) => pinnedKey(pinnedRef(row)) === pinnedKey(drag.over!),
      ) + (drag.after ? 1 : 0);
    setDrag(undefined);
    if (moving) await move(moving, rows[index] ? pinnedRef(rows[index]) : null);
  }
  function item(c: Conversation, section: "pinned" | "recent") {
    const current = highlightCurrent && currentId === c.id;
    const editing =
      renaming?.where === "sidebar" && renaming.id === c.id && !!onRenameDone;
    const draggable = section === "pinned" && manual && !editing;
    const ref: PinnedRef = { kind: "conversation", id: c.id };
    return (
      <div
        key={c.id}
        className={`session-line ${current ? "active" : ""} ${drag?.over && pinnedKey(drag.over) === pinnedKey(ref) ? (drag.after ? "drop-after" : "drop-before") : ""} ${drag && pinnedKey(drag.ref) === pinnedKey(ref) ? "dragging" : ""}`}
        data-conversation={c.id}
        draggable={draggable || undefined}
        onDragStart={
          draggable
            ? (event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", c.id);
                setDrag({ ref });
              }
            : undefined
        }
        onDragOver={draggable ? (event) => dropOn(ref, event) : undefined}
        onDrop={
          draggable
            ? (event) => {
                event.preventDefault();
                void drop();
              }
            : undefined
        }
        onDragEnd={draggable ? () => setDrag(undefined) : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(
            c,
            e.clientX,
            e.clientY,
            section,
            e.currentTarget.querySelector<HTMLElement>(".session-more"),
          );
        }}
      >
        {draggable && (
          <span className="drag-grip" aria-hidden="true" title="拖动调整顺序">
            <Icon name="grip" />
          </span>
        )}
        {editing ? (
          <InlineRename
            conversation={c}
            className="session-rename"
            onClose={onRenameDone!}
          />
        ) : (
          <button
            className={`session ${c.unread ? "unread" : ""}`}
            aria-label={`对话 ${short(c.id)}`}
            aria-current={current ? "true" : undefined}
            title={`${c.title} · ${date(c.updatedAt)} · ${short(c.id)}`}
            onClick={() => {
              void select(c.id);
            }}
          >
            {section === "pinned" && <Icon name="chat" />}
            {c.unread && <span className="unread-dot" aria-label="未读" />}
            <span className="session-name">{c.title}</span>
            {(counts.get(c.title) ?? 0) > 1 && (
              <small className="same-name">同名 {counts.get(c.title)}</small>
            )}
            <time dateTime={c.updatedAt}>{activityTime(c.updatedAt)}</time>
            {dirty(c.id) && <span className="unsaved">未保存</span>}
          </button>
        )}
        <button
          className="session-more"
          aria-label={`对话菜单 ${short(c.id)}`}
          aria-haspopup="menu"
          aria-expanded={menu?.id === c.id && menu.origin === section}
          disabled={!connected}
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            openMenu(
              c,
              box.right,
              box.bottom,
              section,
              e.currentTarget,
              e.detail === 0,
            );
          }}
        >
          ⋯
        </button>
      </div>
    );
  }
  const groups = recentGroups(conversations, now, filter);
  const needle = filter.trim();
  const list = (
    <>
      <div className="sessions" aria-label="最近对话">
        {groups.map(({ group, items }) => (
          <div
            key={group}
            className="session-date-group"
            role="group"
            aria-label={dateGroupLabels[group]}
          >
            <div className="session-group" aria-hidden="true">
              {dateGroupLabels[group]}
            </div>
            {items.map((c) => item(c, "recent"))}
          </div>
        ))}
        {!groups.length && (
          <p className="session-empty" role={needle ? "status" : undefined}>
            {needle ? "没有匹配的对话" : "新的想法，从一段对话开始。"}
          </p>
        )}
      </div>
      <button
        className="archived-entry"
        aria-current={page === "archived" ? "page" : undefined}
        onClick={() => {
          setError("");
          if (onArchived) onArchived();
          else setArchive(true);
        }}
      >
        已归档 <span>{archived.length}</span>
      </button>
    </>
  );
  const pinnedList = pinned.length ? (
    <div className="sessions" aria-label="已置顶对象">
      {pinned.map((row) => {
        if (row.kind === "conversation") return item(row.value, "pinned");
        const ref = pinnedRef(row);
        return renderPinnedProject?.(row.value, {
          draggable: manual,
          over:
            drag?.over && pinnedKey(drag.over) === pinnedKey(ref)
              ? drag.after
                ? "after"
                : "before"
              : undefined,
          dragging: !!drag && pinnedKey(drag.ref) === pinnedKey(ref),
          onDragStart: (event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", pinnedKey(ref));
            setDrag({ ref });
          },
          onDragOver: (event) => dropOn(ref, event),
          onDrop: (event) => {
            event.preventDefault();
            void drop();
          },
          onDragEnd: () => setDrag(undefined),
        });
      })}
    </div>
  ) : null;
  const trash = (
    <>
      <p>至少保留30天。到期后由你选择清理或延长，不会自动永久删除。</p>
      <h3>对话</h3>
      {deleted.length ? (
        <ul className="organized-list">
          {deleted.map((c) => (
            <li key={c.id}>
              <strong>{c.title}</strong>
              <small>
                {short(c.id)} ·{" "}
                {Date.parse(c.retainUntil!) < Date.now()
                  ? "已到期，可延长或清理"
                  : `保留至 ${date(c.retainUntil!)}`}
              </small>
              <div className="row">
                <button
                  className="button"
                  disabled={!connected || busy}
                  onClick={() => void act(c, "restore")}
                >
                  恢复
                </button>
                <button
                  className="button"
                  disabled={!connected || busy}
                  onClick={() => void act(c, "extend")}
                >
                  延长30天
                </button>
                <button
                  className="button danger"
                  disabled={!connected || busy}
                  onClick={() => void act(c, "purge")}
                >
                  永久删除…
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p>没有已删除的对话。</p>
      )}
      <h3>控件</h3>
      <p>暂无已删除控件。</p>
    </>
  );
  // Up and down are the keyboard way to reorder the pinned section in manual order.
  const pinnedIndex =
    menu?.origin === "pinned" && manual && target
      ? pinned.findIndex(
          (row) => row.kind === "conversation" && row.value.id === target.id,
        )
      : -1;
  const overlays = (
    <>
      {menu && target && (
        <>
          <div
            className="menu-dismiss"
            onPointerDown={() => setMenu(undefined)}
          />
          <div
            className="conversation-menu"
            role="menu"
            aria-label="对话菜单"
            style={{ left: menu.x, top: menu.y }}
            onKeyDown={(e) => {
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                const buttons = Array.from(
                  e.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                );
                let i = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                i =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? buttons.length - 1
                      : (i +
                          (e.key === "ArrowDown" ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
                buttons[i]?.focus();
              }
            }}
          >
            <button
              role="menuitem"
              autoFocus
              onClick={(e) => {
                const keyboard = e.detail === 0;
                const origin = menu.origin;
                setMenu(undefined);
                rename(target.id, origin, keyboard);
              }}
            >
              重命名 <kbd>⌥⌘R</kbd>
            </button>
            <button
              role="menuitem"
              disabled={busy}
              onClick={() =>
                void act(target, target.pinnedAt ? "unpin" : "pin")
              }
            >
              {target.pinnedAt ? "取消置顶" : "置顶"}
              <kbd>⌥⌘P</kbd>
            </button>
            <button
              role="menuitem"
              disabled={busy}
              onClick={() =>
                void act(target, target.unread ? "read" : "unread")
              }
            >
              {target.unread ? "标记为已读" : "标记为未读"}
              <kbd>⇧⌘U</kbd>
            </button>
            <button
              role="menuitem"
              disabled={busy}
              onClick={() =>
                void act(target, target.archivedAt ? "unarchive" : "archive")
              }
            >
              {target.archivedAt ? "取消归档" : "归档"}
              <kbd>⇧⌘A</kbd>
            </button>
            <hr />
            <button
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={copyOpen}
              onClick={() => setCopyOpen(!copyOpen)}
            >
              复制 <span aria-hidden="true">{copyOpen ? "⌃" : "⌄"}</span>
            </button>
            {copyOpen && (
              <div role="menu" aria-label="复制" className="copy-submenu">
                <button
                  role="menuitem"
                  onClick={() => void copy(target, "link")}
                >
                  复制对话链接<kbd>⇧⌘C</kbd>
                </button>
                <button
                  role="menuitem"
                  onClick={() => void copy(target, "markdown")}
                >
                  复制为 Markdown
                </button>
                <button
                  role="menuitem"
                  disabled
                  title="对话关联本地 Agent 工作目录后可用"
                >
                  复制工作目录
                </button>
              </div>
            )}
            <hr />
            <button
              role="menuitem"
              className="danger"
              disabled={busy}
              onClick={() => void act(target, "delete")}
            >
              删除对话…
            </button>
            {pinnedIndex >= 0 && (
              <>
                <hr />
                <button
                  role="menuitem"
                  disabled={busy || pinnedIndex === 0}
                  onClick={async (e) => {
                    const keyboard = e.detail === 0;
                    setMenu(undefined);
                    if (
                      await move(
                        { kind: "conversation", value: target },
                        pinnedRef(pinned[pinnedIndex - 1]),
                      )
                    )
                      followRow(target.id, keyboard);
                  }}
                >
                  上移
                </button>
                <button
                  role="menuitem"
                  disabled={busy || pinnedIndex === pinned.length - 1}
                  onClick={async (e) => {
                    const keyboard = e.detail === 0;
                    setMenu(undefined);
                    if (
                      await move(
                        { kind: "conversation", value: target },
                        pinned[pinnedIndex + 2]
                          ? pinnedRef(pinned[pinnedIndex + 2])
                          : null,
                      )
                    )
                      followRow(target.id, keyboard);
                  }}
                >
                  下移
                </button>
              </>
            )}
          </div>
        </>
      )}
      {archive && (
        <Modal title="已归档对话" close={() => setArchive(false)}>
          {archived.length ? (
            <ul className="organized-list">
              {archived.map((c) => (
                <li key={c.id}>
                  <strong>{c.title}</strong>
                  <small>
                    {date(c.updatedAt)} · {short(c.id)}
                  </small>
                  <div className="row">
                    <button
                      className="button"
                      disabled={!connected || busy}
                      onClick={async () => {
                        if (await select(c.id)) setArchive(false);
                      }}
                    >
                      查看
                    </button>
                    <button
                      className="button"
                      disabled={!connected || busy}
                      onClick={async () => {
                        if ((await act(c, "unarchive")) && (await select(c.id)))
                          setArchive(false);
                      }}
                    >
                      取消归档并打开
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p>没有已归档对话。</p>
          )}
          {error && <p role="alert">{error}</p>}
        </Modal>
      )}
      {confirm && (
        <Modal
          title={confirm.action === "purge" ? "永久删除对话" : "删除对话"}
          close={() => {
            if (!busy) setConfirm(undefined);
          }}
        >
          <p>“{confirm.conversation.title}”</p>
          <p>
            {confirm.action === "purge"
              ? "标题、消息和草稿将永久删除，无法恢复。运行事件会保留。"
              : "对话将移至最近删除，至少保留30天，可随时恢复。消息与草稿会保留。"}
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="dialog-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => setConfirm(undefined)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={busy || !connected}
              onClick={() =>
                void act(confirm.conversation, confirm.action, true)
              }
            >
              {confirm.action === "purge" ? "确认永久删除" : "确认删除"}
            </button>
          </div>
        </Modal>
      )}
      {undo &&
        page === undo.page &&
        currentId === undo.currentId &&
        deleted.some((c) => c.id === undo.id) && (
          <div className="organization-undo" role="status">
            <span>对话已移至最近删除，至少保留30天。</span>
            <button
              disabled={busy || !connected}
              onClick={() =>
                void act(
                  deleted.find((c) => c.id === undo.id)!,
                  "restore",
                )
              }
            >
              撤销删除
            </button>
            <button
              aria-label="关闭撤销提示"
              onClick={() => setUndo(undefined)}
            >
              ×
            </button>
          </div>
        )}
    </>
  );
  return {
    list,
    pinned: pinnedList,
    trash,
    overlays,
    openMenu,
    act,
    archived,
    counts,
    recentCount: recent.length,
  };
}
