import { test, expect } from "@playwright/test";
import { launchLocal, closeLocal } from "./local-client";
import { compileWidget } from "../../src/main/widget-build";
import {
  assertWidgetDrawingClipVersion,
  widgetDrawingClipPlanes,
} from "../../src/main/widget-drawing-clip";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
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

test("widget sizing: natural height grows and shrinks independently of the current viewport", async ({}, info) => {
  const client = await setup();
  try {
    await client.evaluate(() => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      h.runtime.place(
        h.instance,
        h.owner,
        { x: 300, y: 1500, width: 370, height: 240 },
        false,
        false,
        { x: 300, y: 1500, width: 370, height: 0 },
      );
    });
    await expect
      .poll(() =>
        client.evaluate(async () => {
          const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
          return {
            viewport: await h.instance.contents.executeJavaScript(
              "({width:innerWidth,height:innerHeight})",
            ),
            layout: h.instance.layout,
            measured: h.instance.measuredRevision,
            visible: h.instance.view.getVisible(),
          };
        }),
      )
      .toMatchObject({
        layout: { height: 720, width: 370, widthRevision: 1, mode: "natural" },
        measured: 1,
        visible: false,
        viewport: { width: 370, height: 240 },
      });
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
  } catch (error) {
    await info.attach("measurement-failure-state", {
      body: JSON.stringify(
        await client.evaluate(async () => {
          const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
          return {
            layout: h.instance.layout,
            measured: h.instance.measuredRevision,
            visible: h.instance.view.getVisible(),
            viewBounds: h.instance.view.getBounds(),
            records: Reflect.get(globalThis, "widgetLayoutRecords"),
            viewport: await h.instance.contents.executeJavaScript(
              "({width:innerWidth,height:innerHeight,hidden:document.hidden,content:document.body.scrollHeight})",
            ),
          };
        }),
      ),
      contentType: "application/json",
    });
    throw error;
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

test("widget sizing: native clipping preserves hit testing and layout across resize and disposal", async () => {
  mkdirSync(".test-data/disposable", { recursive: true });
  const directory = mkdtempSync(
    resolve(".test-data/disposable/native-clipping-"),
  );
  const module = join(directory, "native-probe.node");
  execFileSync("/usr/bin/clang++", [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-std=c++17",
    "-fobjc-arc",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-framework",
    "AppKit",
    "-framework",
    "QuartzCore",
    "-I",
    resolve(dirname(process.execPath), "../include/node"),
    "tests/desktop/widget-native-probe.mm",
    "-o",
    module,
  ]);
  const client = await setup();
  try {
    const read = () =>
      client.evaluate(({ BrowserWindow }, module) => {
        const probe = process.getBuiltinModule("module").createRequire(module)(
          module,
        );
        return JSON.parse(
          probe.inspect(
            BrowserWindow.getAllWindows()[0].getNativeWindowHandle(),
          ),
        ) as {
          rootHeight: number;
          clips: {
            frame: Electron.Rectangle;
            bounds: Electron.Rectangle;
            clips: boolean;
            mask: boolean;
            hidden: boolean;
            children: Electron.Rectangle[];
            insideHitsWidget: boolean;
            aboveHitsWidget: boolean;
          }[];
        };
      }, module);
    for (const [width, height, y] of [
      [500, 720, -200],
      [420, 720, 140],
      [550, 900, -350],
    ]) {
      await client.evaluate(
        ({ BrowserWindow }, { width, height, y }) => {
          const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
          BrowserWindow.getAllWindows()[0].setContentSize(width + 400, 680);
          h.runtime.place(
            h.instance,
            h.owner,
            { x: 300, y, width, height },
            false,
            false,
            { x: 300, y: 180, width, height: 400 },
          );
        },
        { width, height, y },
      );
      await expect
        .poll(async () => {
          const result = await read();
          const c = result.clips[0];
          return (
            !!c &&
            c.clips &&
            c.mask &&
            !c.hidden &&
            c.insideHitsWidget &&
            !c.aboveHitsWidget &&
            c.children[0]?.height === height
          );
        })
        .toBe(true);
      const result = await read(),
        clip = result.clips[0];
      expect(clip.frame).toEqual(clip.bounds);
      expect(clip.frame.y + clip.frame.height).toBe(result.rootHeight - 180);
      expect(clip.children).toHaveLength(1);
      expect(clip.children[0]).toEqual({
        x: 300,
        y: result.rootHeight - y - height,
        width,
        height,
      });
      expect(
        await client.evaluate(async () => {
          const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
          return h.instance.contents.executeJavaScript(
            "({width:innerWidth,height:innerHeight})",
          );
        }),
      ).toEqual({ width, height });
    }
    for (const occluded of [false, true]) {
      await client.evaluate((_, occluded) => {
        const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
        h.runtime.place(
          h.instance,
          h.owner,
          { x: 300, y: 150, width: 500, height: 720 },
          occluded,
          false,
          { x: 300, y: 180, width: 500, height: occluded ? 400 : 0 },
        );
      }, occluded);
      await expect
        .poll(async () => {
          const clip = (await read()).clips[0];
          return {
            hidden: clip.hidden,
            inside: clip.insideHitsWidget,
            above: clip.aboveHitsWidget,
          };
        })
        .toEqual({ hidden: true, inside: false, above: false });
      expect(
        await client.evaluate(() => {
          const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
          return {
            child: h.instance.view.getVisible(),
            root: h.instance.clip.getVisible(),
          };
        }),
      ).toEqual({ child: false, root: false });
    }
    const stopped = await client.evaluate(({ BrowserWindow }, module) => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      process
        .getBuiltinModule("module")
        .createRequire(module)(module)
        .detach(BrowserWindow.getAllWindows()[0].getNativeWindowHandle());
      h.runtime.place(
        h.instance,
        h.owner,
        { x: 300, y: 150, width: 500, height: 720 },
        false,
      );
      return !h.instance.active;
    }, module);
    expect(stopped).toBe(true);
    await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      await h.runtime.retire(h.instance);
      await h.runtime.retire(h.instance);
    });
    await expect.poll(async () => (await read()).clips.length).toBe(0);
    const rejected = await client.evaluate(({ BrowserWindow }, file) => {
      const native = process.getBuiltinModule("module").createRequire(file)(
        file,
      );
      const pending = native.beginAttach(
        BrowserWindow.getAllWindows()[0].getNativeWindowHandle(),
      );
      try {
        native.finishAttach(pending);
        return false;
      } catch {
        native.dispose(pending);
        native.dispose(pending);
        return true;
      }
    }, resolve("dist/widget-clip.node"));
    expect(rejected).toBe(true);
    const ambiguous = await client.evaluate(
      ({ BrowserWindow, WebContentsView }, file) => {
        const owner = BrowserWindow.getAllWindows()[0];
        const native = process.getBuiltinModule("module").createRequire(file)(
          file,
        );
        const pending = native.beginAttach(owner.getNativeWindowHandle());
        const views = [new WebContentsView(), new WebContentsView()];
        for (const view of views) {
          view.setVisible(false);
          owner.contentView.addChildView(view);
        }
        try {
          native.finishAttach(pending);
          return false;
        } catch {
          return true;
        } finally {
          native.dispose(pending);
          for (const view of views) {
            owner.contentView.removeChildView(view);
            view.webContents.close();
          }
        }
      },
      resolve("dist/widget-clip.node"),
    );
    expect(ambiguous).toBe(true);
    expect((await read()).clips).toHaveLength(0);
  } finally {
    await closeLocal(client);
  }
});

