import { useEffect, useState } from "react";
import { validGenerationMinutes } from "../shared/widget-generation";
export function WidgetGenerationSettings({
  minutes,
  connected,
}: {
  minutes: number;
  connected: boolean;
}) {
  const [value, setValue] = useState(String(minutes));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(String(minutes)), [minutes]);
  return (
    <div className="setting-row widget-wait-setting">
      <div>
        <label htmlFor="widget-generation-minutes">
          <strong>控件生成等待时间</strong>
        </label>
        <p>
          默认10分钟，可设置5至30分钟。只影响新开始的尝试；进行中的生成可单独延长，最多等待30分钟。
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="widget-wait-setting-actions">
        <input
          id="widget-generation-minutes"
          type="number"
          min={5}
          max={30}
          step={1}
          value={value}
          disabled={!connected || saving}
          onChange={(e) => setValue(e.target.value)}
        />
        <span>分钟</span>
        <button
          className="button"
          disabled={
            !connected ||
            saving ||
            !validGenerationMinutes(Number(value)) ||
            Number(value) === minutes
          }
          onClick={async () => {
            setSaving(true);
            setError("");
            try {
              const reply = await window.desktop.command({
                type: "setWidgetGenerationWait",
                minutes: Number(value),
              });
              if (!reply.ok) setError(reply.message);
            } catch {
              setError("等待时间未保存，请重试。");
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "正在保存…" : "保存"}
        </button>
      </div>
    </div>
  );
}
