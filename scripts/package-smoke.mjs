import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { clearTimeout, setTimeout } from "node:timers";
import { Buffer } from "node:buffer";
/* global WebSocket -- Node.js 24 provides the WHATWG WebSocket client globally. */

/**
 * Background smoke check of a packaged build. The app runs under an isolated home
 * directory: HOME points at it, which gives the process its own default login keychain,
 * and the inspector points Electron's appData path into it, because Chromium resolves
 * Application Support from the account and not from HOME. The person's data directories
 * and keychain are therefore not read or written; macOS may still record per-app state
 * by bundle identifier under the real ~/Library (preferences, saved window state). Before any product code runs,
 * the Node inspector of the packaged main process installs the same isolation the
 * background desktop tests use: no activation, no Dock icon, no status item in the menu
 * bar, invisible click-through windows that never take focus, and no system dialogs.
 *
 *   seed    start the build, record a conversation with a draft, an API key saved through
 *           the product's vault (safeStorage, keychain) and a provider that references it,
 *           and the appearance; then quit and write seed.json into the work directory
 *   verify  start the build on the same home directory and compare what it reads back
 *           with seed.json; the vault file and the keychain items must be unchanged
 *
 * --dmg mounts the disk image read-only and copies the app out of it first; --app takes
 * an app bundle directly (for example an older build to upgrade from).
 */
const { values } = parseArgs({
  options: {
    phase: { type: "string" },
    dmg: { type: "string" },
    app: { type: "string" },
    work: { type: "string" },
  },
});
if (process.platform !== "darwin")
  throw new Error("This smoke check requires macOS.");
if (!["seed", "verify"].includes(values.phase ?? ""))
  throw new Error("--phase must be seed or verify.");
if (!values.dmg === !values.app)
  throw new Error("Pass exactly one of --dmg and --app.");
const work = resolve(
  values.work ?? (await mkdtemp(join(tmpdir(), "qingluan-smoke-"))),
);
const home = join(work, "home");
const appData = join(home, "Library", "Application Support");
// Guards, checked before anything is created: the work directory is not the account's home,
// one of its ancestors or inside its Library, and the isolated Application Support cannot be the
// account's real one.
const realHome = userInfo().homedir;
const realAppData = join(realHome, "Library", "Application Support");
const inside = (path, parent) =>
  resolve(path) === resolve(parent) ||
  resolve(path).startsWith(resolve(parent) + "/");
if (
  inside(realHome, work) ||
  inside(work, join(realHome, "Library")) ||
  inside(appData, realAppData)
)
  throw new Error(
    `Refusing to run: the work directory ${work} overlaps the account's home or Library.`,
  );
if (
  existsSync(work) &&
  (await readdir(work)).some(
    (name) =>
      ![
        "home",
        "mount",
        "Applications",
        "seed.json",
        "extensions.png",
      ].includes(name) && !name.startsWith("."),
  ) &&
  !existsSync(join(work, "seed.json"))
)
  throw new Error(
    `Refusing to run: ${work} holds files this check did not create.`,
  );
const keychain = join(home, "Library", "Keychains", "login.keychain-db");
const run = (file, args, env = process.env) =>
  execFileSync(file, args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
const homeEnv = { ...process.env, HOME: home };
for (const key of Object.keys(homeEnv))
  if (key.startsWith("ELECTRON_") || key.startsWith("CSTHINK_"))
    delete homeEnv[key];

/** An unlocked keychain that only exists inside the isolated home directory. */
async function ensureKeychain() {
  if (existsSync(keychain)) {
    const listed = run("/usr/bin/security", ["default-keychain"], homeEnv);
    if (!listed.includes(keychain))
      throw new Error(`The isolated home has no default keychain: ${listed}`);
    return;
  }
  await mkdir(join(home, "Library", "Keychains"), { recursive: true });
  const password = randomBytes(16).toString("hex");
  run(
    "/usr/bin/security",
    ["create-keychain", "-p", password, keychain],
    homeEnv,
  );
  run("/usr/bin/security", ["set-keychain-settings", keychain], homeEnv);
  const listed = run("/usr/bin/security", ["default-keychain"], homeEnv).trim();
  if (!listed.includes(keychain))
    throw new Error(`The isolated home has no default keychain: ${listed}`);
}

/** Names and accounts of the generic password items in the isolated keychain, never their values. */
function keychainItems() {
  const dump = run("/usr/bin/security", ["dump-keychain", keychain], homeEnv);
  const items = [];
  for (const block of dump.split(/^keychain: /m).slice(1)) {
    if (!/class: "genp"/.test(block)) continue;
    const service = block.match(/"svce"<blob>="([^"]*)"/)?.[1] ?? null;
    const account = block.match(/"acct"<blob>="([^"]*)"/)?.[1] ?? null;
    items.push({ service, account });
  }
  return items.sort((a, b) => `${a.service}`.localeCompare(`${b.service}`));
}

