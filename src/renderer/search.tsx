import { openModal } from "./modal-focus";
import { useEffect, useRef, useState } from "react";
import type { SearchHit } from "../shared/search";
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
/** Global search categories; only conversations have an index today, the other two are entries that say so. */
type SearchCategory = "all" | "conversation" | "project" | "widget";
const categories: [SearchCategory, string][] = [
  ["all", "全部"],
  ["conversation", "对话"],
  ["project", "项目"],
  ["widget", "控件"],
];
const unprovided: Partial<Record<SearchCategory, string>> = {
  project: "项目搜索尚未提供",
  widget: "控件搜索尚未提供",
};

export function SearchDialog({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (hit: SearchHit, query: string) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<SearchCategory>("all");
  const missing = unprovided[category];
  const [offset, setOffset] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]),
    [more, setMore] = useState(false);
  const [selected, setSelected] = useState(0),
    [busy, setBusy] = useState(true),
    [opening, setOpening] = useState(false),
    [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const version = useRef(0);
  const composing = useRef(false);
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
  useEffect(() => {
    const token = ++version.current;
    if (unprovided[category]) {
      // No index exists for this category: nothing is queried and nothing is invented.
      setBusy(false);
      setHits([]);
      setMore(false);
      setSelected(0);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void window.desktop
        .search({ sequence: ++sequence, query, offset })
        .then((reply) => {
          if (!alive || version.current !== token) return;
          setBusy(false);
          if (reply.ok) {
            setHits(reply.hits);
            setMore(reply.hasMore);
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
  }, [query, offset, retry, category]);
  useEffect(() => {
    dialog.current
      ?.querySelector(`[data-search-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  function change(value: string) {
    version.current++;
    setQuery(value);
    setOffset(0);
    setHits([]);
    setMore(false);
    setSelected(0);
    setBusy(!unprovided[category]);
    setError("");
    void window.desktop.cancelSearch();
  }
  function choose(next: SearchCategory) {
    if (next === category) return;
    version.current++;
    setCategory(next);
    setOffset(0);
    setHits([]);
    setMore(false);
    setSelected(0);
    setBusy(!unprovided[next]);
    setError("");
    void window.desktop.cancelSearch();
  }
  async function open(hit: SearchHit) {
    if (opening || busy) return;
    setOpening(true);
    try {
      if (await onOpen(hit, query)) onClose();
      else setError("未能打开原对话，请重试。");
    } catch {
      setError("未能打开原对话，请重新连接后重试。");
    } finally {
      setOpening(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="search-dialog"
      aria-label="搜索对话"
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
          if (hits[selected]) void open(hits[selected]);
        }
      }}
    >
      <div className="search-input-row">
        <span aria-hidden="true">⌕</span>
        <input
          ref={input}
          aria-label="搜索标题与正文"
          placeholder="搜索对话标题或消息内容…"
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
          const index = categories.findIndex(([id]) => id === category);
          const next =
            categories[
              (index + (e.key === "ArrowRight" ? 1 : -1) + categories.length) %
                categories.length
            ][0];
          choose(next);
          e.currentTarget
            .querySelector<HTMLButtonElement>(`[data-category="${next}"]`)
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
          </button>
        ))}
      </div>
      <div className="search-group-title">
        <span>
          {missing
            ? categories.find(([id]) => id === category)![1]
            : query.trim()
              ? "匹配的对话与消息"
              : "最近对话"}
        </span>
        <span>仅搜索本机已保存内容</span>
      </div>
      {category === "all" && (
        <p className="search-scope-note">项目与控件搜索尚未提供</p>
      )}
      <div
        className="search-results"
        id="search-results"
        role="listbox"
        aria-label="搜索结果"
        aria-busy={busy}
      >
        {!busy &&
          hits.map((hit, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === selected}
              id={`search-option-${index}`}
              data-search-index={index}
              key={`${hit.conversationId}:${hit.messageId}`}
              className={`search-result ${index === selected ? "selected" : ""}`}
              disabled={opening}
              onMouseMove={() => setSelected(index)}
              onClick={() => {
                void open(hit);
              }}
            >
              <span className="search-result-icon" aria-hidden="true">
                {hit.messageId ? "☰" : "▤"}
              </span>
              <span className="search-result-body">
                <strong>
                  <Highlight text={hit.title} ranges={hit.titleRanges} />
                  {hit.archived && <span className="tag">已归档</span>}
                </strong>
                <small>
                  <Highlight text={hit.text} ranges={hit.ranges} />
                </small>
                <span className="search-result-meta">
                  {hit.messageId ? "消息" : "标题"} ·{" "}
                  {new Date(hit.updatedAt).toLocaleString("zh-CN", {
                    hour12: false,
                  })}{" "}
                  · {hit.conversationId.slice(0, 8)}
                </span>
              </span>
            </button>
          ))}
      </div>
      {busy && (
        <p className="search-empty" role="status">
          正在搜索…
        </p>
      )}
      {missing && (
        <div className="search-empty" role="status">
          <strong>{missing}</strong>
          <p>当前只搜索本机对话；这一类对象开放后再提供搜索。</p>
        </div>
      )}
      {!missing && !busy && !error && !hits.length && (
        <div className="search-empty" role="status">
          <strong>{query.trim() ? "没有找到匹配内容" : "还没有对话"}</strong>
          <p>
            {query.trim()
              ? "换一个关键词试试。草稿和附件正文不在搜索范围内。"
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
          {offset > 0 && (
            <button
              className="button small"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setOffset((n) => Math.max(0, n - 40));
              }}
            >
              上一页
            </button>
          )}
          {more && (
            <button
              className="button small"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setOffset((n) => n + 40);
              }}
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
        <p>搜索不完整时可以重建。对话和消息会保留。</p>
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
              setMessage(reply.ok ? "搜索索引已重建。" : reply.message),
            )
            .catch(() =>
              setMessage("索引未重建，请重试。原对话与消息保持不变。"),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "正在重建…" : "重建搜索索引"}
      </button>
    </div>
  );
}
