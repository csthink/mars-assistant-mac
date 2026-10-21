import { openModal } from "./modal-focus";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import type { SearchCategory, SearchHit, SearchKind } from "../shared/search";
let sequence = Date.now();
export function Highlight({
  text,
  ranges,
}: {
  text: string;
  ranges: [number, number][];
}) {
  let end = 0;
  const parts = [];
  for (const [start, stop] of ranges) {
    parts.push(text.slice(end, start));
    parts.push(<mark key={start}>{text.slice(start, stop)}</mark>);
    end = stop;
  }
  parts.push(text.slice(end));
  return <>{parts}</>;
}
const categories: [SearchCategory, string][] = [
  ["all", "全部"],
  ["conversation", "对话"],
  ["project", "项目"],
  ["widget", "控件"],
];
const kindNames: Record<SearchKind, string> = {
  conversation: "对话",
  project: "项目",
  widget: "控件",
};
const kindIcons: Record<SearchKind, string> = {
  conversation: "chat",
  project: "folder",
  widget: "grid",
};
const empty = { conversation: 0, project: 0, widget: 0 };
/** Where a hit lives (SEARCH-01): same-name objects stay apart by this line and by their short identity. */
function location(hit: SearchHit) {
  if (hit.kind === "project") return "项目";
  if (hit.kind === "widget") return "控件页";
  return `${hit.projectName ? `项目 ${hit.projectName}` : "未归属项目"} · ${hit.messageId ? "消息" : "对话标题"}`;
}

/**
 * The global search panel (SEARCH-01): conversations, projects and retained widgets of this Mac, in four
 * categories with their match counts. 全部 shows the first hits of every kind with a link to the kind's own
 * category; a single category pages after the last hit of the previous page. A newer input supersedes every older
 * request, and a reply for an older input is dropped.
 */
