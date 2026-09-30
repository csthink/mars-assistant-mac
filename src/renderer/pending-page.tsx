import { useEffect, useState } from "react";
import type { Snapshot, PendingItem } from "../shared/protocol";
import type { ProjectionPendingItem } from "../shared/runtime-host";
import type { PreparedProjectAction } from "../shared/project-actions";
import type { HostExecutionRecord } from "../shared/runtime-execution";
import type { ToolOperation } from "../shared/capabilities";
import { PendingRow, type ProjectProjection } from "./project-pending";
import { Confirmation } from "./project-actions";
import { PendingList, pendingLabels, RunLog } from "./records";
import { ToolPending, toolStateLabels } from "./capabilities";
import { HostExecutionFact, stopConfirmed } from "./host-execution-fact";
import {
  RecordFilters,
  initialRecordQuery,
  matchesRecord,
  recordScope,
  type RecordQuery,
} from "./record-query";
import { RecordPanel, RecordPagination } from "./record-panel";
import { useProjectColumns } from "./project-columns";

interface Row {
  key: string;
  title: string;
  scope: string;
  type: string;
  typeLabel: string;
  at: string;
  status: "pending" | "processed";
  blocking: boolean;
  owner: string;
  result: string;
  entry?: ProjectProjection;
  item?: ProjectionPendingItem;
  host?: PendingItem;
  tool?: ToolOperation;
  execution?: HostExecutionRecord;
}
function rowsFor(snapshot: Snapshot, entries: ProjectProjection[]): Row[] {
  const rows: Row[] = [],
    seen = new Set<string>();
  for (const entry of entries)
    for (const item of entry.view?.projection?.pendingItems ?? []) {
      const key = `runtime:${entry.project.runtime?.instanceId}|${item.scopeRef}|${item.itemRef}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        key,
        title: item.title,
        scope: entry.project.id,
        type: `runtime:${item.capability.id}:${item.typeId}`,
        typeLabel: item.typeLabel,
        at: item.processedAt ?? item.pendingSince,
        status: item.status,
        blocking: item.blocking,
        owner: entry.project.name,
        result:
          item.status === "processed"
            ? "来源已处理，具体结果以来源记录为准。"
            : "",
        entry,
        item,
      });
    }
  for (const host of [
    ...snapshot.pendingItems,
    ...(snapshot.resolvedPendingItems ?? []),
  ]) {
    const execution = snapshot.runtimeExecutions.find(
      (e) => e.executionRef === host.executionRef,
    );
    rows.push({
      key: `host:${host.id}`,
      title: pendingLabels[host.kind],
      scope: recordScope(
        snapshot,
        host.conversationId,
        execution?.instanceId,
        execution?.scopeRef,
      ),
      type: `host:${host.kind}`,
      typeLabel: pendingLabels[host.kind],
      at: host.resolvedAt ?? host.createdAt,
      status: host.state === "resolved" ? "processed" : "pending",
      blocking: host.kind === "stop_unconfirmed",
      owner:
        snapshot.conversations.find((c) => c.id === host.conversationId)
          ?.title ?? "Host 执行",
      result: host.state === "resolved" ? "事项已处理，原始事件保留。" : "",
      host,
      execution,
    });
  }
  for (const execution of snapshot.runtimeExecutions.filter(stopConfirmed)) {
    if (rows.some((r) => r.host?.executionRef === execution.executionRef))
      continue;
    rows.push({
      key: `stop:${execution.executionRef}`,
      title: "停止未确认",
      scope: recordScope(
        snapshot,
        null,
        execution.instanceId,
        execution.scopeRef,
      ),
      type: "host:stop_unconfirmed",
      typeLabel: "停止未确认",
      at: execution.stopUnconfirmed!.resolvedAt!,
      status: "processed",
      blocking: false,
      owner: execution.domainNodeRef ?? "Host 执行",
      result: "已取消执行的进程已退出，限制已解除。",
      execution,
    });
  }
  for (const tool of snapshot.toolOperations) {
    const pending = tool.state === "pending" || tool.state === "unknown";
    rows.push({
      key: `tool:${tool.id}`,
      title: `资料读取：${tool.attachmentName}`,
      scope: recordScope(snapshot, tool.conversationId),
      type: "host:tool-authorization",
      typeLabel: "资料读取授权",
      at:
        snapshot.events.find((e) => e.executionId === tool.executionId)?.at ??
        "",
      status: pending ? "pending" : "processed",
      blocking: pending,
      owner: tool.conversationTitle,
      result: toolStateLabels[tool.state],
      tool,
    });
  }
  return rows;
}

function PendingEvidence({ row, snapshot }: { row: Row; snapshot: Snapshot }) {
  const [texts, setTexts] = useState<Record<number, string>>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [process, setProcess] = useState(false);
  async function read(index: number) {
    if (!row.entry || !row.item) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.desktop.projectEvidence({
        projectId: row.entry.project.id,
        itemRef: row.item.itemRef,
        revision: row.item.revision,
        index,
      });
      if (result.ok) setTexts((old) => ({ ...old, [index]: result.text }));
      else setError(result.message);
    } catch {
      setError("证据未读取，已读内容保留。");
    } finally {
      setBusy(false);
    }
  }
  const executionId =
    row.host?.executionId ??
    row.tool?.executionId ??
    row.execution?.executionId;
  const events = executionId
    ? snapshot.events
        .filter((e) => e.executionId === executionId)
        .sort((a, b) => a.at.localeCompare(b.at))
    : [];
  return (
    <div className="record-context">
      <h3>{row.title}</h3>
      <p>{row.owner}</p>
      <button className="button" onClick={() => setProcess(!process)}>
        {process ? "返回证据" : "查看执行过程"}
      </button>
      {process ? (
        events.length ? (
          <RunLog
            events={events}
            executions={snapshot.runtimeExecutions}
            connections={snapshot.connections}
          />
        ) : (
          <p>来源未提供可确认的同次执行事件。</p>
        )
      ) : (
        <>
          {row.item ? (
            <>
              <p>固定依据：{row.item.evidence.length} 项</p>
              {row.item.evidence.map((_, index) => (
                <section key={index}>
                  <button
                    className="button"
                    disabled={busy || !!row.entry?.unavailable}
                    onClick={() => void read(index)}
                  >
                    读取依据 {index + 1}
                  </button>
                  {texts[index] !== undefined && (
                    <pre tabIndex={0}>{texts[index]}</pre>
                  )}
                </section>
              ))}
            </>
          ) : row.execution ? (
            <HostExecutionFact
              record={row.execution}
              connections={snapshot.connections}
            />
          ) : row.tool ? (
            <dl className="metadata">
              <dt>资料</dt>
              <dd>{row.tool.attachmentName}</dd>
              <dt>提交摘要</dt>
              <dd>{row.tool.sha256}</dd>
              <dt>用途</dt>
              <dd>{row.tool.purpose}</dd>
            </dl>
          ) : (
            <p>来源没有提供证据原件；可查看执行过程。</p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function PendingPage({
  snapshot,
  entries,
  connected,
  busy,
  onRetry,
  onDismiss,
  onRecheck,
  onOpen,
  onProject,
  refresh,
  onRecords,
  scope,
}: {
  snapshot: Snapshot;
  entries: ProjectProjection[];
  connected: boolean;
  busy: boolean;
  onRetry: (item: PendingItem) => Promise<unknown> | void;
  onDismiss: (item: PendingItem) => Promise<unknown> | void;
  onRecheck: (record: HostExecutionRecord) => void;
  onOpen: (id: string) => void;
  onProject: (id: string, ref: string) => void;
  refresh: () => void;
  onRecords: (scope: string) => void;
  scope?: string;
}) {
  const columns = useProjectColumns();
  const [query, setQuery] = useState<RecordQuery>({
    ...initialRecordQuery,
    scope: scope ?? "all",
  });
  const [cause, setCause] = useState<"tab" | "filter" | "page" | "move">(
    "move",
  );
  const [page, setPage] = useState(0),
    [size, setSize] = useState(5),
    [selected, setSelected] = useState<string | undefined>(
      () => sessionStorage.getItem("pending-selected") ?? undefined,
    );
  const [resultKey, setResultKey] = useState<string>(),
    [submitted, setSubmitted] = useState<string>();
  const [prepared, setPrepared] = useState<PreparedProjectAction | null>(null),
    [refusal, setRefusal] = useState("");
  const [evidence, setEvidence] = useState(false);
  const live = rowsFor(snapshot, entries);
  const rows = live;
  const filtered = rows
    .filter(
      (r) =>
        r.status === query.tab &&
        matchesRecord(query, {
          text: [
            r.title,
            r.owner,
            r.item?.objectRef,
            r.item?.itemRef,
            r.host?.id,
          ].join(" "),
          scope: r.scope,
          type: r.type,
          blocking: r.blocking,
        }),
    )
    .sort((a, b) =>
      query.tab === "processed" || query.order === "newest"
        ? b.at.localeCompare(a.at)
        : query.order === "blocking" && a.blocking !== b.blocking
          ? Number(b.blocking) - Number(a.blocking)
          : a.at.localeCompare(b.at),
    );
  const safePage = Math.min(
      page,
      Math.max(0, Math.ceil(filtered.length / size) - 1),
    ),
    visible = filtered.slice(safePage * size, (safePage + 1) * size);
  const row = rows.find((r) => r.key === selected);
  useEffect(() => {
    if (selected) sessionStorage.setItem("pending-selected", selected);
  }, [selected]);
  useEffect(() => {
    if (!selected && visible[0]) setSelected(visible[0].key);
  }, [selected, visible[0]?.key]);
  useEffect(() => {
    if (submitted && row?.key === submitted && row.status === "processed") {
      setResultKey(submitted);
      setSubmitted(undefined);
    }
  }, [submitted, row?.key, row?.status]);
  const shown =
    !!row && (visible.some((r) => r.key === row.key) || resultKey === row.key);
  function change(next: RecordQuery) {
    setCause(next.tab !== query.tab ? "tab" : "filter");
    setResultKey(undefined);
    setSubmitted(undefined);
    setQuery(next);
    setPage(0);
  }
  function reveal() {
    if (!row) return;
    setCause("move");
    setResultKey(undefined);
    setQuery({ ...initialRecordQuery, tab: row.status });
    setPage(0);
    const ordered = rows
      .filter((r) => r.status === row.status)
      .sort((a, b) =>
        row.status === "processed"
          ? b.at.localeCompare(a.at)
          : a.at.localeCompare(b.at),
      );
    setPage(Math.floor(ordered.findIndex((r) => r.key === row.key) / size));
  }
  function select(key: string) {
    setCause("move");
    setSelected(key);
    setResultKey(undefined);
    setSubmitted(undefined);
    setRefusal("");
  }
  const placeholder =
    row?.status !== query.tab
      ? cause === "tab"
        ? "当前页签下没有选中的事项"
        : row?.status === "processed"
          ? "该事项已移入已处理"
          : "该事项已回到待处理"
      : !filtered.some((r) => r.key === selected)
        ? "当前筛选下没有选中的事项"
        : "选中的事项不在当前页";
  return (
    <>
      <RecordFilters
        query={query}
        change={change}
        snapshot={snapshot}
        pending
        types={rows.map((r) => [r.type, r.typeLabel])}
      />
      <p className="quiet">
        全部未解决：{live.filter((r) => r.status === "pending").length} · 阻塞：
        {live.filter((r) => r.status === "pending" && r.blocking).length}
      </p>
      {query.scope !== "all" && (
        <p className="record-scope">
          范围：
          {snapshot.projects.find((p) => p.id === query.scope)?.name ??
            query.scope}{" "}
          <button
            className="link-button"
            onClick={() => change({ ...query, scope: "all" })}
          >
            回到全局
          </button>
        </p>
      )}
      {entries
        .filter((e) => e.unavailable)
        .map((e) => (
          <p key={e.project.id} className="project-runtime-warning">
            {e.project.name}：{e.unavailable}
          </p>
        ))}
      <div className="pending-columns">
        <section className="pending-index" aria-label="事项列表">
          <p className="quiet">筛选结果：{filtered.length}</p>
          <ul className="record-rows">
            {visible.map((r) => (
              <li key={r.key}>
                <button
                  className="record-row"
                  data-item-ref={r.item?.itemRef}
                  aria-pressed={selected === r.key}
                  onClick={() => select(r.key)}
                >
                  <strong>{r.title}</strong>
                  <span>
                    {r.owner} · {r.typeLabel}
                  </span>
                  <small>
                    {r.at
                      ? new Date(r.at).toLocaleString("zh-CN")
                      : "时间未提供"}
                    {r.blocking ? " · 阻塞" : ""}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {!visible.length && (
            <p className="project-empty-small">
              {live.some((r) => r.status === "pending")
                ? "当前筛选没有事项，全局仍有待处理事项。"
                : "没有待处理事项"}
            </p>
          )}
          <RecordPagination
            page={safePage}
            size={size}
            total={filtered.length}
            sizes={[5, 10, 20]}
            change={(p, n) => {
              setCause("page");
              setResultKey(undefined);
              setSubmitted(undefined);
              setPage(p);
              setSize(n);
            }}
          />
        </section>
        <section className="pending-detail" aria-label="事项详情">
          {refusal && (
            <p role="alert" className="project-error">
              来源拒绝了上一次提交：{refusal}
            </p>
          )}
          {!row ? (
            <p>选择一个事项查看详情。</p>
          ) : !shown ? (
            <div role="status">
              <h2>{placeholder}</h2>
              <p>{row.title}</p>
              {row.status === "processed" && (
                <p>
                  {row.at} · {row.result}
                </p>
              )}
              <button className="button" onClick={reveal}>
                {row.status === "processed" && query.tab === "pending"
                  ? "在已处理中查看"
                  : "显示该事项"}
              </button>
              <button
                className="button"
                onClick={() =>
                  change({ ...initialRecordQuery, tab: query.tab })
                }
              >
                清除筛选
              </button>
            </div>
          ) : (
            <>
              {row.status === "processed" && (
                <div className="pending-result">
                  <h2>已处理</h2>
                  <p>{row.result}</p>
                  <p>
                    处理时间：{row.at} · 处理入口：
                    {resultKey === row.key ? "待处理详情" : "来源未提供"}
                  </p>
                  <button
                    className="button"
                    onClick={() => onRecords(row.scope)}
                  >
                    在记录中查看相关事件
                  </button>
                </div>
              )}
              {row.entry && row.item ? (
                <ul className="pending-list">
                  <PendingRow
                    key={row.key}
                    entry={row.entry}
                    item={row.item}
                    onPrepared={(p) => {
                      setPrepared(p);
                    }}
                    onRefused={(message) =>
                      setRefusal(message ? `${row.title}：${message}` : "")
                    }
                    onOpen={onProject}
                    onEvidence={() => {
                      setEvidence(true);
                      columns?.setOpen(true);
                    }}
                  />
                </ul>
              ) : row.host && row.status === "pending" ? (
                <PendingList
                  items={[row.host]}
                  executions={snapshot.runtimeExecutions}
                  connections={snapshot.connections}
                  busy={busy || !connected}
                  onRetry={(item) => {
                    setSubmitted(row.key);
                    void onRetry(item);
                  }}
                  onDismiss={(item) => {
                    setSubmitted(row.key);
                    void onDismiss(item);
                  }}
                  onRecheck={onRecheck}
                  onOpen={onOpen}
                />
              ) : row.tool && row.status === "pending" ? (
                <div
                  onClickCapture={(e) => {
                    if ((e.target as HTMLElement).closest("button"))
                      setSubmitted(row.key);
                  }}
                >
                  <ToolPending
                    operations={[row.tool]}
                    connected={connected}
                    onOpen={onOpen}
                  />
                </div>
              ) : row.execution ? (
                <HostExecutionFact
                  record={row.execution}
                  connections={snapshot.connections}
                />
              ) : null}
              <button
                className="button"
                onClick={() => {
                  setEvidence(true);
                  columns?.setOpen(true);
                }}
              >
                查看证据与执行过程
              </button>
            </>
          )}
        </section>
      </div>
      <RecordPanel title="证据与执行过程" available={shown && evidence}>
        {row && <PendingEvidence key={row.key} row={row} snapshot={snapshot} />}
      </RecordPanel>
      {prepared && (
        <Confirmation
          key={prepared.token}
          prepared={prepared}
          close={() => setPrepared(null)}
          submitted={() => setSubmitted(selected)}
          changed={refresh}
        />
      )}
    </>
  );
}
