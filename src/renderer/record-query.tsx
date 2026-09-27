import type { Snapshot } from "../shared/protocol";
export interface RecordQuery {
  search: string;
  scope: string;
  type: string;
  order: string;
  blocking: boolean;
  tab: "pending" | "processed";
  days: string;
}
export const initialRecordQuery: RecordQuery = {
  search: "",
  scope: "all",
  type: "all",
  order: "oldest",
  blocking: false,
  tab: "pending",
  days: "7",
};
export function recordScope(
  snapshot: Snapshot,
  conversationId?: string | null,
  instanceId?: string,
  scopeRef?: string,
) {
  const p = snapshot.projects.find(
    (p) =>
      (conversationId &&
        p.chats.some((c) => c.conversationId === conversationId)) ||
      (instanceId &&
        p.runtime?.instanceId === instanceId &&
        p.runtime.scopeRef === scopeRef),
  );
  return p?.id ?? (conversationId || instanceId ? "unassigned" : "application");
}
export function matchesRecord(
  q: RecordQuery,
  row: { text: string; scope: string; type: string; blocking?: boolean },
) {
  return (
    (!q.search ||
      row.text.toLocaleLowerCase().includes(q.search.toLocaleLowerCase())) &&
    (q.scope === "all" || q.scope === row.scope) &&
    (q.type === "all" || q.type === row.type) &&
    (!q.blocking || row.blocking)
  );
}
export function RecordFilters({
  query: q,
  change,
  snapshot,
  types,
  pending = false,
}: {
  query: RecordQuery;
  change: (q: RecordQuery) => void;
  snapshot: Snapshot;
  types: [string, string][];
  pending?: boolean;
}) {
  const set = (v: Partial<RecordQuery>) => change({ ...q, ...v });
  return (
    <div
      className="record-query"
      aria-label={pending ? "待处理查询" : "运行记录查询"}
    >
      {pending && (
        <div className="tabs" role="tablist" aria-label="事项状态">
          {(["pending", "processed"] as const).map((tab) => (
            <button
              role="tab"
              className="button"
              key={tab}
              aria-selected={q.tab === tab}
              onClick={() => set({ tab })}
            >
              {tab === "pending" ? "待处理" : "已处理"}
            </button>
          ))}
        </div>
      )}
      <div className="record-query-controls">
        <label>
          搜索
          <input
            className="record-query-search"
            aria-label={pending ? "搜索事项" : "搜索运行记录"}
            value={q.search}
            placeholder={
              pending
                ? "搜索事项、项目或对象…"
                : "搜索运行记录（对象、事件或编号）…"
            }
            onChange={(e) => set({ search: e.target.value })}
          />
        </label>
        <label>
          范围
          <select
            aria-label={pending ? "事项范围" : "记录范围"}
            value={q.scope}
            onChange={(e) => set({ scope: e.target.value })}
          >
            <option value="all">全部范围</option>
            {snapshot.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.id.slice(0, 8)}
              </option>
            ))}
            <option value="unassigned">未归属项目</option>
            <option value="application">应用全局</option>
          </select>
        </label>
        <label>
          类型
          <select
            aria-label={pending ? "处理类型" : "事件类型"}
            value={q.type}
            onChange={(e) => set({ type: e.target.value })}
          >
            <option value="all">全部类型</option>
            {[...new Map(types)].map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          排序
          <select
            aria-label={pending ? "事项排序" : "记录排序"}
            value={pending && q.tab === "processed" ? "processed" : q.order}
            disabled={pending && q.tab === "processed"}
            onChange={(e) => set({ order: e.target.value })}
          >
            {pending && q.tab === "processed" && (
              <option value="processed">最近处理优先</option>
            )}
            <option value="oldest">
              {pending ? "等待最久优先" : "最早优先"}
            </option>
            <option value="newest">
              {pending ? "最近到达优先" : "最新优先"}
            </option>
            {pending && <option value="blocking">阻塞优先</option>}
          </select>
        </label>
        {pending ? (
          <label className="record-query-check">
            <input
              type="checkbox"
              checked={q.blocking}
              onChange={(e) => set({ blocking: e.target.checked })}
            />
            仅看阻塞
          </label>
        ) : (
          <label>
            时间
            <select
              aria-label="记录时间"
              value={q.days}
              onChange={(e) => set({ days: e.target.value })}
            >
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
              <option value="all">全部保留记录</option>
            </select>
          </label>
        )}
        {(q.search || q.scope !== "all" || q.type !== "all" || q.blocking) && (
          <button
            className="button"
            onClick={() =>
              set({ search: "", scope: "all", type: "all", blocking: false })
            }
          >
            返回全部范围
          </button>
        )}
      </div>
    </div>
  );
}

export function recordDay(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("zh-CN");
}
