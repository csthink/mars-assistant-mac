import { test, expect } from "@playwright/test";
import { launchLocal } from "./local-client";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { compileWidget } from "../../src/main/widget-build";
import type {
  WidgetRuntime,
  WidgetInstance,
} from "../../src/main/widget-runtime";
import type {
  WidgetIdentity,
  WidgetRequest,
} from "../../src/shared/widget-runtime";
import type { BrowserWindow } from "electron";

type Harness = {
  runtime: WidgetRuntime;
  instance: WidgetInstance;
  owner: BrowserWindow;
  calls: { identity: WidgetIdentity; request: WidgetRequest }[];
  failures: string[];
  heartbeats: unknown[];
  lifecycle: string[];
  writeGate?: Promise<void>;
  releaseWrite?: () => void;
};
const candidate = (js = 'document.body.dataset.ready = "yes";') =>
  JSON.stringify({
    schemaVersion: 1,
    name: "边界测试候选",
    view: {
      html: '<h1>边界测试候选</h1><textarea id="note"></textarea>',
      css: "body { background: #eee; color: #111; }",
      js,
    },
    config: [],
    draftFields: ["note"],
    capabilities: ["data.read", "data.write", "draft.write"],
    resources: [],
  });

async function setup(source = candidate()) {
  const built = await compileWidget(
    source,
    resolve("dist/widget-build-worker.cjs"),
  );
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/widget-"));
  const client = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
  });
  try {
    const shell = await client.firstWindow();
    await expect(
      shell
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    await expect
      .poll(() =>
        client.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isVisible(),
        ),
      )
      .toBe(true);
    await client.evaluate(
      async ({ BrowserWindow }, { built, file }) => {
        const { WidgetRuntime } = process
          .getBuiltinModule("module")
          .createRequire(file)(
          file,
        ) as typeof import("../../src/main/widget-runtime");
        const calls: Harness["calls"] = [],
          failures: string[] = [];
        const runtime = new WidgetRuntime(
          async (identity, request) => {
            calls.push({ identity, request });
            if (request.method === "writeDraft")
              await (Reflect.get(globalThis, "widgetHarness") as Harness)
                .writeGate;
            return { ok: true, revision: 0, value: { note: "已确认测试草稿" } };
          },
          (_identity, message) => failures.push(message),
          async () => {},
          async () => {},
        );
        const owner = BrowserWindow.getAllWindows()[0];
        // Every path that retires a healthy view without a failure record (KB-229):
        // owner hide, owner close, owner navigation, owner renderer loss, contents destroyed.
        const lifecycle: string[] = [];
        owner.on("hide", () => lifecycle.push("owner hide"));
        owner.once("closed", () => lifecycle.push("owner closed"));
        owner.webContents.on(
          "did-start-navigation",
          (details: {
            url: string;
            isSameDocument: boolean;
            isMainFrame: boolean;
          }) =>
            lifecycle.push(
              `owner navigation ${details.isMainFrame ? "main" : "sub"} ${details.isSameDocument ? "same-document" : "document"} ${details.url}`,
            ),
        );
        owner.webContents.on("render-process-gone", (_event, details) =>
          lifecycle.push(`owner render-process-gone ${details.reason}`),
        );
        const instance = await runtime.create(owner, built, {
          widgetId: "test-widget",
          candidateId: "test-candidate",
          surface: "main",
        });
        instance.contents.on("destroyed", () =>
          lifecycle.push("contents destroyed"),
        );
        const heartbeats: unknown[] = [];
        instance.contents.on("ipc-message", (event, channel) => {
          if (heartbeats.length < 12)
            heartbeats.push({
              channel,
              url: event.senderFrame?.url,
              same: event.senderFrame === instance.contents.mainFrame,
            });
        });
        Reflect.set(globalThis, "widgetHarness", {
          heartbeats,
          lifecycle,
          runtime,
          instance,
          owner,
          calls,
          failures,
        });
      },
      { built, file: resolve("dist/widget-runtime.cjs") },
    );
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

test("widget runtime: bounded resources, isolated bridge identity, capabilities and native clipping", async () => {
  const client = await setup();
  try {
    const outcome = await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "widgetHarness") as Harness;
      const wc = h.instance.contents;
      const page =
        await wc.executeJavaScript(`(async () => ({ ready: document.body.dataset.ready, node: typeof require, desktop: typeof desktop,
        methods: Object.keys(widget).sort(), read: await widget.readDraft(), denied: await widget.readConfig(),
        field: await widget.writeDraft(0, 'undeclared', 'x'), oversized: await widget.writeData(0, { x: 'x'.repeat(70000) }),
        unsafe: await widget.writeData(0, JSON.parse('{"__proto__":{"x":1}}')) }))()`);
      h.runtime.place(
        h.instance,
        h.owner,
        { x: -100, y: -100, width: 5000, height: 4096 },
        false,
      );
      // Drawing masks include padding; their intersection is the visible boundary.
      const masks = [];
      let x = 0,
        y = 0;
      for (
        let view: Electron.View = h.instance.clip;
        view !== h.instance.view;
        view = view.children[0]
      ) {
        const rect = view.getBounds();
        x += rect.x;
        y += rect.y;
        masks.push({ ...rect, x, y });
      }
      const bounds = masks.reduce((a, b) => {
        const x = Math.max(a.x, b.x),
          y = Math.max(a.y, b.y);
        return {
          x,
          y,
          width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
          height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
        };
      });
      h.runtime.place(
        h.instance,
        h.owner,
        { x: 16, y: 120, width: 300, height: 200 },
        true,
      );
      return {
        page,
        calls: h.calls.filter((call) => call.request.method !== "readView"),
        bounds,
        maskCount: masks.length,
        hidden: !h.instance.view.getVisible(),
        partition: h.instance.partition.isPersistent(),
      };
    });
    expect(outcome.page).toMatchObject({
      ready: "yes",
      node: "undefined",
      desktop: "undefined",
      read: { ok: true },
      denied: { ok: false },
      field: { ok: false },
      oversized: { ok: false },
      unsafe: { ok: false },
    });
    expect(outcome.page.methods).toEqual([
      "readConfig",
      "readData",
      "readDraft",
      "writeData",
      "writeDraft",
    ]);
    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0].identity).toMatchObject({
      widgetId: "test-widget",
      candidateId: "test-candidate",
      surface: "main",
    });
    expect(outcome.calls[0].identity.generation).toMatch(/^[0-9a-f-]{36}$/);
    expect(outcome.partition).toBe(false);
    expect(outcome.maskCount).toBe(4);
    expect(outcome.bounds.x).toBe(16);
    expect(outcome.bounds.y).toBe(96);
    expect(outcome.hidden).toBe(true);
    const stale = await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "widgetHarness") as Harness;
      const wc = h.instance.contents;
      // Exercise the receiver with the actual frame object, then revoke it before dispatch.
      const handler = Reflect.get(wc.ipc, "_invokeHandlers").get(
        "widget:request",
      );
      const event = { sender: wc, senderFrame: wc.mainFrame };
      const forged = await handler(
        event,
        JSON.stringify({ method: "readData", candidateId: "other" }),
      );
      const wrongFrame = await handler(
        { sender: wc, senderFrame: h.owner.webContents.mainFrame },
        JSON.stringify({ method: "readData" }),
      );
      await h.runtime.retire(h.instance);
      const old = await handler(event, JSON.stringify({ method: "readData" }));
      return {
        forged,
        wrongFrame,
        old,
        destroyed: wc.isDestroyed(),
        calls: h.calls.filter((call) => call.request.method !== "readView")
          .length,
      };
    });
    expect(stale).toMatchObject({
      forged: { ok: false },
      wrongFrame: { ok: false },
      old: { ok: false },
      destroyed: true,
      calls: 1,
    });
  } finally {
    await client.evaluate(async () =>
      (Reflect.get(globalThis, "widgetHarness") as Harness).runtime.close(),
    );
    await client.close();
  }
});

