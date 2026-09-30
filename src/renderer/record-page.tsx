import { HostExecutionFact } from "./host-execution-fact";
import { useEffect, useRef, useState } from "react";
import { openModal } from "./modal-focus";
import type { Snapshot, RunEvent } from "../shared/protocol";
import { eventLabels } from "../shared/protocol";
import type { ProjectProjection } from "./project-pending";
import { payloadSummary, RunLog } from "./records";
import {
  RecordFilters,
  initialRecordQuery,
  matchesRecord,
  recordDay,
  recordScope,
} from "./record-query";
import { RecordPanel, RecordPagination } from "./record-panel";
import { useProjectColumns } from "./project-columns";

interface EventRow {
  key: string;
  id: string;
  at: string;
  title: string;
  text: string;
  scope: string;
  owner: string;
  type: string;
  host?: RunEvent;
  entry?: ProjectProjection;
  objectRef?: string;
  section?: string;
}
function eventRows(
  snapshot: Snapshot,
  entries: ProjectProjection[],
): EventRow[] {
  const rows: EventRow[] = snapshot.events.map((event) => {
    const execution = snapshot.runtimeExecutions.find(
      (r) => r.executionRef === event.payload.executionRef,
    );
    const conversationId =
      snapshot.turns.find((t) => t.executionId === event.executionId)
        ?.conversationId ??
      (typeof event.payload.conversationId === "string"
        ? event.payload.conversationId
        : null);
    return {
      key: `host:${event.id}`,
      id: event.id,
      at: event.at,
      title: eventLabels[event.kind],
      text: payloadSummary(event, snapshot.runtimeExecutions),
      scope: recordScope(
        snapshot,
        conversationId,
        execution?.instanceId,
        execution?.scopeRef,
      ),
      owner:
        snapshot.conversations.find((c) => c.id === conversationId)?.title ??
        event.connection?.name ??
        "Assistant",
      type: `host:${event.kind}`,
      host: event,
    };
  });
  for (const entry of entries)
    for (const object of entry.view?.projection?.objects ?? [])
      if (object.view.kind === "trace") {
        for (const event of object.view.entries as {
          id: string;
          occurredAt: string;
          text: string;
          section?: string;
        }[])
          rows.push({
            key: `runtime:${entry.project.runtime?.instanceId}|${object.scopeRef}|${object.objectRef}|${event.id}`,
            id: event.id,
            at: event.occurredAt,
            title: object.title,
            text: event.text,
            scope: entry.project.id,
            owner: entry.project.name,
            type: "runtime:trace",
            entry,
            objectRef: object.objectRef,
            section: event.section,
          });
      }
  return rows;
}
function inTime(at: string, days: string) {
  if (days === "all") return true;
  const cutoff =
    days === "today"
      ? new Date().setHours(0, 0, 0, 0)
      : Date.now() - Number(days) * 86400000;
  return Date.parse(at) >= cutoff;
}
export function RecordsPage({
  snapshot,
  entries,
  onProject,
  onConversation,
  scope,
}: {
  snapshot: Snapshot;
  entries: ProjectProjection[];
  onProject: (id: string, ref: string) => void;
  onConversation: (id: string) => void;
  scope?: string;
}) {
  const columns = useProjectColumns();
  const [factKey, setFactKey] = useState<string>();
  const [query, setQuery] = useState({
    ...initialRecordQuery,
    order: "newest",
    scope: scope ?? "all",
  });
  const [selected, setSelected] = useState<string>(),
    [page, setPage] = useState(0),
    [size, setSize] = useState(12),
    [process, setProcess] = useState(false),
    [notice, setNotice] = useState(""),
    [copyText, setCopyText] = useState<string>();
  const rows = eventRows(snapshot, entries);
  const match = (row: EventRow) =>
    matchesRecord(query, {
      text: [
        row.title,
        row.text,
        row.owner,
        row.id,
        row.objectRef,
        row.host ? JSON.stringify(row.host) : "",
      ].join(" "),
      scope: row.scope,
      type: row.type,
    });
  const sort = (a: EventRow, b: EventRow) =>
    query.order === "oldest"
      ? a.at.localeCompare(b.at)
      : b.at.localeCompare(a.at);
  const filtered = rows
    .filter((r) => match(r) && inTime(r.at, query.days))
    .sort(sort);
  const safePage = Math.min(
      page,
      Math.max(0, Math.ceil(filtered.length / size) - 1),
    ),
    visible = filtered.slice(safePage * size, (safePage + 1) * size),
    row = rows.find((r) => r.key === selected),
    shown = visible.some((r) => r.key === selected);
  function reveal() {
    if (!row) return;
    const q = { ...initialRecordQuery, order: query.order, days: "all" };
    setQuery(q);
    setPage(
      Math.floor(
        [...rows].sort(sort).findIndex((r) => r.key === row.key) / size,
      ),
    );
  }
  const conversationId = row?.host
    ? (snapshot.turns.find((t) => t.executionId === row.host?.executionId)
        ?.conversationId ??
      (typeof row.host.payload.conversationId === "string"
        ? row.host.payload.conversationId
        : null))
    : null;
  const sourceExists =
    !!conversationId &&
    snapshot.conversations.some((c) => c.id === conversationId && !c.deletedAt);
  return (
    <>
      <RecordFilters
        query={query}
        change={(q) => {
          setQuery(q);
          setPage(0);
        }}
        snapshot={snapshot}
        types={[
          ...Object.entries(eventLabels).map(([k, v]): [string, string] => [
            `host:${k}`,
            v,
          ]),
          ["runtime:trace", "Runtime 记录"],
        ]}
      />
      {query.scope !== "all" && (
        <p className="record-scope">
          范围：
          {snapshot.projects.find((p) => p.id === query.scope)?.name ??
            query.scope}{" "}
          <button
            className="link-button"
            onClick={() => {
              setQuery({ ...query, scope: "all" });
              setPage(0);
            }}
          >
            回到全局
          </button>
        </p>
      )}
      <p className="quiet">筛选结果：{filtered.length} · 运行事件只读</p>
      {rows.some((r) => match(r) && !inTime(r.at, query.days)) && (
        <p className="record-scope">
          所选时间之外还有保留记录。
          <button
            className="link-button"
            onClick={() => {
              setQuery({ ...query, days: "all" });
              setPage(0);
            }}
          >
            查看全部时间
          </button>
        </p>
      )}
      <section aria-label="运行记录列表">
        <ol className="record-rows event-list" aria-label="运行事件">
          {visible.map((r, i) => (
            <li
              key={r.key}
              className={r.host ? `event event-${r.host.kind}` : "domain-event"}
            >
              {(i === 0 ||
                recordDay(visible[i - 1].at) !== recordDay(r.at)) && (
                <h3 className="event-date-group">{recordDay(r.at)}</h3>
              )}
              <button
                className="record-row"
                aria-pressed={selected === r.key}
                onClick={() => {
                  setSelected(r.key);
                  setProcess(false);
                  setNotice("");
                  columns?.setOpen(true);
                }}
              >
                <span>
                  <time dateTime={r.at}>
                    {new Date(r.at).toLocaleTimeString("zh-CN")}
                  </time>{" "}
                  · {r.title}
                </span>
                <strong className="event-detail">{r.text || r.title}</strong>
                {r.host && (
                  <span className="event-connection">
                    {r.host.connection
                      ? `${r.host.connection.name} · ${r.host.connection.model}`
                      : typeof r.host.payload.agent === "string"
                        ? `${String(r.host.payload.agent).replace(/^agent:/, "")} · ${String(r.host.payload.model ?? "")}`
                        : "无连接"}
                  </span>
                )}
                <small>
                  {r.owner} · {r.id}
                </small>
              </button>
              {r.host &&
                [
                  "completed",
                  "failed",
                  "stopped",
                  "interrupted",
                  "stop_unconfirmed",
                  "stop_confirmed",
                ].includes(r.host.kind) &&
                snapshot.runtimeExecutions.some(
                  (e) => e.executionRef === r.host!.payload.executionRef,
                ) && (
                  <button
                    className="link-button event-record-toggle"
                    onClick={() => {
                      setSelected(r.key);
                      setFactKey(factKey === r.key ? undefined : r.key);
                      columns?.setOpen(true);
                    }}
                  >
                    {factKey === r.key ? "收起执行记录" : "查看执行记录"}
                  </button>
                )}
            </li>
          ))}
        </ol>
      </section>
      {!visible.length && (
        <p className="project-empty-small">
          {rows.length ? "当前筛选没有运行记录。" : "还没有运行记录"}
        </p>
      )}
      <RecordPagination
        page={safePage}
        size={size}
        total={filtered.length}
        sizes={[12, 24, 48]}
        change={(p, n) => {
          setPage(p);
          setSize(n);
        }}
      />
      {row && (
        <button className="button" onClick={() => columns?.setOpen(true)}>
          查看所选记录
        </button>
      )}
      <RecordPanel title="事件详情" available={!!row}>
        {row && !shown ? (
          <div className="record-context" role="status">
            <h3>
              {filtered.some((r) => r.key === selected)
                ? "选中的记录不在当前页"
                : "当前筛选下没有选中的记录"}
            </h3>
            <p>{row.title}</p>
            <button className="button" onClick={reveal}>
              显示该记录
            </button>
            <button
              className="button"
              onClick={() => {
                setQuery({
                  ...initialRecordQuery,
                  order: "newest",
                  days: "all",
                });
                setPage(0);
              }}
            >
              清除筛选
            </button>
          </div>
        ) : (
          row && (
            <div className="record-context">
              <h3>{row.title}</h3>
              {factKey === row.key &&
                snapshot.runtimeExecutions
                  .filter(
                    (e) => e.executionRef === row.host?.payload.executionRef,
                  )
                  .map((e) => (
                    <HostExecutionFact
                      key={e.executionRef}
                      record={e}
                      connections={snapshot.connections}
                    />
                  ))}
              <dl className="metadata">
                <dt>编号</dt>
                <dd>{row.id}</dd>
                <dt>时间</dt>
                <dd>{row.at}</dd>
                <dt>所属</dt>
                <dd>{row.owner}</dd>
                <dt>事件来源</dt>
                <dd>
                  {row.host
                    ? typeof row.host.payload.executionRef === "string"
                      ? "Host 执行事实"
                      : "Assistant 事件"
                    : "Runtime 原始事件"}
                </dd>
              </dl>
              <p>{row.text}</p>
              {row.entry?.unavailable && (
                <p className="project-runtime-warning">
                  {row.entry.unavailable}
                </p>
              )}
              {row.host ? (
                <>
                  <h4>发生时快照</h4>
                  <p>
                    {row.host.connection
                      ? `${row.host.connection.name} · ${row.host.connection.model}`
                      : "未使用模型连接"}
                  </p>
                  <details>
                    <summary>原始事件字段</summary>
                    <pre tabIndex={0}>{JSON.stringify(row.host, null, 2)}</pre>
                  </details>
                </>
              ) : (
                <>
                  <p>来源对象：{row.objectRef}</p>
                  <p>
                    来源段落：{row.section || "未提供"}
                    。未提供可确认的同次执行标识。
                  </p>
                  <p>原事件未提供证据引用，不能以当前产物代替历史证据。</p>
                </>
              )}
              {row.entry && row.objectRef ? (
                <button
                  className="button"
                  disabled={!!row.entry.unavailable}
                  onClick={() =>
                    onProject(row.entry!.project.id, row.objectRef!)
                  }
                >
                  打开原项目
                </button>
              ) : (
                <button
                  className="button"
                  disabled={!sourceExists}
                  onClick={() =>
                    conversationId && onConversation(conversationId)
                  }
                >
                  打开关联对象
                </button>
              )}
              {!row.entry && !sourceExists && (
                <p>来源对象已删除或未提供，保留发生时快照。</p>
              )}
              <button className="button" onClick={() => setProcess(!process)}>
                {process ? "收起执行过程" : "查看执行过程"}
              </button>
              {process &&
                (row.host ? (
                  <RunLog
                    events={snapshot.events
                      .filter((e) => e.executionId === row.host!.executionId)
                      .sort((a, b) => a.at.localeCompare(b.at))}
                    executions={snapshot.runtimeExecutions}
                    connections={snapshot.connections}
                  />
                ) : (
                  <p>Runtime 未提供稳定的运行关联，不能按段落名称合并执行。</p>
                ))}
              <button
                className="button"
                onClick={() =>
                  setCopyText(
                    JSON.stringify(
                      row.host ?? {
                        id: row.id,
                        at: row.at,
                        text: row.text,
                        objectRef: row.objectRef,
                      },
                      null,
                      2,
                    ),
                  )
                }
              >
                复制事件详情
              </button>
              {notice && <p role="status">{notice}</p>}
            </div>
          )
        )}
      </RecordPanel>
      {copyText !== undefined && (
        <CopyEventDialog
          text={copyText}
          close={() => setCopyText(undefined)}
          copied={() => {
            setCopyText(undefined);
            setNotice("已复制事件详情");
          }}
        />
      )}
    </>
  );
}

function CopyEventDialog({
  text,
  close,
  copied,
}: {
  text: string;
  close: () => void;
  copied: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  useEffect(() => openModal(dialog.current!), []);
  return (
    <dialog
      ref={dialog}
      className="project-action-dialog"
      aria-label="复制事件详情"
      onCancel={close}
    >
      <h3>复制事件详情</h3>
      <p>复制的是字段与发生时快照，不含证据原件、密钥或诊断内容。</p>
      <pre tabIndex={0}>{text}</pre>
      {error && <p role="status">{error}</p>}
      <button className="button" onClick={close}>
        取消
      </button>
      <button
        className="button primary"
        onClick={() => {
          void navigator.clipboard
            .writeText(text)
            .then(copied, () =>
              setError("复制失败，请选择预览文本并手动复制。"),
            );
        }}
      >
        复制
      </button>
    </dialog>
  );
}