export function SearchDialog({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (hit: SearchHit, query: string) => Promise<boolean | string>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<SearchCategory>("all");
  // Cursors of the pages before the current one; the last entry is the current page's cursor.
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const cursor = pages.at(-1) ?? null;
  const [hits, setHits] = useState<SearchHit[]>([]),
    [counts, setCounts] = useState(empty),
    [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState(0),
    [busy, setBusy] = useState(true),
    [opening, setOpening] = useState(false),
    [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const version = useRef(0);
  const composing = useRef(false);
  const keyword = query.trim();
  // SEARCH-01: a press that both starts and ends on the backdrop closes the panel like Escape;
  // a press that starts inside and is released outside must not.
  const backdropPress = useRef(false);
  const onBackdrop = (event: { clientX: number; clientY: number }) => {
    const box = dialog.current?.getBoundingClientRect();
    return (
      !!box &&
      (event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom)
    );
  };
  useEffect(() => {
    const restoreFocus = openModal(dialog.current!);
    input.current?.focus();
    return () => {
      version.current++;
      void window.desktop.cancelSearch();
      restoreFocus();
    };
  }, []);
  // Without a keyword, projects and widgets have nothing to list; no query is sent.
  const idle = !keyword && (category === "project" || category === "widget");
  useEffect(() => {
    const token = ++version.current;
    if (idle) {
      setBusy(false);
      setHits([]);
      setCounts(empty);
      setNext(null);
      setSelected(0);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void window.desktop
        .search({ sequence: ++sequence, query, category, cursor })
        .then((reply) => {
          if (!alive || version.current !== token) return;
          setBusy(false);
          if (reply.ok) {
            setHits(reply.hits);
            setCounts(reply.counts);
            setNext(reply.next);
            setSelected(0);
          } else if (reply.code !== "SUPERSEDED") setError(reply.message);
        })
        .catch(() => {
          if (alive && version.current === token) {
            setBusy(false);
            setError("搜索未完成，请重试。");
          }
        });
    }, 60);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, cursor, retry, category, idle]);
  useEffect(() => {
    dialog.current
      ?.querySelector(`[data-search-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  function reset(nextCategory: SearchCategory, nextQuery: string) {
    version.current++;
    setPages([null]);
    setHits([]);
    setNext(null);
    setSelected(0);
    setBusy(
      !(
        !nextQuery.trim() &&
        (nextCategory === "project" || nextCategory === "widget")
      ),
    );
    setError("");
    void window.desktop.cancelSearch();
  }
  function change(value: string) {
    setQuery(value);
    if (!value.trim()) setCounts(empty);
    reset(category, value);
  }
  function choose(nextCategory: SearchCategory) {
    if (nextCategory === category) return;
    setCategory(nextCategory);
    reset(nextCategory, query);
  }
  function page(nextPages: (string | null)[]) {
    version.current++;
    setBusy(true);
    setError("");
    setPages(nextPages);
  }
  async function open(hit: SearchHit) {
    if (opening || busy) return;
    setOpening(true);
    try {
      const result = await onOpen(hit, query);
      if (result === true) onClose();
      else
        setError(
          typeof result === "string"
            ? result
            : hit.kind === "conversation"
              ? "未能打开原对话，请重试。"
              : `未能打开${kindNames[hit.kind]}，请重试。`,
        );
    } catch {
      setError("未能打开搜索结果，请重新连接后重试。");
    } finally {
      setOpening(false);
    }
  }
  // 全部 groups the hits by kind in the reply's order; a single category is one group.
  const groups = (["conversation", "project", "widget"] as const)
    .map((kind) => ({
      kind,
      hits: hits.filter((hit) => hit.kind === kind),
    }))
    .filter((group) => group.hits.length);
  let index = -1;
  return (
    <dialog
      ref={dialog}
      className="search-dialog"
      aria-label="全局搜索"
      onCancel={(e) => {
        e.preventDefault();
        if (!opening) onClose();
      }}
      onPointerDown={(e) => {
        backdropPress.current = e.target === e.currentTarget && onBackdrop(e);
      }}
      onPointerUp={(e) => {
        const closes =
          backdropPress.current &&
          e.target === e.currentTarget &&
          onBackdrop(e);
        backdropPress.current = false;
        if (closes && !opening) onClose();
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || composing.current) return;
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && hits.length) {
          e.preventDefault();
          setSelected(
            (n) =>
              (n + (e.key === "ArrowDown" ? 1 : -1) + hits.length) %
              hits.length,
          );
        }
        if (e.key === "Enter" && document.activeElement === input.current) {
          e.preventDefault();
          const flat = groups.flatMap((group) => group.hits);
          if (flat[selected]) void open(flat[selected]);
        }
      }}
    >
      <div className="search-input-row">
        <span aria-hidden="true">⌕</span>
        <input
          ref={input}
          aria-label="搜索对话、项目与控件"
          placeholder="搜索对话、项目或控件…"
          value={query}
          onChange={(e) => change(e.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="search-results"
          aria-activedescendant={
            hits[selected] ? `search-option-${selected}` : undefined
          }
          autoComplete="off"
        />
        <button onClick={onClose} disabled={opening} aria-label="关闭搜索">
          <kbd>Esc</kbd>
        </button>
      </div>
      <div
        className="search-categories"
        role="tablist"
        aria-label="搜索分类"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          const at = categories.findIndex(([id]) => id === category);
          const target =
            categories[
              (at + (e.key === "ArrowRight" ? 1 : -1) + categories.length) %
                categories.length
            ][0];
          choose(target);
          e.currentTarget
            .querySelector<HTMLButtonElement>(`[data-category="${target}"]`)
            ?.focus();
        }}
      >
        {categories.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-category={id}
            aria-selected={category === id}
            tabIndex={category === id ? 0 : -1}
            className={category === id ? "selected" : ""}
            onClick={() => choose(id)}
          >
            {label}
            {keyword && !busy && (
              <b className="search-count">
                {id === "all"
                  ? counts.conversation + counts.project + counts.widget
                  : counts[id]}
              </b>
            )}
          </button>
        ))}
      </div>
      <div className="search-group-title">
        <span>
          {keyword
            ? category === "all"
              ? "匹配的对话、项目与控件"
              : `匹配的${kindNames[category]}`
            : category === "all" || category === "conversation"
              ? "最近对话"
              : categories.find(([id]) => id === category)![1]}
        </span>
        <span>仅搜索本机已保存内容</span>
      </div>
      <p className="search-scope-note">
        包含已归档 · 不含最近删除、未发送输入与控件草稿
      </p>
      <div
        className="search-results"
        id="search-results"
        role="listbox"
        aria-label="搜索结果"
        aria-busy={busy}
      >
        {!busy &&
          groups.map((group) => (
            <div
              key={group.kind}
              role="group"
              aria-label={kindNames[group.kind]}
              className="search-group"
            >
              {keyword && category === "all" && (
                <div className="search-group-head" role="presentation">
                  <span>
                    {kindNames[group.kind]} {counts[group.kind]}
                  </span>
                  {counts[group.kind] > group.hits.length && (
                    <button
                      type="button"
                      className="search-more"
                      onClick={() => choose(group.kind)}
                    >
                      查看全部 {counts[group.kind]} 个{kindNames[group.kind]}
                      结果
                    </button>
                  )}
                </div>
              )}
              {group.hits.map((hit) => {
                const at = ++index;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={at === selected}
                    id={`search-option-${at}`}
                    data-search-index={at}
                    data-search-kind={hit.kind}
                    data-search-object={hit.objectId}
                    key={`${hit.kind}:${hit.objectId}:${hit.messageId}`}
                    className={`search-result ${at === selected ? "selected" : ""}`}
                    disabled={opening}
                    onMouseMove={() => setSelected(at)}
                    onClick={() => {
                      void open(hit);
                    }}
                  >
                    <span className="search-result-icon" aria-hidden="true">
                      <Icon name={kindIcons[hit.kind]} />
                    </span>
                    <span className="search-result-body">
                      <strong>
                        <Highlight text={hit.title} ranges={hit.titleRanges} />
                        {hit.archived && <span className="tag">已归档</span>}
                      </strong>
                      {hit.text && (
                        <small>
                          <Highlight text={hit.text} ranges={hit.ranges} />
                        </small>
                      )}
                      <span className="search-result-meta">
                        {location(hit)}
                        {hit.updatedAt && (
                          <>
                            {" · "}
                            <time dateTime={hit.updatedAt}>
                              {new Date(hit.updatedAt).toLocaleString("zh-CN", {
                                hour12: false,
                              })}
                            </time>
                          </>
                        )}
                        {` · ${hit.objectId.slice(0, 8)}`}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
      </div>
      {busy && (
        <p className="search-empty" role="status">
          正在搜索…
        </p>
      )}
      {!busy && !error && !hits.length && (
        <div className="search-empty" role="status">
          <strong>
            {idle
              ? `输入关键词搜索${kindNames[category as SearchKind]}`
              : keyword
                ? "没有找到匹配内容"
                : "还没有对话"}
          </strong>
          <p>
            {idle
              ? category === "project"
                ? "匹配项目名称与目标，包含已归档项目。"
                : "匹配已保留控件的名称与已保存内容，不包含控件草稿。"
              : keyword
                ? "换一个关键词试试。草稿、附件正文与控件草稿不在搜索范围内。"
                : "新建对话后，已保存的消息会出现在这里。"}
          </p>
        </div>
      )}
      {error && (
        <div className="search-error" role="alert">
          {error}
          <button
            className="button small"
            onClick={() => {
              setError("");
              setBusy(true);
              setRetry((n) => n + 1);
            }}
          >
            重试搜索
          </button>
        </div>
      )}
      <footer className="search-footer">
        <span>↑ ↓ 选择 · Enter 打开 · Esc 关闭</span>
        <div>
          {pages.length > 1 && (
            <button
              className="button small"
              disabled={busy}
              onClick={() => page(pages.slice(0, -1))}
            >
              上一页
            </button>
          )}
          {next && (
            <button
              className="button small"
              disabled={busy}
              onClick={() => page([...pages, next])}
            >
              下一页
            </button>
          )}
        </div>
      </footer>
    </dialog>
  );
}
export function SearchIndexSettings({ connected }: { connected: boolean }) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  return (
    <div className="setting-row">
      <div>
        <strong>本地搜索索引</strong>
        <p>搜索不完整时可以重建。对话、项目与控件会保留。</p>
        {message && <p role="status">{message}</p>}
      </div>
      <button
        className="button"
        disabled={!connected || busy}
        onClick={() => {
          setBusy(true);
          setMessage("");
          void window.desktop
            .command({ type: "rebuildSearchIndex" })
            .then((reply) =>
              setMessage(
                reply.ok
                  ? "搜索索引已重建。"
                  : "索引未重建。原对话、项目与控件保持不变，上一份索引仍可搜索。",
              ),
            )
            .catch(() =>
              setMessage(
                "索引未重建。原对话、项目与控件保持不变，上一份索引仍可搜索。",
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "正在重建…" : "重建搜索索引"}
      </button>
    </div>
  );
}
