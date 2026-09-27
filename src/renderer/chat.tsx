import { Highlight } from "./search";
import { matchRanges } from "../shared/search";
import { useEffect, useRef } from "react";
import {
  errorClassLabels,
  stateLabels,
  terminalStates,
  type Attachment,
  type Message,
  type MessageAttachment,
  type Turn,
} from "../shared/protocol";
import { MessageAttachments } from "./attachments";

/** The level actually passed to the executor; nothing is shown when no parameter was sent. */
function effortSuffix(effort: string | null | undefined) {
  return effort ? ` · 推理 ${effort}` : "";
}
function when(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
export function activeTurn(turns: Turn[]) {
  return turns.find((t) => !terminalStates.includes(t.state));
}
/** Messages and turn states of one conversation; the active turn shows its partial output live. */
export function Transcript({
  messages,
  turns,
  attachments,
  messageAttachments,
  onStop,
  onOpenAttachment,
  focus,
  onClearFocus,
}: {
  focus?: { messageId: string; query: string };
  onClearFocus?: () => void;
  messages: Message[];
  turns: Turn[];
  attachments: Attachment[];
  messageAttachments: MessageAttachment[];
  onStop: (executionId: string) => void;
  onOpenAttachment: (attachment: Attachment) => void;
}) {
  const byId = new Map(attachments.map((a) => [a.id, a]));
  const attachmentsOf = (messageId: string) =>
    messageAttachments
      .filter((link) => link.messageId === messageId)
      .sort((a, b) => a.position - b.position)
      .map((link) => byId.get(link.attachmentId))
      .filter((a): a is Attachment => !!a);
  const end = useRef<HTMLDivElement>(null);
  const lastKey = `${messages.length}:${turns.map((t) => `${t.id}${t.state}${t.partialText.length}`).join(",")}`;
  useEffect(() => {
    if (!focus) end.current?.scrollIntoView({ block: "end" });
  }, [lastKey, focus]);
  useEffect(() => {
    if (focus)
      document
        .getElementById(`message-${focus.messageId}`)
        ?.scrollIntoView({ block: "center" });
  }, [focus, messages]);
  const byTurn = new Map(turns.map((t) => [t.id, t]));
  const assistantByTurn = new Set(
    messages
      .filter((m) => m.role === "assistant" && m.turnId)
      .map((m) => m.turnId),
  );
  return (
    <div className="transcript" aria-label="对话消息">
      {focus && (
        <button className="button search-return" onClick={onClearFocus}>
          返回最新消息
        </button>
      )}
      {messages.map((message) => {
        const turn = message.turnId ? byTurn.get(message.turnId) : undefined;
        return (
          <div key={message.id}>
            <article
              id={`message-${message.id}`}
              tabIndex={-1}
              className={`bubble ${message.role} ${focus?.messageId === message.id ? "search-match-message" : ""}`}
              aria-label={message.role === "user" ? "用户消息" : "助手消息"}
            >
              <p>
                {focus?.messageId === message.id ? (
                  <Highlight
                    text={message.content}
                    ranges={matchRanges(message.content, focus.query)}
                  />
                ) : (
                  message.content
                )}
              </p>
              {message.role === "user" && (
                <MessageAttachments
                  attachments={attachmentsOf(message.id)}
                  onOpen={onOpenAttachment}
                />
              )}
              {message.role === "assistant" &&
                turn &&
                turn.omittedImages > 0 && (
                  <p className="quiet turn-omitted" role="note">
                    本回合未携带 {turn.omittedImages} 张历史图片：连接{" "}
                    {turn.connection.name} 未确认支持图片输入。
                  </p>
                )}
            </article>
            {message.role === "user" &&
              turn &&
              assistantByTurn.has(turn.id) && (
                <p className="turn-reference">
                  {turn.connection.name} · {turn.connection.model}
                  {effortSuffix(turn.connection.effort)}
                </p>
              )}
            {message.role === "user" &&
              turn &&
              !assistantByTurn.has(turn.id) && (
                <TurnCard turn={turn} onStop={onStop} focus={focus} />
              )}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}
function TurnCard({
  turn,
  onStop,
  focus,
}: {
  focus?: { messageId: string; query: string };
  turn: Turn;
  onStop: (executionId: string) => void;
}) {
  const active = !terminalStates.includes(turn.state);
  const label = stateLabels[turn.state];
  return (
    <article
      id={`message-turn-${turn.id}`}
      className={`bubble assistant turn-${turn.state} ${focus?.messageId === `turn-${turn.id}` ? "search-match-message" : ""}`}
      aria-label="助手回合"
      data-testid={`turn-${turn.id}`}
    >
      {turn.partialText && (
        <p>
          {focus?.messageId === `turn-${turn.id}` ? (
            <Highlight
              text={turn.partialText}
              ranges={matchRanges(turn.partialText, focus.query)}
            />
          ) : (
            turn.partialText
          )}
        </p>
      )}
      <div className="turn-meta">
        <span className={`turn-state state-${turn.state}`} role="status">
          {label}
        </span>
        <span className="turn-connection">
          {turn.connection.name} · {turn.connection.model}
          {effortSuffix(turn.connection.effort)}
        </span>
        {turn.attempt > 1 && <span className="tag">第 {turn.attempt} 次</span>}
        {turn.omittedImages > 0 && (
          <span
            className="tag"
            title="该连接未确认支持图片输入，历史图片以文字占位说明"
          >
            本回合未携带 {turn.omittedImages} 张历史图片
          </span>
        )}
        <span className="quiet">{when(turn.endedAt ?? turn.createdAt)}</span>
        {active && turn.state !== "stopping" && (
          <button
            className="button small"
            onClick={() => onStop(turn.executionId)}
          >
            停止
          </button>
        )}
      </div>
      {turn.state === "failed" && (
        <p className="turn-error" role="alert">
          {turn.errorClass ? `${errorClassLabels[turn.errorClass]}：` : ""}
          {turn.errorMessage ?? "执行失败。"}
          {turn.partialText ? " 已收到的部分内容保留在上方。" : ""}
        </p>
      )}
      {turn.state === "interrupted" && (
        <p className="turn-error" role="alert">
          应用在回合结束前退出或中断，结果不明。可在“待处理”中重试或忽略。
        </p>
      )}
      {turn.state === "stopped" && !turn.partialText && (
        <p className="quiet">在收到内容前已停止。</p>
      )}
    </article>
  );
}
