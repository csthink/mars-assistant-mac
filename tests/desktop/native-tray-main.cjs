// Native test entry: retain the real Tray callback and all production focus behavior.
const { app, Tray } = require("electron");
const { resolve } = require("node:path");
const root = resolve(__dirname, "../..");
app.setAppPath(root);
globalThis.nativeFocusEvents = [];
globalThis.panelMouseMonitor = require(resolve(root, "dist/panel-events.node"));
app.on("activate", () =>
  globalThis.nativeFocusEvents.push({ event: "activate", time: Date.now() }),
);
app.on("browser-window-created", (_event, win) => {
  for (const event of ["focus", "blur", "show", "hide", "closed"]) {
    win.on(event, () =>
      globalThis.nativeFocusEvents.push({
        event,
        id: win.id,
        time: Date.now(),
      }),
    );
  }
});
const originalOn = Tray.prototype.on;
Tray.prototype.on = function (event, listener) {
  if (event === "click")
    app.on("native-test-tray-click", () => this.emit("click"));
  return originalOn.call(this, event, listener);
};
require(resolve(root, "dist/main.cjs"));
