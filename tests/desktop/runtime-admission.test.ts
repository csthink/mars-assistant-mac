import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import {
  expandArgv,
  installPackage,
  installedVersionKey,
  launchEnvironment,
  manifestProblems,
  osAtLeast,
  packageDir,
  readTar,
  releaseRecordProblems,
  verifyBundle,
  verifyInstalledPackage,
  type HostDescriptor,
} from "../../src/main/runtime-admission";
import { contractDigest, contractVersion } from "../../src/shared/runtime-host";
import {
  buildBundle,
  digestOf,
  newPublisher,
  sha256,
  type BundleSpec,
} from "./runtime-fakes/bundle";
import { hpCapabilityDocuments } from "./runtime-fakes/hp-capability-documents";

mkdirSync(".test-data/disposable", { recursive: true });
const root = () => mkdtempSync(resolve(".test-data/disposable/admission-"));
const schema = {
  type: "object",
  properties: { choice: { enum: ["confirm"] } },
  required: ["choice"],
  additionalProperties: false,
};
const capability = {
  id: "csthink.test.list",
  version: contractVersion,
  schemaDigest: digestOf(schema),
  required: true,
};
const spec = (): BundleSpec => ({
  runtimeId: "runtime:test-list",
  version: "1",
  entrypoint: "list-fake.cjs",
  entrypointBytes: Buffer.from("process.exit(0)\n"),
  launcher: "electron-node",
  argv: ["${instanceDir}", "${contractDigest}"],
  capabilities: [{ capability, schema }],
});
const host = (pins: [string, string][] = []): HostDescriptor => ({
  platform: "darwin-arm64",
  osVersion: "27.0",
  electronExecutable: process.execPath,
  pythonCandidates: [],
  publisherPins: new Map(pins),
});

test("合法包：签名、清单、manifest、launch.json 与能力 schema 逐项核验通过，包解开到不可变目录并可重验", () => {
  const dir = root();
  const publisher = newPublisher();
  const built = buildBundle(join(dir, "bundle"), publisher, spec());
  const verdict = verifyBundle(built.dir, host());
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.identityVerified, true);
  assert.equal(verdict.incompatibility, null);
  assert.equal(verdict.artifactDigest, built.artifactDigest);
  assert.equal(verdict.publicKeyDigest, publisher.publicKeyDigest);
  assert.equal(verdict.manifest?.runtimeId, "runtime:test-list");
  assert.equal(verdict.launch?.launcher, "electron-node");
  assert.equal(
    verdict.capabilitySchemas.get(capability.id)?.digest,
    capability.schemaDigest,
  );
  assert.equal(verdict.launcher?.launcher, process.execPath);
  assert.equal(verdict.checkedFiles, 4);
  const runtimeRoot = join(dir, "runtimes");
  const installed = installPackage(verdict, runtimeRoot, built.dir);
  assert.equal(
    installed,
    packageDir(runtimeRoot, "runtime:test-list", built.artifactDigest),
  );
  assert.equal(
    readFileSync(join(installed, "list-fake.cjs"), "utf8"),
    "process.exit(0)\n",
  );
  assert.equal(
    existsSync(
      join(runtimeRoot, "staging", built.artifactDigest + "-" + process.pid),
    ),
    false,
  );
  assert.equal(verifyInstalledPackage(installed).ok, true);
  assert.deepEqual(
    readTar(built.archive).map((m) => m.name),
    [
      "manifest.json",
      "launch.json",
      "list-fake.cjs",
      "capabilities/csthink.test.list.json",
    ],
  );
  // Placeholders expand only from the closed set; other bytes stay fixed.
  assert.deepEqual(
    expandArgv(
      [
        "--serve",
        "${instanceDir}",
        "${contractDigest}",
        "${runtimeRoot}/x",
        "${resourceHandle}",
      ],
      {
        runtimeRoot: "/r",
        instanceDir: "/i",
        contractDigest: "d",
        resourceHandle: "h",
      },
    ),
    ["--serve", "/i", "d", "/r/x", "h"],
  );
  // No registered handle: the template is refused, never expanded to an empty string (KB-278 item 3).
  assert.throws(
    () =>
      expandArgv(["--resource=${resourceHandle}"], {
        runtimeRoot: "/r",
        instanceDir: "/i",
        contractDigest: "d",
        resourceHandle: null,
      }),
    /no registered resource handle/,
  );
  assert.deepEqual(
    expandArgv(["${instanceDir}"], {
      runtimeRoot: "/r",
      instanceDir: "/i",
      contractDigest: "d",
      resourceHandle: null,
    }),
    ["/i"],
  );
  assert.equal(osAtLeast("27.0", "26.6.2"), true);
  assert.equal(osAtLeast("26.6", "26.6.2"), false);
});

