import { recordDay, matchesRecord, type RecordQuery } from "./record-query";
import { useEffect, useRef, useState } from "react";
import type { Project } from "../shared/projects";
import type { Snapshot } from "../shared/protocol";
import {
  projectScopeProblem,
  type ProjectWorkView,
} from "../shared/project-work";
import type { PreparedProjectAction } from "../shared/project-actions";
import type {
  ProjectionAction,
  ProjectionPendingItem,
} from "../shared/runtime-host";
import { AwaitingNote, Confirmation } from "./project-actions";

export interface ProjectProjection {
  project: Project;
  view: ProjectWorkView | null;
  unavailable: string;
}
/** One last-known projection per project. Runtime/Host push revisions trigger reads, never domain actions. */
export function useProjectProjections(
  snapshot: Snapshot | undefined,
  connected: boolean,
) {
  const [views, setViews] = useState<
    Record<string, { view: ProjectWorkView | null; error: string }>
  >({});
  useEffect(() => {
    if (!snapshot || !connected) return;
    let active = true;
    const timer = setTimeout(() => {
      void Promise.all(
        snapshot.projects
          .filter((p) => p.runtime)
          .map(async (p) => {
            try {
              const r = await window.desktop.projectWork({
                type: "read",
                projectId: p.id,
              });
              return {
                id: p.id,
                view: r.ok ? (r.view ?? null) : null,
                error: r.ok ? "" : r.message,
              };
            } catch {
              return {
                id: p.id,
                view: null,
                error: "项目内容未读取，显示最后已知内容。",
              };
            }
          }),
      ).then((rows) => {
        if (active)
          setViews((old) =>
            Object.fromEntries(
              rows.map((r) => [
                r.id,
                {
                  view: r.view ?? old[r.id]?.view ?? null,
                  error: r.error,
                },
              ]),
            ),
          );
      });
    }, 80);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [snapshot?.revision, connected]);
  return (snapshot?.projects ?? [])
    .filter((p) => p.runtime)
    .map((project): ProjectProjection => {
      const cached = views[project.id];
      return {
        project,
        view: cached?.view ?? null,
        unavailable: !connected
          ? "服务未连接，显示最后已知内容。"
          : projectScopeProblem(snapshot!, project.runtime!) ||
            cached?.error ||
            cached?.view?.unavailable ||
            (!cached ? "正在读取项目内容…" : ""),
      };
    });
}
function stamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}
function PendingRow({
  entry,
  item,
  onPrepared,
  onRefused,
  onOpen,
}: {
  entry: ProjectProjection;
  item: ProjectionPendingItem;
  onPrepared: (p: PreparedProjectAction) => void;
  /** KB-317: a refused opening is reported to the list (message, or "" when a new opening starts). */
  onRefused: (message: string) => void;
  onOpen?: (projectId: string, objectRef: string) => void;
}) {
  const { project, view, unavailable } = entry;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [evidence, setEvidence] = useState<
      Record<number, { text: string; revision: string }>
    >({});
  const inFlight = useRef(false);
  // KB-308: the item's object awaits its projection after an action succeeded; its actions stay closed.
  // An unavailable source keeps the existing rule (warning, actions closed) and takes precedence.
  const awaiting =
    item.status === "pending" && !unavailable
      ? view?.awaiting.find((a) => a.objectRef === item.objectRef)
      : undefined;
  const actions = (view?.projection?.actions ?? []).filter(
    (a) =>
      a.scopeRef === item.scopeRef &&
      a.objectRef === item.objectRef &&
      item.actionIds.includes(a.actionId),
  );
  async function prepare(action: ProjectionAction) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    onRefused("");
    try {
      const r = await window.desktop.projectAction({
        type: "prepare",
        projectId: project.id,
        actionId: action.actionId,
        objectRef: action.objectRef,
        expectedRevision: action.expectedRevision,
        candidateRef: action.candidateRef,
        pending: { itemRef: item.itemRef, revision: item.revision },
      });
      if (r.ok && r.prepared) onPrepared(r.prepared);
      else if (!r.ok) onRefused(r.message);
    } catch {
      onRefused("事项未打开，请重新读取。");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function read(index: number) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await window.desktop.projectEvidence({
        projectId: project.id,
        itemRef: item.itemRef,
        revision: item.revision,
        index,
      });
      if (r.ok)
        setEvidence((old) => ({
          ...old,
          [index]: { text: r.text, revision: String(r.evidence.revision) },
        }));
      else setError(r.message);
    } catch {
      setError("固定依据未读取，已读内容保留。");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <li
      className="project-pending-item"
      data-item-ref={item.itemRef}
      data-item-revision={item.revision}
      data-status={item.status}
    >
      <div className="project-section-heading">
        <strong>{item.title}</strong>
        <span
          className={`project-tag ${item.status === "processed" ? "green" : awaiting ? "running" : "amber"}`}
        >
          {item.status === "processed"
            ? "已处理"
            : awaiting
              ? "同步中"
              : item.blocking
                ? "等待决定"
                : "待处理"}
        </span>
      </div>
      <p>
        {project.name}
        {project.archivedAt ? " · 已归档项目" : ""} · {item.typeLabel}
      </p>
      <p className="project-source">
        {item.status === "processed" ? "处理时间" : "等待开始"}：
        <time
          dateTime={
            item.status === "processed" ? item.processedAt! : item.pendingSince
          }
        >
          {stamp(
            item.status === "processed" ? item.processedAt! : item.pendingSince,
          )}
        </time>{" "}
        · 来自 Runtime
      </p>
      <details className="project-pending-source">
        <summary>事项来源</summary>
        <dl className="metadata">
          <dt>扩展实例</dt>
          <dd>{project.runtime?.instanceId}</dd>
          <dt>作用域</dt>
          <dd>{item.scopeRef}</dd>
          <dt>对象</dt>
          <dd>{item.objectRef}</dd>
          <dt>事项</dt>
          <dd>{item.itemRef}</dd>
          <dt>事项版本</dt>
          <dd>{item.revision}</dd>
        </dl>
      </details>
      {unavailable && (
        <p role="status" className="project-runtime-warning">
          {unavailable}
        </p>
      )}
      {awaiting && project.runtime && (
        <AwaitingNote
          awaiting={awaiting}
          actions={view?.projection?.actions ?? []}
          instanceId={project.runtime.instanceId}
        />
      )}
      <div className="project-action-buttons">
        {onOpen && (
          <button
            className="button"
            onClick={() => onOpen(project.id, item.objectRef)}
          >
            打开原项目
          </button>
        )}
        {item.status === "pending" &&
          actions.map((a) => (
            <div key={a.actionId}>
              <button
                className="button"
                disabled={busy || !!unavailable || !!awaiting || !a.enabled}
                onClick={() => void prepare(a)}
              >
                处理：{a.label}
              </button>
              {!a.enabled && !awaiting && (
                <p className="project-form-hint">{a.disabledReason}</p>
              )}
            </div>
          ))}
        {item.status === "pending" && actions.length === 0 && (
          <p className="project-form-hint">来源尚未提供可用处理动作。</p>
        )}
      </div>
      {item.evidence.length > 0 && (
        <details className="project-pending-evidence">
          <summary>查看固定依据</summary>
          {item.evidence.map((_, index) => (
            <section key={index}>
              <button
                className="button"
                disabled={busy || !!unavailable}
                onClick={() => void read(index)}
              >
                读取依据 {index + 1}
              </button>
              {evidence[index] && (
                <>
                  <p className="project-source">
                    已读取版本：{evidence[index].revision}
                  </p>
                  <pre tabIndex={0}>{evidence[index].text}</pre>
                </>
              )}
            </section>
          ))}
        </details>
      )}
      {error && (
        <p role="alert" className="project-error">
          {error}
        </p>
      )}
    </li>
  );
}
/** Both entry points use this component and the same item/action identities; no duplicated store or outcome. */
export function ProjectPendingList({
  entries,
  refresh,
  onOpen,
  query,
}: {
  entries: ProjectProjection[];
  refresh: () => void;
  onOpen?: (projectId: string, objectRef: string) => void;
  query?: RecordQuery;
}) {
  const [historyCount, setHistoryCount] = useState(10);
  const [prepared, setPrepared] = useState<PreparedProjectAction | null>(null);
  // KB-317: a refused opening is kept here, not in its row: the refusal often arrives because the item was
  // decided meanwhile, and the refreshed list no longer shows that row (its own message would go with it).
  const [refusal, setRefusal] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const refusalLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (refusal) refusalLine.current?.scrollIntoView({ block: "nearest" });
  }, [refusal]);
  const refused = (title: string) => (message: string) =>
    setRefusal(message ? { title, message } : null);
  const seen = new Set<string>();
  const rows = entries.flatMap((entry) =>
    (entry.view?.projection?.pendingItems ?? []).flatMap((item) => {
      const key = `${entry.project.runtime?.instanceId}|${item.scopeRef}|${item.itemRef}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ entry, item, key }];
    }),
  );
  const filtered = query
    ? rows.filter(({ entry, item }) =>
        matchesRecord(query, {
          text: [
            entry.project.name,
            item.title,
            item.typeLabel,
            item.objectRef,
            item.itemRef,
          ].join(" "),
          scope: entry.project.id,
          type: `runtime:${item.capability.id}:${item.typeId}`,
          blocking: item.blocking,
        }),
      )
    : rows;
  const pending = filtered
      .filter((r) => r.item.status === "pending")
      .sort((a, b) =>
        query?.order === "blocking" && a.item.blocking !== b.item.blocking
          ? Number(b.item.blocking) - Number(a.item.blocking)
          : query?.order === "newest"
            ? b.item.pendingSince.localeCompare(a.item.pendingSince)
            : a.item.pendingSince.localeCompare(b.item.pendingSince),
      ),
    processed = filtered
      .filter((r) => r.item.status === "processed")
      .sort((a, b) => b.item.processedAt!.localeCompare(a.item.processedAt!));
  return (
    <section className="project-pending" aria-label="项目待处理">
      <h3>项目待处理</h3>
      {entries
        .filter((e) => e.unavailable)
        .map((e) => (
          <p className="project-runtime-warning" key={e.project.id}>
            {e.project.name}：{e.unavailable}
          </p>
        ))}
      {query && (
        <p className="project-source">
          项目结果：
          {query.tab === "processed" ? processed.length : pending.length}
        </p>
      )}
      {refusal && (
        <p role="alert" className="project-error" ref={refusalLine}>
          未能打开“{refusal.title}”：{refusal.message}
        </p>
      )}
      {query?.tab !== "processed" &&
        (pending.length ? (
          <ul aria-label="领域待处理事项">
            {pending.map((r) => (
              <PendingRow
                key={r.key}
                entry={r.entry}
                item={r.item}
                onPrepared={setPrepared}
                onRefused={refused(r.item.title)}
                onOpen={onOpen}
              />
            ))}
          </ul>
        ) : (
          <p className="project-empty-small">当前范围没有待处理决定。</p>
        ))}
      {processed.length > 0 && (!query || query.tab === "processed") && (
        <details
          open={query?.tab === "processed" ? true : undefined}
          className="project-pending-history"
        >
          <summary>已处理决定（{processed.length}）</summary>
          <ul aria-label="已处理领域事项">
            {processed.slice(0, historyCount).map((r) => (
              <PendingRow
                key={r.key}
                entry={r.entry}
                item={r.item}
                onPrepared={setPrepared}
                onRefused={refused(r.item.title)}
                onOpen={onOpen}
              />
            ))}
          </ul>
          {processed.length > historyCount && (
            <button
              className="button"
              onClick={() => setHistoryCount((n) => n + 10)}
            >
              显示更早决定
            </button>
          )}
        </details>
      )}
      {prepared && (
        <Confirmation
          key={prepared.token}
          prepared={prepared}
          close={() => setPrepared(null)}
          changed={refresh}
        />
      )}
    </section>
  );
}
export function ProjectRunLog({
  entries,
  onOpen,
  query,
}: {
  entries: ProjectProjection[];
  onOpen: (projectId: string, objectRef: string) => void;
  query: RecordQuery;
}) {
  const all = entries.flatMap((entry) =>
    (entry.view?.projection?.objects ?? [])
      .filter((o) => o.view.kind === "trace")
      .flatMap((object) =>
        (
          object.view.entries as {
            id: string;
            section?: string;
            occurredAt: string;
            text: string;
          }[]
        ).map((event) => ({ entry, object, event })),
      ),
  );
  if (!all.length) return null;
  const shown = all
    .filter(
      ({ entry, object, event: e }) =>
        matchesRecord(query, {
          text: [
            entry.project.name,
            object.title,
            object.objectRef,
            e.id,
            e.text,
            e.section,
          ].join(" "),
          scope: entry.project.id,
          type: "runtime:trace",
        }) &&
        (query.days === "all" ||
          Date.parse(e.occurredAt) >=
            Date.now() - Number(query.days) * 86400000),
    )
    .sort((a, b) =>
      query.order === "oldest"
        ? a.event.occurredAt.localeCompare(b.event.occurredAt)
        : b.event.occurredAt.localeCompare(a.event.occurredAt),
    );
  return (
    <section className="project-domain-runs" aria-label="项目运行记录">
      <h2>项目运行记录</h2>
      <p className="project-source">
        结果：{shown.length} · Runtime 原始事件只读
      </p>
      <ol>
        {shown.map(({ entry, object, event: e }, i) => (
          <li key={`${entry.project.id}|${object.objectRef}|${e.id}`}>
            {(i === 0 ||
              recordDay(shown[i - 1].event.occurredAt) !==
                recordDay(e.occurredAt)) && <h3>{recordDay(e.occurredAt)}</h3>}
            <div className="project-section-heading">
              <strong>
                {entry.project.name} · {object.title}
              </strong>
              <button
                className="button"
                onClick={() => onOpen(entry.project.id, object.objectRef)}
              >
                打开原项目
              </button>
            </div>
            <time dateTime={e.occurredAt}>{stamp(e.occurredAt)}</time> ·{" "}
            {e.section || "来源未提供运行分组"}
            <p>{e.text}</p>
            {entry.unavailable && (
              <p className="project-runtime-warning">{entry.unavailable}</p>
            )}
            <details>
              <summary>发生时来源</summary>
              <p className="project-source">
                {entry.project.runtime?.instanceId} · {object.scopeRef} ·{" "}
                {object.objectRef} · {e.id} · {e.section || "无运行分组"}
              </p>
            </details>
            {e.section && (
              <details>
                <summary>查看执行过程</summary>
                {all
                  .filter(
                    (r) =>
                      r.entry.project.id === entry.project.id &&
                      r.object.objectRef === object.objectRef &&
                      r.event.section === e.section,
                  )
                  .sort((a, b) =>
                    a.event.occurredAt.localeCompare(b.event.occurredAt),
                  )
                  .map((r) => (
                    <p key={r.event.id}>
                      <time dateTime={r.event.occurredAt}>
                        {stamp(r.event.occurredAt)}
                      </time>{" "}
                      · {r.event.text}
                    </p>
                  ))}
              </details>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
