import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Snapshot } from "../shared/protocol";
import {
  generationWait,
  type GenerationTask,
  type WidgetDraft,
} from "../shared/widget-generation";
import type { WidgetDraftModel } from "./widget-drafts";
import { WidgetWorkspace } from "./widgets";
import { Icon } from "./icons";
import { openModal } from "./modal-focus";
import "./widget-studio.css";
export const generationLabels = {
  queued: "等待生成",
  running: "正在生成",
  stopping: "正在停止",
  completed: "生成完成",
  stopped: "已停止",
  failed: "生成失败",
  interrupted: "已中断，等待恢复",
};
export function visibleWidgetDraft(d: WidgetDraft, snapshot: Snapshot) {
  const tasks =
    snapshot.widgetGeneration?.tasks.filter((t) => t.draftId === d.id) ?? [];
  const candidates =
    snapshot.widgetGeneration?.candidates.filter((c) => c.draftId === d.id) ??
    [];
  if (d.deleted) return false;
  if (
    d.input ||
    tasks.some((t) => ["queued", "running", "stopping"].includes(t.state))
  )
    return true;
  if (candidates.length) return candidates.at(-1)?.state === "preview";
  return !d.widgetId;
}
export function WidgetTaskCard({
  task,
  model,
  onOpen,
}: {
  task: GenerationTask;
  model: WidgetDraftModel;
  onOpen?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [continuedAt, setContinuedAt] = useState(0);
  const [extending, setExtending] = useState(false);
  useEffect(() => {
    if (task.state !== "running") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task.state, task.executionId]);
  const remaining =
    task.deadlineAt == null ? null : Math.max(0, task.deadlineAt - now);
  const idle =
    task.state === "running" &&
    task.lastProgressAt != null &&
    now - Math.max(task.lastProgressAt, continuedAt) >= generationWait.idleMs;
  const warning =
    task.state === "running" &&
    remaining != null &&
    remaining <= generationWait.warningMs;
  const atMaximum =
    task.startedAt != null &&
    task.deadlineAt != null &&
    task.deadlineAt >= task.startedAt + generationWait.maximumMinutes * 60_000;
  const extensionMinutes =
    task.startedAt != null && task.deadlineAt != null
      ? Math.ceil(
          Math.min(
            generationWait.extensionMs,
            task.startedAt +
              generationWait.maximumMinutes * 60_000 -
              task.deadlineAt,
          ) / 60_000,
        )
      : 0;
  return (
    <article className="widget-task-card" data-widget-task={task.id}>
      <div className="widget-task-title">
        <Icon name="grid" />
        <strong>
          {task.stopUnconfirmed ? "停止尚未确认" : generationLabels[task.state]}
        </strong>
        <span>
          {task.connection.name} · {task.connection.model}
        </span>
      </div>
      <p>{task.requirement}</p>
      <small>
        需求修订 {task.requirementRevision} · 第 {task.attempt} 次尝试
      </small>
      {task.partialText && (
        <p className="widget-task-output">{task.partialText}</p>
      )}
      {task.error && (
        <p className="error" role="alert">
          {task.error}
        </p>
      )}
      {task.state === "running" && remaining != null && (
        <div className="widget-wait-status" role="status">
          <p>
            {remaining > 0
              ? `本次最多还等待 ${Math.ceil(remaining / 60_000)} 分钟。`
              : "已到等待时限，正在确认停止；草稿和已收到的内容会保留。"}
          </p>
          {idle && remaining > 0 && (
            <p>
              已2分钟没有新的生成进展。模型可能仍在处理，你可以继续等待或停止。
            </p>
          )}
          {warning && remaining > 0 && (
            <p>
              本次等待将在1分钟内结束。
              {atMaximum
                ? "已达到本次30分钟上限，不能再延长。"
                : "可延长本次等待，不改变默认设置。"}
            </p>
          )}
          {idle && remaining > 0 && (
            <button
              className="button"
              onClick={() => {
                setContinuedAt(Date.now());
                setNow(Date.now());
              }}
            >
              继续等待
            </button>
          )}
          {warning && remaining > 0 && !atMaximum && (
            <button
              className="button"
              disabled={extending}
              onClick={async () => {
                setExtending(true);
                try {
                  await model.command({
                    type: "extendWidgetGeneration",
                    taskId: task.id,
                    executionId: task.executionId,
                    expectedDeadline: task.deadlineAt!,
                  });
                } finally {
                  setExtending(false);
                }
              }}
            >
              延长{extensionMinutes}分钟
            </button>
          )}
        </div>
      )}
      <div className="widget-studio-actions">
        {task.stopUnconfirmed && (
          <button
            className="button"
            onClick={() =>
              void model.command({
                type: "checkWidgetGenerationStop",
                taskId: task.id,
              })
            }
          >
            核对停止
          </button>
        )}
        {["queued", "running"].includes(task.state) && (
          <button
            className="button"
            onClick={() =>
              void model.command({
                type: "stopWidgetGeneration",
                taskId: task.id,
              })
            }
          >
            停止生成
          </button>
        )}
        {["failed", "interrupted", "stopped"].includes(task.state) &&
          !task.stopUnconfirmed &&
          task.attempt < 3 && (
            <button
              className="button"
              onClick={() =>
                void model.command({
                  type: "retryWidgetGeneration",
                  taskId: task.id,
                  attempt: task.attempt,
                })
              }
            >
              重试生成
            </button>
          )}
        {onOpen && (
          <button className="button" onClick={onOpen}>
            打开控件编辑
          </button>
        )}
      </div>
    </article>
  );
}
export function WidgetStudio({
  snapshot,
  connected,
  model,
  selected,
  section,
  onSelect,
  onSection,
  openSettings,
  occluded = false,
  full = false,
  onFull,
  panel = false,
}: {
  snapshot?: Snapshot;
  connected: boolean;
  model: WidgetDraftModel;
  selected?: string;
  section: "widgets" | "drafts";
  onSelect: (id?: string) => void;
  onSection: (s: "widgets" | "drafts") => void;
  openSettings: () => void;
  occluded?: boolean;
  full?: boolean;
  onFull?: (value: boolean) => void;
  panel?: boolean;
}) {
  const studio = useRef<HTMLElement>(null);
  const fullButton = useRef<HTMLButtonElement>(null);
  const scroll = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const viewport = studio.current?.closest(".viewport");
    if (!full && viewport && scroll.current !== undefined) {
      viewport.scrollTop = scroll.current;
      scroll.current = undefined;
      fullButton.current?.focus({ preventScroll: true });
    }
  }, [full]);
  useEffect(() => {
    if (!full) return;
    const restore = () => onFull?.(false);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        restore();
      }
    };
    window.addEventListener("keydown", key);
    const off = window.desktop.onWidgetRestore(restore);
    return () => {
      window.removeEventListener("keydown", key);
      off();
    };
  }, [full, onFull]);
  const [rowMenu, setRowMenu] = useState<string>();
  const [deletingDraft, setDeletingDraft] = useState<WidgetDraft>();
  const [undo, setUndo] = useState<{ id: string; token: string }>();
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<string[]>([]);
  const [search, setSearch] = useState(false);
  const [connection, setConnection] = useState("");
  const draft = snapshot?.widgetGeneration?.drafts.find(
    (d) => d.id === selected,
  );
  const local = selected ? model.value(selected) : undefined;
  const unsaved = selected ? model.locals.get(selected) : undefined;
  const tasks =
    snapshot?.widgetGeneration?.tasks.filter((t) => t.draftId === selected) ??
    [];
  const active = tasks.some((t) =>
    ["queued", "running", "stopping"].includes(t.state),
  );
  const connections = (snapshot?.connections ?? [])
    .filter((c) => c.enabled)
    .flatMap((c) =>
      c.models
        .filter((m) => m.enabled)
        .map((m) => ({
          value: `${c.id}::${m.model}`,
          label: `${c.name} · ${m.model}`,
        })),
    );
  const selectedConnection = connection || connections[0]?.value || "";
  const drafts = (snapshot?.widgetGeneration?.drafts ?? []).filter(
    (d) => snapshot && visibleWidgetDraft(d, snapshot),
  );
  const filtered = drafts.filter((d) =>
    `${d.name}\n${d.input}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  async function leave() {
    setUndo(undefined);
    if (selected && !(await model.confirmed(selected))) return;
    onSelect();
  }
  async function create() {
    setUndo(undefined);
    if (selected && !(await model.confirmed(selected))) return;
    const id = await model.create();
    if (id) onSelect(id);
  }
  return (
    <section
      ref={studio}
      className={`widget-studio ${draft ? "widget-editor" : ""}`}
      data-entry={panel ? "panel" : "main"}
      data-widget-full={full || undefined}
    >
      {full && (
        <div className="widget-restore-zone">
          <button
            className="button widget-restore"
            aria-label="还原控件 Esc"
            onClick={() => onFull?.(false)}
          >
            还原 <kbd>Esc</kbd>
          </button>
        </div>
      )}
      <div className="widget-studio-heading">
        {(draft || section === "drafts") && (
          <button
            className="icon-button"
            aria-label={draft ? "返回控件草稿" : "返回控件"}
            onClick={() => {
              if (draft) void leave();
              else onSection("widgets");
            }}
          >
            <span aria-hidden="true">‹</span>
          </button>
        )}
        {draft && local ? (
          <input
            aria-label="控件草稿名称"
            className="widget-name"
            value={local.name}
            maxLength={160}
            disabled={!connected}
            onChange={(e) => model.edit(draft.id, "name", e.target.value)}
          />
        ) : (
          <h1 tabIndex={-1} data-center-title>
            {panel ? "工作台" : section === "drafts" ? "控件草稿" : "控件"}
          </h1>
        )}
        {!draft && (
          <span className="quiet">
            {section === "drafts"
              ? drafts.length
              : (snapshot?.widgetGeneration?.widgets.length ?? 0)}
          </span>
        )}
        {panel && (
          <button
            className="button"
            onClick={() => void window.desktop.openMain()}
          >
            打开主窗口编辑
          </button>
        )}
        <div className="widget-studio-actions">
          {!draft &&
            section === "widgets" &&
            !!snapshot?.widgetGeneration?.widgets.length &&
            onFull && (
              <button
                ref={fullButton}
                className="button"
                onClick={() => {
                  scroll.current =
                    studio.current?.closest(".viewport")?.scrollTop ?? 0;
                  onFull(true);
                }}
              >
                控件全屏
              </button>
            )}
          {draft &&
            snapshot &&
            (visibleWidgetDraft(draft, snapshot) || !!local?.input) && (
              <button
                className="button"
                disabled={!connected}
                onClick={() => setDeletingDraft(draft)}
              >
                删除草稿
              </button>
            )}
          {!draft && section === "widgets" && targets.length > 0 && (
            <button
              className="button"
              onClick={async () => {
                const id = await model.createEdit(targets);
                if (id) {
                  setTargets([]);
                  onSelect(id);
                }
              }}
            >
              修改所选 {targets.length} 个控件
            </button>
          )}
          {!draft && section === "widgets" && (
            <button className="button" onClick={() => onSection("drafts")}>
              草稿 {drafts.length}
            </button>
          )}
          {!draft && section === "drafts" && (
            <div className="widget-search-anchor">
              <button
                className="icon-button"
                aria-label="搜索控件草稿"
                aria-expanded={search}
                onClick={() => setSearch(!search)}
              >
                <Icon name="search" />
              </button>
              {search && (
                <div className="widget-search-popover">
                  <input
                    autoFocus
                    aria-label="搜索草稿名称或需求"
                    placeholder="搜索草稿名称或需求"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setSearch(false);
                        e.stopPropagation();
                      }
                    }}
                  />
                  {query && (
                    <button className="button" onClick={() => setQuery("")}>
                      清除搜索
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {!draft && (
            <button
              className="button"
              disabled={!connected}
              onClick={() => void create()}
            >
              <Icon name="plus" />
              新建控件
            </button>
          )}
        </div>
      </div>
      {undo && (
        <div className="widget-undo" role="status">
          <span>草稿已删除。</span>
          <button
            className="button"
            onClick={async () => {
              if (await model.undoRemoval(undo.id, undo.token)) {
                setUndo(undefined);
                onSelect(undo.id);
              }
            }}
          >
            撤销删除
          </button>
          <button
            className="icon-button"
            aria-label="关闭撤销删除提示"
            onClick={() => setUndo(undefined)}
          >
            ×
          </button>
        </div>
      )}
      {deletingDraft && (
        <DraftDeletion
          draft={deletingDraft}
          model={model}
          close={() => setDeletingDraft(undefined)}
          deleted={(token) => {
            setUndo({ id: deletingDraft.id, token });
            setDeletingDraft(undefined);
            onSelect();
            onSection("drafts");
          }}
        />
      )}
      {model.error && (
        <p className="error" role="alert">
          {model.error}
        </p>
      )}
      {draft && local ? (
        <>
          <div className="widget-history" aria-label="控件编辑对话">
            {!tasks.length && (
              <div className="widget-empty">
                <Icon name="spark" />
                <h2>
                  {draft.widgetId
                    ? "想怎样修改这个控件？"
                    : "你想做一个什么控件？"}
                </h2>
                <p>
                  {draft.widgetId
                    ? "描述行为、显示或配置的变化，预览后再保留。"
                    : "描述内容与用法，预览后再保留。"}
                </p>
              </div>
            )}
            {tasks.map((t) => (
              <WidgetTaskCard key={t.id} task={t} model={model} />
            ))}
          </div>
          <div className="widget-input-box">
            {unsaved?.error && (
              <div className="error" role="alert">
                <p>{unsaved.error} 输入保留在本窗口，尚未保存。</p>
                <button
                  className="button"
                  disabled={!connected || !!unsaved.saving}
                  onClick={() => void model.retry(draft.id)}
                >
                  重试保存
                </button>
              </div>
            )}
            <label className="widget-input-label" htmlFor="widget-requirement">
              控件需求
            </label>
            <textarea
              id="widget-requirement"
              aria-label="控件需求"
              placeholder={
                draft.widgetId
                  ? "描述要修改的行为、显示或配置…"
                  : "描述控件，或补充新的需求…"
              }
              value={local.input}
              disabled={!connected}
              onChange={(e) => model.edit(draft.id, "input", e.target.value)}
            />
            <div className="widget-input-footer">
              <select
                aria-label="生成使用的模型"
                value={selectedConnection}
                disabled={active || !connected}
                onChange={(e) => setConnection(e.target.value)}
              >
                {!connections.length && <option value="">尚无可用模型</option>}
                {connections.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <button
                className="button primary"
                disabled={
                  !connected ||
                  !local.input.trim() ||
                  !!unsaved?.dirty ||
                  !selectedConnection
                }
                onClick={() => {
                  const [id, ...rest] = selectedConnection.split("::");
                  void model.submit(draft.id, id, rest.join("::"), active);
                }}
              >
                {active
                  ? "补充需求并重新生成"
                  : draft.widgetId
                    ? "生成修改"
                    : "生成控件"}
              </button>
            </div>
            <div className="widget-save-note" role="status">
              <span>
                {unsaved?.error
                  ? "尚未保存"
                  : unsaved?.dirty
                    ? "正在保存…"
                    : "草稿已保存"}
              </span>
              {!connections.length && (
                <button onClick={openSettings}>设置模型</button>
              )}
            </div>
          </div>
        </>
      ) : section === "drafts" ? (
        <>
          {!drafts.length ? (
            <div className="widget-empty">
              <Icon name="edit" />
              <h2>还没有控件草稿</h2>
              <p>每个新控件都有独立草稿，同名也不会覆盖。</p>
            </div>
          ) : !filtered.length ? (
            <div className="widget-empty">
              <Icon name="search" />
              <h2>没有匹配的控件草稿</h2>
              <p>试试其他关键词，或清除搜索条件。</p>
            </div>
          ) : (
            <div className="widget-draft-list">
              {filtered.map((d) => {
                const t = snapshot?.widgetGeneration?.tasks
                  .filter((t) => t.draftId === d.id)
                  .at(-1);
                return (
                  <article className="widget-draft-entry" key={d.id}>
                    <button
                      className="widget-draft-row"
                      aria-label={`编辑草稿 ${d.id.slice(0, 8)}`}
                      onClick={() => {
                        setUndo(undefined);
                        onSelect(d.id);
                      }}
                    >
                      <Icon name="grid" />
                      <span>
                        <strong>{d.name}</strong>
                        <small>
                          {d.widgetId ? "修改控件" : "新建控件"} ·{" "}
                          {d.id.slice(0, 8)}
                        </small>
                        <p>{d.input || t?.requirement || "尚未输入需求"}</p>
                      </span>
                      <small>{t ? generationLabels[t.state] : "未生成"}</small>
                    </button>
                    <div className="widget-draft-menu-anchor">
                      <button
                        className="icon-button"
                        aria-label={`草稿操作 ${d.id.slice(0, 8)}`}
                        aria-expanded={rowMenu === d.id}
                        onClick={() =>
                          setRowMenu(rowMenu === d.id ? undefined : d.id)
                        }
                      >
                        ···
                      </button>
                      {rowMenu === d.id && (
                        <div
                          className="widget-draft-menu"
                          role="menu"
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.stopPropagation();
                              setRowMenu(undefined);
                            }
                          }}
                        >
                          <button
                            className="button"
                            role="menuitem"
                            autoFocus
                            disabled={!connected}
                            onClick={() => {
                              setRowMenu(undefined);
                              setDeletingDraft(d);
                            }}
                          >
                            删除草稿
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      ) : (snapshot?.widgetGeneration?.widgets.length ?? 0) ? (
        <div>
          {snapshot?.widgetGeneration?.layout?.fallback && (
            <p role="alert" className="error">
              {snapshot.widgetGeneration.layout.fallback}
            </p>
          )}
          <div
            className="widget-draft-list widget-formal-grid"
            style={{
              gridTemplateColumns: `repeat(auto-fit,minmax(min(100%,${snapshot?.widgetGeneration?.layout?.value.minWidth ?? 320}px),1fr))`,
              gap: snapshot?.widgetGeneration?.layout?.value.gap ?? 16,
            }}
            data-density={snapshot?.widgetGeneration?.layout?.value.density}
          >
            {snapshot!.widgetGeneration!.widgets.map((w) => (
              <article
                className="widget-saved-card"
                key={w.id}
                data-formal-widget={w.id}
              >
                <div className="widget-formal-controls">
                  <h2>{w.name}</h2>
                  <label className="widget-target-choice">
                    <input
                      type="checkbox"
                      aria-label={`选择控件 ${w.name} ${w.id.slice(0, 8)}`}
                      checked={targets.includes(w.id)}
                      onChange={(e) =>
                        setTargets(
                          e.target.checked
                            ? [...targets, w.id]
                            : targets.filter((id) => id !== w.id),
                        )
                      }
                    />
                    选择修改
                  </label>
                  <p>已保留 · 版本 {w.revision}</p>
                  <button
                    className="button"
                    onClick={() => {
                      const d = snapshot!.widgetGeneration!.drafts.find(
                        (d) => d.widgetId === w.id,
                      );
                      if (d) onSelect(d.id);
                    }}
                  >
                    打开控件
                  </button>
                  <button
                    className="button"
                    onClick={async () => {
                      const id = await model.createEdit([w.id]);
                      if (id) onSelect(id);
                    }}
                  >
                    新建修改草稿
                  </button>
                </div>
                <WidgetWorkspace
                  key={w.candidateId}
                  slot={`formal:${w.id}`}
                  candidateId={w.candidateId}
                  retained
                  connected={connected}
                  occluded={occluded}
                  contentOnly={full}
                />
              </article>
            ))}
          </div>
        </div>
      ) : (
        <div className={panel ? "empty" : "widget-empty"}>
          <span className={panel ? "empty-icon" : "widget-canvas-empty-icon"}>
            <Icon name="grid" />
          </span>
          <h2>{panel ? "工作台还是空的" : "还没有控件"}</h2>
          <p>
            {panel
              ? "在主窗口创建控件，保留后可在工作台查看。"
              : "从一个想法开始，创建属于自己的小工具。"}
          </p>
          <button
            className="button"
            disabled={!connected}
            onClick={() =>
              panel ? void window.desktop.openMain() : void create()
            }
          >
            {panel ? "打开主窗口" : "新建控件"}
          </button>
        </div>
      )}
    </section>
  );
}

function DraftDeletion({
  draft,
  model,
  close,
  deleted,
}: {
  draft: WidgetDraft;
  model: WidgetDraftModel;
  close: () => void;
  deleted: (token: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false);
  useEffect(() => openModal(dialog.current!), []);
  return (
    <dialog
      ref={dialog}
      className="rename-dialog widget-confirmation"
      aria-label="确认删除控件草稿"
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
          const token = await model.remove(draft.id);
          setBusy(false);
          if (token) deleted(token);
          else setFailed(true);
        }}
      >
        <h2>删除这个草稿？</h2>
        <p>
          {draft.name} · {draft.id.slice(0, 8)}
        </p>
        <p>
          将先停止生成，再清理本草稿的候选和未提交输入。正式控件及编辑历史保留，草稿不进入最近删除。
        </p>
        <p>删除后可即时撤销，恢复候选和输入。恢复不会重新开始生成。</p>
        {busy && <p role="status">正在确认停止并删除草稿…</p>}
        {failed && (
          <p className="error" role="alert">
            {model.error || "删除未完成，草稿仍保留。"}
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
          <button className="button" disabled={busy}>
            确认删除
          </button>
        </div>
      </form>
    </dialog>
  );
}
