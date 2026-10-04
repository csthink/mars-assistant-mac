/* Test-only Electron entry. Install OS isolation before loading production code. */
const electron = require("electron");
const { app, clipboard, dialog } = electron;
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

// The menu bar icon is an in-process stand-in: a background client never puts a status item in the system
// menu bar, where a person could click it or quit the test client from its menu, and parallel workers
// would show one icon each. `electron.Tray` cannot be redefined, so the production bundle alone gets an
// Electron module whose Tray is the stand-in. Tests click it with the app events below; the real Tray is
// covered by the native tests, whose entry loads the production bundle directly.
const { EventEmitter } = require("node:events");
const mainBundle = resolve(root, "dist/main.cjs");
const tray = {
  created: 0,
  realTrayUsed: false,
  toolTip: null,
  menus: [],
  instance: null,
};
globalThis.testTray = tray;
const RealTray = electron.Tray;
RealTray.prototype.setToolTip = function () {
  // Tripwire: the production code sets the tooltip right after creating its icon.
  tray.realTrayUsed = true;
};
class TestTray extends EventEmitter {
  constructor(image) {
    super();
    tray.created += 1;
    tray.imageEmpty = image.isEmpty();
    tray.instance = this;
    this.destroyed = false;
  }
  setToolTip(text) {
    tray.toolTip = text;
  }
  // A fixed rectangle at the right end of the primary display's menu bar, the same in every worker.
  getBounds() {
    const { bounds, workArea } = electron.screen.getPrimaryDisplay();
    const height = Math.max(workArea.y - bounds.y, 24);
    return { x: bounds.x + bounds.width - 240, y: bounds.y, width: 24, height };
  }
  popUpContextMenu(menu) {
    tray.menus.push(menu.items.map((item) => item.label));
    tray.menu = menu;
  }
  setImage() {}
  setPressedImage() {}
  setTitle() {}
  destroy() {
    this.destroyed = true;
  }
  isDestroyed() {
    return this.destroyed;
  }
}
const click = () => ({
  preventDefault() {},
  altKey: false,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
});
app.on("test-tray-click", () =>
  tray.instance?.emit("click", click(), tray.instance.getBounds()),
);
app.on("test-tray-right-click", () =>
  tray.instance?.emit("right-click", click(), tray.instance.getBounds()),
);
app.on("test-tray-menu", (label) => {
  const item = tray.menu?.items.find((entry) => entry.label === label);
  if (!item) throw new Error(`No recorded menu bar icon menu item: ${label}`);
  item.click();
});
const electronForMain = new Proxy(electron, {
  get: (target, key, receiver) =>
    key === "Tray" ? TestTray : Reflect.get(target, key, receiver),
});
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron" && parent?.filename === mainBundle)
    return electronForMain;
  return load.call(this, request, parent, isMain);
};

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

// Observe sizing traffic without delaying it; synthetic tests attach this on failure.
if (process.env.CSTHINK_TEST_RECORD_WIDGET_LAYOUT === "1") {
  const records = (globalThis.widgetLayoutRecords = []);
  app.on("web-contents-created", (_event, contents) => {
    contents.ipc.on("widget:measure", (_event, value) => {
      if (records.length < 1000)
        records.push({
          direction: "measure",
          id: contents.id,
          at: Date.now(),
          value,
        });
    });
    const send = contents.send;
    contents.send = function (channel, ...args) {
      if (channel === "widget:layout" && records.length < 1000)
        records.push({
          direction: "layout",
          id: contents.id,
          at: Date.now(),
          value: args[0],
        });
      return send.call(this, channel, ...args);
    };
  });
}

// Hold only the first panel snapshot reply, after the actual service has published its
// data. This makes the two legal data/connection notification orders deterministic.
const panelConnectionOrder = process.env.CSTHINK_TEST_PANEL_CONNECTION_ORDER;
if (panelConnectionOrder) {
  const { ipcMain } = electron;
  const handle = ipcMain.handle;
  const gate = (globalThis.panelConnectionGate = { held: false, calls: [] });
  let first = true;
  ipcMain.handle = function (channel, listener) {
    if (channel !== "business:command")
      return handle.call(this, channel, listener);
    return handle.call(this, channel, async (event, command) => {
      const owner = electron.BrowserWindow.fromWebContents(event.sender);
      const panel = owner && !owner.isResizable();
      gate.calls.push({ command: command.type, windowId: owner?.id, panel });
      if (!first || !panel || command.type !== "snapshot")
        return listener(event, command);
      first = false;
      if (panelConnectionOrder === "connection-first")
        event.sender.send("business:status", { connected: true, message: "" });
      const reply = await listener(event, command);
      gate.held = true;
      await new Promise((release) =>
        app.once("test-panel-connection-release", release),
      );
      return reply;
    });
  };
}

// A slow business service: the messages of the first service process reach the main process only after
// CSTHINK_TEST_SERVICE_DELAY_MS, in their original order, as when a large data root opens slowly.
const serviceDelay = Number(process.env.CSTHINK_TEST_SERVICE_DELAY_MS ?? 0);
if (serviceDelay > 0) {
  const { utilityProcess } = require("electron");
  const fork = utilityProcess.fork;
  let delayed = false;
  utilityProcess.fork = function (...args) {
    const child = fork.apply(this, args);
    if (delayed) return child;
    delayed = true;
    const held = [];
    let open = false;
    setTimeout(() => {
      open = true;
      for (const deliver of held.splice(0)) deliver();
    }, serviceDelay);
    const on = child.on;
    child.on = function (event, listener) {
      if (event !== "message") return on.call(this, event, listener);
      return on.call(this, event, (message) =>
        open ? listener(message) : held.push(() => listener(message)),
      );
    };
    return child;
  };
}

/** The most frequent colour of a captured page, sampled on a 200-point-wide copy. */
function dominantColour(image) {
  const small = image.resize({ width: 200 });
  const { width, height } = small.getSize();
  const bitmap = small.toBitmap();
  const counts = new Map();
  let best = 0,
    most = 0;
  for (let y = 0; y < height; y += 2)
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const key = (bitmap[i + 2] << 16) | (bitmap[i + 1] << 8) | bitmap[i];
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > most) ((most = count), (best = key));
    }
  return most ? `#${best.toString(16).padStart(6, "0")}` : "empty";
}

// The window-background tests record, per window, the native background when it is first shown, the page
// as composited at that moment (its most frequent colour), and the page's appearance from the moment the
// page is ready.
if (process.env.CSTHINK_TEST_RECORD_APPEARANCE === "1") {
  globalThis.appearanceRecord = [];
  app.on("browser-window-created", (_event, window) => {
    const entry = { themes: [] };
    globalThis.appearanceRecord.push(entry);
    const show = window.show;
    window.show = () => {
      if (entry.shown === undefined) {
        entry.shown = window.getBackgroundColor();
        void window.webContents.capturePage().then((image) => {
          entry.frame = image.isEmpty() ? "empty" : dominantColour(image);
        });
      }
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
app.on("csthink:project-folders", (folders) => {
  globalThis.projectFolders = folders;
});
// The embedded execution port (feature-t30): tests register fixture adapters; production has no listener.
app.on("csthink:execution-port", (port) => {
  globalThis.executionPort = port;
});

require(resolve(root, "dist/main.cjs"));
