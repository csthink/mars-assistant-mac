import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWidgetPackage,
  parseWidgetPackage,
  verifyBuiltWidget,
} from "../../src/main/widget-package";
const good = () => ({
  schemaVersion: 1,
  name: "本地记事测试候选",
  view: {
    html: '<textarea id="note"></textarea>',
    css: "body { color: #222; }",
    js: 'document.title = "测试候选";',
  },
  config: [{ id: "title", label: "标题", type: "text", default: "我的笔记" }],
  draftFields: ["note"],
  capabilities: ["data.read", "data.write", "draft.write", "config.read"],
  resources: [],
});
test("widget package: deterministic build, immutable output and tampering rejection", () => {
  const source = JSON.stringify(good());
  const a = buildWidgetPackage(source),
    b = buildWidgetPackage(source);
  assert.deepEqual(a, b);
  assert(verifyBuiltWidget(a));
  assert(Object.isFrozen(a.resources));
  assert(Object.isFrozen(a.manifest.view));
  assert.throws(() => {
    a.resources["view.js"].data = "bad";
  });
  const altered = structuredClone(a);
  altered.resources["view.js"].data = Buffer.from("bad").toString("base64");
  assert.equal(verifyBuiltWidget(altered), false);
  const spoof = structuredClone(a);
  spoof.digest = "0".repeat(64);
  assert.equal(verifyBuiltWidget(spoof), false);
});
test("widget package: unknown fields, tooling, versions, capabilities and duplicate JSON rejected", () => {
  const source = JSON.stringify(good());
  assert.throws(
    () =>
      parseWidgetPackage(
        source.replace(
          '"schemaVersion":1',
          '"schemaVersion":1,"schemaVersion":1',
        ),
      ),
    /重复/,
  );
  for (const change of [
    { schemaVersion: 2 },
    { scripts: { build: "touch /tmp/forbidden" } },
    { widgetId: "other" },
    { capabilities: ["network"] },
    { background: "while(true){}" },
  ])
    assert.throws(() =>
      parseWidgetPackage(JSON.stringify({ ...good(), ...change })),
    );
  assert.throws(() => parseWidgetPackage('{"schemaVersion":1,}'));
  assert.throws(() => parseWidgetPackage(" ".repeat(1_048_577)));
});
test("widget package: syntax and static or dynamic dependencies rejected without evaluation", () => {
  for (const js of [
    "const = ;",
    'import x from "node:fs"',
    'import("https://example.invalid/evil")',
    'const p = "./x"; import(p)',
    "export const a = 1;",
  ])
    assert.throws(() =>
      buildWidgetPackage(
        JSON.stringify({ ...good(), view: { ...good().view, js } }),
      ),
    );
  const marker = "__CSTHINK_WIDGET_MUST_NOT_RUN__";
  buildWidgetPackage(
    JSON.stringify({
      ...good(),
      view: {
        ...good().view,
        js: `globalThis.${marker} = true; throw new Error("never execute");`,
      },
    }),
  );
  assert.equal(Reflect.get(globalThis, marker), undefined);
});
test("widget package: path escapes, symbolic metadata and disguised resources rejected", () => {
  for (const path of [
    "../other.png",
    "/secret.png",
    "assets/../other.png",
    "assets/%2e%2e.png",
    "assets/a\\b.png",
    "file:///secret.png",
    "assets/a.js",
  ])
    assert.throws(() =>
      buildWidgetPackage(
        JSON.stringify({
          ...good(),
          resources: [{ path, type: "image/png", data: "AAAA" }],
        }),
      ),
    );
  assert.throws(() =>
    buildWidgetPackage(
      JSON.stringify({
        ...good(),
        resources: [
          {
            path: "assets/a.png",
            type: "image/png",
            data: "AAAA",
            symlink: "/secret",
          },
        ],
      }),
    ),
  );
  assert.throws(() =>
    buildWidgetPackage(
      JSON.stringify({
        ...good(),
        resources: [{ path: "assets/a.png", type: "image/png", data: "AAAA" }],
      }),
    ),
  );
});
test("widget package: config types, unique field identities and input bounds", () => {
  for (const config of [
    [...good().config, ...good().config],
    [{ ...good().config[0], id: "__proto__" }],
    [{ ...good().config[0], type: "number" }],
  ])
    assert.throws(() =>
      parseWidgetPackage(JSON.stringify({ ...good(), config })),
    );
  assert.throws(() =>
    parseWidgetPackage(
      JSON.stringify({ ...good(), draftFields: ["note", "note"] }),
    ),
  );
  assert.throws(() =>
    parseWidgetPackage(
      JSON.stringify({
        ...good(),
        view: { ...good().view, html: "x".repeat(262_145) },
      }),
    ),
  );
});

