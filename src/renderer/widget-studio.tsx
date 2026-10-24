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
import { useWidgetOrder } from "./widget-order";
import { widgetOrderDragType } from "../shared/widget-ui";
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
  focusWidget,
  onFocused,
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
  /** A retained widget to bring into view and focus, from a search result (SEARCH-01). */
  focusWidget?: string;
  onFocused?: () => void;
}) {
  const studio = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusWidget || selected || section !== "widgets") return;
    const card = studio.current?.querySelector<HTMLElement>(
      `[data-formal-widget="${focusWidget}"]`,
    );
    if (!card) return;
    onFocused?.();
    card.scrollIntoView({ block: "center" });
    card.dataset.searchTarget = "true";
    // The search panel returns focus to its opener as it closes; focus the card after that frame.
    // Clearing the target re-runs this effect; the scheduled focus and mark removal still apply to this card.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => card.focus({ preventScroll: true })),
    );
    setTimeout(() => delete card.dataset.searchTarget, 2400);
  }, [focusWidget, selected, section, snapshot, onFocused]);
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
  const order = useWidgetOrder(snapshot);
  const [layoutEdit, setLayoutEdit] = useState(false);
  const [widgetMenu, setWidgetMenu] = useState<string>();
  const [drag, setDrag] = useState<{
    id: string;
    over?: string;
    after?: boolean;
  }>();
  // The card being dragged. A drop over a native widget view reaches the host through the main process and can
  // arrive after the source's dragend, so the source stays known for a moment after the drag ends (KB-04).
  const dragSource = useRef<{ id: string; ended?: number }>(undefined);
  const dragEnded = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    // The overlay rows of every card show or hide, or a card's menu opens below its row; native views
    // re-measure their clip so trusted controls are never covered.
    window.dispatchEvent(new Event("widget-display-change"));
  }, [layoutEdit, widgetMenu]);
  useEffect(() => {
    if (!widgetMenu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest?.(".widget-order-menu-anchor"))
        setWidgetMenu(undefined);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [widgetMenu]);
  /** Moves a widget by one place and keeps focus on the control the person used (WB-02). */
  function step(id: string, delta: -1 | 1, focus: "layout" | "menu") {
    const index = order.widgets.findIndex((w) => w.id === id);
    order.move(id, index + delta);
    requestAnimationFrame(() => {
      const card = studio.current?.querySelector(
        `[data-formal-widget="${id}"]`,
      );
      const target =
        focus === "layout"
          ? card?.querySelector<HTMLButtonElement>(
              `[data-order-step="${delta}"]:not(:disabled)`,
            )
          : null;
      (
        target ?? card?.querySelector<HTMLButtonElement>(".widget-order-more")
      )?.focus();
    });
  }
  function dropOn(id: string, event: React.DragEvent<HTMLElement>) {
    if (!drag || drag.id === id) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    const after = event.clientX >= box.left + box.width / 2;
    if (drag.over !== id || drag.after !== after)
      setDrag({ ...drag, over: id, after });
  }
  function drop() {
    if (!drag?.over) return setDrag(undefined);
    commitDrop(drag.id, drag.over, !!drag.after);
  }
  function commitDrop(id: string, over: string, after: boolean) {
    dragSource.current = undefined;
    setDrag(undefined);
    // The dragged card holds the focus after the drop, wherever it landed (mac-feature-t11:KB-05).
    requestAnimationFrame(() => {
      const card = studio.current?.querySelector<HTMLElement>(
        `[data-formal-widget="${id}"]`,
      );
      if (card && document.activeElement !== card)
        card.focus({ preventScroll: true });
    });
    if (id === over) return;
    const rest = order.widgets.filter((w) => w.id !== id);
    order.move(id, rest.findIndex((w) => w.id === over) + (after ? 1 : 0));
  }
  // Drag events relayed from the native widget views: the same indicator and drop as over the host page.
  const nativeDrag = useRef<(event: Event) => void>(undefined);
  nativeDrag.current = (event: Event) => {
    const source = dragSource.current;
    const over = (event.target as HTMLElement).dataset?.formalWidget;
    const detail = (event as CustomEvent<{ phase: string; after: boolean }>)
      .detail;
    if (!source || !over) return;
    if (detail.phase === "drop") commitDrop(source.id, over, detail.after);
    else if (!source.ended && source.id !== over)
      setDrag((current) =>
        current?.over === over && current.after === detail.after
          ? current
          : { id: source.id, over, after: detail.after },
      );
  };
  useEffect(() => {
    const node = studio.current;
    const listener = (event: Event) => nativeDrag.current?.(event);
    node?.addEventListener("widget-native-drag", listener);
    return () => {
      node?.removeEventListener("widget-native-drag", listener);
      clearTimeout(dragEnded.current);
    };
  }, []);
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
            className="icon-button widget-restore"
            aria-label="还原（Esc）"
            title="还原（Esc）"
            onClick={() => onFull?.(false)}
          >
            <Icon name="fullscreenExit" />
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
                className="icon-button"
                aria-label="控件全屏"
                title="控件全屏"
                onClick={() => {
                  scroll.current =
                    studio.current?.closest(".viewport")?.scrollTop ?? 0;
                  onFull(true);
                }}
              >
                <Icon name="fullscreenEnter" />
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
          {!draft &&
            section === "widgets" &&
            !panel &&
            order.widgets.length > 1 && (
              <button
                className="button"
                aria-pressed={layoutEdit}
                onClick={() => setLayoutEdit(!layoutEdit)}
              >
                <Icon name="layout" />
                {layoutEdit ? "完成布局编辑" : "编辑布局"}
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
          {!panel && layoutEdit && (
            <p className="widget-layout-note">
              拖动控件或用「前移 / 后移」调整顺序，立即生效，不需要保存。
            </p>
          )}
          {/* Progress and success are announced; the moved card itself is the visible result (WB-02). */}
          {!panel && (
            <p className="widget-order-announce" role="status">
              {order.notice?.kind === "saving"
                ? "正在保存顺序…"
                : order.notice?.kind === "saved"
                  ? order.notice.text
                  : ""}
            </p>
          )}
          {!panel &&
            (order.notice?.kind === "failed" ||
              order.notice?.kind === "conflict") && (
              <div className="widget-order-notice error" role="alert">
                <span>{order.notice.text}</span>
                {order.notice.kind === "failed" && order.notice.retry && (
                  <button
                    className="button small"
                    disabled={!connected}
                    onClick={order.retry}
                  >
                    重试
                  </button>
                )}
                <button
                  className="icon-button"
                  aria-label="关闭顺序提示"
                  onClick={order.dismiss}
                >
                  ×
                </button>
              </div>
            )}
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
            {order.widgets.map((w, index, list) => (
              <article
                className={`widget-saved-card ${drag?.id === w.id ? "dragging" : ""} ${drag?.over === w.id ? (drag.after ? "drop-after" : "drop-before") : ""}`}
                key={w.id}
                data-formal-widget={w.id}
                tabIndex={-1}
                aria-label={`控件 ${w.name} ${w.id.slice(0, 8)}`}
                data-layout-edit={(!panel && layoutEdit) || undefined}
                onDragOver={drag ? (event) => dropOn(w.id, event) : undefined}
                onDrop={
                  drag
                    ? (event) => {
                        event.preventDefault();
                        drop();
                      }
                    : undefined
                }
              >
                {/* One row at every card width: text truncates with its full value in title,
                    and narrow cards show the actions as icons with the same names. */}
                <div className="widget-formal-controls">
                  {layoutEdit && !panel && (
                    <span
                      className="widget-order-grip"
                      draggable
                      title="拖动调整顺序"
                      aria-hidden="true"
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        // Only the private order type: no text a widget or another app could take in.
                        event.dataTransfer.setData(widgetOrderDragType, w.id);
                        const card = event.currentTarget.closest("article");
                        if (card) event.dataTransfer.setDragImage(card, 24, 24);
                        clearTimeout(dragEnded.current);
                        dragSource.current = { id: w.id };
                        setDrag({ id: w.id });
                      }}
                      onDragEnd={() => {
                        setDrag(undefined);
                        const source = dragSource.current;
                        if (!source) return;
                        source.ended = Date.now();
                        dragEnded.current = setTimeout(() => {
                          if (dragSource.current === source)
                            dragSource.current = undefined;
                        }, 1000);
                      }}
                    >
                      <Icon name="grip" />
                    </span>
                  )}
                  <h2 title={w.name}>{w.name}</h2>
                  <p title={`已保留 · 版本 ${w.revision}`}>
                    已保留 · 版本 {w.revision}
                  </p>
                  {layoutEdit && !panel ? (
                    <>
                      <button
                        className="button widget-control-action"
                        data-order-step={-1}
                        aria-label={`前移 ${w.name} ${w.id.slice(0, 8)}`}
                        title={index === 0 ? "已在最前" : "前移"}
                        disabled={index === 0 || !connected}
                        onClick={() => step(w.id, -1, "layout")}
                      >
                        <Icon name="arrowUp" />
                        <span className="widget-control-text">前移</span>
                      </button>
                      <button
                        className="button widget-control-action"
                        data-order-step={1}
                        aria-label={`后移 ${w.name} ${w.id.slice(0, 8)}`}
                        title={index === list.length - 1 ? "已在最后" : "后移"}
                        disabled={index === list.length - 1 || !connected}
                        onClick={() => step(w.id, 1, "layout")}
                      >
                        <Icon name="arrowDown" />
                        <span className="widget-control-text">后移</span>
                      </button>
                    </>
                  ) : (
                    <>
                      <label className="widget-target-choice" title="选择修改">
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
                        <span className="widget-control-text">选择修改</span>
                      </label>
                      <button
                        className="button widget-control-action"
                        aria-label="打开控件"
                        title="打开控件"
                        onClick={() => {
                          const d = snapshot!.widgetGeneration!.drafts.find(
                            (d) => d.widgetId === w.id,
                          );
                          if (d) onSelect(d.id);
                        }}
                      >
                        <Icon name="open" />
                        <span className="widget-control-text">打开控件</span>
                      </button>
                      <button
                        className="button widget-control-action"
                        aria-label="新建修改草稿"
                        title="新建修改草稿"
                        onClick={async () => {
                          const id = await model.createEdit([w.id]);
                          if (id) onSelect(id);
                        }}
                      >
                        <Icon name="compose" />
                        <span className="widget-control-text">
                          新建修改草稿
                        </span>
                      </button>
                    </>
                  )}
                  {!panel && (
                    <div className="widget-order-menu-anchor">
                      <button
                        className="icon-button widget-order-more"
                        aria-label={`控件操作 ${w.name} ${w.id.slice(0, 8)}`}
                        title="控件操作"
                        aria-haspopup="menu"
                        aria-expanded={widgetMenu === w.id}
                        onClick={() =>
                          setWidgetMenu(widgetMenu === w.id ? undefined : w.id)
                        }
                      >
                        ···
                      </button>
                      {widgetMenu === w.id && (
                        <div
                          className="widget-draft-menu widget-order-menu"
                          role="menu"
                          aria-label={`控件操作：${w.name}`}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.stopPropagation();
                              setWidgetMenu(undefined);
                              e.currentTarget.parentElement
                                ?.querySelector<HTMLButtonElement>(
                                  ".widget-order-more",
                                )
                                ?.focus();
                            }
                            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                              e.preventDefault();
                              const items = [
                                ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                                  "[role=menuitem]",
                                ),
                              ];
                              const at = items.indexOf(
                                document.activeElement as HTMLButtonElement,
                              );
                              items[
                                (at +
                                  (e.key === "ArrowDown" ? 1 : -1) +
                                  items.length) %
                                  items.length
                              ]?.focus();
                            }
                          }}
                        >
                          <button
                            className="button"
                            role="menuitem"
                            autoFocus
                            aria-disabled={index === 0 || !connected}
                            onClick={() => {
                              if (index === 0 || !connected) return;
                              setWidgetMenu(undefined);
                              step(w.id, -1, "menu");
                            }}
                          >
                            前移
                            {index === 0 && <small>已在最前</small>}
                          </button>
                          <button
                            className="button"
                            role="menuitem"
                            aria-disabled={
                              index === list.length - 1 || !connected
                            }
                            onClick={() => {
                              if (index === list.length - 1 || !connected)
                                return;
                              setWidgetMenu(undefined);
                              step(w.id, 1, "menu");
                            }}
                          >
                            后移
                            {index === list.length - 1 && (
                              <small>已在最后</small>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
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
