import type { WidgetPreview } from "./widget-store";
/**
 * The drag data type of a retained widget being reordered (WB-02). Only the host page sets it, and a widget view
 * relays drag events of this type to the host instead of handling them (mac-feature-t11:KB-04), so dropping a
 * card onto another card's native content reorders and never inserts anything into that widget.
 */
export const widgetOrderDragType = "application/x-qingluan-widget-order";
/** The status of a widget whose input another entry or instance made stale (WB-03, mac-feature-t12:OD-02 A). */
export const widgetStaleMessage =
  "数据已在另一入口改变，你的输入未保存。控件已显示最新内容。";
/** A display input a widget view relays to the host page that shows it. */
export type WidgetDisplayInput =
  | { kind: "hover" | "focus"; value: boolean }
  | { kind: "scroll"; x: number; y: number }
  | {
      kind: "drag";
      phase: "over" | "drop";
      x: number;
      y: number;
      width: number;
      height: number;
    };
export type WidgetControl = { slot?: string } & (
  | { action: "draftConfig"; field: string; revision: number; value: string }
  | {
      action:
        | "status"
        | "open"
        | "hide"
        | "recover"
        | "suspend"
        | "retry"
        | "discardConflicts";
    }
  | { action: "openGenerated"; candidateId: string }
  | {
      action: "place";
      generation: string;
      x: number;
      y: number;
      width: number;
      height: number;
      contentOnly?: boolean;
      clip?: { x: number; y: number; width: number; height: number };
    }
  | {
      action: "configure";
      draftRevisions: Record<string, number>;
      revision: number;
      value: Record<string, unknown>;
    }
);
export type WidgetUIReply =
  | {
      ok: true;
      enabled: boolean;
      preview?: WidgetPreview;
      generation?: string;
      unconfirmed?: boolean;
      /** Input another entry made stale (WB-03): kept by the host until the person discards it. */
      conflicts?: string[];
    }
  | { ok: false; message: string };
export interface WidgetSignal {
  generation: string;
  unconfirmed: boolean;
  state: "saving" | "saved" | "failed" | "conflict" | "closed" | "stopped";
  message: string;
  /** Input rejected as stale and kept by the host; present on every signal of an open instance. */
  conflicts?: string[];
}

export interface WidgetLayoutSignal {
  generation: string;
  version: string;
  widthRevision: number;
  width: number;
  height: number;
  mode: "natural" | "limited" | "unstable" | "compatibility";
  diagnostic?: string;
}
