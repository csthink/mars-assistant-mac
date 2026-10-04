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

// Display measurement stays in the isolated preload world, outside window.widget.
if (process.isMainFrame) {
  let layout:
    | {
        generation: string;
        version: string;
        widthRevision: number;
        width: number;
      }
    | undefined;
  let scheduled = 0;
  let observer: ResizeObserver | undefined;
  let limited = false;
  const viewportRoots = new Set<Element>();
  function scan() {
    const nodes = [...document.querySelectorAll<HTMLElement>("body, body *")];
    limited = nodes.length > 2048;
    observer?.disconnect();
    for (const node of nodes.slice(0, 2048)) observer?.observe(node);
    viewportRoots.clear();
    // Detect viewport-dependent heights from declarations, not resolved px values.
    function declarations(element: Element, style: CSSStyleDeclaration) {
      if (
        [style.height, style.minHeight, style.maxHeight].some((v) =>
          /(?:vh|dvh|svh|lvh|%)/.test(v),
        )
      )
        viewportRoots.add(element);
    }
    for (const element of nodes.slice(0, 2048))
      declarations(element, element.style);
    for (const sheet of [...document.styleSheets]) {
      try {
        for (const rule of [...sheet.cssRules]) {
          if (!(rule instanceof CSSStyleRule)) continue;
          if (
            ![
              rule.style.height,
              rule.style.minHeight,
              rule.style.maxHeight,
            ].some((v) => /(?:vh|dvh|svh|lvh|%)/.test(v))
          )
            continue;
          for (const element of document.querySelectorAll(rule.selectorText))
            viewportRoots.add(element);
        }
      } catch {
        /* A denied sheet never grants measurement authority. */
      }
    }
  }
  function measure() {
    scheduled = 0;
    if (!layout || !document.body || Math.abs(innerWidth - layout.width) >= 1)
      return;
    const body = document.body;
    const bodyStyle = getComputedStyle(body);
    let height =
      body.offsetHeight +
      (parseFloat(bodyStyle.marginTop) || 0) +
      (parseFloat(bodyStyle.marginBottom) || 0);
    let diagnostic = limited
      ? "measurement-limit"
      : viewportRoots.size
        ? "viewport-layout"
        : "";
    for (const node of [
      ...document.querySelectorAll<HTMLElement>("body *"),
    ].slice(0, 2048)) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.position === "fixed") continue;
      // offset geometry excludes transforms, so paint-only animations do not resize the host.
      let top = 0,
        current: HTMLElement | null = node;
      while (current) {
        top += current.offsetTop;
        current = current.offsetParent as HTMLElement | null;
      }
      if (
        !diagnostic &&
        ["hidden", "clip"].includes(style.overflowY) &&
        node.scrollHeight > node.clientHeight + 1
      )
        diagnostic = "internal-clipping";
      if (
        !diagnostic &&
        node.scrollWidth > node.clientWidth + 1 &&
        ["hidden", "clip"].includes(style.overflowX)
      )
        diagnostic = "content-width";
      height = Math.max(
        height,
        top + node.offsetHeight + (parseFloat(style.marginBottom) || 0),
      );
    }
    if (
      !diagnostic &&
      ["hidden", "clip"].includes(bodyStyle.overflowY) &&
      body.scrollHeight > body.clientHeight + 1
    )
      diagnostic = "internal-clipping";
    if (!diagnostic && body.scrollWidth > innerWidth + 1)
      diagnostic = "content-width";
    ipcRenderer.send("widget:measure", { ...layout, height, diagnostic });
  }
  function schedule() {
    if (!scheduled) scheduled = requestAnimationFrame(measure);
  }
  ipcRenderer.on("widget:layout", (_event, next: typeof layout) => {
    if (!next) return;
    layout = {
      generation: next.generation,
      version: next.version,
      widthRevision: next.widthRevision,
      width: next.width,
    };
    schedule();
  });
  window.addEventListener("DOMContentLoaded", () => {
    observer = new ResizeObserver(schedule);
    scan();
    new MutationObserver(() => {
      scan();
      schedule();
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    document.fonts.addEventListener("loadingdone", schedule);
    void document.fonts.ready.then(schedule);
    document.addEventListener("load", schedule, true);
    window.addEventListener("resize", schedule);
    document.addEventListener("toggle", schedule, true);
    document.addEventListener("pointerenter", () =>
      ipcRenderer.send("widget:display-input", { kind: "hover", value: true }),
    );
    document.addEventListener("focusin", () =>
      ipcRenderer.send("widget:display-input", { kind: "focus", value: true }),
    );
    document.addEventListener("focusout", (event) => {
      if (!event.relatedTarget)
        ipcRenderer.send("widget:display-input", {
          kind: "focus",
          value: false,
        });
    });
    window.addEventListener("blur", () =>
      ipcRenderer.send("widget:display-input", { kind: "focus", value: false }),
    );
    document.addEventListener("pointerleave", () =>
      ipcRenderer.send("widget:display-input", { kind: "hover", value: false }),
    );
    function canScroll(target: EventTarget | null, dy: number) {
      for (
        let element = target instanceof Element ? target : null;
        element;
        element = element.parentElement
      ) {
        const style = getComputedStyle(element);
        if (
          ["auto", "scroll"].includes(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 1 &&
          (dy < 0
            ? element.scrollTop > 0
            : element.scrollTop + element.clientHeight <
              element.scrollHeight - 1)
        )
          return true;
      }
      const doc = document.scrollingElement;
      return (
        !!doc &&
        doc.scrollHeight > innerHeight + 1 &&
        (dy < 0
          ? doc.scrollTop > 0
          : doc.scrollTop + innerHeight < doc.scrollHeight - 1)
      );
    }
    document.addEventListener(
      "wheel",
      (event) => {
        if (event.ctrlKey || canScroll(event.target, event.deltaY)) return;
        event.preventDefault();
        const scale =
          event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
        ipcRenderer.send("widget:display-input", {
          kind: "scroll",
          x: event.deltaX * scale,
          y: event.deltaY * scale,
        });
      },
      { passive: false },
    );
    document.addEventListener("keydown", (event) => {
      if (
        (event.target as HTMLElement)?.closest(
          "input,textarea,select,[contenteditable=true]",
        )
      )
        return;
      const dy =
        event.key === "PageDown"
          ? innerHeight * 0.8
          : event.key === "PageUp"
            ? -innerHeight * 0.8
            : event.key === "ArrowDown"
              ? 40
              : event.key === "ArrowUp"
                ? -40
                : 0;
      if (!dy || canScroll(event.target, dy)) return;
      event.preventDefault();
      ipcRenderer.send("widget:display-input", { kind: "scroll", x: 0, y: dy });
    });
    schedule();
  });
}
