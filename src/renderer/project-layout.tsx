import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ProjectColumns } from "./project-columns";
type ChatMode = "docked" | "float" | "collapsed";
export function useProjectLayout(
  projectId: string,
  columns: ProjectColumns | null,
) {
  const ref = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [mode, setMode] = useState<ChatMode>("docked");
  const lastMode = useRef<ChatMode>("docked");
  const saved = useRef<{
    open: boolean;
    takeover: boolean;
    mode: ChatMode;
    focus: HTMLElement | null;
    scroll: [HTMLElement, number, number][];
  } | null>(null);
  const shellFull = columns?.setFull;
  useEffect(() => () => shellFull?.(false), [projectId, shellFull]);
  function chatMode(next: ChatMode) {
    if (next !== "collapsed") lastMode.current = next;
    setMode(next);
  }
  function enlarge() {
    if (full) return;
    const scroll = [
      ...document.querySelectorAll<HTMLElement>(
        ".viewport, .project-chat-slot, .project-chat-scroll, .project-chat-settings, .project-chat-transcript, .project-runtime-pane, .right-body, .project-evidence pre",
      ),
    ].map((node): [HTMLElement, number, number] => [
      node,
      node.scrollTop,
      node.scrollLeft,
    ]);
    saved.current = {
      open: columns?.open ?? false,
      takeover: columns?.layout.takeover ?? false,
      mode,
      scroll,
      focus:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    };
    setMode("docked");
    columns?.setOpen(true);
    columns?.setTakeover(false);
    shellFull?.(true);
    setFull(true);
  }
  function restore() {
    const prior = saved.current;
    setFull(false);
    shellFull?.(false);
    if (prior) {
      setMode(prior.mode);
      columns?.setOpen(prior.open);
      columns?.setTakeover(prior.takeover);
    }
  }
  useLayoutEffect(() => {
    if (full) {
      document
        .querySelector<HTMLElement>(".project-restore")
        ?.focus({ preventScroll: true });
      return;
    }
    const prior = saved.current;
    if (prior)
      requestAnimationFrame(() => {
        for (const [node, top, left] of prior.scroll)
          if (node.isConnected) {
            node.scrollTop = top;
            node.scrollLeft = left;
          }
        if (prior.focus?.isConnected)
          prior.focus.focus({ preventScroll: true });
      });
  }, [full]);
  useEffect(() => {
    if (!full) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.isComposing ||
        event.defaultPrevented ||
        document.querySelector(
          'dialog[open], [role="menu"], .conversation-menu, .project-menu',
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      restore();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  });
  return {
    ref,
    full,
    mode,
    enlarge,
    restore,
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
    <aside
      className="project-chat-slot"
      data-mode={layout.full ? layout.mode : "docked"}
    >
      <div className="project-layout-controls" hidden={!layout.full}>
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
                onChange={(event) =>
                  layout.chatMode(event.target.value as ChatMode)
                }
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
      <div
        className="project-chat-content"
        hidden={layout.full && layout.mode === "collapsed"}
      >
        {children}
      </div>
    </aside>
  );
}