test("八类拒绝用包各得对应原因码，且不出现已核验身份：错误签名、篡改成员、路径穿越、symlink、发布记录字段不一致、能力 schema 摘要不符、成员超限、缺清单文件", () => {
  const dir = root();
  const publisher = newPublisher();
  const other = newPublisher("publisher:someone-else");
  const cases: {
    name: string;
    code: string;
    build: () => string;
    pattern: RegExp;
  }[] = [
    {
      name: "bad-signature",
      code: "INVALID_SOURCE",
      build: () =>
        buildBundle(join(dir, "bad-signature"), publisher, spec(), {
          signWith: other.privateKey,
        }).dir,
      pattern: /signature does not verify/,
    },
    {
      name: "foreign-key",
      code: "INVALID_SOURCE",
      build: () =>
        buildBundle(join(dir, "foreign-key"), publisher, spec(), {
          publisherPem: other.publicKeyPem,
        }).dir,
      pattern: /signature does not verify/,
    },
    {
      name: "tampered-member",
      code: "INTEGRITY_MISMATCH",
      build: () =>
        buildBundle(join(dir, "tampered-member"), publisher, spec(), {
          members: (m) =>
            m.map((x) =>
              x.name === "list-fake.cjs"
                ? { ...x, data: Buffer.from("process.exit(1)\n") }
                : x,
            ),
          release: (r) => ({ ...r, archive: undefined }),
        }).dir,
      pattern: /release record/,
    },
    {
      name: "tampered-bytes",
      code: "INTEGRITY_MISMATCH",
      build: () => {
        const built = buildBundle(
          join(dir, "tampered-bytes"),
          publisher,
          spec(),
        );
        // Rewrite one member after signing: the archive digest no longer matches the record.
        const archive = Buffer.from(built.archive);
        const at = archive.indexOf("process.exit(0)");
        archive.write("process.exit(9)", at, "utf8");
        writeFileSync(join(built.dir, "bundle.tar"), archive);
        return built.dir;
      },
      pattern: /archive digest or size/,
    },
    {
      name: "path-traversal",
      code: "INTEGRITY_MISMATCH",
      build: () =>
        buildBundle(join(dir, "path-traversal"), publisher, spec(), {
          members: (m) => [
            ...m,
            { name: "../escape.txt", data: Buffer.from("x") },
          ],
        }).dir,
      pattern: /escapes the bundle root/,
    },
    {
      name: "symlink",
      code: "INTEGRITY_MISMATCH",
      build: () =>
        buildBundle(join(dir, "symlink"), publisher, spec(), {
          members: (m) => [
            ...m,
            {
              name: "link",
              data: Buffer.alloc(0),
              type: "2",
              linkname: "/etc/passwd",
            },
          ],
        }).dir,
      pattern: /not a regular file/,
    },
    {
      name: "record-mismatch",
      code: "INTEGRITY_MISMATCH",
      build: () =>
        buildBundle(join(dir, "record-mismatch"), publisher, spec(), {
          release: (r) => ({ ...r, version: "2" }),
        }).dir,
      pattern: /version differs between manifest and release record/,
    },
    {
      name: "capability-digest",
      code: "UNSUPPORTED_CAPABILITY",
      build: () =>
        buildBundle(join(dir, "capability-digest"), publisher, {
          ...spec(),
          capabilities: [
            {
              capability: { ...capability, schemaDigest: sha256("other") },
              schema,
            },
          ],
        }).dir,
      pattern: /schemaDigest differs/,
    },
    {
      name: "members-limit",
      code: "RESOURCE_LIMIT",
      build: () =>
        buildBundle(join(dir, "members-limit"), publisher, {
          ...spec(),
          membersMax: 2,
        }).dir,
      pattern: /exceeds membersMax/,
    },
    {
      name: "missing-launch",
      code: "INTEGRITY_MISMATCH",
      build: () =>
        buildBundle(join(dir, "missing-launch"), publisher, spec(), {
          members: (m) => m.filter((x) => x.name !== "launch.json"),
        }).dir,
      pattern: /listed file launch.json is missing/,
    },
    {
      name: "argv-placeholder",
      code: "INTEGRITY_MISMATCH",
      build: () =>
        buildBundle(join(dir, "argv-placeholder"), publisher, {
          ...spec(),
          argv: ["${HOME}/x"],
        }).dir,
      pattern: /placeholder outside the closed set/,
    },
    {
      name: "launch-disagrees",
      code: "INTEGRITY_MISMATCH",
      build: () =>
        buildBundle(join(dir, "launch-disagrees"), publisher, {
          ...spec(),
          launchOverride: (l) => ({ ...l, argv: ["--other"] }),
        }).dir,
      pattern: /entrypoint or argv differ from the manifest/,
    },
  ];
  for (const c of cases) {
    const verdict = verifyBundle(c.build(), host());
    assert.equal(verdict.identityVerified, false, c.name + " must not verify");
    assert.equal(
      verdict.code,
      c.code,
      c.name + ": " + verdict.reasons.join(" | "),
    );
    assert.ok(
      verdict.reasons.some((r) => c.pattern.test(r)),
      c.name + ": " + verdict.reasons.join(" | "),
    );
    assert.throws(
      () => installPackage(verdict, join(dir, "runtimes"), c.name),
      /refusing to install/,
    );
  }
  assert.equal(existsSync(join(dir, "runtimes")), false);
});

