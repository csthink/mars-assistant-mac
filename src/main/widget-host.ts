import type { BrowserWindow } from "electron";
import { compileWidget } from "./widget-build";
import { widgetFixture } from "./widget-fixture";
import { WidgetRuntime, type WidgetInstance } from "./widget-runtime";
import { widgetFailure } from "../shared/widget-runtime";
import type { WidgetIdentity } from "../shared/widget-runtime";
import type {
  WidgetControl,
  WidgetSignal,
  WidgetUIReply,
} from "../shared/widget-ui";
import type { WidgetHostCommand, WidgetPreview } from "../shared/widget-store";
import type { WidgetGenerationHostCommand } from "../shared/widget-generation";
import type { Reply, Surface } from "../shared/protocol";
interface PendingInput {
  revision: number;
  value?: string;
  pending: boolean;
}
interface Entry {
  token: number;
  contentOnly?: boolean;
  owner: BrowserWindow;
  instance?: WidgetInstance;
  preview?: WidgetPreview;
  unconfirmed: Map<string, PendingInput>;
}
/** Trusted shell controls are separate from the limited generated-view bridge. */
export class WidgetHost {
  private entries = new Map<string, Entry>();
  private owners = new Set<number>();
  private buffers = new Map<string, Map<string, PendingInput>>();
  private buffer(surface: Surface, candidateId: string) {
    const key = `${surface}:${candidateId}`;
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = new Map();
      this.buffers.set(key, buffer);
    }
    return buffer;
  }
  readonly runtime: WidgetRuntime;
  constructor(
    readonly enabled: boolean,
    private request: (
      command: WidgetHostCommand | WidgetGenerationHostCommand,
      surface: Surface,
    ) => Promise<Reply>,
  ) {
    this.runtime = new WidgetRuntime(
      async (identity, command) => {
        const write =
          command.method === "writeData" || command.method === "writeDraft";
        const buffer = this.buffer(identity.surface, identity.candidateId);
        const input: PendingInput = {
          revision: "revision" in command ? command.revision : 0,
          value: command.method === "writeDraft" ? command.value : undefined,
          pending: true,
        };
        const key =
          command.method === "writeDraft" ? `draft:${command.field}` : "data";
        if (
          input.value !== undefined &&
          (Buffer.byteLength(input.value) > 4096 ||
            [...buffer.entries()].reduce(
              (bytes, [name, input]) =>
                bytes +
                (name === key ? 0 : Buffer.byteLength(input.value ?? "")),
              Buffer.byteLength(input.value),
            ) > 60000)
        )
          return widgetFailure;
        if (write) {
          buffer.set(key, input);
          this.signal(identity, "saving", "输入尚未确认保存");
        }
        const reply = await this.request(
          { type: "widgetRequest", identity, request: command },
          identity.surface,
        ).finally(() => {
          input.pending = false;
        });
        const result = reply.ok
          ? (reply.widget ?? widgetFailure)
          : { ok: false as const, message: reply.message };
        input.pending = false;
        if (write && result.ok && buffer.get(key) === input) buffer.delete(key);
        if (result.ok && command.method === "readDraft") {
          for (const [key, pending] of buffer)
            if (key.startsWith("draft:") && pending.value !== undefined)
              result.value[key.slice(6)] = {
                text: pending.value,
                revision: pending.revision,
                unconfirmed: true,
              };
        }
        if (write)
          this.signal(
            identity,
            result.ok ? "saved" : "failed",
            result.ok
              ? buffer.size
                ? "本次写入已保存，仍有其他输入未确认。"
                : "本次写入已确认保存"
              : result.message,
          );
        return result;
      },
      (identity, message) => this.signal(identity, "stopped", message),
      async (identity) => {
        const reply = await this.request(
          { type: "widgetBind", identity },
          identity.surface,
        );
        if (!reply.ok) throw new Error(reply.message);
      },
      async (identity) => {
        await this.request(
          { type: "widgetRevoke", generation: identity.generation },
          identity.surface,
        );
      },
    );
  }
  hasUnconfirmed() {
    return [...this.buffers.values()].some((buffer) => buffer.size > 0);
  }
  hasUnconfirmedCandidate(candidateId: string) {
    return (["main", "panel"] as const).some(
      (surface) =>
        (this.buffers.get(`${surface}:${candidateId}`)?.size ?? 0) > 0,
    );
  }
  private signal(
    identity: WidgetIdentity,
    state: WidgetSignal["state"],
    message: string,
  ) {
    for (const entry of this.entries.values()) {
      if (
        entry.instance?.identity.generation === identity.generation &&
        !entry.owner.isDestroyed()
      )
        entry.owner.webContents.send("widget:status", {
          generation: identity.generation,
          unconfirmed: entry.unconfirmed.size > 0,
          state,
          message,
        } satisfies WidgetSignal);
    }
  }
  occlude(owner: BrowserWindow, slot?: string) {
    for (const [key, entry] of this.entries)
      if (
        entry.owner === owner &&
        (slot === undefined || key === `${owner.webContents.id}:${slot}`)
      )
        this.closeEntry(entry);
  }
  private closeEntry(entry: Entry) {
    entry.token++;
    if (entry.instance) {
      this.signal(
        entry.instance.identity,
        "closed",
        "预览已收起，重开将读取已确认内容。",
      );
      void this.runtime.retire(entry.instance);
      entry.instance = undefined;
    }
  }
  async control(
    owner: BrowserWindow,
    surface: Surface,
    raw: unknown,
  ): Promise<WidgetUIReply> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { ok: false, message: "控件操作无效。" };
    const command = raw as WidgetControl;
    if (!this.enabled && command.action === "open")
      return { ok: true, enabled: false };
    if (
      command.slot !== undefined &&
      (typeof command.slot !== "string" ||
        !/^[a-zA-Z0-9:-]{1,200}$/.test(command.slot))
    )
      return { ok: false, message: "控件位置身份无效。" };
    const keys = Object.keys(command)
      .filter((key) => key !== "slot")
      .sort()
      .join(",");
    if (
      ![
        "status",
        "suspend",
        "open",
        "openGenerated",
        "hide",
        "place",
        "configure",
        "draftConfig",
        "recover",
      ].includes(command.action)
    )
      return { ok: false, message: "控件操作无效。" };
    const entryKey = `${owner.webContents.id}:${command.slot ?? "default"}`;
    let entry = this.entries.get(entryKey);
    if (!entry) {
      entry = { token: 0, owner, unconfirmed: new Map() };
      this.entries.set(entryKey, entry);
    }
    if (!this.owners.has(owner.webContents.id)) {
      this.owners.add(owner.webContents.id);
      const id = owner.webContents.id;
      let visible = owner.isVisible();
      const visibility = () => {
        const next = owner.isVisible();
        // macOS also emits hide for occlusion. Only native visibility revokes the preview.
        // A hidden, already-occluded window can omit the native hide event. The runtime
        // still retires its views from native visibility, so reconcile those retired
        // instances on show even if the cached visibility never changed.
        const retired = [...this.entries.values()].filter(
          (entry) =>
            entry.owner === owner && entry.instance && !entry.instance.active,
        );
        if (next === visible && retired.length === 0) return;
        visible = next;
        if (!next) this.occlude(owner);
        else for (const entry of retired) this.closeEntry(entry);
        if (!owner.webContents.isDestroyed())
          owner.webContents.send("widget:visibility", next);
      };
      let visibilityCheck: ReturnType<typeof setImmediate> | undefined;
      const observeVisibility = () => {
        visibility();
        // A hide listener can show the owner reentrantly without a second native
        // event. Reconcile once after the event stack, without delaying revocation.
        if (visibilityCheck) return;
        visibilityCheck = setImmediate(() => {
          visibilityCheck = undefined;
          if (!owner.isDestroyed()) visibility();
        });
      };
      owner.on("hide", observeVisibility);
      owner.on("show", observeVisibility);
      owner.on("minimize", observeVisibility);
      owner.on("restore", observeVisibility);
      owner.once("closed", () => {
        if (visibilityCheck) clearImmediate(visibilityCheck);
        owner.removeListener("hide", observeVisibility);
        owner.removeListener("show", observeVisibility);
        owner.removeListener("minimize", observeVisibility);
        owner.removeListener("restore", observeVisibility);
        this.occlude(owner);
        for (const [key, entry] of this.entries)
          if (entry.owner === owner) this.entries.delete(key);
        this.owners.delete(id);
      });
    }
    try {
      if (command.action === "place") {
        if (
          ![
            "action,generation,height,width,x,y",
            "action,contentOnly,generation,height,width,x,y",
          ].includes(keys) ||
          (command.contentOnly !== undefined &&
            typeof command.contentOnly !== "boolean") ||
          !entry.instance ||
          entry.instance.identity.generation !== command.generation
        )
          return { ok: false, message: "控件实例已关闭。" };
        entry.contentOnly = command.contentOnly === true;
        this.runtime.place(
          entry.instance,
          owner,
          {
            x: command.x,
            y: command.y,
            width: command.width,
            height: command.height,
          },
          false,
          command.contentOnly === true,
        );
      } else if (command.action === "draftConfig") {
        if (keys !== "action,field,revision,value" || !entry.preview)
          throw new Error("控件候选未载入。");
        if (
          !entry.preview.definition.config.some(
            (field) => field.id === command.field,
          ) ||
          typeof command.value !== "string" ||
          Buffer.byteLength(command.value) > 4096 ||
          !Number.isSafeInteger(command.revision) ||
          command.revision < 0
        )
          throw new Error("设置草稿格式无效。");
        const input: PendingInput = {
          revision: command.revision,
          value: command.value,
          pending: true,
        };
        entry.unconfirmed.set(`config:${command.field}`, input);
        const result = await this.request(
          {
            type: "widgetConfigDraft",
            candidateId: entry.preview.candidateId,
            field: command.field,
            revision: command.revision,
            value: command.value,
          },
          surface,
        ).finally(() => {
          input.pending = false;
        });
        input.pending = false;
        if (!result.ok) throw new Error(result.message);
        if (entry.unconfirmed.get(`config:${command.field}`) === input)
          entry.unconfirmed.delete(`config:${command.field}`);
        entry.preview = result.widgetPreview;
      } else if (command.action === "configure") {
        if (keys !== "action,draftRevisions,revision,value" || !entry.preview)
          throw new Error("控件候选未载入。");
        const result = await this.request(
          {
            type: "widgetConfigure",
            draftRevisions: command.draftRevisions,
            candidateId: entry.preview.candidateId,
            revision: command.revision,
            value: command.value,
          },
          surface,
        );
        if (!result.ok) throw new Error(result.message);
        entry.preview = result.widgetPreview;
      } else {
        if (command.action === "openGenerated") {
          if (
            keys !== "action,candidateId" ||
            typeof command.candidateId !== "string" ||
            !/^[a-zA-Z0-9-]{1,160}$/.test(command.candidateId)
          )
            throw new Error("候选身份无效。");
        } else if (keys !== "action") throw new Error("控件操作无效。");
        if (command.action === "recover") {
          if ([...entry.unconfirmed.values()].some((input) => input.pending))
            throw new Error("写入尚未结束，请稍后再核对。");
          entry.unconfirmed.clear();
          this.closeEntry(entry);
        }
        if (command.action === "hide") this.closeEntry(entry);
        if (command.action === "suspend" && entry.instance)
          entry.instance.view.setVisible(false);
        if (command.action === "status" && entry.preview) {
          const reply = await this.request(
            { type: "widgetInspect", candidateId: entry.preview.candidateId },
            surface,
          );
          if (!reply.ok) throw new Error(reply.message);
          entry.preview = reply.widgetPreview;
        }
        if (command.action === "open" || command.action === "openGenerated") {
          this.closeEntry(entry);
          const token = entry.token;
          const generated =
            command.action === "openGenerated"
              ? await this.request(
                  {
                    type: "loadGeneratedWidget",
                    candidateId: command.candidateId,
                  },
                  surface,
                )
              : undefined;
          if (generated && (!generated.ok || !generated.generatedBuild))
            throw new Error(
              generated.ok ? "候选产物读取失败。" : generated.message,
            );
          const built =
            generated?.ok && generated.generatedBuild
              ? generated.generatedBuild
              : await compileWidget(widgetFixture);
          const candidateId =
            command.action === "openGenerated"
              ? command.candidateId
              : `acceptance-${built.digest}`;
          let reply = await this.request(
            { type: "widgetInspect", candidateId },
            surface,
          );
          if (
            command.action === "open" &&
            !reply.ok &&
            reply.code === "INVALID_COMMAND"
          )
            reply = await this.request(
              {
                type: "widgetCreate",
                candidateId,
                widgetId: "acceptance-note",
                version: built.digest,
                definition: {
                  name: built.manifest.name,
                  config: built.manifest.config,
                  draftFields: built.manifest.draftFields,
                  capabilities: built.manifest.capabilities,
                },
              },
              surface,
            );
          if (!reply.ok || !reply.widgetPreview)
            throw new Error(reply.ok ? "测试候选读取失败。" : reply.message);
          if (entry.token !== token || owner.isDestroyed())
            throw new Error("预览已关闭。");
          entry.preview = reply.widgetPreview;
          entry.unconfirmed = this.buffer(surface, candidateId);
          const instance = await this.runtime.create(owner, built, {
            widgetId: entry.preview.widgetId,
            candidateId,
            surface,
          });
          if (entry.token !== token || owner.isDestroyed()) {
            await this.runtime.retire(instance);
            throw new Error("预览已关闭。");
          }
          entry.instance = instance;
          instance.contents.on("before-input-event", (event, input) => {
            if (input.type === "keyDown" && input.key === "Escape") {
              if (entry.contentOnly) event.preventDefault();
              owner.webContents.send("widget:restore");
            }
            if (input.meta && input.key.toLowerCase() === "k") {
              event.preventDefault();
              this.occlude(owner);
              owner.webContents.send("widget:search");
            }
          });
        }
      }
      const preview = entry.preview
        ? structuredClone(entry.preview)
        : undefined;
      if (preview)
        for (const [key, input] of entry.unconfirmed)
          if (key.startsWith("config:") && input.value !== undefined)
            preview.configDrafts[key.slice(7)] = {
              text: input.value,
              revision: input.revision,
              unconfirmed: true,
            };
      return {
        ok: true,
        enabled: true,
        unconfirmed: entry.unconfirmed.size > 0,
        preview,
        generation: entry.instance?.active
          ? entry.instance.identity.generation
          : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "控件操作失败，请保留当前输入。",
      };
    }
  }
}
