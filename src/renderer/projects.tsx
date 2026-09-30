import { useProjectColumns } from "./project-columns";
import { ProjectDetail, type Business } from "./project-detail";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Project, ProjectFolder, ProjectUndo } from "../shared/projects";
import { validProjectName } from "../shared/projects";
import type { Snapshot } from "../shared/protocol";
import { Icon } from "./icons";
import { openModal } from "./modal-focus";
import "./projects.css";

function source(folder: ProjectFolder) {
  return !folder.git
    ? "普通文件夹"
    : folder.git.remotes.length
      ? `${folder.git.remotes.length} 个远程仓库`
      : "Git · 无远程";
}
function Folder({ folder }: { folder: ProjectFolder }) {
  return (
    <div className="project-folder-details">
      <p className="project-folder-path">{folder.path}</p>
      <span>{source(folder)}</span>
      {folder.git?.remotes.map((r, i) => (
        <div className="project-remote" key={`${r.name}-${i}`}>
          <b>{r.name}</b>
          <code>{r.url}</code>
        </div>
      ))}
    </div>
  );
}
export function ProjectForm({
  project,
  close,
  created,
}: {
  project: Project | null;
  close: () => void;
  created: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(project?.name ?? "");
  const [goal, setGoal] = useState(project?.goal ?? "");
  const [selection, setSelection] = useState<{
    token: string;
    folder: ProjectFolder;
  } | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const request = useRef(0);
  useEffect(() => openModal(dialog.current!), []);
  useEffect(() => {
    if (error && !project) {
      const form = dialog.current?.querySelector("form");
      form?.scrollTo({ top: form.scrollHeight });
    }
  }, [error, project]);
  function cancel() {
    request.current++;
    void window.desktop.cancelProjectFolder();
    close();
  }
  function acceptFolderReply(
    r: Awaited<ReturnType<typeof window.desktop.pickProjectFolder>>,
  ) {
    if (r.ok) {
      setSelection(r);
      setSelectedPath(r.folder.path);
      setError("");
    } else if (!r.cancelled) {
      setSelection(null);
      setSelectedPath(r.selectedPath ?? null);
      setError(r.message);
    }
  }
  async function pick() {
    const current = ++request.current;
    setChecking(true);
    setError("");
    setSelection(null);
    setSelectedPath(null);
    try {
      await window.desktop.cancelProjectFolder();
      const r = await window.desktop.pickProjectFolder();
      if (current === request.current) acceptFolderReply(r);
    } catch {
      if (current === request.current)
        setError("文件夹选择未完成，请重新选择。");
    } finally {
      if (current === request.current) setChecking(false);
    }
  }
  async function retry() {
    const current = ++request.current;
    setChecking(true);
    setError("");
    try {
      const r = await window.desktop.retryProjectFolder();
      if (current === request.current) acceptFolderReply(r);
    } catch {
      if (current === request.current)
        setError("文件夹检查未完成，请重试检查或重新选择。");
    } finally {
      if (current === request.current) setChecking(false);
    }
  }
  async function save() {
    if (
      checking ||
      saving ||
      !validProjectName(name) ||
      (!project && !selection)
    )
      return;
    setSaving(true);
    setError("");
    try {
      const reply = project
        ? await window.desktop.command({
            type: "projectEdit",
            id: project.id,
            name,
            goal,
            revision: project.revision,
          })
        : await window.desktop.createProject({
            token: selection!.token,
            name,
            goal,
          });
      if (!reply.ok) {
        setError(reply.message);
        return;
      }
      request.current++;
      close();
      if (!project && reply.projectId) created(reply.projectId);
    } catch {
      setError("项目未保存，请保留输入后重试。");
    } finally {
      setSaving(false);
    }
  }
  const folder = project?.folder ?? selection?.folder;
  return (
    <dialog
      ref={dialog}
      className="project-form-dialog"
      aria-labelledby="project-form-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!saving) cancel();
      }}
    >
      <div className="project-form-head">
        <h2 id="project-form-title">{project ? "编辑项目" : "新建项目"}</h2>
        <button
          type="button"
          aria-label="关闭"
          className="icon-button"
          disabled={saving}
          onClick={cancel}
        >
          <Icon name="close" />
        </button>
      </div>
      <p className="project-form-subtitle">
        {project ? "更新项目名称和目标。" : "为持续推进的工作建立一个空间。"}
      </p>
      <form
        id="project-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          项目名称 <span>必填</span>
          <input
            autoFocus
            name="name"
            maxLength={60}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：个人作品集"
            disabled={checking || saving}
          />
        </label>
        <label>
          项目目标 <span>可选</span>
          <textarea
            name="goal"
            rows={3}
            maxLength={4000}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="希望在这个项目中持续推进什么？"
            disabled={checking || saving}
          />
        </label>
        <section aria-label="本地文件夹">
          <div className="project-field-title">
            <b>本地文件夹</b>
            <span>{project ? "不可更改" : "必填"}</span>
          </div>
          <div className="project-folder-choice">
            <span className="project-folder-symbol">
              <Icon name="folder" />
            </span>
            <div>
              {folder ? (
                <Folder folder={folder} />
              ) : selectedPath ? (
                <>
                  <b>
                    {checking ? "正在检查文件夹" : "已选择文件夹，等待重试检查"}
                  </b>
                  <p className="project-folder-path">{selectedPath}</p>
                </>
              ) : (
                <>
                  <b>选择一个本地文件夹</b>
                  <p>用于保存与组织项目内容</p>
                </>
              )}
            </div>
            {!project && (
              <button
                type="button"
                className="button"
                disabled={saving}
                onClick={() => void pick()}
              >
                {checking || selection || selectedPath
                  ? "重新选择"
                  : "选择文件夹"}
              </button>
            )}
          </div>
        </section>
      </form>
      {(error || (!project && selectedPath && !selection && !checking)) && (
        <div className="project-form-status">
          {error && (
            <p role="alert" className="project-error">
              {error}
            </p>
          )}
          {!project && selectedPath && !selection && !checking && (
            <button
              type="button"
              className="button project-folder-retry"
              onClick={() => void retry()}
            >
              重试检查
            </button>
          )}
        </div>
      )}
      {!project && (
        <p className="project-form-hint project-form-footer-hint">
          选择文件夹后读取 Git 信息。创建项目不会修改文件夹或开始执行。
        </p>
      )}
      <div className="project-form-actions">
        <button
          className="button"
          type="button"
          disabled={saving}
          onClick={cancel}
        >
          取消
        </button>
        <button
          form="project-form"
          className="button project-primary"
          type="submit"
          disabled={
            checking ||
            saving ||
            !validProjectName(name) ||
            (!project && !selection)
          }
        >
          {saving
            ? "正在保存…"
            : checking
              ? "正在检查…"
              : project
                ? "保存修改"
                : "创建项目"}
        </button>
      </div>
    </dialog>
  );
}
export function ProjectMenu({
  project,
  anchor,
  close,
  edit,
  pin,
  archive,
  move,
}: {
  project: Project;
  anchor: HTMLElement;
  close: (restore?: boolean) => void;
  edit: () => void;
  pin: () => void;
  archive: () => void;
  move?: { up: () => void; down: () => void; first: boolean; last: boolean };
}) {
  const ref = useRef<HTMLDivElement>(null),
    rect = anchor.getBoundingClientRect();
  const left = Math.max(
    12,
    Math.min(rect.right - 190, window.innerWidth - 202),
  );
  const top = Math.max(
    12,
    Math.min(rect.bottom + 6, window.innerHeight - (move ? 260 : 170)),
  );
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const pointer = (event: PointerEvent) => {
      if (
        !ref.current?.contains(event.target as Node) &&
        !anchor.contains(event.target as Node)
      )
        close(false);
    };
    const scroll = () => close(false);
    window.addEventListener("pointerdown", pointer);
    window.addEventListener("resize", scroll);
    document.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("pointerdown", pointer);
      window.removeEventListener("resize", scroll);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [anchor, close]);
  return createPortal(
    <div
      ref={ref}
      className="project-menu"
      role="menu"
      aria-label={`${project.name} 项目操作`}
      style={{ left, top }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) close(false);
      }}
      onKeyDown={(e) => {
        const buttons = Array.from(
          ref.current!.querySelectorAll<HTMLButtonElement>("button"),
        );
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        if (e.key === "Escape") {
          e.preventDefault();
          close(true);
        } else if (e.key === "Tab") {
          close(false);
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          buttons[
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                  buttons.length
          ].focus();
        }
      }}
    >
      {!project.archivedAt && (
        <button role="menuitem" onClick={pin}>
          <Icon name="pin" />
          {project.pinnedAt ? "取消置顶" : "置顶"}
        </button>
      )}
      <button role="menuitem" onClick={edit}>
        <Icon name="edit" />
        编辑项目
      </button>
      <hr />
      <button role="menuitem" onClick={archive}>
        <Icon name="archive" />
        {project.archivedAt ? "取消归档项目" : "归档项目"}
      </button>
      {move && (
        <>
          <hr />
          <button role="menuitem" disabled={move.first} onClick={move.up}>
            上移
          </button>
          <button role="menuitem" disabled={move.last} onClick={move.down}>
            下移
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
export function Projects({
  snapshot,
  connected,
  model,
  onOpenSettings,
}: {
  snapshot: Snapshot | undefined;
  connected: boolean;
  model: Business;
  onOpenSettings?: (tab: "扩展管理" | "访问权限") => void;
}) {
  const columns = useProjectColumns();
  const projects = snapshot?.projects ?? [];
  const [selected, setSelected] = useState<string | null>(() =>
    sessionStorage.getItem("project-selected"),
  );
  useEffect(() => {
    if (selected) sessionStorage.setItem("project-selected", selected);
    else sessionStorage.removeItem("project-selected");
  }, [selected]);
  const [form, setForm] = useState<{ project: Project | null } | null>(null);
  const [menu, setMenu] = useState<{
    project: Project;
    anchor: HTMLElement;
  } | null>(null);
  const [archived, setArchived] = useState(false),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(false);
  const [sort, setSort] = useState("updated"),
    [page, setPage] = useState(0),
    [filter, setFilter] = useState("all");
  const [notice, setNotice] = useState<{
      text: string;
      undo: ProjectUndo;
    } | null>(null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const composing = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const project = projects.find((p) => p.id === selected);
  const setAvailable = columns?.setAvailable;
  useEffect(() => {
    setAvailable?.(!!project);
    return () => setAvailable?.(false);
  }, [!!project, setAvailable]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(
      () => setNotice(null),
      Math.max(0, Date.parse(notice.undo.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [notice]);
  const closeMenu = useCallback(
    (restore = true) => {
      if (restore && menu?.anchor.isConnected) menu.anchor.focus();
      setMenu(null);
    },
    [menu],
  );
  async function archive(p: Project) {
    closeMenu();
    setBusy(true);
    setError("");
    try {
      const r = await window.desktop.command({
        type: "projectArchive",
        id: p.id,
        archived: !p.archivedAt,
        revision: p.revision,
      });
      if (!r.ok) setError(r.message);
      else if (r.projectUndo)
        setNotice({
          text: p.archivedAt ? "项目已取消归档" : "项目已归档",
          undo: r.projectUndo,
        });
    } catch {
      setError("归档状态未确认，请重新读取项目后再操作。");
    } finally {
      setBusy(false);
    }
  }
  async function pin(p: Project) {
    closeMenu();
    setBusy(true);
    setError("");
    try {
      const r = await window.desktop.command({
        type: "projectPin",
        id: p.id,
        pinned: !p.pinnedAt,
        revision: p.revision,
      });
      if (!r.ok) setError(r.message);
    } catch {
      setError("置顶状态未确认，请重新读取项目后再操作。");
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    if (!notice || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await window.desktop.command({
        type: "projectUndo",
        id: notice.undo.id,
        token: notice.undo.token,
      });
      if (!r.ok) setError(r.message);
      setNotice(null);
    } catch {
      setError("撤销结果未确认，请重新读取项目。");
    } finally {
      setBusy(false);
    }
  }
  const filtered = projects
    .filter(
      (p) =>
        !!p.archivedAt === archived &&
        `${p.name}\n${p.goal}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()) &&
        (filter === "all" ||
          (filter === "git" ? !!p.folder.git : !p.folder.git)),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "zh")
        : b.updatedAt.localeCompare(a.updatedAt),
    );
  const pages = Math.max(1, Math.ceil(filtered.length / 10)),
    currentPage = Math.min(page, pages - 1);
  const openMenu = (p: Project, anchor: HTMLElement) => {
    if (menu?.project.id === p.id) {
      closeMenu();
      return;
    }
    setMenu({ project: p, anchor });
  };
  const ops = (p: Project) => (
    <button
      className="project-more"
      title="项目操作"
      aria-label={`${p.name} 项目操作`}
      aria-haspopup="menu"
      aria-expanded={menu?.project.id === p.id}
      disabled={!connected || busy}
      onClick={(e) => {
        e.stopPropagation();
        openMenu(p, e.currentTarget);
      }}
    >
      ⋯
    </button>
  );
  return (
    <section className="projects-workspace" aria-label="项目">
      {error && (
        <div className="project-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="project-notice" role="status">
          {notice.text}
          <button disabled={!connected || busy} onClick={() => void undo()}>
            撤销
          </button>
        </div>
      )}
      {project ? (
        <>
          <div className="project-detail-heading">
            <button className="button" onClick={() => setSelected(null)}>
              返回项目列表
            </button>
            <div>
              <h2>{project.name}</h2>
              {project.archivedAt && (
                <span className="project-tag">已归档</span>
              )}
            </div>
            {ops(project)}
            {columns && (
              <button
                ref={columns.toggleRef}
                className="icon-button panel-toggle"
                aria-label={columns.open ? "收起右栏" : "打开右栏"}
                aria-expanded={columns.open}
                aria-controls="right-panel"
                onClick={columns.toggle}
              >
                <Icon name="panelRight" />
              </button>
            )}
          </div>
          <p className="project-goal-full">
            {project.goal || "尚未填写项目目标"}
          </p>
          {snapshot && (
            <ProjectDetail
              key={project.id}
              project={project}
              model={model}
              onOpenSettings={onOpenSettings}
            />
          )}
          <details className="project-detail-card project-folder-details">
            <summary>本地文件夹</summary>
            <Folder folder={project.folder} />
          </details>
        </>
      ) : (
        <>
          <div className="project-toolbar">
            <span className="project-total">{filtered.length} 个项目</span>
            <div className="project-search-anchor">
              <button
                className="icon-button"
                aria-label="搜索项目"
                aria-expanded={search}
                onClick={() => {
                  setSearch(!search);
                  if (!search)
                    requestAnimationFrame(() => searchInput.current?.focus());
                }}
              >
                <Icon name="search" />
              </button>
              {search && (
                <div className="project-search-popover">
                  <input
                    ref={searchInput}
                    aria-label="搜索项目名称或目标"
                    placeholder="搜索名称或目标"
                    defaultValue={query}
                    onCompositionStart={() => {
                      composing.current = true;
                    }}
                    onCompositionEnd={(e) => {
                      composing.current = false;
                      setQuery(e.currentTarget.value);
                      setPage(0);
                    }}
                    onChange={(e) => {
                      if (!composing.current) {
                        setQuery(e.target.value);
                        setPage(0);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape" && !e.nativeEvent.isComposing) {
                        setSearch(false);
                        e.currentTarget
                          .closest(".project-search-anchor")
                          ?.querySelector<HTMLButtonElement>("button")
                          ?.focus();
                      }
                    }}
                  />
                </div>
              )}
            </div>
            <div className="project-controls">
              <select
                aria-label="项目来源筛选"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPage(0);
                }}
              >
                <option value="all">全部来源</option>
                <option value="git">Git 仓库</option>
                <option value="folder">普通文件夹</option>
              </select>
              <select
                aria-label="项目排序"
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value);
                  setPage(0);
                }}
              >
                <option value="updated">最近更新</option>
                <option value="name">按名称</option>
              </select>
              <button
                className="button"
                aria-pressed={archived}
                onClick={() => {
                  setArchived(!archived);
                  setPage(0);
                }}
              >
                {archived ? "返回未归档" : "已归档"}
              </button>
              <button
                className="button project-primary"
                disabled={!connected}
                onClick={() => setForm({ project: null })}
              >
                <Icon name="plus" />
                新建项目
              </button>
            </div>
          </div>
          {archived && (
            <p className="project-form-hint">
              归档项目保留全部内容，可随时取消归档。
            </p>
          )}
          {filtered.length ? (
            <div className="project-table-wrap">
              <table className="project-table">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>来源</th>
                    <th>更新时间</th>
                    <th>
                      <span className="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered
                    .slice(currentPage * 10, currentPage * 10 + 10)
                    .map((p) => (
                      <tr key={p.id} onClick={() => setSelected(p.id)}>
                        <td>
                          <button
                            className="project-open"
                            onClick={() => setSelected(p.id)}
                          >
                            <span className="project-symbol">
                              <Icon name="folder" />
                            </span>
                            <span>
                              <strong>{p.name}</strong>
                              <small>{p.goal || p.folder.path}</small>
                              {projects.filter((x) => x.name === p.name)
                                .length > 1 && (
                                <span className="project-same-name">
                                  同名 · {p.folder.path}
                                </span>
                              )}
                            </span>
                          </button>
                        </td>
                        <td>{source(p.folder)}</td>
                        <td>
                          <time dateTime={p.updatedAt}>
                            {new Date(p.updatedAt).toLocaleDateString("zh-CN", {
                              month: "short",
                              day: "numeric",
                            })}
                          </time>
                        </td>
                        <td>{ops(p)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="project-empty">
              <span className="project-empty-icon">
                <Icon name={query ? "search" : "folder"} />
              </span>
              <h2>
                {query
                  ? "没有匹配的项目"
                  : archived
                    ? "没有已归档项目"
                    : "从一个项目开始"}
              </h2>
              <p>
                {query
                  ? "试试其他名称或目标关键词。"
                  : archived
                    ? "归档后的项目会显示在这里。"
                    : "把目标、对话和工作成果组织在一起。"}
              </p>
              {!query && !archived && (
                <button
                  className="button project-primary"
                  disabled={!connected}
                  onClick={() => setForm({ project: null })}
                >
                  新建项目
                </button>
              )}
            </div>
          )}
          {pages > 1 && (
            <nav className="project-pagination" aria-label="项目分页">
              <button
                className="button"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                上一页
              </button>
              <span>
                {currentPage + 1} / {pages}
              </span>
              <button
                className="button"
                disabled={currentPage + 1 >= pages}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </button>
            </nav>
          )}
        </>
      )}
      {menu && (
        <ProjectMenu
          {...menu}
          close={closeMenu}
          edit={() => {
            menu.anchor.focus();
            setForm({ project: menu.project });
            setMenu(null);
          }}
          pin={() => void pin(menu.project)}
          archive={() => void archive(menu.project)}
        />
      )}
      {form && (
        <ProjectForm
          {...form}
          close={() => setForm(null)}
          created={setSelected}
        />
      )}
    </section>
  );
}
