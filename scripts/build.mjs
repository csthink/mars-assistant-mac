import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
if (process.platform === "darwin")
  execFileSync(
    "/usr/bin/clang",
    [
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "src/main/codex-process.c",
      "-o",
      "dist/codex-process",
    ],
    { stdio: "inherit" },
  );
if (process.platform === "darwin")
  execFileSync(
    "/usr/bin/clang++",
    [
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
      "-I",
      resolve(dirname(process.execPath), "../include/node"),
      "src/main/panel-events.mm",
      "-o",
      "dist/panel-events.node",
    ],
    { stdio: "inherit" },
  );
if (process.platform === "darwin")
  execFileSync(
    "/usr/bin/clang++",
    [
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
      "src/main/widget-clip.mm",
      "-o",
      "dist/widget-clip.node",
    ],
    { stdio: "inherit" },
  );
await Promise.all([
  build({
    entryPoints: {
      main: "src/main/index.ts",
      service: "src/service/entry.ts",
      extract: "src/service/extract.ts",
      "search-worker": "src/service/search-worker.ts",
      preload: "src/main/preload.ts",
      "claude-mcp": "src/main/claude-mcp.ts",
      "widget-runtime": "src/main/widget-runtime.ts",
      "widget-preload": "src/main/widget-preload.ts",
      "widget-build-worker": "src/main/widget-build-worker.ts",
    },
    outdir: "dist",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    target: "node24",
    external: ["electron"],
    sourcemap: true,
  }),
  build({
    entryPoints: ["src/renderer/index.tsx"],
    outfile: "dist/renderer.js",
    bundle: true,
    platform: "browser",
    target: "chrome144",
    sourcemap: true,
    define: { "process.env.NODE_ENV": '"production"' },
  }),
  copyFile("src/renderer/index.html", "dist/index.html"),
  // PDF.js loads its parser as a sibling module of the extraction worker bundle.
  copyFile(
    "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    "dist/pdf.worker.mjs",
  ),
]);

// The menu bar icon is a template image (black plus transparency, the file name ends in
// Template) at 20 × 20 points in both pixel densities. assets/icon/README.md describes the files.
await copyFile("assets/icon/brand-mark.svg", "dist/brand-mark.svg");
for (const scale of ["", "@2x"])
  await copyFile(
    `assets/icon/trayTemplate${scale}.png`,
    `dist/trayTemplate${scale}.png`,
  );