/** Copies the app out of the read-only disk image and checks the image layout. */
async function appFromImage(dmg) {
  const mount = join(work, "mount");
  await mkdir(mount, { recursive: true });
  run("/usr/bin/hdiutil", [
    "attach",
    "-nobrowse",
    "-readonly",
    "-noautoopen",
    "-mountpoint",
    mount,
    dmg,
  ]);
  try {
    const entries = (await readdir(mount)).filter(
      (name) => !name.startsWith("."),
    );
    const target = run("/usr/bin/readlink", [
      join(mount, "Applications"),
    ]).trim();
    const apps = entries.filter((name) => name.endsWith(".app"));
    if (apps.length !== 1 || target !== "/Applications")
      throw new Error(
        `Unexpected disk image layout: ${entries.join(", ")} -> ${target}`,
      );
    const destination = join(work, "Applications");
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    run("/usr/bin/ditto", [join(mount, apps[0]), join(destination, apps[0])]);
    return {
      app: join(destination, apps[0]),
      layout: entries.sort(),
      link: target,
    };
  } finally {
    run("/usr/bin/hdiutil", ["detach", mount]);
  }
}

function executableOf(app) {
  const plist = JSON.parse(
    run("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      join(app, "Contents", "Info.plist"),
    ]),
  );
  return {
    file: join(app, "Contents", "MacOS", plist.CFBundleExecutable),
    plist,
  };
}

/** The isolation installed in the packaged main process before its own code runs. */
const isolation = (mainBundle, applicationSupport) => `(() => {
  const electron = require("electron");
  const { app, dialog } = electron;
  const Module = require("node:module");
  const { EventEmitter } = require("node:events");
  // Chromium resolves Application Support from the account, not from HOME: point the
  // product's default data directories into the isolated home before its code runs.
  require("node:fs").mkdirSync(${JSON.stringify(applicationSupport)}, { recursive: true });
  app.setPath("appData", ${JSON.stringify(applicationSupport)});
  app.setActivationPolicy("prohibited");
  app.focus = () => {};
  // An uncaught main-process error would open an error box: record it instead and fail the check.
  globalThis.smokeErrors = [];
  dialog.showErrorBox = (title, content) => { globalThis.smokeErrors.push({ title, content: String(content).split("\\n").slice(0, 8) }); };
  for (const method of ["showOpenDialog", "showOpenDialogSync", "showSaveDialog", "showSaveDialogSync", "showMessageBoxSync"])
    dialog[method] = () => { throw new Error("Unexpected native dialog in the package smoke check: " + method); };
  // The quit confirmation is answered with its second button (stop and quit).
  dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  class StandInTray extends EventEmitter {
    constructor(image) { super(); globalThis.smokeTray = { imageEmpty: image.isEmpty(), template: image.isTemplateImage() }; }
    setToolTip(text) { globalThis.smokeTray.toolTip = text; }
    getBounds() { return { x: 0, y: 0, width: 24, height: 24 }; }
    popUpContextMenu() {} setImage() {} setPressedImage() {} setTitle() {} destroy() {} isDestroyed() { return false; }
  }
  const proxied = new Proxy(electron, { get: (target, key, receiver) => key === "Tray" ? StandInTray : Reflect.get(target, key, receiver) });
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron" && parent && parent.filename === ${JSON.stringify(mainBundle)}) return proxied;
    return load.call(this, request, parent, isMain);
  };
  app.on("browser-window-created", (_event, window) => {
    window.setFocusable(false);
    window.setOpacity(0);
    window.setIgnoreMouseEvents(true);
    window.show = () => window.showInactive();
    window.focus = () => {};
  });
  return app.getPath("appData") === ${JSON.stringify(applicationSupport)} ? "isolated" : "appData not redirected";
})()`;

