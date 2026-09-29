import {
  attachmentKindLabels,
  stateLabels,
  type Attachment,
  type Snapshot,
} from "../shared/protocol";
import { Icon } from "./icons";

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function when(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
/** What the right column can say about a conversation: its data, or why it cannot be read. */
export interface ConversationPanelSource {
  snapshot: Snapshot | undefined;
  /** The conversation shown in the centre; undefined on the new-conversation page. */
  conversationId: string | undefined;
  /** Messages, turns and attachments are only in the snapshot for the selected, connected conversation. */
  readable: boolean;
}
const unavailable = (
  <p className="right-empty" role="status">
    未连接，无法读取本对话的文件与事件。
  </p>
);

/**
 * Files of a conversation: the attachments its submitted messages carry, each as the saved copy that was
 * sent (the version is the copy's SHA-256) and to whom the turn sent it. Attachments still in the composer are
 * only counted: they are not part of any submitted version and their content is not read here.
 */
export function ConversationFiles({
  source,
  onOpen,
}: {
  source: ConversationPanelSource;
  onOpen: (attachment: Attachment) => void;
}) {
  const { snapshot, conversationId } = source;
  if (!conversationId)
    return <p className="right-empty">新对话还没有提交的资料。</p>;
  if (!source.readable || !snapshot) return unavailable;
  const messages = snapshot.messages.filter(
    (m) => m.conversationId === conversationId,
  );
  const byId = new Map(snapshot.attachments.map((a) => [a.id, a]));
  const turns = new Map(snapshot.turns.map((t) => [t.id, t]));
  const sent = messages.flatMap((message) =>
    snapshot.messageAttachments
      .filter((link) => link.messageId === message.id)
      .sort((a, b) => a.position - b.position)
      .map((link) => ({
        message,
        attachment: byId.get(link.attachmentId),
        turn: message.turnId ? turns.get(message.turnId) : undefined,
      }))
      .filter(
        (x): x is typeof x & { attachment: Attachment } => !!x.attachment,
      ),
  );
  const waiting = snapshot.draftAttachments.filter(
    (link) => link.conversationId === conversationId,
  ).length;
  return (
    <div className="conversation-files">
      {sent.length ? (
        <ul className="right-list" aria-label="已提交的资料">
          {sent.map(({ message, attachment, turn }) => (
            <li key={`${message.id}:${attachment.id}`}>
              <button
                className="right-row"
                aria-label={`预览 ${attachment.name}`}
                onClick={() => onOpen(attachment)}
              >
                <Icon name="file" />
                <span>
                  <b>{attachment.name}</b>
                  <small>
                    {attachmentKindLabels[attachment.kind]} ·{" "}
                    {size(attachment.size)} · 已提交版本{" "}
                    <code>{attachment.sha256.slice(0, 12)}</code> ·{" "}
                    {when(message.createdAt)}
                  </small>
                  <small>
                    发送范围：
                    {turn
                      ? `本回合发送给 ${turn.connection.name} · ${turn.connection.model}`
                      : "未发送给模型"}
                  </small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="right-empty">这段对话还没有提交的资料。</p>
      )}
      {waiting > 0 && (
        <p className="right-note">
          输入区另有 {waiting} 个已选择、尚未提交的资料；提交前可在输入区移除。
        </p>
      )}
      <p className="right-note">
        选择一个文件不等于授权访问其父目录或其他文件；原文件之后变化或消失，不会替换已提交版本。
      </p>
    </div>
  );
}

/**
 * Turn events of a conversation, newest first: when, the turn state, and the connection, model and reasoning
 * level of that turn. Read only: stop and retry stay in the conversation.
 */
export function ConversationEvents({
  source,
}: {
  source: ConversationPanelSource;
}) {
  const { snapshot, conversationId } = source;
  if (!conversationId)
    return <p className="right-empty">新对话还没有回合事件。</p>;
  if (!source.readable || !snapshot) return unavailable;
  const turns = snapshot.turns
    .filter((t) => t.conversationId === conversationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!turns.length)
    return <p className="right-empty">这段对话还没有回合事件。</p>;
  return (
    <div className="conversation-events">
      <ol className="right-timeline" aria-label="回合事件">
        {turns.map((turn) => (
          <li key={turn.id}>
            <time dateTime={turn.endedAt ?? turn.createdAt}>
              {when(turn.endedAt ?? turn.createdAt)}
            </time>
            <span>
              <b>回合{stateLabels[turn.state]}</b>
              <small>
                {turn.connection.name} · {turn.connection.model} · 推理{" "}
                {turn.connection.effort ?? "未记录"}
              </small>
            </span>
          </li>
        ))}
      </ol>
      <p className="right-note">完整事件在「记录」中查看；这里只读。</p>
    </div>
  );
}