test("OD-425 R3 与 RFC 8785 域：能力文档根 definitions 每项自包含且摘要互不相同；严格解析失败或超出 I-JSON 的文档在比较摘要前拒绝；按 OD-425 形态重排的 hp 七份能力文档通过准入", () => {
  const dir = root();
  const publisher = newPublisher();
  const annotate = {
    type: "object",
    title: "补充说明",
    properties: { note: { type: "string", maxLength: 200 } },
    required: ["note"],
    additionalProperties: false,
  };
  const close = {
    type: "object",
    properties: { reason: { enum: ["完成", "放弃"] } },
  };
  const document = {
    ...schema,
    definitions: { "list.annotate": annotate, "list.close": close },
  };
  const bundle = (name: string, value: unknown, bytes?: Buffer) =>
    buildBundle(join(dir, name), publisher, {
      ...spec(),
      capabilities: [
        {
          capability: { ...capability, schemaDigest: digestOf(value) },
          schema: value,
          ...(bytes ? { bytes } : {}),
        },
      ],
    }).dir;
  const accepted = verifyBundle(bundle("accepted", document), host());
  assert.deepEqual(accepted.reasons, []);
  assert.equal(
    accepted.capabilitySchemas.get(capability.id)?.digest,
    digestOf(document),
  );
  // hp's seven capability documents as OD-425 R2 describes them, in one bundle.
  const hp = hpCapabilityDocuments();
  const hpVerdict = verifyBundle(
    buildBundle(join(dir, "hp"), publisher, {
      ...spec(),
      capabilities: hp.map((d) => ({
        capability: {
          id: d.id,
          version: contractVersion,
          schemaDigest: d.digest,
          required: true,
        },
        schema: d.document,
      })),
    }).dir,
    host(),
  );
  assert.deepEqual(hpVerdict.reasons, []);
  assert.equal(hpVerdict.capabilitySchemas.size, 7);
  const refused: {
    name: string;
    value: unknown;
    bytes?: string | Buffer;
    pattern: RegExp;
  }[] = [
    {
      name: "same-digest",
      value: { ...document, definitions: { a: annotate, b: { ...annotate } } },
      pattern: /definitions entries a and b have the same digest \(OD-425 R3\)/,
    },
    {
      name: "local-ref",
      value: {
        ...document,
        definitions: {
          x: { type: "object", properties: { n: { $ref: "#/definitions/y" } } },
          y: { type: "string" },
        },
      },
      pattern:
        /definitions entry x is not self-contained: it holds \$ref \(OD-425 R2, R3\)/,
    },
    {
      name: "remote-ref",
      value: {
        ...document,
        definitions: { x: { $ref: "https://invalid.test/schema" } },
      },
      pattern: /schema uses a non-local \$ref/,
    },
    {
      name: "nested-id",
      value: {
        ...document,
        definitions: {
          x: {
            type: "object",
            properties: { n: { $id: "urn:x", type: "string" } },
          },
        },
      },
      pattern: /definitions entry x is not self-contained: it holds \$id/,
    },
    {
      // hp's delivery-r3 action schemas carry their own $id: as entries they must drop it (R2).
      name: "entry-id",
      value: {
        ...document,
        definitions: { x: { $id: "urn:hp:x:v1", type: "object" } },
      },
      pattern: /definitions entry x is not self-contained: it holds \$id/,
    },
    {
      name: "definitions-array",
      value: { ...document, definitions: [annotate] },
      pattern: /definitions is not an object of named schemas \(OD-425 R3\)/,
    },
    {
      name: "entry-not-schema",
      value: { ...document, definitions: { x: true } },
      pattern: /definitions entry x is not a schema object/,
    },
    {
      name: "duplicate-key",
      value: schema,
      bytes: '{"type":"object","type":"string"}',
      pattern: /schema is not JSON \(duplicate key type/,
    },
    {
      name: "invalid-utf8",
      value: schema,
      bytes: Buffer.from([
        0x7b, 0x22, 0x74, 0x22, 0x3a, 0x22, 0xc3, 0x22, 0x7d,
      ]),
      pattern: /schema is not JSON \(invalid UTF-8\)/,
    },
    {
      name: "unpaired-surrogate",
      value: schema,
      bytes: '{"type":"object","title":"\\ud800"}',
      pattern: /schema has a string with an unpaired surrogate/,
    },
    {
      name: "unsafe-integer",
      value: schema,
      bytes:
        '{"type":"object","properties":{"n":{"type":"integer","maximum":9007199254740993}}}',
      pattern: /schema has a number outside ±\(2\^53 - 1\)/,
    },
  ];
  for (const c of refused) {
    const verdict = verifyBundle(
      bundle(
        c.name,
        c.value,
        c.bytes === undefined ? undefined : Buffer.from(c.bytes),
      ),
      host(),
    );
    assert.equal(verdict.identityVerified, false, c.name);
    assert.equal(
      verdict.code,
      "UNSUPPORTED_CAPABILITY",
      c.name + ": " + verdict.reasons.join(" | "),
    );
    assert.ok(
      verdict.reasons.some((r) => c.pattern.test(r)),
      c.name + ": " + verdict.reasons.join(" | "),
    );
    assert.equal(verdict.capabilitySchemas.size, 0, c.name);
  }
});

test("身份通过但不可用：平台不匹配、系统过低、协议不交集、非空依赖、缺 python3 记为 UNSUPPORTED_VERSION 的不兼容而不是拒绝，且不解开包", () => {
  const dir = root();
  const publisher = newPublisher();
  const cases: {
    name: string;
    build: () => string;
    pattern: RegExp;
    hostOverride?: Partial<HostDescriptor>;
  }[] = [
    {
      name: "platform",
      build: () => buildBundle(join(dir, "platform"), publisher, spec()).dir,
      pattern: /platform darwin-arm64 does not match/,
      hostOverride: { platform: "darwin-x86_64" },
    },
    {
      // The frozen schema allows only minimumOs 26.6.2, so an older system is the mismatch.
      name: "os",
      build: () => buildBundle(join(dir, "os"), publisher, spec()).dir,
      pattern: /minimumOs 26.6.2 is above this system 26.5/,
      hostOverride: { osVersion: "26.5" },
    },
    {
      name: "protocol",
      build: () =>
        buildBundle(join(dir, "protocol"), publisher, {
          ...spec(),
          protocols: [
            { version: "0.1.0-draft.4", contractDigest: sha256("old") },
          ],
        }).dir,
      pattern: /does not offer Contract 0.1.0/,
    },
    {
      name: "dependency",
      build: () =>
        buildBundle(join(dir, "dependency"), publisher, {
          ...spec(),
          dependencies: [
            { id: "dep-common", version: "1", digest: sha256("dep") },
          ],
        }).dir,
      pattern: /dependencies are not provided/,
    },
    {
      name: "python",
      build: () =>
        buildBundle(join(dir, "python"), publisher, {
          ...spec(),
          launcher: "python3",
          entrypoint: "fake.py",
          entrypointBytes: Buffer.from("print(1)\n"),
        }).dir,
      pattern: /no runnable python3/,
    },
    {
      name: "direct-mode",
      build: () =>
        buildBundle(join(dir, "direct-mode"), publisher, {
          ...spec(),
          launcher: "direct",
        }).dir,
      pattern: /requires an executable/,
    },
    {
      // KB-278 item 3: this Host launches before any resource is registered, so the handle is never expanded to "".
      name: "resource-handle",
      build: () =>
        buildBundle(join(dir, "resource-handle"), publisher, {
          ...spec(),
          argv: ["${instanceDir}", "--resource=${resourceHandle}"],
        }).dir,
      pattern:
        /argv template uses \$\{resourceHandle\}; this Host starts one instance per installation/,
    },
  ];
  for (const c of cases) {
    const verdict = verifyBundle(c.build(), { ...host(), ...c.hostOverride });
    assert.equal(verdict.identityVerified, true, c.name);
    assert.equal(verdict.incompatibility?.code, "UNSUPPORTED_VERSION", c.name);
    assert.ok(
      verdict.incompatibility!.reasons.some((r) => c.pattern.test(r)),
      c.name + ": " + verdict.incompatibility!.reasons.join(" | "),
    );
    assert.throws(
      () => installPackage(verdict, join(dir, "runtimes"), c.name),
      /refusing to install/,
    );
  }
  assert.equal(existsSync(join(dir, "runtimes")), false);
});

test("发布者钉住：同一 runtimeId 换密钥拒绝为 INVALID_SOURCE；direct 启动要求 0755 且安装时保留可执行位", () => {
  const dir = root();
  const publisher = newPublisher();
  const other = newPublisher("publisher:csthink-test");
  const built = buildBundle(join(dir, "pinned"), other, spec());
  const refused = verifyBundle(
    built.dir,
    host([["runtime:test-list", publisher.publicKeyDigest]]),
  );
  assert.equal(refused.identityVerified, false);
  assert.equal(refused.code, "INVALID_SOURCE");
  assert.match(refused.reasons.join(" "), /pinned for runtime:test-list/);
  const direct = buildBundle(join(dir, "direct"), publisher, {
    ...spec(),
    launcher: "direct",
    entrypointMode: "0755",
    entrypointBytes: Buffer.from("#!/bin/sh\nexit 0\n"),
  });
  const verdict = verifyBundle(direct.dir, host());
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.launcher?.launcher, "direct");
  const installed = installPackage(verdict, join(dir, "runtimes"), direct.dir);
  assert.equal(statSync(join(installed, "list-fake.cjs")).mode & 0o111, 0o111);
  // A byte changed after installation is caught before any launch.
  writeFileSync(join(installed, "list-fake.cjs"), "#!/bin/sh\nexit 1\n");
  assert.deepEqual(verifyInstalledPackage(installed), {
    ok: false,
    reasons: ["digest mismatch list-fake.cjs"],
  });
  assert.equal(contractDigest.length, 64);
});

