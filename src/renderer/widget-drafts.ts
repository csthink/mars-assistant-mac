import { useRef, useState } from "react";
import type { Command, Snapshot } from "../shared/protocol";
interface LocalWidgetDraft {
  name: string;
  input: string;
  revision: number;
  saving?: Promise<void>;
  dirty: boolean;
  error: string;
}
/** Draft buffers outlive the editor view and only clear after the committed revision is acknowledged. */
export function useWidgetDrafts(
  snapshot: Snapshot | undefined,
  reportDirty: (key: string, dirty: boolean) => void,
) {
  const latest = useRef(snapshot);
  if (
    snapshot &&
    (!latest.current || snapshot.revision >= latest.current.revision)
  )
    latest.current = snapshot;
  const deleting = useRef(new Set<string>());
  const locals = useRef(new Map<string, LocalWidgetDraft>());
  const [, render] = useState(0);
  const [error, setError] = useState("");
  const refresh = () => {
    reportDirty(
      "widget-drafts",
      [...locals.current.values()].some((d) => d.dirty),
    );
    render((n) => n + 1);
  };
  async function command(value: Command) {
    const reply = await window.desktop.command(value);
    if (!reply.ok) {
      setError(reply.message);
      return null;
    }
    latest.current = reply.snapshot;
    setError("");
    render((n) => n + 1);
    return reply.snapshot;
  }
  function value(id: string) {
    return (
      locals.current.get(id) ??
      latest.current?.widgetGeneration?.drafts.find((d) => d.id === id)
    );
  }
  async function flush(id: string) {
    const local = locals.current.get(id);
    if (!local || local.error) return;
    if (local.saving) return local.saving;
    const run = async () => {
      while (local.dirty && !local.error && !deleting.current.has(id)) {
        const { name, input, revision } = local;
        if (!name.trim()) {
          local.error = "请填写控件名称。";
          break;
        }
        const reply = await window.desktop.command({
          type: "saveWidgetDraft",
          id,
          name,
          input,
          revision,
        });
        if (!reply.ok) {
          local.error = reply.message;
          break;
        }
        latest.current = reply.snapshot;
        local.revision = reply.snapshot.widgetGeneration!.drafts.find(
          (d) => d.id === id,
        )!.revision;
        local.dirty = name !== local.name || input !== local.input;
      }
    };
    local.saving = run()
      .catch(() => {
        local.error = "尚未确认保存，请重试。";
      })
      .finally(() => {
        local.saving = undefined;
        if (!local.dirty) locals.current.delete(id);
        refresh();
      });
    refresh();
    return local.saving;
  }
  function edit(id: string, field: "name" | "input", text: string) {
    if (deleting.current.has(id)) return;
    const saved = latest.current?.widgetGeneration?.drafts.find(
      (d) => d.id === id,
    );
    if (!saved) return;
    const local = locals.current.get(id) ?? {
      name: saved.name,
      input: saved.input,
      revision: saved.revision,
      dirty: false,
      error: "",
    };
    local[field] = text;
    local.dirty = true;
    locals.current.set(id, local);
    refresh();
    void flush(id);
  }
  async function retry(id: string) {
    const local = locals.current.get(id);
    if (!local || local.saving) return;
    const read = await command({ type: "snapshot" });
    if (!read) return;
    const saved = read.widgetGeneration!.drafts.find((d) => d.id === id);
    if (!saved) return;
    local.revision = saved.revision;
    local.error = "";
    await flush(id);
  }
  async function confirmed(id: string) {
    await flush(id);
    return !locals.current.get(id)?.dirty;
  }
  return {
    value,
    locals: locals.current,
    edit,
    retry,
    confirmed,
    command,
    error,
    async remove(id: string) {
      if (deleting.current.has(id)) return null;
      deleting.current.add(id);
      try {
        await locals.current.get(id)?.saving;
        let read = await command({ type: "snapshot" });
        if (!read) return null;
        const pending = read.widgetGeneration!.tasks.filter(
          (t) =>
            t.draftId === id &&
            ["queued", "running", "stopping"].includes(t.state),
        );
        for (const t of pending)
          if (!(await command({ type: "stopWidgetGeneration", taskId: t.id })))
            return null;
        const deadline = Date.now() + 10000;
        while (true) {
          read = await command({ type: "snapshot" });
          if (!read) return null;
          if (
            !read.widgetGeneration!.tasks.some(
              (t) =>
                t.draftId === id &&
                ["queued", "running", "stopping"].includes(t.state),
            )
          )
            break;
          if (Date.now() >= deadline) {
            setError("生成尚未确认停止，草稿未删除。请等待停止完成后再删除。");
            return null;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (
          read.widgetGeneration!.tasks.some(
            (t) => t.draftId === id && t.stopUnconfirmed,
          )
        ) {
          setError("生成进程停止尚未确认，草稿未删除。请核对进程状态。");
          return null;
        }
        const saved = read.widgetGeneration!.drafts.find((d) => d.id === id);
        if (!saved) return null;
        const local = locals.current.get(id) ?? saved;
        const undoToken = crypto.randomUUID();
        const result = await command({
          type: "deleteWidgetDraft",
          id,
          revision: local.revision,
          name: local.name,
          input: local.input,
          undoToken,
        });
        if (!result) return null;
        locals.current.delete(id);
        refresh();
        return undoToken;
      } finally {
        deleting.current.delete(id);
      }
    },
    async undoRemoval(id: string, undoToken: string) {
      return !!(await command({
        type: "undoWidgetDraftDeletion",
        id,
        undoToken,
      }));
    },
    async create(sourceConversationId: string | null = null) {
      const id = crypto.randomUUID();
      return (await command({
        type: "createWidgetDraft",
        id,
        name: "新控件",
        sourceConversationId,
      }))
        ? id
        : null;
    },
    async createEdit(widgetIds: string[]) {
      const id = crypto.randomUUID();
      return (await command({ type: "createWidgetEditDraft", id, widgetIds }))
        ? id
        : null;
    },
    async submit(
      id: string,
      connectionId: string,
      model: string,
      supplement = false,
    ) {
      if (!(await confirmed(id))) return false;
      const saved = latest.current?.widgetGeneration?.drafts.find(
        (d) => d.id === id,
      );
      if (!saved) return false;
      return !!(await command({
        type: supplement
          ? "supplementWidgetGeneration"
          : "submitWidgetGeneration",
        draftId: id,
        revision: saved.revision,
        requestId: crypto.randomUUID(),
        connectionId,
        model,
      }));
    },
  };
}
export type WidgetDraftModel = ReturnType<typeof useWidgetDrafts>;
