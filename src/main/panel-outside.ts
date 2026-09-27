export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export interface MouseMonitor {
  start(callback: (point: Point) => void): void;
  stop(): void;
}
function contains(rect: Rect, point: Point) {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}
/** Watches only one visible panel; stale queued clicks cannot close a later panel. */
export class PanelOutsideClicks {
  private generation = 0;
  constructor(private readonly monitor: MouseMonitor) {}
  watch(bounds: () => Rect, tray: () => Rect, dismiss: () => void) {
    this.stop();
    const generation = this.generation;
    this.monitor.start((point) => {
      if (
        generation !== this.generation ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y)
      )
        return;
      if (contains(bounds(), point) || contains(tray(), point)) return;
      this.stop();
      dismiss();
    });
  }
  stop() {
    this.generation++;
    this.monitor.stop();
  }
}
