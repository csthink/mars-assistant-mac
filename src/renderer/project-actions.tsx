import { useEffect, useId, useRef, useState } from "react";
import {
  entryBounds,
  formProblem,
  type ActionForm,
  type PreparedProjectAction,
  type ProjectionAwaiting,
} from "../shared/project-actions";
import type { Project } from "../shared/projects";
import type {
  ProjectionAction,
  ProjectionObject,
  RuntimeOperation,
} from "../shared/runtime-host";
import type { Snapshot } from "../shared/protocol";
import { HostExecutionFact } from "./host-execution-fact";
import { openModal } from "./modal-focus";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
/** The starting value of a field; a nullable field starts as the explicit empty value null. */
function initial(form: ActionForm): unknown {
  if (form.constant !== undefined) return form.constant;
  if (form.nullable) return null;
  return filled(form);
}
/** The starting value of a field that holds a value (not null). */
function filled(form: ActionForm): unknown {
  if (form.constant !== undefined) return form.constant;
  if (form.type === "array")
    return Array.from({ length: entryBounds(form).min }, () =>
      initial(form.items!),
    );
  if (form.type === "object" && form.values) return {};
  if (form.type === "object")
    return Object.fromEntries(
      Object.entries(form.properties)
        .filter(
          ([k, f]) => form.required.includes(k) || f.constant !== undefined,
        )
        .map(([k, f]) => [k, initial(f)]),
    );
  if (form.choices?.length === 1) return form.choices[0];
  return form.type === "boolean"
    ? false
    : form.type === "integer"
      ? undefined
      : "";
}
/** Count and bounds of an array or map, and the add action. */
function EntryFooter({
  form,
  count,
  add,
}: {
  form: ActionForm;
  count: number;
  add: () => void;
}) {
  const { min, max } = entryBounds(form);
  return (
    <div className="project-action-group-footer">
      <span className="project-form-hint">
        共 {count} 项{min > 0 ? `，至少 ${min} 项` : ""}，至多 {max} 项
      </span>
      <button
        type="button"
        className="button"
        disabled={count >= max}
        onClick={add}
      >
        添加一项
      </button>
    </div>
  );
}
function ArrayField({
  form,
  value,
  change,
  title,
}: {
  form: ActionForm;
  value: unknown;
  change: (v: unknown) => void;
  title: string;
}) {
  const items = Array.isArray(value) ? value : [];
  const { min } = entryBounds(form);
  const move = (from: number, to: number) => {
    const next = [...items];
    next.splice(to, 0, ...next.splice(from, 1));
    change(next);
  };
  return (
    <fieldset className="project-action-group">
      <legend>{title}</legend>
      {form.description && (
        <p className="project-form-hint">{form.description}</p>
      )}
      {items.map((item, i) => (
        <div
          key={i}
          role="group"
          aria-label={`${title} 第 ${i + 1} 项`}
          className="project-action-entry"
        >
          <div className="project-action-entry-heading">
            <span>第 {i + 1} 项</span>
            <span className="project-action-entry-tools">
              <button
                type="button"
                className="project-text-button"
                disabled={i === 0}
                aria-label={`上移${title}第 ${i + 1} 项`}
                onClick={() => move(i, i - 1)}
              >
                上移
              </button>
              <button
                type="button"
                className="project-text-button"
                disabled={i === items.length - 1}
                aria-label={`下移${title}第 ${i + 1} 项`}
                onClick={() => move(i, i + 1)}
              >
                下移
              </button>
              <button
                type="button"
                className="project-text-button"
                disabled={items.length <= min}
                aria-label={`删除${title}第 ${i + 1} 项`}
                onClick={() => change(items.filter((_, j) => j !== i))}
              >
                删除
              </button>
            </span>
          </div>
          <Field
            form={form.items!}
            value={item}
            change={(v) => change(items.map((x, j) => (j === i ? v : x)))}
            name={`${title} 第 ${i + 1} 项`}
            bare
          />
        </div>
      ))}
      <EntryFooter
        form={form}
        count={items.length}
        add={() => change([...items, initial(form.items!)])}
      />
    </fieldset>
  );
}
/**
 * A map (`additionalProperties` schema): named entries. While a name is empty or repeated the
 * rows themselves are handed over, which the form check refuses; nothing is merged or dropped.
 */
