import { contextBridge, ipcRenderer } from "electron";
import { widgetKey } from "../shared/widget";
import {
  parseWidgetRequest,
  validWidgetReply,
  widgetChannel,
  validWidgetViewState,
  widgetFailure,
  type WidgetBridge,
  type WidgetRequest,
  type WidgetReply,
} from "../shared/widget-runtime";
let pending = 0;
let epoch = performance.now();
let count = 0;
async function request(value: WidgetRequest): Promise<WidgetReply> {
  if (performance.now() - epoch >= 1000) {
    epoch = performance.now();
    count = 0;
  }
  if (++count > 30 || pending >= 4) return widgetFailure;
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    return widgetFailure;
  }
  if (!parseWidgetRequest(raw)) return widgetFailure;
  pending++;
  try {
    const reply: unknown = await ipcRenderer.invoke(widgetChannel, raw);
    return validWidgetReply(reply) ? reply : widgetFailure;
  } catch {
    return widgetFailure;
  } finally {
    pending--;
  }
}
const bridge: WidgetBridge = {
  readData: () => request({ method: "readData" }),
  readConfig: () => request({ method: "readConfig" }),
  readDraft: () => request({ method: "readDraft" }),
  writeData: (revision, value) =>
    request({ method: "writeData", revision, value }),
  writeDraft: (revision, field, value) =>
    request({ method: "writeDraft", revision, field, value }),
};
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("widget", bridge);
  ipcRenderer.on("widget:ping", (_event, nonce: unknown) => {
    if (typeof nonce === "string" && nonce.length === 36)
      ipcRenderer.send("widget:pong", nonce);
  });
}

if (process.isMainFrame)
  window.addEventListener("DOMContentLoaded", async () => {
    const reply = await request({ method: "readView" });
    if (!reply.ok || !validWidgetViewState(reply.value)) return;
    let revision = reply.revision,
      pending = false;
    for (const element of document.querySelectorAll("details[id]"))
      (element as HTMLDetailsElement).open = reply.value.expanded.includes(
        element.id,
      );
    window.scrollTo(reply.value.scrollX, reply.value.scrollY);
    // Remember the field without forcing focus into a newly created native view.
    let focus = reply.value.focus;
    let confirmed = JSON.stringify(reply.value);
    let timer: ReturnType<typeof setTimeout> | undefined;
    function value() {
      return {
        scrollX: Math.min(1_000_000, Math.max(0, window.scrollX)),
        scrollY: Math.min(1_000_000, Math.max(0, window.scrollY)),
        expanded: [...document.querySelectorAll("details[open][id]")]
          .map((element) => element.id)
          .filter(widgetKey)
          .slice(0, 32),
        focus,
      };
    }
    async function flush() {
      if (pending) return;
      const state = value(),
        serialized = JSON.stringify(state);
      if (serialized === confirmed) return;
      pending = true;
      const result = await request({
        method: "writeView",
        revision,
        value: state,
      });
      pending = false;
      if (result.ok) {
        revision = result.revision;
        confirmed = serialized;
        if (JSON.stringify(value()) !== confirmed) schedule();
      }
    }
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void flush();
      }, 200);
    }
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("focusin", (event) => {
      const id = (event.target as HTMLElement | null)?.id;
      focus = widgetKey(id) ? id : null;
      schedule();
    });
    document.addEventListener("toggle", schedule, true);
  });
