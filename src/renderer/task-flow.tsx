import { taskRoute } from "./task-route";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectionObject } from "../shared/runtime-host";
import type { Project } from "../shared/projects";
import type { ProjectWorkView } from "../shared/project-work";
import type { Business } from "./project-detail";
import { useProjectColumns } from "./project-columns";
import { RightPanel } from "./main-shell";
import {
  Graph,
  ProjectView,
  type GraphNode,
  type GraphEdge,
} from "./project-views";
import { ProjectActionPanel } from "./project-actions";
import { ProjectPendingList } from "./project-pending";
import { EvidenceReader, type EvidenceCache } from "./project-evidence";

/** Domain identity comes only from the projection. Local selection never changes action identity. */
export function TaskFlow({
  project,
  object,
  view,
  model,
  cache,
  onBrowse,
}: {
  project: Project;
  object: ProjectionObject;
  view: ProjectWorkView;
  model: Business;
  cache: EvidenceCache;
  onBrowse: (ref: string) => void;
}) {
  const columns = useProjectColumns();
  const key = `task-view:${project.id}:${object.scopeRef}:${object.objectRef}`;
  const [mode, setMode] = useState(() =>
    (taskRoute()?.project === project.id &&
    taskRoute()?.object === object.objectRef
      ? taskRoute()?.view
      : sessionStorage.getItem(key)) === "detail"
      ? "detail"
      : "flow",
  );
  const [tab, setTab] = useState("inspector");
  const [selection, setSelection] = useState("");
  const [traceRef, setTraceRef] = useState(
    () => sessionStorage.getItem(`${key}:trace`) ?? "",
  );
  const actionsRef = useRef<HTMLElement>(null);
  const [full, setFull] = useState(false);
  const [actionsOverflow, setActionsOverflow] = useState(false);
  useEffect(() => {
    const area = actionsRef.current;
    if (!area) return;
    const measure = () =>
      setActionsOverflow(area.scrollHeight > area.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    for (const child of area.children) observer.observe(child);
    measure();
    return () => observer.disconnect();
  }, [object, view.projection]);
  const fullButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".app");
    if (shell) shell.dataset.taskFull = String(full);
    if (!full)
      return () => {
        if (shell) delete shell.dataset.taskFull;
      };
    const restore = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.isComposing ||
        event.defaultPrevented ||
        document.querySelector(
          'dialog[open], [role="menu"], .project-menu, .conversation-menu',
        )
      )
        return;
      event.preventDefault();
      setFull(false);
      requestAnimationFrame(() => fullButton.current?.focus());
    };
    window.addEventListener("keydown", restore, true);
    return () => {
      if (shell) delete shell.dataset.taskFull;
      window.removeEventListener("keydown", restore, true);
    };
  }, [full]);

  const setOpen = columns?.setOpen;
  useEffect(() => {
    if (mode === "flow") setOpen?.(true);
    sessionStorage.setItem(key, mode);
    sessionStorage.setItem(
      "task-route",
      JSON.stringify({
        project: project.id,
        object: object.objectRef,
        view: mode,
      }),
    );
  }, [mode, key, setOpen, project.id, object.objectRef]);
  const select = useCallback(
    (id: string) => {
      setSelection(id);
      if (id) {
        setTab("inspector");
        setOpen?.(true);
      }
    },
    [setOpen],
  );
  const nodes = (object.view.nodes ?? []) as GraphNode[],
    edges = (object.view.edges ?? []) as GraphEdge[];
  const node = nodes.find((n) => n.id === selection),
    edge = edges.find((e) => `edge:${e.id}` === selection);
  const unavailable =
    view.unavailable || (!model.status.connected ? "业务服务未连接。" : "");
  const traces =
    view.projection?.objects.filter((o) => o.view.kind === "trace") ?? [];
  const trace = traces.find((o) => o.objectRef === traceRef);
  const source = { object, projectId: project.id, cache, unavailable };
  const actions = (
    <section
      className="task-fixed-actions"
      aria-label="任务操作"
      tabIndex={-1}
      ref={actionsRef}
    >
      <div className="project-section-heading">
        <h3>{object.title}</h3>
        <span title={object.stateLabel}>{object.stateLabel}</span>
      </div>
      <p className="project-source">
        {object.objectRef} · 版本 {object.revision}
      </p>
      {unavailable && (
        <p role="status" className="project-error">
          {unavailable}
        </p>
      )}
      <ProjectActionPanel
        project={project}
        object={object}
        actions={view.projection!.actions}
        snapshot={model.snapshot!}
        unavailable={unavailable}
        awaiting={view.awaiting.find((a) => a.objectRef === object.objectRef)}
      />
      <ProjectPendingList
        entries={[
          {
            project,
            unavailable,
            view: {
              ...view,
              projection: {
                ...view.projection!,
                pendingItems: view.projection!.pendingItems.filter(
                  (item) =>
                    item.objectRef === object.objectRef &&
                    item.scopeRef === object.scopeRef,
                ),
              },
            },
          },
        ]}
        refresh={() => void model.reload()}
      />
    </section>
  );
  const inspector = (
    <section
      className="project-node-detail"
      aria-label={node || edge ? "节点详情" : "运行摘要"}
    >
      {node ? (
        <>
          <h3>{node.label}</h3>
          <p>{node.stateLabel}</p>
          <p className="project-source">
            {node.id} · {node.kind ?? "未提供类型"}
          </p>
          <p>已选择，仅表示浏览位置。</p>
          <h4>相邻节点与条件</h4>
          <ul>
            {edges
              .filter((e) => e.source === node.id || e.target === node.id)
              .map((e) => (
                <li key={e.id}>
                  {nodes.find((n) => n.id === e.source)?.label} →{" "}
                  {nodes.find((n) => n.id === e.target)?.label} · {e.label} ·{" "}
                  {e.semantics ?? "未提供条件语义"}
                </li>
              ))}
          </ul>
        </>
      ) : edge ? (
        <>
          <h3>{edge.label}</h3>
          <p>{edge.semantics ?? "未提供条件语义"}</p>
          <p>
            {edge.source} → {edge.target}
          </p>
          <p className="project-source">{edge.id}</p>
        </>
      ) : (
        <>
          <h3>运行摘要</h3>
          <p>当前投影版本 {object.revision}</p>
          <p>未提供运行身份与历史运行关联。选择节点查看说明。</p>
        </>
      )}
      <dl className="metadata">
        <dt>当前节点</dt>
        <dd>未提供当前位置</dd>
        <dt>节点状态</dt>
        <dd>未提供稳定状态，按来源原文显示</dd>
        <dt>下一步</dt>
        <dd>未提供节点操作；任务操作见上方。</dd>
        <dt>尝试</dt>
        <dd>未提供</dd>
        <dt>输入与输出</dt>
        <dd>未提供</dd>
        <dt>判词</dt>
        <dd>未提供</dd>
        <dt>节点证据关联</dt>
        <dd>未提供</dd>
      </dl>
    </section>
  );
  const panel = columns && (
    <RightPanel
      owner={`任务：${object.title}`}
      enlarged={full}
      tabs={[
        { id: "inspector", name: "节点检查器", icon: "note", body: inspector },
        {
          id: "trace",
          name: "Trace 日志",
          icon: "activity",
          body: (
            <>
              <label className="task-source-picker">
                Trace 来源
                <select
                  aria-label="Trace 来源"
                  value={trace?.objectRef ?? ""}
                  onChange={(e) => {
                    setTraceRef(e.target.value);
                    sessionStorage.setItem(`${key}:trace`, e.target.value);
                  }}
                >
                  <option value="">选择来源对象</option>
                  {traces.map((t) => (
                    <option key={t.objectRef} value={t.objectRef}>
                      {t.title} · {t.objectRef}
                    </option>
                  ))}
                </select>
              </label>
              <p className="project-form-hint">
                未提供任务与运行关联。此处只浏览明确选择的 Trace
                来源，不改变上方任务操作。
              </p>
              {trace ? (
                <ProjectView
                  {...source}
                  object={trace}
                  includeEvidence={false}
                />
              ) : (
                <p>Trace 日志不可用：请先选择已有来源对象。</p>
              )}
            </>
          ),
        },
        {
          id: "files",
          name: "文件",
          icon: "file",
          body: object.evidence.length ? (
            object.evidence.map((_, index) => (
              <EvidenceReader
                key={`${object.objectRef}:${index}`}
                {...source}
                source={{ kind: "evidence", index }}
                label={`产物与依据 ${index + 1}`}
              />
            ))
          ) : (
            <p>产物不可用：当前对象未提供产物。</p>
          ),
        },
      ]}
      activeTab={tab}
      onTab={setTab}
      layout={columns.layout}
      width={columns.layout.right}
      panelRef={columns.panelRef}
      takeoverButton={columns.takeoverRef}
      onWidth={columns.width}
      onPreview={columns.preview}
      onTakeover={() => columns.setTakeover(!columns.layout.takeover)}
      onClose={columns.close}
      browser={
        <>
          <nav
            className="project-object-tabs task-source-navigation"
            aria-label="Runtime 内容"
          >
            {view.projection!.objects.map((o) => (
              <button
                key={o.objectRef}
                className="button"
                aria-pressed={o.objectRef === object.objectRef}
                onClick={() => onBrowse(o.objectRef)}
              >
                {o.title}
              </button>
            ))}
          </nav>
          {actions}
          {actionsOverflow && (
            <p className="task-actions-scroll-hint">
              操作区可独立滚动，查看其余操作与记录。
            </p>
          )}
        </>
      }
    />
  );
  return (
    <section className="task-flow" aria-label="任务详情">
      <header className="task-flow-header">
        <div className="project-section-heading">
          <h2>{object.title}</h2>
          <button
            ref={fullButton}
            className="button"
            onClick={() => {
              if (!full) columns?.setTakeover(false);
              setFull(!full);
            }}
            aria-label={full ? "还原任务视图" : "放大任务视图"}
          >
            {full ? (
              <>
                还原 <kbd>Esc</kbd>
              </>
            ) : (
              "放大"
            )}
          </button>
          <button
            className="button"
            onClick={() => {
              setOpen?.(true);
              requestAnimationFrame(() => actionsRef.current?.focus());
            }}
          >
            任务操作
          </button>
        </div>
        <div className="task-view-toolbar">
          <div role="tablist" aria-label="任务视图">
            {[
              ["detail", "详情"],
              ["flow", "流程"],
            ].map(([id, label]) => (
              <button
                className="button"
                key={id}
                role="tab"
                aria-selected={mode === id}
                onClick={() => setMode(id)}
                onKeyDown={(e) => {
                  if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
                    e.preventDefault();
                    setMode(id === "detail" ? "flow" : "detail");
                    (
                      e.currentTarget.parentElement?.querySelectorAll("button")[
                        id === "detail" ? 1 : 0
                      ] as HTMLElement
                    )?.focus();
                  }
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <label>
            运行
            <select aria-label="任务运行" value="projection" disabled>
              <option value="projection">当前投影（未提供运行身份）</option>
            </select>
          </label>
        </div>
      </header>
      <div hidden={mode !== "detail"} className="task-detail-summary">
        <h3>任务状态</h3>
        <p>{object.stateLabel}</p>
        <p>当前环节：未提供当前位置。</p>
        <p>历史运行不可用：未提供任务与运行关联。</p>
        <p>人工决定与禁止原因见右栏任务操作。</p>
        <p className="project-source">
          {object.objectRef} · 版本 {object.revision}
        </p>
      </div>
      <div hidden={mode !== "flow"} className="task-flow-body">
        <div className="task-flow-notice">
          <button className="button" disabled title="未提供当前位置">
            定位当前节点
          </button>
          <span>未提供当前位置；节点状态保持来源原文。</span>
        </div>
        {object.view.kind === "graph" ? (
          <Graph
            object={object}
            projectId={project.id}
            onSelect={select}
            inspector={false}
          />
        ) : (
          <p className="project-empty-small" role="status">
            流程不可用：当前对象未提供流程投影。
          </p>
        )}
      </div>
      {unavailable && (
        <p role="status" className="project-error">
          {unavailable}
        </p>
      )}
      {columns?.host && createPortal(panel, columns.host)}
    </section>
  );
}
