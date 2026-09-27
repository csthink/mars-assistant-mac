import type { Connection, EffortRecord } from "../shared/protocol";
export const effortUnrecorded = "未记录";
/** Levels are shown exactly as the installation named them; nothing is translated or inferred. */
export function effortLabel(record: EffortRecord | null): string {
  if (!record) return effortUnrecorded;
  return `${record.levels.join(" / ")} · 默认 ${record.defaultLevel ?? effortUnrecorded}`;
}
export function EffortSummary({
  connection,
  model,
}: {
  connection: Connection;
  model?: string;
}) {
  const entry = connection.models.find((m) => m.model === model);
  if (!entry) return null;
  const local =
    connection.provider === "codex" || connection.provider === "claude";
  const testId = `effort-${connection.id}-${entry.model}`;
  if (!local)
    return (
      <p className="model-capability effort-summary" data-testid={testId}>
        推理强度 · {entry.model}：{effortUnrecorded}
        （未按提供方取证，不透传字段）
      </p>
    );
  const record = entry.effort;
  return (
    <div
      className="native-effort effort-summary"
      role="group"
      aria-label={`推理强度 ${entry.model}`}
      data-testid={testId}
    >
      <p>
        推理强度 · {entry.model}：{effortLabel(record)}
        {record
          ? `，读回于 ${new Date(record.recordedAt).toLocaleString("zh-CN")}`
          : "（当次安装未提供该参数，按模型默认执行）"}
      </p>
      <p className="form-note">
        档位从当次安装读回，按连接与模型分别记录；对话输入区可为每个对话选择档位，未记录时按模型默认执行。
      </p>
    </div>
  );
}
