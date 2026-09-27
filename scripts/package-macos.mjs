import { packager } from "@electron/packager";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    "data-root": { type: "string" },
    "widget-acceptance": { type: "boolean", default: false },
  },
});
if (process.platform !== "darwin")
  throw new Error("This packaging entry requires macOS.");
if (values["data-root"] && !isAbsolute(values["data-root"]))
  throw new Error("data-root must be absolute.");
if (values["widget-acceptance"] && !values["data-root"])
  throw new Error("Widget acceptance requires an explicit isolated data-root.");
const stage = await mkdtemp(join(tmpdir(), "csthink-package-"));
try {
  await mkdir(join(stage, "dist"));
  for (const file of await readdir("dist", { withFileTypes: true })) {
    if (
      file.isFile() &&
      (file.name === "codex-process" ||
        /\.(cjs|mjs|js|css|html|png|map|node)$/.test(file.name))
    )
      await cp(join("dist", file.name), join(stage, "dist", file.name));
  }
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      main: "dist/main.cjs",
      description: pkg.description,
    }),
  );
  if (values["data-root"])
    await writeFile(
      join(stage, "runtime.json"),
      JSON.stringify({
        dataRoot: values["data-root"],
        widgetAcceptance: values["widget-acceptance"],
      }),
    );
  const result = await packager({
    dir: stage,
    out: resolve(values.out ?? "dist/packaged"),
    name: "csthink-assistant",
    appBundleId: "com.csthink.assistant",
    platform: "darwin",
    arch: process.arch,
    electronVersion: pkg.devDependencies.electron,
    asar: false,
    overwrite: false,
    protocols: [
      {
        name: "csthink-assistant conversation",
        schemes: ["csthink-assistant"],
      },
    ],
  });
  console.log(
    JSON.stringify(
      {
        paths: result,
        dataRoot: values["data-root"] ?? "default",
        widgetAcceptance: values["widget-acceptance"],
        signing:
          "Local development bundle; no distribution signing or notarization.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
