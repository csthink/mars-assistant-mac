import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Snapshot } from "../shared/protocol";
import type { HostExecutionRecord } from "../shared/runtime-execution";
import { stopUnconfirmed } from "./host-execution-fact";
import { Icon } from "./icons";
import { openModal } from "./modal-focus";
import { accessOperations } from "../shared/project-access";
import {
  admissionCodeLabels,
  extensionState,
  extensionStateLabels,
  healthResultLabels,
  type ExtensionState,
  type RuntimeCopyTarget,
  type RuntimeGrant,
  type RuntimeImportReply,
  type RuntimeInstallation,
  type RuntimeInstance,
  type RuntimeOperation,
  type RuntimeResource,
  type RuntimeScope,
} from "../shared/runtime-host";
import {
  catalogEntryFor,
  extensionCatalog,
} from "../shared/runtime-capabilities";

const instanceStateLabels: Record<RuntimeInstance["state"], string> = {
  stopped: "未运行",
  starting: "正在协商",
  ready: "运行中",
  failed: "协商失败",
  exited: "已退出",
};
const healthLabels = healthResultLabels;
const badgeClass: Record<ExtensionState, string> = {
  "not-installed": "",
  available: "green",
  "connection-error": "red",
  incompatible: "amber",
  unverified: "amber",
};
function clock(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString("zh-CN", { hour12: false });
}
function dateTime(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("zh-CN", { hour12: false });
}
function CodeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />
    </svg>
  );
}
function BookIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5V5.5M8 7h8M8 11h6" />
    </svg>
  );
}

/** One catalog entry that has no verified bundle yet: shown as not installed, never as installable. */
function CatalogCard({ entry }: { entry: (typeof extensionCatalog)[number] }) {
  const [details, setDetails] = useState(false);
  return (
    <article
      className="extension-card"
      aria-label={`${entry.displayName} 扩展`}
    >
      <div className="extension-heading">
        <span className="extension-icon">
          {entry.planned ? <BookIcon /> : <CodeIcon />}
        </span>
        <div>
          <h3>{entry.displayName}</h3>
          <p>{entry.purpose}</p>
        </div>
      </div>
      <span className={"extension-badge" + (entry.planned ? "" : " muted")}>
        {entry.planned ? "规划中" : extensionStateLabels["not-installed"]}
      </span>
      <p className="extension-description">{entry.description}</p>
      {entry.planned ? (
        details && (
          <p className="extension-hint" role="status">
            整理资料、积累知识并按需检索。此扩展规划中，首阶段不提供安装或完整知识库。现有选定资料问答仍可使用。
          </p>
        )
      ) : (
        <p className="extension-hint" role="status">
          随产品提供的项目默认管理能力，尚无已核验的运行包；运行包在切片集成时接入，不提供全局启停或卸载。
        </p>
      )}
      <footer>
        {entry.planned ? (
          <button
            className="button"
            aria-expanded={details}
            onClick={() => setDetails((v) => !v)}
          >
            了解扩展
          </button>
        ) : (
          <button className="button" disabled title="更新检查在去留门后提供">
            检查更新
          </button>
        )}
      </footer>
    </article>
  );
}

const freshnessLabels: Record<RuntimeScope["freshness"], string> = {
  missing: "无投影",
  syncing: "同步中",
  current: "实时",
  stale: "过期",
};
const grantStatusLabels: Record<RuntimeGrant["status"], string> = {
  active: "有效",
  revoked: "已撤销",
  expired: "已到期",
};
/** A grant's status as of now: an active record past its expiry counts as expired, never cached. */
const grantStatus = (grant: RuntimeGrant): RuntimeGrant["status"] =>
  grant.status === "active" && Date.parse(grant.expiresAt) <= Date.now()
    ? "expired"
    : grant.status;
/** Host-issued operations that cite a grant and have no final answer yet: shown paused once the grant is revoked. */
const dependentOperations = (
  grant: RuntimeGrant,
  operations: RuntimeOperation[],
) =>
  operations.filter(
    (o) =>
      o.origin === "host" &&
      o.instanceId === grant.instanceId &&
      Array.isArray(o.request?.grantRefs) &&
      (o.request!.grantRefs as { id: string }[]).some(
        (r) => r.id === grant.ref.id,
      ) &&
      !["succeeded", "failed", "cancelled"].includes(o.status),
  );
