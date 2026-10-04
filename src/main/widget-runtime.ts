import {
  BrowserWindow,
  WebContentsView,
  View,
  session,
  type Rectangle,
  type Session,
  type IpcMainInvokeEvent,
} from "electron";
import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { freezeWidget, widgetLimits, type BuiltWidget } from "../shared/widget";
import {
  parseWidgetRequest,
  validWidgetReply,
  widgetCapabilities,
  widgetChannel,
  widgetFailure,
  type WidgetIdentity,
  type WidgetReply,
  type WidgetRequest,
} from "../shared/widget-runtime";
import type { WidgetLayoutSignal } from "../shared/widget-ui";
import { verifyBuiltWidget } from "./widget-package";

const csp =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-same-origin; webrtc 'block'";
const headers = {
  "Content-Security-Policy": csp,
  "X-Content-Type-Options": "nosniff",
  "X-DNS-Prefetch-Control": "off",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), display-capture=(), fullscreen=(), usb=(), serial=(), hid=(), bluetooth=(), clipboard-read=(), clipboard-write=(), payment=()",
};
export interface WidgetInstance {
  readonly identity: WidgetIdentity;
  readonly id: number;
  readonly owner: BrowserWindow;
  readonly view: WebContentsView;
  readonly clip: View;
  layout: WidgetLayoutSignal;
  heightChanges: number[];
  measuredRevision: number;
  measurementTimer?: ReturnType<typeof setTimeout>;
  readonly contents: Electron.WebContents;
  readonly url: string;
  readonly partition: Session;
  active: boolean;
  retired: boolean;
  ready: boolean;
  inflight: Set<Promise<WidgetReply>>;
}
type Dispatch = (
  identity: Readonly<WidgetIdentity>,
  request: WidgetRequest,
) => Promise<WidgetReply>;
/** One manager is owned by the trusted host. No package can construct identities or choose sessions. */
export class WidgetRuntime {
  private instances = new Map<number, WidgetInstance>();
  private retiring = new Map<number, Promise<void>>();
  private closed = false;
  private proxy?: Server;
  private sockets = new Set<Socket>();
  private proxyReady?: Promise<string>;
  constructor(
    private dispatch: Dispatch,
    private onFailure: (identity: WidgetIdentity, message: string) => void,
    private register: (identity: WidgetIdentity) => Promise<void>,
    private revoke: (identity: WidgetIdentity) => Promise<void>,
    private onLayout: (
      identity: WidgetIdentity,
      layout: WidgetLayoutSignal,
    ) => void = () => {},
    private onInput: (
      identity: WidgetIdentity,
      input:
        | { kind: "hover" | "focus"; value: boolean }
        | { kind: "scroll"; x: number; y: number },
    ) => void = () => {},
  ) {}

