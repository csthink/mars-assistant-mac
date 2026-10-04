import { test, expect } from "@playwright/test";
import { launchLocal, closeLocal } from "./local-client";
import { compileWidget } from "../../src/main/widget-build";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import type {
  WidgetRuntime,
  WidgetInstance,
} from "../../src/main/widget-runtime";
import type { BrowserWindow } from "electron";

type SizingHarness = {
  runtime: WidgetRuntime;
  instance: WidgetInstance;
  owner: BrowserWindow;
};
async function setup() {
  const built = await compileWidget(
    JSON.stringify({
      schemaVersion: 1,
      name: "自然尺寸",
      view: {
        html: '<section style="height:320px">第一时间卡</section><section style="height:400px">第二时间卡<span id="end">底部文字</span></section>',
        css: "body{margin:0;background:#d4edd4}section{box-sizing:border-box;border:1px solid #487748}",
        js: "",
      },
      config: [],
      draftFields: [],
      capabilities: [],
      resources: [
        {
          path: "assets/pixel.png",
          type: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4Y4AAAAASUVORK5CYII=",
        },
      ],
    }),
    resolve("dist/widget-build-worker.cjs"),
  );
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/sizing-"));
  const client = await launchLocal({
    args: [resolve("."), `--data-root=${root}`],
  });
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
      const owner = BrowserWindow.getAllWindows()[0];
      const runtime = new WidgetRuntime(
        async () => ({ ok: false, message: "none" }),
        () => {},
        async () => {},
        async () => {},
      );
      const instance = await runtime.create(owner, built, {
        widgetId: "sizing",
        candidateId: "sizing-candidate",
        surface: "main",
      });
      Reflect.set(globalThis, "sizingHarness", { runtime, instance, owner });
    },
    { built, file: resolve("dist/widget-runtime.cjs") },
  );
  return client;
}
test("widget sizing: clipping preserves the complete native layout viewport", async () => {
  const client = await setup();
  try {
    const result = await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      h.runtime.place(
        h.instance,
        h.owner,
        { x: 300, y: -200, width: 500, height: 720 },
        false,
      );
      await new Promise((r) => setTimeout(r, 100));
      return {
        bounds: h.instance.view.getBounds(),
        viewport: await h.instance.contents.executeJavaScript(
          "({width:innerWidth,height:innerHeight,content:document.body.scrollHeight})",
        ),
      };
    });
    console.log("sizing geometry", JSON.stringify(result));
    expect(result.viewport).toMatchObject({
      width: 500,
      height: 720,
      content: 720,
    });
  } finally {
    await closeLocal(client);
  }
});

test("widget sizing: natural height grows and shrinks independently of the current viewport", async () => {
  const client = await setup();
  try {
    await client.evaluate(() => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      h.runtime.place(
        h.instance,
        h.owner,
        { x: 300, y: 150, width: 500, height: 720 },
        false,
      );
    });
    const height = () =>
      client.evaluate(
        () =>
          (Reflect.get(globalThis, "sizingHarness") as SizingHarness).instance
            .layout.height,
      );
    await expect.poll(height).toBe(720);
    await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      await h.instance.contents.executeJavaScript(
        "document.querySelectorAll('section')[1].style.height='800px'",
      );
    });
    await expect.poll(height).toBe(1120);
    await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      await h.instance.contents.executeJavaScript(
        "document.querySelectorAll('section')[1].remove()",
      );
    });
    await expect.poll(height).toBe(320);
    await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      await h.instance.contents.executeJavaScript(
        `new Promise(resolve=>setTimeout(()=>{const c=document.createElement('canvas');c.width=200;c.height=200;c.style.display='block';document.body.append(c);resolve(true)},60))`,
      );
    });
    await expect.poll(height).toBe(520);
    await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      await h.instance.contents.executeJavaScript(
        `(async()=>{const image=new Image();image.style.cssText='display:block;width:100px;height:auto';await new Promise(r=>setTimeout(r,50));image.src='/assets/pixel.png';document.body.append(image);await image.decode()})()`,
      );
    });
    await expect.poll(height).toBe(620);

    await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      await h.instance.contents.executeJavaScript(
        `document.body.innerHTML='<p style="font-size:12px;line-height:1.5;margin:0;width:150px">'+ '迟到字体重新排版'.repeat(12)+'</p>'`,
      );
    });
    const beforeFont = await height();
    await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      await h.instance.contents.executeJavaScript(
        `(async()=>{const f=new FontFace('SizedLocal','local(Arial)');await f.load();document.fonts.add(f);document.querySelector('p').style.cssText+=';font-family:SizedLocal;font-size:28px';})()`,
      );
    });
    await expect.poll(height).toBeGreaterThan(beforeFont);
    await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      await h.instance.contents.executeJavaScript(
        `document.body.innerHTML='<div style="height:6000px">长表格内容<span style="position:absolute;top:5950px" id="tail">末尾</span></div>'`,
      );
    });
    await expect.poll(height).toBe(4096);
    const tail = await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      h.runtime.place(
        h.instance,
        h.owner,
        { x: 300, y: 150, width: 500, height: 4096 },
        false,
      );
      return h.instance.contents.executeJavaScript(
        `new Promise(resolve=>requestAnimationFrame(()=>{scrollTo(0,document.body.scrollHeight);resolve({scroll:scrollY,tail:document.querySelector('#tail').getBoundingClientRect().bottom,height:innerHeight})}))`,
      );
    });
    expect(tail.scroll).toBeGreaterThan(0);
    expect(tail.tail).toBeLessThanOrEqual(tail.height);
  } finally {
    await closeLocal(client);
  }
});

