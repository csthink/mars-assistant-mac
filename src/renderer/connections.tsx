import { EffortSummary } from "./effort";
import { ProviderIndicator, NativeProviderIndicator } from "./provider-status";
import { ClaudeSettings } from "./claude";
import { CodexSettings } from "./codex";
import { useId, useState, useRef, useEffect, type ReactNode } from "react";
import {
  baseUrlProblem,
  defaultContextChars,
  imageInputLabels,
  presets,
  providers,
  stateLabels,
  terminalStates,
  validModel,
  type CheckKind,
  type Command,
  type Connection,
  type ConnectionModel,
  type ImageInput,
  type Provider,
  type Snapshot,
  type Status,
} from "../shared/protocol";

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: (id: string) => ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <small>{hint}</small>}
    </div>
  );
}
function ready(c: Connection) {
  return (
    c.enabled &&
    (c.provider === "codex"
      ? !!c.codex
      : c.provider === "claude"
        ? !!c.claude
        : !!c.secretRef) &&
    c.models.some((m) => m.enabled)
  );
}
function state(c: Connection) {
  return !c.enabled
    ? "已停用"
    : !c.secretRef
      ? "未配置密钥"
      : !c.models.some((m) => m.enabled)
        ? "没有启用的模型"
        : "已配置";
}
export function ConnectionSettings({
  snapshot,
  status,
}: {
  snapshot: Snapshot | undefined;
  status: Status;
}) {
  const [search, setSearch] = useState("");
  const matches = (...values: unknown[]) =>
    values
      .join(" ")
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase());
  const [selected, setSelected] = useState<string>();
  const [native, setNative] = useState<"codex" | "claude">();
  const [create, setCreate] = useState<Provider>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const connections = snapshot?.connections ?? [];
  const connection = connections.find((c) => c.id === selected);
  async function command(c: Command) {
    setBusy(true);
    setError("");
    try {
      const r = await window.desktop.command(c);
      if (!r.ok) setError(r.message);
      return r;
    } finally {
      setBusy(false);
    }
  }
  const locked = !status.connected || busy;
  return (
    <>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {native ? (
        <article
          className="provider-detail"
          aria-label={`提供方 ${native === "codex" ? "Codex" : "Claude Code"}`}
        >
          <button
            className="link-button provider-back"
            onClick={() => setNative(undefined)}
          >
            ‹ 全部提供方
          </button>
          {native === "codex" ? (
            <CodexSettings snapshot={snapshot} connected={status.connected} />
          ) : (
            <ClaudeSettings snapshot={snapshot} connected={status.connected} />
          )}
        </article>
      ) : connection ? (
        <ProviderDetail
          key={connection.id}
          connection={connection}
          snapshot={snapshot!}
          locked={locked}
          command={command}
          onBack={() => {
            setSelected(undefined);
            setError("");
            setNotice("");
          }}
          onNotice={setNotice}
          onError={setError}
        />
      ) : create ? (
        <ProviderForm
          provider={create}
          locked={locked}
          command={command}
          onCancel={() => setCreate(undefined)}
          onSaved={(id) => {
            setCreate(undefined);
            setSelected(id);
            setNotice("提供方已保存，接下来保存密钥并添加模型。");
          }}
        />
      ) : (
        <>
          <p className="muted">
            进入提供方可管理密钥、搜索模型、测试模型及检测图片能力。已配置模型会列在聊天输入区，停用项会标明原因。
          </p>
          <div className="connection-head">
            <label className="provider-search">
              搜索模型与 Agent
              <input
                aria-label="搜索模型与 Agent"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="名称、模型或地址"
              />
            </label>
            <button
              className="button"
              disabled={locked}
              onClick={() => {
                setCreate("custom");
                setError("");
              }}
            >
              添加自定义提供方
            </button>
          </div>
          <h3>本地 Agent</h3>
          <section className="provider-list" aria-label="本地 Agent">
            {(["codex", "claude"] as const).map((provider) => {
              const name = provider === "codex" ? "Codex" : "Claude Code";
              const c = connections.find((item) => item.provider === provider);
              const enabled =
                provider === "codex"
                  ? snapshot?.settings.codex.enabled
                  : snapshot?.settings.claude.enabled;
              if (!matches(name, c?.models.map((m) => m.model).join(" ")))
                return null;
              return (
                <div className="provider-row-shell" key={provider}>
                  <button
                    className="provider-row"
                    aria-label={`打开提供方 ${name}`}
                    onClick={() => setNative(provider)}
                  >
                    <span className="provider-mark">{name.slice(0, 1)}</span>
                    <span className="provider-info">
                      <span className="provider-name">
                        <strong>{name}</strong>
                        <NativeProviderIndicator
                          name={name}
                          provider={provider}
                          connection={c}
                          events={snapshot?.events ?? []}
                          enabled={!!enabled}
                          connected={status.connected}
                          revision={snapshot?.settings[provider].revision ?? 0}
                        />
                      </span>
                      <small>
                        {provider === "codex"
                          ? (snapshot?.settings.codex.path ??
                            "自动识别本地安装，复用本地登录")
                          : (snapshot?.settings.claude.path ??
                            "自动识别本地安装，复用本地登录")}
                      </small>
                    </span>
                    <span className="provider-state">
                      {!enabled ? (
                        "整合已关闭"
                      ) : c ? (
                        "已配置"
                      ) : (
                        <>
                          整合已开启<small>待配置模型</small>
                        </>
                      )}
                      {c && (
                        <small>
                          {
                            c.models.filter(
                              (m) =>
                                m.enabled &&
                                (provider === "codex" ? m.codex : m.claude),
                            ).length
                          }{" "}
                          个模型
                        </small>
                      )}
                    </span>
                    <span className="provider-manage">管理模型与测试 ›</span>
                  </button>
                </div>
              );
            })}
          </section>
          <h3>模型提供方</h3>
          <section className="provider-list" aria-label="模型提供方">
            {providers
              .filter((p) => p !== "custom")
              .map((provider) => {
                const c = connections.find((c) => c.provider === provider);
                if (
                  !matches(
                    presets[provider].label,
                    c?.name,
                    c?.baseUrl ?? presets[provider].baseUrl,
                    c?.models.map((m) => m.model).join(" "),
                  )
                )
                  return null;
                return c ? (
                  <ProviderRow
                    key={c.id}
                    connection={c}
                    events={snapshot?.events ?? []}
                    connected={status.connected}
                    locked={locked}
                    command={command}
                    isDefault={snapshot?.settings.defaultConnectionId === c.id}
                    onOpen={() => setSelected(c.id)}
                  />
                ) : (
                  <div className="provider-row-shell" key={provider}>
                    <button
                      className="provider-row"
                      disabled={locked}
                      onClick={() => setCreate(provider)}
                    >
                      <span className="provider-mark">
                        {presets[provider].label.slice(0, 1)}
                      </span>
                      <span className="provider-info">
                        <span className="provider-name">
                          <strong>{presets[provider].label}</strong>
                          <ProviderIndicator
                            name={presets[provider].label}
                            events={[]}
                            connected={status.connected}
                          />
                        </span>
                        <small>{presets[provider].baseUrl}</small>
                      </span>
                      <span className="provider-state">未配置密钥</span>
                      <span className="provider-manage">配置与模型测试 ›</span>
                    </button>
                    <label
                      className="inline-check provider-row-toggle"
                      title="先配置提供方、密钥和模型"
                    >
                      <input
                        type="checkbox"
                        className="setting-switch"
                        aria-label={`启用提供方 ${presets[provider].label}`}
                        checked={false}
                        disabled
                      />
                      启用
                    </label>
                  </div>
                );
              })}
            {connections
              .filter(
                (c) =>
                  c.provider === "custom" &&
                  matches(
                    c.name,
                    c.baseUrl,
                    c.models.map((m) => m.model).join(" "),
                  ),
              )
              .map((c) => (
                <ProviderRow
                  key={c.id}
                  connection={c}
                  events={snapshot?.events ?? []}
                  connected={status.connected}
                  locked={locked}
                  command={command}
                  isDefault={snapshot?.settings.defaultConnectionId === c.id}
                  onOpen={() => setSelected(c.id)}
                />
              ))}
          </section>
          {search.trim() &&
            ![
              "Codex",
              "Claude Code",
              ...providers
                .filter((p) => p !== "custom")
                .flatMap((p) => [presets[p].label, presets[p].baseUrl]),
              ...connections.flatMap((c) => [
                c.name,
                c.baseUrl,
                ...c.models.map((m) => m.model),
              ]),
            ].some((v) => matches(v)) && (
              <p role="status">没有匹配的模型或 Agent</p>
            )}
          <p className="form-note">
            每家预设厂商固定一个提供方。第二个账户或地址可添加为自定义提供方。
          </p>
        </>
      )}
    </>
  );
}
function ProviderRow({
  connection: c,
  events,
  connected,
  onOpen,
  locked,
  command,
  isDefault,
}: {
  connection: Connection;
  events: Snapshot["events"];
  connected: boolean;
  locked: boolean;
  command: Send;
  isDefault: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="provider-row-shell">
      <button
        className="provider-row"
        aria-label={`打开提供方 ${c.name}`}
        onClick={onOpen}
      >
        <span className="provider-mark">{c.name.slice(0, 1)}</span>
        <span className="provider-info">
          <span className="provider-name">
            <strong>{c.name}</strong>
            <ProviderIndicator
              name={c.name}
              connection={c}
              events={events}
              connected={connected}
            />
          </span>
          <small>{c.baseUrl}</small>
        </span>
        <span className="provider-state">
          {state(c)}
          <small>{c.models.filter((m) => m.enabled).length} 个模型</small>
        </span>
        <span className="provider-manage">管理模型与测试 ›</span>
      </button>
      <label
        className="inline-check provider-row-toggle"
        title={
          isDefault
            ? "默认提供方请进入管理页确认停用"
            : "停用后不能发送，历史仍保留"
        }
      >
        <input
          type="checkbox"
          className="setting-switch"
          aria-label={`启用提供方 ${c.name}`}
          checked={c.enabled}
          disabled={locked || isDefault}
          onChange={(e) =>
            void command({
              type: "setConnectionEnabled",
              id: c.id,
              revision: c.revision,
              enabled: e.target.checked,
              clearDefault: false,
            })
          }
        />
        启用
      </label>
    </div>
  );
}
type Send = (c: Command) => Promise<import("../shared/protocol").Reply>;
function ProviderForm({
  provider,
  connection,
  locked,
  command,
  onCancel,
  onSaved,
}: {
  provider: Provider;
  connection?: Connection;
  locked: boolean;
  command: Send;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const [error, setError] = useState("");
  return (
    <form
      className="connection-form"
      aria-label={connection ? "编辑提供方" : "新建提供方"}
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const name = String(data.get("name") ?? "");
        const url = String(data.get("endpoint") ?? "");
        const problem = baseUrlProblem(url.trim());
        if (problem || !name.trim()) {
          setError(problem ?? "请填写名称。");
          return;
        }
        const id = connection?.id ?? crypto.randomUUID();
        void command({
          type: "upsertConnection",
          id,
          name: name.trim(),
          provider,
          baseUrl: url.trim(),
          model: connection?.model ?? "",
          secretRef: connection?.secretRef ?? null,
          imageInput: connection?.imageInput ?? "unknown",
          contextChars: connection?.contextChars ?? null,
          revision: connection?.revision ?? 0,
        }).then((r) => {
          if (r.ok) {
            onSaved(id);
          }
        });
      }}
    >
      <h3>
        {connection
          ? "编辑提供方"
          : provider === "custom"
            ? "添加自定义提供方"
            : `配置 ${presets[provider].label}`}
      </h3>
      <Field label="名称">
        {(id) => (
          <input
            id={id}
            name="name"
            defaultValue={
              connection?.name ??
              (provider === "custom" ? "" : presets[provider].label)
            }
            maxLength={80}
            required
          />
        )}
      </Field>
      <Field
        label="Endpoint"
        hint={presets[provider].scope + " 保存后的地址不会被预设更新覆盖。"}
      >
        {(id) => (
          <input
            id={id}
            name="endpoint"
            defaultValue={connection?.baseUrl ?? presets[provider].baseUrl}
            spellCheck={false}
            required
          />
        )}
      </Field>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="button primary" disabled={locked}>
          保存提供方
        </button>
        <button
          type="button"
          className="button"
          onClick={onCancel}
          disabled={locked}
        >
          取消
        </button>
      </div>
      <p className="form-note">保存配置不会发送请求。</p>
    </form>
  );
}
function ProviderDetail({
  connection: c,
  snapshot,
  locked,
  command,
  onBack,
  onNotice,
  onError,
}: {
  connection: Connection;
  snapshot: Snapshot;
  locked: boolean;
  command: Send;
  onBack: () => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}) {
  const secretInput = useRef<HTMLInputElement>(null),
    modelInput = useRef<HTMLInputElement>(null);
  const [configuredQuery, setConfiguredQuery] = useState("");
  const [editing, setEditing] = useState(false),
    [secret, setSecret] = useState(""),
    [secretBusy, setSecretBusy] = useState(false);
  const [confirm, setConfirm] = useState<"key" | "disable" | "delete">();
  const confirmation = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = confirmation.current;
    if (confirm && dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, [confirm]);
  const [modelId, setModelId] = useState(""),
    [fetched, setFetched] = useState(false),
    [picked, setPicked] = useState<string[]>([]),
    [modelSearch, setModelSearch] = useState("");
  const availableModels =
    c.modelList.state === "fetched"
      ? c.modelList.models.filter(validModel)
      : [];
  const visibleModels = availableModels.filter((id) =>
    id.toLowerCase().includes(modelSearch.trim().toLowerCase()),
  );
  const isDefault = snapshot.settings.defaultConnectionId === c.id;
  const unavailable = locked || secretBusy;
  const activeCheck = (kind: CheckKind) =>
    kind === "model_list"
      ? c.lastModelList
      : kind === "image_probe"
        ? c.lastImageProbe
        : c.lastTest;
  async function check(kind: CheckKind, model?: string) {
    onError("");
    const r = await window.desktop.runConnectionCheck(kind, c.id, model);
    if (!r.ok) onError(r.message);
  }
  async function saveKey() {
    if (!secret || secretBusy) return;
    setSecretBusy(true);
    try {
      const stored = await window.desktop.saveSecret(
        secretInput.current?.value ?? "",
      );
      if (!stored.ok) {
        onError(stored.message);
        return;
      }
      const r = await command({
        type: "upsertConnection",
        id: c.id,
        name: c.name,
        provider: c.provider,
        baseUrl: c.baseUrl,
        model: c.model,
        secretRef: stored.secretRef,
        imageInput: c.imageInput,
        contextChars: c.contextChars,
        revision: c.revision,
      });
      if (!r.ok) await window.desktop.discardSecret(stored.secretRef);
      else {
        setSecret("");
        if (secretInput.current) secretInput.current.value = "";
        onNotice("密钥已加密保存，尚未测试。");
      }
    } finally {
      setSecretBusy(false);
    }
  }
  async function confirmAction() {
    let r;
    if (confirm === "key")
      r = await command({
        type: "upsertConnection",
        id: c.id,
        name: c.name,
        provider: c.provider,
        baseUrl: c.baseUrl,
        model: c.model,
        secretRef: null,
        imageInput: c.imageInput,
        contextChars: c.contextChars,
        revision: c.revision,
        clearDefault: true,
      });
    else if (confirm === "disable")
      r = await command({
        type: "setConnectionEnabled",
        id: c.id,
        enabled: false,
        revision: c.revision,
        clearDefault: true,
      });
    else r = await command({ type: "deleteConnection", id: c.id });
    if (r.ok) {
      onNotice(
        isDefault
          ? "已取消默认模型。新对话需要重新选择模型，未自动切换账户。"
          : "操作已保存，对话与历史回合保持。",
      );
      if (confirm === "delete") onBack();
    }
    setConfirm(undefined);
  }
  async function addModels(ids: string[]) {
    let revision = c.revision;
    for (const model of ids) {
      const r = await command({
        type: "upsertModel",
        id: c.id,
        model,
        enabled: true,
        imageInput: "unknown",
        contextChars: null,
        revision,
      });
      if (!r.ok) return;
      revision = r.snapshot.connections.find((x) => x.id === c.id)!.revision;
    }
    setModelId("");
    if (modelInput.current) modelInput.current.value = "";
    setFetched(false);
    setPicked([]);
    onNotice("模型已添加，能力未知，可按模型检测。");
  }
  const keyStatus = c.secretRef ? "已保存" : "未保存";
  return (
    <article className="provider-detail" aria-label={`提供方 ${c.name}`}>
      <button className="link-button provider-back" onClick={onBack}>
        ‹ 全部提供方
      </button>
      <div className="provider-heading">
        <div>
          <h3>{c.name}</h3>
          <p>{presets[c.provider].label}</p>
        </div>
        <label className="inline-check">
          <input
            type="checkbox"
            className="setting-switch"
            aria-label="启用提供方"
            checked={c.enabled}
            disabled={unavailable}
            onChange={(e) => {
              if (!e.target.checked) setConfirm("disable");
              else
                void command({
                  type: "setConnectionEnabled",
                  id: c.id,
                  enabled: true,
                  revision: c.revision,
                  clearDefault: false,
                });
            }}
          />
          启用
        </label>
      </div>
      {editing ? (
        <ProviderForm
          provider={c.provider}
          connection={c}
          locked={unavailable}
          command={command}
          onCancel={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      ) : (
        <div className="setting-row">
          <div className="provider-info">
            <strong>Endpoint</strong>
            <p className="data-path">{c.baseUrl}</p>
          </div>
          <button
            className="button"
            disabled={unavailable}
            onClick={() => setEditing(true)}
          >
            编辑提供方
          </button>
        </div>
      )}
      <section className="provider-section" aria-label="密钥">
        <div className="connection-head">
          <strong>API key</strong>
          <span className="tag">{keyStatus}</span>
        </div>
        <Field
          label="API key"
          hint="加密保存在本机，保存后不再显示。只在明确测试或发送时使用。"
        >
          {(id) => (
            <input
              id={id}
              type="password"
              autoComplete="off"
              spellCheck={false}
              ref={secretInput}
              defaultValue=""
              placeholder={
                c.secretRef ? "已加密保存；输入新密钥可替换" : "输入 API key"
              }
              onChange={(e) => setSecret(e.target.value)}
            />
          )}
        </Field>
        <div className="row">
          <button
            className="button primary"
            disabled={unavailable || !secret}
            onClick={() => void saveKey()}
          >
            保存密钥
          </button>
          <button
            className="button danger"
            disabled={unavailable || !c.secretRef}
            onClick={() => setConfirm("key")}
          >
            移除密钥…
          </button>
        </div>
      </section>
      {isDefault && (
        <button
          className="link-button"
          disabled={unavailable}
          onClick={() =>
            void command({ type: "setDefaultConnection", id: null }).then(
              (r) => {
                if (r.ok) onNotice("已取消默认模型，新对话需要重新选择。");
              },
            )
          }
        >
          取消默认模型
        </button>
      )}
      <section className="provider-section" aria-label="模型列表">
        <div className="connection-head">
          <div>
            <strong>模型列表</strong>
            <p>勾选的模型出现在输入区选择器。</p>
            <p className="form-note">
              测试模型会发送一次简短文本请求，可能产生少量费用。结果仅代表当次调用，配置修改后需重新测试。
            </p>
          </div>
          <button
            className="button"
            disabled={unavailable || !c.secretRef}
            onClick={() => {
              setFetched(true);
              setPicked([]);
              setModelSearch("");
              void check("model_list");
            }}
          >
            从厂商列表添加
          </button>
        </div>
        {!c.models.length && (
          <p className="connection-empty">
            还没有模型。从厂商列表添加，或在下方手动填写。
          </p>
        )}
        <Field label="搜索已配置模型">
          {(id) => (
            <input
              id={id}
              type="search"
              value={configuredQuery}
              onChange={(e) => setConfiguredQuery(e.target.value)}
              placeholder="按模型名称搜索"
            />
          )}
        </Field>
        {c.models
          .filter((m) =>
            m.model
              .toLowerCase()
              .includes(configuredQuery.trim().toLowerCase()),
          )
          .map((m) => (
            <ModelRow
              key={m.model}
              model={m}
              connection={c}
              defaultModel={isDefault ? snapshot.settings.defaultModelId : null}
              locked={unavailable}
              command={command}
              check={check}
            />
          ))}
        <form
          className="model-add"
          aria-label="手动添加模型"
          onSubmit={(e) => {
            e.preventDefault();
            const id = (modelInput.current?.value ?? "").trim();
            if (!validModel(id)) {
              onError(
                "模型 ID 只能包含字母、数字、点、斜杠、冒号、下划线与连字符，最多 200 字符。",
              );
              return;
            }
            if (c.models.some((m) => m.model === id)) {
              onError("该模型已存在。");
              return;
            }
            void addModels([id]);
          }}
        >
          <Field label="模型 ID">
            {(id) => (
              <input
                id={id}
                ref={modelInput}
                defaultValue=""
                spellCheck={false}
                maxLength={200}
                placeholder="手动填写模型 ID"
                onChange={(e) => setModelId(e.target.value)}
              />
            )}
          </Field>
          <button
            className="button"
            type="submit"
            disabled={unavailable || !modelId.trim()}
          >
            添加模型
          </button>
        </form>
        {fetched && (
          <div className="model-picker" role="group" aria-label="厂商模型列表">
            <h4>从厂商列表添加模型</h4>
            <p>列表来自该提供方，不能证明模型能力；不会移除手填模型。</p>
            {c.lastModelList &&
            !terminalStates.includes(c.lastModelList.state) ? (
              <>
                <p role="status">正在获取模型列表…</p>
                <button
                  className="button"
                  onClick={() =>
                    void command({
                      type: "stopExecution",
                      executionId: c.lastModelList!.executionId,
                    })
                  }
                >
                  取消获取
                </button>
              </>
            ) : c.modelList.state === "fetched" ? (
              <>
                <div className="model-search">
                  <Field label="搜索模型">
                    {(id) => (
                      <input
                        id={id}
                        type="search"
                        value={modelSearch}
                        placeholder="搜索模型 ID，例如 deepseek"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => setModelSearch(e.target.value)}
                      />
                    )}
                  </Field>
                  <button
                    className="button"
                    aria-label="清空模型搜索"
                    disabled={!modelSearch}
                    onClick={() => setModelSearch("")}
                  >
                    清空
                  </button>
                </div>
                <p role="status">
                  显示 {visibleModels.length} / {availableModels.length} 个模型
                  · 已选 {picked.length} 个
                </p>
                {!visibleModels.length && (
                  <p className="connection-empty">
                    没有匹配的模型，请尝试其他关键词。
                  </p>
                )}
                {visibleModels.map((m) => (
                  <label className="model-option" key={m}>
                    <input
                      type="checkbox"
                      checked={
                        c.models.some((x) => x.model === m) ||
                        picked.includes(m)
                      }
                      disabled={c.models.some((x) => x.model === m)}
                      onChange={(e) =>
                        setPicked((list) =>
                          e.target.checked
                            ? [...list, m]
                            : list.filter((x) => x !== m),
                        )
                      }
                    />
                    <span>{m}</span>
                    {c.models.some((x) => x.model === m) && (
                      <small>已添加</small>
                    )}
                  </label>
                ))}
              </>
            ) : (
              <p role="alert">
                {c.modelList.state === "failed"
                  ? `模型列表获取失败：${c.modelList.error}`
                  : "模型列表未获取"}
              </p>
            )}
            <div className="row">
              <button
                className="button primary"
                disabled={unavailable || !picked.length}
                onClick={() => void addModels(picked)}
              >
                添加选中模型
              </button>
              <button className="button" onClick={() => setFetched(false)}>
                关闭列表
              </button>
            </div>
          </div>
        )}
      </section>
      {c.provider === "custom" && (
        <button
          className="button danger"
          disabled={unavailable}
          onClick={() => setConfirm("delete")}
        >
          删除提供方…
        </button>
      )}
      {confirm && (
        <dialog
          ref={confirmation}
          onCancel={(e) => {
            e.preventDefault();
            if (!unavailable) setConfirm(undefined);
          }}
          className="confirm-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={
            confirm === "key"
              ? "移除密钥"
              : confirm === "disable"
                ? "停用提供方"
                : "删除提供方"
          }
        >
          <h3>
            {confirm === "key"
              ? "移除密钥"
              : confirm === "disable"
                ? "停用提供方"
                : "删除提供方"}
            ：{c.name}
          </h3>
          <p>它的模型将退出输入区选择器。已保存的对话、回合与名称快照保留。</p>
          {isDefault && (
            <p className="notice">
              {confirm === "delete"
                ? "请先将其他模型设为默认或取消默认，才能删除。"
                : "此操作同时取消默认模型，新对话需要重新选择，不会自动切换账户。"}
            </p>
          )}
          <p>若有活动回合或检查，必须先等待结束或停止。</p>
          <div className="row">
            <button
              className="button"
              disabled={unavailable}
              onClick={() => setConfirm(undefined)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={unavailable || (confirm === "delete" && isDefault)}
              onClick={() => void confirmAction()}
            >
              确认
              {confirm === "key"
                ? "移除密钥"
                : confirm === "disable"
                  ? "停用"
                  : "删除"}
            </button>
          </div>
        </dialog>
      )}
      {activeCheck("image_probe") &&
        !terminalStates.includes(activeCheck("image_probe")!.state) && (
          <p role="status">图片能力检测正在执行…</p>
        )}
    </article>
  );
}
function ModelRow({
  model: m,
  connection: c,
  defaultModel,
  locked,
  command,
  check,
}: {
  model: ConnectionModel;
  connection: Connection;
  defaultModel: string | null;
  locked: boolean;
  command: Send;
  check: (kind: CheckKind, model?: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [budget, setBudget] = useState(m.contextChars?.toString() ?? "");
  const isDefault = defaultModel === m.model;
  const test = m.lastTest;
  const testing = test && !terminalStates.includes(test.state);
  const [startingTest, setStartingTest] = useState(false);
  const testPending = useRef(false);
  async function testModel() {
    if (testPending.current) return;
    testPending.current = true;
    setStartingTest(true);
    try {
      await check("connection_test", m.model);
    } finally {
      testPending.current = false;
      setStartingTest(false);
    }
  }
  const probe = m.lastProbe;
  const probing = probe && !terminalStates.includes(probe.state);
  const write = (
    enabled: boolean,
    imageInput: ImageInput,
    contextChars: number | null,
  ) =>
    command({
      type: "upsertModel",
      id: c.id,
      model: m.model,
      enabled,
      imageInput,
      contextChars,
      revision: c.revision,
    });
  return (
    <div className="provider-model" role="group" aria-label={`模型 ${m.model}`}>
      <div className="provider-model-line">
        <label className="model-option">
          <input
            type="checkbox"
            aria-label={`启用模型 ${m.model}`}
            checked={m.enabled}
            disabled={locked || isDefault}
            onChange={(e) =>
              void write(e.target.checked, m.imageInput, m.contextChars)
            }
          />
          <span title={m.model}>{m.model}</span>
        </label>
        {testing ? (
          <button
            className="link-button"
            onClick={() =>
              void command({
                type: "stopExecution",
                executionId: test.executionId,
              })
            }
          >
            取消测试
          </button>
        ) : (
          <button
            className="link-button"
            disabled={locked || !c.secretRef || startingTest}
            onClick={() => void testModel()}
          >
            {startingTest ? "正在开始…" : "测试模型"}
          </button>
        )}
        {isDefault ? (
          <span className="tag default-tag">默认</span>
        ) : (
          <button
            className="link-button"
            disabled={locked || !ready(c) || !m.enabled}
            onClick={() =>
              void command({
                type: "setDefaultConnection",
                id: c.id,
                model: m.model,
              })
            }
          >
            设为默认
          </button>
        )}
        <button
          className="link-button"
          onClick={() => {
            setBudget(m.contextChars?.toString() ?? "");
            setExpanded(!expanded);
          }}
        >
          能力与预算
        </button>
        <button
          className="link-button danger"
          disabled={locked || isDefault}
          title={isDefault ? "请先把其他模型设为默认" : undefined}
          onClick={() =>
            void command({
              type: "deleteModel",
              id: c.id,
              model: m.model,
              revision: c.revision,
            })
          }
        >
          移除
        </button>
      </div>
      <p
        className={`model-capability${test?.state === "failed" ? " form-error" : ""}`}
        role="status"
        data-testid={`test-${c.id}-${m.model}`}
      >
        文本调用：
        {test
          ? test.state === "completed"
            ? "成功"
            : stateLabels[test.state]
          : "未测试"}
        {test
          ? `，${new Date(test.endedAt ?? test.createdAt).toLocaleString("zh-CN")}`
          : ""}
        {test?.errorMessage ? `：${test.errorMessage}` : ""}
      </p>
      <p className="model-capability">
        图片输入：{imageInputLabels[m.imageInput]}
        {m.imageInputCheckedAt
          ? `，检测于 ${new Date(m.imageInputCheckedAt).toLocaleString("zh-CN")}`
          : ""}
      </p>
      <EffortSummary connection={c} model={m.model} />
      {probe && (
        <p className={probe.state === "failed" ? "form-error" : "form-note"}>
          图片能力检测：
          {probe.state === "completed" ? "成功" : stateLabels[probe.state]}
          {probe.errorMessage ? "：" + probe.errorMessage : ""}
        </p>
      )}
      {expanded && (
        <div className="model-capability-form">
          <p className="form-note">
            图片能力由实际检测确认，无需手动声明。未检测时也可直接发送图片；检测会调用当前模型。
          </p>
          <Field
            label={`上下文预算（字符） ${m.model}`}
            hint={`留空采用默认 ${defaultContextChars} 字符。`}
          >
            {(id) => (
              <input
                id={id}
                inputMode="numeric"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            )}
          </Field>
          <div className="row">
            <button
              className="button"
              disabled={locked}
              onClick={() =>
                void write(
                  m.enabled,
                  m.imageInput,
                  budget.trim() ? Number(budget) : null,
                )
              }
            >
              保存能力与预算
            </button>
            {probing ? (
              <button
                className="button"
                onClick={() =>
                  void command({
                    type: "stopExecution",
                    executionId: probe.executionId,
                  })
                }
              >
                取消检测
              </button>
            ) : (
              <button
                className="button"
                disabled={locked || !c.secretRef}
                onClick={() => void check("image_probe", m.model)}
              >
                检测图片能力
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
