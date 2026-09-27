import { Fragment, useEffect, useRef, useState } from "react";
import type { Project } from "../shared/projects";
import {
  proposalGrants,
  type AccessInstance,
  type ProjectAccessView,
} from "../shared/project-access";
import { RuntimeFact } from "./extensions";
import { openModal } from "./modal-focus";

const runtimeName = (runtimeId: string) => runtimeId.replace(/^runtime:/, "");
const publisherName = (id: string) => id.replace(/^publisher:/, "");
const date = (iso: string) =>
  new Date(iso).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
const dateTime = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Identifiers listed with 、; a line breaks between names, never inside one. */
function Names({ values }: { values: readonly string[] }) {
  return (
    <p className="access-review-names">
      {values.map((value, i) => (
        <Fragment key={value}>
          {i > 0 && "、"}
          <code>{value}</code>
        </Fragment>
      ))}
    </p>
  );
}

/** The review before authorizing (ACCESS-01): subject, objects, operations, impact and period; cancel sends nothing. */
function AccessReview({
  entry,
  view,
  projectName,
  busy,
  confirm,
  close,
}: {
  entry: AccessInstance;
  view: ProjectAccessView;
  projectName: string;
  busy: boolean;
  confirm: () => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => openModal(dialog.current!), []);
  const proposal = entry.proposal!;
  const total = proposalGrants(proposal).length;
  const until = new Date(Date.now() + proposal.lifetimeDays * 86_400_000);
  return (
    <dialog
      ref={dialog}
      className="project-action-dialog access-review"
      aria-label="核对扩展授权"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="project-section-heading">
        <h2>核对扩展授权</h2>
        <button className="button" disabled={busy} onClick={close}>
          关闭
        </button>
      </div>
      <p className="project-form-hint">
        确认后，扩展只能在下列对象与操作范围内访问该仓库；授权可在 设置 →
        访问权限 查看或撤销，到期后需重新核对。
      </p>
      <dl className="access-review-list">
        <dt>主体</dt>
        <dd>
          {runtimeName(proposal.runtimeId)} {proposal.version} ·{" "}
          {publisherName(proposal.publisherId)}
          <code>{proposal.instanceId}</code>
        </dd>
        <dt>对象范围</dt>
        <dd>
          项目“{projectName}”的文件夹
          <code>{proposal.folder}</code>
          <code>
            {proposal.resourceHandle} · {proposal.scopeRef}
          </code>
          {view.folder.gitRoot && view.folder.gitRoot !== proposal.folder && (
            <span>Git 仓库根 {view.folder.gitRoot}</span>
          )}
        </dd>
        <dt>能力</dt>
        <dd>
          <span>协商通过的 {proposal.capabilities.length} 项能力</span>
          <Names values={proposal.capabilities} />
        </dd>
        <dt>操作</dt>
        <dd>
          <span>读取项目状态与证据</span>
          <Names values={proposal.operations.read} />
          <span>领域操作与查询</span>
          <Names values={proposal.operations.act} />
        </dd>
        <dt>期限</dt>
        <dd>
          {proposal.lifetimeDays} 天，至 {date(until.toISOString())}
          ；共 {total} 项授权
        </dd>
      </dl>
      <section className="access-review-impact" aria-label="影响">
        <h3>影响</h3>
        <ul>
          <li>
            <strong>访问仓库</strong>
            扩展进程可按上列操作读取该文件夹中的项目状态与证据。扩展在当前 macOS
            账户内运行，这不是操作系统隔离。
          </li>
          <li>
            <strong>安装治理内容</strong>
            本次授权不复制或安装治理内容，也不修改仓库；扩展提供的安装动作须在项目内单独确认。
          </li>
          <li>
            <strong>执行</strong>
            扩展可按领域流程请求在该仓库启动 Agent
            执行；每次执行仍核对执行配置、模型与预算，不因本授权自动开始。
          </li>
          <li>
            <strong>发布</strong>
            推送、发布与合并仍需逐次人工决定，本授权不代替这些决定。
          </li>
        </ul>
      </section>
      <div className="access-review-actions">
        <button className="button" disabled={busy} onClick={close}>
          取消
        </button>
        <button
          className="button project-primary"
          disabled={busy}
          onClick={confirm}
        >
          {busy ? "正在授权…" : "确认授权"}
        </button>
      </div>
    </dialog>
  );
}

