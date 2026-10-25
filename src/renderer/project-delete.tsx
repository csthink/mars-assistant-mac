import { useEffect, useState } from "react";
import type { Snapshot } from "../shared/protocol";
import type { Project } from "../shared/projects";
import {
  Callout,
  DeletionDialog,
  ImpactList,
  deletionNoticeMs,
  projectDeletionImpact,
  projectDeletionNotice,
} from "./deletion-dialogs";

/**
 * Deleting a project from any of its three menus (project list, project detail, sidebar): a separate
 * confirmation with what the deletion touches, then a notice (PROJECT-03, D-03). Only the organization record
 * goes to recently deleted; conversations, tasks, pending items, records and the folder stay.
 */
export function useProjectDeletion({
  snapshot,
  connected,
  onDeleted,
  openRecentlyDeleted,
  openRecords,
  noticeClass = "project-notice",
}: {
  /** The notice's look where the owner shows it (the project page or the sidebar). */
  noticeClass?: string;
  snapshot: Snapshot | undefined;
  connected: boolean;
  /** After the deletion committed: the owner leaves a detail page and places focus. */
  onDeleted?: (projectId: string) => void;
  openRecentlyDeleted?: () => void;
  /** Opens the project's records, where work with an unknown result is checked. */
  openRecords?: (projectId: string) => void;
}) {
  const [target, setTarget] = useState<{
    project: Project;
    back: () => HTMLElement | null | undefined;
  }>();
  const [notice, setNotice] = useState<{
    id: string;
    name: string;
    error?: string;
  }>();
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(undefined), deletionNoticeMs);
    return () => clearTimeout(timer);
  }, [notice]);
  async function undo() {
    if (!notice) return;
    const entry = snapshot?.recentlyDeleted?.projects.find(
      (p) => p.id === notice.id,
    );
    if (!entry) return setNotice(undefined);
    try {
      const reply = await window.desktop.command({
        type: "restoreDeleted",
        kind: "project",
        id: notice.id,
        revision: entry.revision,
      });
      if (!reply.ok) setNotice({ ...notice, error: reply.message });
      else setNotice(undefined);
    } catch {
      setNotice({
        ...notice,
        error: "撤销结果未确认，请在设置「最近删除」中核对。",
      });
    }
  }
  const dialog =
    target && snapshot ? (
      <ProjectDeletion
        snapshot={snapshot}
        project={target.project}
        connected={connected}
        back={target.back}
        close={() => setTarget(undefined)}
        openRecords={
          openRecords
            ? () => {
                setTarget(undefined);
                openRecords(target.project.id);
              }
            : undefined
        }
        deleted={() => {
          const { project } = target;
          setTarget(undefined);
          setNotice({ id: project.id, name: project.name });
          onDeleted?.(project.id);
        }}
      />
    ) : null;
  const noticeView = notice ? (
    <div className={`${noticeClass} project-deletion-notice`} role="status">
      <span>
        {notice.error ?? `已将「${notice.name}」移入最近删除，至少保留 30 天。`}
      </span>
      {!notice.error && projectDeletionNotice.includes("undo") && (
        <button disabled={!connected} onClick={() => void undo()}>
          撤销
        </button>
      )}
      {projectDeletionNotice.includes("open") && openRecentlyDeleted && (
        <button
          onClick={() => {
            setNotice(undefined);
            openRecentlyDeleted();
          }}
        >
          打开最近删除
        </button>
      )}
      <button aria-label="关闭删除提示" onClick={() => setNotice(undefined)}>
        ×
      </button>
    </div>
  ) : null;
  return {
    start: (project: Project, back: () => HTMLElement | null | undefined) =>
      setTarget({ project, back }),
    dialog,
    notice: noticeView,
  };
}

function ProjectDeletion({
  snapshot,
  project,
  connected,
  back,
  close,
  deleted,
  openRecords,
}: {
  snapshot: Snapshot;
  project: Project;
  connected: boolean;
  back: () => HTMLElement | null | undefined;
  close: () => void;
  deleted: () => void;
  openRecords?: () => void;
}) {
  const impact = projectDeletionImpact(snapshot, project);
  const [pending, setPending] = useState<number | null | undefined>(
    project.runtime ? undefined : 0,
  );
  useEffect(() => {
    if (!project.runtime) return;
    let active = true;
    void window.desktop
      .projectWork({ type: "read", projectId: project.id })
      .then((r) => {
        if (active)
          setPending(
            r.ok ? (r.view?.projection?.pendingItems.length ?? 0) : null,
          );
      })
      .catch(() => active && setPending(null));
    return () => {
      active = false;
    };
  }, [project.id, project.runtime]);
  const blocked = impact.unknown > 0;
  return (
    <DeletionDialog
      title={`删除项目「${project.name}」`}
      confirmLabel="移入最近删除"
      back={back}
      close={close}
      disabled={blocked || !connected}
      confirm={async () => {
        const reply = await window.desktop.command({
          type: "deleteProject",
          id: project.id,
          revision: project.revision,
          confirmed: true,
        });
        if (!reply.ok) return reply.message;
        deleted();
        return "";
      }}
    >
      {blocked ? (
        <Callout tone="amber" icon="alert" title="暂时不能删除">
          <p>
            项目有 {impact.unknown}{" "}
            项工作结果未知。请先查询原请求并核实结果，再删除；删除不能成为隐藏未决事项的方式。
          </p>
          {openRecords && (
            <button className="button" onClick={openRecords}>
              查看项目记录
            </button>
          )}
        </Callout>
      ) : (
        <Callout icon="shield" title="移入最近删除，至少保留 30 天">
          <p>
            可在设置「最近删除」恢复。普通删除只移除项目的组织记录，不级联删除对话、控件、领域记录、仓库或文件，也不停止领域执行。
          </p>
        </Callout>
      )}
      <ImpactList
        rows={[
          [
            "项目对话",
            impact.chats
              ? `${impact.chats} 段，保留在最近聊天中，可继续打开`
              : "无",
          ],
          [
            "进行中的工作",
            impact.active
              ? `${impact.active} 项；不停止执行，可在待处理与记录中找到`
              : "无",
          ],
          [
            "待处理",
            pending === undefined
              ? "正在读取…"
              : pending === null
                ? "未能读取；删除后仍可在「待处理」中查看"
                : pending
                  ? `${pending} 项，仍在「待处理」中`
                  : "无",
          ],
          ["项目文件夹", `${project.folder.path}：不删除，字节不变`],
        ]}
      />
    </DeletionDialog>
  );
}