test("widget runtime: actual network, WebSocket, WebRTC, frames, file, permissions and downloads refused", async () => {
  const requests: string[] = [],
    datagrams: number[] = [];
  let connections = 0;
  const receiver = createServer((req, res) => {
    requests.push(req.url ?? "unknown");
    res.writeHead(302, { Location: "/redirect-target" });
    res.end();
  });
  receiver.on("connection", () => {
    connections++;
  });
  receiver.on("upgrade", (_req, socket) => {
    requests.push("websocket");
    socket.destroy();
  });
  await new Promise<void>((done) => receiver.listen(0, "127.0.0.1", done));
  const address = receiver.address();
  if (!address || typeof address === "string") throw new Error("receiver");
  const udp = createSocket("udp4");
  udp.on("message", (data) => datagrams.push(data.length));
  await new Promise<void>((done) => udp.bind(0, "127.0.0.1", done));
  const http = `http://127.0.0.1:${address.port}`;
  await fetch(`${http}/positive-control`, {
    redirect: "manual",
    headers: { Connection: "close" },
  });
  expect(requests).toEqual(["/positive-control"]);
  requests.length = 0;
  connections = 0;
  const received = new Promise<void>((done) =>
    udp.once("message", () => done()),
  );
  udp.send(Buffer.from("positive-control"), udp.address().port, "127.0.0.1");
  await received;
  expect(datagrams).toEqual([16]);
  datagrams.length = 0;
  const client = await setup();
  try {
    const result = await client.evaluate(
      async ({ webContents }, { http, udpPort, tcpPort }) => {
        const h = Reflect.get(globalThis, "widgetHarness") as Harness;
        const before = webContents.getAllWebContents().length;
        let downloads = 0;
        h.instance.partition.on("will-download", () => {
          downloads++;
        });
        h.instance.contents.on("console-message", (_event, ...args) => {
          console.error("widget-console", args);
        });
        const result = await h.instance.contents
          .executeJavaScript(`(async () => {
        const attempt = async (fn) => { try { await fn(); return 'allowed'; } catch (error) { return error.name; } };
        const http = ${JSON.stringify(http)};
        const out = {}; globalThis.boundaryProgress = out;
        out.fetch = await attempt(() => fetch(http + '/fetch'));
        out.file = await attempt(() => fetch('file:///etc/hosts'));
        out.other = await attempt(() => fetch('csthink-widget://other/index.html'));
        out.sw = await attempt(() => navigator.serviceWorker.register('/view.js'));
        out.worker = await new Promise(resolve => { try { const worker = new Worker('/view.js'); worker.onerror = () => { worker.terminate(); resolve('denied'); }; worker.onmessage = () => { worker.terminate(); resolve('allowed'); }; } catch { resolve('denied'); } });
        out.websocket = await new Promise(resolve => { try { const socket = new WebSocket(http.replace('http:', 'ws:') + '/ws'); socket.onerror = () => resolve('denied'); socket.onopen = () => { socket.close(); resolve('allowed'); }; } catch { resolve('denied'); } });
        out.popup = window.open(http + '/popup') === null;
        const frame = document.createElement('iframe'); frame.src = http + '/frame'; document.body.append(frame);
        const image = new Image(); image.src = http + '/image'; document.body.append(image);
        const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob(['synthetic'])); link.download = 'blocked.txt'; link.click();
        out.notification = await attempt(async () => { if (await Notification.requestPermission() !== 'granted') throw new Error('denied'); });
        out.media = await attempt(() => navigator.mediaDevices.getUserMedia({audio:true}));
        out.rtc = await new Promise(async resolve => {
          const peers = [new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }, { urls: 'turn:127.0.0.1:${tcpPort}?transport=tcp', username: 'synthetic', credential: 'synthetic' }] }), new RTCPeerConnection()];
          let settled = false;
          const finish = result => { if (settled) return; settled = true; const states = peers.map(p => ({ ice: p.iceConnectionState, gathering: p.iceGatheringState, candidates: (p.localDescription?.sdp.match(/a=candidate:/g) || []).length })); peers.forEach(p => p.close()); resolve({result, states}); };
          peers.forEach(p => p.oniceconnectionstatechange = () => { if (p.iceConnectionState === 'failed') finish('failed'); if (p.iceConnectionState === 'connected') finish('connected'); });
          peers[0].createDataChannel('test');
          peers[0].onicecandidate = e => { if(e.candidate) peers[1].addIceCandidate(e.candidate).catch(() => {}); };
          peers[1].onicecandidate = e => { if(e.candidate) peers[0].addIceCandidate(e.candidate).catch(() => {}); };
          try { await peers[0].setLocalDescription(await peers[0].createOffer()); await peers[1].setRemoteDescription(peers[0].localDescription); await peers[1].setLocalDescription(await peers[1].createAnswer()); await peers[0].setRemoteDescription(peers[1].localDescription); } catch { finish('rejected'); }
          setTimeout(() => finish('timeout'), 3000);
        });
        await new Promise(resolve => setTimeout(resolve, 200));
        out.frame = frame.contentDocument?.URL ?? 'blocked';
        location.href = http + '/redirect';
        return out;
      })()`);
        return {
          result,
          popupCount: webContents.getAllWebContents().length - before,
          downloads,
          url: h.instance.contents.getURL(),
          expectedURL: h.instance.url,
        };
      },
      { http, udpPort: udp.address().port, tcpPort: address.port },
    );
    console.log(
      JSON.stringify({
        boundaries: result,
        receivedHTTP: requests,
        receivedUDP: datagrams,
        connections,
      }),
    );
    expect(result.result.fetch).not.toBe("allowed");
    expect(result.result.file).not.toBe("allowed");
    expect(result.result.other).not.toBe("allowed");
    expect(result.result.sw).not.toBe("allowed");
    expect(result.result.worker).not.toBe("allowed");
    expect(result.result.websocket).toBe("denied");
    expect(result.result.popup).toBe(true);
    expect(result.result.notification).not.toBe("allowed");
    expect(result.result.media).not.toBe("allowed");
    expect(result.result.rtc.states).toHaveLength(2);
    for (const state of result.result.rtc.states) {
      expect(state.gathering).toBe("complete");
      expect(state.ice).not.toBe("connected");
      expect(state.candidates).toBe(0);
    }
    expect(result.result.frame).not.toContain(http);
    expect(result.popupCount).toBe(0);
    expect(result.url).toBe(result.expectedURL);
    expect(requests).toEqual([]);
    expect(datagrams).toEqual([]);
    expect(connections).toBe(0);
    // Positive control uses the same Chromium binary, with network policy absent.
    // It runs only synthetic ICE traffic against the already-owned loopback sockets. The ICE agent reaches
    // them on its own schedule, so the peer connection stays open until both have seen its traffic.
    await client.evaluate(
      async ({ BrowserWindow, session }, { udpPort, tcpPort }) => {
        const partition = session.fromPartition(
          `widget-positive-${Date.now()}`,
        );
        partition.setPermissionCheckHandler(() => true);
        const window = new BrowserWindow({
          show: false,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            session: partition,
          },
        });
        try {
          await window.loadURL(
            "data:text/html,<title>Local ICE positive control</title>",
          );
          await window.webContents.executeJavaScript(`(async () => {
          const pc = new RTCPeerConnection({ iceServers: [{urls:'stun:127.0.0.1:${udpPort}'}, {urls:'turn:127.0.0.1:${tcpPort}?transport=tcp',username:'synthetic',credential:'synthetic'}] });
          globalThis.positivePeer = pc;
          pc.createDataChannel('test'); await pc.setLocalDescription(await pc.createOffer());
        })()`);
        } catch (error) {
          window.destroy();
          throw error;
        }
        Reflect.set(globalThis, "icePositiveWindow", window);
      },
      { udpPort: udp.address().port, tcpPort: address.port },
    );
    try {
      await expect.poll(() => connections).toBeGreaterThan(0);
      await expect.poll(() => datagrams.length).toBeGreaterThan(0);
    } finally {
      const positive = await client.evaluate(async () => {
        const window = Reflect.get(
          globalThis,
          "icePositiveWindow",
        ) as BrowserWindow;
        try {
          return await window.webContents.executeJavaScript(`(() => {
          const pc = globalThis.positivePeer;
          const result = { gathering: pc.iceGatheringState, candidates: (pc.localDescription.sdp.match(/a=candidate:/g) || []).length }; pc.close(); return result;
        })()`);
        } finally {
          window.destroy();
        }
      });
      console.log(
        JSON.stringify({
          positive,
          positiveTCP: connections,
          positiveUDP: datagrams.length,
        }),
      );
    }
  } finally {
    await client.evaluate(async () =>
      (Reflect.get(globalThis, "widgetHarness") as Harness).runtime.close(),
    );
    await client.close();
    udp.close();
    await new Promise<void>((done) => receiver.close(() => done()));
  }
});

