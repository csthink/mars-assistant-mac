import type { Connection } from "../shared/protocol";
import {
  blockedOperationLabels,
  exitClassificationLabels,
  modelRefOf,
  stopReasonLabels,
  type ContractProcessIdentity,
  type HostExecutionRecord,
} from "../shared/runtime-execution";
import { useState } from "react";

/**
 * The reusable "Host 执行" fact block (feature-t30 S-04, RUNTIME-04): what the Host knows
 * about one physical execution, shown inside the pending item's detail here and mounted
 * on the task detail page by feature-t31. It reads the persisted record only; it never
 * rewrites a domain run state and offers no retry, publish or merge action. The only
 * action, "重新检查", is one more observation while the stop is unconfirmed; the release
 * itself is automatic once the Host has observed every escaped process gone.
 */
function when(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
function identityText(identity: ContractProcessIdentity) {
  return `PID ${identity.pid} · 启动 ${when(identity.startTime)} · 程序 ${identity.image}`;
}
/** True while the Host is still waiting for the target's escaped processes (the pending item is open). */
export function stopUnconfirmed(record: HostExecutionRecord) {
  return (
    record.state === "stopping" &&
    record.stopUnconfirmed !== null &&
    record.stopUnconfirmed.resolvedAt === null
  );
}
/** A stop the Host has since confirmed: the item is resolved and this is its result. */
export function stopConfirmed(record: HostExecutionRecord) {
  return (
    record.stopUnconfirmed !== null &&
    record.stopUnconfirmed.resolvedAt !== null
  );
}
export const stopConfirmedResult = "已确认停止（进程自行退出）";
/**
 * OD-328: people see the connection's own model id (`claude-opus-5[1m]`), found among the
 * connection's models by its Contract ref, else the model the protocol read back; the
 * Contract ref (`claude-opus-5:1m`) is never the shown value.
 */
export function displayModel(
  record: HostExecutionRecord,
  connections: Connection[],
): string | null {
  const connection = connections.find((c) => c.id === record.connectionId);
  const own = connection?.models.find(
    (m) => modelRefOf(m.model) === record.model,
  );
  return own?.model ?? record.actualBinding?.model ?? null;
}
const completenessLabels: Record<
  HostExecutionRecord["observationCompleteness"],
  string
> = { complete: "完整", partial: "部分", unknown: "未知" };
const stateText = (record: HostExecutionRecord) =>
  stopUnconfirmed(record)
    ? "有一个进程还没退出 · 等待它退出（停止未确认）"
    : stopConfirmed(record)
      ? stopConfirmedResult
      : record.state === "stopped"
        ? `已停止${record.stopReason ? `（${stopReasonLabels[record.stopReason]}）` : ""}`
        : record.state === "completed"
          ? "已完成"
          : record.state === "failed"
            ? "失败"
            : record.state === "unknown"
              ? "结果不明"
              : record.state === "running"
                ? "执行中"
                : record.state === "stopping"
                  ? "停止中"
                  : "已预约";
/** A budget stop as a person reads it (S-05); the port's own wording stays in the technical detail. */
function stopText(record: HostExecutionRecord): string | null {
  if (record.state !== "stopped" || !record.stopReason) return null;
  const budget = record.budget;
  switch (record.stopReason) {
    case "timeout":
      return `运行时间超过上限 ${budget.maxRunSeconds} 秒，Assistant 已按身份停止它。`;
    case "tool-call-budget":
      return `工具调用次数超过上限 ${budget.maxToolCalls} 次，Assistant 已按身份停止它；超出的那一次可能已经发出。`;
    case "output-limit":
      return `输出超过上限 ${budget.maxOutputBytes} 字节，Assistant 已按身份停止它。`;
    case "cancelled":
      return "已按请求取消。";
    case "signal":
      return "放行后没有得到目标的确认，Assistant 已按身份停止它。";
  }
}
/**
 * What happened, as a person reads it (OD-332): built from the record's structured fields
 * (state, stop reason, exit, accounting, approvals), never from the adapter's or the port's
 * own `reason` string, which stays in the technical detail as 端口原因.
 */
function outcomeText(record: HostExecutionRecord): string {
  const accounting = record.accounting;
  const exit = record.exit;
  const exitText = !exit
    ? "退出状态未记录"
    : exit.signal
      ? `被信号 ${exit.signal} 结束`
      : `以退出码 ${exit.code ?? "未记录"} 退出`;
  const approvals = record.approvalDecisionRefs.length;
  const work = accounting
    ? `调用工具 ${accounting.toolCalls} 次${approvals ? `，原生批准 ${approvals} 次` : ""}，用时 ${accounting.runSeconds} 秒`
    : null;
  switch (record.state) {
    case "completed":
      return `Agent 已完成这次执行${work ? `：${work}` : ""}，正常退出。`;
    case "failed":
      return (
        (exit?.signal
          ? `Agent 进程${exitText}，没有给出结果。`
          : exit && exit.code !== 0
            ? `Agent 进程${exitText}，没有给出可用的结果。`
            : "Agent 进程正常退出，但没有给出符合要求的结果。") +
        "具体说明见运行记录的“失败”事件和下方技术详情。"
      );
    case "unknown":
      return "Assistant 拿到了退出状态，但没能确认进程已经消失，结果按不明处理；它可能仍在运行。";
    case "stopped":
      return stopText(record) ?? "已停止。";
    case "running":
      return "正在执行。";
    case "stopping":
      return "正在按身份停止目标进程。";
    default:
      return "已预约，还没有启动。";
  }
}
/** The role an execution was requested for (Contract roleIntent), as the run log and the fact block name it. */
export function roleText(roleIntent: string | null | undefined): string {
  const role = String(roleIntent ?? "").replace(/^role:/, "");
  return roleLabels[role] ?? (role || "Agent");
}
const roleLabels: Record<string, string> = {
  implementer: "Implementer",
  reviewer: "Reviewer",
};
/** The stop-unconfirmed reason as a person reads it; the port's own wording stays in the technical detail. */
function reasonText(record: HostExecutionRecord) {
  const fact = record.stopUnconfirmed;
  if (!fact) return outcomeText(record);
  const escaped = fact.escaped.length;
  const unregistered = fact.escaped.filter(
    (e) => e.kind === "unregistered",
  ).length;
  const cause = record.cancelRequestedAt
    ? "取消后"
    : record.stopReason
      ? `${stopReasonLabels[record.stopReason]}停止后`
      : "退出后";
  return `${cause} Agent 的主进程已退出，但它启动的 ${escaped} 个进程${unregistered ? "（含 " + unregistered + " 个无法登记）" : ""}自己开了新的 session${fact.resolvedAt ? "，当时还在运行" : "，还在运行"}。Assistant 不会强行结束这种进程（可能误伤你在别处运行的程序），只能等它退出。`;
}

/**
 * The physical accounting of a settled execution (LOG-01): the five fields the audit
 * recomputes from the protocol output, each next to the budget it was measured against,
 * plus the exit facts and the effort level (S-05).
 */
function Accounting({ record }: { record: HostExecutionRecord }) {
  const accounting = record.accounting!;
  const exit = record.exit;
  const yesNo = (value: boolean) => (value ? "是" : "否");
  return (
    <dl className="metadata fact-accounting" aria-label="执行核算">
      <dt>工具调用</dt>
      <dd>
        {accounting.toolCalls} 次（上限 {record.budget.maxToolCalls}）
      </dd>
      <dt>时长</dt>
      <dd>
        {accounting.runSeconds} 秒（上限 {record.budget.maxRunSeconds} 秒）
      </dd>
      <dt>输出字节</dt>
      <dd>
        {accounting.outputBytes}（上限 {record.budget.maxOutputBytes}）
      </dd>
      <dt>父进程等待</dt>
      <dd>{yesNo(accounting.waited)}</dd>
      <dt>退出后进程消失</dt>
      <dd>{yesNo(accounting.pidGoneAfterExit)}</dd>
      <dt>退出</dt>
      <dd>
        {exit
          ? `${exit.signal ? `信号 ${exit.signal}` : `退出码 ${exit.code ?? "未记录"}`} · 管道${exit.pipesClosed ? "已关闭" : "未关闭"}`
          : "未记录"}
      </dd>
      <dt>推理强度</dt>
      <dd>{record.effort ?? "未记录"}</dd>
    </dl>
  );
}
export function HostExecutionFact({
  record,
  connections,
  busy = false,
  onRecheck,
}: {
  record: HostExecutionRecord;
  connections: Connection[];
  busy?: boolean;
  /** Present only where the block itself carries the action; the pending row carries its own. */
  onRecheck?: (record: HostExecutionRecord) => void;
}) {
  const [technical, setTechnical] = useState(false);
  const fact = record.stopUnconfirmed;
  const waiting = stopUnconfirmed(record);
  const model = displayModel(record, connections);
  const target = fact?.targetIdentity ?? null;
  return (
    <section
      className="host-execution-fact"
      aria-label="Host 执行事实"
      data-state={record.state}
      data-waiting={waiting ? "true" : "false"}
    >
      <h3>Host 执行</h3>
      <dl className="metadata">
        <dt>状态</dt>
        <dd>
          <span
            className={
              "fact-state " +
              (waiting ? "amber" : stopConfirmed(record) ? "green" : "")
            }
          >
            {stateText(record)}
          </span>
        </dd>
        <dt>原因</dt>
        <dd>{reasonText(record)}</dd>
        <dt>目标进程</dt>
        <dd>
          {target
            ? identityText(target)
            : record.target
              ? `PID ${record.target.pid} · 程序 ${record.target.path}`
              : "未记录"}
        </dd>
        {fact && (
          <>
            <dt>仍在运行的进程</dt>
            <dd>
              {fact.escaped.length === 0 ? (
                "无"
              ) : (
                <ul className="fact-escaped">
                  {fact.escaped.map((e) => (
                    <li key={e.identity.pid}>
                      {identityText(e.identity)}（自己的 session {e.session}，
                      {e.kind === "registered" ? "已登记" : "无法登记"}）
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            <dt>已检查</dt>
            <dd>
              {fact.checks} 次 · 最近 {when(fact.lastCheckedAt)}
              {fact.resolvedAt ? ` · 解除于 ${when(fact.resolvedAt)}` : ""}
            </dd>
          </>
        )}
        <dt>暂时不能做的事</dt>
        <dd>
          {record.blockedOperations.length
            ? record.blockedOperations
                .map((o) => blockedOperationLabels[o])
                .join("、")
            : fact
              ? "无（限制已解除）"
              : "无"}
        </dd>
        {fact && (
          <>
            <dt>什么时候解除</dt>
            <dd>
              Assistant
              每秒检查一次，看到这些进程都退出后自动解除并在运行记录追加“停止已确认”，不需要点击；“重新检查”只是立刻看一次。
            </dd>
          </>
        )}
        <dt>角色</dt>
        <dd>{roleText(record.roleIntent)}</dd>
        <dt>Agent</dt>
        <dd>{record.agent.replace(/^agent:/, "")}</dd>
        <dt>模型</dt>
        <dd>{model ?? "未记录"}</dd>
      </dl>
      {record.accounting && <Accounting record={record} />}
      {waiting && (
        <p className="fact-note" role="note">
          <strong>这里不需要你做决定。</strong>
          你可以点“重新检查”立刻看一次；进程退出后会自动处理完。在此之前不能更新扩展、更新应用或把项目交给别的工具。
        </p>
      )}
      <div className="row fact-actions">
        <button
          className="link-button"
          aria-expanded={technical}
          onClick={() => setTechnical((v) => !v)}
        >
          技术详情
        </button>
        {waiting && onRecheck && (
          <button
            className="button"
            disabled={busy}
            onClick={() => onRecheck(record)}
          >
            重新检查
          </button>
        )}
      </div>
      {technical && (
        <dl className="metadata fact-technical">
          <dt>执行引用</dt>
          <dd>
            <code>{record.executionRef}</code>
          </dd>
          <dt>Contract 引用</dt>
          <dd>
            <code>{record.model}</code>
            {model && model !== record.model ? `（显示为 ${model}）` : ""}
          </dd>
          <dt>端口与 profile</dt>
          <dd>
            {record.portId} / {record.profileId}
          </dd>
          <dt>退出分类</dt>
          <dd>
            {record.exitClassification
              ? exitClassificationLabels[record.exitClassification]
              : "未记录"}
          </dd>
          <dt>观察完整性</dt>
          <dd>{completenessLabels[record.observationCompleteness]}</dd>
          <dt>端口原因</dt>
          <dd>{record.reason}</dd>
          {fact && (
            <>
              <dt>停止未确认自</dt>
              <dd>{when(fact.since)}</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}