/**
 * 仓库治理接入 (spec RUNTIME-01 last paragraph, PROJECT-02): inside the project the
 * person checks the actual repository, the extension source and version and the
 * applicable authorization, and completes each step deliberately. Missing access
 * never hides independent chat or available project content.
 */
export function ProjectAccessPanel({
  project,
  revision,
  connected,
  onOpenSettings,
}: {
  project: Project;
  revision: number;
  connected: boolean;
  onOpenSettings?: (tab: "扩展管理" | "访问权限") => void;
}) {
  const [view, setView] = useState<ProjectAccessView | null>(null);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  // The step the latest message or refusal belongs to; it is shown inside that step.
  const [at, setAt] = useState<"register" | "open" | "authorize" | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    void window.desktop
      .projectAccess({ type: "read", projectId: project.id })
      .then((r) => {
        if (!active) return;
        if (r.ok) setView(r.view);
        else setError(r.message);
      })
      .catch(() => active && setError("未能读取接入状态，请重新打开项目。"));
    return () => {
      active = false;
    };
  }, [project.id, revision]);
  const instances = view?.instances ?? [];
  const entry =
    instances.find((i) => i.instanceId === chosen) ??
    instances.find((i) => i.scope?.linkedHere) ??
    instances.find((i) => i.scope) ??
    instances.find((i) => i.ready) ??
    instances[0];
  async function run(
    step: "register" | "open" | "authorize",
    label: string,
  ): Promise<boolean> {
    if (inFlight.current || (!entry && step !== "register")) return false;
    inFlight.current = true;
    setBusy(step);
    setAt(step);
    setError("");
    setMessage(label);
    try {
      const r = await window.desktop.projectAccess(
        step === "register"
          ? { type: "register", projectId: project.id }
          : step === "open"
            ? {
                type: "open",
                projectId: project.id,
                instanceId: entry!.instanceId,
              }
            : {
                type: "authorize",
                projectId: project.id,
                instanceId: entry!.instanceId,
                scopeRef: entry!.scope!.scopeRef,
                proposalDigest: entry!.proposalDigest!,
              },
      );
      if (r.view) setView(r.view);
      // The authorized step states its own result and the sync state; a second line would go stale.
      if (r.ok) setMessage(step === "authorize" ? "" : (r.message ?? ""));
      else {
        setMessage("");
        setError(r.message);
      }
      return r.ok;
    } catch {
      setMessage("");
      setError("结果未确认，请重新读取接入状态后再继续。");
      return false;
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }
  const resource = view?.resource ?? null;
  const scope = entry?.scope ?? null;
  const authorized =
    !!scope && scope.state === "active" && scope.activeGrants > 0;
  const disabled = !connected || busy !== null;
  const stepClass = (done: boolean, current: boolean) =>
    "access-step" + (done ? " done" : current ? " current" : "");
  const feedback = (step: "register" | "open" | "authorize") =>
    at === step && (
      <>
        {message && (
          <p className="access-feedback" role="status" aria-live="polite">
            {message}
          </p>
        )}
        {error && (
          <p className="project-error access-feedback" role="alert">
            {error}
          </p>
        )}
      </>
    );
  const doneTag = <span className="access-step-state">已完成</span>;
  return (
    <section
      className="project-detail-card project-access"
      aria-label="仓库治理接入"
    >
      <div className="project-section-heading">
        <h3>仓库治理接入</h3>
        <span className="access-summary" data-testid="access-summary">
          {authorized
            ? scope!.linkedHere
              ? "已接入"
              : "已授权，待关联"
            : scope?.ended?.reason === "expired"
              ? "授权已到期"
              : resource
                ? "接入未完成"
                : "未接入"}
        </span>
      </div>
      <p className="project-form-hint">
        核对实际仓库、扩展来源与版本及适用授权。登记与授权只记录身份和范围，不读取或修改文件夹内容，也不启动任务。
      </p>
      {!view && !error && <p role="status">正在读取接入状态…</p>}
      {view && (
        <>
          <dl className="access-facts">
            <dt>实际仓库</dt>
            <dd>
              <code>{view.folder.path}</code>
              {view.folder.gitRoot &&
                view.folder.gitRoot !== view.folder.path && (
                  <span>Git 仓库根 {view.folder.gitRoot}</span>
                )}
              {!view.folder.gitRoot && <span>普通文件夹（非 Git）</span>}
            </dd>
            <dt>扩展</dt>
            <dd>
              {instances.length === 0 ? (
                <span>
                  尚无可用的扩展运行包。
                  {onOpenSettings && (
                    <button
                      className="project-text-button"
                      onClick={() => onOpenSettings("扩展管理")}
                    >
                      前往扩展管理
                    </button>
                  )}
                </span>
              ) : instances.length > 1 ? (
                <select
                  aria-label="接入使用的扩展"
                  value={entry?.instanceId ?? ""}
                  disabled={disabled}
                  onChange={(e) => {
                    setChosen(e.target.value);
                    setMessage("");
                    setError("");
                    setAt(null);
                  }}
                >
                  {instances.map((i) => (
                    <option key={i.instanceId} value={i.instanceId}>
                      {runtimeName(i.runtimeId)} {i.version} · {i.state}
                    </option>
                  ))}
                </select>
              ) : (
                <span data-testid="access-extension">
                  {runtimeName(entry!.runtimeId)} {entry!.version} ·{" "}
                  {publisherName(entry!.publisherId)} · {entry!.state}
                </span>
              )}
              {entry && !entry.ready && (
                <span className="access-issue">
                  扩展实例未就绪{entry.reason ? "：" + entry.reason : ""}
                </span>
              )}
            </dd>
          </dl>
          <ol className="access-steps">
            <li className={stepClass(!!resource, !resource)}>
              <div className="access-step-heading">
                <strong>1. 登记项目文件夹</strong>
                {resource && doneTag}
                {!resource && (
                  <button
                    className="button"
                    disabled={disabled}
                    onClick={() =>
                      void run("register", "正在核对文件夹身份并登记…")
                    }
                  >
                    {busy === "register" ? "正在登记…" : "登记项目文件夹"}
                  </button>
                )}
              </div>
              {resource ? (
                <div className="runtime-facts project-runtime-facts">
                  <RuntimeFact
                    label="Runtime 资源句柄"
                    value={resource.handle}
                    target={{
                      field: "resourceHandle",
                      handle: resource.handle,
                    }}
                    hint="本项目文件夹登记为扩展资源时的身份。扩展发布方要求写入绑定信息时使用。"
                    testId="project-resource-handle"
                  />
                </div>
              ) : (
                <p className="project-form-hint">
                  只记录文件夹身份并生成资源句柄，不授予扩展任何访问。
                </p>
              )}
              {feedback("register")}
            </li>
            <li className={stepClass(!!scope, !!resource && !scope)}>
              <div className="access-step-heading">
                <strong>2. 打开项目范围</strong>
                {scope && doneTag}
                {resource && !scope && entry && (
                  <button
                    className="button"
                    disabled={disabled || !entry.ready}
                    onClick={() =>
                      void run("open", "正在请求扩展打开项目范围…")
                    }
                  >
                    {busy === "open" ? "正在打开…" : "打开项目范围"}
                  </button>
                )}
              </div>
              {scope ? (
                <p className="project-form-hint" data-testid="access-scope">
                  已打开 <code>{scope.scopeRef}</code>
                  {scope.state === "active" ? "，已授权" : "，尚未授权"}
                </p>
              ) : resource && entry ? (
                <div className="access-binding">
                  <p className="project-form-hint">
                    扩展按这个句柄识别项目文件夹。若扩展发布方要求先在本机写入绑定信息（例如
                    hp 开发包的 <code>binding write</code>
                    ），请按其说明使用下面的实例目录和上面的资源句柄写入；Assistant
                    不代写。写入后在 设置 → 扩展管理
                    点“重新连接”，再打开项目范围。
                  </p>
                  <div className="runtime-facts project-runtime-facts">
                    <RuntimeFact
                      label="实例目录"
                      value={entry.instanceDir}
                      target={{
                        field: "instanceDir",
                        instanceId: entry.instanceId,
                      }}
                      missing="扩展尚未启动，没有实例目录记录"
                      testId="access-instance-dir"
                    />
                  </div>
                </div>
              ) : null}
              {feedback("open")}
            </li>
            <li className={stepClass(authorized, !!scope && !authorized)}>
              <div className="access-step-heading">
                <strong>3. 授权扩展访问</strong>
                {authorized && doneTag}
                {scope && !authorized && (
                  <button
                    className="button"
                    disabled={
                      disabled ||
                      !entry?.ready ||
                      !entry?.proposal ||
                      !!scope.linkedElsewhere
                    }
                    onClick={() => {
                      setError("");
                      setMessage("");
                      setAt(null);
                      setReviewing(true);
                    }}
                  >
                    核对并授权…
                  </button>
                )}
              </div>
              {authorized ? (
                <p className="project-form-hint" data-testid="access-grants">
                  已授权 {scope!.activeGrants} 项
                  {scope!.expiresAt ? `，至 ${date(scope!.expiresAt)}` : ""}。
                  {onOpenSettings && (
                    <button
                      className="project-text-button"
                      onClick={() => onOpenSettings("访问权限")}
                    >
                      在访问权限中查看或撤销
                    </button>
                  )}
                </p>
              ) : scope ? (
                <p
                  className="project-form-hint"
                  data-testid="access-grant-state"
                >
                  {scope.ended?.reason === "expired"
                    ? `授权已于 ${dateTime(scope.ended.at)} 到期；重新核对范围后再授权。`
                    : scope.ended?.reason === "revoked"
                      ? `授权已于 ${dateTime(scope.ended.at)} 撤销；重新核对范围后再授权。`
                      : scope.state === "inactive"
                        ? "尚未授权；确认后扩展才能按核对的范围访问该仓库。"
                        : "授权状态待核实。"}
                </p>
              ) : (
                <p className="project-form-hint">
                  打开项目范围后，核对扩展的授权范围并确认。
                </p>
              )}
              {feedback("authorize")}
            </li>
            <li
              className={stepClass(
                !!scope?.linkedHere,
                authorized && !scope?.linkedHere,
              )}
            >
              <div className="access-step-heading">
                <strong>4. 关联项目内容</strong>
                {scope?.linkedHere && doneTag}
              </div>
              <p className="project-form-hint">
                {scope?.linkedElsewhere
                  ? `该文件夹的项目范围已由项目“${scope.linkedElsewhere.name}”关联；同一仓库不能作为两个独立项目接入。`
                  : scope?.linkedHere
                    ? authorized
                      ? "已关联，项目进度显示该扩展提供的阶段与任务。"
                      : "已关联；授权恢复前项目进度只显示最后已知内容，相关动作不可用。"
                    : authorized && scope!.freshness !== "current"
                      ? "项目数据正在同步；同步完成后在上方“项目进度”选择该项目内容并关联。"
                      : "授权后在上方“项目进度”选择该项目内容并关联。"}
              </p>
            </li>
          </ol>
        </>
      )}
      {!at && error && (
        <p className="project-error" role="alert">
          {error}
        </p>
      )}
      {reviewing && entry?.proposal && view && (
        <AccessReview
          entry={entry}
          view={view}
          projectName={project.name}
          busy={busy === "authorize"}
          close={() => setReviewing(false)}
          confirm={() =>
            void run("authorize", "正在建立授权…").then(() =>
              setReviewing(false),
            )
          }
        />
      )}
    </section>
  );
}