test("widget runtime: hung generated script retires without blocking the trusted host", async () => {
  const client = await setup(
    candidate(
      'document.body.dataset.ready = "yes"; setTimeout(() => { while(true) {} }, 500);',
    ),
  );
  try {
    await expect
      .poll(
        () =>
          client.evaluate(() =>
            (
              Reflect.get(globalThis, "widgetHarness") as Harness
            ).instance.contents.isDestroyed(),
          ),
        { timeout: 12000 },
      )
      .toBe(true);
    const page = await client.firstWindow();
    await expect(
      page
        .locator("#main-sidebar")
        .getByRole("button", { name: "新建聊天", exact: true }),
    ).toBeEnabled();
    const outcome = await client.evaluate(() => {
      const h = Reflect.get(globalThis, "widgetHarness") as Harness;
      return { failures: h.failures, lifecycle: h.lifecycle };
    });
    console.log("hung diagnostic", outcome);
    expect(outcome.failures).toHaveLength(1);
  } finally {
    await client.evaluate(async () =>
      (Reflect.get(globalThis, "widgetHarness") as Harness).runtime.close(),
    );
    await client.close();
  }
});

test("widget runtime: healthy isolated view survives watchdog and decoded image is displayed", async () => {
  const source = JSON.parse(candidate());
  source.resources = [
    {
      path: "assets/pixel.png",
      type: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4Y4AAAAASUVORK5CYII=",
    },
  ];
  source.view.html += '<img src="/assets/pixel.png" alt="本地测试像素">';
  const client = await setup(JSON.stringify(source));
  try {
    await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "widgetHarness") as Harness;
      h.runtime.place(
        h.instance,
        h.owner,
        { x: 260, y: 200, width: 300, height: 200 },
        false,
      );
      await new Promise((resolve) => setTimeout(resolve, 6500));
    });
    const state = await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "widgetHarness") as Harness;
      return {
        active: h.instance.active,
        failures: h.failures,
        // Which silent retire path fired (owner hide, contents destroyed) when a healthy view disappears (KB-229).
        lifecycle: h.lifecycle,
        heartbeats: h.heartbeats,
        image: h.instance.active
          ? await h.instance.contents.executeJavaScript(
              "document.querySelector('img').naturalWidth",
            )
          : -1,
      };
    });
    console.log("healthy diagnostic", state);
    expect(state).toMatchObject({ active: true, failures: [], image: 1 });
  } finally {
    await client.evaluate(async () =>
      (Reflect.get(globalThis, "widgetHarness") as Harness).runtime.close(),
    );
    await client.close();
  }
  const original = Buffer.from(source.resources[0].data, "base64");
  const corrupted = Buffer.concat([
    original.subarray(0, 33),
    original.subarray(-12),
  ]);
  source.resources[0].data = corrupted.toString("base64");
  const rejected = await setup(JSON.stringify(source)).then(
    async (unexpected) => {
      await unexpected.evaluate(async () =>
        (Reflect.get(globalThis, "widgetHarness") as Harness).runtime.close(),
      );
      await unexpected.close();
      return false;
    },
    (error: Error) => {
      console.log("image refusal", error.message);
      return /无法安全载入/.test(error.message);
    },
  );
  expect(rejected).toBe(true);
});

