import type { WidgetPreview } from "./widget-store";
export type WidgetControl =
  | { action: "draftConfig"; field: string; revision: number; value: string }
  | { action: "status" | "open" | "hide" | "recover" }
  | {
      action: "place";
      generation: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | {
      action: "configure";
      draftRevisions: Record<string, number>;
      revision: number;
      value: Record<string, unknown>;
    };
export type WidgetUIReply =
  | {
      ok: true;
      enabled: boolean;
      preview?: WidgetPreview;
      generation?: string;
      unconfirmed?: boolean;
    }
  | { ok: false; message: string };
export interface WidgetSignal {
  generation: string;
  unconfirmed: boolean;
  state: "saving" | "saved" | "failed" | "closed" | "stopped";
  message: string;
}
