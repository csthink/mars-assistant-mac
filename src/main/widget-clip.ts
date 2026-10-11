import type { Rectangle } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";

export interface NativeWidgetClip {
  beginAttach(window: Buffer): object;
  finishAttach(binding: object): void;
  place(
    binding: object,
    rectangle: Rectangle,
    visible: boolean,
    full?: Rectangle,
  ): void;
  dispose(binding: object): void;
}
/** Only the trusted main process owns native handles; none cross a renderer bridge. */
export const nativeWidgetClip: NativeWidgetClip | undefined =
  process.platform === "darwin"
    ? createRequire(__filename)(join(__dirname, "widget-clip.node"))
    : undefined;
