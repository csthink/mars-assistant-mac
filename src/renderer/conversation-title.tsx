import { openModal } from "./modal-focus";
import { useEffect, useRef, useState } from "react";
import type { Conversation } from "../shared/protocol";
export function RenameDialog({
  conversation,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(conversation.title);
  const [revision, setRevision] = useState(conversation.titleRevision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  useEffect(() => {
    const restoreFocus = openModal(dialog.current!);
    input.current?.select();
    return restoreFocus;
  }, []);
  async function save() {
    if (busy || !value.trim()) return;
    setBusy(true);
    setError("");
    try {
      const reply = await window.desktop.command({
        type: "renameConversation",
        id: conversation.id,
        title: value,
        revision,
      });
      if (reply.ok) onClose();
      else {
        setError(reply.message);
        if (reply.code === "CONFLICT") setRevision(conversation.titleRevision);
      }
    } catch {
      setError("标题未保存，请保留输入并重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="rename-dialog"
      aria-label="重命名对话"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!composing.current) void save();
        }}
      >
        <h2>重命名对话</h2>
        <p className="quiet">手动标题会一直保留，不会被自动标题覆盖。</p>
        <label>
          对话标题
          <input
            ref={input}
            aria-label="对话标题"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                (e.nativeEvent.isComposing || composing.current)
              )
                e.preventDefault();
            }}
          />
        </label>
        <small className="quiet">
          最多 80 个字符 · 对话 {conversation.id.slice(0, 8)}
        </small>
        {(error || revision !== conversation.titleRevision) && (
          <p className="quiet">最新已保存标题：{conversation.title}</p>
        )}
        {error && (
          <p role="alert" className="title-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || !value.trim() || [...value.trim()].length > 80}
          >
            {busy ? "正在保存…" : "保存标题"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * Renaming in place (the sidebar row or the centre title): Enter saves, Escape or leaving the field cancels, and
 * a name that is empty after trimming keeps the saved one without a command. Enter during an input method
 * composition only commits the composition. A failed save keeps the field open with the typed text, the reason
 * and the saved name; the saved name does not change. onClose runs once, after a save or a cancel.
 */
export function InlineRename({
  conversation,
  className = "",
  onClose,
}: {
  conversation: Conversation;
  className?: string;
  onClose: () => void;
}) {
  const [value, setValue] = useState(conversation.title);
  const [revision, setRevision] = useState(conversation.titleRevision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const closed = useRef(false);
  const latest = useRef(conversation);
  latest.current = conversation;
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, []);
  function close() {
    if (closed.current) return;
    closed.current = true;
    onClose();
  }
  async function save() {
    const title = value.trim();
    if (!title || title === conversation.title) return close();
    if ([...title].length > 80) {
      setError("名称最多 80 个字符，未保存。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const reply = await window.desktop.command({
        type: "renameConversation",
        id: conversation.id,
        title,
        revision,
      });
      if (reply.ok) close();
      else {
        setError(reply.message);
        // After a conflict the typed text is kept; saving again applies it over the latest saved name.
        if (reply.code === "CONFLICT")
          setRevision(latest.current.titleRevision);
      }
    } catch {
      setError("名称未保存，请保留输入并重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className={`rename-inline ${className}`}>
      <input
        ref={input}
        className="rename-input"
        aria-label={`重命名对话「${conversation.title}」，Enter 保存，Escape 取消`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `rename-error-${conversation.id}` : undefined}
        value={value}
        readOnly={busy}
        onChange={(e) => setValue(e.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.nativeEvent.isComposing || composing.current || busy) return;
            void save();
          } else if (e.key === "Escape") {
            if (e.nativeEvent.isComposing || composing.current) return;
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
        onBlur={() => {
          // A failed save stays open so the typed text is not lost; Escape still cancels.
          if (!busy && !error) close();
        }}
      />
      {error && (
        <span
          id={`rename-error-${conversation.id}`}
          role="alert"
          className="rename-error"
        >
          {error} 已保存的名称：{conversation.title}
        </span>
      )}
    </span>
  );
}
