import { useEffect, useRef, useState } from "react";
import type { WidgetPreview } from "../shared/widget-store";
import "./widgets.css";

export function WidgetWorkspace({
  occluded,
  connected,
}: {
  occluded: boolean;
  connected: boolean;
}) {
  const [preview, setPreview] = useState<WidgetPreview>();
  const [generation, setGeneration] = useState<string>();
  const [wanted, setWanted] = useState(false);
  const [settings, setSettings] = useState(false);
  const [visible, setVisible] = useState(true);
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
      const reply = await window.desktop.widgetControl({
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
  const frame = useRef<HTMLDivElement>(null);
  const current = useRef<string | undefined>(undefined);
  const opening = useRef(false);
  const serial = useRef(0);
  const latest = useRef({ wanted, settings, occluded, visible });
  latest.current = { wanted, settings, occluded, visible };
  async function open() {
    if (opening.current || !connected) return;
    const id = ++serial.current;
    opening.current = true;
    setBusy(true);
    setFailed(false);
    const reply = await window.desktop.widgetControl({ action: "open" });
    if (id !== serial.current) return;
    opening.current = false;
    setBusy(false);
    if (!reply.ok) {
      setMessage(reply.message);
      setFailed(true);
      return;
    }
    if (!reply.generation || !reply.preview) return;
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
    window.desktop.widgetOcclude();
    current.current = undefined;
    setGeneration(undefined);
  }
  useEffect(() => {
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
    return () => {
      off();
      serial.current++;
      window.desktop.widgetOcclude();
    };
  }, []);
  useEffect(() => {
    if (wanted && !settings && !occluded && visible) void open();
    else hide();
    // These transitions are the trusted visibility contract, not widget messages.
  }, [wanted, settings, occluded, visible]);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let scheduled = 0;
    function measure() {
      scheduled = 0;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const viewport = element.closest(".viewport")!.getBoundingClientRect();
      const x = Math.max(bounds.left, viewport.left),
        y = Math.max(bounds.top, viewport.top);
      const width = Math.min(bounds.right, viewport.right) - x;
      const height = Math.min(bounds.bottom, viewport.bottom) - y;
      const shown = width >= 40 && height >= 40 && !document.hidden;
      setVisible(shown);
      if (
        shown &&
        current.current &&
        !latest.current.occluded &&
        !latest.current.settings
      )
        void window.desktop.widgetControl({
          action: "place",
          generation: current.current,
          x,
          y,
          width,
          height,
        });
    }
    function schedule() {
      if (!scheduled) scheduled = requestAnimationFrame(measure);
    }
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(scheduled);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [generation, settings]);
  async function save() {
    if (!preview || busy || draftPending) return;
    setBusy(true);
    const reply = await window.desktop.widgetControl({
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
      className="widget-shell"
      data-widget-shell
      aria-label="测试候选预览"
    >
      <div className="widget-heading">
        <div>
          <h2>
            本地便笺 <span className="widget-source">测试候选</span>
          </h2>
          <p>本地验收内容，尚未接入模型生成。</p>
        </div>
        <div className="widget-actions">
          {preview && (
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
        仅保存本候选的数据与草稿，无法访问网络或本机文件。
      </p>
      {unconfirmed && (
        <button
          className="button"
          onClick={async () => {
            const reply = await window.desktop.widgetControl({
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
              <label htmlFor={`widget-${field.id}`}>{field.label}</label>
              {field.type === "boolean" ? (
                <input
                  id={`widget-${field.id}`}
                  type="checkbox"
                  checked={drafts.current[field.id]?.text === "true"}
                  onChange={(event) =>
                    editDraft(field.id, String(event.target.checked))
                  }
                />
              ) : (
                <input
                  id={`widget-${field.id}`}
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
        <div className="widget-frame" ref={frame}>
          {!generation && (
            <div className="widget-placeholder">
              <p>
                {busy
                  ? "正在载入测试候选…"
                  : preview
                    ? "预览已收起"
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
                {preview ? "重新打开预览" : "载入测试候选"}
              </button>
            </div>
          )}
        </div>
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