/** Frozen Contract 0.1.0 validators: schema.json Manifest and release-record ReleaseRecord. */
function frozenValidators() {
  const ajv = new Ajv({ allErrors: true });
  const contract = JSON.parse(
    readFileSync("contract/0.1.0/schema.json", "utf8"),
  );
  const release = JSON.parse(
    readFileSync(
      "contract/0.1.0/release-record/release-record.schema.json",
      "utf8",
    ),
  );
  ajv.addSchema(contract);
  ajv.addSchema(release);
  return {
    manifest: ajv.compile({ $ref: contract.$id + "#/definitions/Manifest" }),
    release: ajv.compile({
      $ref: release.$id + "#/definitions/ReleaseRecord",
    }),
  };
}
type Mutation = [string, (value: Record<string, unknown>) => void];
const set =
  (key: string, value: unknown) => (target: Record<string, unknown>) => {
    target[key] = value;
  };
const setIn =
  (path: string[], value: unknown) => (target: Record<string, unknown>) => {
    let node = target;
    for (const key of path.slice(0, -1))
      node = node[key] as Record<string, unknown>;
    node[path[path.length - 1]] = value;
  };
const many = <T>(count: number, item: (i: number) => T) =>
  Array.from({ length: count }, (_, i) => item(i));

test("KB-278 第二项：manifest 与发布记录的结构核验与冻结 schema 逐项等价（冻结示例与边界值由 Ajv 对照），delivery-r3 的取值形态通过", () => {
  const frozen = frozenValidators();
  const dir = root();
  const built = buildBundle(join(dir, "base"), newPublisher(), spec());
  // 1. Every frozen example of the two definitions: the Host verdict equals the example's valid flag and Ajv.
  const examples = [
    ...JSON.parse(readFileSync("contract/0.1.0/examples.json", "utf8")).cases,
    ...JSON.parse(
      readFileSync("contract/0.1.0/release-record/examples.json", "utf8"),
    ).cases,
  ].filter(
    (c: { definition: string }) =>
      c.definition === "Manifest" || c.definition === "ReleaseRecord",
  ) as { id: string; definition: string; valid: boolean; value: unknown }[];
  assert.ok(
    examples.filter((c) => c.definition === "Manifest").length >= 3 &&
      examples.filter((c) => c.definition === "ReleaseRecord").length >= 8,
  );
  for (const example of examples) {
    const host =
      example.definition === "Manifest"
        ? manifestProblems(example.value)
        : releaseRecordProblems(example.value);
    const ajv =
      example.definition === "Manifest"
        ? frozen.manifest(example.value)
        : frozen.release(example.value);
    assert.equal(ajv, example.valid, example.id + " (Ajv)");
    assert.equal(host.length === 0, example.valid, example.id + ": " + host);
  }
  // 2. Boundary values around every field rule, including the delivery-r3 forms.
  const argv32 = many(32, () => "x");
  const manifestCases: Mutation[] = [
    ["base", () => {}],
    [
      "delivery-r3 identity",
      (m) => {
        m.runtimeId = "runtime:harness-plane";
        m.publisher = "publisher:harness-plane-dev";
        m.version = "0.1.0-dev.ea1999bfb4ca";
        m.dataFormat = "hp-domain-v1";
        m.entrypoint = "python/bin/python3.12";
        m.argv = [
          "-I",
          "-B",
          "-m",
          "hp",
          "serve-stdio",
          "--bundle",
          "--runtime-root",
          "${runtimeRoot}",
          "--instance-dir",
          "${instanceDir}",
          "--contract-digest",
          "${contractDigest}",
        ];
      },
    ],
    ["version with colon", set("version", "1:2")],
    ["version with slash", set("version", "a/b")],
    ["version with plus", set("version", "1+2")],
    ["version leading dash", set("version", "-1")],
    ["version 256", set("version", "v".repeat(256))],
    ["version 257", set("version", "v".repeat(257))],
    ["runtimeId without prefix", set("runtimeId", "example.graph")],
    ["runtimeId leading underscore", set("runtimeId", "_x")],
    ["publisher empty", set("publisher", "")],
    ["dataFormat with colon", set("dataFormat", "a:b")],
    ["dataFormat leading dot", set("dataFormat", ".x")],
    ["entrypoint space", set("entrypoint", "a b")],
    ["entrypoint dot segment", set("entrypoint", "x/./y")],
    ["entrypoint parent", set("entrypoint", "../x")],
    ["entrypoint absolute", set("entrypoint", "/bin/x")],
    ["entrypoint non-ASCII", set("entrypoint", "é")],
    ["entrypoint 257", set("entrypoint", "e".repeat(257))],
    ["argv 32", set("argv", argv32)],
    ["argv 33", set("argv", [...argv32, "x"])],
    ["argv item 1024", set("argv", ["a".repeat(1024)])],
    ["argv item 1025", set("argv", ["a".repeat(1025)])],
    ["argv unknown placeholder", set("argv", ["${HOME}"])],
    ["argv unclosed placeholder", set("argv", ["${runtimeRoot"])],
    ["argv literal dollars", set("argv", ["$x", "$${runtimeRoot}", "a$"])],
    ["argv resource handle", set("argv", ["${resourceHandle}"])],
    ["platform x86", set("platform", "darwin-x86_64")],
    ["minimumOs newer", set("minimumOs", "27.0")],
    ["minimumOs older", set("minimumOs", "26.5")],
    ["protocols empty", set("protocols", [])],
    [
      "protocols 9",
      set(
        "protocols",
        many(9, () => ({ version: "p", contractDigest: sha256("p") })),
      ),
    ],
    [
      "protocol version leading dot",
      set("protocols", [{ version: ".p", contractDigest: sha256("p") }]),
    ],
    [
      "capabilities 33",
      (m) => {
        m.capabilities = many(33, (i) => ({
          id: "c" + i,
          version: "1",
          schemaDigest: sha256("c"),
          required: false,
        }));
      },
    ],
    ["capability id with space", setIn(["capabilities", "0", "id"], "a b")],
    ["capability extra key", setIn(["capabilities", "0", "extra"], true)],
    [
      "profile requirement with applicability",
      set("executionProfileRequirements", [
        {
          capabilityId: "c",
          profile: { id: "p", version: "1", digest: sha256("p") },
          applicability: {
            executionPort: "embedded",
            purpose: "review",
            trustModel: "current-user",
            profileDigest: sha256("p"),
            configurationRevision: "0",
            credentialRevision: "12",
          },
        },
      ]),
    ],
    [
      "profile requirement bad revision",
      set("executionProfileRequirements", [
        {
          capabilityId: "c",
          profile: { id: "p", version: "1", digest: sha256("p") },
          applicability: {
            executionPort: "embedded",
            purpose: "review",
            trustModel: "current-user",
            profileDigest: sha256("p"),
            configurationRevision: "01",
            credentialRevision: "1",
          },
        },
      ]),
    ],
    [
      "profile requirement extra key",
      set("executionProfileRequirements", [
        {
          capabilityId: "c",
          profile: { id: "p", version: "1", digest: sha256("p") },
          note: "x",
        },
      ]),
    ],
    [
      "profile requirements 33",
      set(
        "executionProfileRequirements",
        many(33, () => ({
          capabilityId: "c",
          profile: { id: "p", version: "1", digest: sha256("p") },
        })),
      ),
    ],
    [
      "dependency version plus",
      set("dependencies", [{ id: "d", version: "1+2", digest: sha256("d") }]),
    ],
    [
      "dependencies 33",
      set(
        "dependencies",
        many(33, (i) => ({ id: "d" + i, version: "1", digest: sha256("d") })),
      ),
    ],
    ["extra field", set("note", "x")],
    ["missing field", (m) => delete m.dataFormat],
  ];
  const verdicts = new Map<string, boolean>();
  for (const [name, mutate] of manifestCases) {
    const value = JSON.parse(JSON.stringify(built.manifest));
    mutate(value);
    const ajv = frozen.manifest(value) === true;
    const host = manifestProblems(value);
    assert.equal(host.length === 0, ajv, "manifest " + name + ": " + host);
    verdicts.set("manifest " + name, ajv);
  }
  const files = built.release.files as { path: string }[];
  const releaseCases: Mutation[] = [
    ["base", () => {}],
    [
      "delivery-r3 identity",
      (r) => {
        r.runtimeId = "runtime:harness-plane";
        r.version = "0.1.0-dev.ea1999bfb4ca";
        r.dataFormat = "hp-domain-v1";
      },
    ],
    ["version with plus", set("version", "1+2")],
    ["version with colon", set("version", "1:2")],
    ["version with underscore", set("version", "1_2")],
    ["version 64", set("version", "v".repeat(64))],
    ["version 65", set("version", "v".repeat(65))],
    ["dataFormat with colon", set("dataFormat", "a:b")],
    ["dataFormat 128", set("dataFormat", "d".repeat(128))],
    ["dataFormat 129", set("dataFormat", "d".repeat(129))],
    ["dataFormat leading underscore", set("dataFormat", "_d")],
    ["archive zero bytes", setIn(["archive", "bytes"], 0)],
    ["manifest zero bytes", setIn(["manifest", "bytes"], 0)],
    ["files empty", set("files", [])],
    ["file path with space", setIn(["files", "0", "path"], "a b")],
    ["file path non-ASCII", setIn(["files", "0", "path"], "文件.json")],
    ["file path parent", setIn(["files", "0", "path"], "a/../b")],
    ["file path backslash", setIn(["files", "0", "path"], "a\\b")],
    ["file path NUL", setIn(["files", "0", "path"], "a\u0000b")],
    [
      "file path 512 code points",
      setIn(["files", "0", "path"], "文".repeat(512)),
    ],
    [
      "file path 513 code points",
      setIn(["files", "0", "path"], "文".repeat(513)),
    ],
    [
      "files 4097",
      set(
        "files",
        many(4097, (i) => ({ ...files[0], path: "f" + i })),
      ),
    ],
    ["limits zero", setIn(["limits", "membersMax"], 0)],
    [
      "dependency id with colon",
      set("dependencies", [{ id: "a:b", version: "1", digest: sha256("d") }]),
    ],
    [
      "dependencies 257",
      set(
        "dependencies",
        many(257, (i) => ({ id: "d" + i, version: "1", digest: sha256("d") })),
      ),
    ],
    [
      "maintenance ok",
      set("maintenance", {
        entrypoint: "bin/maintain",
        argv: ["a".repeat(256)],
      }),
    ],
    [
      "maintenance empty argv item",
      set("maintenance", { entrypoint: "bin/maintain", argv: [""] }),
    ],
    [
      "maintenance argv item 257",
      set("maintenance", {
        entrypoint: "bin/maintain",
        argv: ["a".repeat(257)],
      }),
    ],
    [
      "maintenance argv 33",
      set("maintenance", {
        entrypoint: "bin/maintain",
        argv: many(33, () => "a"),
      }),
    ],
    ["source reference empty", setIn(["source", "reference"], "")],
    ["source reference 513", setIn(["source", "reference"], "r".repeat(513))],
    ["release digest field", set("releaseDigest", sha256("x"))],
  ];
  for (const [name, mutate] of releaseCases) {
    const value = JSON.parse(JSON.stringify(built.release));
    mutate(value);
    const ajv = frozen.release(value) === true;
    const host = releaseRecordProblems(value);
    assert.equal(host.length === 0, ajv, "release " + name + ": " + host);
    verdicts.set("release " + name, ajv);
  }
  // The corpus exercises both outcomes on both sides; the earlier Host rules differed on these.
  const accepted = [...verdicts].filter(([, v]) => v).map(([k]) => k);
  const refused = [...verdicts].filter(([, v]) => !v).map(([k]) => k);
  for (const name of [
    "manifest base",
    "manifest delivery-r3 identity",
    "manifest version with colon",
    "manifest dataFormat with colon",
    "manifest protocols empty",
    "release base",
    "release delivery-r3 identity",
    "release version with plus",
    "release file path non-ASCII",
  ])
    assert.ok(accepted.includes(name), name + " must be accepted");
  for (const name of [
    "manifest version leading dash",
    "manifest entrypoint space",
    "manifest argv 33",
    "manifest argv item 1025",
    "manifest minimumOs newer",
    "manifest capabilities 33",
    "manifest profile requirement bad revision",
    "release version with underscore",
    "release dataFormat leading underscore",
    "release archive zero bytes",
    "release files empty",
    "release maintenance empty argv item",
    "release source reference empty",
  ])
    assert.ok(refused.includes(name), name + " must be refused");
});

