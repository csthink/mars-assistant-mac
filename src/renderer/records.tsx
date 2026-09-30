import { recordDay } from "./record-query";
import { toolStateLabels } from "./capabilities";
import type { ToolState } from "../shared/capabilities";
import { useState } from "react";
import {
  errorClassLabels,
  eventLabels,
  type Connection,
  type ErrorClass,
  type PendingItem,
  type RunEvent,
} from "../shared/protocol";
import {
  exitClassificationLabels,
  stopReasonLabels,
  type ExitClassification,
  type HostExecutionRecord,
  type StopReason,
} from "../shared/runtime-execution";
import {
  HostExecutionFact,
  roleText,
  stopConfirmed,
  stopConfirmedResult,
  stopUnconfirmed,
} from "./host-execution-fact";

function when(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
/**
 * Events of a physical Agent execution (feature-t30) carry the executionRef; the labels come from the
 * record, never from Agent text. Every line names the role (V-19 r1: the role appeared only on the
 * submitted line, so an Implementer and a Reviewer record could not be told apart in the list); the
 * role comes from the execution record, or from the submitted payload when the record is gone.
 */
function executionSummary(
  event: RunEvent,
  executions: HostExecutionRecord[],
): string | null {
  const payload = event.payload;
  if (typeof payload.executionRef !== "string") return null;
  const record = executions.find(
    (r) => r.executionRef === payload.executionRef,
  );
  const head = `${roleText(record?.roleIntent ?? (typeof payload.roleIntent === "string" ? payload.roleIntent : null))} 执行 ${payload.executionRef.replace(/^execution:/, "").slice(0, 8)}`;
  if (event.kind === "submitted") return head;
  if (event.kind === "started")
    return `${head} 已放行 · PID ${String(payload.pid ?? "")}${payload.effort ? ` · 推理 ${String(payload.effort)}` : " · 推理 未记录"}`;
  if (event.kind === "stop_requested")
    return `${head} · 取消请求已持久化，正在按身份停止目标`;
  if (event.kind === "stopped")
    return `${head} · 停止原因 ${stopReasonLabels[payload.stopReason as StopReason] ?? String(payload.stopReason ?? "")}${classificationText(payload.classification)}${typeof payload.reclaimed === "number" && payload.reclaimed > 0 ? ` · 已回收 session 内子进程 ${String(payload.reclaimed)}` : ""}${typeof payload.remaining === "number" && payload.remaining > 0 ? ` · 未回收 ${String(payload.remaining)}` : ""}`;
  if (event.kind === "completed")
    return `${head}${payload.model ? ` · 实际模型 ${String(payload.model)}` : ""}${typeof payload.toolCalls === "number" ? ` · 工具调用 ${String(payload.toolCalls)}` : ""}${typeof payload.approvals === "number" && payload.approvals > 0 ? ` · 原生批准 ${String(payload.approvals)}` : ""}`;
  if (event.kind === "failed") {
    const cls = payload.errorClass as ErrorClass | undefined;
    return `${head} · ${cls && errorClassLabels[cls] ? errorClassLabels[cls] : "失败"}${payload.message ? `：${String(payload.message)}` : ""}`;
  }
  if (event.kind === "interrupted")
    return `${head} · 结果不明${payload.recovery ? `（${String(payload.recovery)}）` : ""}${classificationText(payload.classification)}`;
  if (event.kind === "stop_unconfirmed") {
    const escaped = Array.isArray(payload.escaped) ? payload.escaped.length : 0;
    return `${head} · 执行已取消，但它启动的 ${escaped} 个进程还在运行，等待其退出；在此之前不能更新扩展、更新应用或把项目交给别的工具`;
  }
  if (event.kind === "stop_confirmed")
    return `${head} · ${stopConfirmedResult}${typeof payload.checks === "number" ? ` · 已检查 ${String(payload.checks)} 次` : ""} · 限制已解除`;
  if (event.kind === "approval_accepted" || event.kind === "approval_rejected")
    return `${head} · 原生批准${event.kind === "approval_accepted" ? "按期望范围放行" : "与期望范围不符，已拒绝"}`;
  return null;
}
/** The exit classification (退出分类) as recorded by the port, or nothing when the event carries none. */
function classificationText(value: unknown) {
  const label =
    typeof value === "string"
      ? exitClassificationLabels[value as ExitClassification]
      : undefined;
  return label ? ` · 退出分类 ${label}` : "";
}
export function payloadSummary(
  event: RunEvent,
  executions: HostExecutionRecord[],
) {
  const payload = event.payload;
  const execution = executionSummary(event, executions);
  if (execution !== null) return execution;
  if (event.kind === "capability_changed")
    return `${String(payload.attachmentName ?? "选定资料")} · ${payload.state === "permission_enabled" ? "已重新授权" : payload.state === "permission_revoked" ? "已撤销授权" : (toolStateLabels[payload.state as ToolState] ?? "状态已更新")}`;
  if (event.kind === "conversation_changed") {
    const labels: Record<string, string> = {
      pin: "置顶",
      unpin: "取消置顶",
      unread: "标记未读",
      read: "标记已读",
      archive: "归档",
      unarchive: "取消归档",
      delete: "删除",
      restore: "恢复",
      extend: "延长保留",
      purge: "永久删除",
    };
    return `${labels[String(payload.action)] ?? "更新"} · 对话 ${String(payload.conversationId).slice(0, 8)}`;
  }
  if (event.kind === "data_migrated") {
    const converted = Array.isArray(payload.converted)
      ? (payload.converted as { name: string }[])
      : [];
    return converted.length
      ? `多模型数据升级完成。重复预设账户 ${converted.map((c) => c.name).join("、")} 已转为自定义提供方，密钥引用与历史保留。`
      : "多模型数据升级完成，原连接、密钥引用与历史保留。";
  }
  if (event.kind === "failed") {
    const cls = payload.errorClass as ErrorClass | undefined;
    return `${cls ? errorClassLabels[cls] : "失败"}${payload.message ? `：${String(payload.message)}` : ""}`;
  }
  if (event.kind === "completed" && typeof payload.models === "number")
    return `模型列表 ${payload.models} 项`;
  if (event.kind === "submitted" && payload.kind)
    return payload.kind === "connection_test"
      ? "模型测试"
      : payload.kind === "image_probe"
        ? "图片能力检测"
        : "模型列表获取";
  if (event.kind === "submitted") return "问答回合";
  if (event.kind === "late_result")
    return `终态后的回报：${String(payload.report ?? "")}`;
  if (event.kind === "pending_resolved")
    return payload.action === "retry" ? "处理方式：重试" : "处理方式：忽略";
  if (event.kind === "retried")
    return `第 ${String(payload.attempt ?? "")} 次尝试`;
  if (event.kind === "interrupted" || event.kind === "stop_requested")
    return payload.from ? `此前状态：${String(payload.from)}` : "";
  return "";
}
/** The terminal events of a physical execution whose persisted record can be opened beside the event (feature-t30 S-05). */
const settledExecutionEvents: RunEvent["kind"][] = [
  "completed",
  "failed",
  "stopped",
  "interrupted",
  "stop_unconfirmed",
  "stop_confirmed",
];
/**
 * Read-only, newest first. No retry, stop or authorization controls live here; the only
 * control is a disclosure that opens an execution's own record (the Host execution fact
 * block with its accounting) under the event that settled it.
 */
export function RunLog({
  events,
  executions = [],
  connections = [],
}: {
  events: RunEvent[];
  executions?: HostExecutionRecord[];
  connections?: Connection[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ol className="event-list" aria-label="运行事件">
      {events.map((event, index) => {
        const record =
          settledExecutionEvents.includes(event.kind) &&
          typeof event.payload.executionRef === "string"
            ? executions.find(
                (r) => r.executionRef === event.payload.executionRef,
              )
            : undefined;
        const expanded = !!record && open === event.id;
        return (
          <li key={event.id} className={`event event-${event.kind}`}>
            {(index === 0 ||
              recordDay(events[index - 1].at) !== recordDay(event.at)) && (
              <h3 className="event-date-group">{recordDay(event.at)}</h3>
            )}
            <span className="event-kind">{eventLabels[event.kind]}</span>
            <span className="event-time">{when(event.at)}</span>
            <span className="event-connection">
              {event.connection
                ? `${event.connection.name} · ${event.connection.model}${event.connection.effort ? ` · 推理 ${event.connection.effort}` : ""}`
                : typeof event.payload.agent === "string"
                  ? `${String(event.payload.agent).replace(/^agent:/, "")} · ${String(event.payload.model ?? "")}`
                  : "无连接"}
            </span>
            <span className="event-detail">
              {payloadSummary(event, executions)}
              {record && (
                <button
                  className="link-button event-record-toggle"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : event.id)}
                >
                  {expanded ? "收起执行记录" : "查看执行记录"}
                </button>
              )}
            </span>
            {expanded && record && (
              <div className="event-record">
                <HostExecutionFact record={record} connections={connections} />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
export const pendingLabels: Record<PendingItem["kind"], string> = {
  interrupted_turn: "回合被中断，结果不明",
  failed_turn: "回合失败",
  stop_unconfirmed: "停止未确认",
};
const shortRef = (executionRef: string) =>
  executionRef.replace(/^execution:/, "").slice(0, 8);
/**
 * 待处理 (LOG-02): turn items offer retry and dismiss; a stop-unconfirmed item is a Host
 * fact, not a decision (RUNTIME-04): amber, its only action is 重新检查, and its detail is
 * the Host execution fact block. It leaves this list by itself once the Host confirms the stop.
 */
export function PendingList({
  items,
  executions,
  connections,
  busy,
  onRetry,
  onDismiss,
  onRecheck,
  onOpen,
}: {
  items: PendingItem[];
  executions: HostExecutionRecord[];
  connections: Connection[];
  busy: boolean;
  onRetry?: (item: PendingItem) => void;
  onDismiss: (item: PendingItem) => void;
  onRecheck: (record: HostExecutionRecord) => void;
  onOpen: (conversationId: string) => void;
}) {
  return (
    <ul className="pending-list" aria-label="待处理事项">
      {items.map((item) => {
        const record =
          item.kind === "stop_unconfirmed" && item.executionRef
            ? executions.find((r) => r.executionRef === item.executionRef)
            : undefined;
        if (item.kind === "stop_unconfirmed")
          return (
            <StopItem
              key={item.id}
              record={record ?? null}
              createdAt={item.createdAt}
              connections={connections}
              busy={busy}
              onRecheck={onRecheck}
            />
          );
        return (
          <li key={item.id} className="pending-item" data-kind={item.kind}>
            <div>
              <strong>{pendingLabels[item.kind]}</strong>
              <p>
                {when(item.createdAt)}
                {item.conversationId && (
                  <>
                    {" · "}
                    <button
                      className="link-button"
                      onClick={() => onOpen(item.conversationId!)}
                    >
                      打开原对话
                    </button>
                  </>
                )}
              </p>
            </div>
            <div className="row">
              {onRetry && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => onRetry(item)}
                >
                  重试
                </button>
              )}
              <button
                className="button"
                disabled={busy}
                onClick={() => onDismiss(item)}
              >
                忽略
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
/** One stop-unconfirmed row (open, amber) or its resolved counterpart (green, in 已处理), with the fact block as its detail. */
function StopItem({
  record,
  createdAt,
  connections,
  busy,
  onRecheck,
}: {
  record: HostExecutionRecord | null;
  createdAt: string;
  connections: Connection[];
  busy: boolean;
  onRecheck?: (record: HostExecutionRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  const waiting = record ? stopUnconfirmed(record) : false;
  const confirmed = record ? stopConfirmed(record) : false;
  const tone = waiting ? "amber" : confirmed ? "green" : "neutral";
  const escaped = record?.stopUnconfirmed?.escaped.length ?? 0;
  const checks = record?.stopUnconfirmed?.checks ?? 0;
  return (
    <li
      className="pending-item pending-stop"
      data-kind="stop_unconfirmed"
      data-tone={tone}
    >
      <div className="pending-stop-heading">
        <div>
          <strong>
            <span className={"pending-marker " + tone} aria-hidden="true" />
            {waiting ? "有一个进程还没退出" : "已取消执行的进程已退出"}
            <span className="pending-kind">
              {pendingLabels.stop_unconfirmed}
            </span>
          </strong>
          <p>
            {when(
              confirmed && record?.stopUnconfirmed?.resolvedAt
                ? record.stopUnconfirmed.resolvedAt
                : createdAt,
            )}
            {record
              ? ` · ${roleText(record.roleIntent)} 执行 ${shortRef(record.executionRef)}`
              : ""}
            {waiting
              ? ` · 这次执行已取消，但它启动的 ${escaped} 个进程还在运行。Assistant 不会强行结束它，会每秒检查一次（已检查 ${checks} 次），它退出后本事项自动消失。在此之前不能更新扩展、更新应用或把项目交给别的工具。`
              : confirmed
                ? ` · ${stopConfirmedResult} · 已检查 ${checks} 次 · 限制已解除`
                : " · 执行记录不可用"}
          </p>
        </div>
        <div className="row">
          {record && (
            <button
              className="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "收起详情" : "查看详情"}
            </button>
          )}
          {waiting && record && onRecheck && (
            <button
              className="button"
              disabled={busy}
              onClick={() => onRecheck(record)}
            >
              重新检查
            </button>
          )}
        </div>
      </div>
      {open && record && (
        <HostExecutionFact record={record} connections={connections} />
      )}
    </li>
  );
}
/** 已处理: the stops the Host has confirmed, newest first, each with its result (the item itself is resolved in the store). */
export function ResolvedStops({
  executions,
  connections,
}: {
  executions: HostExecutionRecord[];
  connections: Connection[];
}) {
  const resolved = executions
    .filter(stopConfirmed)
    .sort((a, b) =>
      b.stopUnconfirmed!.resolvedAt!.localeCompare(
        a.stopUnconfirmed!.resolvedAt!,
      ),
    )
    .slice(0, 10);
  if (resolved.length === 0) return null;
  return (
    <section className="pending-done" aria-label="已处理">
      <h2>已处理</h2>
      <ul className="pending-list" aria-label="已处理事项">
        {resolved.map((record) => (
          <StopItem
            key={record.executionRef}
            record={record}
            createdAt={record.stopUnconfirmed!.since}
            connections={connections}
            busy
          />
        ))}
      </ul>
    </section>
  );
}
