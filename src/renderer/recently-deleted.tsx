import { useRef, useState } from "react";
import type { Conversation, Snapshot } from "../shared/protocol";
import { Icon } from "./icons";
import { Callout, DeletionDialog, ImpactList } from "./deletion-dialogs";
import { useToday } from "./organization";

/** How many days before the end of the retention the 延长 30 天 action shows; null shows it all the time. */
export const extendWithinDays: number | null = 7;
/** How many days before the end of the retention the page warns at its top. */
export const expiringWithinDays = 3;

type Kind = "项目" | "对话" | "控件";
type Filter = "all" | Kind;
interface Entry {
  kind: Kind;
  id: string;
  name: string;
  icon: string;
  owner: string;
  deletedAt: string;
  retainUntil: string;
  protection: string | null;
}
const day = 86_400_000;
const shortDate = (value: string) =>
  new Date(value).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
const longDate = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export function daysLeft(retainUntil: string, now: number) {
  return Math.ceil((Date.parse(retainUntil) - now) / day);
}
export function extendShown(left: number) {
  return extendWithinDays === null || left <= extendWithinDays;
}

/** Deleted projects, conversations and widgets of the snapshot, soonest end of retention first. */
export function recentlyDeletedEntries(snapshot: Snapshot): Entry[] {
  const projectOf = (c: Conversation) =>
    snapshot.projects.find((p) =>
      p.chats.some((x) => x.conversationId === c.id),
    )?.name;
  return [
    ...(snapshot.recentlyDeleted?.projects ?? []).map((p) => ({
      kind: "项目" as const,
      id: p.id,
      name: p.name,
      icon: "folder",
      owner: "",
      deletedAt: p.deletedAt,
      retainUntil: p.retainUntil,
      protection: p.protection,
    })),
    ...snapshot.conversations
      .filter((c) => c.deletedAt && c.retainUntil)
      .map((c) => ({
        kind: "对话" as const,
        id: c.id,
        name: c.title,
        icon: "chat",
        owner: projectOf(c) ?? "未归属项目",
        deletedAt: c.deletedAt!,
        retainUntil: c.retainUntil!,
        protection: null,
      })),
    ...(snapshot.recentlyDeleted?.widgets ?? []).map((w) => ({
      kind: "控件" as const,
      id: w.id,
      name: w.name,
      icon: "grid",
      owner: "",
      deletedAt: w.deletedAt,
      retainUntil: w.retainUntil,
      protection: w.protection,
    })),
  ].sort(
    (a, b) =>
      Date.parse(a.retainUntil) - Date.parse(b.retainUntil) ||
      a.id.localeCompare(b.id),
  );
}

const filters: [Filter, string][] = [
  ["all", "全部"],
  ["项目", "项目"],
  ["对话", "对话"],
  ["控件", "控件"],
];
const purgeImpact: Record<Kind, string> = {
  项目: "项目的组织记录永久移除；对话、控件、领域记录、仓库与文件不删除",
  对话: "对话与消息永久移除；关联控件与运行事件不删除",
  控件: "控件的配置与数据永久移除；关联对话保留",
};

/**
 * Settings 最近删除 (WB-04, PROJECT-03, CHAT-02, D-03): deleted projects, conversations and widgets together,
 * filtered by kind, each with its end of retention; restore, extend by 30 days and a separately confirmed
 * permanent deletion. Each kind keeps its own rules in the business service.
 */
