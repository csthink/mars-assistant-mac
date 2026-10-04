import { View, type Rectangle, type WebContentsView } from "electron";

// Electron 44.2.0 creates a compositor layer for setBackgroundBlur(0), without
// applying a blur filter. Its rounded clip path is empty below 32px. Keep this
// adapter version-bound; an Electron upgrade requires native pixel validation.
// https://github.com/electron/electron/blob/v44.2.0/shell/browser/api/electron_api_view.cc
export const widgetDrawingClipElectron = "44.2.0";
const padding = 32;
const radius = 8;

export function assertWidgetDrawingClipVersion(version: string | undefined) {
  if (version !== widgetDrawingClipElectron)
    throw new Error("当前运行版本尚未验证控件显示边界，请更新应用。");
}

function valid(rect: Rectangle, positive: boolean) {
  return (
    Object.values(rect).every(Number.isSafeInteger) &&
    rect.width >= (positive ? 1 : 0) &&
    rect.height >= (positive ? 1 : 0) &&
    rect.width <= 8192 &&
    rect.height <= 4096
  );
}

/** Four large one-sided masks intersect in an exact, possibly 1px rectangle. */
export function widgetDrawingClipPlanes(rect: Rectangle): Rectangle[] {
  if (!valid(rect, false)) throw new Error("控件显示边界无效。");
  const { x, y, width, height } = rect;
  return [
    { x, y: y - padding, width: width + padding, height: height + 2 * padding },
    {
      x: x - padding,
      y: y - padding,
      width: width + padding,
      height: height + 2 * padding,
    },
    { x: x - padding, y, width: width + 2 * padding, height: height + padding },
    {
      x: x - padding,
      y: y - padding,
      width: width + 2 * padding,
      height: height + padding,
    },
  ];
}

export class WidgetDrawingClip {
  readonly root: View;
  private readonly masks: View[];
  private disposed = false;

  constructor(private readonly child: WebContentsView) {
    assertWidgetDrawingClipVersion(process.versions.electron);
    this.masks = Array.from({ length: 4 }, () => {
      const view = new View();
      view.setBounds({ x: 0, y: 0, width: 64, height: 64 });
      view.setBorderRadius(radius);
      view.setBackgroundBlur(0);
      return view;
    });
    this.root = this.masks[0];
    this.root.setVisible(false);
    for (let i = 1; i < this.masks.length; i++)
      this.masks[i - 1].addChildView(this.masks[i]);
    this.masks.at(-1)!.addChildView(child);
  }

  place(full: Rectangle, visible: Rectangle) {
    if (this.disposed || !valid(full, true) || !valid(visible, false))
      throw new Error("控件显示边界无效。");
    const x = Math.max(full.x, visible.x);
    const y = Math.max(full.y, visible.y);
    const right = Math.min(full.x + full.width, visible.x + visible.width);
    const bottom = Math.min(full.y + full.height, visible.y + visible.height);
    const rect = {
      x,
      y,
      width: Math.max(0, right - x),
      height: Math.max(0, bottom - y),
    };
    const planes = widgetDrawingClipPlanes(rect);
    let parent = { x: 0, y: 0 };
    for (let i = 0; i < planes.length; i++) {
      const plane = planes[i];
      this.masks[i].setBounds({
        ...plane,
        x: plane.x - parent.x,
        y: plane.y - parent.y,
      });
      parent = plane;
    }
    // The complete document viewport stays unchanged, including when fully clipped.
    this.child.setBounds({
      ...full,
      x: full.x - parent.x,
      y: full.y - parent.y,
    });
    const shown = rect.width > 0 && rect.height > 0;
    this.child.setVisible(shown);
    this.root.setVisible(shown);
    return rect;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.root.setVisible(false);
    this.masks.at(-1)!.removeChildView(this.child);
    for (let i = this.masks.length - 1; i > 0; i--)
      this.masks[i - 1].removeChildView(this.masks[i]);
  }
}