test("widget sizing: rejects stale width, forged identity and invalid measurements before bounded fallback", async () => {
  const client = await setup();
  try {
    const result = await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      h.runtime.place(
        h.instance,
        h.owner,
        { x: 300, y: 150, width: 500, height: 720 },
        false,
      );
      await new Promise((r) => setTimeout(r, 100));
      const wc = h.instance.contents;
      const handler = wc.ipc.listeners("widget:measure")[0];
      const event = { sender: wc, senderFrame: wc.mainFrame };
      const base = {
        generation: h.instance.identity.generation,
        version: h.instance.identity.version,
        widthRevision: h.instance.layout.widthRevision,
        width: 500,
        height: 700,
        diagnostic: "",
      };
      const initial = h.instance.layout.height;
      for (const bad of [
        { ...base, height: -1 },
        { ...base, height: NaN },
        { ...base, height: Infinity },
        { ...base, height: 1_000_001 },
        { ...base, width: 90000 },
        { ...base, generation: "forged" },
        { ...base, version: "old" },
        { ...base, widthRevision: 0 },
        { ...base, extra: true },
      ])
        handler(event, bad);
      handler({ sender: wc, senderFrame: h.owner.webContents.mainFrame }, base);
      const rejected = h.instance.layout.height === initial;
      h.runtime.place(
        h.instance,
        h.owner,
        { x: 300, y: 150, width: 400, height: 720 },
        false,
      );
      handler(event, base);
      const staleWidth = h.instance.layout.height === initial;
      const current = {
        ...base,
        width: 400,
        widthRevision: h.instance.layout.widthRevision,
      };
      handler(event, { ...current, height: 6000 });
      const limited = { ...h.instance.layout };
      h.instance.heightChanges = [];
      for (let i = 0; i < 21; i++)
        handler(event, { ...current, height: 800 + i * 2 });
      const unstable = { ...h.instance.layout };
      handler(event, { ...current, height: 400 });
      const frozen = h.instance.layout.height;
      await h.runtime.retire(h.instance);
      handler(event, { ...current, height: 600 });
      return {
        rejected,
        staleWidth,
        limited,
        unstable,
        frozen,
        retired: h.instance.layout.height === frozen,
      };
    });
    expect(result.rejected).toBe(true);
    expect(result.staleWidth).toBe(true);
    expect(result.limited).toMatchObject({ height: 4096, mode: "limited" });
    expect(result.unstable).toMatchObject({ height: 360, mode: "unstable" });
    expect(result.frozen).toBe(360);
    expect(result.retired).toBe(true);
  } finally {
    await closeLocal(client);
  }
});

test("widget sizing: compatibility diagnosis preserves package CSS and transform animation does not change height", async () => {
  const client = await setup();
  try {
    await client.evaluate(() => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      h.runtime.place(
        h.instance,
        h.owner,
        { x: 300, y: 150, width: 500, height: 720 },
        false,
      );
    });
    await expect
      .poll(() =>
        client.evaluate(
          () =>
            (Reflect.get(globalThis, "sizingHarness") as SizingHarness).instance
              .layout.height,
        ),
      )
      .toBe(720);
    const result = await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      h.instance.heightChanges = [];
      await h.instance.contents.executeJavaScript(
        "document.querySelector('section').animate([{transform:'translateY(0px)'},{transform:'translateY(90px)'}],{duration:80,iterations:30})",
      );
      await new Promise((r) => setTimeout(r, 2200));
      const animated = {
        height: h.instance.layout.height,
        changes: h.instance.heightChanges.length,
        mode: h.instance.layout.mode,
      };
      await h.instance.contents.executeJavaScript(
        "document.body.style.height='200px';document.body.style.overflow='hidden'",
      );
      await new Promise((r) => setTimeout(r, 100));
      const clipped = { ...h.instance.layout };
      const css = await h.instance.contents.executeJavaScript(
        "document.body.style.cssText",
      );
      await h.instance.contents.executeJavaScript(
        "document.body.style.cssText='min-height:100vh'",
      );
      await new Promise((r) => setTimeout(r, 100));
      return { animated, clipped, css, viewport: { ...h.instance.layout } };
    });
    expect(result.animated).toMatchObject({
      height: 720,
      changes: 0,
      mode: "natural",
    });
    expect(result.clipped.diagnostic).toBe("internal-clipping");
    expect(result.css).toContain("overflow: hidden");
    expect(result.viewport).toMatchObject({
      mode: "compatibility",
      height: 360,
      diagnostic: "viewport-layout",
    });
  } finally {
    await closeLocal(client);
  }
});
