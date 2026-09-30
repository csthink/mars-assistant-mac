import { DraftAttachments, AttachmentPreviewPanel } from "./attachments";
import {
  attachmentsPerTurn,
  type Attachment,
  type AttachmentPreview,
} from "../shared/protocol";
import { useEffect, useRef, useState } from "react";
import type { Project } from "../shared/projects";
import type { ProjectWorkView } from "../shared/project-work";
import { activeTurn, Transcript } from "./chat";
import { type Business, modelReason } from "./project-detail";
export function ProjectChat({
  project,
  model,
  view,
  compact = false,
  onDiscussion,
}: {
  project: Project;
  model: Business;
  view: ProjectWorkView | null;
  compact?: boolean;
  onDiscussion?: (
    objectRef: string,
    title: string,
    conversation: string,
  ) => void;
}) {
  const snapshot = model.snapshot!;
  const [settingsOpen, setSettingsOpen] = useState(!compact);
  const wasCompact = useRef(compact),
    normalSettings = useRef(true);
  useEffect(() => {
    if (compact && !wasCompact.current) {
      normalSettings.current = settingsOpen;
      setSettingsOpen(false);
    } else if (!compact && wasCompact.current)
      setSettingsOpen(normalSettings.current);
    wasCompact.current = compact;
  }, [compact]);
  const [preview, setPreview] = useState<{
    attachment: Attachment;
    text: AttachmentPreview | null;
  } | null>(null);
  const previewRequest = useRef(0);
  async function openAttachment(attachment: Attachment) {
    const seq = ++previewRequest.current;
    setPreview({ attachment, text: null });
    if (
      attachment.status !== "ready" ||
      ["png", "jpeg"].includes(attachment.kind)
    )
      return;
    const r = await window.desktop.command({
      type: "readAttachmentPreview",
      attachmentId: attachment.id,
    });
    if (seq !== previewRequest.current) return;
    if (r.ok && r.preview) setPreview({ attachment, text: r.preview });
    else if (!r.ok) setError(r.message);
  }

  const available = project.chats.filter((ch) =>
    snapshot.conversations.some(
      (c) => c.id === ch.conversationId && !c.deletedAt,
    ),
  );
  const [chosen, setChosen] = useState<string | null>(() =>
      sessionStorage.getItem(`project-chat:${project.id}`),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const id =
    available.find((ch) => ch.conversationId === chosen)?.conversationId ??
    available[0]?.conversationId;
  const draftAttachments = snapshot.draftAttachments
    .filter((a) => a.conversationId === id)
    .map((link) => snapshot.attachments.find((a) => a.id === link.attachmentId))
    .filter((a): a is Attachment => !!a);
  useEffect(() => {
    previewRequest.current++;
    setPreview(null);
  }, [id]);
  const chat = available.find((ch) => ch.conversationId === id),
    conversation = snapshot.conversations.find((c) => c.id === id);
  useEffect(() => {
    if (id && snapshot.selected.main !== id) void model.select(id);
  }, [id, snapshot.selected.main]);
  async function create() {
    if (busy) return;
    setBusy(true);
    try {
      const conversationId = crypto.randomUUID();
      const r = await window.desktop.projectWork({
        type: "chat",
        projectId: project.id,
        conversationId,
      });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setChosen(conversationId);
      sessionStorage.setItem(`project-chat:${project.id}`, conversationId);
      await model.reload();
      await model.select(conversationId);
    } catch {
      setError("对话未创建，请重试。");
    } finally {
      setBusy(false);
    }
  }
  async function context(objectRef: string) {
    if (!chat || busy) return;
    setBusy(true);
    setError("");
    try {
      const object = view?.projection?.objects.find(
        (o) => o.objectRef === objectRef,
      );
      const r = await window.desktop.projectWork({
        type: "context",
        projectId: project.id,
        conversationId: chat.conversationId,
        objectRef: objectRef || null,
        objectRevision: object?.revision ?? null,
        revision: chat.revision,
      });
      if (!r.ok) setError(r.message);
      await model.reload();
    } catch {
      setError("讨论对象未保存。");
    } finally {
      setBusy(false);
    }
  }
  const turns = snapshot.turns.filter((t) => t.conversationId === id),
    running = activeTurn(turns),
    local = id ? model.drafts.get(id) : undefined;
  const connectionId =
    conversation?.connectionId ?? snapshot.settings.defaultConnectionId;
  const connection = snapshot.connections.find((c) => c.id === connectionId),
    modelId = conversation?.connectionId
      ? (conversation.modelId ?? connection?.model)
      : (snapshot.settings.defaultModelId ?? connection?.model);
  const modelEntry = connection?.models.find((m) => m.model === modelId);
  const issue =
    connectionId && modelId
      ? modelReason(snapshot, connectionId, modelId)
      : "请先选择模型";
  const target = chat?.context,
    object = view?.projection?.objects.find(
      (o) => o.objectRef === target?.objectRef,
    );
  useEffect(() => {
    onDiscussion?.(
      target?.objectRef ?? "",
      target?.title ?? "项目名称与目标",
      conversation?.title ?? "项目对话",
    );
  }, [id, target?.objectRef, target?.revision, conversation?.title]);
  const contextProblem = target
    ? !view
      ? "正在读取讨论对象，暂不能发送。"
      : view.unavailable ||
        (!object || object.revision !== target.revision
          ? "讨论对象版本已变化，请重新选择。"
          : "")
    : "";
  const attachmentProblem = draftAttachments.some(
    (a) => a.status === "importing",
  )
    ? "资料正在提取，请稍候。"
    : draftAttachments.some((a) => a.status !== "ready")
      ? "资料尚不可读，请移除后重新添加。"
      : "";
  const disabled =
    busy ||
    !model.status.connected ||
    model.switching ||
    !!running ||
    snapshot.selected.main !== id;
  const historyNeedsConsent =
    !!conversation?.lastDestination &&
    connection &&
    conversation.lastDestination !== `${connection.id}|${connection.baseUrl}` &&
    !conversation.grantedConnections.includes(
      `${connection.id}|${connection.baseUrl}`,
    );
  return (
    <section
      className="project-chat-pane project-detail-card"
      aria-label="项目对话"
    >
      <div className="project-section-heading">
        <h3>项目对话</h3>
        <button
          className="button"
          disabled={busy || !model.status.connected}
          onClick={() => void create()}
        >
          新建项目对话
        </button>
      </div>
      {!conversation ? (
        <p className="project-empty-small">
          开始一段独立对话。默认只携带项目名称与目标，不自动读取文件夹。
        </p>
      ) : (
        <>
          <div className="project-chat-scroll">
            <details
              className="project-chat-settings"
              open={settingsOpen}
              onToggle={(e) => setSettingsOpen(e.currentTarget.open)}
            >
              <summary>
                对话设置 · {target?.title ?? "项目"} · {modelId || "未选择模型"}
              </summary>
              <label>
                对话
                <select
                  aria-label="项目对话选择"
                  value={id}
                  disabled={busy}
                  onChange={(e) => {
                    setChosen(e.target.value);
                    sessionStorage.setItem(
                      `project-chat:${project.id}`,
                      e.target.value,
                    );
                    model.clearActionError();
                  }}
                >
                  {available.map((ch) => (
                    <option key={ch.conversationId} value={ch.conversationId}>
                      {
                        snapshot.conversations.find(
                          (c) => c.id === ch.conversationId,
                        )?.title
                      }{" "}
                      · {ch.conversationId.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                讨论对象
                <select
                  aria-label="讨论对象"
                  value={target?.objectRef ?? ""}
                  disabled={disabled}
                  onChange={(e) => void context(e.target.value)}
                >
                  <option value="">项目名称与目标</option>
                  {target && !object && (
                    <option value={target.objectRef} disabled>
                      {target.title} · 不可用
                    </option>
                  )}
                  {view?.projection?.objects.map((o) => (
                    <option
                      key={o.objectRef}
                      value={o.objectRef}
                      disabled={!!view.unavailable}
                    >
                      {o.title} · {o.revision}
                    </option>
                  ))}
                </select>
              </label>
              {target && (
                <p className="project-source">
                  当前讨论：{target.title} · {target.revision}{" "}
                  <button
                    className="project-text-button"
                    disabled={disabled || !!view?.unavailable || !object}
                    onClick={() => void context(target.objectRef)}
                  >
                    采用当前版本
                  </button>
                </p>
              )}
              <p className="project-form-hint">
                仅发送本对话历史、项目名称与目标，以及所选对象的身份、版本和状态。切换讨论对象保留历史；需要独立历史时新建对话。
              </p>
              <label>
                对话模型
                <select
                  aria-label="项目对话模型"
                  disabled={disabled}
                  value={
                    conversation.connectionId
                      ? `${conversation.connectionId}::${conversation.modelId ?? connection?.model ?? ""}`
                      : ""
                  }
                  onChange={(e) =>
                    void model.chooseConnection(id!, e.target.value)
                  }
                >
                  <option value="">
                    {snapshot.settings.defaultConnectionId
                      ? "使用全局默认模型"
                      : "请选择模型"}
                  </option>
                  {snapshot.connections.flatMap((c) =>
                    c.models.map((m) => (
                      <option
                        key={`${c.id}::${m.model}`}
                        value={`${c.id}::${m.model}`}
                        disabled={!!modelReason(snapshot, c.id, m.model)}
                      >
                        {c.name} · {m.model}
                        {modelReason(snapshot, c.id, m.model)
                          ? " · " + modelReason(snapshot, c.id, m.model)
                          : ""}
                      </option>
                    )),
                  )}
                </select>
              </label>
              <label>
                推理强度
                <select
                  aria-label="项目对话推理强度"
                  value={conversation.effort ?? ""}
                  disabled={disabled || !modelEntry?.effort}
                  onChange={(e) =>
                    void model.chooseEffort(id!, e.target.value || null)
                  }
                >
                  <option value="">
                    {modelEntry?.effort
                      ? `模型默认（${modelEntry.effort.defaultLevel ?? "未记录"}）`
                      : "未记录"}
                  </option>
                  {modelEntry?.effort?.levels.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              </label>
            </details>
            {contextProblem && (
              <p role="status" className="project-runtime-warning">
                {contextProblem}
              </p>
            )}
            <div className="project-chat-transcript">
              <Transcript
                messages={snapshot.messages.filter(
                  (m) => m.conversationId === id,
                )}
                turns={turns}
                attachments={snapshot.attachments}
                messageAttachments={snapshot.messageAttachments}
                onStop={(id) => void model.stop(id)}
                onOpenAttachment={(a) => void openAttachment(a)}
              />
            </div>
            {historyNeedsConsent && (
              <div className="project-runtime-warning">
                <p>将向 {connection.name} 发送本对话历史与已选资料。</p>
                <button
                  className="button"
                  disabled={disabled}
                  onClick={() =>
                    void window.desktop
                      .command({
                        type: "grantConnectionScope",
                        conversationId: id!,
                        connectionId: connection.id,
                        baseUrl: connection.baseUrl,
                      })
                      .then((r) => {
                        if (!r.ok) setError(r.message);
                      })
                  }
                >
                  确认发送范围
                </button>
              </div>
            )}
            {preview && (
              <AttachmentPreviewPanel
                attachment={preview.attachment}
                preview={preview.text}
                onClose={() => {
                  previewRequest.current++;
                  setPreview(null);
                }}
              />
            )}
            <DraftAttachments
              attachments={draftAttachments}
              disabled={disabled}
              onOpen={(a) => void openAttachment(a)}
              onRemove={(a) =>
                void window.desktop
                  .command({
                    type: "removeDraftAttachment",
                    conversationId: id!,
                    attachmentId: a.id,
                  })
                  .then((r) => {
                    if (!r.ok) setError(r.message);
                  })
              }
            />
          </div>
          <button
            type="button"
            className="button"
            disabled={disabled || draftAttachments.length >= attachmentsPerTurn}
            onClick={() => {
              setBusy(true);
              void window.desktop
                .pickAttachments(id!)
                .then((r) => {
                  if (!r.ok) setError(r.message);
                })
                .catch(() => setError("资料选择未完成。"))
                .finally(() => setBusy(false));
            }}
          >
            添加资料
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (
                !disabled &&
                !issue &&
                !contextProblem &&
                !attachmentProblem &&
                !local?.error &&
                !historyNeedsConsent
              )
                void model.submit(id!, connectionId!, modelId!);
            }}
          >
            <textarea
              aria-label="项目对话输入"
              placeholder="讨论这个项目…"
              value={local?.text ?? conversation.draft}
              rows={4}
              disabled={!model.status.connected}
              onChange={(e) => model.edit(id!, e.target.value)}
            />
            <div className="project-chat-send">
              <span>
                {local?.saving
                  ? "正在保存草稿…"
                  : attachmentProblem || issue || "草稿自动保存"}
              </span>
              <button
                className="button project-primary"
                disabled={
                  disabled ||
                  !!issue ||
                  !!contextProblem ||
                  !!attachmentProblem ||
                  !!local?.error ||
                  historyNeedsConsent ||
                  !(local?.text ?? conversation.draft).trim()
                }
              >
                发送
              </button>
            </div>
          </form>
          {local?.error && (
            <div role="alert">
              <p>{local.error}</p>
              <button className="button" onClick={() => model.retry(id!)}>
                重试保存草稿
              </button>
            </div>
          )}
        </>
      )}
      {(error || model.actionError) && (
        <p role="alert" className="project-error">
          {error || model.actionError}
        </p>
      )}
    </section>
  );
}
