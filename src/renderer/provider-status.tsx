import { useEffect, useState } from "react";
import type { ClaudeStatus } from "../shared/claude";
import type { CodexStatus } from "../shared/codex";
import type { Connection, RunEvent } from "../shared/protocol";

type Indicator = { state: "available" | "error" | "inactive"; reason: string };
type NativeStatus = ClaudeStatus | CodexStatus;
const inactive = (reason: string): Indicator => ({ state: "inactive", reason });
const error = (reason: string): Indicator => ({ state: "error", reason });
const connectionErrors = new Set(["auth", "address", "network", "protocol"]);

/** Only current-configuration evidence can change a provider's availability. */
export function providerStatus(
  connection: Connection | undefined,
  events: RunEvent[],
  enabled = connection?.enabled ?? false,
  connected = true,
  native?: NativeStatus | string,
): Indicator {
  if (!enabled) return inactive("未启用");
  if (!connection) return inactive("整合已开启，待配置模型");
  if (!connection.enabled) return inactive("未启用");
  const local =
    connection.provider === "codex" || connection.provider === "claude";
  if (!local && !connection.secretRef) return inactive("未配置密钥");
  const models = connection.models.filter(
    (m) =>
      m.enabled && (!local || !!m[connection.provider as "codex" | "claude"]),
  );
  if (!models.length) return inactive("没有启用的模型");
  if (!connected) return error("业务服务连接中断，请重新连接");
  if (local) {
    if (typeof native === "string") return error(native);
    if (!native) return inactive("正在核对本地安装与登录状态");
    if (
      native.detection !== "found" ||
      native.protocol !== "available" ||
      ["signedOut", "unknown"].includes(native.authentication) ||
      native.restriction === "conflict"
    )
      return error(native.message || "本地连接不可用，请进入提供方查看详情");
    if (!models.some((m) => native.models.includes(m.model)))
      return error("已启用的模型未在当前本地配置中识别，请重新配置");
  }
  // A model refusal, unsupported image, user stop or permission denial is not
  // evidence that the provider's login, address or network is broken.
  const current = events
    .filter(
      (e) =>
        e.connection?.connectionId === connection.id &&
        e.connection.revision === connection.revision &&
        models.some((m) => m.model === e.connection?.model) &&
        (e.kind === "completed" ||
          (e.kind === "failed" &&
            connectionErrors.has(String(e.payload.errorClass)))),
    )
    .sort((a, b) => b.seq - a.seq)[0];
  const checks = [
    connection.lastTest,
    connection.lastModelList,
    ...models.map((m) => m.lastTest),
  ]
    .filter(
      (c) =>
        c &&
        (c.state === "completed" ||
          (c.state === "failed" && connectionErrors.has(c.errorClass ?? ""))),
    )
    .sort((a, b) =>
      (b!.endedAt ?? b!.createdAt).localeCompare(a!.endedAt ?? a!.createdAt),
    );
  const check = checks[0];
  if (current && (!check || current.at >= (check.endedAt ?? check.createdAt))) {
    if (current.kind === "failed")
      return error(
        String(current.payload.message || "连接失败，请进入提供方查看详情"),
      );
  } else if (check?.state === "failed") {
    return error(check.errorMessage || "连接失败，请进入提供方查看详情");
  }
  const modelErrors = new Set(["model", "provider", "rate_limit"]);
  const failures = models.map((model) => {
    const event = events
      .filter(
        (e) =>
          e.connection?.connectionId === connection.id &&
          e.connection.revision === connection.revision &&
          e.connection.model === model.model &&
          (e.kind === "completed" ||
            (e.kind === "failed" &&
              modelErrors.has(String(e.payload.errorClass)))),
      )
      .sort((a, b) => b.seq - a.seq)[0];
    const test = model.lastTest;
    if (event && (!test || event.at >= (test.endedAt ?? test.createdAt)))
      return event.kind === "failed"
        ? String(event.payload.message || "模型请求失败")
        : null;
    return test?.state === "failed" && modelErrors.has(test.errorClass ?? "")
      ? test.errorMessage || "模型测试失败"
      : null;
  });
  if (failures.every(Boolean))
    return error(`已启用的模型均出现调用错误：${failures[0]}`);
  return {
    state: "available",
    reason: "可用：已启用并完成配置；调用结果以模型测试和实际对话为准",
  };
}

function Dot({ name, value }: { name: string; value: Indicator }) {
  const label =
    value.state === "available"
      ? "可用"
      : value.state === "error"
        ? "错误"
        : "未启用或未就绪";
  return (
    <span
      className="provider-indicator"
      data-state={value.state}
      role="img"
      aria-label={`${name}：${label}，${value.reason}`}
      title={value.reason}
    />
  );
}

export function ProviderIndicator({
  name,
  connection,
  events,
  connected,
}: {
  name: string;
  connection?: Connection;
  events: RunEvent[];
  connected: boolean;
}) {
  return (
    <Dot
      name={name}
      value={providerStatus(connection, events, undefined, connected)}
    />
  );
}

export function NativeProviderIndicator({
  name,
  provider,
  connection,
  events,
  enabled,
  connected,
  revision,
}: {
  name: string;
  provider: "codex" | "claude";
  connection?: Connection;
  events: RunEvent[];
  enabled: boolean;
  connected: boolean;
  revision: number;
}) {
  const key = `${provider}:${enabled}:${connected}:${revision}:${connection?.id}:${connection?.revision}`;
  const [result, setResult] = useState<{
    key: string;
    value: NativeStatus | string;
  }>();
  const configured = !!connection?.enabled;
  useEffect(() => {
    if (!enabled || !connected || !configured) return;
    let active = true;
    const detect =
      provider === "codex"
        ? window.desktop.detectCodex
        : window.desktop.detectClaude;
    void detect().then(
      (value) => {
        if (active) setResult({ key, value });
      },
      () => {
        if (active)
          setResult({ key, value: "暂时无法检测本地连接，请进入提供方重试" });
      },
    );
    return () => {
      active = false;
    };
  }, [key, provider, enabled, connected, configured]);
  return (
    <Dot
      name={name}
      value={providerStatus(
        connection,
        events,
        enabled,
        connected,
        result?.key === key ? result.value : undefined,
      )}
    />
  );
}
