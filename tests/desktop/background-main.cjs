/* Test-only Electron entry. Install OS isolation before loading production code. */
const { app, clipboard, dialog } = require("electron");
const { resolve } = require("node:path");

const root = resolve(__dirname, "../..");
// Background tests must not subscribe to global mouse events.
const Module = require("node:module");
const monitorPath = resolve(root, "dist/panel-events.node");
const monitorModule = new Module(monitorPath);
let outsideClick;
monitorModule.exports = {
  start: (callback) => {
    outsideClick = callback;
  },
  stop: () => {
    outsideClick = undefined;
  },
  isActive: () => !!outsideClick,
};
globalThis.panelMouseMonitor = monitorModule.exports;
monitorModule.loaded = true;
require.cache[monitorPath] = monitorModule;
app.on("test-panel-outside-click", (point) => outsideClick?.(point));
app.setAppPath(root);
if (process.platform === "darwin") app.setActivationPolicy("prohibited");
// User-triggered panel activation must never activate a background test app.
app.focus = () => {};

// A process-local clipboard keeps concurrent user copy/paste untouched.
const text = new Map();
clipboard.writeText = (value, type = "clipboard") => text.set(type, value);
clipboard.readText = (type = "clipboard") => text.get(type) ?? "";
clipboard.clear = (type = "clipboard") => text.delete(type);

// Each test must supply its intended dialog result. Unexpected OS UI fails closed.
for (const method of [
  "showOpenDialog",
  "showOpenDialogSync",
  "showSaveDialog",
  "showSaveDialogSync",
  "showMessageBox",
  "showMessageBoxSync",
  "showErrorBox",
]) {
  dialog[method] = () => {
    throw new Error(`Unexpected native dialog in background test: ${method}`);
  };
}

app.on("browser-window-created", (_event, window) => {
  // Keep native visibility/lifecycle observable, but make windows invisible and
  // click-through. Protocol input and webContents screenshots still reach Chromium.
  window.setFocusable(false);
  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
  if (process.platform === "darwin") window.setAutoHideCursor(false);
  window.webContents.setBackgroundThrottling(false);
  window.show = () => window.showInactive();
  window.focus = () => {};
});

// The window-background test records, per window, the native background when it is first shown and the
// page's appearance from the moment the page is ready (the first frame follows it).
if (process.env.CSTHINK_TEST_RECORD_APPEARANCE === "1") {
  globalThis.appearanceRecord = [];
  app.on("browser-window-created", (_event, window) => {
    const entry = { themes: [] };
    globalThis.appearanceRecord.push(entry);
    const show = window.show;
    window.show = () => {
      entry.shown ??= window.getBackgroundColor();
      show();
    };
    window.webContents.once("dom-ready", () => {
      void window.webContents
        .executeJavaScript(
          `(() => {
            const log = (window.__appearanceLog = [document.documentElement.dataset.theme]);
            new MutationObserver(() => log.push(document.documentElement.dataset.theme)).observe(
              document.documentElement,
              { attributes: true, attributeFilter: ["data-theme"] },
            );
            return log[0];
          })()`,
        )
        .then((theme) => {
          entry.ready = theme;
        });
    });
  });
}
// The live Runtime Host (feature-t29) is exposed to integration tests; production has no listener.
app.on("csthink:runtime-host", (host) => {
  globalThis.runtimeHost = host;
});
// The embedded execution port (feature-t30): tests register fixture adapters; production has no listener.
app.on("csthink:execution-port", (port) => {
  globalThis.executionPort = port;
});

require(resolve(root, "dist/main.cjs"));
