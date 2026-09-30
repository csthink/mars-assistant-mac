import { createPortal } from "react-dom";
import { useEffect, type ReactNode } from "react";
import { useProjectColumns } from "./project-columns";
import { RightPanel } from "./main-shell";

/** Read-only contextual content shares the window's existing column and focus controls. */
export function RecordPanel({
  title,
  children,
  available = true,
}: {
  title: string;
  children: ReactNode;
  available?: boolean;
}) {
  const columns = useProjectColumns();
  const setAvailable = columns?.setAvailable;
  useEffect(() => {
    setAvailable?.(available);
    return () => setAvailable?.(false);
  }, [available, setAvailable]);
  if (!available) return null;
  if (!columns) return <aside aria-label={title}>{children}</aside>;
  return columns.host && columns.open
    ? createPortal(
        <RightPanel
          owner={title}
          tabs={[{ id: "context", name: title, icon: "file", body: children }]}
          layout={columns.layout}
          width={columns.layout.right}
          panelRef={columns.panelRef}
          takeoverButton={columns.takeoverRef}
          onWidth={columns.width}
          onPreview={columns.preview}
          onTakeover={() => columns.setTakeover(!columns.layout.takeover)}
          onClose={columns.close}
        />,
        columns.host,
      )
    : null;
}

export function RecordPagination({
  page,
  size,
  total,
  sizes,
  change,
}: {
  page: number;
  size: number;
  total: number;
  sizes: number[];
  change: (page: number, size: number) => void;
}) {
  const count = Math.max(1, Math.ceil(total / size));
  return (
    <nav className="record-pagination" aria-label="列表分页">
      <label>
        每页{" "}
        <select
          aria-label="每页数量"
          value={size}
          onChange={(e) => change(0, Number(e.target.value))}
        >
          {sizes.map((n) => (
            <option key={n} value={n}>
              {n} 项
            </option>
          ))}
        </select>
      </label>
      <span>
        第 {Math.min(page + 1, count)} / {count} 页 · {total} 项
      </span>
      <button
        className="button"
        disabled={page === 0}
        onClick={() => change(page - 1, size)}
      >
        上一页
      </button>
      <button
        className="button"
        disabled={page + 1 >= count}
        onClick={() => change(page + 1, size)}
      >
        下一页
      </button>
    </nav>
  );
}
