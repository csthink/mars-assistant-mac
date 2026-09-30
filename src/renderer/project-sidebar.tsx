import { useEffect, useRef, useState } from "react";
import type { Project, ProjectUndo } from "../shared/projects";
import type {
  PinnedRef,
  PinnedSort,
  ProjectSort,
  Snapshot,
} from "../shared/protocol";
import { refocus } from "./modal-focus";
import { Icon } from "./icons";
import { ProjectForm, ProjectMenu } from "./projects";
import { orderedSidebarProjects, pinnedObjects } from "./project-lists";
import type { PinnedProjectDrag } from "./organization";

const short = (id: string) => id.slice(0, 8);
const asRef = (row: {
  kind: PinnedRef["kind"];
  value: { id: string };
}): PinnedRef => ({ kind: row.kind, id: row.value.id });

/** Project actions shared by the sidebar's project and mixed pinned rows. */
export function useProjectSidebar({
  snapshot,
  connected,
  sort,
  pinnedSort,
  open,
  newChat,
  notify,
}: {
  snapshot: Snapshot | undefined;
  connected: boolean;
  sort: ProjectSort;
  pinnedSort: PinnedSort;
  open: (id: string) => void;
  newChat: (id: string) => Promise<void>;
  notify: (message: string) => void;
}) {
  const projects = snapshot?.projects ?? [];
  const fullOrder = orderedSidebarProjects(projects, sort);
  const visible = fullOrder.slice(0, 5);
  const pins = pinnedObjects(
    snapshot?.conversations ?? [],
    projects,
    pinnedSort,
    snapshot?.pinnedOrder ?? [],
  );
  const [menu, setMenu] = useState<{
    id: string;
    anchor: HTMLElement;
    keyboard: boolean;
  }>();
  const [form, setForm] = useState<Project | null>();
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<ProjectUndo>();
  const [drag, setDrag] = useState<{
    id: string;
    over?: string;
    after?: boolean;
  }>();
  const lastTrigger = useRef<{ id: string; keyboard: boolean } | undefined>(
    undefined,
  );
  const target = projects.find((project) => project.id === menu?.id);
  useEffect(() => {
    if (menu && !target) setMenu(undefined);
  }, [menu, target]);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(
      () => setUndo(undefined),
      Math.max(0, Date.parse(undo.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [undo]);
  function follow(id: string, keyboard: boolean) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        refocus(
          document.querySelector<HTMLElement>(
            `#main-sidebar [data-project-menu="${id}"]`,
          ),
          keyboard,
        ),
      ),
    );
  }
  function closeMenu(restore = true) {
    const current = menu;
    setMenu(undefined);
    if (restore && current?.anchor.isConnected)
      requestAnimationFrame(() => refocus(current.anchor, current.keyboard));
  }
  function openMenu(id: string, anchor: HTMLElement, keyboard: boolean) {
    if (!connected || busy) return;
    if (menu?.id === id && menu.anchor === anchor) return closeMenu();
    setMenu({ id, anchor, keyboard });
  }
  async function command(project: Project, action: "pin" | "archive") {
    const keyboard = menu?.keyboard ?? false;
    closeMenu(false);
    setBusy(true);
    try {
      const reply = await window.desktop.command(
        action === "pin"
          ? {
              type: "projectPin",
              id: project.id,
              pinned: !project.pinnedAt,
              revision: project.revision,
            }
          : {
              type: "projectArchive",
              id: project.id,
              archived: !project.archivedAt,
              revision: project.revision,
            },
      );
      if (!reply.ok) {
        notify(reply.message);
        return;
      }
      if (reply.projectUndo) setUndo(reply.projectUndo);
      if (action === "pin") follow(project.id, keyboard);
    } catch {
      notify("项目操作结果未确认，请重新读取后重试。");
    } finally {
      setBusy(false);
    }
  }
  async function move(project: Project, before: PinnedRef | string | null) {
    const keyboard = menu?.keyboard ?? false;
    closeMenu(false);
    setBusy(true);
    try {
      const reply = project.pinnedAt
        ? await window.desktop.command({
            type: "movePinned",
            kind: "project",
            id: project.id,
            before: before as PinnedRef | null,
            revision: project.revision,
          })
        : await window.desktop.command({
            type: "moveProject",
            id: project.id,
            before: before as string | null,
            revision: project.revision,
          });
      if (!reply.ok) notify(`顺序未改变：${reply.message}`);
      else follow(project.id, keyboard);
    } catch {
      notify("顺序未改变，请核对连接后重试。");
    } finally {
      setBusy(false);
    }
  }
  function create() {
    if (!connected || busy) return;
    lastTrigger.current = undefined;
    setForm(null);
  }
  function row(
    project: Project,
    section: "pinned" | "projects",
    mixedDrag?: PinnedProjectDrag,
  ) {
    const manual =
      section === "pinned" ? pinnedSort === "manual" : sort === "manual";
    const draggable = manual && connected && !busy;
    const over =
      section === "pinned"
        ? mixedDrag?.over
        : drag?.over === project.id
          ? drag.after
            ? "after"
            : "before"
          : undefined;
    const dragging =
      section === "pinned" ? mixedDrag?.dragging : drag?.id === project.id;
    const counts = projects.filter(
      (item) => !item.archivedAt && item.name === project.name,
    ).length;
    return (
      <div
        key={`project:${project.id}`}
        className={`session-line project-side-line ${over ? `drop-${over}` : ""} ${dragging ? "dragging" : ""}`}
        data-project={project.id}
        draggable={draggable || undefined}
        onDragStart={
          draggable
            ? section === "pinned"
              ? mixedDrag?.onDragStart
              : (event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", project.id);
                  setDrag({ id: project.id });
                }
            : undefined
        }
        onDragOver={
          draggable
            ? section === "pinned"
              ? mixedDrag?.onDragOver
              : (event) => {
                  if (!drag || drag.id === project.id) return;
                  event.preventDefault();
                  const box = event.currentTarget.getBoundingClientRect();
                  setDrag({
                    ...drag,
                    over: project.id,
                    after: event.clientY > box.top + box.height / 2,
                  });
                }
            : undefined
        }
        onDrop={
          draggable
            ? section === "pinned"
              ? mixedDrag?.onDrop
              : (event) => {
                  event.preventDefault();
                  if (!drag?.over) return setDrag(undefined);
                  const ids = visible
                    .map((item) => item.id)
                    .filter((id) => id !== drag.id);
                  const index = ids.indexOf(drag.over) + (drag.after ? 1 : 0);
                  const moving = projects.find((item) => item.id === drag.id);
                  setDrag(undefined);
                  if (moving)
                    void move(moving, ids[index] ?? fullOrder[5]?.id ?? null);
                }
            : undefined
        }
        onDragEnd={
          draggable
            ? section === "pinned"
              ? mixedDrag?.onDragEnd
              : () => setDrag(undefined)
            : undefined
        }
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(
            project.id,
            event.currentTarget.querySelector<HTMLElement>(".session-more")!,
            false,
          );
        }}
      >
        {manual && (
          <span className="drag-grip" aria-hidden="true" title="拖动调整顺序">
            <Icon name="grip" />
          </span>
        )}
        <button
          className="session project-side-open"
          aria-label={`项目 ${project.name} ${short(project.id)}`}
          onClick={() => open(project.id)}
        >
          <Icon name="folder" />
          <span className="session-name">{project.name}</span>
          {counts > 1 && <small className="same-name">同名 {counts}</small>}
        </button>
        <button
          className="session-more project-side-more"
          data-project-menu={project.id}
          aria-label={`项目菜单 ${project.name} ${short(project.id)}`}
          aria-haspopup="menu"
          aria-expanded={menu?.id === project.id && menu.anchor.isConnected}
          disabled={!connected || busy}
          onClick={(event) => {
            event.stopPropagation();
            openMenu(project.id, event.currentTarget, event.detail === 0);
          }}
        >
          ⋯
        </button>
        <button
          className="session-more project-new-chat"
          aria-label={`新建项目对话 ${project.name} ${short(project.id)}`}
          disabled={!connected || busy}
          onClick={(event) => {
            event.stopPropagation();
            void newChat(project.id);
          }}
        >
          <Icon name="edit" />
        </button>
      </div>
    );
  }
  const ordered = sort === "manual" ? visible : [];
  const pinnedIndex =
    target?.pinnedAt && pinnedSort === "manual"
      ? pins.findIndex(
          (row) => row.kind === "project" && row.value.id === target.id,
        )
      : -1;
  const projectIndex =
    target && sort === "manual" && !target.pinnedAt
      ? ordered.findIndex((row) => row.id === target.id)
      : -1;
  const moveOptions =
    pinnedIndex >= 0
      ? {
          first: pinnedIndex === 0,
          last: pinnedIndex === pins.length - 1,
          up: () => void move(target!, asRef(pins[pinnedIndex - 1])),
          down: () =>
            void move(
              target!,
              pins[pinnedIndex + 2] ? asRef(pins[pinnedIndex + 2]) : null,
            ),
        }
      : projectIndex >= 0
        ? {
            first: projectIndex === 0,
            last: projectIndex === ordered.length - 1,
            up: () => void move(target!, ordered[projectIndex - 1].id),
            down: () =>
              void move(
                target!,
                ordered[projectIndex + 2]?.id ?? fullOrder[5]?.id ?? null,
              ),
          }
        : undefined;
  const overlays = (
    <>
      {menu && target && (
        <ProjectMenu
          project={target}
          anchor={menu.anchor}
          close={closeMenu}
          edit={() => {
            lastTrigger.current = { id: target.id, keyboard: menu.keyboard };
            closeMenu(false);
            setForm(target);
          }}
          pin={() => void command(target, "pin")}
          archive={() => void command(target, "archive")}
          move={moveOptions}
        />
      )}
      {form !== undefined && (
        <ProjectForm
          project={form}
          close={() => {
            setForm(undefined);
            if (lastTrigger.current)
              follow(lastTrigger.current.id, lastTrigger.current.keyboard);
          }}
          created={open}
        />
      )}
      {undo && (
        <div className="project-sidebar-notice" role="status">
          项目归档状态已更新。
          <button
            onClick={async () => {
              const current = undo;
              setUndo(undefined);
              const reply = await window.desktop.command({
                type: "projectUndo",
                id: current.id,
                token: current.token,
              });
              if (!reply.ok) notify(reply.message);
            }}
          >
            撤销
          </button>
        </div>
      )}
    </>
  );
  return {
    create,
    rows: (
      <div className="sessions" aria-label="侧栏项目">
        {visible.map((project) => row(project, "projects"))}
      </div>
    ),
    renderPinnedProject: (project: Project, dragProps: PinnedProjectDrag) =>
      row(project, "pinned", dragProps),
    overlays,
  };
}