function MapField({
  form,
  value,
  change,
  title,
}: {
  form: ActionForm;
  value: unknown;
  change: (v: unknown) => void;
  title: string;
}) {
  const [rows, setRows] = useState<[string, unknown][]>(() =>
    isRecord(value)
      ? Object.entries(value)
      : Array.isArray(value)
        ? (value as [string, unknown][])
        : [],
  );
  const emit = (next: [string, unknown][]) => {
    setRows(next);
    const names = next.map(([k]) => k);
    change(
      names.every((k) => k.length) && new Set(names).size === names.length
        ? Object.fromEntries(next)
        : next,
    );
  };
  const { min } = entryBounds(form);
  return (
    <fieldset className="project-action-group">
      <legend>{title}</legend>
      {form.description && (
        <p className="project-form-hint">{form.description}</p>
      )}
      {rows.map(([key, entry], i) => (
        <div
          key={i}
          role="group"
          aria-label={`${title} 第 ${i + 1} 项`}
          className="project-action-entry"
        >
          <div className="project-action-entry-heading">
            <span>第 {i + 1} 项</span>
            <span className="project-action-entry-tools">
              <button
                type="button"
                className="project-text-button"
                disabled={rows.length <= min}
                aria-label={`删除${title}第 ${i + 1} 项`}
                onClick={() => emit(rows.filter((_, j) => j !== i))}
              >
                删除
              </button>
            </span>
          </div>
          <label className="project-action-field">
            名称
            <input
              aria-label="名称"
              type="text"
              value={key}
              maxLength={256}
              onChange={(e) =>
                emit(
                  rows.map((r, j) =>
                    j === i ? ([e.target.value, r[1]] as [string, unknown]) : r,
                  ),
                )
              }
            />
          </label>
          <Field
            form={form.values!}
            value={entry}
            change={(v) =>
              emit(
                rows.map((r, j) =>
                  j === i ? ([r[0], v] as [string, unknown]) : r,
                ),
              )
            }
            name="内容"
          />
        </div>
      ))}
      <EntryFooter
        form={form}
        count={rows.length}
        add={() => emit([...rows, ["", initial(form.values!)]])}
      />
    </fieldset>
  );
}
function Field({
  form,
  value,
  change,
  name,
  bare = false,
}: {
  form: ActionForm;
  value: unknown;
  change: (v: unknown) => void;
  name: string;
  /** The field is the whole content of its container (the payload, an array entry): no group of its own. */
  bare?: boolean;
}) {
  const title = form.title || name;
  if (form.constant !== undefined)
    return (
      <p className="project-source">
        {title}：{String(form.constant)}
      </p>
    );
  if (form.nullable) {
    // Null is a value the person chooses, distinct from leaving an optional field out.
    const empty = value === null;
    return (
      <div className="project-action-nullable">
        <label className="project-checkbox">
          <input
            type="checkbox"
            checked={empty}
            onChange={(e) => change(e.target.checked ? null : filled(form))}
          />
          {title} 为空值（null）
        </label>
        {!empty && (
          <Field
            form={{ ...form, nullable: false }}
            value={value}
            change={change}
            name={name}
            bare={bare}
          />
        )}
      </div>
    );
  }
  if (form.type === "array")
    return (
      <ArrayField form={form} value={value} change={change} title={title} />
    );
  if (form.type === "object" && form.values)
    return <MapField form={form} value={value} change={change} title={title} />;
  if (form.type === "object") {
    const values = isRecord(value) ? value : {};
    const fields = (
      <div className="project-action-fields">
        {Object.entries(form.properties).map(([key, field]) => {
          const required =
            form.required.includes(key) || field.constant !== undefined;
          const set = (v: unknown) => change({ ...values, [key]: v });
          return (
            <div key={key} className="project-action-slot">
              {!required && (
                <label className="project-checkbox">
                  <input
                    type="checkbox"
                    checked={Object.hasOwn(values, key)}
                    onChange={(e) => {
                      if (e.target.checked) set(initial(field));
                      else
                        change(
                          Object.fromEntries(
                            Object.entries(values).filter(([k]) => k !== key),
                          ),
                        );
                    }}
                  />
                  填写{field.title || key}
                </label>
              )}
              {(required || Object.hasOwn(values, key)) && (
                <Field
                  form={field}
                  value={values[key]}
                  change={set}
                  name={key}
                />
              )}
            </div>
          );
        })}
        {form.description && (
          <p className="project-form-hint">{form.description}</p>
        )}
      </div>
    );
    return bare ? (
      fields
    ) : (
      <fieldset className="project-action-group">
        <legend>{title}</legend>
        {fields}
      </fieldset>
    );
  }
  return (
    <label className="project-action-field">
      {title}
      {form.choices ? (
        <select
          aria-label={title}
          value={value === undefined ? "" : String(value)}
          onChange={(e) =>
            change(form.choices!.find((v) => String(v) === e.target.value))
          }
        >
          <option value="">请选择</option>
          {form.choices.map((v) => (
            <option key={String(v)} value={String(v)}>
              {String(v)}
            </option>
          ))}
        </select>
      ) : form.type === "boolean" ? (
        <select
          aria-label={title}
          value={String(value)}
          onChange={(e) => change(e.target.value === "true")}
        >
          <option value="false">否</option>
          <option value="true">是</option>
        </select>
      ) : form.type === "integer" ? (
        <input
          aria-label={title}
          type="number"
          step="1"
          min={form.minimum}
          max={form.maximum}
          value={value === undefined ? "" : Number(value)}
          onChange={(e) =>
            change(e.target.value === "" ? undefined : Number(e.target.value))
          }
        />
      ) : (form.maxLength ?? Infinity) <= 1024 ||
        (form.pattern && form.maxLength === undefined) ? (
        // A bounded or patterned text (an identifier, a ref, a path, a digest) is one line; longer text keeps the text area.
        <input
          aria-label={title}
          type="text"
          value={String(value ?? "")}
          maxLength={form.maxLength}
          onChange={(e) => change(e.target.value)}
        />
      ) : (
        <textarea
          aria-label={title}
          rows={3}
          value={String(value ?? "")}
          maxLength={Math.min(form.maxLength ?? 65536, 65536)}
          onChange={(e) => change(e.target.value)}
        />
      )}
      {form.description && <small>{form.description}</small>}
      {form.pattern && (
        <small>
          格式由扩展核验：<code>{form.pattern}</code>
        </small>
      )}
    </label>
  );
}
const statusNames: Record<RuntimeOperation["status"], string> = {
  accepted: "已接纳，等待处理",
  running: "正在处理",
  succeeded: "操作已成功",
  failed: "操作失败",
  cancelled: "已取消",
  unknown: "结果待核实",
};
function Operation({
  value,
  query,
  busy,
}: {
  value: RuntimeOperation;
  query?: () => void;
  busy: boolean;
}) {
  return (
    <article
      className="project-operation"
      aria-label={`操作 ${value.operationId}`}
    >
      <strong>
        {value.transport === "lost"
          ? "应答未收到，请查询结果"
          : statusNames[value.status]}
      </strong>
      <p>{value.reason}</p>
      <p className="project-source">
        {value.operationId} ·{" "}
        {new Date(value.updatedAt).toLocaleString("zh-CN")}
      </p>
      {value.request && (
        <details className="project-operation-basis">
          <summary>本次操作依据</summary>
          <dl className="metadata">
            <dt>操作</dt>
            <dd>{String(value.request.actionId)}</dd>
            <dt>对象</dt>
            <dd>{String(value.request.objectRef)}</dd>
            <dt>核对版本</dt>
            <dd>{String(value.request.expectedRevision)}</dd>
            <dt>候选</dt>
            <dd>{String(value.request.candidateRef ?? "无独立候选")}</dd>
          </dl>
        </details>
      )}
      {value.resultCode && <p>来源结果：{value.resultCode}</p>}
      {value.errorCode && <p>核对状态：{value.errorCode}</p>}
      {query && (
        <button className="button" disabled={busy} onClick={query}>
          查询该操作
        </button>
      )}
    </article>
  );
}
export function Confirmation({
  prepared,
  close,
  changed,
  submitted,
}: {
  prepared: PreparedProjectAction;
  close: () => void;
  changed: () => void;
  submitted?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    inFlight = useRef(false);
  const [payload, setPayload] = useState(
      () => initial(prepared.form) as Record<string, unknown>,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [read, setRead] = useState<Record<number, string>>({}),
    [result, setResult] = useState<RuntimeOperation | null>(null),
    [message, setMessage] = useState("");
  useEffect(() => openModal(dialog.current!), []);
  const problem = formProblem(prepared.form, payload),
    unread = prepared.evidence.some((_, i) => !(i in read));
  async function evidence(index: number) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await window.desktop.projectAction({
        type: "evidence",
        projectId: prepared.projectId,
        token: prepared.token,
        index,
      });
      if (r.ok && r.evidence)
        setRead((old) => ({ ...old, [index]: r.evidence!.text }));
      else if (!r.ok) setError(r.message);
    } catch {
      setError("依据未读取，请保留当前确认并重试。");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function submit() {
    if (
      inFlight.current ||
      problem ||
      (prepared.action.requiresHumanDecision && (!confirmed || unread))
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await window.desktop.projectAction({
        type: "submit",
        projectId: prepared.projectId,
        token: prepared.token,
        payload,
      });
      if (!r.ok) setError(r.message);
      else {
        submitted?.();
        setResult(r.operation ?? null);
        setMessage(r.message ?? "");
      }
      changed();
    } catch {
      setError("提交结果未确认，请关闭后从操作记录查询，不要重新发起。");
      changed();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="project-action-dialog"
      aria-label="核对项目操作"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="project-section-heading">
        <h2>{prepared.action.label}</h2>
        <button className="button" disabled={busy} onClick={close}>
          关闭
        </button>
      </div>
      <p>
        <strong>{prepared.projectName}</strong> · {prepared.object.title}
      </p>
      <p className="project-source">{prepared.folder}</p>
      <p>当前状态：{prepared.object.stateLabel}</p>
      <p className="project-source">
        对象版本 {prepared.object.revision} · 操作版本{" "}
        {prepared.action.expectedRevision}
      </p>
      <p>候选：{prepared.action.candidateRef ?? "此操作没有独立候选"}</p>
      {prepared.pending && (
        <p className="project-source">
          待处理身份：{prepared.pending.itemRef} · {prepared.pending.revision}
        </p>
      )}
      {result ? (
        <>
          <Operation value={result} busy={busy} />
          <p>状态由 Runtime 返回；单次操作成功不代表任务已交付或合并。</p>
        </>
      ) : (
        <>
          <fieldset disabled={busy}>
            <Field
              form={prepared.form}
              value={payload}
              change={(v) => {
                setPayload(v as Record<string, unknown>);
                setConfirmed(false);
              }}
              name="操作输入"
              bare
            />
          </fieldset>
          {prepared.evidence.map((ref, index) => (
            <section className="project-action-evidence" key={index}>
              <button
                className="button"
                disabled={busy}
                onClick={() => void evidence(index)}
              >
                打开依据 {index + 1}
              </button>
              <span className="project-source">
                {String(ref.objectRef)} · {String(ref.revision)}
              </span>
              {index in read && <pre tabIndex={0}>{read[index]}</pre>}
            </section>
          ))}
          {prepared.action.requiresHumanDecision && (
            <label className="project-checkbox">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy || unread}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              我已核对本次操作与全部依据
            </label>
          )}
          {problem && (
            <p role="status" className="project-form-problem">
              {problem}
            </p>
          )}
          <p className="project-form-hint">
            提交会调用上面列出的操作。页面点击和请求被接纳不代表决定已经生效；以来源结果为准。
          </p>
          <button
            className="button project-primary"
            disabled={
              busy ||
              !!problem ||
              (prepared.action.requiresHumanDecision && (!confirmed || unread))
            }
            onClick={() => void submit()}
          >
            {busy ? "正在提交…" : "确认提交"}
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="project-error" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
/**
 * KB-308: the object's newest action succeeded but the projection has not caught up with it yet, so
 * the shown actions are the old ones. They stay closed; “重新同步” asks the Host for a fresh full
 * snapshot, the way out when the extension keeps the old binding (ProjectWorkspace.awaiting).
 */
export function AwaitingNote({
  awaiting,
  actions,
  instanceId,
}: {
  awaiting: ProjectionAwaiting;
  actions: ProjectionAction[];
  instanceId: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const label =
    actions.find(
      (a) =>
        a.actionId === awaiting.actionId && a.objectRef === awaiting.objectRef,
    )?.label ?? awaiting.actionId;
  async function resync() {
    setBusy(true);
    setError("");
    try {
      const r = await window.desktop.runtimeControl({
        type: "reverify",
        instanceId,
      });
      if (!r.ok) setError(r.message);
    } catch {
      setError("未能重新同步，请稍后再试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="project-awaiting" data-operation={awaiting.operationId}>
      <p role="status">
        <strong>同步中</strong>“{label}
        ”已成功，正在等待扩展送来最新状态；在此之前这里的操作暂不可用。
      </p>
      <button className="button" disabled={busy} onClick={() => void resync()}>
        {busy ? "正在同步…" : "重新同步"}
      </button>
      {error && (
        <p role="alert" className="project-error">
          {error}
        </p>
      )}
    </div>
  );
}
export function ProjectActionPanel({
  project,
  object,
  actions,
  snapshot,
  unavailable,
  awaiting,
}: {
  project: Project;
  object: ProjectionObject;
  actions: ProjectionAction[];
  snapshot: Snapshot;
  unavailable: string;
  /** KB-308: this object awaits its projection; unavailable (the existing rules) takes precedence. */
  awaiting?: ProjectionAwaiting;
}) {
  const [prepared, setPrepared] = useState<PreparedProjectAction | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [operations, setOperations] = useState<RuntimeOperation[]>([]),
    [refresh, setRefresh] = useState(0),
    [visibleCount, setVisibleCount] = useState(20);
  useEffect(() => setVisibleCount(20), [project.id, object.objectRef]);
  const history = operations.filter(
    (o) => o.request?.objectRef === object.objectRef,
  );
  const shown = actions.filter(
      (a) => a.objectRef === object.objectRef && a.scopeRef === object.scopeRef,
    ),
    rowId = useId();
  const inFlight = useRef(false),
    request = useRef(0);
  useEffect(() => {
    let active = true;
    const seq = ++request.current;
    void window.desktop
      .projectAction({ type: "list", projectId: project.id })
      .then((r) => {
        if (active && seq === request.current && r.ok && r.operations)
          setOperations(r.operations);
      })
      .catch(() => {
        if (active) setError("操作记录暂不可读。");
      });
    return () => {
      active = false;
    };
  }, [project.id, snapshot.revision, refresh]);
  async function prepare(action: ProjectionAction) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await window.desktop.projectAction({
        type: "prepare",
        projectId: project.id,
        actionId: action.actionId,
        objectRef: action.objectRef,
        expectedRevision: action.expectedRevision,
        candidateRef: action.candidateRef,
      });
      if (r.ok && r.prepared) setPrepared(r.prepared);
      else if (!r.ok) setError(r.message);
    } catch {
      setError("操作未打开，请重新读取项目。");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function query(operationId: string) {
    setBusy(true);
    setError("");
    try {
      const r = await window.desktop.projectAction({
        type: "query",
        projectId: project.id,
        operationId,
      });
      if (!r.ok) setError(r.message);
      else if (r.message) setError(r.message);
      setRefresh((v) => v + 1);
    } catch {
      setError("结果仍未核实，请稍后查询原操作。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="project-actions" aria-label="项目操作">
      <h4>可用操作</h4>
      {!shown.length && (
        <p className="project-form-hint">当前对象未提供可用操作。</p>
      )}
      {awaiting && !unavailable && project.runtime && (
        <AwaitingNote
          awaiting={awaiting}
          actions={actions}
          instanceId={project.runtime.instanceId}
        />
      )}
      {/* KB-315: one row per action, the button in one column of equal widths and a closed action's reason
          beside it; the actions that can be taken now come first, each group in the Runtime's order. */}
      <div className="project-action-list">
        {[
          ...shown.filter((a) => a.enabled),
          ...shown.filter((a) => !a.enabled),
        ].map((a) => {
          const stale = a.expectedRevision !== object.revision;
          const reason = stale
            ? "操作版本与当前投影不一致，请重新读取。"
            : !a.enabled && !awaiting
              ? `${a.disabledReason ?? ""}${a.disabledCode ? `（${a.disabledCode}）` : ""}`
              : "";
          const reasonId = `${rowId}-${a.actionId}`;
          return (
            <div key={a.actionId} className="project-action-row">
              <button
                className="button"
                disabled={
                  busy || !!unavailable || !!awaiting || !a.enabled || stale
                }
                aria-describedby={reason ? reasonId : undefined}
                onClick={() => void prepare(a)}
              >
                {a.label}
              </button>
              {reason && (
                <p id={reasonId} className="project-form-hint">
                  {reason}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="project-error">
          {error}
        </p>
      )}
      {history.length > 0 && <h4>操作记录</h4>}
      {history.slice(0, visibleCount).map((o) => (
        <Operation
          key={o.operationId}
          value={o}
          busy={busy}
          query={() => void query(o.operationId)}
        />
      ))}
      {history.length > visibleCount && (
        <button
          className="button"
          onClick={() => setVisibleCount((n) => n + 20)}
        >
          显示更早记录
        </button>
      )}
      {snapshot.runtimeExecutions
        .filter(
          (r) =>
            r.instanceId === project.runtime?.instanceId &&
            r.scopeRef === project.runtime?.scopeRef &&
            (r.domainNodeRef === object.objectRef ||
              operations.some(
                (o) =>
                  o.operationId === r.domainOperationId &&
                  o.request?.objectRef === object.objectRef,
              )),
        )
        .map((r) => (
          <HostExecutionFact
            key={r.executionRef}
            record={r}
            connections={snapshot.connections}
          />
        ))}
      {prepared && (
        <Confirmation
          key={prepared.token}
          prepared={prepared}
          close={() => setPrepared(null)}
          changed={() => setRefresh((v) => v + 1)}
        />
      )}
    </section>
  );
}