test("widget package: bounded worker builds without executing input and reports parser failure", async () => {
  const { build } = await import("esbuild");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { compileWidget } = await import("../../src/main/widget-build");
  const dir = await mkdtemp(join(tmpdir(), "csthink-widget-build-test-"));
  try {
    const worker = join(dir, "compiler.cjs");
    await build({
      entryPoints: [resolve("src/main/widget-build-worker.ts")],
      outfile: worker,
      bundle: true,
      platform: "node",
      format: "cjs",
    });
    const built = await compileWidget(JSON.stringify(good()), worker);
    assert(verifyBuiltWidget(built));
    assert(Object.isFrozen(built.resources));
    assert(Object.isFrozen(built.manifest.view));
    await assert.rejects(
      compileWidget('{"schemaVersion":2}', worker),
      /未知|缺失/,
    );
    await assert.rejects(compileWidget("x".repeat(1_048_577), worker), /超过/);
    const hung = join(dir, "hung.cjs");
    await writeFile(hung, "while (true) {}");
    const before = Date.now();
    await assert.rejects(compileWidget(JSON.stringify(good()), hung), /超时/);
    assert(Date.now() - before < 5000);
    const crashed = join(dir, "crash.cjs");
    await writeFile(crashed, 'throw new Error("synthetic worker failure")');
    await assert.rejects(
      compileWidget(JSON.stringify(good()), crashed),
      /进程失败/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("widget package: declared local image bytes preserved and duplicate resource identity rejected", () => {
  const resource = {
    path: "assets/pixel.png",
    type: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4Y4AAAAASUVORK5CYII=",
  };
  const built = buildWidgetPackage(
    JSON.stringify({ ...good(), resources: [resource] }),
  );
  assert.deepEqual(built.resources[resource.path], {
    type: resource.type,
    data: resource.data,
  });
  assert(verifyBuiltWidget(built));
  assert.throws(
    () =>
      buildWidgetPackage(
        JSON.stringify({ ...good(), resources: [resource, resource] }),
      ),
    /重复/,
  );
});

test("widget package: image dimensions, total pixels, animation and truncated structures refused before decoding", () => {
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4Y4AAAAASUVORK5CYII=",
    "base64",
  );
  const source = (data: Buffer, count = 1) =>
    JSON.stringify({
      ...good(),
      resources: Array.from({ length: count }, (_, i) => ({
        path: `assets/pixel${i}.png`,
        type: "image/png",
        data: data.toString("base64"),
      })),
    });
  const giant = Buffer.from(pixel);
  giant.writeUInt32BE(100000, 16);
  assert.throws(() => buildWidgetPackage(source(giant)), /图片/);
  const budget = Buffer.from(pixel);
  budget.writeUInt32BE(2048, 16);
  budget.writeUInt32BE(2048, 20);
  assert.throws(() => buildWidgetPackage(source(budget, 2)), /总像素/);
  const animated = Buffer.from(pixel);
  animated.write("acTL", 37, "ascii");
  assert.throws(() => buildWidgetPackage(source(animated)), /图片/);
  assert.throws(
    () => buildWidgetPackage(source(pixel.subarray(0, 40))),
    /图片/,
  );
});
