import { contextBridge, ipcRenderer } from "electron";
import {
  validInterfacePreferences,
  type Command,
  type DesktopBridge,
  type Snapshot,
  type Status,
} from "../shared/protocol";
function listen<T>(channel: string, callback: (value: T) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: T) =>
    callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
const widgetEnabled = process.argv.includes("--widget-acceptance");
// The saved appearance the main process knew when it created this window (its cache or the current
// snapshot); the page takes it for the first frame instead of waiting for the snapshot.
const appearanceArgument = process.argv
  .find((arg) => arg.startsWith("--appearance="))
  ?.slice("--appearance=".length);
const appearance =
  appearanceArgument === "light" ||
  appearanceArgument === "dark" ||
  appearanceArgument === "auto"
    ? appearanceArgument
    : undefined;
// The saved interface preferences the main process knew when it created the main window; the page lays out
// its columns from them for the first frame. Anything that is not exactly valid is treated as unknown.
const interfaceArgument = process.argv
  .find((arg) => arg.startsWith("--interface="))
  ?.slice("--interface=".length);
const interfacePreferences = (() => {
  try {
    const value: unknown = interfaceArgument
      ? JSON.parse(interfaceArgument)
      : undefined;
    return validInterfacePreferences(value) ? value : undefined;
  } catch {
    return undefined;
  }
})();
const occlude = (slot?: string) => {
  ipcRenderer.sendSync("widget:occlude", slot);
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
  retryProjectFolder: () => ipcRenderer.invoke("project:retry-folder"),
  cancelProjectFolder: () => ipcRenderer.invoke("project:cancel-folder"),
  createProject: (input) => ipcRenderer.invoke("project:create", input),
  widgetEnabled,
  widgetControl: (command) => ipcRenderer.invoke("widget:control", command),
  widgetOcclude: occlude,
  onWidgetLayout: (callback) => listen("widget:layout", callback),
  onWidgetDisplayInput: (callback) => listen("widget:display-input", callback),
  onWidgetStatus: (callback) => listen("widget:status", callback),
  onWidgetVisibility: (callback) => listen("widget:visibility", callback),
  onWidgetRestore: (callback) => listen("widget:restore", callback),
  onWidgetSearch: (callback) => listen("widget:search", callback),
  prepareClaude: (model) => ipcRenderer.invoke("claude:prepare", model),
  acceptClaude: (token) => ipcRenderer.invoke("claude:accept", token),
  detectClaude: () => ipcRenderer.invoke("claude:detect"),
  detectCodex: () => ipcRenderer.invoke("codex:detect"),
  prepareCodex: (model) => ipcRenderer.invoke("codex:prepare", model),
  acceptCodex: (token) => ipcRenderer.invoke("codex:accept", token),
  surface: process.argv.includes("--surface=panel") ? "panel" : "main",
  appearance,
  interface: interfacePreferences,
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