test("KB-278 第六项：同一 runtimeId 同版本不同字节在解包前拒绝为 INTEGRITY_MISMATCH；同版本同字节与新版本号照常核验", () => {
  const dir = root();
  const publisher = newPublisher();
  const first = buildBundle(join(dir, "first"), publisher, spec());
  const firstVerdict = verifyBundle(first.dir, host());
  assert.equal(firstVerdict.identityVerified, true);
  const recorded = new Map([
    [
      installedVersionKey("runtime:test-list", "1"),
      {
        artifactDigest: firstVerdict.artifactDigest,
        releaseRecordDigest: firstVerdict.releaseRecordDigest,
      },
    ],
  ]);
  const withRecorded = { ...host(), installedVersions: recorded };
  const changed = buildBundle(join(dir, "changed"), publisher, {
    ...spec(),
    entrypointBytes: Buffer.from("process.exit(2)\n"),
  });
  const refused = verifyBundle(changed.dir, withRecorded);
  assert.equal(refused.identityVerified, false);
  assert.equal(refused.code, "INTEGRITY_MISMATCH");
  assert.match(
    refused.reasons.join(" "),
    /version 1 of runtime:test-list is already installed with a different archive or release record/,
  );
  assert.equal(refused.members.size, 0, "nothing read past the identity check");
  assert.throws(
    () => installPackage(refused, join(dir, "runtimes"), changed.dir),
    /refusing to install/,
  );
  // A re-signed record over the same archive is a different release description of the same version: refused as well.
  const resigned = buildBundle(join(dir, "resigned"), publisher, spec(), {
    release: (r) => ({
      ...r,
      source: { kind: "offline-import", reference: "other" },
    }),
  });
  assert.equal(
    verifyBundle(resigned.dir, withRecorded).code,
    "INTEGRITY_MISMATCH",
  );
  // The same bytes verify again (the supervisor then answers with the recorded installation).
  const same = verifyBundle(first.dir, withRecorded);
  assert.equal(same.identityVerified, true);
  assert.equal(same.artifactDigest, firstVerdict.artifactDigest);
  // A new version number is a new identity.
  const next = buildBundle(join(dir, "next"), publisher, {
    ...spec(),
    version: "2",
    entrypointBytes: Buffer.from("process.exit(2)\n"),
  });
  assert.deepEqual(verifyBundle(next.dir, withRecorded).reasons, []);
  assert.equal(existsSync(join(dir, "runtimes")), false);
});