test("widget runtime: an occlusion hide event on a visible owner keeps the view and a real hide still retires it", async () => {
  const client = await setup();
  try {
    const result = await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "widgetHarness") as Harness;
      h.runtime.place(
        h.instance,
        h.owner,
        { x: 260, y: 200, width: 300, height: 200 },
        false,
      );
      const before = h.heartbeats.length;
      // macOS Electron emits "hide" for a fully covered window while isVisible() stays true (KB-229).
      h.owner.emit("hide");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const occluded = {
        active: h.instance.active,
        viewVisible: h.instance.view.getVisible(),
        ownerVisible: h.owner.isVisible(),
        failures: h.failures,
        lifecycle: [...h.lifecycle],
        pongs: h.heartbeats.length - before,
        destroyed: h.instance.contents.isDestroyed(),
      };
      h.owner.hide();
      // The hide event itself depends on an occlusion change; the runtime also polls visibility.
      const deadline = performance.now() + 5000;
      while (h.instance.active && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        occluded,
        hidden: {
          active: h.instance.active,
          ownerVisible: h.owner.isVisible(),
        },
      };
    });
    console.log("occlusion diagnostic", result);
    expect(result.occluded).toMatchObject({
      active: true,
      viewVisible: true,
      ownerVisible: true,
      failures: [],
      destroyed: false,
    });
    expect(result.occluded.lifecycle).toContain("owner hide");
    expect(result.occluded.pongs).toBeGreaterThanOrEqual(1);
    expect(result.hidden).toEqual({ active: false, ownerVisible: false });
  } finally {
    await client.evaluate(async () =>
      (Reflect.get(globalThis, "widgetHarness") as Harness).runtime.close(),
    );
    await client.close();
  }
});
test("widget runtime: owner hide revokes immediately, drains accepted writes for at most two seconds and rejects hidden creation", async () => {
  const client = await setup();
  try {
    await client.evaluate(() => {
      const h = Reflect.get(globalThis, "widgetHarness") as Harness;
      h.writeGate = new Promise<void>((resolve) => {
        h.releaseWrite = resolve;
      });
      void h.instance.contents.executeJavaScript(
        "void widget.writeDraft(0, 'note', 'in-flight')",
      );
    });
    await expect
      .poll(() =>
        client.evaluate(() =>
          (Reflect.get(globalThis, "widgetHarness") as Harness).calls.some(
            (call) => call.request.method === "writeDraft",
          ),
        ),
      )
      .toBe(true);
    const result = await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "widgetHarness") as Harness;
      const wc = h.instance.contents;
      const handler = Reflect.get(wc.ipc, "_invokeHandlers").get(
        "widget:request",
      );
      const event = { sender: wc, senderFrame: wc.mainFrame };
      h.owner.hide();
      // The hide event itself depends on an occlusion change; the runtime also polls visibility.
      const deadline = performance.now() + 5000;
      while (h.instance.active && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      const start = performance.now();
      const active = h.instance.active,
        visible = h.instance.view.getVisible();
      const first = h.runtime.retire(h.instance),
        second = h.runtime.retire(h.instance);
      const rejected = await handler(
        event,
        JSON.stringify({ method: "readData" }),
      );
      await first;
      return {
        active,
        visible,
        same: first === second,
        rejected,
        elapsed: performance.now() - start,
        destroyed: wc.isDestroyed(),
      };
    });
    expect(result).toMatchObject({
      active: false,
      visible: false,
      same: true,
      rejected: { ok: false },
      destroyed: true,
    });
    expect(result.elapsed).toBeGreaterThanOrEqual(1900);
    expect(result.elapsed).toBeLessThan(3500);
    const built = await compileWidget(
      candidate(),
      resolve("dist/widget-build-worker.cjs"),
    );
    const hidden = await client.evaluate(async (_electron, built) => {
      const h = Reflect.get(globalThis, "widgetHarness") as Harness;
      h.releaseWrite?.();
      try {
        await h.runtime.create(h.owner, built, {
          widgetId: "test-widget",
          candidateId: "test-candidate",
          surface: "main",
        });
        return "accepted";
      } catch (error) {
        return String(error);
      }
    }, built);
    expect(hidden).toContain("请等待窗口就绪");
  } finally {
    await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "widgetHarness") as Harness;
      h.releaseWrite?.();
      await h.runtime.close();
    });
    await client.close();
  }
});
