import { NativeImageCapability } from "./native-image-capability";
import { EffortSummary } from "./effort";
import { useNativeSetupFeedback } from "./native-setup-feedback";
import { useCallback, useEffect, useState, useRef } from "react";
import {
  codexAuthenticationLabels,
  defaultCodexSettings,
  validCodexPath,
  sameCodexOrigin,
  type CodexStatus,
  type CodexSetup,
} from "../shared/codex";

import { terminalStates, stateLabels, type Snapshot } from "../shared/protocol";
export function CodexSettings({
  snapshot,
  connected,
}: {
  snapshot: Snapshot | undefined;
  connected: boolean;
}) {
  const connection = snapshot?.connections.find((c) => c.provider === "codex");
  const preferences = snapshot?.settings.codex ?? {
    ...defaultCodexSettings,
    enabled: false,
  };
  const [path, setPath] = useState(preferences.path ?? "");
  const [saving, setSaving] = useState(false);
  const [startingTest, setStartingTest] = useState(false);
  const [query, setQuery] = useState("");
  const [testModelId, setTestModelId] = useState("");
  const configuredModels =
    connection?.models.filter((m) => m.codex && m.enabled) ?? [];
  const selectedModelId = configuredModels.some((m) => m.model === testModelId)
    ? testModelId
    : connection?.model;

  const lastTest = connection?.models.find(
    (m) => m.model === selectedModelId,
  )?.lastTest;
  const testing = !!lastTest && !terminalStates.includes(lastTest.state);
  useEffect(() => setPath(preferences.path ?? ""), [preferences.path]);
  async function savePreferences(enabled: boolean, chosenPath: string | null) {
    if (!validCodexPath(chosenPath)) {
      setError("请填写 Codex 可执行文件的绝对路径。");
      return;
    }
    setSaving(true);
    setError("");
    setSetup(undefined);
    try {
      const reply = await window.desktop.command({
        type: "setCodexSettings",
        enabled,
        path: chosenPath,
        revision: preferences.revision,
      });
      if (!reply.ok) setError(reply.message);
    } catch {
      setError("Codex 设置未保存，请重试。");
    } finally {
      setSaving(false);
    }
  }
  async function testModel(model = selectedModelId) {
    if (!connection) return;
    setTestModelId(model ?? "");
    setStartingTest(true);
    setError("");
    try {
      const reply = await window.desktop.runConnectionCheck(
        "connection_test",
        connection.id,
        model,
      );
      if (!reply.ok) setError(reply.message);
    } catch {
      setError("模型测试未能启动，请重试。");
    } finally {
      setStartingTest(false);
    }
  }
  const lastCall = snapshot?.events.find(
    (event) =>
      event.connection?.provider === "codex" &&
      (event.executionId === lastTest?.executionId ||
        snapshot.events.some(
          (submitted) =>
            submitted.executionId === event.executionId &&
            submitted.kind === "submitted" &&
            typeof submitted.payload.turnId === "string",
        )) &&
      event.connection.revision === connection?.revision &&
      ["completed", "failed", "stopped", "interrupted"].includes(event.kind),
  );
  const callState =
    lastCall?.kind === "completed"
      ? "最近调用成功"
      : lastCall?.kind === "failed"
        ? "最近调用失败"
        : lastCall?.kind === "stopped"
          ? "已停止"
          : lastCall?.kind === "interrupted"
            ? "已中断"
            : "未测试";
  const [setup, setSetup] = useState<CodexSetup>();
  const [confirmed, setConfirmed] = useState(false);
  const [preparing, setPreparing] = useState(false);
  async function prepare(model?: string, reuseConsent = false) {
    setPreparing(true);
    setError("");
    setSetup(undefined);
    setConfirmed(false);
    try {
      const reply = await window.desktop.prepareCodex(model);
      if (reply.ok) {
        if (
          reuseConsent &&
          connection?.codex &&
          sameCodexOrigin(connection.codex, reply.setup.configuration)
        ) {
          const accepted = await window.desktop.acceptCodex(reply.setup.token);
          if (!accepted.ok) setError(accepted.message);
        } else setSetup(reply.setup);
      } else setError(reply.message);
    } catch {
      setError("Codex 配置准备失败，请重试。");
    } finally {
      setPreparing(false);
    }
  }
  async function toggleModel(model: string, enabled: boolean) {
    if (enabled) {
      await prepare(model, true);
      return;
    }
    const entry = connection?.models.find((m) => m.model === model);
    if (!connection || !entry) return;
    setPreparing(true);
    setError("");
    try {
      const reply = await window.desktop.command({
        type: "upsertModel",
        id: connection.id,
        model,
        enabled: false,
        imageInput: entry.imageInput,
        contextChars: entry.contextChars,
        revision: connection.revision,
      });
      if (!reply.ok) setError(reply.message);
    } catch {
      setError("模型设置未保存，请重试。");
    } finally {
      setPreparing(false);
    }
  }
  async function accept() {
    if (!setup) return;
    setPreparing(true);
    setError("");
    try {
      const reply = await window.desktop.acceptCodex(setup.token);
      if (reply.ok) setSetup(undefined);
      else setError(reply.message);
    } catch {
      setError("Codex 连接尚未确认保存，请重新核对。");
    } finally {
      setPreparing(false);
    }
  }

  const [result, setResult] = useState<CodexStatus>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const feedback = useNativeSetupFeedback(error, setup);
  const detectionSequence = useRef(0);
  const detect = useCallback(async () => {
    const sequence = ++detectionSequence.current;
    if (!connected || !preferences.enabled) {
      setBusy(false);
      setResult(undefined);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const detected = await window.desktop.detectCodex();
      if (sequence === detectionSequence.current) setResult(detected);
    } catch {
      if (sequence === detectionSequence.current)
        setError("暂时无法检测 Codex，请重试。");
    } finally {
      if (sequence === detectionSequence.current) setBusy(false);
    }
  }, [connected, preferences.enabled, preferences.revision]);
  useEffect(() => {
    void detect();
    return () => {
      detectionSequence.current++;
    };
  }, [detect]);
  const listedModels = [
    ...new Set([
      ...(result?.models ?? []),
      ...(connection?.models.map((m) => m.model) ?? []),
    ]),
  ];
  const filteredModels = listedModels.filter((model) =>
    model.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <section aria-label="Codex 连接" className="codex-settings">
      <div className="setting-row">
        <div>
          <strong>Codex</strong>
          <p>
            {!preferences.enabled
              ? "Codex 整合已关闭，不会启动检测或模型调用。"
              : busy
                ? "正在检测本地安装与登录…"
                : lastCall &&
                    result?.protocol === "available" &&
                    result.restriction === "verified"
                  ? "已读取本地安装与登录信息。"
                  : result?.message}
          </p>
        </div>
        <button
          className="button"
          disabled={busy || !connected || !preferences.enabled || saving}
          onClick={() => void detect()}
        >
          {busy ? "正在检测…" : "重新检测 Codex"}
        </button>
      </div>
      {error && (
        <p
          ref={feedback.errorRef}
          tabIndex={-1}
          role="alert"
          className="form-error"
        >
          {error}
        </p>
      )}
      <label className="codex-integration-toggle">
        <input
          type="checkbox"
          className="setting-switch"
          checked={preferences.enabled}
          disabled={!connected || saving || preparing}
          onChange={(e) =>
            void savePreferences(e.target.checked, preferences.path)
          }
        />
        启用 Codex 整合
      </label>
      <p className="muted">
        关闭会取消 Codex 默认模型，保留连接配置和历史；正在执行时请先停止。
      </p>
      <div className="codex-path-settings">
        <label htmlFor="codex-executable-path">Codex 安装路径</label>
        <p className="muted data-path">
          {preferences.path ? "当前使用自定义路径" : "当前使用系统自动识别"} ·{" "}
          {result?.installation?.path ??
            (preferences.enabled ? "尚未识别" : "整合已关闭")}
        </p>
        <input
          id="codex-executable-path"
          value={path}
          placeholder={
            result?.installation?.path ?? "例如 /opt/homebrew/bin/codex"
          }
          spellCheck={false}
          disabled={!connected || saving || preparing}
          onChange={(e) => setPath(e.target.value)}
        />
        <div className="row">
          <button
            className="button"
            disabled={!connected || saving || preparing || !path.trim()}
            onClick={() =>
              void savePreferences(preferences.enabled, path.trim())
            }
          >
            保存安装路径
          </button>
          <button
            className="button"
            disabled={
              !connected || saving || preparing || preferences.path === null
            }
            onClick={() => void savePreferences(preferences.enabled, null)}
          >
            重置为系统识别
          </button>
        </div>
      </div>
      {result && preferences.enabled && (
        <>
          <dl className="codex-facts">
            <div>
              <dt>安装</dt>
              <dd>
                {result.detection === "found"
                  ? "已安装"
                  : result.detection === "missing"
                    ? "未发现"
                    : "检测失败"}
              </dd>
            </div>
            <div>
              <dt>认证</dt>
              <dd>{codexAuthenticationLabels[result.authentication]}</dd>
            </div>
            <div>
              <dt>模型</dt>
              <dd>{result.model ?? "暂未识别"}</dd>
            </div>
            <div>
              <dt>调用</dt>
              <dd>{callState}</dd>
            </div>
          </dl>
          <details>
            <summary>连接详情</summary>
            <dl className="codex-facts codex-details">
              <div>
                <dt>安装位置</dt>
                <dd>{result.installation?.path ?? "未发现"}</dd>
              </div>
              <div>
                <dt>程序位置</dt>
                <dd>{result.installation?.resolvedPath ?? "未发现"}</dd>
              </div>
              <div>
                <dt>版本</dt>
                <dd>{result.installation?.version ?? "未识别"}</dd>
              </div>
              <div>
                <dt>提供方</dt>
                <dd>{result.provider ?? "暂未识别"}</dd>
              </div>
              <div>
                <dt>配置限制</dt>
                <dd>
                  {result.restriction === "verified"
                    ? "已核对"
                    : result.restriction === "conflict"
                      ? "配置冲突，不能发起会话"
                      : "尚未核对"}
                </dd>
              </div>
              <div>
                <dt>协议</dt>
                <dd>
                  {result.protocol === "available"
                    ? "已连接"
                    : result.protocol === "unavailable"
                      ? "连接检测失败"
                      : "尚未连接"}
                </dd>
              </div>
            </dl>
          </details>
        </>
      )}
      {preferences.enabled && (
        <>
          <div className="setting-row">
            <div>
              <strong>
                {connection
                  ? connection.enabled
                    ? "已配置"
                    : "已停用"
                  : "尚未配置"}
              </strong>
              <p>
                {connection
                  ? `当前模型：${connection.model}`
                  : "配置完成后可在聊天输入区选择 Codex。"}
              </p>
            </div>
            <button
              className="button"
              disabled={
                !connected ||
                busy ||
                preparing ||
                result?.restriction !== "verified"
              }
              onClick={() => void prepare()}
            >
              {preparing
                ? "正在核对…"
                : connection
                  ? "重新配置 Codex"
                  : "配置 Codex"}
            </button>
          </div>
          {setup && (
            <div
              className="codex-setup"
              ref={feedback.setupRef}
              tabIndex={-1}
              role="region"
              aria-label="确认 Codex 连接"
            >
              <strong>确认连接来源</strong>
              <p className="data-path">
                连接地址：{setup.configuration.endpoint}
              </p>
              <p>
                {setup.configuration.provider} · {setup.model} ·{" "}
                {codexAuthenticationLabels[setup.configuration.authentication]}
              </p>
              <p>
                {setup.configuration.instructions.length +
                setup.configuration.configurationInstructions.length
                  ? "使用此连接发送对话时，Codex 会同时向上述提供方发送以下个人规则来源。"
                  : "本次协议未报告额外个人规则来源。"}
              </p>
              {setup.configuration.configurationInstructions.map((source) => (
                <div key={source.field} className="data-path">
                  <span>Codex 配置字段：{source.field}</span>
                  <small>SHA-256：{source.sha256}</small>
                </div>
              ))}
              {setup.configuration.instructions.map((source) => (
                <div key={source.path} className="data-path">
                  <span>{source.path}</span>
                  <small>SHA-256：{source.sha256}</small>
                </div>
              ))}
              {setup.configuration.instructions.length +
                setup.configuration.configurationInstructions.length >
                0 && (
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  允许随此连接的对话发送这些规则
                </label>
              )}
              <div className="setting-row">
                <button
                  className="button"
                  disabled={
                    preparing ||
                    (!confirmed &&
                      setup.configuration.instructions.length +
                        setup.configuration.configurationInstructions.length >
                        0)
                  }
                  onClick={() => void accept()}
                >
                  确认配置 Codex
                </button>
                <button
                  className="button"
                  disabled={preparing}
                  onClick={() => setSetup(undefined)}
                >
                  取消
                </button>
              </div>
            </div>
          )}
          {connection && (
            <div className="field">
              <label htmlFor="codex-test-model">已配置的 Codex 模型</label>
              <select
                id="codex-test-model"
                value={selectedModelId ?? ""}
                disabled={testing || startingTest || preparing}
                onChange={(e) => setTestModelId(e.target.value)}
              >
                {configuredModels.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.model}
                  </option>
                ))}
              </select>
              <small>选择要测试或设为默认的模型；对话页可独立切换。</small>
            </div>
          )}
          {connection && (
            <div className="setting-row">
              <button
                className="button"
                disabled={
                  !connected ||
                  preparing ||
                  startingTest ||
                  testing ||
                  !connection.enabled ||
                  busy ||
                  result?.restriction !== "verified"
                }
                onClick={() => void testModel()}
              >
                {startingTest || testing ? "正在测试…" : "模型测试"}
              </button>
              {testing && lastTest && (
                <button
                  className="button"
                  onClick={() =>
                    void window.desktop
                      .command({
                        type: "stopExecution",
                        executionId: lastTest.executionId,
                      })
                      .then((r) => {
                        if (!r.ok) setError(r.message);
                      })
                  }
                >
                  停止测试
                </button>
              )}
              <button
                className="button"
                disabled={!connected || !connection.enabled || preparing}
                onClick={() =>
                  void window.desktop
                    .command({
                      type: "setDefaultConnection",
                      id: connection.id,
                      model: selectedModelId,
                    })
                    .then((r) => {
                      if (!r.ok) setError(r.message);
                    })
                }
              >
                {snapshot?.settings.defaultConnectionId === connection.id &&
                snapshot.settings.defaultModelId === selectedModelId
                  ? "当前默认模型"
                  : "设为默认模型"}
              </button>
              {snapshot?.settings.defaultConnectionId === connection.id && (
                <button
                  className="link-button"
                  disabled={!connected || preparing}
                  onClick={() =>
                    void window.desktop
                      .command({ type: "setDefaultConnection", id: null })
                      .then((r) => {
                        if (!r.ok) setError(r.message);
                      })
                  }
                >
                  取消默认模型
                </button>
              )}
            </div>
          )}
          {connection && (
            <NativeImageCapability
              key={`${connection.id}:${selectedModelId}:${connection.revision}`}
              connection={connection}
              model={selectedModelId}
              disabled={
                !connected ||
                !preferences.enabled ||
                !connection.enabled ||
                busy ||
                preparing ||
                testing ||
                startingTest
              }
            />
          )}
          {connection && (
            <EffortSummary connection={connection} model={selectedModelId} />
          )}
          {connection && (
            <p role="status">
              <span>测试模型：{selectedModelId}。 </span>
              <span>
                {!lastTest
                  ? "模型测试：未测试"
                  : lastTest.state === "completed"
                    ? "模型测试成功"
                    : lastTest.state === "failed"
                      ? `模型测试失败：${lastTest.errorMessage ?? "请检查连接后重试。"}`
                      : lastTest.state === "stopped"
                        ? "模型测试已停止"
                        : lastTest.state === "interrupted"
                          ? "模型测试已中断"
                          : "模型测试进行中…"}
              </span>
            </p>
          )}
          <section className="codex-model-list" aria-label="Codex 模型列表">
            <div className="setting-row">
              <strong>模型列表</strong>
              <button
                className="button"
                disabled={!connected || busy || preparing || testing}
                onClick={() => void detect()}
              >
                刷新模型列表
              </button>
            </div>
            <div className="field">
              <label htmlFor="codex-model-search">搜索 Codex 模型</label>
              <input
                id="codex-model-search"
                type="search"
                value={query}
                placeholder="按模型名称搜索"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <p className="muted">
              已配置 {configuredModels.length}{" "}
              个模型。勾选启用后，可在对话页切换。
            </p>
            {!listedModels.length ? (
              <p className="muted">
                {busy
                  ? "正在读取模型列表…"
                  : "当前 Codex 未返回模型列表，请检查登录与配置后刷新。"}
              </p>
            ) : !filteredModels.length ? (
              <p role="status">没有匹配的 Codex 模型</p>
            ) : (
              <ul>
                {filteredModels.map((model) => {
                  const entry = connection?.models.find(
                    (m) => m.model === model,
                  );
                  const enabled = !!entry?.enabled && !!entry.codex;
                  const isDefault =
                    snapshot?.settings.defaultConnectionId === connection?.id &&
                    snapshot?.settings.defaultModelId === model;
                  const check = entry?.lastTest;
                  const running =
                    !!check && !terminalStates.includes(check.state);
                  const locked =
                    !connected || busy || preparing || startingTest || testing;
                  return (
                    <li
                      key={model}
                      role="group"
                      aria-label={`模型 ${model}`}
                      className="provider-model"
                    >
                      <div className="provider-model-line">
                        <label className="model-option">
                          <input
                            type="checkbox"
                            aria-label={`启用模型 ${model}`}
                            checked={enabled}
                            disabled={locked || isDefault}
                            onChange={(e) =>
                              void toggleModel(model, e.target.checked)
                            }
                          />
                          <span title={model}>{model}</span>
                        </label>
                        {running ? (
                          <button
                            className="link-button"
                            onClick={() =>
                              void window.desktop
                                .command({
                                  type: "stopExecution",
                                  executionId: check.executionId,
                                })
                                .then((r) => {
                                  if (!r.ok) setError(r.message);
                                })
                            }
                          >
                            取消测试
                          </button>
                        ) : (
                          <button
                            className="link-button"
                            disabled={
                              locked || !enabled || !connection?.enabled
                            }
                            onClick={() => void testModel(model)}
                          >
                            测试模型
                          </button>
                        )}
                        {isDefault ? (
                          <span className="tag default-tag">默认</span>
                        ) : (
                          <button
                            className="link-button"
                            disabled={
                              locked || !enabled || !connection?.enabled
                            }
                            onClick={() =>
                              void window.desktop
                                .command({
                                  type: "setDefaultConnection",
                                  id: connection!.id,
                                  model,
                                })
                                .then((r) => {
                                  if (!r.ok) setError(r.message);
                                })
                            }
                          >
                            设为默认
                          </button>
                        )}
                      </div>
                      <small role="status">
                        {check
                          ? `文本调用：${stateLabels[check.state]}${check.errorMessage ? ` · ${check.errorMessage}` : ""}`
                          : "文本调用：未测试"}
                      </small>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <p className="muted">
            安装检测、模型列表与配置核对不调用真实模型。点击“模型测试”“检测图片能力”或发送问答时，会使用
            Codex 登录并发送已确认的个人规则。
          </p>
        </>
      )}
    </section>
  );
}
