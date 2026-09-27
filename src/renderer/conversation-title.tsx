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
