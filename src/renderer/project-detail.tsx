import { createPortal } from "react-dom";
import { useProjectColumns } from "./project-columns";
import { RightPanel } from "./main-shell";
import { EvidenceReader } from "./project-evidence";
import { ProjectPendingList } from "./project-pending";
import { ProjectChatLayout, useProjectLayout } from "./project-layout";
import { ProjectView } from "./project-views";
import type { EvidenceCache } from "./project-evidence";
import { ProjectActionPanel } from "./project-actions";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Project } from "../shared/projects";
import type { ProjectRequest, ProjectWorkView } from "../shared/project-work";
import type { Snapshot } from "../shared/protocol";
import type { useBusiness } from "./state";
import { ProjectChat } from "./project-chat";
import { ProjectAccessPanel } from "./project-access";
export type Business = ReturnType<typeof useBusiness>;
export function modelReason(
  snapshot: Snapshot,
  connectionId: string,
  modelId: string,
) {
  const c = snapshot.connections.find((c) => c.id === connectionId),
    m = c?.models.find((m) => m.model === modelId);
  if (!c || !m) return "模型已移除";
  if (!c.enabled || !m.enabled) return "已停用";
  if (c.provider === "codex" && (!snapshot.settings.codex.enabled || !m.codex))
    return "Codex 来源未确认或已停用";
  if (
    c.provider === "claude" &&
    (!snapshot.settings.claude.enabled || !m.claude)
  )
    return "Claude Code 来源未确认或已停用";
  if (!["claude", "codex"].includes(c.provider) && !c.secretRef)
    return "未配置密钥";
  return "";
}
function Role({
  entry,
  snapshot,
  project,
  act,
  busy,
}: {
  entry: ProjectWorkView["roles"][number];
  snapshot: Snapshot;
  project: Project;
  act: (request: ProjectRequest) => Promise<void>;
  busy: boolean;
}) {
  const b = entry.binding;
  const [value, setValue] = useState(b ? `${b.connectionId}::${b.model}` : ""),
    [effort, setEffort] = useState(b?.effort ?? "");
  const label = entry.role === "implementer" ? "实施者" : "评审者",
    provider = entry.role === "implementer" ? "claude" : "codex";
  const [id, ...parts] = value.split("::"),
    modelId = parts.join("::"),
    connection = snapshot.connections.find((c) => c.id === id),
    model = connection?.models.find((m) => m.model === modelId);
  const reason = value ? modelReason(snapshot, id, modelId) : "请选择模型";
  return (
    <fieldset className="project-role" disabled={busy || !entry.available}>
      <legend>
        {label} <span>{provider === "claude" ? "Claude Code" : "Codex"}</span>
      </legend>
      <label>
        Agent 与模型
        <select
          aria-label={`${label}模型`}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setEffort("");
          }}
        >
          <option value="">请选择全局模型</option>
          {value && !model && (
            <option value={value} disabled>
              原模型已移除
            </option>
          )}
          {snapshot.connections
            .filter((c) => c.provider === provider)
            .flatMap((c) =>
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
          aria-label={`${label}推理强度`}
          value={effort}
          disabled={!model?.effort || busy || !entry.available}
          onChange={(e) => setEffort(e.target.value)}
        >
          <option value="">
            {model?.effort
              ? `默认（${model.effort.defaultLevel ?? "未记录"}）`
              : "未记录，按模型默认执行"}
          </option>
          {effort && !model?.effort?.levels.includes(effort) && (
            <option value={effort} disabled>
              原档位 {effort} 不可用
            </option>
          )}
          {model?.effort?.levels.map((level) => (
            <option key={level}>{level}</option>
          ))}
        </select>
      </label>
      <button
        className="button"
        disabled={
          busy ||
          !entry.available ||
          !!reason ||
          (!!effort && !model?.effort?.levels.includes(effort))
        }
        onClick={() =>
          void act({
            type: "role",
            projectId: project.id,
            role: entry.role,
            connectionId: id,
            model: modelId,
            effort: effort || null,
            expectedUpdatedAt: b?.updatedAt ?? null,
          })
        }
      >
        保存{label}
      </button>
      <p className="project-form-hint">
        {entry.reason ||
          (b
            ? `已保存：${b.model} · ${b.effort ?? "模型默认"}`
            : "尚未保存角色选择")}
      </p>
    </fieldset>
  );
}
export function ProjectDetail({
  project,
  model,
  onOpenSettings,
}: {
  project: Project;
  model: Business;
  onOpenSettings?: (tab: "扩展管理" | "访问权限") => void;
}) {
  const snapshot = model.snapshot!;
  const columns = useProjectColumns();
  const [panelTab, setPanelTab] = useState("document");
  const [discussion, setDiscussion] = useState({
    ref: "",
    title: "项目名称与目标",
    conversation: "项目对话",
  });
  const evidenceCache = useRef<EvidenceCache>(new Map());
  const layout = useProjectLayout(project.id, columns);
  const [view, setView] = useState<ProjectWorkView | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [scope, setScope] = useState("");
  const [objectId, setObjectId] = useState(
    () => sessionStorage.getItem(`project-object:${project.id}`) ?? "",
  );
  const [query, setQuery] = useState(
      () => sessionStorage.getItem(`project-query:${project.id}`) ?? "",
    ),
    [filter, setFilter] = useState(
      () => sessionStorage.getItem(`project-filter:${project.id}`) ?? "",
    );
  const [group, setGroup] = useState(
    () => sessionStorage.getItem(`project-group:${project.id}`) ?? "none",
  );
  const requestSeq = useRef(0);
  useEffect(() => {
    let active = true;
    const n = ++requestSeq.current;
    void window.desktop
      .projectWork({ type: "read", projectId: project.id })
      .then((r) => {
        if (!active || n !== requestSeq.current) return;
        if (r.ok && r.view) setView(r.view);
        else if (!r.ok) setError(r.message);
      })
      .catch(() => {
        if (active) setError("未能读取项目内容，请重新读取。");
      });
    return () => {
      active = false;
    };
  }, [project.id, snapshot.revision]);
  async function act(request: ProjectRequest) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await window.desktop.projectWork(request);
      if (!r.ok) setError(r.message);
      else if (r.view) setView(r.view);
      await model.reload();
    } catch {
      setError("操作结果未确认，请重新读取项目。");
    } finally {
      setBusy(false);
    }
  }
  const objects = view?.projection?.objects ?? [],
    selected = objects.find((o) => o.objectRef === objectId) ?? objects[0];
  const rows =
    selected?.view.kind === "list"
      ? (selected.view.rows as { id: string; title: string; detail: string }[])
      : [];
  const shown = rows.filter(
    (row) =>
      (!filter || row.detail === filter) &&
      `${row.title} ${row.detail}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const disabled = busy || !model.status.connected;
  function browse(ref: string) {
    setObjectId(ref);
    sessionStorage.setItem(`project-object:${project.id}`, ref);
    const object = objects.find((item) => item.objectRef === ref);
    setPanelTab(
      object?.view.kind === "trace"
        ? "events"
        : object?.view.kind === "diff"
          ? "diff"
          : "document",
    );
  }
  useLayoutEffect(() => {
    const body = columns?.panelRef.current?.querySelector(".right-body");
    if (body) body.scrollTop = 0;
  }, [objectId, panelTab]);
  function followDiscussion(ref: string, title: string, conversation: string) {
    setDiscussion({ ref, title, conversation });
    if (ref) browse(ref);
  }
  const documentContent = (
    <div className="project-runtime-pane project-work-grid">
      {error && (
        <p className="project-error" role="alert">
          {error}
        </p>
      )}
      <section className="project-detail-card" aria-label="项目进度">
        {objects.length > 0 && (
          <>
            {selected &&
              !["trace", "diff", "graph"].includes(
                String(selected.view.kind),
              ) && (
                <div className="project-domain-content">
                  <div className="project-section-heading">
                    <h4>{selected.title}</h4>
                    <span>{selected.stateLabel}</span>
                  </div>
                  <p className="project-source">版本 {selected.revision}</p>
                  {selected.view.kind === "list" ? (
                    <>
                      <div className="project-inline-controls">
                        <input
                          aria-label="搜索列表"
                          placeholder="搜索列表"
                          value={query}
                          onChange={(e) => {
                            setQuery(e.target.value);
                            sessionStorage.setItem(
                              `project-query:${project.id}`,
                              e.target.value,
                            );
                          }}
                        />
                        <select
                          aria-label="列表内容筛选"
                          value={filter}
                          onChange={(e) => {
                            setFilter(e.target.value);
                            sessionStorage.setItem(
                              `project-filter:${project.id}`,
                              e.target.value,
                            );
                          }}
                        >
                          <option value="">全部内容</option>
                          {[...new Set(rows.map((r) => r.detail))].map((d) => (
                            <option key={d}>{d}</option>
                          ))}
                        </select>
                      </div>
                      <label className="project-list-group">
                        分组方式
                        <select
                          aria-label="列表分组方式"
                          value={group}
                          onChange={(e) => {
                            setGroup(e.target.value);
                            sessionStorage.setItem(
                              `project-group:${project.id}`,
                              e.target.value,
                            );
                          }}
                        >
                          <option value="none">不分组</option>
                          <option value="state">按来源状态分组</option>
                        </select>
                      </label>
                      <ul className="project-task-list">
                        {[...shown]
                          .sort((a, b) =>
                            group === "none"
                              ? 0
                              : (
                                  objects.find((o) => o.objectRef === a.id)
                                    ?.stateLabel ?? "未提供状态"
                                ).localeCompare(
                                  objects.find((o) => o.objectRef === b.id)
                                    ?.stateLabel ?? "未提供状态",
                                ),
                          )
                          .map((row, index, all) => (
                            <li key={row.id}>
                              {group !== "none" &&
                                (index === 0 ||
                                  objects.find(
                                    (o) => o.objectRef === all[index - 1].id,
                                  )?.stateLabel !==
                                    objects.find((o) => o.objectRef === row.id)
                                      ?.stateLabel) && (
                                  <h5 className="project-task-group">
                                    {objects.find((o) => o.objectRef === row.id)
                                      ?.stateLabel ?? "未提供状态"}
                                  </h5>
                                )}
                              {objects.some((o) => o.objectRef === row.id) ? (
                                <button
                                  className="project-text-button"
                                  onClick={() => {
                                    browse(row.id);
                                  }}
                                >
                                  {row.title}
                                </button>
                              ) : (
                                <strong>{row.title}</strong>
                              )}
                              <span>{row.detail}</span>
                            </li>
                          ))}
                      </ul>
                      {!shown.length && (
                        <p className="project-empty-small">没有匹配的内容。</p>
                      )}
                    </>
                  ) : null}
                  <ProjectView
                    includeEvidence={false}
                    projectId={project.id}
                    object={selected}
                    cache={evidenceCache.current}
                    unavailable={view!.unavailable}
                  />
                </div>
              )}
          </>
        )}
        {selected &&
          ["graph", "trace", "diff"].includes(String(selected.view.kind)) && (
            <p className="project-empty-small" role="status">
              文档不可用：当前对象没有提供对应投影。
            </p>
          )}
        <div className="project-section-heading">
          <h3>项目进度</h3>
          <button
            className="button"
            disabled={disabled}
            onClick={() => void act({ type: "read", projectId: project.id })}
          >
            重新读取
          </button>
        </div>
        {!view && !error && <p role="status">正在读取项目内容…</p>}
        {view?.unavailable && (
          <p role="status" className="project-runtime-warning">
            {view.unavailable}
          </p>
        )}
        {!project.runtime && view && (
          <>
            <p className="project-form-hint">
              AI-SDLC
              提供项目阶段与任务。完成扩展接入后，可关联同一文件夹的已授权项目内容。
            </p>
            {view?.scopes.length ? (
              <div className="project-inline-controls">
                <select
                  aria-label="关联项目内容"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="">选择已接入的项目内容</option>
                  {view.scopes.map((s) => (
                    <option
                      key={`${s.instanceId}|${s.scopeRef}`}
                      value={`${s.instanceId}|${s.scopeRef}`}
                    >
                      {s.scopeRef} · {s.instanceId}
                    </option>
                  ))}
                </select>
                <button
                  className="button"
                  disabled={disabled || !scope}
                  onClick={() => {
                    const [instanceId, scopeRef] = scope.split("|");
                    void act({
                      type: "bind",
                      projectId: project.id,
                      instanceId,
                      scopeRef,
                      revision: project.revision,
                    });
                  }}
                >
                  关联
                </button>
              </div>
            ) : (
              <p className="project-empty-small">
                尚无可关联的 Runtime 数据。你可以先开始项目对话。
              </p>
            )}
          </>
        )}
        {view?.scope && (
          <p className="project-source">
            来源：
            {snapshot.runtimeInstallations.find(
              (i) => i.installationId === view.scope!.installationId,
            )?.runtimeId ?? view.scope.instanceId}{" "}
            · 更新时间 {new Date(view.scope.updatedAt).toLocaleString("zh-CN")}
          </p>
        )}
        {!layout.full && project.runtime && (
          <ProjectPendingList
            entries={[
              {
                project,
                view,
                unavailable:
                  view?.unavailable ||
                  (!model.status.connected ? "服务未连接。" : ""),
              },
            ]}
            refresh={() => void model.reload()}
          />
        )}
      </section>
      {!layout.full && (
        <ProjectAccessPanel
          project={project}
          revision={snapshot.revision}
          connected={model.status.connected}
          onOpenSettings={onOpenSettings}
        />
      )}
      <section className="project-detail-card" aria-label="执行角色">
        <h3>执行角色</h3>
        <p className="project-form-hint">
          引用全局模型设置。保存选择不会启动执行。
        </p>
        {!view && !error && <p role="status">正在读取角色选择…</p>}
        <div className="project-role-grid">
          {view?.roles.map((entry) => (
            <Role
              key={`${entry.role}:${entry.binding?.updatedAt ?? "new"}`}
              entry={entry}
              snapshot={snapshot}
              project={project}
              act={act}
              busy={disabled || !!view.unavailable}
            />
          ))}
        </div>
      </section>
    </div>
  );
  const absent = (name: string) => (
    <p className="project-empty-small" role="status">
      {name}不可用：当前对象没有提供对应投影。
    </p>
  );
  const source = selected
    ? {
        projectId: project.id,
        object: selected,
        cache: evidenceCache.current,
        unavailable: view?.unavailable ?? "",
      }
    : null;
  const panel = columns ? (
    <RightPanel
      owner={`${project.name} · ${discussion.conversation} · 讨论对象：${discussion.title}`}
      activeTab={panelTab}
      onTab={setPanelTab}
      tabs={[
        {
          id: "files",
          name: "文件",
          icon: "file",
          body:
            source && selected!.evidence.length
              ? selected!.evidence.map((_, index) => (
                  <EvidenceReader
                    key={`${selected!.objectRef}:${index}`}
                    {...source}
                    source={{ kind: "evidence", index }}
                    label={`产物与依据 ${index + 1}`}
                  />
                ))
              : absent("文件"),
        },
        { id: "document", name: "文档", icon: "note", body: documentContent },
        {
          id: "preview",
          name: "预览",
          icon: "grid",
          body: (
            <p className="project-empty-small" role="status">
              原型预览不可用：Runtime 未提供受限预览投影。
            </p>
          ),
        },
        {
          id: "diff",
          name: "修改对比",
          icon: "diff",
          body:
            source && selected!.view.kind === "diff" ? (
              <ProjectView {...source} includeEvidence={false} />
            ) : (
              absent("修改对比")
            ),
        },
        {
          id: "events",
          name: "事件",
          icon: "activity",
          body:
            source && selected!.view.kind === "trace" ? (
              <ProjectView {...source} includeEvidence={false} />
            ) : (
              absent("事件")
            ),
        },
      ]}
      layout={columns.layout}
      width={columns.layout.right}
      panelRef={columns.panelRef}
      takeoverButton={columns.takeoverRef}
      onWidth={columns.width}
      onPreview={columns.preview}
      onTakeover={() => columns.setTakeover(!columns.layout.takeover)}
      onClose={columns.close}
      browser={
        <div className="project-object-browser" hidden={layout.full}>
          <nav className="project-object-tabs" aria-label="Runtime 内容">
            {objects.map((object) => (
              <button
                className="button"
                key={object.objectRef}
                aria-pressed={selected?.objectRef === object.objectRef}
                onClick={() => browse(object.objectRef)}
              >
                {object.title}
              </button>
            ))}
            {!objects.length && <span>没有可用投影</span>}
          </nav>
          {selected && (
            <p className="project-source">
              正在浏览：{selected.title} · {selected.revision}
            </p>
          )}
        </div>
      }
      enlarged={layout.full}
      extra={
        layout.full ? (
          <button
            className="button project-restore"
            aria-label="还原内容区"
            onClick={layout.restore}
          >
            还原 <kbd>Esc</kbd>
          </button>
        ) : (
          <button
            className="icon-button project-enlarge"
            aria-label="放大内容区"
            title="放大内容区"
            onClick={layout.enlarge}
          >
            ⤢
          </button>
        )
      }
    />
  ) : (
    documentContent
  );
  return (
    <div
      ref={layout.ref}
      className="project-work-grid project-columns-content"
      data-full={layout.full}
      data-chat={layout.mode}
    >
      <div className="project-overview" hidden={layout.full}>
        <span>
          {view?.unavailable ||
            (project.runtime
              ? "项目内容来自 Runtime"
              : "尚无可关联的 Runtime 数据。你可以先开始项目对话。")}
        </span>
        {columns && (
          <button
            className="button"
            onClick={() => {
              columns.setOpen(true);
              setPanelTab("document");
            }}
          >
            在右栏查看
          </button>
        )}
      </div>
      <ProjectChatLayout layout={layout}>
        <ProjectChat
          project={project}
          model={model}
          view={view}
          compact={layout.full}
          onDiscussion={followDiscussion}
        />
      </ProjectChatLayout>
      {selected?.view.kind === "graph" && !layout.full && (
        <div className="project-center-content project-domain-content">
          <div className="project-section-heading">
            <h4>{selected.title}</h4>
            <span>{selected.stateLabel}</span>
          </div>
          <p className="project-source">版本 {selected.revision}</p>
          <ProjectView
            projectId={project.id}
            object={selected}
            cache={evidenceCache.current}
            unavailable={view?.unavailable ?? ""}
            includeEvidence={false}
          />
        </div>
      )}
      {selected && view?.projection && !layout.full && (
        <div className="project-center-actions">
          <ProjectActionPanel
            project={project}
            object={selected}
            actions={view!.projection!.actions}
            snapshot={snapshot}
            unavailable={
              view!.unavailable ||
              (!model.status.connected ? "业务服务未连接。" : "")
            }
            awaiting={view!.awaiting.find(
              (a) => a.objectRef === selected.objectRef,
            )}
          />
        </div>
      )}
      {columns?.host
        ? createPortal(<>{panel}</>, columns.host)
        : !columns && panel}
    </div>
  );
}
