// Separate native application used only by the explicitly scheduled native suite.
const { app, BrowserWindow } = require("electron");
app.setPath(
  "userData",
  process.argv.find((arg) => arg.startsWith("--peer-root=")).slice(12),
);
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 360, height: 240 });
  void win.loadURL(
    "data:text/html,<title>Native focus peer</title><h1>Native focus peer</h1>",
  );
});
