import { useEffect, useRef, useState } from "react";
import {
  trustBoundaryNotice,
  authorizationWindowMs,
  grantLifetimeMs,
  type Permission,
  type PermissionBlocker,
  type ToolOperation,
  type ToolState,
} from "../shared/capabilities";
import type { CapabilityCommand } from "../shared/capabilities";
import { openModal } from "./modal-focus";
const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
export const toolStateLabels: Record<ToolState, string> = {
  pending: "等待授权",
  approved: "已授权，等待读取",
  executing: "正在读取",
  completed: "读取完成",
  denied: "已拒绝",
  cancelled: "已取消",
  expired: "授权请求已过期",
  failed: "读取失败",
  unknown: "读取结果尚未确认",
  acknowledged: "已确认结果记录",
};
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
function Scope({ item }: { item: Permission | ToolOperation }) {
  return (
    <dl className="permission-scope">
      <dt>所属对话</dt>
      <dd>对话「{item.conversationTitle}」</dd>
      <dt>发送给</dt>
      <dd>
        {item.connectionName} · {item.model}
        <small>{item.baseUrl}</small>
      </dd>
      <dt>资料</dt>
      <dd>
        {item.attachmentName}
        <small>此消息所附版本 · 仅此文件</small>
      </dd>
      <dt>目的</dt>
      <dd>{item.purpose}</dd>
    </dl>
  );
}
function useCommand() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run(command: CapabilityCommand) {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      const reply = await window.desktop.command(command);
      if (!reply.ok) {
        setError(reply.message);
        return false;
      }
      return true;
    } catch {
      setError("操作未确认，请核对连接与实际状态。");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}
