import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { displayName } from "../../src/shared/app-name";
import {
  acceptedLicenses,
  copiedPackageFiles,
  electronCoveredFrameworks,
  electronFrameworkProblems,
  electronFrameworks,
  embeddedComponents,
  embeddedInSourceMap,
  installedElectronVersion,
  noticesFile,
  packageDirOf,
  packagesFromMetafiles,
  packagesFromSourceMaps,
  thirdPartyNotices,
} from "../../scripts/third-party-licenses.mjs";

test("app name: the single display name is 青鸾, the Chinese name of the Chinese-only interface", () => {
  assert.equal(displayName, "青鸾");
});

test("app name: the packaging script writes the same display name into the bundle", () => {
  const script = readFileSync("scripts/package-macos.mjs", "utf8");
  assert.match(
    script,
    new RegExp(`^const displayName = "${displayName}";$`, "m"),
  );
  assert.match(script, /CFBundleDevelopmentRegion: "zh_CN"/);
});

/** A node_modules tree in a temporary directory: path relative to the root → file content. */
function packageTree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "csthink-licenses-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
/** Synthetic trees ship no Electron frameworks. */
const noFrameworks = { electronVersion: "1.0.0", frameworks: [] };
const manifest = (name: string, version: string, license?: string) =>
  JSON.stringify(license ? { name, version, license } : { name, version });

