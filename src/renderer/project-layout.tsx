import { useEffect, useRef, useState, type ReactNode } from "react";
type ChatMode = "docked" | "float" | "collapsed";
export function useProjectLayout(projectId: string) {
  const ref = useRef<HTMLDivElement>(null),
    saved = useRef<{
      viewport: HTMLElement | null;
      scroll: number;
      paneScroll: number;
      focus: HTMLElement | null;
    } | null>(null);
  const [full, setFull] = useState(false),
    [mode, setMode] = useState<ChatMode>(() => {
      const value = sessionStorage.getItem(`project-chat-layout:${projectId}`);
      return value === "float" || value === "collapsed" ? value : "docked";
    });
  const lastMode = useRef<ChatMode>(
    sessionStorage.getItem(`project-chat-last-mode:${projectId}`) === "float"
      ? "float"
      : "docked",
  );
  function chatMode(next: ChatMode) {
    if (next !== "collapsed") {
      lastMode.current = next;
      sessionStorage.setItem(`project-chat-last-mode:${projectId}`, next);
    }
    sessionStorage.setItem(`project-chat-layout:${projectId}`, next);
    setMode(next);
  }
  function enlarge() {
    const viewport = ref.current?.closest<HTMLElement>(".viewport") ?? null;
    saved.current = {
      viewport,
      scroll: viewport?.scrollTop ?? 0,
      paneScroll:
        ref.current?.querySelector(".project-runtime-pane")?.scrollTop ?? 0,
      focus:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    };
    setFull(true);
  }
  useEffect(() => {
    if (!full || !ref.current) return;
    const prior: [HTMLElement, boolean][] = [];
    let node: HTMLElement = ref.current;
    while (node.parentElement) {
      for (const other of node.parentElement.children)
        if (other !== node && other instanceof HTMLElement) {
          prior.push([other, other.inert]);
          other.inert = true;
        }
      node = node.parentElement;
      if (node === document.body) break;
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        e.stopPropagation();
        setFull(false);
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
      for (const [element, inert] of prior) element.inert = inert;
      const original = saved.current;
      requestAnimationFrame(() => {
        if (original?.viewport?.isConnected)
          original.viewport.scrollTop = original.scroll;
        const pane = ref.current?.querySelector(".project-runtime-pane");
        if (pane && original) pane.scrollTop = original.paneScroll;
        if (original?.focus?.isConnected)
          original.focus.focus({ preventScroll: true });
      });
    };
  }, [full]);
  return {
    ref,
    full,
    mode,
    enlarge,
    restore: () => setFull(false),
    chatMode,
    reopen: () => chatMode(lastMode.current),
  };
}
export function ProjectChatLayout({
  layout,
  children,
}: {
  layout: ReturnType<typeof useProjectLayout>;
  children: ReactNode;
}) {
  return (
    <aside className="project-chat-slot" data-mode={layout.mode}>
      <div className="project-layout-controls">
        {layout.mode === "collapsed" ? (
          <button className="button project-primary" onClick={layout.reopen}>
            打开项目对话
          </button>
        ) : (
          <>
            <label>
              对话布局
              <select
                aria-label="对话布局"
                value={layout.mode}
                onChange={(e) => layout.chatMode(e.target.value as ChatMode)}
              >
                <option value="docked">停靠</option>
                <option value="float">悬浮</option>
              </select>
            </label>
            <button
              className="button"
              onClick={() => layout.chatMode("collapsed")}
            >
              收起对话
            </button>
          </>
        )}
      </div>
      <div hidden={layout.mode === "collapsed"}>{children}</div>
    </aside>
  );
}