async function launch(app) {
  const { file, plist } = executableOf(app);
  const mainBundle = join(
    app,
    "Contents",
    "Resources",
    "app",
    "dist",
    "main.cjs",
  );
  const child = spawn(file, ["--inspect-brk=0"], {
    env: homeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`No inspector: ${stderr}`)),
      20000,
    );
    child.stderr.on("data", (data) => {
      stderr += data;
      const match = stderr.match(/ws:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[0]);
      }
    });
    child.once("exit", (code) =>
      reject(new Error(`Exited ${code}: ${stderr}`)),
    );
  });
  const socket = new WebSocket(url);
  await new Promise((ready, fail) => {
    socket.addEventListener("open", ready, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const pauses = [];
  let paused = () => {};
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === "Debugger.paused") {
      pauses.push(message.params);
      paused();
    }
  });
  const nextPause = (predicate) =>
    new Promise((found, fail) => {
      const timer = setTimeout(
        () => fail(new Error("The main bundle never started.")),
        20000,
      );
      paused = () => {
        const index = pauses.findIndex(predicate);
        if (index < 0) return;
        clearTimeout(timer);
        found(pauses.splice(index, 1)[0]);
      };
      paused();
    });
  const send = (method, params = {}) =>
    new Promise((answer) => {
      const next = ++id;
      pending.set(next, answer);
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  // While the main process is paused, awaiting a promise would never settle.
  const evaluate = async (expression, awaitPromise = true) => {
    const reply = await send("Runtime.evaluate", {
      expression,
      includeCommandLineAPI: true,
      awaitPromise,
      returnByValue: true,
    });
    if (reply.error || reply.result?.exceptionDetails)
      throw new Error(
        JSON.stringify(reply.error ?? reply.result.exceptionDetails),
      );
    return reply.result.result.value;
  };
  // Evaluating before the inspector's first-line pause runs in a half-started Node, where
  // require fails. The pause comes before any product code runs.
  await send("Runtime.enable");
  await send("Debugger.enable");
  await send("Runtime.runIfWaitingForDebugger");
  await nextPause(() => true);
  // Still paused before any product code: if the isolation or the appData redirect did not
  // take, the process is killed here and never opens a data directory.
  const installed = await evaluate(isolation(mainBundle, appData), false).catch(
    (error) => String(error),
  );
  if (installed !== "isolated") {
    child.kill("SIGKILL");
    throw new Error(`Isolation was not installed: ${installed}`);
  }
  await send("Debugger.resume");
  await send("Debugger.disable");
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  return { child, plist, evaluate, socket, exited, stderr: () => stderr };
}

/** Waits for the main window's business service and returns what the main process reports. */
async function ready(session) {
  const deadline = Date.now() + 60000;
  for (;;) {
    const state = await session.evaluate(`(async () => {
      const { app, BrowserWindow, Menu } = require("electron");
      const main = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== "工作台助手");
      if (!app.isReady() || !main || main.webContents.isLoading())
        return { waiting: { ready: app.isReady(), titles: BrowserWindow.getAllWindows().map((w) => w.getTitle()) } };
      const snapshot = await main.webContents.executeJavaScript(
        "window.desktop.command({ type: 'snapshot' })",
      );
      if (!snapshot || !snapshot.ok)
        return { waiting: { code: snapshot?.code ?? null, message: snapshot?.message ?? null } };
      const menu = Menu.getApplicationMenu();
      return {
        name: app.getName(),
        locale: app.getLocale(),
        version: app.getVersion(),
        appData: app.getPath("appData"),
        userData: app.getPath("userData"),
        packaged: app.isPackaged,
        titles: BrowserWindow.getAllWindows().map((w) => w.getTitle()),
        focusable: BrowserWindow.getAllWindows().some((w) => w.isFocusable()),
        menu: menu ? menu.items[0].submenu.items.map((item) => item.label) : [],
        tray: globalThis.smokeTray ?? null,
        snapshot: snapshot.snapshot,
      };
    })()`);
    if (!state.waiting) return state;
    if (Date.now() > deadline)
      throw new Error(
        `The packaged app did not become ready: ${JSON.stringify(state.waiting)}`,
      );
    await new Promise((wait) => setTimeout(wait, 500));
  }
}

async function command(session, body) {
  const reply = await session.evaluate(`(async () => {
    const { BrowserWindow } = require("electron");
    const main = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== "工作台助手");
    return main.webContents.executeJavaScript(${JSON.stringify(body)});
  })()`);
  if (!reply || reply.ok === false)
    throw new Error(
      `Command failed: ${JSON.stringify(reply && { code: reply.code, message: reply.message })}`,
    );
  return reply;
}

/**
 * The HarnessPlane entry in the trial build (spec RUNTIME-01): opens 设置 → 扩展管理 in the
 * main window, reads the AI-SDLC card and saves a capture of the page. Without an imported
 * runtime package the card must say 未安装 and offer no working action.
 */
async function extensionsProbe(session, capture) {
  const result = await session.evaluate(`(async () => {
    const { BrowserWindow } = require("electron");
    const main = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== "工作台助手");
    const read = await main.webContents.executeJavaScript(\`(async () => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms));
      const find = async (pick) => {
        for (let i = 0; i < 50; i++) { const found = pick(); if (found) return found; await wait(100); }
        return null;
      };
      const avatar = await find(() => [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").startsWith("我，个人空间")));
      if (!avatar) return { error: "no avatar button" };
      avatar.click();
      const nav = await find(() => [...document.querySelectorAll("nav[aria-label='设置分类'] button")].find((b) => b.textContent.trim() === "扩展管理"));
      if (!nav) return { error: "no 扩展管理 category" };
      nav.click();
      const card = await find(() => document.querySelector("article[aria-label='AI-SDLC 扩展']"));
      if (!card) return { error: "no AI-SDLC card" };
      const badge = card.querySelector(".extension-badge");
      const buttons = [...card.querySelectorAll("button")].map((b) => ({ label: b.textContent.trim(), disabled: b.disabled }));
      const hint = card.querySelector(".extension-hint");
      return { badge: badge ? badge.textContent.trim() : null, reason: hint ? hint.textContent.trim() : null, buttons, switches: card.querySelectorAll("[role=switch]").length };
    })()\`);
    const image = await main.webContents.capturePage();
    return { read, png: image.toPNG().toString("base64") };
  })()`);
  await writeFile(capture, Buffer.from(result.png, "base64"));
  return result.read;
}

/**
 * Quits through the product's own quit path. Node keeps the process until the inspector
 * detaches, so the socket stays open while the app shuts down (to read any recorded error
 * box) and is closed once Node reports that it waits for the debugger.
 */
async function quit(session) {
  await session.evaluate(
    `(() => { const { app } = require("electron"); setTimeout(() => app.quit(), 200); return true; })()`,
  );
  let errors = [];
  let exited = false;
  void session.exited.then(() => (exited = true));
  const deadline = Date.now() + 30000;
  while (!exited && Date.now() < deadline) {
    if (session.stderr().includes("Waiting for the debugger to disconnect"))
      break;
    const recorded = await Promise.race([
      session.evaluate("globalThis.smokeErrors ?? []", false).catch(() => null),
      new Promise((wait) => setTimeout(() => wait(null), 1000)),
    ]);
    if (recorded) errors = recorded;
    await new Promise((wait) => setTimeout(wait, 300));
  }
  session.socket.close();
  const timer = setTimeout(() => session.child.kill("SIGKILL"), 15000);
  const exit = await session.exited;
  clearTimeout(timer);
  return {
    ...exit,
    errors,
    ...(exit.signal === "SIGKILL"
      ? { stderr: session.stderr().split("\n").slice(-12) }
      : {}),
  };
}

/** The part of a snapshot this check compares: titles, drafts, providers and the appearance. */
function projection(snapshot) {
  return {
    conversations: snapshot.conversations
      .map((c) => ({ id: c.id, title: c.title, draft: c.draft ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    connections: snapshot.connections
      .map((c) => ({
        id: c.id,
        name: c.name,
        provider: c.provider,
        baseUrl: c.baseUrl,
        model: c.model,
        secretRef: c.secretRef,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    appearance: snapshot.settings?.appearance ?? null,
  };
}

async function digest(path) {
  return existsSync(path)
    ? createHash("sha256")
        .update(await readFile(path))
        .digest("hex")
    : null;
}

async function dataDirectories() {
  return existsSync(appData)
    ? (await readdir(appData)).filter((name) => !name.startsWith(".")).sort()
    : [];
}

await mkdir(home, { recursive: true });
await ensureKeychain();
const source = values.dmg
  ? await appFromImage(resolve(values.dmg))
  : { app: resolve(values.app), layout: null, link: null };
if (!isAbsolute(source.app)) throw new Error("App path must be absolute.");
const session = await launch(source.app);
const report = {
  phase: values.phase,
  app: basename(source.app),
  bundle: {
    identifier: session.plist.CFBundleIdentifier,
    name: session.plist.CFBundleName,
    displayName: session.plist.CFBundleDisplayName,
    version: session.plist.CFBundleShortVersionString,
    minimumSystemVersion: session.plist.LSMinimumSystemVersion ?? null,
  },
  image: source.layout
    ? { entries: source.layout, applicationsLink: source.link }
    : null,
};
try {
  const state = await ready(session);
  Object.assign(report, {
    internalName: state.name,
    locale: state.locale,
    version: state.version,
    packaged: state.packaged,
    appDataIsIsolated: state.appData === appData,
    userDataIsShellRoot:
      state.userData === join(appData, "csthink-assistant-shell"),
    titles: state.titles,
    anyFocusableWindow: state.focusable,
    applicationMenu: state.menu,
    tray: state.tray,
  });
  const seedFile = join(work, "seed.json");
  if (values.phase === "seed") {
    const conversation = randomUUID();
    const connection = randomUUID();
    await command(
      session,
      `window.desktop.command(${JSON.stringify({ type: "create", id: conversation })})`,
    );
    let snapshot = (
      await command(session, "window.desktop.command({ type: 'snapshot' })")
    ).snapshot;
    const titleRevision = snapshot.conversations.find(
      (c) => c.id === conversation,
    ).titleRevision;
    snapshot = (
      await command(
        session,
        `window.desktop.command(${JSON.stringify({ type: "renameConversation", id: conversation, title: "升级核对 upgrade check", revision: titleRevision })})`,
      )
    ).snapshot;
    const revision = snapshot.conversations.find(
      (c) => c.id === conversation,
    ).revision;
    await command(
      session,
      `window.desktop.command(${JSON.stringify({ type: "saveDraft", id: conversation, text: "草稿保留 draft kept", revision })})`,
    );
    // A synthetic key: it is only encrypted and stored, never sent anywhere.
    const secret = `sk-smoke-${randomBytes(12).toString("hex")}`;
    const saved = await command(
      session,
      `window.desktop.saveSecret(${JSON.stringify(secret)})`,
    );
    await command(
      session,
      `window.desktop.command(${JSON.stringify({
        type: "upsertConnection",
        id: connection,
        name: "Smoke provider",
        provider: "custom",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "smoke-model",
        secretRef: saved.secretRef,
        imageInput: "unknown",
        contextChars: null,
        revision: 0,
      })})`,
    );
    await command(
      session,
      `window.desktop.command({ type: 'setAppearance', appearance: 'dark' })`,
    );
    snapshot = (
      await command(session, "window.desktop.command({ type: 'snapshot' })")
    ).snapshot;
    report.data = projection(snapshot);
  } else {
    report.data = projection(state.snapshot);
    report.extensions = await extensionsProbe(
      session,
      join(work, "extensions.png"),
    );
  }
  report.exit = await quit(session);
  report.dataDirectories = await dataDirectories();
  report.vault = await digest(
    join(appData, "csthink-assistant-vault", "vault.json"),
  );
  report.vaultRefs = existsSync(
    join(appData, "csthink-assistant-vault", "vault.json"),
  )
    ? Object.keys(
        JSON.parse(
          await readFile(
            join(appData, "csthink-assistant-vault", "vault.json"),
            "utf8",
          ),
        ).secrets,
      ).sort()
    : [];
  report.keychainItems = keychainItems();
  if (values.phase === "seed") {
    await writeFile(seedFile, JSON.stringify(report, null, 2) + "\n");
  } else {
    const seed = JSON.parse(await readFile(seedFile, "utf8"));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    report.compare = {
      seededBy: seed.bundle,
      data: same(seed.data, report.data),
      dataDirectories: same(seed.dataDirectories, report.dataDirectories),
      vault: seed.vault !== null && seed.vault === report.vault,
      vaultRefs: same(seed.vaultRefs, report.vaultRefs),
      keychainItems: same(seed.keychainItems, report.keychainItems),
    };
  }
} catch (error) {
  session.child.kill("SIGKILL");
  throw error;
} finally {
  session.socket.close();
}
report.cleanExit =
  report.exit?.code === 0 && (report.exit?.errors ?? []).length === 0;
console.log(JSON.stringify({ work, ...report }, null, 2));
if (
  !report.cleanExit ||
  report.anyFocusableWindow ||
  !report.appDataIsIsolated ||
  (report.extensions &&
    (report.extensions.badge !== "未安装" ||
      report.extensions.switches !== 0 ||
      report.extensions.buttons.some((button) => !button.disabled))) ||
  (report.compare &&
    !Object.entries(report.compare).every(
      ([key, value]) => key === "seededBy" || value === true,
    ))
)
  process.exitCode = 1;
