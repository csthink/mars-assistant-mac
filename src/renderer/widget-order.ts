import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../shared/protocol";
import type { SavedWidget } from "../shared/widget-generation";

export type OrderNotice =
  | { kind: "saving" }
  | { kind: "saved"; text: string }
  | { kind: "failed"; text: string; retry?: Move }
  | { kind: "conflict"; text: string };
interface Move {
  widgetId: string;
  toIndex: number;
}

/**
 * WB-02 ordering of the retained widgets of one entry. A move shows at once (optimistic), then commits through the
 * business service with the order revision this entry last saw confirmed. Moves of this entry are sent one after
 * another, so a second move never conflicts with the first. A refused or failed commit drops every pending move and
 * the view returns to the business service's current order; nothing is replayed automatically.
 */
export function useWidgetOrder(snapshot: Snapshot | undefined) {
  const committed = snapshot?.widgetGeneration?.widgets ?? [];
  const [pending, setPending] = useState<string[]>();
  const [notice, setNotice] = useState<OrderNotice>();
  const queue = useRef<Move[]>([]);
  const running = useRef(false);
  const revision = useRef(snapshot?.widgetGeneration?.orderRevision ?? 0);
  const latest = useRef(revision.current);
  latest.current = snapshot?.widgetGeneration?.orderRevision ?? 0;
  useEffect(() => {
    if (!running.current)
      revision.current = snapshot?.widgetGeneration?.orderRevision ?? 0;
  }, [snapshot?.widgetGeneration?.orderRevision]);
  const byId = new Map(committed.map((w) => [w.id, w]));
  const widgets: SavedWidget[] = pending
    ? pending.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
    : committed;
  async function drain() {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const move = queue.current[0];
        let reply;
        try {
          reply = await window.desktop.command({
            type: "moveWidget",
            widgetId: move.widgetId,
            toIndex: move.toIndex,
            orderRevision: revision.current,
          });
        } catch {
          reply = {
            ok: false as const,
            code: "UNAVAILABLE" as const,
            message: "本地数据未连接。",
          };
        }
        if (!reply.ok) {
          queue.current = [];
          // The service published its current order with the refusal; later moves start from that revision.
          revision.current = Math.max(revision.current, latest.current);
          setPending(undefined);
          const name = byId.get(move.widgetId)?.name ?? "控件";
          setNotice(
            reply.code === "CONFLICT"
              ? {
                  kind: "conflict",
                  text: `顺序已在另一入口更新，「${name}」的移动未应用，已显示最新顺序。`,
                }
              : {
                  kind: "failed",
                  // Write and connection failures say what to check; refusals carry the service's own reason.
                  text:
                    reply.code === "WRITE_FAILED" ||
                    reply.code === "UNAVAILABLE"
                      ? "顺序未保存，已恢复为上次保存的顺序。请检查本地数据连接与磁盘空间后重试。"
                      : `顺序未保存：${reply.message}已恢复为上次保存的顺序。`,
                  retry:
                    reply.code === "WRITE_FAILED" ||
                    reply.code === "UNAVAILABLE"
                      ? move
                      : undefined,
                },
          );
          return;
        }
        revision.current =
          reply.snapshot.widgetGeneration?.orderRevision ?? revision.current;
        queue.current.shift();
        if (!queue.current.length) {
          const saved = reply.snapshot.widgetGeneration?.widgets ?? [];
          const at = saved.findIndex((w) => w.id === move.widgetId);
          setPending(undefined);
          setNotice({
            kind: "saved",
            text: `「${saved[at]?.name ?? "控件"}」已移到第 ${at + 1} 位`,
          });
        }
      }
    } finally {
      running.current = false;
    }
  }
  function move(widgetId: string, toIndex: number) {
    const ids = widgets.map((w) => w.id);
    const from = ids.indexOf(widgetId);
    if (from < 0 || toIndex < 0 || toIndex >= ids.length || from === toIndex)
      return;
    ids.splice(from, 1);
    ids.splice(toIndex, 0, widgetId);
    setPending(ids);
    setNotice({ kind: "saving" });
    queue.current.push({ widgetId, toIndex });
    void drain();
  }
  function retry() {
    if (notice?.kind !== "failed" || !notice.retry) return;
    const { widgetId, toIndex } = notice.retry;
    const count = committed.length;
    move(widgetId, Math.min(toIndex, count - 1));
  }
  return {
    widgets,
    notice,
    saving: !!pending,
    move,
    retry,
    dismiss: () => setNotice(undefined),
  };
}