test("KB-278 第四项：启动配置的环境允许列表只收窄 Host 固定环境，不增加变量，不取宿主环境；非变量名条目在准入拒绝", () => {
  assert.deepEqual(
    launchEnvironment(["HOME", "PATH", "PYTHONDONTWRITEBYTECODE"], "/i"),
    { PATH: "/usr/bin:/bin", HOME: "/i", PYTHONDONTWRITEBYTECODE: "1" },
  );
  assert.deepEqual(launchEnvironment(["PATH"], "/i"), {
    PATH: "/usr/bin:/bin",
  });
  assert.deepEqual(launchEnvironment([], "/i"), {});
  // A name the Host does not offer is not taken from the Host's own environment.
  process.env.CSTHINK_ADMISSION_PROBE = "leak";
  try {
    assert.deepEqual(
      launchEnvironment(["CSTHINK_ADMISSION_PROBE", "USER"], "/i"),
      {},
    );
  } finally {
    delete process.env.CSTHINK_ADMISSION_PROBE;
  }
  const dir = root();
  const publisher = newPublisher();
  for (const [name, list] of [
    ["assignment", ["PATH=/usr/bin"]],
    ["duplicate", ["PATH", "PATH"]],
    ["empty", [""]],
  ] as const) {
    const built = buildBundle(join(dir, name), publisher, {
      ...spec(),
      launchOverride: (l) => ({ ...l, environmentAllowList: [...list] }),
    });
    const verdict = verifyBundle(built.dir, host());
    assert.equal(verdict.identityVerified, false, name);
    assert.equal(verdict.code, "INTEGRITY_MISMATCH", name);
    assert.ok(verdict.reasons.includes("environmentAllowList"), name);
  }
});