const upgradeStatusLabels: Record<string, string> = {
  prepared: "已准备（屏障保持）",
  blocked: "被阻止（固定结果）",
  released: "已释放",
  unknown: "结果未知",
};
/** Host records only: scope sync state, grant counts, the latest operations and the upgrade state; no Runtime text is interpreted here. */
function Diagnostics({
  instance,
  scopes,
  grants,
  operations,
}: {
  instance: RuntimeInstance | undefined;
  scopes: RuntimeScope[];
  grants: RuntimeGrant[];
  operations: RuntimeOperation[];
}) {
  const counts = { active: 0, revoked: 0, expired: 0 };
  for (const grant of grants) counts[grantStatus(grant)] += 1;
  const upgrades = operations.filter(
    (o) => o.method === "runtime.upgrade.prepare",
  );
  const process = !instance
    ? "未启动"
    : instance.pid
      ? `${instanceStateLabels[instance.state]}，PID ${instance.pid}，启动 ${instance.startedAt ? clock(instance.startedAt) : "未知"}`
      : instance.exit
        ? `${instanceStateLabels[instance.state]}，退出码 ${instance.exit.code ?? "无"}，信号 ${instance.exit.signal ?? "无"}，${clock(instance.exit.at)}`
        : instanceStateLabels[instance.state];
  const protocol = !instance?.negotiation
    ? instance?.failure
      ? `协商失败 ${instance.failure.code}`
      : "尚未协商"
    : `${instance.negotiation.selectedProtocol.version}，健康 ${
        instance.health
          ? `${healthLabels[instance.health.result]}${instance.health.reason ? `（${instance.health.reason}）` : ""}，${clock(instance.health.at)}`
          : "尚未完成"
      }`;
  return (
    <details className="extension-diagnostics">
      <summary>运行诊断</summary>
      <p data-testid="extension-process">进程 {process}</p>
      <p data-testid="extension-protocol">协议 {protocol}</p>
      <p data-testid="extension-grants">
        授权 有效 {counts.active}，已撤销 {counts.revoked}，已到期{" "}
        {counts.expired}
      </p>
      {scopes.length === 0 ? (
        <p className="extension-hint">
          尚未接入项目资源（项目组织在 feature-t31）。
        </p>
      ) : (
        <ul className="extension-scopes" aria-label="scope 同步状态">
          {scopes.map((scope) => (
            <li key={scope.scopeRef} data-testid="extension-scope">
              <code>{scope.scopeRef}</code>
              <span>{scope.state === "active" ? "已授权" : "未授权"}</span>
              <span data-testid="scope-freshness">
                {freshnessLabels[scope.freshness]}
              </span>
              <span data-testid="scope-cursor">
                {scope.cursor
                  ? `水位 ${scope.cursor.epoch} / ${scope.cursor.seq}`
                  : "无水位"}
              </span>
              <span>
                对象 {scope.counts?.objects ?? 0}，操作{" "}
                {scope.counts?.actionsEnabled ?? 0}/{scope.counts?.actions ?? 0}
                ，待处理 {scope.counts?.pending ?? 0}
              </span>
              {scope.lastError && (
                <span className="extension-issue">
                  {scope.lastError.code}：{scope.lastError.message}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {operations.length > 0 && (
        <ul className="extension-operations" aria-label="最近操作">
          {operations.slice(0, 8).map((operation) => (
            <li key={operation.operationId} data-testid="extension-operation">
              <code>
                {operation.request &&
                typeof operation.request.actionId === "string"
                  ? String(operation.request.actionId)
                  : operation.method}
              </code>
              <span>{operation.status}</span>
              <span>
                {operation.resultCode ?? operation.errorCode ?? ""}
                {operation.recovery ? `，恢复 ${operation.recovery}` : ""}
                {operation.transport === "lost" ? "（应答丢失）" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {upgrades.length > 0 && (
        <ul className="extension-operations" aria-label="升级操作">
          {upgrades.slice(0, 3).map((operation) => {
            const result = operation.result as {
              upgrade: { status: string; barrierRef: string | null } | null;
              hostBarrier: { established: boolean; releasedAt: string | null };
            } | null;
            return (
              <li key={operation.operationId} data-testid="extension-upgrade">
                <code>升级准备</code>
                <span>
                  {result?.upgrade
                    ? (upgradeStatusLabels[result.upgrade.status] ??
                      result.upgrade.status)
                    : operation.resultCode === "HOST_BARRIER"
                      ? "Host 屏障未建立"
                      : operation.transport === "lost"
                        ? "应答丢失"
                        : operation.status}
                </span>
                <span>
                  {result?.hostBarrier.established &&
                  !result.hostBarrier.releasedAt
                    ? "Host 屏障保持"
                    : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

/**
 * One persisted runtime fact shown read-only (OD-412): the value comes from the Host
 * records and the copy button asks the main process to copy that same record, so what
 * reaches the clipboard is never text the page supplies.
 */
export function RuntimeFact({
  label,
  value,
  target,
  missing,
  hint,
  testId,
}: {
  label: string;
  value: string | null;
  target?: RuntimeCopyTarget | null;
  missing?: string;
  hint?: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), copiedMs);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    if (!target) return;
    setProblem("");
    const reply = await window.desktop.copyRuntimeValue(target);
    if (reply.ok) setCopied(true);
    else setProblem(reply.message);
  }
  return (
    <div className="runtime-fact" data-testid={testId}>
      <div className="runtime-fact-heading">
        <span>{label}</span>
        {value && target && (
          <button
            className="button small"
            aria-label={`复制${/^[A-Za-z]/.test(label) ? " " : ""}${label}`}
            onClick={() => void copy()}
          >
            {copied ? "已复制" : "复制"}
          </button>
        )}
      </div>
      {value ? (
        <code data-testid={testId ? testId + "-value" : undefined}>
          {value}
        </code>
      ) : (
        <span className="runtime-fact-missing">{missing ?? "未记录"}</span>
      )}
      {hint && <p className="runtime-fact-hint">{hint}</p>}
      {problem && (
        <p className="runtime-fact-hint extension-issue" role="status">
          {problem}
        </p>
      )}
    </div>
  );
}
const copiedMs = 2000;
/**
 * 接入信息 (OD-412): where this installation actually runs on this machine, from the
 * persisted launch record, and the publisher key pinned for it. A provider's binding
 * step (for example hp binding write) uses these values; nothing here changes them.
 */
function AccessFacts({
  installation,
  instance,
}: {
  installation: RuntimeInstallation;
  instance: RuntimeInstance | undefined;
}) {
  const directories = instance?.launchDirectories;
  return (
    <details className="extension-access" data-testid="extension-access">
      <summary>接入信息</summary>
      <p>本机记录的实际位置与发布者身份，只读显示。</p>
      <div className="runtime-facts">
        <RuntimeFact
          label="实例"
          value={instance?.instanceId ?? null}
          missing="尚未建立实例"
          testId="fact-instance"
        />
        <RuntimeFact
          label="实例目录"
          value={directories?.instanceDir ?? null}
          target={
            instance
              ? { field: "instanceDir", instanceId: instance.instanceId }
              : null
          }
          missing="尚未启动，没有记录"
          testId="fact-instance-dir"
        />
        <RuntimeFact
          label="包目录"
          value={directories?.packageDir ?? null}
          target={
            instance
              ? { field: "packageDir", instanceId: instance.instanceId }
              : null
          }
          missing="尚未启动，没有记录"
          testId="fact-package-dir"
        />
        <RuntimeFact
          label="发布者公钥摘要"
          value={installation.publicKeyDigest}
          target={{
            field: "publicKeyDigest",
            installationId: installation.installationId,
          }}
          hint="公钥 SPKI 的 SHA-256。首次导入该扩展时按此摘要固定发布者，请与发布方另行提供的摘要核对。"
          testId="fact-publisher-key"
        />
      </div>
    </details>
  );
}

/** UI-03: a stop-unconfirmed execution is a reference that holds the extension's upgrade until the target's processes are gone. */
const heldBlockReason = (held: HostExecutionRecord[]) =>
  held.length
    ? `有一次已取消的执行还剩进程没退出，等它退出后才能更新（${held.length} 项，见待处理）。`
    : "";
function InstallationCard({
  installation,
  instance,
  scopes,
  grants,
  operations,
  executions,
  connected,
}: {
  installation: RuntimeInstallation;
  instance: RuntimeInstance | undefined;
  scopes: RuntimeScope[];
  grants: RuntimeGrant[];
  operations: RuntimeOperation[];
  executions: HostExecutionRecord[];
  connected: boolean;
}) {
  const held = executions.filter(stopUnconfirmed);
  const [busy, setBusy] = useState<"reconnect" | "reverify" | null>(null);
  const [notice, setNotice] = useState("");
  // The incarnation a reconnect started from: the result names the new connection's real state, never "recovered".
  const [reconnected, setReconnected] = useState<string | null>(null);
  const reconnectDone =
    reconnected !== null &&
    busy === null &&
    !!instance &&
    instance.incarnationId !== reconnected &&
    instance.state !== "starting";
  useEffect(() => {
    if (!reconnectDone) return;
    const timer = setTimeout(() => setReconnected(null), reconnectResultMs);
    return () => clearTimeout(timer);
  }, [reconnectDone]);
  const catalog = catalogEntryFor(installation.runtimeId);
  const name =
    catalog?.displayName ?? installation.runtimeId.replace(/^runtime:/, "");
  // An uncatalogued runtime is described by its capability ids, each kept on one line.
  const purpose = catalog?.purpose ?? (
    <NameList values={installation.capabilities.map((c) => c.id)} />
  );
  const { state, reason } = extensionState(installation, instance, scopes);
  async function control(type: "reconnect" | "reverify") {
    if (!instance || busy) return;
    setBusy(type);
    setReconnected(null);
    setNotice(
      type === "reconnect"
        ? "已发出重新连接请求，等待协商与健康检查…"
        : "已发出重新核实请求…",
    );
    const from = instance.incarnationId ?? "";
    try {
      const reply = await window.desktop.runtimeControl({
        type,
        instanceId: instance.instanceId,
      });
      setNotice(reply.ok ? "" : reply.message);
      if (reply.ok && type === "reconnect") setReconnected(from);
    } finally {
      setBusy(null);
    }
  }
  return (
    <article
      className="extension-card"
      aria-label={`${name} 扩展`}
      aria-busy={busy !== null}
      data-state={state}
    >
      <div className="extension-heading">
        <span className="extension-icon">
          <CodeIcon />
        </span>
        <div>
          <h3>{name}</h3>
          <p>{purpose}</p>
        </div>
      </div>
      <span
        className={"extension-badge " + badgeClass[state]}
        data-testid="extension-state"
      >
        {extensionStateLabels[state]}
      </span>
      <p className="extension-description">
        {catalog?.description ??
          `由 ${installation.publisherId.replace(/^publisher:/, "")} 提供的扩展。`}
      </p>
      <dl className="extension-metadata">
        <dt>扩展版本</dt>
        <dd data-extension-version>{installation.version}</dd>
        <dt>维护来源</dt>
        <dd>
          {installation.publisherId.replace(/^publisher:/, "")}（密钥{" "}
          {installation.publicKeyDigest.slice(0, 8)}）
        </dd>
        <dt>运行状态</dt>
        <dd>
          {instance ? instanceStateLabels[instance.state] : "未启动"}
          {instance?.pid ? `，PID ${instance.pid}` : ""}
        </dd>
        <dt>健康检查</dt>
        <dd data-testid="extension-health">
          {instance?.health
            ? `${healthLabels[instance.health.result]}${instance.health.reason ? `（${instance.health.reason}）` : ""}，${clock(instance.health.at)}`
            : "尚未完成"}
        </dd>
      </dl>
      {state !== "available" && (
        <p className="extension-hint extension-issue" role="status">
          {state === "incompatible" && installation.incompatibility
            ? `${admissionCodeLabels[installation.incompatibility.code]}：${reason}`
            : state === "connection-error"
              ? `${reason}。项目内容保留，重新连接不会自动继续任务或重放操作。`
              : reason}
        </p>
      )}
      {notice && (
        <p className="extension-hint" role="status" aria-live="polite">
          {notice}
        </p>
      )}
      {reconnectDone && (
        <p
          className="extension-hint"
          role="status"
          aria-live="polite"
          data-testid="reconnect-result"
        >
          已建立新的连接，当前状态：{extensionStateLabels[state]}。
        </p>
      )}
      {held.length > 0 && (
        <p
          className="extension-hint extension-issue"
          role="status"
          data-testid="extension-blocked"
        >
          {heldBlockReason(held)}
        </p>
      )}
      <Diagnostics
        instance={instance}
        scopes={scopes}
        grants={grants}
        operations={operations}
      />
      <AccessFacts installation={installation} instance={instance} />
      <footer>
        {(state === "connection-error" ||
          (state === "unverified" && instance?.state !== "starting")) &&
          instance && (
            <button
              className="button"
              disabled={busy !== null || !connected}
              onClick={() => control("reconnect")}
            >
              {busy === "reconnect" ? "正在重新连接…" : "重新连接"}
            </button>
          )}
        {state === "unverified" &&
          instance &&
          instance.state !== "starting" && (
            <button
              className="button"
              disabled={busy !== null || !connected}
              onClick={() => control("reverify")}
            >
              {busy === "reverify" ? "正在重新核实…" : "重新核实"}
            </button>
          )}
        {state === "incompatible" ? (
          <button className="button" disabled title="适用更新在去留门后提供">
            查看适用更新
          </button>
        ) : (
          <button
            className="button"
            disabled
            title={
              held.length
                ? heldBlockReason(held).replace(/。$/, "")
                : "更新检查在去留门后提供"
            }
          >
            检查更新
          </button>
        )}
      </footer>
    </article>
  );
}

export function ExtensionSettings({
  snapshot,
  connected,
}: {
  snapshot: Snapshot | undefined;
  connected: boolean;
}) {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<RuntimeImportReply | null>(null);
  // The outcome also flashes as a self-dismissing notice: the inline line below the
  // import row is easy to miss right after the directory dialog closes (V-15 r1).
  const [flash, setFlash] = useState<{
    id: number;
    result: RuntimeImportReply;
  }>();
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(undefined), importFlashMs);
    return () => clearTimeout(timer);
  }, [flash]);
  // KB-316: the notice is fixed at the bottom of the window. The space it takes stays free below the import
  // row (kept after the notice leaves, so nothing jumps), and while it shows the row is kept above it: the
  // new card grows as its checks arrive and would otherwise push the row and the cards' buttons under it.
  const importRow = useRef<HTMLDivElement>(null),
    flashBox = useRef<HTMLDivElement>(null),
    [clearance, setClearance] = useState(0);
  useLayoutEffect(() => {
    const box = flashBox.current?.getBoundingClientRect();
    if (box)
      setClearance((c) => Math.max(c, Math.ceil(innerHeight - box.top) + 12));
  }, [flash]);
  useEffect(() => {
    const row = importRow.current;
    if (!flash || !clearance || !row) return;
    row.style.scrollMarginBottom = `${clearance}px`;
    const keep = () => row.scrollIntoView({ block: "nearest" });
    keep();
    const observer = new ResizeObserver(keep);
    observer.observe(row.parentElement!);
    return () => observer.disconnect();
  }, [flash, clearance]);
  const installations = snapshot?.runtimeInstallations ?? [];
  const instances = snapshot?.runtimeInstances ?? [];
  const matched = new Set(installations.map((i) => i.runtimeId));
  async function importBundle() {
    if (importing) return;
    setImporting(true);
    setResult(null);
    try {
      const reply = await window.desktop.importRuntimeBundle();
      setResult(reply);
      if (reply.ok || reply.code !== "CANCELLED")
        setFlash({ id: Date.now(), result: reply });
    } finally {
      setImporting(false);
    }
  }
  return (
    <>
      <p className="muted extension-lead">
        通过扩展，为 Assistant 添加专业能力。
      </p>
      <div className="extension-grid">
        {extensionCatalog
          .filter(
            (entry) =>
              !entry.planned &&
              !(entry.runtimeId && matched.has(entry.runtimeId)),
          )
          .map((entry) => (
            <CatalogCard key={entry.key} entry={entry} />
          ))}
        {installations.map((installation) => (
          <InstallationCard
            key={installation.installationId}
            installation={installation}
            instance={instances.find(
              (i) => i.installationId === installation.installationId,
            )}
            scopes={(snapshot?.runtimeScopes ?? []).filter(
              (s) => s.installationId === installation.installationId,
            )}
            grants={(snapshot?.runtimeGrants ?? []).filter(
              (g) => g.installationId === installation.installationId,
            )}
            operations={(snapshot?.runtimeOperations ?? []).filter(
              (o) => o.installationId === installation.installationId,
            )}
            executions={(snapshot?.runtimeExecutions ?? []).filter(
              (r) => r.installationId === installation.installationId,
            )}
            connected={connected}
          />
        ))}
        {extensionCatalog
          .filter((entry) => entry.planned)
          .map((entry) => (
            <CatalogCard key={entry.key} entry={entry} />
          ))}
      </div>
      <div className="setting-row extension-import" ref={importRow}>
        <div>
          <strong>从本地导入运行包</strong>
          <p>
            选择一个包含 bundle.tar、release.json、release.sig 与 publisher.pub
            的目录。导入前核对签名、发布者、逐文件摘要、平台与协议版本；来源可信不等于隔离已验证。
          </p>
          {result && (
            <p
              className="extension-import-result"
              role="status"
              aria-live="polite"
              data-testid="import-result"
            >
              {importResultText(result)}
            </p>
          )}
          {result?.ok &&
            !result.existing &&
            result.publisherPin === "first-use" && (
              <p className="extension-import-result" data-testid="import-pin">
                首次导入该扩展，已按本次携带的公钥固定发布者（摘要{" "}
                {result.publicKeyDigest.slice(0, 12)}
                …）。完整摘要见扩展卡片的“接入信息”，请与发布方另行提供的摘要核对。
              </p>
            )}
        </div>
        <button
          className="button"
          disabled={importing || !connected}
          onClick={importBundle}
        >
          {importing ? "正在导入…" : "从本地导入运行包…"}
        </button>
      </div>
      {clearance > 0 && (
        <div
          className="extension-import-clearance"
          style={{ height: clearance }}
        />
      )}
      {flash && (
        <div
          key={flash.id}
          ref={flashBox}
          className="extension-import-flash"
          data-outcome={
            flash.result.ok
              ? flash.result.existing
                ? "existing"
                : flash.result.incompatible
                  ? "incompatible"
                  : "accepted"
              : "rejected"
          }
          role={flash.result.ok ? "status" : "alert"}
          data-testid="import-flash"
        >
          <span>{importResultText(flash.result)}</span>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setFlash(undefined)}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
    </>
  );
}
/** Shown for this long, then removed on its own; the inline result line stays. */
export const importFlashMs = 6000;
/** How long the result of a reconnect stays on the card. */
const reconnectResultMs = 20000;
function importResultText(result: RuntimeImportReply) {
  return result.ok
    ? result.existing
      ? "该版本已导入过且内容相同，未新建安装。"
      : result.incompatible
        ? "已核验身份，但与本机不兼容，未启动。"
        : "已导入并开始可用性检查。"
    : result.code === "CANCELLED"
      ? "已取消导入。"
      : result.code === "UNAVAILABLE"
        ? result.reasons.join("；")
        : `导入被拒绝（${result.code}，${admissionCodeLabels[result.code]}）：${result.reasons.join("；")}`;
}

/** Grants confirmed together (same authorization id and current status) are one authorization entry. */
interface GrantGroup {
  key: string;
  grants: RuntimeGrant[];
  status: RuntimeGrant["status"];
}
function grantGroups(grants: RuntimeGrant[]): GrantGroup[] {
  const groups = new Map<string, GrantGroup>();
  for (const grant of grants) {
    const status = grantStatus(grant);
    // One reviewed authorization shares an id; a grant created alone is its own entry.
    const key = [grant.authorizationId ?? grant.ref.id, status].join("|");
    const group = groups.get(key) ?? { key, grants: [], status };
    group.grants.push(grant);
    groups.set(key, group);
  }
  // Usable authorizations first, then the newest.
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.status === "active") - Number(a.status === "active") ||
      b.grants[0].createdAt.localeCompare(a.grants[0].createdAt),
  );
}
/** Operation names in the entry's reading order (read, then act), others after, alphabetically. */
const operationOrder: string[] = [
  ...accessOperations.read,
  ...accessOperations.act,
];
const byOperation = (a: string, b: string) =>
  (operationOrder.indexOf(a) + 1 || 99) -
    (operationOrder.indexOf(b) + 1 || 99) || a.localeCompare(b);
const unique = (values: string[]) => [...new Set(values)];
/** Identifiers (capability ids, operation names) listed with 、: a line breaks between names, never inside one. */
function NameList({ values }: { values: string[] }) {
  return values.map((value, i) => (
    <Fragment key={value}>
      {i > 0 && "、"}
      <span className="identifier-name">{value}</span>
    </Fragment>
  ));
}
/** ACCESS-01: revocation happens only after the person confirms what it stops. */
function RevokeGrants({
  group,
  name,
  resourcePath,
  busy,
  connected,
  confirm,
  close,
}: {
  group: GrantGroup;
  name: string;
  resourcePath: string;
  busy: boolean;
  connected: boolean;
  confirm: () => void;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => openModal(ref.current!), []);
  const first = group.grants[0];
  return (
    <dialog
      ref={ref}
      className="rename-dialog permission-dialog"
      aria-label="撤销扩展授权"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <h2>撤销扩展授权</h2>
      <dl className="permission-scope">
        <dt>主体</dt>
        <dd>
          {name}（<code>{first.instanceId}</code>）
        </dd>
        <dt>能力</dt>
        <dd>
          <NameList
            values={unique(group.grants.map((g) => g.capability)).sort()}
          />
        </dd>
        <dt>操作</dt>
        <dd>
          <NameList
            values={unique(group.grants.map((g) => g.operation)).sort(
              byOperation,
            )}
          />
        </dd>
        <dt>对象</dt>
        <dd className="data-path">{resourcePath}</dd>
        <dt>期限</dt>
        <dd>至 {dateTime(first.expiresAt)}</dd>
      </dl>
      <p>
        确认后阻止扩展的新访问，依赖这些授权且尚无最终应答的操作暂停；已经读取的内容无法收回。重新授权需要重新核对范围，不会自动继续旧操作。
      </p>
      <div className="dialog-actions">
        <button className="button" disabled={busy} onClick={close}>
          取消
        </button>
        <button
          className="button primary"
          disabled={!connected || busy}
          onClick={confirm}
        >
          {busy ? "正在撤销…" : "确认撤销"}
        </button>
      </div>
    </dialog>
  );
}
/**
 * 访问权限 → 扩展授权: every authorization the Host holds for an extension, with its
 * subject (runtimeId and instance), capabilities and operations, resource, expiry and
 * status. Grants confirmed together are listed as one authorization. Revoking asks for
 * confirmation and takes effect the moment the Host persists it; operations that cite
 * a revoked grant and have no final answer are shown paused.
 */
export function ExtensionGrants({
  snapshot,
  connected,
}: {
  snapshot: Snapshot | undefined;
  connected: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState<GrantGroup | null>(null);
  const grants = snapshot?.runtimeGrants ?? [];
  const installations = snapshot?.runtimeInstallations ?? [];
  const resources: RuntimeResource[] = snapshot?.runtimeResources ?? [];
  const operations = snapshot?.runtimeOperations ?? [];
  const name = (installationId: string) => {
    const installation = installations.find(
      (i) => i.installationId === installationId,
    );
    return installation
      ? (catalogEntryFor(installation.runtimeId)?.displayName ??
          installation.runtimeId.replace(/^runtime:/, ""))
      : installationId;
  };
  const pathOf = (grant: RuntimeGrant) =>
    resources.find((r) => r.handle === grant.resourceHandle)?.path ??
    grant.resourceHandle;
  async function revoke(group: GrantGroup) {
    if (busy) return;
    setBusy(group.key);
    setNotice("");
    try {
      const first = group.grants[0];
      const reply = await window.desktop.runtimeControl(
        group.grants.length === 1
          ? {
              type: "revokeGrant",
              instanceId: first.instanceId,
              grantId: first.ref.id,
            }
          : {
              type: "revokeGrants",
              instanceId: first.instanceId,
              grantIds: group.grants.map((g) => g.ref.id),
            },
      );
      setNotice(reply.ok ? "" : reply.message);
      if (reply.ok) setConfirming(null);
    } finally {
      setBusy(null);
    }
  }
  const groups = grantGroups(grants);
  return (
    <section aria-label="扩展授权" className="extension-grants">
      <h2>扩展授权</h2>
      <p className="quiet">
        扩展只能在这里列出的授权范围内读取资源；撤销经确认后立即生效，依赖该授权且尚无最终应答的操作暂停，重新授权会建立新的授权引用。
      </p>
      {notice && (
        <p role="status" className="permission-reason">
          {notice}
        </p>
      )}
      {groups.length === 0 ? (
        <p className="quiet">尚无扩展授权。</p>
      ) : (
        <ul className="extension-grant-list">
          {groups.map((group) => {
            const status = group.status;
            const first = group.grants[0];
            const paused =
              status === "active"
                ? []
                : group.grants.flatMap((g) =>
                    dependentOperations(g, operations),
                  );
            const single = group.grants.length === 1;
            const capabilities = unique(
              group.grants.map((g) => g.capability),
            ).sort();
            const operationNames = unique(
              group.grants.map((g) => g.operation),
            ).sort(byOperation);
            return (
              <li
                key={group.key}
                className="extension-grant"
                data-testid="extension-grant"
                data-status={status}
              >
                <div className="extension-grant-heading">
                  <strong>{name(first.installationId)}</strong>
                  <span
                    className={
                      "extension-badge " +
                      (status === "active" ? "green" : "muted")
                    }
                    data-testid="grant-status"
                  >
                    {grantStatusLabels[status]}
                  </span>
                  {status === "active" && (
                    <button
                      className="button"
                      disabled={!connected || busy !== null}
                      aria-label={
                        single
                          ? `撤销 ${first.capability} 对 ${pathOf(first)} 的授权`
                          : `撤销 ${first.purpose} 的 ${group.grants.length} 项授权`
                      }
                      onClick={() => setConfirming(group)}
                    >
                      撤销
                    </button>
                  )}
                </div>
                <dl className="extension-metadata">
                  <dt>实例</dt>
                  <dd>
                    <code>{first.instanceId}</code>
                  </dd>
                  {single ? (
                    <>
                      <dt>能力</dt>
                      <dd>
                        {first.capability}（{first.operation}）
                      </dd>
                    </>
                  ) : (
                    <>
                      <dt>能力</dt>
                      <dd data-testid="grant-capabilities">
                        <NameList values={capabilities} />
                      </dd>
                      <dt>操作</dt>
                      <dd data-testid="grant-operations">
                        <NameList values={operationNames} />
                        （共 {group.grants.length} 项）
                      </dd>
                    </>
                  )}
                  <dt>资源</dt>
                  <dd className="data-path">{pathOf(first)}</dd>
                  <dt>期限</dt>
                  <dd>
                    {status === "revoked" && first.revokedAt
                      ? `已于 ${dateTime(first.revokedAt)} 撤销`
                      : `至 ${dateTime(first.expiresAt)}`}
                  </dd>
                  <dt>用途</dt>
                  <dd>{first.purpose}</dd>
                </dl>
                {paused.length > 0 && (
                  <p
                    className="extension-hint extension-issue"
                    role="status"
                    data-testid="grant-paused"
                  >
                    依赖操作已暂停：
                    {unique(
                      paused.map((o) =>
                        typeof o.request?.actionId === "string"
                          ? String(o.request.actionId)
                          : o.method,
                      ),
                    ).join("、")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {confirming && (
        <RevokeGrants
          group={confirming}
          name={name(confirming.grants[0].installationId)}
          resourcePath={pathOf(confirming.grants[0])}
          busy={busy === confirming.key}
          connected={connected}
          confirm={() => void revoke(confirming)}
          close={() => setConfirming(null)}
        />
      )}
    </section>
  );
}
