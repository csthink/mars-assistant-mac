import {
  attachmentKindLabels,
  attachmentReasonLabels,
  type Attachment,
  type AttachmentPreview,
} from "../shared/protocol";

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
/** Short status line for a chip; the full reason is available in the preview and the title. */
export function attachmentStatus(attachment: Attachment) {
  if (attachment.status === "importing") return "提取中…";
  if (attachment.status === "unreadable")
    return `不可读：${attachment.reason ? attachmentReasonLabels[attachment.reason] : "原因未知"}`;
  if (attachment.kind === "png" || attachment.kind === "jpeg")
    return `${attachment.width} × ${attachment.height} 像素`;
  const parts: string[] = [];
  if (attachment.pages !== null) parts.push(`${attachment.pages} 页`);
  if (attachment.chars !== null)
    parts.push(`${attachment.chars.toLocaleString("zh-CN")} 字符`);
  return parts.join(" · ") || "可用";
}
export function versionTag(attachment: Attachment) {
  return attachment.sha256 ? attachment.sha256.slice(0, 8) : "无副本";
}
function Chip({
  attachment,
  onRemove,
  onOpen,
  disabled,
}: {
  attachment: Attachment;
  onRemove?: (attachment: Attachment) => void;
  onOpen?: (attachment: Attachment) => void;
  disabled?: boolean;
}) {
  const status = attachmentStatus(attachment);
  const kind =
    attachment.reason === "unsupported_format"
      ? "未知类型"
      : attachmentKindLabels[attachment.kind];
  return (
    <li
      className={`attachment attachment-${attachment.status}`}
      aria-label={`资料 ${attachment.name}`}
      data-testid={`attachment-${attachment.id}`}
    >
      <button
        type="button"
        className="attachment-main"
        aria-label={`预览资料 ${attachment.name}`}
        title={`${attachment.name} · ${kind} · ${formatSize(attachment.size)} · 版本 ${versionTag(attachment)} · ${status}`}
        onClick={() => onOpen?.(attachment)}
        disabled={!onOpen}
      >
        <span className="attachment-name">{attachment.name}</span>
        <span className="attachment-meta">
          {kind} · {formatSize(attachment.size)} · 版本 {versionTag(attachment)}
        </span>
        <span className="attachment-state" role="status">
          {status}
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          className="attachment-remove"
          aria-label={`移除资料 ${attachment.name}`}
          disabled={disabled}
          onClick={() => onRemove(attachment)}
        >
          ×
        </button>
      )}
    </li>
  );
}
/** Selected but unsent material of the composer; every chip can be removed before sending. */
export function DraftAttachments({
  attachments,
  disabled,
  onRemove,
  onOpen,
}: {
  attachments: Attachment[];
  disabled: boolean;
  onRemove: (attachment: Attachment) => void;
  onOpen: (attachment: Attachment) => void;
}) {
  if (!attachments.length) return null;
  return (
    <ul className="attachment-list" aria-label="待发送资料">
      {attachments.map((attachment) => (
        <Chip
          key={attachment.id}
          attachment={attachment}
          onRemove={onRemove}
          onOpen={onOpen}
          disabled={disabled}
        />
      ))}
    </ul>
  );
}
/** The fixed versions a saved user message carried. */
export function MessageAttachments({
  attachments,
  onOpen,
}: {
  attachments: Attachment[];
  onOpen: (attachment: Attachment) => void;
}) {
  if (!attachments.length) return null;
  return (
    <ul className="attachment-list message-attachments" aria-label="消息资料">
      {attachments.map((attachment) => (
        <Chip key={attachment.id} attachment={attachment} onOpen={onOpen} />
      ))}
    </ul>
  );
}
/** Metadata and the first characters of extracted text; images are described, never decoded here. */
export function AttachmentPreviewPanel({
  attachment,
  preview,
  onClose,
}: {
  attachment: Attachment;
  preview: AttachmentPreview | null;
  onClose: () => void;
}) {
  const kind =
    attachment.reason === "unsupported_format"
      ? "未知类型"
      : attachmentKindLabels[attachment.kind];
  const textual =
    attachment.kind === "text" ||
    attachment.kind === "markdown" ||
    attachment.kind === "pdf";
  return (
    <section
      role="dialog"
      aria-label="资料预览"
      className="attachment-preview"
      data-testid="attachment-preview"
    >
      <div className="attachment-preview-head">
        <strong>{attachment.name}</strong>
        <button
          type="button"
          className="button small"
          onClick={onClose}
          aria-label="关闭预览"
        >
          关闭
        </button>
      </div>
      <p className="attachment-preview-meta">
        {kind} · {formatSize(attachment.size)} · 版本 {versionTag(attachment)} ·{" "}
        {attachmentStatus(attachment)}
      </p>
      {attachment.status === "unreadable" && (
        <p className="turn-error" role="alert">
          {attachment.reason
            ? attachmentReasonLabels[attachment.reason]
            : "该资料不可读。"}{" "}
          该资料不会进入发送内容，请移除它或重新选择文件。
        </p>
      )}
      {attachment.status === "importing" && (
        <p className="quiet">正在受限提取正文，完成后显示预览。</p>
      )}
      {attachment.status === "ready" && !textual && (
        <>
          <img
            className="attachment-preview-image"
            src={`attachment://copy/${attachment.sha256}`}
            alt={`${attachment.name} 预览`}
          />
          <p className="quiet">
            显示的是提交时保存的副本；图片按所选连接的图片能力随消息发送。
          </p>
        </>
      )}
      {attachment.status === "ready" && textual && preview && (
        <>
          <pre className="attachment-preview-text" aria-label="正文预览">
            {preview.text}
          </pre>
          <p className="quiet">
            {preview.chars > preview.text.length
              ? `显示前 ${preview.text.length.toLocaleString("zh-CN")} 个字符，共 ${preview.chars.toLocaleString("zh-CN")} 个字符。`
              : `共 ${preview.chars.toLocaleString("zh-CN")} 个字符，已完整显示。`}
          </p>
        </>
      )}
      {attachment.status === "ready" && textual && !preview && (
        <p className="quiet">正在读取预览…</p>
      )}
    </section>
  );
}
