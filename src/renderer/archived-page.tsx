import { useRef, useState } from "react";
import { refocus } from "./modal-focus";
import type { Conversation, Snapshot } from "../shared/protocol";
import { archivedRows } from "./conversation-lists";
import { activityTime } from "./organization";
import { Icon } from "./icons";

function when(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
/**
 * The archived conversations as a centre page, newest creation first: opening a row shows the conversation
 * without unarchiving it; the row's 取消归档 runs the same command as the conversation menu.
 */
export function ArchivedPage({
  snapshot,
  connected,
  counts,
  onOpen,
  onUnarchive,
}: {
  snapshot: Snapshot | undefined;
  connected: boolean;
  counts: Map<string, number>;
  onOpen: (id: string) => void;
  onUnarchive: (conversation: Conversation) => Promise<boolean>;
}) {
  const rows = archivedRows(snapshot?.conversations ?? []);
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const owner = (c: Conversation) =>
    snapshot?.projects.find((p) =>
      p.chats.some((x) => x.conversationId === c.id),
    )?.name ?? "未归属项目";
  if (!rows.length)
    return (
      <div className="empty archived-empty" tabIndex={-1}>
        <div className="empty-icon">
          <Icon name="archive" />
        </div>
        <h2>没有已归档的对话</h2>
        <p>在对话菜单中选择「归档」后，对话会出现在这里。</p>
      </div>
    );
  return (
    <div className="archived-page">
      <p className="quiet">
        已归档的对话移出最近聊天，全部记录保留，仍参与全局搜索；在已归档对话中发送新消息会自动取消归档。
      </p>
      <ul className="archived-list" ref={list} aria-label="已归档对话">
        {rows.map((c, index) => (
          <li key={c.id} className="archived-row">
            <button
              className="archived-open"
              data-conversation={c.id}
              aria-label={`打开 ${c.title}`}
              title={c.title}
              onClick={() => onOpen(c.id)}
            >
              <Icon name="chat" />
              <span className="archived-text">
                <b>
                  {c.title}
                  {(counts.get(c.title) ?? 0) > 1 && (
                    <small className="same-name">
                      同名 {counts.get(c.title)}
                    </small>
                  )}
                </b>
                <small>
                  {owner(c)} · 最后活动{" "}
                  <time dateTime={c.updatedAt}>
                    {activityTime(c.updatedAt)}
                  </time>{" "}
                  · 归档于{" "}
                  <time dateTime={c.archivedAt!}>{when(c.archivedAt!)}</time>
                </small>
              </span>
            </button>
            <button
              className="button"
              disabled={!connected || busy}
              onClick={async (e) => {
                const keyboard = e.detail === 0;
                setBusy(true);
                const ok = await onUnarchive(c);
                setBusy(false);
                if (!ok) return;
                const next = rows[index + 1] ?? rows[index - 1];
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    const target =
                      (next &&
                        list.current?.querySelector<HTMLElement>(
                          `[data-conversation="${next.id}"]`,
                        )) ||
                      document.querySelector<HTMLElement>(".archived-empty");
                    refocus(target, keyboard);
                  }),
                );
              }}
            >
              取消归档
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
