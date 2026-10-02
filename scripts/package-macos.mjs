import { packager } from "@electron/packager";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

/**
 * Packages the macOS app bundle "Qingluan.app" (shown as 青鸾 whatever the system language)
 * with an ad-hoc signature, and with --dmg also the
 * arm64 disk image of the trial build. There is no Developer ID signature and no
 * notarization: a downloaded copy must be allowed once in System Settings > Privacy &
 * Security.
 *
 * The bundle identifier, the internal application name (app.setName in src/main/index.ts),
 * the data directories and the keychain item do not depend on anything set here.
 */
const productName = "Qingluan";
const bundleId = "com.csthink.assistant";
/** Localized names per bundle localization; other languages use the base Info.plist value. */
/**
 * The display name in every localization of the bundle; equal to src/shared/app-name.ts, which a
 * service test compares. The interface is Chinese only, so the Finder, the Dock and the menu bar
 * show 青鸾 for every system language; the base Info.plist keeps Qingluan, the file name, which the
 * Finder requires before it shows a localized name.
 */
const displayName = "青鸾";
/** The lowest macOS version the product is built and accepted for (spec D-01). */
const minimumSystemVersion = "26.6.2";
/**
 * The app icon (assets/icon/README.md): AppIcon.icns is built from the PNG set with iconutil
 * (CFBundleIconFile, every macOS version), and the compiled asset catalog Assets.car carries
 * the layered icon macOS 26 and later render natively (CFBundleIconName).
 */
const iconSet = "assets/icon/source/AppIcon.iconset";
const assetCatalog = "assets/icon/Assets.car";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    "data-root": { type: "string" },
    "widget-acceptance": { type: "boolean", default: false },
    dmg: { type: "boolean", default: false },
  },
});
if (process.platform !== "darwin")
  throw new Error("This packaging entry requires macOS.");
if (values["data-root"] && !isAbsolute(values["data-root"]))
  throw new Error("data-root must be absolute.");
if (values["widget-acceptance"] && !values["data-root"])
  throw new Error("Widget acceptance requires an explicit isolated data-root.");
if (values.dmg && values["data-root"])
  throw new Error(
    "A disk image is a distributable build and must use the default data directories.",
  );
if (values.dmg && process.arch !== "arm64")
  throw new Error("The trial disk image is built for arm64 only.");

const run = (file, args) =>
  execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** True when the file starts with a Mach-O (thin or universal) magic number. */
async function isMachO(path) {
  const handle = await open(path, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    if (bytesRead < 4) return false;
    return [
      0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe,
    ].includes(buffer.readUInt32BE(0));
  } finally {
    await handle.close();
  }
}

/**
 * Ad-hoc signs every nested code item from the inside out: loose Mach-O files (dylibs,
 * helper executables, native modules), then nested bundles (helper apps, frameworks),
 * deepest first, and the app itself last. Symbolic links are not followed.
 */
async function adHocSign(app) {
  const files = [];
  const bundles = [];
  async function walk(dir) {
    for (const entry of await readdir(dir)) {
      const path = join(dir, entry);
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walk(path);
        if (/\.(app|framework|xpc|bundle)$/.test(entry)) bundles.push(path);
      } else if (info.isFile() && (await isMachO(path))) files.push(path);
    }
  }
  await walk(join(app, "Contents"));
  const depth = (path) => path.split(sep).length;
  const order = [
    ...files.sort((a, b) => depth(b) - depth(a)),
    ...bundles.sort((a, b) => depth(b) - depth(a)),
    app,
  ];
  for (const item of order)
    run("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      item,
    ]);
  run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    app,
  ]);
  return order.length;
}

/**
 * Writes InfoPlist.strings (binary property list) with the display name into every localization
 * the bundle has (Electron ships one per Chromium locale), so whichever one macOS picks for the
 * system language shows the same name.
 */
