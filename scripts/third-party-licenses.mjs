import { readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";

/**
 * The third-party license notices of the packaged app (README, 许可). The app bundle carries no
 * node_modules: the third-party code in it is what esbuild bundles into dist/ and the package
 * files the build copies into dist/ unchanged. scripts/build.mjs derives that package set from
 * esbuild's metafiles and writes dist/THIRD_PARTY_LICENSES.txt; scripts/package-macos.mjs derives
 * it again from the source maps of the staged bundles, regenerates the text and refuses to package
 * when the two differ. Electron and Chromium are covered by the license files Electron ships, which
 * the packaging script places next to this one.
 *
 * The set comes from what the build bundles, not from the dependencies field of package.json: a
 * development dependency the app source imports is bundled and listed, a dependency nothing imports
 * is not. A package whose license is not one of acceptedLicenses, that declares no license or that
 * has no license file stops the build, so a person reviews it before it is distributed.
 */
export const noticesFile = "THIRD_PARTY_LICENSES.txt";

/** SPDX identifiers distributed without further review; any other value, an expression included, stops the build. */
export const acceptedLicenses = [
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
];

/** Package files the build copies into dist/ unchanged: the name in dist/ and the source path. */
export const copiedPackageFiles = {
  // PDF.js loads its parser as a sibling module of the extraction worker bundle.
  "pdf.worker.mjs": "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
};

/**
 * Components that bundled packages embed without depending on them as packages, so their license
 * text is not in node_modules. Each entry was reviewed for one exact host version; a different
 * version of the host, or a marker that no longer appears in the host's file, stops the build until
 * the entry is reviewed again. The license texts in scripts/licenses/ are the upstream files,
 * byte for byte:
 *
 *   llhttp-9.3.0.LICENSE       nodejs/llhttp v9.3.0 LICENSE (undici 7.30.0 builds deps/llhttp 9.3.0)
 *   ws.LICENSE                 websockets/ws 8.22.0 LICENSE
 *   formdata-polyfill.LICENSE  jimmywarting/FormData v4.0.10 LICENSE
 *   core-js-3.50.0.LICENSE     zloirock/core-js v3.50.0 LICENSE
 */
export const embeddedComponents = [
  {
    host: "undici",
    hostVersion: "7.30.0",
    name: "llhttp",
    version: "9.3.0",
    license: "MIT",
    use: "the HTTP parser, compiled to WebAssembly",
    markerFile: "lib/llhttp/llhttp-wasm.js",
    marker: "const wasmBase64 = 'AGFzbQ",
    text: "scripts/licenses/llhttp-9.3.0.LICENSE",
  },
  {
    host: "undici",
    hostVersion: "7.30.0",
    name: "ws",
    version: null,
    license: "MIT",
    use: "adapted code in the WebSocket frame encoder",
    markerFile: "lib/web/websocket/frame.js",
    marker: "/*! ws. MIT License.",
    text: "scripts/licenses/ws.LICENSE",
  },
  {
    host: "undici",
    hostVersion: "7.30.0",
    name: "formdata-polyfill",
    version: null,
    license: "MIT",
    use: "adapted code in the multipart/form-data encoder",
    markerFile: "lib/web/fetch/body.js",
    marker: "/*! formdata-polyfill. MIT License.",
    text: "scripts/licenses/formdata-polyfill.LICENSE",
  },
  {
    host: "pdfjs-dist",
    hostVersion: "6.3.289",
    name: "core-js",
    version: "3.50.0",
    license: "MIT",
    use: "polyfills in the legacy build",
    markerFile: "legacy/build/pdf.mjs",
    marker: "https://github.com/zloirock/core-js/blob/v3.50.0/LICENSE",
    text: "scripts/licenses/core-js-3.50.0.LICENSE",
  },
];

const licenseFile = /^(licen[cs]e|copying)([-.][^/]*)?$/i;
const noticeFile = /^notice([-.][^/]*)?$/i;

/**
 * The package directory, relative and with forward slashes, of a path inside node_modules: the
 * innermost node_modules segment and the package name after it (two segments for a scoped name).
 * Null for a path outside node_modules.
 */
export function packageDirOf(path) {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  const at = normalized.lastIndexOf("node_modules/");
  if (at < 0) return null;
  const rest = normalized.slice(at + "node_modules/".length).split("/");
  const segments = rest[0].startsWith("@") ? 2 : 1;
  if (rest.length <= segments || rest.slice(0, segments).some((s) => !s))
    return null;
  return (
    normalized.slice(0, at) +
    "node_modules/" +
    rest.slice(0, segments).join("/")
  );
}

function packageDirs(paths) {
  const dirs = new Set();
  for (const path of paths) {
    const dir = packageDirOf(path);
    if (dir) dirs.add(dir);
  }
  return [...dirs].sort();
}

/** Package directories of the node_modules inputs of esbuild metafiles. */
export function packagesFromMetafiles(metafiles) {
  return packageDirs(
    metafiles.flatMap((metafile) => Object.keys(metafile.inputs)),
  );
}

/** Matches a source map source written by another tool's build, such as webpack://pdf.js/... */
const urlSource = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Names of the packages that a source map's URL sources (webpack://pdf.js/node_modules/core-js/...)
 * place under node_modules: code another tool's build embedded in a published package, which is
 * not installed as a package of its own. Each must be one of embeddedComponents.
 */
export async function embeddedInSourceMap(mapPath) {
  const map = JSON.parse(await readFile(mapPath, "utf8"));
  if (!Array.isArray(map.sources))
    throw new Error(`The source map ${mapPath} has no sources.`);
  const names = new Set();
  for (const source of map.sources) {
    if (!urlSource.test(source)) continue;
    const dir = packageDirOf(source.replace(urlSource, ""));
    if (dir) names.add(dir.slice(dir.lastIndexOf("node_modules/") + 13));
  }
  return [...names].sort();
}

/**
 * The packages named by the sources of every source map in mapDir: the directories of installed
 * packages (relative sources) and the names of embedded ones (URL sources, see embeddedInSourceMap).
 * Relative sources are relative to the map; sourceBase is where the maps were written relative to
 * the package root (dist), so they resolve to the same package paths wherever the maps were copied.
 */
export async function packagesFromSourceMaps(mapDir, sourceBase) {
  const sources = [];
  const embedded = new Set();
  for (const name of (await readdir(mapDir)).sort()) {
    if (!name.endsWith(".map")) continue;
    const map = JSON.parse(await readFile(join(mapDir, name), "utf8"));
    if (!Array.isArray(map.sources))
      throw new Error(`The source map ${name} has no sources.`);
    for (const source of map.sources)
      if (!urlSource.test(source)) sources.push(posix.join(sourceBase, source));
    for (const component of await embeddedInSourceMap(join(mapDir, name)))
      embedded.add(component);
  }
  return { packages: packageDirs(sources), embedded: [...embedded].sort() };
}

async function filesMatching(dir, pattern) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

const rule = "=".repeat(80);
const thin = "-".repeat(80);

function block(title, license, sections) {
  const body = sections
    .map(({ name, text }) => `${name}:\n\n${text.replace(/\s+$/, "")}\n`)
    .join(`\n${thin}\n`);
  return `${rule}\n${title}\nLicense: ${license}\n${thin}\n${body}`;
}

/**
 * The notices text for the given package directories (relative to root): one block per package
 * with its name, version, license identifier, license files and notice files, then one block per
 * embedded component. Throws when a package declares no license, declares one outside
 * acceptedLicenses or has no license file, and when an embedded component's review no longer
 * matches the bundled host. The text depends only on the files, so the same build gives the same
 * bytes.
 */
export async function thirdPartyNotices({
  root,
  packageDirs: dirs,
  embedded = embeddedComponents,
  product = "青鸾 (Qingluan)",
}) {
  const packages = new Map();
  const problems = [];
  for (const dir of dirs) {
    const path = join(root, dir);
    const manifest = JSON.parse(
      await readFile(join(path, "package.json"), "utf8"),
    );
    const id = `${manifest.name}@${manifest.version}`;
    if (packages.has(id)) continue;
    const { license } = manifest;
    if (typeof license !== "string" || !license) {
      problems.push(`${id} (${dir}) declares no license.`);
      continue;
    }
    if (!acceptedLicenses.includes(license)) {
      problems.push(
        `${id} (${dir}) is licensed under ${license}, which is not accepted without review.`,
      );
      continue;
    }
    const licenses = await filesMatching(path, licenseFile);
    if (licenses.length === 0) {
      problems.push(`${id} (${dir}) has no license file.`);
      continue;
    }
    const sections = [];
    for (const name of [
      ...licenses,
      ...(await filesMatching(path, noticeFile)),
    ])
      sections.push({ name, text: await readFile(join(path, name), "utf8") });
    packages.set(id, {
      dir,
      name: manifest.name,
      version: manifest.version,
      license,
      sections,
    });
  }
  const components = [];
  for (const entry of embedded) {
    const hosts = [...packages.values()].filter((p) => p.name === entry.host);
    if (hosts.length === 0) {
      problems.push(
        `The embedded component ${entry.name} is registered for ${entry.host}, which the build no longer bundles.`,
      );
      continue;
    }
    for (const host of hosts) {
      if (host.version !== entry.hostVersion) {
        problems.push(
          `${entry.host} is ${host.version}; its embedded component ${entry.name} was reviewed for ${entry.hostVersion}.`,
        );
        continue;
      }
      const file = await readFile(
        join(root, host.dir, entry.markerFile),
        "utf8",
      ).catch(() => "");
      if (!file.includes(entry.marker)) {
        problems.push(
          `${entry.host} ${host.version} no longer shows ${entry.name} in ${entry.markerFile}.`,
        );
        continue;
      }
      components.push({
        ...entry,
        licenseText: await readFile(join(root, entry.text), "utf8"),
      });
    }
  }
  if (problems.length > 0)
    throw new Error(
      `Third-party licenses need review:\n${problems.join("\n")}`,
    );
  // Code point order, independent of the locale, so the bytes do not depend on the machine.
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const list = [...packages.values()].sort(
    (a, b) => order(a.name, b.name) || order(a.version, b.version),
  );
  components.sort((a, b) => order(a.name, b.name));
  const head = [
    `Third-party software in ${product}`,
    "",
    "Generated by scripts/third-party-licenses.mjs when the app is built. It lists every npm package",
    "whose code the build bundles into the app, with the package's license and notice files, and the",
    "components those packages embed. Electron and Chromium are covered by LICENSE.electron.txt and",
    "LICENSES.chromium.html next to this file.",
    "",
    `Packages: ${list.length}. Embedded components: ${components.length}.`,
    "",
  ].join("\n");
  const blocks = [
    ...list.map((p) => block(`${p.name} ${p.version}`, p.license, p.sections)),
    ...components.map((c) =>
      block(
        `${c.name}${c.version ? ` ${c.version}` : ""} (embedded in ${c.host} ${c.hostVersion}: ${c.use})`,
        c.license,
        [{ name: posix.basename(c.text), text: c.licenseText }],
      ),
    ),
  ];
  return {
    text: `${head}\n${blocks.join("\n")}`,
    packages: list.map(({ name, version, license }) => ({
      name,
      version,
      license,
    })),
    components: components.map(
      ({ name, version, license, host, hostVersion }) => ({
        name,
        version,
        license,
        host,
        hostVersion,
      }),
    ),
  };
}
