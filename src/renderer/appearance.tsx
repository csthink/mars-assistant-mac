import { useEffect, useState } from "react";
import type { Appearance } from "../shared/protocol";
const systemDark = () =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;
/**
 * The page appearance before the saved choice arrives: the main process sets the native theme from the
 * saved choice before the page loads, so the colour scheme the page sees already is that choice (or the
 * system appearance for automatic). The first frame takes it instead of a fixed light page.
 */
export function applyInitialAppearance() {
  document.documentElement.dataset.theme = systemDark() ? "dark" : "light";
}
/** Until the saved choice is known the page follows the native theme, as in automatic. */
export function useAppearance(appearance: Appearance = "auto") {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        appearance === "auto" ? (media.matches ? "dark" : "light") : appearance;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance]);
}
export function AppearanceSettings({
  value,
  connected,
}: {
  value: Appearance;
  connected: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <div className="setting-row">
        <div>
          <strong>外观</strong>
          <p>自动模式跟随这台 Mac 的系统外观。</p>
        </div>
        <div className="appearance-control" role="group" aria-label="外观">
          {(
            [
              ["light", "浅色"],
              ["dark", "深色"],
              ["auto", "自动"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              aria-pressed={value === mode}
              disabled={!connected || busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const reply = await window.desktop.command({
                    type: "setAppearance",
                    appearance: mode,
                  });
                  if (!reply.ok) setError(reply.message);
                } catch {
                  setError("外观未保存，请重试。");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </>
  );
}