export function RecentlyDeleted({
  snapshot,
  connected,
}: {
  snapshot: Snapshot | undefined;
  connected: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [purging, setPurging] = useState<Entry>();
  const chips = useRef<HTMLDivElement>(null);
  // The day boundary moves the remaining days; the page also redraws with every snapshot.
  useToday();
  if (!snapshot) return <p>尚未读取。</p>;
  const now = Date.now();
  const all = recentlyDeletedEntries(snapshot);
  const list = all.filter((e) => filter === "all" || e.kind === filter);
  const counts = {
    all: all.length,
    项目: all.filter((e) => e.kind === "项目").length,
    对话: all.filter((e) => e.kind === "对话").length,
    控件: all.filter((e) => e.kind === "控件").length,
  };
  const soon = all.filter(
    (e) => daysLeft(e.retainUntil, now) <= expiringWithinDays,
  );
  const focusFilter = () =>
    requestAnimationFrame(() =>
      chips.current
        ?.querySelector<HTMLButtonElement>("[aria-checked='true']")
        ?.focus(),
    );
  /** Sends one command for the entry; resolves to an error text or "". */
  async function run(
    e: Entry,
    action: "restore" | "extend" | "purge",
  ): Promise<string> {
    const conversation = snapshot!.conversations.find((c) => c.id === e.id);
    const kind = e.kind === "项目" ? "project" : "widget";
    const deleted =
      e.kind === "项目"
        ? snapshot!.recentlyDeleted?.projects.find((p) => p.id === e.id)
            ?.revision
        : snapshot!.recentlyDeleted?.widgets.find((w) => w.id === e.id)
            ?.trashRevision;
    const reply = await window.desktop.command(
      e.kind === "对话"
        ? {
            type: "organizeConversation",
            id: e.id,
            action,
            revision: conversation?.organizationRevision ?? -1,
            confirmed: action === "purge",
          }
        : action === "purge"
          ? {
              type: "purgeDeleted",
              kind,
              id: e.id,
              revision: deleted ?? -1,
              confirmed: true,
            }
          : {
              type: action === "restore" ? "restoreDeleted" : "extendDeleted",
              kind,
              id: e.id,
              revision: deleted ?? -1,
            },
    );
    if (!reply.ok) return reply.message;
    if (action === "restore")
      setNotice({
        text:
          e.kind === "项目"
            ? `已恢复项目「${e.name}」；不会自动重新置顶，之后改过归属的对象不回退。`
            : e.kind === "对话"
              ? `已恢复对话「${e.name}」，回到最近聊天并保持原身份与消息。`
              : `已恢复「${e.name}」。${reply.restoredWidget?.placement === "end" ? "原来相邻的控件都已不在，已追加到末尾。" : ""}`,
      });
    else if (action === "extend") {
      const next =
        e.kind === "对话"
          ? reply.snapshot.conversations.find((c) => c.id === e.id)?.retainUntil
          : e.kind === "项目"
            ? reply.snapshot.recentlyDeleted?.projects.find(
                (p) => p.id === e.id,
              )?.retainUntil
            : reply.snapshot.recentlyDeleted?.widgets.find((w) => w.id === e.id)
                ?.retainUntil;
      setNotice({
        text: `已延长 30 天：「${e.name}」保留至 ${next ? shortDate(next) : "新的到期日"}。`,
      });
    } else setNotice({ text: `已永久删除「${e.name}」。` });
    return "";
  }
  async function act(e: Entry, action: "restore" | "extend") {
    if (busy) return;
    setBusy(true);
    try {
      const error = await run(e, action);
      if (error) setNotice({ text: error, error: true });
      else focusFilter();
    } catch {
      setNotice({ text: "操作未完成，请核对连接后重试。", error: true });
    } finally {
      setBusy(false);
    }
  }
  const disabled = !connected || busy;
  return (
    <div className="recently-deleted">
      <p className="settings-lead">
        至少保留 30
        天；到期前提示清理或延长，不静默永久删除。恢复保持原身份与关联，不自动执行工作。
      </p>
      {soon.length > 0 && (
        <Callout tone="amber" icon="clock" title={`${soon.length} 项即将到期`}>
          <p>
            {soon
              .map((e) => {
                const left = daysLeft(e.retainUntil, now);
                return `${e.kind}「${e.name}」${left > 0 ? `还剩 ${left} 天` : "已到期"}`;
              })
              .join("；")}
            。可以恢复、延长 30 天或永久删除；到期不会自动永久删除。
          </p>
        </Callout>
      )}
      <div
        ref={chips}
        className="recently-deleted-filters"
        role="radiogroup"
        aria-label="类型"
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          event.preventDefault();
          const at = filters.findIndex(([id]) => id === filter);
          const next =
            filters[
              (at + (event.key === "ArrowRight" ? 1 : -1) + filters.length) %
                filters.length
            ][0];
          setFilter(next);
          focusFilter();
        }}
      >
        {filters.map(([id, label]) => (
          <button
            key={id}
            role="radio"
            aria-checked={filter === id}
            tabIndex={filter === id ? 0 : -1}
            className={filter === id ? "selected" : ""}
            onClick={() => setFilter(id)}
          >
            {label}
            <b>{counts[id]}</b>
          </button>
        ))}
      </div>
      {notice && (
        <p
          className={notice.error ? "error" : "recently-deleted-notice"}
          role={notice.error ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}
      {list.length ? (
        <ul className="recently-deleted-list" aria-label="最近删除的内容">
          {list.map((e) => {
            const left = daysLeft(e.retainUntil, now);
            return (
              <li key={`${e.kind}:${e.id}`} className="recently-deleted-row">
                <span className="recently-deleted-icon">
                  <Icon name={e.icon} />
                </span>
                <div className="recently-deleted-text">
                  <strong title={e.name}>{e.name}</strong>
                  <small>
                    <span className="recently-deleted-kind">{e.kind}</span>
                    {e.owner && <span>{e.owner}</span>}
                    <span>删除于 {longDate(e.deletedAt)}</span>
                    <span className={left <= expiringWithinDays ? "warn" : ""}>
                      {left > 0
                        ? `还剩 ${left} 天，至 ${shortDate(e.retainUntil)}`
                        : `已于 ${shortDate(e.retainUntil)} 到期，可延长或永久删除`}
                    </span>
                  </small>
                  {e.protection && (
                    <small className="recently-deleted-guard">
                      <Icon name="shield" />
                      受保护：永久删除前需要先处理仍在进行或结果未知的工作
                    </small>
                  )}
                </div>
                <div className="recently-deleted-actions">
                  <button
                    className="button"
                    disabled={disabled}
                    aria-label={`恢复 ${e.kind} ${e.name}`}
                    onClick={() => void act(e, "restore")}
                  >
                    恢复
                  </button>
                  {extendShown(left) && (
                    <button
                      className="button"
                      disabled={disabled}
                      aria-label={`延长 30 天 ${e.kind} ${e.name}`}
                      onClick={() => void act(e, "extend")}
                    >
                      延长 30 天
                    </button>
                  )}
                  <button
                    className="button danger-ghost"
                    disabled={disabled}
                    aria-label={`永久删除 ${e.kind} ${e.name}`}
                    onClick={() => {
                      setNotice(undefined);
                      setPurging(e);
                    }}
                  >
                    永久删除…
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="recently-deleted-empty">
          <Icon name="trash" />
          <h3>
            {filter === "all" ? "没有已删除的内容" : `没有已删除的${filter}`}
          </h3>
          <p>项目、对话和控件删除后会在这里统一保留。</p>
        </div>
      )}
      <p className="settings-note">
        三类共用展示，处置按各自规则：项目删除只移除组织记录，不停止领域执行；删除控件或对话都不删除彼此的关联。永久删除需要单独确认，提交时重新检查仍在进行或结果未知的工作。
      </p>
      {purging &&
        (purging.protection ? (
          <DeletionDialog
            title={`不能永久删除「${purging.name}」`}
            cancelLabel="关闭"
            back={() =>
              document.querySelector<HTMLElement>(
                `[aria-label="永久删除 ${purging.kind} ${purging.name}"]`,
              )
            }
            close={() => setPurging(undefined)}
            extra={
              <button
                className="button primary"
                disabled={disabled}
                onClick={() => {
                  const e = purging;
                  setPurging(undefined);
                  void act(e, "restore");
                }}
              >
                恢复{purging.kind}
              </button>
            }
          >
            <Callout tone="amber" icon="shield" title="仍被保护">
              <p>{purging.protection}</p>
            </Callout>
            <p className="deletion-hint">
              提交永久删除前会重新检查仍在进行或结果未知的工作；仍被保护的记录不能清除。
            </p>
          </DeletionDialog>
        ) : (
          <DeletionDialog
            title={`永久删除「${purging.name}」`}
            confirmLabel="永久删除"
            back={() =>
              document.querySelector<HTMLElement>(
                `[aria-label="永久删除 ${purging.kind} ${purging.name}"]`,
              )
            }
            close={() => setPurging(undefined)}
            disabled={!connected}
            confirm={async () => {
              const error = await run(purging, "purge");
              if (error) return error;
              setPurging(undefined);
              focusFilter();
              return "";
            }}
          >
            <ImpactList
              rows={[
                ["之后", purgeImpact[purging.kind]],
                ["恢复", "永久删除后不能恢复"],
              ]}
            />
          </DeletionDialog>
        ))}
    </div>
  );
}