test("widget sizing: compositor masks retain narrow visible strips without changing the document viewport", async () => {
  expect(() => assertWidgetDrawingClipVersion("44.2.0")).not.toThrow();
  expect(() => assertWidgetDrawingClipVersion("44.2.1")).toThrow();
  expect(() =>
    widgetDrawingClipPlanes({ x: 0, y: 0, width: NaN, height: 1 }),
  ).toThrow();
  expect(() =>
    widgetDrawingClipPlanes({ x: 0, y: 0, width: 1, height: -1 }),
  ).toThrow();
  const client = await setup();
  try {
    const result = await client.evaluate(async () => {
      const h = Reflect.get(globalThis, "sizingHarness") as SizingHarness;
      const original: Electron.View[] = [];
      for (
        let view: Electron.View = h.instance.clip;
        view !== h.instance.view;
        view = view.children[0]
      )
        original.push(view);
      const outputs = [];
      for (const axis of ["height", "width"] as const) {
        for (const size of [33, 32, 31, 1, 0, 1, 33]) {
          const full = { x: 300, y: 140, width: 500, height: 720 };
          const visible = {
            x: 320,
            y: 220,
            width: 420,
            height: 300,
            [axis]: size,
          };
          h.runtime.place(h.instance, h.owner, full, false, false, visible);
          await new Promise((r) => setTimeout(r, 20));
          const masks = [];
          let x = 0,
            y = 0,
            index = 0;
          let stable = true;
          for (
            let view: Electron.View = h.instance.clip;
            view !== h.instance.view;
            view = view.children[0]
          ) {
            stable &&= view === original[index++];
            const bounds = view.getBounds();
            x += bounds.x;
            y += bounds.y;
            masks.push({ ...bounds, x, y });
          }
          const intersection = masks.reduce((a, b) => {
            const x = Math.max(a.x, b.x),
              y = Math.max(a.y, b.y);
            return {
              x,
              y,
              width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
              height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
            };
          });
          const child = h.instance.view.getBounds();
          outputs.push({
            axis,
            size,
            stable,
            masks,
            intersection,
            expected: visible,
            childInWindow: { ...child, x: child.x + x, y: child.y + y },
            full,
            visible: h.instance.clip.getVisible(),
            viewport: await h.instance.contents.executeJavaScript(
              "({width:innerWidth,height:innerHeight})",
            ),
          });
        }
      }
      const short = [];
      for (const height of [33, 32, 31, 1]) {
        h.runtime.place(
          h.instance,
          h.owner,
          { x: 300, y: 200, width: 500, height },
          false,
        );
        await new Promise((r) => setTimeout(r, 20));
        short.push({
          height,
          viewport: await h.instance.contents.executeJavaScript(
            "({width:innerWidth,height:innerHeight})",
          ),
          visible: h.instance.view.getVisible(),
        });
      }
      await h.runtime.retire(h.instance);
      await h.runtime.retire(h.instance);
      let rejected = false;
      try {
        h.instance.drawingClip.place(
          { x: 0, y: 0, width: 500, height: 720 },
          { x: 0, y: 0, width: 1, height: 1 },
        );
      } catch {
        rejected = true;
      }
      return {
        outputs,
        short,
        rejected,
        detached: !h.owner.contentView.children.includes(h.instance.clip),
        childrenReleased: original.every((view) => view.children.length === 0),
      };
    });
    expect(result.outputs).toHaveLength(14);
    for (const state of result.outputs) {
      expect(state.stable).toBe(true);
      expect(state.masks).toHaveLength(4);
      expect(state.masks.every((r) => r.width >= 32 && r.height >= 32)).toBe(
        true,
      );
      expect(state.intersection).toEqual(state.expected);
      expect(state.childInWindow).toEqual(state.full);
      expect(state.viewport).toEqual({ width: 500, height: 720 });
      expect(state.visible).toBe(state.size > 0);
    }
    for (const state of result.short) {
      expect(state.viewport).toEqual({ width: 500, height: state.height });
      expect(state.visible).toBe(true);
    }
    expect(result.rejected).toBe(true);
    expect(result.detached).toBe(true);
    expect(result.childrenReleased).toBe(true);
  } finally {
    await closeLocal(client);
  }
});
