import { contextBridge, ipcRenderer } from "electron";
import type {
  Command,
  DesktopBridge,
  Snapshot,
  Status,
} from "../shared/protocol";
function listen<T>(channel: string, callback: (value: T) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: T) =>
    callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
const widgetEnabled = process.argv.includes("--widget-acceptance");
const occlude = () => {
  if (widgetEnabled) ipcRenderer.sendSync("widget:occlude");
};
if (widgetEnabled) {
  // Synchronous acknowledgement hides the native child before trusted DOM
  // handlers can display dialogs. Generated views never receive this bridge.
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (
        (event.target as Element | null)?.closest(
          "button,a,input,select,textarea,[role=button]",
        )
      )
        occlude();
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.metaKey || event.key === "Escape") occlude();
    },
    true,
  );
  window.addEventListener("DOMContentLoaded", () => {
    new MutationObserver(() => {
      if (document.querySelector('[role="dialog"]')) occlude();
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role", "open"],
    });
  });
}
const bridge: DesktopBridge = {
  projectEvidence: (input) => ipcRenderer.invoke("project:evidence", input),
  projectAction: (input) => ipcRenderer.invoke("project:action", input),
  projectWork: (request) => ipcRenderer.invoke("project:work", request),
  projectAccess: (request) => ipcRenderer.invoke("project:access", request),
  pickProjectFolder: () => ipcRenderer.invoke("project:pick-folder"),
  createProject: (input) => ipcRenderer.invoke("project:create", input),
  widgetEnabled,
  widgetControl: (command) => ipcRenderer.invoke("widget:control", command),
  widgetOcclude: occlude,
  onWidgetStatus: (callback) => listen("widget:status", callback),
  onWidgetSearch: (callback) => listen("widget:search", callback),
  prepareClaude: (model) => ipcRenderer.invoke("claude:prepare", model),
  acceptClaude: (token) => ipcRenderer.invoke("claude:accept", token),
  detectClaude: () => ipcRenderer.invoke("claude:detect"),
  detectCodex: () => ipcRenderer.invoke("codex:detect"),
  prepareCodex: (model) => ipcRenderer.invoke("codex:prepare", model),
  acceptCodex: (token) => ipcRenderer.invoke("codex:accept", token),
  surface: process.argv.includes("--surface=panel") ? "panel" : "main",
  copyConversation: (id, kind) =>
    ipcRenderer.invoke("conversation:copy", id, kind),
  search: (request) => ipcRenderer.invoke("business:search", request),
  cancelSearch: () => ipcRenderer.invoke("business:search-cancel"),
  command: (command: Command) =>
    ipcRenderer.invoke("business:command", command),
  subscribe: (callback) => listen<Snapshot>("business:snapshot", callback),
  onStatus: (callback) => listen<Status>("business:status", callback),
  reportDirty: (dirty) => ipcRenderer.send("window:dirty", dirty),
  openMain: (conversationId) =>
    ipcRenderer.invoke("window:open-main", conversationId),
  reconnect: () => ipcRenderer.invoke("business:reconnect"),
  onOpenConversation: (callback) =>
    listen("window:open-conversation", callback),
  saveSecret: (secret) => ipcRenderer.invoke("secret:save", secret),
  discardSecret: (secretRef) => ipcRenderer.invoke("secret:discard", secretRef),
  runConnectionCheck: (kind, connectionId, model) =>
    ipcRenderer.invoke("connection:check", kind, connectionId, model),
  pickAttachments: (conversationId) =>
    ipcRenderer.invoke("attachment:pick", conversationId),
  importRuntimeBundle: () => ipcRenderer.invoke("runtime:import"),
  runtimeControl: (command) => ipcRenderer.invoke("runtime:control", command),
  copyRuntimeValue: (target) => ipcRenderer.invoke("runtime:copy", target),
};
contextBridge.exposeInMainWorld("desktop", bridge);
