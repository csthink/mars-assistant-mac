import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../shared/protocol";
import type {
  GeneratedCandidate,
  WidgetDraft,
} from "../shared/widget-generation";
import type { WidgetDraftModel } from "./widget-drafts";
import { WidgetWorkspace } from "./widgets";
import { openModal } from "./modal-focus";
function display(value: string | null, encoding?: string) {
  if (value === null) return "文件不存在";
  if (encoding !== "base64") return value;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
    );
  } catch {
    return `二进制资源（${value.length} 个 Base64 字符）`;
  }
}
export function WidgetCandidatePanel({
  snapshot,
  draft,
  model,
  connected,
  occluded,
}: {
  snapshot: Snapshot;
  draft: WidgetDraft;
  model: WidgetDraftModel;
  connected: boolean;
  occluded: boolean;
}) {
  const candidates =
    snapshot.widgetGeneration?.candidates.filter(
      (c) => c.draftId === draft.id,
    ) ?? [];
  const formal = snapshot.widgetGeneration?.widgets.find(
    (w) => w.id === draft.widgetId,
  );
  const latest = candidates.at(-1);
  const candidate =
    latest && latest.state !== "discarded"
      ? latest
      : (snapshot.widgetGeneration?.candidates.find(
          (c) => c.id === formal?.candidateId,
        ) ?? latest);
  const [confirmation, setConfirmation] = useState<{
    candidate: GeneratedCandidate;
    action: "retainWidgetCandidate" | "discardWidgetCandidate";
  }>();
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [difference, setDifference] = useState(false);
  if (!candidate)
    return (
      <div className="widget-empty">
        <h2>等待控件候选</h2>
        <p>提交需求后，生成进度和结果会保留在编辑对话中。</p>
      </div>
    );
  const task = snapshot.widgetGeneration?.tasks.find(
    (t) => t.id === candidate.taskId,
  );
  const stale = candidate.requirementRevision !== draft.requirementRevision;
  const changed =
    candidate.differences.length > 0 && candidate.state !== "unchanged";
  const available = candidate.state === "preview" && changed;
  return (
    <div className="widget-candidate-panel">
      <div className="widget-candidate-summary">
        <h2>{candidate.name}</h2>
        <p>
          {candidate.state === "retained"
            ? "已保留到控件。编辑历史继续保存。"
            : candidate.state === "discarded"
              ? "已撤销预览，编辑历史继续保存。"
              : !changed
                ? "没有实际变化，无需保留。"
                : `${draft.widgetId ? "修改" : "新增"} 1 个控件 · ${candidate.differences.length} 个文件变化`}
        </p>
        {stale && candidate.state === "preview" && (
          <p className="error" role="alert">
            需求已更新，此候选不能保留。可继续检查或撤销。
          </p>
        )}
        <p className="quiet">
          访问范围：仅本控件的本地配置和数据；不访问网络或本机文件。
        </p>
        <div className="widget-studio-actions">
          {changed && (
            <button
              className="button"
              onClick={() => setDifference(!difference)}
            >
              {difference ? "返回实际预览" : "查看实际差异"}
            </button>
          )}
          {available && (
            <button
              className="button primary"
              disabled={
                !connected ||
                stale ||
                task?.state !== "completed" ||
                unconfirmed
              }
              onClick={() =>
                setConfirmation({ candidate, action: "retainWidgetCandidate" })
              }
            >
              保留控件
            </button>
          )}
          {candidate.state === "preview" && (
            <button
              className="button"
              disabled={!connected}
              onClick={() =>
                setConfirmation({ candidate, action: "discardWidgetCandidate" })
              }
            >
              撤销预览
            </button>
          )}
        </div>
        {unconfirmed && (
          <p className="error">控件输入尚未确认保存，确认后才能保留。</p>
        )}
      </div>
      {difference ? (
        <div className="widget-differences" aria-label="实际产物差异">
          {candidate.differences.map((d) => (
            <details key={d.path}>
              <summary>
                {d.before === null
                  ? "新增"
                  : d.after === null
                    ? "删除"
                    : "修改"}{" "}
                · {d.path}
              </summary>
              <h3>正式版本</h3>
              <pre>{display(d.before, d.encoding)}</pre>
              <h3>候选版本</h3>
              <pre>{display(d.after, d.encoding)}</pre>
            </details>
          ))}
        </div>
      ) : (
        ["preview", "retained"].includes(candidate.state) && (
          <WidgetWorkspace
            key={`${candidate.id}:${candidate.state}`}
            candidateId={candidate.id}
            retained={candidate.state === "retained"}
            connected={connected}
            occluded={occluded || !!confirmation}
            onUnconfirmed={setUnconfirmed}
          />
        )
      )}
      {confirmation && (
        <CandidateConfirmation
          candidate={confirmation.candidate}
          action={confirmation.action}
          model={model}
          close={() => setConfirmation(undefined)}
        />
      )}
    </div>
  );
}
function CandidateConfirmation({
  candidate,
  action,
  model,
  close,
}: {
  candidate: GeneratedCandidate;
  action: "retainWidgetCandidate" | "discardWidgetCandidate";
  model: WidgetDraftModel;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false);
  const retain = action === "retainWidgetCandidate";
  useEffect(() => openModal(dialog.current!), []);
  return (
    <dialog
      ref={dialog}
      className="rename-dialog widget-confirmation"
      aria-label={retain ? "确认保留控件" : "确认撤销预览"}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          const result = await model.command({
            type: action,
            candidateId: candidate.id,
            digest: candidate.digest,
            requirementRevision: candidate.requirementRevision,
          });
          setBusy(false);
          if (result) close();
          else setFailed(true);
        }}
      >
        <h2>{retain ? "保留这个控件？" : "撤销这个预览？"}</h2>
        <p>
          {candidate.name} · 需求修订 {candidate.requirementRevision}
        </p>
        <p>
          {retain
            ? "保留当前检查的候选及已确认配置。成功后留在编辑页。"
            : "只丢弃尚未保留的候选，生成和编辑历史仍保存。"}
        </p>
        {failed && (
          <p className="error" role="alert">
            {model.error || "操作未完成，候选仍可检查。"}
          </p>
        )}
        <div className="widget-studio-actions">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={close}
          >
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {retain ? "确认保留" : "确认撤销"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
