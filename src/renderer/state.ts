import { useEffect, useReducer, useRef, useState } from "react";
import type {
  Command,
  DesktopBridge,
  Snapshot,
  Status,
} from "../shared/protocol";
declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
interface LocalDraft {
  text: string;
  revision: number;
  dirty: boolean;
  saving: boolean;
  error: string;
}
export function useBusiness() {
  const bridge = window.desktop;
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const latest = useRef<Snapshot | undefined>(undefined);
  const [status, setStatus] = useState<Status>({
    connected: false,
    message: "正在打开本地数据…",
  });
  const [actionError, setActionError] = useState("");
  const [switching, setSwitching] = useState(false);
  const selectionBusy = useRef(false);
  const drafts = useRef(new Map<string, LocalDraft>());
  const externalDirty = useRef(new Set<string>());
  const [, render] = useReducer((n) => n + 1, 0);
  function refresh() {
    bridge.reportDirty(
      externalDirty.current.size > 0 ||
        [...drafts.current.values()].some((d) => d.dirty),
    );
    render();
  }
  function accept(value: Snapshot) {
    if (
      latest.current &&
      value.rootId === latest.current.rootId &&
      value.revision < latest.current.revision
    )
      return;
    latest.current = value;
    setSnapshot(value);
  }
  /** Asks the service for its current snapshot; the push channel normally keeps the view current, this is the person's explicit re-read (V-19 r1). */
  async function reload() {
    const reply = await bridge.command({ type: "snapshot" });
    if (reply.ok) {
      accept(reply.snapshot);
      setStatus({ connected: true, message: "" });
    } else setStatus({ connected: false, message: reply.message });
  }
  useEffect(() => {
    const offSnapshot = bridge.subscribe(accept);
    const offStatus = bridge.onStatus(setStatus);
    void reload();
    return () => {
      offSnapshot();
      offStatus();
    };
  }, [bridge]);
  async function flush(id: string) {
    const local = drafts.current.get(id);
    if (!local || local.saving || !local.dirty || local.error) return;
    local.saving = true;
    refresh();
    while (local.dirty && !local.error) {
      const text = local.text;
      const reply = await bridge.command({
        type: "saveDraft",
        id,
        text,
        revision: local.revision,
      });
      if (!reply.ok) {
        local.error = reply.message;
        break;
      }
      accept(reply.snapshot);
      const saved = reply.snapshot.conversations.find((c) => c.id === id)!;
      local.revision = saved.revision;
      local.dirty = local.text !== text;
    }
    local.saving = false;
    if (!local.dirty) drafts.current.delete(id);
    refresh();
  }
  function edit(id: string, text: string) {
    const conversation = latest.current?.conversations.find((c) => c.id === id);
    if (!conversation) return;
    const local = drafts.current.get(id) ?? {
      text: conversation.draft,
      revision: conversation.revision,
      dirty: false,
      saving: false,
      error: "",
    };
    local.text = text;
    local.dirty = true;
    drafts.current.set(id, local);
    refresh();
    void flush(id);
  }
  async function changeSelection(
    command: Extract<
      Command,
      {
        type:
          | "create"
          | "newConversation"
          | "select"
          | "chooseConnection"
          | "chooseEffort";
      }
    >,
  ) {
    if (selectionBusy.current) return null;
    selectionBusy.current = true;
    setSwitching(true);
    setActionError("");
    try {
      const reply = await bridge.command(command);
      if (reply.ok) {
        accept(reply.snapshot);
        return reply.snapshot;
      }
      setActionError(reply.message);
      return null;
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "选择未保存，请重试。",
      );
      return null;
    } finally {
      selectionBusy.current = false;
      setSwitching(false);
    }
  }
  async function create() {
    // A new conversation reuses the unused one when there is one; the reply tells which one is selected.
    const saved = await changeSelection({
      type: "newConversation",
      id: crypto.randomUUID(),
    });
    return saved?.selected[bridge.surface] ?? null;
  }
  async function select(id: string) {
    return !!(await changeSelection({ type: "select", id }));
  }
  async function chooseConnection(conversationId: string, value: string) {
    await changeSelection({
      type: "chooseConnection",
      conversationId,
      connectionId: value.split("::")[0] || null,
      ...(value ? { model: value.slice(value.indexOf("::") + 2) } : {}),
    });
  }
  async function chooseEffort(conversationId: string, effort: string | null) {
    await changeSelection({ type: "chooseEffort", conversationId, effort });
  }
  function retry(id: string) {
    const local = drafts.current.get(id),
      saved = latest.current?.conversations.find((c) => c.id === id);
    if (!local || !saved) return;
    local.revision = saved.revision;
    local.error = "";
    refresh();
    void flush(id);
  }
  /** Submits the current text as a turn; the store clears the draft in the same transaction. */
  async function submit(id: string, connectionId: string, model: string) {
    const local = drafts.current.get(id);
    const saved = latest.current?.conversations.find((c) => c.id === id);
    const text = (local?.text ?? saved?.draft ?? "").trim();
    if (!text || selectionBusy.current) return false;
    // Let an in-flight autosave settle so its acknowledgement cannot race the cleared draft.
    for (let i = 0; i < 40 && drafts.current.get(id)?.saving; i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    setActionError("");
    const reply = await bridge.command({
      type: "submitTurn",
      ...(() => {
        const chat = latest.current?.projects
          .flatMap((p) => p.chats)
          .find((c) => c.conversationId === id);
        return chat ? { projectContextRevision: chat.revision } : {};
      })(),
      requestId: crypto.randomUUID(),
      conversationId: id,
      connectionId,
      model,
      text,
    });
    if (!reply.ok) {
      setActionError(reply.message);
      return false;
    }
    drafts.current.delete(id);
    accept(reply.snapshot);
    refresh();
    return true;
  }
  async function stop(executionId: string) {
    setActionError("");
    const reply = await bridge.command({ type: "stopExecution", executionId });
    if (!reply.ok) setActionError(reply.message);
    else accept(reply.snapshot);
  }
  function adopt(id: string) {
    const draft = drafts.current.get(id);
    if (draft?.saving) return;
    drafts.current.delete(id);
    refresh();
  }
  return {
    snapshot,
    setExternalDirty(key: string, dirty: boolean) {
      const before = externalDirty.current.has(key);
      if (dirty) externalDirty.current.add(key);
      else externalDirty.current.delete(key);
      if (before !== dirty) refresh();
    },
    status,
    actionError,
    clearActionError: () => setActionError(""),
    switching,
    drafts: drafts.current,
    edit,
    create,
    select,
    chooseConnection,
    chooseEffort,
    retry,
    adopt,
    submit,
    stop,
    reload,
  };
}
