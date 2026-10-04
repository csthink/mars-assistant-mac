import { useCallback, useEffect, useRef, useState } from "react";
import type { WidgetControl, WidgetLayoutSignal } from "../shared/widget-ui";
import type { WidgetPreview } from "../shared/widget-store";
import "./widgets.css";

export function WidgetWorkspace({
  occluded,
  connected,
  candidateId,
  retained = false,
  onUnconfirmed,
  slot,
  contentOnly = false,
}: {
  occluded: boolean;
  connected: boolean;
  candidateId?: string;
  retained?: boolean;
  slot?: string;
  contentOnly?: boolean;
  onUnconfirmed?: (value: boolean) => void;
}) {
  const control = useCallback(
    (command: WidgetControl) =>
      window.desktop.widgetControl({ ...command, ...(slot ? { slot } : {}) }),
    [slot],
  );
  const [preview, setPreview] = useState<WidgetPreview>();
  const [generation, setGeneration] = useState<string>();
  const [wanted, setWanted] = useState(!!candidateId);
  const [settings, setSettings] = useState(false);
  const [visible, setVisible] = useState(true);
  const [layout, setLayout] = useState<WidgetLayoutSignal>();

  const ownerVisible = useRef(true);
  const [ownerVisibilityRevision, reviseOwnerVisibility] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    "关闭预览后，再次打开会读取已确认内容。",
  );
  const [failed, setFailed] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const drafts = useRef<
    Record<
      string,
      {
        text: string;
        confirmed: string | undefined;
        revision: number;
        saving: boolean;
        error: boolean;
      }
    >
  >({});
  const [, renderDrafts] = useState(0);
  const refreshDrafts = () => renderDrafts((n) => n + 1);
  function acceptDrafts(preview: WidgetPreview) {
    drafts.current = Object.fromEntries(
      preview.definition.config.map((field) => {
        const saved = preview.configDrafts[field.id];
        const text = saved?.text ?? String(preview.config[field.id]);
        return [
          field.id,
          {
            text,
            confirmed: saved?.unconfirmed ? undefined : text,
            revision: saved?.revision ?? 0,
            saving: false,
            error: saved?.unconfirmed === true,
          },
        ];
      }),
    );
    refreshDrafts();
  }
  async function flushDraft(field: string) {
    const draft = drafts.current[field];
    if (!draft || draft.saving || draft.error) return;
    draft.saving = true;
    let remaining = unconfirmed;
    refreshDrafts();
    while (draft.text !== draft.confirmed && !draft.error) {
      const text = draft.text;
      const reply = await control({
        action: "draftConfig",
        field,
        revision: draft.revision,
        value: text,
      });
      if (drafts.current[field] !== draft) return;
      if (!reply.ok || !reply.preview) {
        draft.error = true;
        setFailed(true);
        setUnconfirmed(true);
        setMessage(reply.ok ? "设置草稿未确认保存。" : reply.message);
        break;
      }
      remaining = !!reply.unconfirmed;
      draft.revision = reply.preview.configDrafts[field].revision;
      draft.confirmed = text;
      setPreview(reply.preview);
    }
    draft.saving = false;
    refreshDrafts();
    if (!draft.error) {
      setFailed(false);
      setUnconfirmed(remaining);
      setMessage("设置草稿已确认保存，尚未应用到控件。");
    }
  }
  function editDraft(field: string, text: string) {
    drafts.current[field].text = text;
    drafts.current[field].error = false;
    refreshDrafts();
    void flushDraft(field);
  }
  const draftPending = Object.values(drafts.current).some(
    (draft) => draft.saving || draft.error || draft.text !== draft.confirmed,
  );
  useEffect(() => {
    onUnconfirmed?.(unconfirmed || draftPending);
  }, [unconfirmed, draftPending, onUnconfirmed]);
  const frame = useRef<HTMLDivElement>(null);
  const current = useRef<string | undefined>(undefined);
  const opening = useRef(false);
  const serial = useRef(0);
  const latest = useRef({ wanted, settings, occluded });
  latest.current = { wanted, settings, occluded };
  async function open() {
    if (opening.current || !connected || !ownerVisible.current) return;
    const id = ++serial.current;
    opening.current = true;
    setBusy(true);
    setFailed(false);
    const reply = await control(
      candidateId
        ? { action: "openGenerated", candidateId }
        : { action: "open" },
    );
    if (id !== serial.current) return;
    opening.current = false;
    setBusy(false);
    if (!reply.ok) {
      setMessage(reply.message);
      setFailed(true);
      return;
    }
    if (!reply.generation || !reply.preview) return;
    setLayout(undefined);
    current.current = reply.generation;
    setGeneration(reply.generation);
    setPreview(reply.preview);
    acceptDrafts(reply.preview);
    setUnconfirmed(!!reply.unconfirmed);
    setFailed(!!reply.unconfirmed);
    setMessage(
      reply.unconfirmed
        ? "已恢复未确认输入，请先核对保存状态。"
        : "已读取上次确认的内容",
    );
  }
  function hide() {
    serial.current++;
    opening.current = false;
    setBusy(false);
    window.desktop.widgetOcclude(slot ?? "default");
    current.current = undefined;
    setGeneration(undefined);
  }
  useEffect(() => {
    const offLayout = window.desktop.onWidgetLayout((signal) => {
      if (signal.generation !== current.current) return;
      // Preserve the first currently visible widget when an earlier row grows.
      const viewport = frame.current?.closest(".viewport, .right-body");
      const top = viewport?.getBoundingClientRect().top ?? 0;
      const anchor =
        viewport &&
        [...viewport.querySelectorAll<HTMLElement>(".widget-frame")].find(
          (node) => node.getBoundingClientRect().bottom > top,
        );
      const before = anchor?.getBoundingClientRect().top;
      setLayout(signal);
      requestAnimationFrame(() =>
        window.dispatchEvent(new Event("widget-display-change")),
      );
      if (anchor && viewport && before !== undefined)
        requestAnimationFrame(() => {
          const delta = anchor.getBoundingClientRect().top - before;
          if (Math.abs(delta) >= 1) viewport.scrollTop += delta;
        });
    });
    const offInput = window.desktop.onWidgetDisplayInput((signal) => {
      if (signal.generation !== current.current) return;
      const element = frame.current;
      if (signal.kind === "scroll")
        element
          ?.closest(".viewport, .right-body")
          ?.scrollBy(signal.x, signal.y);
      else {
        const article = element?.closest<HTMLElement>(".widget-saved-card");
        if (article) {
          if (signal.kind === "hover")
            article.dataset.nativeHover = String(signal.value);
          else article.dataset.nativeFocus = String(signal.value);
        }
        window.dispatchEvent(new Event("widget-display-change"));
      }
    });
    const off = window.desktop.onWidgetStatus((signal) => {
      if (signal.generation !== current.current) return;
      setMessage(signal.message);
      setUnconfirmed(signal.unconfirmed);
      setFailed(signal.state === "failed" || signal.state === "stopped");
      if (signal.state === "closed" || signal.state === "stopped") {
        current.current = undefined;
        setGeneration(undefined);
      }
      if (signal.state === "stopped") setWanted(false);
    });
    const offVisibility = window.desktop.onWidgetVisibility((shown) => {
      ownerVisible.current = shown;
      // Hidden renderers may suspend animation frames and coalesce visibility changes.
      // Revoke immediately and preserve a transition even after a rapid hide/show pair.
      if (!shown) hide();
      reviseOwnerVisibility((revision) => revision + 1);
    });
    return () => {
      off();
      offLayout();
      offInput();
      offVisibility();
      serial.current++;
      window.desktop.widgetOcclude(slot ?? "default");
    };
  }, []);
  useEffect(() => {
    if (
      wanted &&
      !settings &&
      !occluded &&
      (retained || visible) &&
      ownerVisible.current
    ) {
      if (!current.current) void open();
    } else hide();
    // These transitions are the trusted visibility contract, not widget messages.
  }, [wanted, settings, occluded, visible, retained, ownerVisibilityRevision]);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let scheduled = 0;
    function measure() {
      scheduled = 0;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const viewport = (
        element.closest(".viewport, .right-body") ?? element.parentElement!
      ).getBoundingClientRect();
      const article = element.closest<HTMLElement>(".widget-saved-card");
      const controls = article?.querySelector<HTMLElement>(
        ".widget-formal-controls",
      );
      const overlay =
        !contentOnly &&
        controls &&
        (article?.matches(":hover, :focus-within") ||
          article?.dataset.nativeHover === "true" ||
          article?.dataset.nativeFocus === "true")
          ? controls.getBoundingClientRect().bottom
          : bounds.top;
      const x = bounds.left + element.clientLeft,
        y = bounds.top + element.clientTop;
      const width = element.clientWidth,
        height = element.clientHeight;
      const clipX = Math.max(x, viewport.left),
        clipY = Math.max(y, viewport.top, overlay);
      const clipWidth = Math.max(
        0,
        Math.min(x + width, viewport.right) - clipX,
      );
      const clipHeight = Math.max(
        0,
        Math.min(y + height, viewport.bottom) - clipY,
      );
      const shown = clipWidth >= 1 && clipHeight >= 1 && !document.hidden;
      setVisible(shown);
      if (retained && !shown && current.current)
        void control({ action: "suspend" });
      if (
        current.current &&
        !latest.current.occluded &&
        !latest.current.settings
      )
        void control({
          action: "place",
          generation: current.current,
          x,
          y,
          width,
          height,
          contentOnly,
          clip: { x: clipX, y: clipY, width: clipWidth, height: clipHeight },
        });
    }

    function schedule() {
      if (!scheduled) scheduled = requestAnimationFrame(measure);
    }
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    window.addEventListener("widget-display-change", schedule);
    const article = element.closest(".widget-saved-card");
    for (const event of ["pointerenter", "pointerleave", "focusin", "focusout"])
      article?.addEventListener(event, schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(scheduled);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("widget-display-change", schedule);
      for (const event of [
        "pointerenter",
        "pointerleave",
        "focusin",
        "focusout",
      ])
        article?.removeEventListener(event, schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [generation, settings, contentOnly]);
  async function save() {
    if (!preview || busy || draftPending) return;
    setBusy(true);
    const reply = await control({
      action: "configure",
      revision: preview.configRevision,
      draftRevisions: Object.fromEntries(
        Object.entries(drafts.current).map(([id, draft]) => [
          id,
          draft.revision,
        ]),
      ),
      value: Object.fromEntries(
        preview.definition.config.map((field) => {
          const text = drafts.current[field.id].text;
          return [
            field.id,
            field.type === "boolean"
              ? text === "true"
              : field.type === "number"
                ? text.trim() && Number.isFinite(Number(text))
                  ? Number(text)
                  : null
                : text,
          ];
        }),
      ),
    });
    setBusy(false);
    if (!reply.ok) {
      setFailed(true);
      setMessage(reply.message);
      return;
    }
    setPreview(reply.preview);
    setSettings(false);
    setFailed(false);
    setMessage("设置已保存");
  }
  return (
    <section
      className={`widget-shell ${retained ? "widget-retained" : ""} ${contentOnly ? "widget-content-only" : ""}`}
      data-widget-shell
      aria-label={candidateId ? "控件预览" : "测试候选预览"}
    >
      <div className="widget-heading">
        <div>
          <h2>
            {candidateId
              ? (preview?.definition.name ?? "控件预览")
              : "本地便笺"}{" "}
            <span className="widget-source">
              {candidateId ? (retained ? "已保留" : "候选预览") : "测试候选"}
            </span>
          </h2>
          <p>
            {candidateId
              ? retained
                ? "配置和输入按此控件身份保存。"
                : "检查实际效果后，再决定是否保留。"
              : "本地验收内容，尚未接入模型生成。"}
          </p>
        </div>
        <div className="widget-actions">
          {!!preview?.definition.config.length && (
            <button
              className="button"
              onClick={() => {
                hide();
                setSettings(!settings);
              }}
            >
              设置
            </button>
          )}
          {(wanted || settings) && (
            <button
              className="button"
              onClick={() => {
                hide();
                setWanted(false);
                setSettings(false);
              }}
            >
              关闭预览
            </button>
          )}
        </div>
      </div>
      <p className="widget-scope">
        {retained
          ? "配置、数据与草稿按此控件身份保存。"
          : "仅保存本候选的数据与草稿，无法访问网络或本机文件。"}
      </p>
      {unconfirmed && (
        <button
          className="button"
          onClick={async () => {
            const reply = await control({
              action: "recover",
            });
            if (!reply.ok) {
              setMessage(reply.message);
              return;
            }
            setUnconfirmed(false);
            hide();
            setSettings(false);
            setWanted(true);
            void open();
          }}
        >
          放弃未确认输入并重读
        </button>
      )}
      {settings ? (
        <form
          className="widget-settings"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {preview?.definition.config.map((field) => (
            <div className="widget-config-field" key={field.id}>
              <label htmlFor={`widget-${slot ?? "default"}-${field.id}`}>
                {field.label}
              </label>
              {field.type === "boolean" ? (
                <input
                  id={`widget-${slot ?? "default"}-${field.id}`}
                  type="checkbox"
                  checked={drafts.current[field.id]?.text === "true"}
                  onChange={(event) =>
                    editDraft(field.id, String(event.target.checked))
                  }
                />
              ) : (
                <input
                  id={`widget-${slot ?? "default"}-${field.id}`}
                  value={drafts.current[field.id]?.text ?? ""}
                  inputMode={field.type === "number" ? "decimal" : "text"}
                  maxLength={4096}
                  onChange={(event) => editDraft(field.id, event.target.value)}
                />
              )}
            </div>
          ))}
          <p>输入会保存为草稿；点击保存设置后才应用到控件。</p>
          <div className="widget-actions">
            <button
              className="button primary"
              disabled={busy || !connected || draftPending}
            >
              保存设置
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setSettings(false)}
            >
              返回预览
            </button>
          </div>
        </form>
      ) : (
        <div
          className="widget-frame"
          ref={frame}
          style={{ height: layout?.height ?? 240 }}
          data-height-mode={layout?.mode ?? "loading"}
        >
          {!generation && (
            <div className="widget-placeholder">
              <p>
                {busy
                  ? candidateId
                    ? "正在载入控件…"
                    : "正在载入测试候选…"
                  : preview
                    ? "预览已收起"
                    : candidateId
                      ? "打开候选，检查实际效果。"
                      : "打开便笺，试试输入、保存和重新打开。"}
              </p>
              <button
                className="button primary"
                disabled={busy || !connected}
                onClick={() => {
                  setWanted(true);
                  if (wanted) void open();
                }}
              >
                {preview
                  ? "重新打开预览"
                  : candidateId
                    ? "打开控件预览"
                    : "载入测试候选"}
              </button>
            </div>
          )}
        </div>
      )}
      {generation && !layout && (
        <p className="widget-layout-diagnostic" role="status">
          正在调整内容尺寸…
        </p>
      )}
      {layout?.diagnostic && (
        <p className="widget-layout-diagnostic" role="status">
          {
            (
              {
                "height-limit": "内容超过显示上限，可在控件内滚动查看。",
                "unstable-height": "内容高度持续变化，已使用有界滚动布局。",
                "internal-clipping":
                  "控件自身固定尺寸隐藏了部分内容，可通过修改控件调整。原内容保持不变。",
                "viewport-layout":
                  "控件使用随视口变化的高度，已使用有界布局；可滚动查看，或修改控件采用自然高度。",
                "content-width":
                  "控件内部宽度超过可用空间，可水平滚动；若内部隐藏内容，请修改控件。",
                "measurement-timeout":
                  "暂时无法测量内容，已使用有界滚动布局；可重新打开控件。",
                "measurement-limit":
                  "内容结构超出测量限制，已使用有界滚动布局。",
              } as Record<string, string>
            )[layout.diagnostic]
          }
        </p>
      )}
      <p
        className={`widget-save-status ${failed ? "error" : ""}`}
        role={failed ? "alert" : "status"}
      >
        {message}
      </p>
    </section>
  );
}