test("third-party licenses: every bundled package is listed with its version, license identifier, license files and notice files, and a nested package resolves to its own directory", async () => {
  const root = packageTree({
    "node_modules/alpha/package.json": manifest("alpha", "1.2.3", "MIT"),
    "node_modules/alpha/LICENSE": "alpha license text\n",
    "node_modules/alpha/node_modules/gamma/package.json": manifest(
      "gamma",
      "0.1.0",
      "BSD-3-Clause",
    ),
    "node_modules/alpha/node_modules/gamma/COPYING": "gamma license text\n",
    "node_modules/@scope/beta/package.json": manifest(
      "@scope/beta",
      "2.0.0",
      "Apache-2.0",
    ),
    "node_modules/@scope/beta/LICENSE.md": "beta license text\n",
    "node_modules/@scope/beta/NOTICE": "beta notice text\n",
    "node_modules/@scope/beta/README.md": "not a license\n",
  });
  try {
    const dirs = packagesFromMetafiles([
      {
        inputs: {
          "src/main/index.ts": {},
          "node_modules/alpha/index.js": {},
          "node_modules/alpha/node_modules/gamma/lib/x.js": {},
        },
      },
      { inputs: { "node_modules/@scope/beta/dist/beta.js": {} } },
    ]);
    assert.deepEqual(dirs, [
      "node_modules/@scope/beta",
      "node_modules/alpha",
      "node_modules/alpha/node_modules/gamma",
    ]);
    const notices = await thirdPartyNotices({
      root,
      packageDirs: dirs,
      embedded: [],
      ...noFrameworks,
    });
    assert.deepEqual(notices.packages, [
      { name: "@scope/beta", version: "2.0.0", license: "Apache-2.0" },
      { name: "alpha", version: "1.2.3", license: "MIT" },
      { name: "gamma", version: "0.1.0", license: "BSD-3-Clause" },
    ]);
    assert.match(notices.text, /Packages: 3\. Embedded components: 0\./);
    assert.match(
      notices.text,
      /@scope\/beta 2\.0\.0\nLicense: Apache-2\.0\n-+\nLICENSE\.md:\n\nbeta license text\n\n-+\nNOTICE:\n\nbeta notice text\n/,
    );
    assert.match(
      notices.text,
      /gamma 0\.1\.0\nLicense: BSD-3-Clause\n-+\nCOPYING:\n\ngamma license text\n/,
    );
    assert.doesNotMatch(notices.text, /not a license/);
    // The same files give the same bytes.
    const again = await thirdPartyNotices({
      root,
      packageDirs: dirs,
      embedded: [],
      ...noFrameworks,
    });
    assert.equal(again.text, notices.text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("third-party licenses: a package that declares no license, declares one outside the accepted list or has no license file stops the build", async () => {
  const root = packageTree({
    "node_modules/unlicensed/package.json": manifest("unlicensed", "1.0.0"),
    "node_modules/unlicensed/LICENSE": "text\n",
    "node_modules/copyleft/package.json": manifest(
      "copyleft",
      "1.0.0",
      "GPL-3.0-only",
    ),
    "node_modules/copyleft/LICENSE": "text\n",
    "node_modules/either/package.json": manifest(
      "either",
      "1.0.0",
      "(MIT OR GPL-3.0-only)",
    ),
    "node_modules/either/LICENSE": "text\n",
    "node_modules/textless/package.json": manifest("textless", "1.0.0", "MIT"),
    "node_modules/fine/package.json": manifest("fine", "1.0.0", "ISC"),
    "node_modules/fine/LICENSE": "text\n",
  });
  try {
    for (const [dir, reason] of [
      ["node_modules/unlicensed", /unlicensed@1\.0\.0 .* declares no license/],
      [
        "node_modules/copyleft",
        /copyleft@1\.0\.0 .* GPL-3\.0-only, which is not accepted without review/,
      ],
      [
        "node_modules/either",
        /either@1\.0\.0 .* \(MIT OR GPL-3\.0-only\), which is not accepted/,
      ],
      ["node_modules/textless", /textless@1\.0\.0 .* has no license file/],
    ] as const)
      await assert.rejects(
        thirdPartyNotices({
          root,
          packageDirs: ["node_modules/fine", dir],
          embedded: [],
          ...noFrameworks,
        }),
        reason,
      );
    assert.deepEqual(acceptedLicenses, [
      "0BSD",
      "Apache-2.0",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "ISC",
      "MIT",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("third-party licenses: an embedded component is listed only while its host package keeps the reviewed version and still shows the component", async () => {
  const root = packageTree({
    "node_modules/host/package.json": manifest("host", "3.0.0", "MIT"),
    "node_modules/host/LICENSE": "host license text\n",
    "node_modules/host/lib/part.js": "/*! part. MIT License. */\n",
    "node_modules/other/package.json": manifest("other", "1.0.0", "MIT"),
    "node_modules/other/LICENSE": "other license text\n",
    "licenses/part.LICENSE": "part license text\n",
  });
  const entry = {
    host: "host",
    hostVersion: "3.0.0",
    name: "part",
    version: "0.9.0",
    license: "MIT",
    use: "adapted code",
    markerFile: "lib/part.js",
    marker: "/*! part. MIT License.",
    text: "licenses/part.LICENSE",
  };
  try {
    const notices = await thirdPartyNotices({
      root,
      packageDirs: ["node_modules/host"],
      embedded: [entry],
      ...noFrameworks,
    });
    assert.deepEqual(notices.components, [
      {
        name: "part",
        version: "0.9.0",
        license: "MIT",
        host: "host",
        hostVersion: "3.0.0",
      },
    ]);
    assert.match(
      notices.text,
      /part 0\.9\.0 \(embedded in host 3\.0\.0: adapted code\)\nLicense: MIT\n-+\npart\.LICENSE:\n\npart license text\n$/,
    );
    await assert.rejects(
      thirdPartyNotices({
        root,
        packageDirs: ["node_modules/host"],
        embedded: [{ ...entry, hostVersion: "2.9.0" }],
        ...noFrameworks,
      }),
      /host is 3\.0\.0; its embedded component part was reviewed for 2\.9\.0/,
    );
    await assert.rejects(
      thirdPartyNotices({
        root,
        packageDirs: ["node_modules/host"],
        embedded: [{ ...entry, marker: "/*! gone */" }],
        ...noFrameworks,
      }),
      /host 3\.0\.0 no longer shows part in lib\/part\.js/,
    );
    await assert.rejects(
      thirdPartyNotices({
        root,
        packageDirs: ["node_modules/other"],
        embedded: [entry],
        ...noFrameworks,
      }),
      /registered for host, which the build no longer bundles/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("third-party licenses: the built notices are exactly those of the packages the bundles' source maps name and of the copied package files, and every component the maps show embedded is registered", async () => {
  const maps = await packagesFromSourceMaps("dist", "dist");
  const dirs = new Set(maps.packages);
  const embedded = new Set(maps.embedded);
  for (const [name, source] of Object.entries(copiedPackageFiles)) {
    assert.deepEqual(readFileSync(join("dist", name)), readFileSync(source));
    dirs.add(packageDirOf(source) ?? "");
    for (const component of await embeddedInSourceMap(`${source}.map`))
      embedded.add(component);
  }
  const expected = await thirdPartyNotices({
    root: ".",
    packageDirs: [...dirs].sort(),
    electronVersion: await installedElectronVersion("."),
  });
  assert.equal(readFileSync(join("dist", noticesFile), "utf8"), expected.text);
  // A development dependency the app source imports is bundled and therefore listed.
  assert.ok(expected.packages.some((p) => p.name === "acorn"));
  for (const p of expected.packages)
    assert.ok(acceptedLicenses.includes(p.license));
  // PDF.js's own build embeds core-js; its source maps show it under webpack://.
  assert.ok(embedded.has("core-js"));
  for (const component of embedded)
    assert.ok(
      embeddedComponents.some((c) => c.name === component),
      `${component} is embedded but not registered`,
    );
});

test("third-party licenses: a source map's URL sources name the packages another build embedded, and its relative sources the installed ones", async () => {
  const root = packageTree({
    "dist/a.cjs.map": JSON.stringify({
      version: 3,
      sources: [
        "../src/main/index.ts",
        "../node_modules/alpha/index.js",
        "../node_modules/@scope/beta/lib/b.js",
        "webpack://lib/./node_modules/inner/x.js",
        "webpack://lib/src/y.js",
      ],
    }),
    "dist/a.cjs": "",
  });
  try {
    assert.deepEqual(await packagesFromSourceMaps(join(root, "dist"), "dist"), {
      packages: ["node_modules/@scope/beta", "node_modules/alpha"],
      embedded: ["inner"],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("third-party licenses: a framework Electron ships outside its own license files is listed for the reviewed Electron version only", async () => {
  const root = packageTree({ "licenses/Kit.LICENSE.md": "kit license text\n" });
  const kit = {
    electronVersion: "9.1.0",
    name: "Kit",
    framework: "Kit.framework",
    license: "MIT",
    use: "a dependency of the updater",
    text: "licenses/Kit.LICENSE.md",
  };
  try {
    const notices = await thirdPartyNotices({
      root,
      packageDirs: [],
      electronVersion: "9.1.0",
      embedded: [],
      frameworks: [kit],
    });
    assert.deepEqual(notices.frameworks, [
      {
        name: "Kit",
        framework: "Kit.framework",
        license: "MIT",
        electronVersion: "9.1.0",
      },
    ]);
    assert.match(
      notices.text,
      /Packages: 0\. Embedded components: 0\. Electron frameworks: 1\./,
    );
    assert.match(
      notices.text,
      /Kit \(shipped with Electron 9\.1\.0 as Kit\.framework: a dependency of the updater\)\nLicense: MIT\n-+\nKit\.LICENSE\.md:\n\nkit license text\n$/,
    );
    await assert.rejects(
      thirdPartyNotices({
        root,
        packageDirs: [],
        electronVersion: "9.2.0",
        embedded: [],
        frameworks: [kit],
      }),
      /Electron is 9\.2\.0; its framework Kit\.framework was reviewed for 9\.1\.0/,
    );
    await assert.rejects(
      thirdPartyNotices({
        root,
        packageDirs: [],
        electronVersion: "",
        embedded: [],
        frameworks: [kit],
      }),
      /needs the Electron version/,
    );
    // The packaging check: helper apps are ignored; an unknown framework, a missing registered
    // one and a registration for another Electron version are each reported.
    const covered = ["Core.framework"];
    assert.deepEqual(
      electronFrameworkProblems({
        bundled: ["Core.framework", "Kit.framework", "Helper.app"],
        electronVersion: "9.1.0",
        frameworks: [kit],
        covered,
      }),
      [],
    );
    assert.deepEqual(
      electronFrameworkProblems({
        bundled: ["Core.framework", "Extra.framework"],
        electronVersion: "9.2.0",
        frameworks: [kit],
        covered,
      }),
      [
        "The bundle has Extra.framework, which neither Electron's license files nor scripts/third-party-licenses.mjs cover; review its license first.",
        "Electron is 9.2.0; its framework Kit.framework was reviewed for 9.1.0.",
        "The bundle has no Kit.framework, which scripts/third-party-licenses.mjs lists for Electron 9.1.0.",
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("third-party licenses: the installed Electron's frameworks are covered by its license files or registered, and the registered ones are those LICENSES.chromium.html misses", async () => {
  const dist = "node_modules/electron/dist";
  const version = await installedElectronVersion(".");
  assert.equal(readFileSync(join(dist, "version"), "utf8").trim(), version);
  assert.deepEqual(
    electronFrameworkProblems({
      bundled: readdirSync(join(dist, "Electron.app/Contents/Frameworks")),
      electronVersion: version,
    }),
    [],
  );
  const titles = [
    ...readFileSync(join(dist, "LICENSES.chromium.html"), "utf8").matchAll(
      /<span class="title">([^<]*)<\/span>/g,
    ),
  ].map((m) => m[1]);
  assert.ok(titles.includes("Squirrel"));
  assert.ok(electronCoveredFrameworks.includes("Squirrel.framework"));
  for (const f of electronFrameworks) {
    assert.ok(
      !titles.includes(f.name),
      `${f.name} is in LICENSES.chromium.html`,
    );
    assert.ok(
      readFileSync(f.text, "utf8").includes("Permission is hereby granted"),
    );
  }
});