async function localize(app) {
  const resources = join(app, "Contents", "Resources");
  const localizations = (await readdir(resources)).filter((name) =>
    name.endsWith(".lproj"),
  );
  for (const required of ["en.lproj", "zh_CN.lproj"])
    if (!localizations.includes(required))
      throw new Error(`The Electron bundle has no ${required} localization.`);
  for (const localization of localizations) {
    const file = join(resources, localization, "InfoPlist.strings");
    await writeFile(
      file,
      `"CFBundleDisplayName" = "${displayName}";\n"CFBundleName" = "${displayName}";\n`,
      "utf8",
    );
    run("/usr/bin/plutil", ["-convert", "binary1", file]);
  }
  return localizations.length;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * The URL that opens System Settings > Privacy & Security, where a person allows the app once.
 * The Privacy & Security settings extension (com.apple.settings.PrivacySecurity.extension)
 * declares allowsXAppleSystemPreferencesURLScheme. The shortcut only opens the page; it changes
 * no setting and runs nothing.
 */
const privacySecurityURL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension";
const shortcutName = "打开隐私与安全性.webloc";

/** dmgbuild in a private virtual environment, installed only from the pinned, hashed wheels. */
function dmgbuild() {
  const venv = resolve("dist/dmgbuild-venv");
  const bin = join(venv, "bin", "dmgbuild");
  if (!existsSync(bin)) {
    run("python3", ["-m", "venv", venv]);
    run(join(venv, "bin", "python"), [
      "-m",
      "pip",
      "install",
      "--require-hashes",
      "--no-deps",
      "--only-binary",
      ":all:",
      "-r",
      "scripts/dmg-requirements.txt",
    ]);
  }
  return bin;
}

/**
 * A compressed, read-only disk image: the app, a link to /Applications, the shortcut to
 * Privacy & Security, and a window background that shows how to install and how to allow the
 * first launch. dmgbuild writes the window layout (.DS_Store) directly, so building the image
 * never scripts the Finder.
 */
async function diskImage(app, outDir, version) {
  const file = join(outDir, `${productName}-${version}-arm64.dmg`);
  if (existsSync(file)) throw new Error(`${file} already exists.`);
  const work = await mkdtemp(join(tmpdir(), "qingluan-dmg-"));
  try {
    const background = join(work, "background.tiff");
    run("/usr/bin/tiffutil", [
      "-cathidpicheck",
      ...["", "@2x"].map((scale) => `assets/dmg/background${scale}.png`),
      "-out",
      background,
    ]);
    const shortcut = join(work, shortcutName);
    await writeFile(
      shortcut,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>URL</key>\n\t<string>${privacySecurityURL}</string>\n</dict>\n</plist>\n`,
      "utf8",
    );
    run("/usr/bin/plutil", ["-lint", shortcut]);
    run(dmgbuild(), [
      "-s",
      "scripts/dmg-settings.py",
      "-D",
      `app=${app}`,
      "-D",
      `background=${background}`,
      "-D",
      `shortcut=${shortcut}`,
      productName,
      file,
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  run("/usr/bin/hdiutil", ["verify", file]);
  return file;
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const stage = await mkdtemp(join(tmpdir(), "csthink-package-"));
const iconDir = await mkdtemp(join(tmpdir(), "csthink-icon-"));
try {
  await mkdir(join(stage, "dist"));
  for (const file of await readdir("dist", { withFileTypes: true })) {
    if (
      file.isFile() &&
      (file.name === "codex-process" ||
        /\.(cjs|mjs|js|css|html|png|svg|map|node)$/.test(file.name))
    )
      await cp(join("dist", file.name), join(stage, "dist", file.name));
  }
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
  const icon = join(iconDir, "AppIcon.icns");
  run("/usr/bin/iconutil", ["-c", "icns", iconSet, "-o", icon]);
  const out = resolve(values.out ?? "dist/packaged");
  const [packaged] = await packager({
    dir: stage,
    out,
    name: productName,
    appBundleId: bundleId,
    appVersion: pkg.version,
    buildVersion: pkg.version,
    appCategoryType: "public.app-category.productivity",
    icon,
    platform: "darwin",
    arch: process.arch,
    electronVersion: pkg.devDependencies.electron,
    asar: false,
    overwrite: false,
    extendInfo: {
      CFBundleIconFile: "AppIcon.icns",
      CFBundleIconName: "AppIcon",
      LSHasLocalizedDisplayName: true,
      LSMinimumSystemVersion: minimumSystemVersion,
      CFBundleDevelopmentRegion: "zh_CN",
    },
    protocols: [
      {
        name: "csthink-assistant conversation",
        schemes: ["csthink-assistant"],
      },
    ],
  });
  const app = join(packaged, `${productName}.app`);
  const resources = join(app, "Contents", "Resources");
  // The packager copied the icon to AppIcon.icns (CFBundleIconFile); Electron's own icon is unused.
  if (!existsSync(join(resources, "AppIcon.icns")))
    throw new Error("The app icon was not copied into the bundle.");
  await rm(join(resources, "electron.icns"), { force: true });
  await cp(assetCatalog, join(resources, "Assets.car"));
  const localizations = await localize(app);
  const signed = await adHocSign(app);
  const result = {
    app,
    version: pkg.version,
    bundleId,
    minimumSystemVersion,
    arch: process.arch,
    dataRoot: values["data-root"] ?? "default",
    widgetAcceptance: values["widget-acceptance"],
    displayName,
    localizations,
    signing: `Ad-hoc signature on ${signed} code items; no Developer ID signature and no notarization.`,
  };
  if (values.dmg) {
    const file = await diskImage(app, out, pkg.version);
    Object.assign(result, {
      dmg: file,
      dmgBytes: (await stat(file)).size,
      dmgSha256: await sha256(file),
    });
    await writeFile(
      file.replace(/\.dmg$/, ".json"),
      JSON.stringify(
        {
          name: productName,
          displayName,
          version: pkg.version,
          bundleId,
          minimumSystemVersion,
          arch: process.arch,
          file: basename(file),
          bytes: result.dmgBytes,
          sha256: result.dmgSha256,
        },
        null,
        2,
      ) + "\n",
    );
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(stage, { recursive: true, force: true });
  await rm(iconDir, { recursive: true, force: true });
}