export function ToolPending({
  operations,
  connected,
  onOpen,
}: {
  operations: ToolOperation[];
  connected: boolean;
  onOpen: (id: string) => void;
}) {
  const { busy, error, run } = useCommand(),
    now = useNow();
  const [remember, setRemember] = useState<Record<string, boolean>>({});
  const pending = operations.filter(
    (o) => o.state === "pending" || o.state === "unknown",
  );
  return (
    <section aria-label="资料读取授权">
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {pending.map((o) => {
        const expired = Date.parse(o.expiresAt) <= now;
        return (
          <article
            key={o.id}
            className="capability-card"
            aria-label={`读取 ${o.attachmentName}`}
          >
            <h2>{toolStateLabels[o.state]}</h2>
            <Scope item={o} />
            {o.state === "pending" ? (
              <>
                <p className="quiet">
                  当前资料的正文尚未发给模型。
                  {expired
                    ? "请求已过期，请从原对话重新发起。"
                    : `请在 ${date(o.expiresAt)} 前处理。`}
                </p>
                <p className="quiet">
                  只授权读取这份资料，不代表允许创建或修改控件。
                </p>
                <label className="remember-permission">
                  <input
                    type="checkbox"
                    checked={remember[o.id] ?? false}
                    disabled={!connected || busy || expired}
                    onChange={(e) =>
                      setRemember({ ...remember, [o.id]: e.target.checked })
                    }
                  />
                  记住这份已选资料的读取授权（30天）
                </label>
                <p className="quiet">
                  {remember[o.id]
                    ? "重试同一消息时无需重复确认；新添加的资料仍会询问。可在设置的访问权限中撤销。"
                    : "默认只允许这次操作，结束后自动失效，无需到设置清理。"}
                </p>
                <div className="capability-actions">
                  {(
                    [
                      [
                        remember[o.id] ? "persist" : "once",
                        remember[o.id] ? "允许并记住30天" : "允许本次读取",
                      ],
                      ["deny", "拒绝读取"],
                    ] as const
                  ).map(([action, label]) => (
                    <button
                      key={action}
                      className={
                        action === "deny" ? "button" : "button primary"
                      }
                      disabled={!connected || busy || expired}
                      onClick={() =>
                        void run({
                          type: "resolveToolAuthorization",
                          id: o.id,
                          revision: o.revision,
                          action,
                          expiresAt: new Date(
                            Date.now() +
                              (action === "persist"
                                ? grantLifetimeMs
                                : authorizationWindowMs) -
                              1000,
                          ).toISOString(),
                        })
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="quiet">
                  拒绝后停止依赖资料的操作，仍可继续普通对话。
                </p>
                <button
                  className="link-button"
                  disabled={!connected || busy || expired}
                  onClick={() =>
                    void run({
                      type: "resolveToolAuthorization",
                      id: o.id,
                      revision: o.revision,
                      action: "cancel",
                      expiresAt: new Date(
                        Date.now() + authorizationWindowMs - 1000,
                      ).toISOString(),
                    })
                  }
                >
                  取消请求
                </button>
              </>
            ) : (
              <>
                <p>
                  读取已开始，但应用中断前没有确认结果。本工具不修改原文件；不会自动重放。已发送给提供方的数据无法收回。
                </p>
                <button
                  className="button"
                  disabled={!connected || busy}
                  onClick={() =>
                    void run({
                      type: "acknowledgeToolResult",
                      id: o.id,
                      revision: o.revision,
                    })
                  }
                >
                  已核对，保留记录
                </button>
              </>
            )}
            <button
              className="link-button"
              onClick={() => onOpen(o.conversationId)}
            >
              打开原对话
            </button>
          </article>
        );
      })}
    </section>
  );
}
function PermissionDialog({
  permission,
  enabled,
  onClose,
  connected,
}: {
  permission: Permission;
  enabled: boolean;
  onClose: () => void;
  connected: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    { busy, error, run } = useCommand();
  const [expiresAt] = useState(() =>
    new Date(Date.now() + grantLifetimeMs - 1000).toISOString(),
  );
  const [confirmUntil] = useState(() =>
    new Date(Date.now() + authorizationWindowMs - 1000).toISOString(),
  );
  useEffect(() => openModal(ref.current!), []);
  return (
    <dialog
      ref={ref}
      className="rename-dialog permission-dialog"
      aria-label={enabled ? "重新授权资料读取" : "撤销资料读取授权"}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2>{enabled ? "重新授权资料读取" : "撤销资料读取授权"}</h2>
      <Scope item={permission} />
      <p>
        {enabled
          ? `新的有效期限：${date(expiresAt)}。重新授权不会自动继续或重跑旧读取。`
          : "确认后阻止新的读取，并取消尚未确认结果的读取。已发给提供方的数据无法收回。"}
      </p>
      {error && (
        <p role="alert" className="title-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="button" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="button primary"
          disabled={!connected || busy}
          onClick={async () => {
            if (
              await run({
                type: "setPermission",
                id: permission.id,
                revision: permission.revision,
                enabled,
                expiresAt,
                confirmUntil,
              })
            )
              onClose();
          }}
        >
          {enabled ? "确认授权" : "确认撤销"}
        </button>
      </div>
    </dialog>
  );
}
const blockerText: Record<PermissionBlocker, string> = {
  execution_ended: "本次操作已结束。如需再次读取，请从聊天重新发起。",
  conversation_deleted:
    "原对话已删除。请先恢复对话；永久删除后需重新发起读取。",
  connection_unavailable: "原提供方已停用或移除。请到模型设置核对提供方。",
  destination_changed:
    "提供方的发送地址已改变。请恢复原地址，或重新发起读取并核对新目标。",
  model_unavailable: "原模型已停用或移除。请到模型设置恢复原模型。",
  material_unavailable: "原资料版本已不可用。请在聊天重新选择资料并授权。",
};
/** Fixed statement of what this phase does and does not enforce; it never depends on saved permissions. */
export function TrustBoundaryNotice() {
  return (
    <section className="trust-boundary" aria-label="首期信任边界">
      <h2>首期信任边界</h2>
      <p>{trustBoundaryNotice}</p>
    </section>
  );
}
export function PermissionSettings({
  permissions,
  connected,
  onHistory,
  onModels,
}: {
  permissions: Permission[];
  connected: boolean;
  onHistory: () => void;
  onModels: () => void;
}) {
  const [selected, setSelected] = useState<{
    permission: Permission;
    enabled: boolean;
  }>();
  const [showInactive, setShowInactive] = useState(false);
  const now = useNow();
  const active = (p: Permission) => p.valid && Date.parse(p.expiresAt) > now;
  const saved = permissions.filter((p) => p.executionId === null);
  const current = permissions.filter(
    (p) => p.executionId !== null && active(p),
  );
  const enabled = saved.filter(active),
    inactive = saved.filter((p) => !active(p));
  function card(p: Permission) {
    const isActive = active(p),
      once = p.executionId !== null;
    const state = once
      ? "本次读取中"
      : isActive
        ? "已开启"
        : p.blocker
          ? "暂不可用"
          : !p.enabled
            ? "已撤销"
            : "已到期";
    return (
      <article
        className="capability-card"
        key={p.id}
        aria-label={`授权 ${p.attachmentName}`}
      >
        <div className="permission-heading">
          <h2>{p.attachmentName}</h2>
          <span>{state}</span>
          {(!p.blocker || isActive) && (
            <button
              role="switch"
              aria-checked={isActive}
              aria-label={`读取 ${p.attachmentName}`}
              className="button"
              disabled={!connected}
              onClick={() =>
                setSelected({ permission: { ...p }, enabled: !isActive })
              }
            >
              {isActive ? "撤销授权" : "重新授权"}
            </button>
          )}
        </div>
        <Scope item={p} />
        <p className="quiet">
          {once
            ? "只允许本次操作，结束后自动失效；这张卡片随后移出列表。"
            : `记住授权至 ${date(p.expiresAt)}。只覆盖此消息所附资料；新添加资料仍需确认。`}
        </p>
        {p.blocker && (
          <p className="permission-reason">{blockerText[p.blocker]}</p>
        )}
        {p.blocker &&
          [
            "connection_unavailable",
            "destination_changed",
            "model_unavailable",
          ].includes(p.blocker) && (
            <button className="link-button" onClick={onModels}>
              前往模型设置
            </button>
          )}
      </article>
    );
  }
  return (
    <section aria-label="已保存的访问权限">
      <p className="quiet">
        这里管理你选择记住的资料读取授权。本次允许在操作结束后自动结束，拒绝和取消不会新增授权。
      </p>
      <button className="link-button permissions-history" onClick={onHistory}>
        查看读取历史
      </button>
      {!connected && (
        <p role="status" className="permission-reason">
          本地业务服务未连接，恢复连接后才能修改权限。
        </p>
      )}
      {current.length > 0 && (
        <section aria-label="当前一次性授权">
          <h2>本次读取</h2>
          {current.map(card)}
        </section>
      )}
      <h2>已记住的授权</h2>
      {enabled.length ? (
        enabled.map(card)
      ) : (
        <p className="quiet">
          没有已开启的持续授权。通常选择“允许本次读取”即可，无需在这里设置。
        </p>
      )}
      {inactive.length > 0 && (
        <>
          <button
            className="link-button"
            aria-expanded={showInactive}
            onClick={() => setShowInactive(!showInactive)}
          >
            已关闭或不可用的授权（{inactive.length}）
          </button>
          {showInactive && inactive.map(card)}
        </>
      )}
      {selected && (
        <PermissionDialog
          key={`${selected.permission.id}-${selected.permission.revision}`}
          {...selected}
          connected={connected}
          onClose={() => setSelected(undefined)}
        />
      )}
    </section>
  );
}
export function ToolHistory({ operations }: { operations: ToolOperation[] }) {
  if (!operations.length) return null;
  return (
    <ul className="tool-history" aria-label="本对话资料读取记录">
      {operations.slice(0, 20).map((o) => (
        <li key={o.id}>
          <strong>{o.attachmentName}</strong>
          <span>{toolStateLabels[o.state]}</span>
        </li>
      ))}
    </ul>
  );
}
