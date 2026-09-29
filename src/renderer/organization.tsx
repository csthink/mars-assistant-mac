import { openModal } from "./modal-focus";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  Conversation,
  ConversationAction,
  Snapshot,
} from "../shared/protocol";
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
}: {
  page: string;
  snapshot: Snapshot | undefined;
  connected: boolean;
  currentId: string | undefined;
  dirty: (id: string) => boolean;
  select: (id: string) => Promise<boolean>;
  rename: (id: string) => void;
  notice: (message: string) => void;
  /** Title-only filter for the recent list (the sidebar's in-list search); never a global search. */
  filter?: string;
  /** Mark the current conversation's row; off while the centre shows another object. */
  highlightCurrent?: boolean;
}) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
  const [archive, setArchive] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [confirm, setConfirm] = useState<{
    conversation: Conversation;
    action: "delete" | "purge";
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{
    id: string;
    page: string;
    currentId: string | undefined;
    revision: number;
  }>();
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
  const target = snapshot?.conversations.find(
    (c) => c.id === menu?.id && !c.deletedAt,
  );
  function openMenu(c: Conversation, x: number, y: number) {
    if (!connected) return;
    setError("");
    setCopyOpen(false);
    setMenu({
      id: c.id,
      x: Math.max(8, Math.min(x, innerWidth - 248)),
      y: Math.max(8, Math.min(y, innerHeight - 330)),
    });
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
        setMenu(undefined);
        return;
      }
      const c = snapshot?.conversations.find(
        (c) => c.id === currentId && !c.deletedAt,
      );
      if (!c) return;
      if (e.metaKey && e.altKey && e.code === "KeyR") {
        e.preventDefault();
        rename(c.id);
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
  const recent = (snapshot?.conversations ?? []).filter(
    (c) => !c.archivedAt && !c.deletedAt,
  );
  const archived = (snapshot?.conversations ?? []).filter(
    (c) => c.archivedAt && !c.deletedAt,
  );
  const deleted = (snapshot?.conversations ?? []).filter((c) => c.deletedAt);
  const counts = new Map<string, number>();
  for (const c of recent) counts.set(c.title, (counts.get(c.title) ?? 0) + 1);
  function item(c: Conversation) {
    return (
      <div
        key={c.id}
        className={`session-line ${highlightCurrent && currentId === c.id ? "active" : ""}`}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(c, e.clientX, e.clientY);
        }}
      >
        <button
          className={`session ${c.unread ? "unread" : ""}`}
          aria-label={`对话 ${c.id.slice(0, 8)}`}
          aria-current={
            highlightCurrent && currentId === c.id ? "true" : undefined
          }
          title={`${c.title} · ${date(c.updatedAt)} · ${c.id.slice(0, 8)}`}
          onClick={() => {
            void select(c.id);
          }}
        >
          {c.unread && <span className="unread-dot" aria-label="未读" />}
          <span className="session-name">{c.title}</span>
          {(counts.get(c.title) ?? 0) > 1 && (
            <small className="same-name">同名 {counts.get(c.title)}</small>
          )}
          <time dateTime={c.updatedAt}>
            {new Date(c.updatedAt).toLocaleDateString() ===
            new Date().toLocaleDateString()
              ? new Date(c.updatedAt).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })
              : new Date(c.updatedAt).toLocaleDateString("zh-CN", {
                  month: "numeric",
                  day: "numeric",
                })}
          </time>
          {dirty(c.id) && <span className="unsaved">未保存</span>}
        </button>
        <button
          className="session-more"
          aria-label={`对话菜单 ${c.id.slice(0, 8)}`}
          disabled={!connected}
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            openMenu(c, box.right, box.bottom);
          }}
        >
          ⋯
        </button>
      </div>
    );
  }
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? recent.filter((c) => c.title.toLowerCase().includes(needle))
    : recent;
  const list = (
    <>
      <div className="sessions" aria-label="最近对话">
        {shown.some((c) => c.pinnedAt) && (
          <>
            <div className="session-group">置顶</div>
            {shown.filter((c) => c.pinnedAt).map(item)}
            <div className="session-group">最近</div>
          </>
        )}
        {shown.filter((c) => !c.pinnedAt).map(item)}
        {!shown.length && (
          <p className="session-empty" role={needle ? "status" : undefined}>
            {needle ? "没有匹配的对话" : "新的想法，从一段对话开始。"}
          </p>
        )}
      </div>
      <button
        className="archived-entry"
        onClick={() => {
          setArchive(true);
          setError("");
        }}
      >
        已归档 <span>{archived.length}</span>
      </button>
    </>
  );
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
                {c.id.slice(0, 8)} ·{" "}
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
              onClick={() => {
                rename(target.id);
                setMenu(undefined);
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
                    {date(c.updatedAt)} · {c.id.slice(0, 8)}
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
  return { list, trash, overlays, openMenu };
}