  private denyProxy(): Promise<string> {
    // No DIRECT fallback, including Chromium's implicit loopback bypass. This
    // process-owned endpoint closes sockets without forwarding or interpreting data.
    return (this.proxyReady ??= new Promise((resolve, reject) => {
      const server = (this.proxy = createServer((socket) => {
        this.sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => this.sockets.delete(socket));
        socket.destroy();
      }));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string")
          return reject(new Error("控件网络隔离初始化失败。"));
        resolve(`http://127.0.0.1:${address.port}`);
      });
    }));
  }
  async create(
    owner: BrowserWindow,
    built: BuiltWidget,
    identity: Omit<WidgetIdentity, "generation" | "version">,
  ): Promise<WidgetInstance> {
    if (
      this.closed ||
      owner.isDestroyed() ||
      !owner.isVisible() ||
      owner.webContents.isLoadingMainFrame()
    )
      throw new Error("请等待窗口就绪后再打开预览。");
    if (!verifyBuiltWidget(built)) throw new Error("控件资源校验失败。");
    const fixed = freezeWidget(structuredClone(built));
    const generation = randomUUID();
    const subject = freezeWidget({
      ...identity,
      version: fixed.digest,
      generation,
    });
    const origin = `csthink-widget://${generation}`;
    const url = `${origin}/index.html`;
    const partition = session.fromPartition(`widget-${generation}`, {
      cache: false,
    });
    await partition.setProxy({
      mode: "fixed_servers",
      proxyRules: await this.denyProxy(),
      proxyBypassRules: "<-loopback>",
    });
    partition.setPermissionCheckHandler(() => false);
    partition.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    partition.setDevicePermissionHandler(() => false);
    partition.setDisplayMediaRequestHandler((_request, callback) =>
      callback({}),
    );
    partition.on("will-download", (event, item) => {
      event.preventDefault();
      item.cancel();
    });
    const view = new WebContentsView({
      webPreferences: {
        session: partition,
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        plugins: false,
        experimentalFeatures: false,
        webgl: false,
        navigateOnDragDrop: false,
        devTools: false,
        safeDialogs: true,
        disableDialogs: true,
        preload: join(__dirname, "widget-preload.cjs"),
      },
    });
    view.setBorderRadius(8);
    view.setVisible(false);
    const clip = new View();
    clip.setBorderRadius(8);
    clip.addChildView(view);
    const contents = view.webContents;
    const instance: WidgetInstance = {
      owner,
      identity: subject,
      id: contents.id,
      contents,
      view,
      clip,
      layout: {
        generation,
        version: fixed.digest,
        widthRevision: 0,
        width: 0,
        height: 240,
        mode: "natural",
      },
      heightChanges: [],
      measuredRevision: -1,
      url,
      partition,
      active: true,
      retired: false,
      ready: false,
      inflight: new Set(),
    };
    this.instances.set(contents.id, instance);
    const resource = (requested: string) => {
      if (!instance.active || !requested.startsWith(origin + "/"))
        return undefined;
      const path = requested.slice(origin.length + 1);
      return Object.hasOwn(fixed.resources, path)
        ? fixed.resources[path]
        : undefined;
    };
    partition.protocol.handle("csthink-widget", (request) => {
      if (!instance.active || request.method !== "GET")
        return new Response(null, { status: 403 });
      if (request.url === `${origin}/guard.html`)
        return new Response("<!doctype html><title>控件资源校验</title>", {
          headers: { ...headers, "Content-Type": "text/html" },
        });
      const item = resource(request.url);
      if (!item) return new Response(null, { status: 403 });
      return new Response(Buffer.from(item.data, "base64"), {
        headers: { ...headers, "Content-Type": item.type },
      });
    });
    partition.webRequest.onBeforeRequest((details, callback) => {
      const own = details.webContentsId === contents.id;
      const path = details.url.slice(origin.length + 1);
      const permitted =
        instance.active &&
        own &&
        details.method === "GET" &&
        (details.resourceType === "mainFrame"
          ? !instance.ready &&
            (details.url === url || details.url === `${origin}/guard.html`)
          : !!resource(details.url) &&
            ((details.resourceType === "script" && path === "view.js") ||
              (details.resourceType === "stylesheet" && path === "view.css") ||
              (details.resourceType === "image" &&
                path.startsWith("assets/"))));
      callback({ cancel: !permitted });
    });
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-frame-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("content-bounds-updated", (event) => event.preventDefault());
    contents.on("select-bluetooth-device", (event, _devices, callback) => {
      event.preventDefault();
      callback("");
    });
    contents.on("unresponsive", () =>
      this.fail(instance, "控件没有响应，已关闭预览。"),
    );
    contents.on("render-process-gone", () =>
      this.fail(instance, "控件运行中断，请重新打开预览。"),
    );
    const contentsId = contents.id;
    contents.once("destroyed", () => {
      void this.retire(instance);
      this.instances.delete(contentsId);
      if (!owner.isDestroyed()) owner.contentView.removeChildView(clip);
    });
    let epoch = Date.now(),
      count = 0,
      total = 0;
    contents.ipc.handle(
      widgetChannel,
      (event: IpcMainInvokeEvent, raw: unknown) => {
        if (Date.now() - epoch >= 1000) {
          epoch = Date.now();
          count = 0;
          total = 0;
        }
        total++;
        if (total > 120) this.fail(instance, "控件请求过于频繁，已关闭预览。");
        if (
          !this.authorized(instance, event) ||
          ++count > 30 ||
          instance.inflight.size >= 4 ||
          typeof raw !== "string" ||
          Buffer.byteLength(raw) > widgetLimits.stateBytes + 512
        )
          return widgetFailure;
        const request = parseWidgetRequest(raw);
        if (
          !request ||
          (widgetCapabilities[request.method] !== undefined &&
            !fixed.manifest.capabilities.includes(
              widgetCapabilities[request.method]!,
            )) ||
          (request.method === "writeDraft" &&
            !fixed.manifest.draftFields.includes(request.field))
        )
          return widgetFailure;
        const work = Promise.resolve()
          .then(() => this.dispatch(subject, request))
          .then(
            (reply) =>
              validWidgetReply(reply) &&
              Buffer.byteLength(JSON.stringify(reply)) <=
                widgetLimits.stateBytes
                ? reply
                : widgetFailure,
            () => widgetFailure,
          );
        instance.inflight.add(work);
        void work.finally(() => instance.inflight.delete(work));
        return work;
      },
    );
    contents.ipc.on("widget:measure", (event, raw: unknown) => {
      if (!this.authorized(instance, event) || !raw || typeof raw !== "object")
        return;
      const r = raw as Record<string, unknown>;
      const layout = instance.layout;
      if (
        Object.keys(r).sort().join(",") !==
          "diagnostic,generation,height,version,width,widthRevision" ||
        r.generation !== subject.generation ||
        r.version !== subject.version ||
        r.widthRevision !== layout.widthRevision ||
        r.width !== layout.width ||
        typeof r.height !== "number" ||
        !Number.isFinite(r.height) ||
        r.height < 0 ||
        r.height > 1_000_000 ||
        ![
          "",
          "internal-clipping",
          "viewport-layout",
          "content-width",
          "measurement-limit",
        ].includes(String(r.diagnostic))
      )
        return;
      if (layout.mode === "unstable") return;
      const initial = instance.measuredRevision !== layout.widthRevision;
      instance.measuredRevision = layout.widthRevision;
      clearTimeout(instance.measurementTimer);
      const height = Math.max(1, Math.min(4096, Math.ceil(r.height)));
      const changed =
        Math.abs(r.height - layout.height) >= 1 && height !== layout.height;
      const now = performance.now();
      instance.heightChanges = instance.heightChanges.filter(
        (t) => now - t < 2000,
      );
      if (changed) instance.heightChanges.push(now);
      const diagnostic = String(r.diagnostic);
      const unstable = instance.heightChanges.length > 20;
      instance.layout = {
        ...layout,
        height:
          unstable ||
          diagnostic === "viewport-layout" ||
          diagnostic === "measurement-limit"
            ? 360
            : changed
              ? height
              : layout.height,
        mode: unstable
          ? "unstable"
          : diagnostic
            ? "compatibility"
            : r.height > 4096
              ? "limited"
              : "natural",
        diagnostic: unstable
          ? "unstable-height"
          : diagnostic || (r.height > 4096 ? "height-limit" : undefined),
      };
      if (
        initial ||
        changed ||
        layout.mode !== instance.layout.mode ||
        layout.diagnostic !== instance.layout.diagnostic
      )
        this.onLayout(subject, { ...instance.layout });
    });
    let lastInput = 0;
    contents.ipc.on("widget:display-input", (event, raw: unknown) => {
      if (!this.authorized(instance, event) || !raw || typeof raw !== "object")
        return;
      const r = raw as Record<string, unknown>;
      if (
        (r.kind === "hover" || r.kind === "focus") &&
        typeof r.value === "boolean"
      )
        this.onInput(subject, { kind: r.kind, value: r.value });
      if (
        r.kind === "scroll" &&
        typeof r.x === "number" &&
        typeof r.y === "number" &&
        Number.isFinite(r.x) &&
        Number.isFinite(r.y) &&
        performance.now() - lastInput >= 8
      ) {
        lastInput = performance.now();
        this.onInput(subject, {
          kind: "scroll",
          x: Math.max(-2000, Math.min(2000, r.x)),
          y: Math.max(-2000, Math.min(2000, r.y)),
        });
      }
    });
    let ping: { nonce: string; sent: number } | undefined;
    contents.ipc.on("widget:pong", (event, nonce: unknown) => {
      if (
        instance.active &&
        event.sender === contents &&
        event.senderFrame === contents.mainFrame &&
        event.senderFrame?.url === url &&
        nonce === ping?.nonce
      )
        ping = undefined;
    });
    // The host initiates probes. Renderer background timer scheduling is not a
    // liveness signal; only a matching response from this frame completes a probe.
    const watchdog = setInterval(() => {
      if (!instance.active || !instance.ready) return;
      // The owner's hide event follows macOS occlusion notifications, and a window hidden
      // while it is already occluded emits none; visibility itself is the authority.
      if (owner.isDestroyed() || !owner.isVisible()) {
        void this.retire(instance);
        return;
      }
      if (!ping) {
        ping = { nonce: randomUUID(), sent: performance.now() };
        contents.send("widget:ping", ping.nonce);
      } else if (performance.now() - ping.sent > 5000) {
        this.fail(
          instance,
          "控件没有响应，已关闭预览。未确认的输入可能未保存。",
        );
      }
    }, 1000);
    contents.once("destroyed", () => clearInterval(watchdog));
    owner.contentView.addChildView(clip);
    const retire = () => {
      void this.retire(instance);
    };
    // macOS Electron also emits "hide" from the window's occlusion state (fully covered by
    // another window, another Space, a locked screen). Only a window that is no longer
    // visible (hide(), minimize) has hidden the view; an occluded window still shows it.
    const hidden = () => {
      if (!owner.isVisible()) retire();
    };
    owner.once("closed", retire);
    owner.on("hide", hidden);
    owner.webContents.on("did-start-navigation", retire);
    owner.webContents.on("render-process-gone", retire);
    contents.once("destroyed", () => {
      owner.removeListener("closed", retire);
      owner.removeListener("hide", hidden);
      if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) {
        owner.webContents.removeListener("did-start-navigation", retire);
        owner.webContents.removeListener("render-process-gone", retire);
      }
    });
    try {
      await this.deadline(this.register(subject));
      await this.deadline(contents.loadURL(`${origin}/guard.html`));
      // Decode declared images before package code runs, inside Chromium's sandbox.
      // The fixed source consumes only serialized URLs, never generated JavaScript.
      const images = fixed.manifest.resources.map(
        (asset) => `${origin}/${asset.path}`,
      );
      const valid = await this.deadline(
        contents.executeJavaScript(`(async () => {
        let pixels = 0;
        for (const url of ${JSON.stringify(images)}) {
          const image = new Image(); image.src = url; await image.decode();
          if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 2048 || image.naturalHeight > 2048) return false;
          pixels += image.naturalWidth * image.naturalHeight;
          if (pixels > 4194304) return false;
        }
        return true;
      })()`),
      );
      if (!valid) throw new Error("控件图片尺寸或解码无效。");
      await this.deadline(contents.loadURL(url));
      if (!instance.active || owner.isDestroyed())
        throw new Error("控件实例已关闭。");
      instance.ready = true;
      return instance;
    } catch {
      await this.retire(instance);
      throw new Error("控件资源无法安全载入。");
    }
  }
  private authorized(instance: WidgetInstance, event: IpcMainInvokeEvent) {
    return (
      instance.active &&
      !instance.owner.isDestroyed() &&
      instance.owner.isVisible() &&
      this.instances.get(event.sender.id) === instance &&
      event.sender === instance.contents &&
      event.senderFrame === event.sender.mainFrame &&
      event.senderFrame?.url === instance.url
    );
  }
  /** Only the trusted host supplies geometry; reserve a toolbar and outer gutters. */
  place(
    instance: WidgetInstance,
    owner: BrowserWindow,
    rectangle: Rectangle,
    occluded: boolean,
    contentOnly = false,
    visibleRectangle: Rectangle = rectangle,
  ) {
    if (
      !instance.active ||
      !instance.ready ||
      instance.owner !== owner ||
      owner.isDestroyed()
    )
      return;
    const { width, height } = owner.getContentBounds();
    if (
      occluded ||
      !owner.isVisible() ||
      !Object.values(rectangle).every(Number.isFinite) ||
      !Object.values(visibleRectangle).every(Number.isFinite) ||
      rectangle.width < 1 ||
      rectangle.width > 8192 ||
      rectangle.height < 1 ||
      rectangle.height > 4096
    ) {
      instance.view.setVisible(false);
      instance.clip.setVisible(false);
      return;
    }
    const layoutWidth = Math.ceil(rectangle.width),
      layoutHeight = Math.ceil(rectangle.height);
    const x = Math.max(
      contentOnly ? 0 : 16,
      Math.ceil(rectangle.x),
      Math.ceil(visibleRectangle.x),
    );
    const y = Math.max(
      contentOnly ? 0 : 96,
      Math.ceil(rectangle.y),
      Math.ceil(visibleRectangle.y),
    );
    const right = Math.min(
      width - (contentOnly ? 0 : 16),
      Math.floor(rectangle.x + rectangle.width),
      Math.floor(visibleRectangle.x + visibleRectangle.width),
    );
    const bottom = Math.min(
      height - (contentOnly ? 0 : 16),
      Math.floor(rectangle.y + rectangle.height),
      Math.floor(visibleRectangle.y + visibleRectangle.height),
    );
    // The child retains its full viewport; the parent owns clipping and position.
    instance.clip.setBounds({
      x,
      y,
      width: Math.max(0, right - x),
      height: Math.max(0, bottom - y),
    });
    instance.view.setBounds({
      x: Math.floor(rectangle.x) - x,
      y: Math.floor(rectangle.y) - y,
      width: layoutWidth,
      height: layoutHeight,
    });
    const shown = right > x && bottom > y;
    instance.view.setVisible(shown);
    instance.clip.setVisible(shown);
    if (instance.layout.width !== layoutWidth) {
      instance.layout = {
        ...instance.layout,
        width: layoutWidth,
        widthRevision: instance.layout.widthRevision + 1,
      };
      instance.contents.send("widget:layout", { ...instance.layout });
      clearTimeout(instance.measurementTimer);
      const revision = instance.layout.widthRevision;
      instance.measurementTimer = setTimeout(() => {
        if (
          !instance.active ||
          instance.measuredRevision === revision ||
          instance.layout.widthRevision !== revision
        )
          return;
        instance.layout = {
          ...instance.layout,
          height: 360,
          mode: "compatibility",
          diagnostic: "measurement-timeout",
        };
        this.onLayout(instance.identity, { ...instance.layout });
      }, 2000);
    }
  }

  private fail(instance: WidgetInstance, message: string) {
    if (!instance.active) return;
    void this.retire(instance);
    this.onFailure(instance.identity, message);
  }
  retire(instance: WidgetInstance): Promise<void> {
    const id = instance.id;
    const pending = this.retiring.get(id);
    if (pending) return pending;
    if (instance.retired) return Promise.resolve();
    clearTimeout(instance.measurementTimer);
    instance.retired = true;
    instance.active = false;
    if (!instance.contents.isDestroyed()) {
      instance.view.setVisible(false);
      instance.clip.setVisible(false);
    }
    this.instances.delete(instance.id);
    const retiring = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...instance.inflight]),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 2000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!instance.contents.isDestroyed())
        instance.contents.close({ waitForBeforeUnload: false });
      await this.revoke(instance.identity).catch(() => {});
      instance.partition.protocol.unhandle("csthink-widget");
      await instance.partition.clearStorageData();
    })();
    this.retiring.set(id, retiring);
    void retiring.then(
      () => this.retiring.delete(id),
      () => this.retiring.delete(id),
    );
    return retiring;
  }
  private async deadline<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("控件载入超时。")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async close() {
    this.closed = true;
    await Promise.all(
      [...this.instances.values()].map((instance) => this.retire(instance)),
    );
    await Promise.allSettled([...this.retiring.values()]);
    for (const socket of this.sockets) socket.destroy();
    if (this.proxy)
      await new Promise<void>((resolve) => this.proxy!.close(() => resolve()));
  }
}
