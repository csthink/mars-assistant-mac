import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Snapshot } from "../shared/protocol";
import type { Project } from "../shared/projects";
import { openModal, refocus, refocusWhenReady } from "./modal-focus";
import { Icon } from "./icons";

/** The actions of the notice after a project moved to recently deleted. */
export const projectDeletionNotice: readonly ("undo" | "open")[] = [
  "undo",
  "open",
];
/** How long a deletion notice stays, unless the page or the conversation changes first. */
export const deletionNoticeMs = 5000;

/**
 * A confirmation dialog of a deletion: the title, the content, then Cancel and the destructive action. Focus
 * starts on Cancel; Cancel, the close button and Escape change nothing and give focus back to `back`.
 */
export function DeletionDialog({
  title,
  children,
  confirm,
  confirmLabel,
  close,
  back,
  disabled,
  cancelLabel = "取消",
  extra,
}: {
  title: string;
  children: ReactNode;
  /** Runs the action; resolves to an error text, or "" when it succeeded (the owner then closes the dialog). */
  confirm?: () => Promise<string>;
  confirmLabel?: string;
  close: () => void;
  /** The entry that opened the dialog; focus goes back to it on cancel. */
  back: () => HTMLElement | null | undefined;
  disabled?: boolean;
  cancelLabel?: string;
  extra?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const close = openModal(dialog.current!);
    // The safe choice holds focus first, not the close button that comes first in the dialog.
    cancelButton.current?.focus();
    return close;
  }, []);
  function cancel() {
    if (busy) return;
    const entry = back();
    close();
    requestAnimationFrame(() => refocus(entry, true));
  }
  return (
    <dialog
      ref={dialog}
      className="rename-dialog deletion-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
      // Escape is handled here, before it becomes a close request: over the settings dialog Chromium would
      // otherwise close both dialogs with one key press.
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }}
    >
      <div className="deletion-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="关闭"
          disabled={busy}
          onClick={cancel}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="deletion-actions">
        <button
          ref={cancelButton}
          className="button"
          disabled={busy}
          onClick={cancel}
        >
          {cancelLabel}
        </button>
        {extra}
        {confirm && (
          <button
            className="button danger"
            disabled={busy || disabled}
            onClick={async () => {
              setBusy(true);
              setError("");
              let message = "";
              try {
                message = await confirm();
              } catch {
                message = "结果未确认，请重新读取后再操作。";
              }
              setBusy(false);
              if (message) setError(message);
            }}
          >
            {confirmLabel}
          </button>
        )}
      </div>
    </dialog>
  );
}

/** Focuses an entry once the confirmation dialog has closed (closing a dialog moves focus on its own). */
export function focusAfterDialog(find: () => HTMLElement | null | undefined) {
  refocusWhenReady(
    () => (document.querySelector(".deletion-dialog[open]") ? null : find()),
    false,
    30,
  );
}

export function ImpactList({ rows }: { rows: [string, string][] }) {
  return (
    <ul className="impact-list">
      {rows.map(([label, text]) => (
        <li key={label}>
          <b>{label}</b>
          <span>{text}</span>
        </li>
      ))}
    </ul>
  );
}

export function Callout({
  tone = "info",
  icon,
  title,
  children,
}: {
  tone?: "info" | "amber";
  icon: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`deletion-callout ${tone}`}
      role={tone === "amber" ? "alert" : undefined}
    >
      <Icon name={icon} />
      <div>
        <b>{title}</b>
        {children}
      </div>
    </div>
  );
}

/** What deleting a project touches, from the Host's records (PROJECT-03). */
export function projectDeletionImpact(snapshot: Snapshot, project: Project) {
  const listed = new Set(
    snapshot.conversations.filter((c) => !c.deletedAt).map((c) => c.id),
  );
  const chats = project.chats.filter((c) => listed.has(c.conversationId));
  const { unknown, active } = project.openWork;
  return { chats: chats.length, active, unknown };
}
