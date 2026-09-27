import { useState } from "react";
import {
  imageInputLabels,
  terminalStates,
  stateLabels,
  type Connection,
} from "../shared/protocol";
export function NativeImageCapability({
  connection,
  model,
  disabled,
}: {
  connection: Connection;
  model?: string;
  disabled: boolean;
}) {
  const [starting, setStarting] = useState(false),
    [error, setError] = useState("");
  const entry = connection.models.find((m) => m.model === model);
  if (!entry) return null;
  const probe = entry.lastProbe;
  const running = !!probe && !terminalStates.includes(probe.state);
  async function check() {
    setStarting(true);
    setError("");
    try {
      const r = await window.desktop.runConnectionCheck(
        "image_probe",
        connection.id,
        model,
      );
      if (!r.ok) setError(r.message);
    } catch {
      setError("图片检测未能启动，请重试。");
    } finally {
      setStarting(false);
    }
  }
  return (
    <div
      className="native-image-capability"
      role="group"
      aria-label={`图片能力 ${model}`}
    >
      <p>
        图片输入 · {model}：{imageInputLabels[entry.imageInput]}
      </p>
      <p className="form-note">
        可直接发送图片。检测会调用所选模型，验证它能否识别测试图片的内容。
      </p>
      {running && probe ? (
        <button
          className="button"
          onClick={() =>
            void window.desktop
              .command({
                type: "stopExecution",
                executionId: probe.executionId,
              })
              .then((r) => {
                if (!r.ok) setError(r.message);
              })
          }
        >
          取消图片检测
        </button>
      ) : (
        <button
          className="button"
          disabled={disabled || starting}
          onClick={() => void check()}
        >
          {starting ? "正在启动检测…" : "检测图片能力"}
        </button>
      )}
      {probe && (
        <p
          role="status"
          className={probe.state === "failed" ? "form-error" : "form-note"}
        >
          图片检测 · {model}：
          {probe.state === "completed" ? "成功" : stateLabels[probe.state]}
          {probe.errorMessage ? `，${probe.errorMessage}` : ""}
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
