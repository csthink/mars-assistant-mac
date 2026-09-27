/**
 * Runtime bundle admission (Contract "安装、身份与协商", release-record schema candidate).
 * The input is a directory holding bundle.tar (ustar), release.json, release.sig
 * (Ed25519 over the record's raw bytes) and publisher.pub (SPKI PEM). Verification runs
 * in the Contract's order and every failure is recorded; nothing is unpacked into the
 * package root before the whole identity verified. A platform, OS, protocol or
 * dependency mismatch keeps the verified identity but records an incompatibility, so
 * the catalog shows an unusable entry instead of an installable one.
 */
import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, delimiter } from "node:path";
import { parseJsonDocument } from "./runtime-framing";
import {
  admissionCodes,
  argvPlaceholders,
  canonicalJson,
  contractDigest,
  contractVersion,
  iJsonProblem,
  launchers,
  runtimeLimits,
  type AdmissionCode,
  type Capability,
  type LaunchConfiguration,
  type Manifest,
  type ProgramIdentity,
} from "../shared/runtime-host";

export const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const digestOf = (value: unknown) => sha256(canonicalJson(value));

/** Bundle limits of the Host itself; the record's own limits must not exceed them. */
export const archiveBytesMax = 256 * 1024 * 1024;
export const expandedBytesCeiling = 1024 * 1024 * 1024;
export const membersCeiling = 20_000;

export interface TarMember {
  name: string;
  size: number;
  type: string;
  mode: string;
  linkname: string;
  data: Buffer;
}
/** Minimal ustar reader: regular files only are accepted later, every entry is reported. */
export function readTar(archive: Buffer): TarMember[] {
  const members: TarMember[] = [];
  let offset = 0;
  const text = (b: Buffer) => b.toString("utf8").replace(/\0.*$/s, "");
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if (text(header.subarray(257, 263)) !== "ustar")
      throw new Error("archive is not ustar at offset " + offset);
    const name = text(header.subarray(0, 100));
    const prefix = text(header.subarray(345, 500));
    const size = parseInt(text(header.subarray(124, 136)).trim() || "0", 8);
    const mode = parseInt(text(header.subarray(100, 108)).trim() || "0", 8);
    const typeByte = header[156];
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    const linkname = text(header.subarray(157, 257));
    if (!Number.isSafeInteger(size) || offset + 512 + size > archive.length)
      throw new Error("archive member size escapes the archive");
    members.push({
      name: prefix ? prefix + "/" + name : name,
      size,
      type,
      mode: "0" + (mode & 0o777).toString(8).padStart(3, "0"),
      linkname,
      data: Buffer.from(archive.subarray(offset + 512, offset + 512 + size)),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return members;
}

export interface ReleaseRecord {
  schema: "csthink-runtime-release/v1-candidate";
  runtimeId: string;
  publisher: {
    id: string;
    signatureAlgorithm: "ed25519";
    publicKeyDigest: string;
  };
  version: string;
  platform: string;
  dataFormat: string;
  archive: { digest: string; bytes: number; format: "ustar" };
  manifest: { path: "manifest.json"; digest: string; bytes: number };
  files: {
    path: string;
    bytes: number;
    sha256: string;
    mode: "0644" | "0755";
  }[];
  limits: { expandedBytesMax: number; membersMax: number };
  dependencies: { id: string; version: string; digest: string }[];
  permissionProfileDigest: string;
  maintenance: { entrypoint: string; argv: string[] } | null;
  source: {
    kind: "built-in" | "catalog" | "offline-import";
    reference: string;
  };
}
/*
 * Field rules of the frozen Contract 0.1.0: the release record follows
 * release-record/release-record.schema.json and the manifest follows the Manifest
 * definition of schema.json, field by field (KB-278 item 2). A value the frozen schema
 * accepts is accepted here and a value it refuses is refused; runtime-admission.test.ts
 * compares both validators with Ajv on the frozen schema files.
 */
const digestPattern = /^[0-9a-f]{64}$/;
const runtimeIdPattern = /^runtime:[A-Za-z0-9._-]{1,120}$/;
const publisherIdPattern = /^publisher:[A-Za-z0-9._-]{1,120}$/;
/** schema.json identifiers (runtimeId, publisher, version, dataFormat, ids and versions), 1 to 256 characters. */
const contractIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/;
/** release-record Identifier (dataFormat, dependency id). */
const releaseIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
/** release-record Version (record version, dependency version). */
const releaseVersionPattern = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
/** schema.json Manifest.entrypoint. */
const manifestEntrypointPattern =
  /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_./-]+$/;
/** schema.json Manifest.argv item: "$" is literal unless it opens a closed placeholder. */
const argvTemplatePattern =
  /^(?:[^$]|\$(?!\{)|\$\{(?:runtimeRoot|instanceDir|contractDigest|resourceHandle)\})*$/;
/** release-record RelativePath without its NUL exclusion, which is checked separately. */
const releaseRelativePathPattern =
  /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))(?!.*\\)[^]+$/;
const revisionPattern = /^(0|[1-9][0-9]*)$/;
/** Launch configuration environmentAllowList entries are variable names (Assistant launch profile). */
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isDigest = (value: unknown) =>
  isString(value) && digestPattern.test(value);
/** JSON Schema "integer" with a minimum: any integral number, not only safe integers. */
const isInteger = (value: unknown, minimum: number) =>
  Number.isInteger(value) && (value as number) >= minimum;
/** JSON Schema string length counts code points, not UTF-16 code units. */
const codePoints = (value: string) => [...value].length;
const isContractIdentifier = (value: unknown) =>
  isString(value) &&
  value.length >= 1 &&
  value.length <= 256 &&
  contractIdentifierPattern.test(value);
const isReleaseIdentifier = (value: unknown) =>
  isString(value) && releaseIdentifierPattern.test(value);
const isReleaseVersion = (value: unknown) =>
  isString(value) && releaseVersionPattern.test(value);
const isReleaseRelativePath = (value: unknown) =>
  isString(value) &&
  codePoints(value) >= 1 &&
  codePoints(value) <= 512 &&
  !value.includes("\u0000") &&
  releaseRelativePathPattern.test(value);
/** Object keys: every required key present and no key outside the allowed set. */
function keysWithin(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  return (
    required.every((key) => key in value) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}
/** Relative bundle path: no leading slash, no empty, "." or ".." segment, no backslash. */
export function validRelativePath(value: unknown): value is string {
  return (
    isString(value) &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => key in value);
}
/** Structural validation of the release record (schema draft-07 candidate, no extra fields). */
export function releaseRecordProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["release record is not an object"];
  if (
    !exactKeys(value, [
      "schema",
      "runtimeId",
      "publisher",
      "version",
      "platform",
      "dataFormat",
      "archive",
      "manifest",
      "files",
      "limits",
      "dependencies",
      "permissionProfileDigest",
      "maintenance",
      "source",
    ])
  )
    problems.push("release record fields differ from the schema");
  if (value.schema !== "csthink-runtime-release/v1-candidate")
    problems.push("schema identifier");
  if (!isString(value.runtimeId) || !runtimeIdPattern.test(value.runtimeId))
    problems.push("runtimeId");
  const publisher = value.publisher;
  if (
    !isRecord(publisher) ||
    !exactKeys(publisher, ["id", "signatureAlgorithm", "publicKeyDigest"]) ||
    !isString(publisher.id) ||
    !publisherIdPattern.test(publisher.id) ||
    publisher.signatureAlgorithm !== "ed25519" ||
    !isDigest(publisher.publicKeyDigest)
  )
    problems.push("publisher identity");
  if (!isReleaseVersion(value.version)) problems.push("version");
  if (value.platform !== "darwin-arm64" && value.platform !== "darwin-x86_64")
    problems.push("platform");
  if (!isReleaseIdentifier(value.dataFormat)) problems.push("dataFormat");
  const archive = value.archive;
  if (
    !isRecord(archive) ||
    !exactKeys(archive, ["digest", "bytes", "format"]) ||
    !isDigest(archive.digest) ||
    !isInteger(archive.bytes, 1) ||
    archive.format !== "ustar"
  )
    problems.push("archive");
  const manifest = value.manifest;
  if (
    !isRecord(manifest) ||
    !exactKeys(manifest, ["path", "digest", "bytes"]) ||
    manifest.path !== "manifest.json" ||
    !isDigest(manifest.digest) ||
    !isInteger(manifest.bytes, 1)
  )
    problems.push("manifest entry");
  if (
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > 4096 ||
    !value.files.every(
      (f) =>
        isRecord(f) &&
        exactKeys(f, ["path", "bytes", "sha256", "mode"]) &&
        isReleaseRelativePath(f.path) &&
        isInteger(f.bytes, 0) &&
        isDigest(f.sha256) &&
        (f.mode === "0644" || f.mode === "0755"),
    )
  )
    problems.push("files");
  const limits = value.limits;
  if (
    !isRecord(limits) ||
    !exactKeys(limits, ["expandedBytesMax", "membersMax"]) ||
    !isInteger(limits.expandedBytesMax, 1) ||
    !isInteger(limits.membersMax, 1)
  )
    problems.push("limits");
  if (
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > 256 ||
    !value.dependencies.every(
      (d) =>
        isRecord(d) &&
        exactKeys(d, ["id", "version", "digest"]) &&
        isReleaseIdentifier(d.id) &&
        isReleaseVersion(d.version) &&
        isDigest(d.digest),
    )
  )
    problems.push("dependencies");
  if (!isDigest(value.permissionProfileDigest))
    problems.push("permissionProfileDigest");
  const maintenance = value.maintenance;
  if (
    maintenance !== null &&
    (!isRecord(maintenance) ||
      !exactKeys(maintenance, ["entrypoint", "argv"]) ||
      !isReleaseRelativePath(maintenance.entrypoint) ||
      !Array.isArray(maintenance.argv) ||
      maintenance.argv.length > 32 ||
      !maintenance.argv.every(
        (arg) =>
          isString(arg) && codePoints(arg) >= 1 && codePoints(arg) <= 256,
      ))
  )
    problems.push("maintenance");
  const source = value.source;
  if (
    !isRecord(source) ||
    !exactKeys(source, ["kind", "reference"]) ||
    !["built-in", "catalog", "offline-import"].includes(
      source.kind as string,
    ) ||
    !isString(source.reference) ||
    codePoints(source.reference) < 1 ||
    codePoints(source.reference) > 512
  )
    problems.push("source");
  for (const forbidden of [
    "releaseDigest",
    "recordDigest",
    "signature",
    "downloadUrl",
  ])
    if (forbidden in value) problems.push("forbidden field " + forbidden);
  return problems;
}
export function manifestProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["manifest is not an object"];
  if (
    !exactKeys(value, [
      "manifestVersion",
      "runtimeId",
      "publisher",
      "version",
      "entrypoint",
      "argv",
      "platform",
      "minimumOs",
      "protocols",
      "capabilities",
      "permissionProfileDigest",
      "executionProfileRequirements",
      "dataFormat",
      "dependencies",
    ])
  )
    problems.push("manifest fields differ from the Contract schema");
  if (value.manifestVersion !== contractVersion)
    problems.push("manifestVersion");
  if (!isContractIdentifier(value.runtimeId)) problems.push("runtimeId");
  if (!isContractIdentifier(value.publisher)) problems.push("publisher");
  if (!isContractIdentifier(value.version)) problems.push("version");
  if (
    !isString(value.entrypoint) ||
    value.entrypoint.length < 1 ||
    value.entrypoint.length > 256 ||
    !manifestEntrypointPattern.test(value.entrypoint)
  )
    problems.push("entrypoint");
  if (
    !Array.isArray(value.argv) ||
    !value.argv.every(isString) ||
    value.argv.length > 32 ||
    value.argv.some((arg: string) => codePoints(arg) > 1024)
  )
    problems.push("argv");
  else {
    // Placeholder problems keep their own reason; the schema pattern decides.
    const placeholders = argvTemplateProblems(value.argv);
    problems.push(...placeholders);
    if (
      !placeholders.length &&
      !value.argv.every((arg: string) => argvTemplatePattern.test(arg))
    )
      problems.push("argv");
  }
  // schema.json enums: platform darwin-arm64 and minimumOs 26.6.2 are the only Manifest values.
  if (value.platform !== "darwin-arm64") problems.push("platform");
  if (value.minimumOs !== "26.6.2") problems.push("minimumOs");
  if (
    !Array.isArray(value.protocols) ||
    value.protocols.length > 8 ||
    !value.protocols.every(
      (p) =>
        isRecord(p) &&
        exactKeys(p, ["version", "contractDigest"]) &&
        isContractIdentifier(p.version) &&
        isDigest(p.contractDigest),
    )
  )
    problems.push("protocols");
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > 32 ||
    !value.capabilities.every(
      (c) =>
        isRecord(c) &&
        exactKeys(c, ["id", "version", "schemaDigest", "required"]) &&
        isContractIdentifier(c.id) &&
        isContractIdentifier(c.version) &&
        isDigest(c.schemaDigest) &&
        typeof c.required === "boolean",
    )
  )
    problems.push("capabilities");
  if (!isDigest(value.permissionProfileDigest))
    problems.push("permissionProfileDigest");
  if (
    !Array.isArray(value.executionProfileRequirements) ||
    value.executionProfileRequirements.length > 32 ||
    !value.executionProfileRequirements.every(
      (r) =>
        isRecord(r) &&
        keysWithin(r, ["capabilityId", "profile"], ["applicability"]) &&
        isContractIdentifier(r.capabilityId) &&
        isRecord(r.profile) &&
        exactKeys(r.profile, ["id", "version", "digest"]) &&
        isContractIdentifier(r.profile.id) &&
        isContractIdentifier(r.profile.version) &&
        isDigest(r.profile.digest) &&
        (!("applicability" in r) || validApplicability(r.applicability)),
    )
  )
    problems.push("executionProfileRequirements");
  if (!isContractIdentifier(value.dataFormat)) problems.push("dataFormat");
  if (
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > 32 ||
    !value.dependencies.every(
      (d) =>
        isRecord(d) &&
        exactKeys(d, ["id", "version", "digest"]) &&
        isContractIdentifier(d.id) &&
        isContractIdentifier(d.version) &&
        isDigest(d.digest),
    )
  )
    problems.push("dependencies");
  return problems;
}
/** schema.json ReviewerApplicability. */
function validApplicability(value: unknown) {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "executionPort",
      "purpose",
      "trustModel",
      "profileDigest",
      "configurationRevision",
      "credentialRevision",
    ]) &&
    ["embedded", "standalone", "any"].includes(value.executionPort as string) &&
    value.purpose === "review" &&
    value.trustModel === "current-user" &&
    isDigest(value.profileDigest) &&
    [value.configurationRevision, value.credentialRevision].every(
      (revision) =>
        isString(revision) &&
        revision.length <= 32 &&
        revisionPattern.test(revision),
    )
  );
}
export function launchProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["launch configuration is not an object"];
  if (
    !exactKeys(value, [
      "schema",
      "entrypoint",
      "argv",
      "environmentAllowList",
      "dependencies",
      "launcher",
      "trustModel",
    ])
  )
    problems.push("launch configuration fields");
  if (value.schema !== "csthink-runtime-launch/v1")
    problems.push("launch schema");
  if (!validRelativePath(value.entrypoint)) problems.push("launch entrypoint");
  if (!Array.isArray(value.argv) || !value.argv.every(isString))
    problems.push("launch argv");
  // Variable names only, each once: the list narrows the Host's fixed launch environment (KB-278 item 4).
  if (
    !Array.isArray(value.environmentAllowList) ||
    !value.environmentAllowList.every(
      (name) => isString(name) && environmentNamePattern.test(name),
    ) ||
    new Set(value.environmentAllowList).size !==
      value.environmentAllowList.length
  )
    problems.push("environmentAllowList");
  if (!Array.isArray(value.dependencies)) problems.push("launch dependencies");
  if (!launchers.includes(value.launcher as LaunchConfiguration["launcher"]))
    problems.push("launcher");
  if (value.trustModel !== "current-user") problems.push("trustModel");
  return problems;
}
/** Only the closed placeholder set may appear; other "${...}" text is refused. */
export function argvTemplateProblems(argv: string[]): string[] {
  const problems: string[] = [];
  for (const arg of argv)
    for (const match of arg.matchAll(/\$\{[^}]*\}?/g))
      if (!(argvPlaceholders as readonly string[]).includes(match[0]))
        problems.push("argv placeholder outside the closed set: " + match[0]);
  return problems;
}
/** Whether the argv template needs a registered resource handle at launch. */
export const needsResourceHandle = (template: string[]) =>
  template.some((arg) => arg.includes("${resourceHandle}"));
/**
 * Expands the closed placeholders. ${resourceHandle} is the Host-registered handle
 * (Contract RC-02); without one the template is refused, never expanded to an empty
 * string (KB-278 item 3).
 */
export function expandArgv(
  template: string[],
  values: {
    runtimeRoot: string;
    instanceDir: string;
    contractDigest: string;
    resourceHandle: string | null;
  },
): string[] {
  if (needsResourceHandle(template) && !values.resourceHandle)
    throw new Error(
      "argv template needs ${resourceHandle} but no registered resource handle was given",
    );
  return template.map((arg) =>
    arg
      .replaceAll("${runtimeRoot}", values.runtimeRoot)
      .replaceAll("${instanceDir}", values.instanceDir)
      .replaceAll("${contractDigest}", values.contractDigest)
      .replaceAll("${resourceHandle}", values.resourceHandle ?? ""),
  );
}
/**
 * The Host's fixed launch environment narrowed to the names the bundle's launch
 * configuration allows (KB-278 item 4): the list can remove a variable, never add one,
 * and nothing is taken from the Host's own environment. A launcher that needs its own
 * switch (electron-node: ELECTRON_RUN_AS_NODE) adds it after this.
 */
export function launchEnvironment(
  allowList: readonly string[],
  instanceDir: string,
): Record<string, string> {
  const offered: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: instanceDir,
    PYTHONDONTWRITEBYTECODE: "1",
  };
  return Object.fromEntries(
    Object.entries(offered).filter(([name]) => allowList.includes(name)),
  );
}

/** Host descriptor: what this machine and build offer to a bundle. */
export interface HostDescriptor {
  platform: string;
  /** macOS product version, for example "27.0". */
  osVersion: string;
  /** This application's executable, used with ELECTRON_RUN_AS_NODE=1 for electron-node bundles. */
  electronExecutable: string;
  /** Absolute python3 candidates in resolution order; the first runnable one is pinned by digest. */
  pythonCandidates: string[];
  /** Pinned publisher key digests by runtimeId (catalog entries and earlier imports). */
  publisherPins: Map<string, string>;
  /**
   * Identities already recorded, keyed by installedVersionKey(runtimeId, version): the same
   * version with a different archive or release record is refused (runtime-delivery-design:
   * 相同版本号变更字节必须拒绝; KB-278 item 6).
   */
  installedVersions?: Map<
    string,
    { artifactDigest: string; releaseRecordDigest: string }
  >;
}
export const installedVersionKey = (runtimeId: string, version: string) =>
  runtimeId + "@" + version;
export function osAtLeast(actual: string, minimum: string) {
  const a = actual.split(".").map(Number);
  const m = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, m.length); i++) {
    const x = a[i] ?? 0;
    const y = m[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}
export function defaultPythonCandidates(environment = process.env) {
  const paths = (environment.PATH ?? "")
    .split(delimiter)
    .filter(isAbsolute)
    .map((p) => join(p, "python3"));
  return [
    ...new Set([
      ...paths,
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/usr/bin/python3",
    ]),
  ];
}
/** Resolves a launcher to a concrete program identity; the digest is recomputed at every start. */
export function resolveLauncher(
  kind: LaunchConfiguration["launcher"],
  host: HostDescriptor,
  entrypointExecutable: boolean,
): { identity: ProgramIdentity | null; reasons: string[] } {
  if (kind === "direct") {
    if (!entrypointExecutable)
      return {
        identity: null,
        reasons: [
          "direct launcher requires an executable (0755) entrypoint member",
        ],
      };
    return {
      identity: { launcher: "direct", binaryDigest: "", version: "" },
      reasons: [],
    };
  }
  if (kind === "electron-node") {
    if (!existsSync(host.electronExecutable))
      return { identity: null, reasons: ["application executable not found"] };
    const stat = statSync(host.electronExecutable);
    // The Electron binary is large; its identity is the path plus size/mtime digest recomputed at each start.
    return {
      identity: {
        launcher: host.electronExecutable,
        binaryDigest: sha256(
          `${host.electronExecutable}|${stat.size}|${Math.floor(stat.mtimeMs)}`,
        ),
        version: process.versions.electron ?? process.versions.node,
      },
      reasons: [],
    };
  }
  for (const candidate of host.pythonCandidates) {
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    const probe = spawnSync(
      candidate,
      ["-c", "import sys; print(sys.version.split()[0])"],
      {
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    if (probe.status !== 0 || !/^3\.\d+/.test(probe.stdout.trim())) continue;
    return {
      identity: {
        launcher: candidate,
        binaryDigest: sha256(readFileSync(candidate)),
        version: probe.stdout.trim(),
      },
      reasons: [],
    };
  }
  return {
    identity: null,
    reasons: ["no runnable python3 among the launcher candidates"],
  };
}

export interface AdmissionVerdict {
  /** Identity verified: signature, publisher, archive, files, manifest and launch configuration agree. */
  identityVerified: boolean;
  /** Class of the first identity failure, or of the incompatibility when the identity verified. */
  code: AdmissionCode | null;
  reasons: string[];
  incompatibility: { code: AdmissionCode; reasons: string[] } | null;
  release: ReleaseRecord | null;
  manifest: Manifest | null;
  launch: LaunchConfiguration | null;
  artifactDigest: string;
  archiveBytes: number;
  releaseRecordDigest: string;
  manifestDigest: string;
  publicKeyDigest: string;
  members: Map<string, { data: Buffer; mode: string }>;
  /** Capability id to the canonical digest of its packaged schema member. */
  capabilitySchemas: Map<string, { digest: string; bytes: Buffer }>;
  launcher: ProgramIdentity | null;
  checkedFiles: number;
  expandedBytes: number;
}
const codeRank: Record<AdmissionCode, number> = {
  INVALID_SOURCE: 0,
  INTEGRITY_MISMATCH: 1,
  RESOURCE_LIMIT: 2,
  UNSUPPORTED_CAPABILITY: 3,
  UNSUPPORTED_VERSION: 4,
};
function readOptional(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}
function loadPublicKey(pem: Buffer): { key: KeyObject; digest: string } | null {
  try {
    const key = createPublicKey({ key: pem, format: "pem" });
    if (key.asymmetricKeyType !== "ed25519") return null;
    return {
      key,
      digest: sha256(key.export({ type: "spki", format: "der" }) as Buffer),
    };
  } catch {
    return null;
  }
}
/**
 * Verifies a bundle directory. The order follows the Contract: signature, publisher,
 * runtime identity, archive digest, member list, manifest, launch configuration,
 * capability schemas, then platform, OS, protocol, dependencies and launcher.
 */
export function verifyBundle(
  sourceDir: string,
  host: HostDescriptor,
): AdmissionVerdict {
  const failures = new Map<AdmissionCode, string[]>();
  const fail = (code: AdmissionCode, reason: string) => {
    if (!failures.has(code)) failures.set(code, []);
    failures.get(code)!.push(reason);
  };
  const verdict: AdmissionVerdict = {
    identityVerified: false,
    code: null,
    reasons: [],
    incompatibility: null,
    release: null,
    manifest: null,
    launch: null,
    artifactDigest: "",
    archiveBytes: 0,
    releaseRecordDigest: "",
    manifestDigest: "",
    publicKeyDigest: "",
    members: new Map(),
    capabilitySchemas: new Map(),
    launcher: null,
    checkedFiles: 0,
    expandedBytes: 0,
  };
  const finish = () => {
    const codes = [...failures.keys()].sort(
      (a, b) => codeRank[a] - codeRank[b],
    );
    verdict.code = codes[0] ?? null;
    verdict.reasons = codes.flatMap((code) => failures.get(code)!);
    return verdict;
  };
  const releaseBytes = readOptional(join(sourceDir, "release.json"));
  const signatureText = readOptional(join(sourceDir, "release.sig"));
  const publisherPem = readOptional(join(sourceDir, "publisher.pub"));
  const archive = readOptional(join(sourceDir, "bundle.tar"));
  for (const [name, present] of [
    ["release.json", releaseBytes],
    ["release.sig", signatureText],
    ["publisher.pub", publisherPem],
    ["bundle.tar", archive],
  ] as const)
    if (!present) fail("INVALID_SOURCE", `missing ${name}`);
  if (failures.size) return finish();
  // 1. Signature over the raw record bytes with the bundled publisher key.
  const publicKey = loadPublicKey(publisherPem!);
  if (!publicKey) {
    fail("INVALID_SOURCE", "publisher.pub is not an Ed25519 public key");
    return finish();
  }
  verdict.publicKeyDigest = publicKey.digest;
  const signature = /^[0-9a-f]+$/i.test(signatureText!.toString("utf8").trim())
    ? Buffer.from(signatureText!.toString("utf8").trim(), "hex")
    : Buffer.alloc(0);
  let signed = false;
  try {
    signed =
      signature.length === 64 &&
      cryptoVerify(null, releaseBytes!, publicKey.key, signature);
  } catch {
    signed = false;
  }
  if (!signed) {
    fail(
      "INVALID_SOURCE",
      "release signature does not verify against publisher.pub",
    );
    return finish();
  }
  verdict.releaseRecordDigest = sha256(releaseBytes!);
  // 2. Record structure, publisher identity and pinned key.
  let release: unknown;
  try {
    release = JSON.parse(releaseBytes!.toString("utf8"));
  } catch {
    fail("INTEGRITY_MISMATCH", "release record is not JSON");
    return finish();
  }
  const recordProblems = releaseRecordProblems(release);
  if (recordProblems.length) {
    for (const p of recordProblems)
      fail("INTEGRITY_MISMATCH", "release record: " + p);
    return finish();
  }
  const record = release as ReleaseRecord;
  verdict.release = record;
  if (record.publisher.publicKeyDigest !== publicKey.digest)
    fail(
      "INVALID_SOURCE",
      "publisher key digest in the record differs from publisher.pub",
    );
  const pinned = host.publisherPins.get(record.runtimeId);
  if (pinned && pinned !== publicKey.digest)
    fail(
      "INVALID_SOURCE",
      "publisher key differs from the key pinned for " + record.runtimeId,
    );
  if (failures.size) return finish();
  // 3. Archive digest, bytes and format; member list against the signed file list.
  verdict.artifactDigest = sha256(archive!);
  verdict.archiveBytes = archive!.length;
  if (archive!.length > archiveBytesMax)
    fail("RESOURCE_LIMIT", "archive exceeds the Host archive limit");
  if (
    record.archive.digest !== verdict.artifactDigest ||
    record.archive.bytes !== archive!.length
  )
    fail(
      "INTEGRITY_MISMATCH",
      "archive digest or size differs from the signed release record",
    );
  if (failures.size) return finish();
  // One version, one identity: changed bytes under a recorded version are refused before anything is unpacked.
  const installed = host.installedVersions?.get(
    installedVersionKey(record.runtimeId, record.version),
  );
  if (
    installed &&
    (installed.artifactDigest !== verdict.artifactDigest ||
      installed.releaseRecordDigest !== verdict.releaseRecordDigest)
  )
    fail(
      "INTEGRITY_MISMATCH",
      `version ${record.version} of ${record.runtimeId} is already installed with a different archive or release record (archive ${installed.artifactDigest.slice(0, 12)}); changed bytes need a new version number`,
    );
  if (failures.size) return finish();
  let members: TarMember[];
  try {
    members = readTar(archive!);
  } catch (error) {
    fail("INTEGRITY_MISMATCH", "archive: " + (error as Error).message);
    return finish();
  }
  if (
    record.limits.membersMax > membersCeiling ||
    record.limits.expandedBytesMax > expandedBytesCeiling
  )
    fail("RESOURCE_LIMIT", "release limits exceed the Host ceiling");
  if (members.length > record.limits.membersMax)
    fail("RESOURCE_LIMIT", `member count ${members.length} exceeds membersMax`);
  const seen = new Set<string>();
  let expanded = 0;
  for (const member of members) {
    if (member.type !== "0") {
      fail(
        "INTEGRITY_MISMATCH",
        `member ${member.name} is not a regular file (type ${member.type}${member.linkname ? " -> " + member.linkname : ""})`,
      );
      continue;
    }
    if (!validRelativePath(member.name)) {
      fail(
        "INTEGRITY_MISMATCH",
        `member ${member.name} escapes the bundle root`,
      );
      continue;
    }
    if (seen.has(member.name)) {
      fail("INTEGRITY_MISMATCH", `duplicate member path ${member.name}`);
      continue;
    }
    seen.add(member.name);
    expanded += member.size;
    verdict.members.set(member.name, { data: member.data, mode: member.mode });
  }
  verdict.expandedBytes = expanded;
  if (expanded > record.limits.expandedBytesMax)
    fail(
      "RESOURCE_LIMIT",
      `expanded size ${expanded} exceeds expandedBytesMax`,
    );
  const listed = new Map(record.files.map((f) => [f.path, f]));
  if (listed.size !== record.files.length)
    fail("INTEGRITY_MISMATCH", "duplicate path in the signed file list");
  for (const [name, member] of verdict.members) {
    const entry = listed.get(name);
    if (!entry)
      fail(
        "INTEGRITY_MISMATCH",
        `member ${name} is not in the signed file list`,
      );
    else if (
      entry.bytes !== member.data.length ||
      entry.sha256 !== sha256(member.data) ||
      entry.mode !== member.mode
    )
      fail(
        "INTEGRITY_MISMATCH",
        `member ${name} bytes, digest or mode differ from the signed file list`,
      );
  }
  for (const name of listed.keys())
    if (!verdict.members.has(name))
      fail(
        "INTEGRITY_MISMATCH",
        `listed file ${name} is missing from the archive`,
      );
  verdict.checkedFiles = verdict.members.size;
  if (failures.size) return finish();
  // 4. Manifest member: digest, structure, agreement with the record.
  const manifestMember = verdict.members.get("manifest.json");
  if (!manifestMember) {
    fail("INTEGRITY_MISMATCH", "manifest.json missing");
    return finish();
  }
  verdict.manifestDigest = sha256(manifestMember.data);
  if (
    verdict.manifestDigest !== record.manifest.digest ||
    manifestMember.data.length !== record.manifest.bytes
  )
    fail(
      "INTEGRITY_MISMATCH",
      "manifest digest or size differs from the signed release record",
    );
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestMember.data.toString("utf8"));
  } catch {
    fail("INTEGRITY_MISMATCH", "manifest is not JSON");
    return finish();
  }
  const manifestIssues = manifestProblems(manifestValue);
  for (const p of manifestIssues) fail("INTEGRITY_MISMATCH", "manifest: " + p);
  if (failures.size) return finish();
  const manifest = manifestValue as Manifest;
  verdict.manifest = manifest;
  for (const [field, a, b] of [
    ["runtimeId", manifest.runtimeId, record.runtimeId],
    ["publisher", manifest.publisher, record.publisher.id],
    ["version", manifest.version, record.version],
    ["platform", manifest.platform, record.platform],
    ["dataFormat", manifest.dataFormat, record.dataFormat],
    [
      "permissionProfileDigest",
      manifest.permissionProfileDigest,
      record.permissionProfileDigest,
    ],
  ] as const)
    if (a !== b)
      fail(
        "INTEGRITY_MISMATCH",
        `${field} differs between manifest and release record`,
      );
  const depKey = (d: { id: string; version: string; digest: string }) =>
    `${d.id}@${d.version}#${d.digest}`;
  const manifestDeps = new Set(manifest.dependencies.map(depKey));
  const recordDeps = new Set(record.dependencies.map(depKey));
  if (
    manifestDeps.size !== recordDeps.size ||
    [...manifestDeps].some((d) => !recordDeps.has(d))
  )
    fail(
      "INTEGRITY_MISMATCH",
      "dependencies differ between manifest and release record",
    );
  if (!verdict.members.has(manifest.entrypoint))
    fail("INTEGRITY_MISMATCH", "manifest entrypoint is not a bundle member");
  // 5. Launch configuration member bound by permissionProfileDigest.
  const launchMember = verdict.members.get("launch.json");
  if (!launchMember) fail("INTEGRITY_MISMATCH", "launch.json missing");
  else if (sha256(launchMember.data) !== manifest.permissionProfileDigest)
    fail(
      "INTEGRITY_MISMATCH",
      "launch.json digest differs from permissionProfileDigest",
    );
  else {
    let launchValue: unknown;
    try {
      launchValue = JSON.parse(launchMember.data.toString("utf8"));
    } catch {
      launchValue = null;
    }
    const issues = launchProblems(launchValue);
    for (const p of issues) fail("INTEGRITY_MISMATCH", p);
    if (!issues.length) {
      const launch = launchValue as LaunchConfiguration;
      if (
        launch.entrypoint !== manifest.entrypoint ||
        canonicalJson(launch.argv) !== canonicalJson(manifest.argv)
      )
        fail(
          "INTEGRITY_MISMATCH",
          "launch configuration entrypoint or argv differ from the manifest",
        );
      if (
        new Set(launch.dependencies.map((d) => depKey(d))).size !==
          manifestDeps.size ||
        launch.dependencies.some((d) => !manifestDeps.has(depKey(d)))
      )
        fail(
          "INTEGRITY_MISMATCH",
          "launch configuration dependencies differ from the manifest",
        );
      verdict.launch = launch;
    }
  }
  // 6. Capability schemas packaged under capabilities/<id>.json with the declared digest.
  for (const capability of manifest.capabilities) {
    const member = verdict.members.get(`capabilities/${capability.id}.json`);
    if (!member) {
      fail(
        "UNSUPPORTED_CAPABILITY",
        `capability ${capability.id} has no packaged schema member`,
      );
      continue;
    }
    // Strict parse, then I-JSON: a document two RFC 8785 implementations could read or
    // digest differently (duplicate key, invalid UTF-8, unpaired surrogate, a number
    // beyond the exact integers) is refused before any digest is compared.
    let schema: unknown;
    try {
      schema = parseJsonDocument(member.data, runtimeLimits);
    } catch (error) {
      fail(
        "UNSUPPORTED_CAPABILITY",
        `capability ${capability.id} schema is not JSON (${(error as Error).message})`,
      );
      continue;
    }
    const canonical = iJsonProblem(schema);
    if (canonical) {
      fail(
        "UNSUPPORTED_CAPABILITY",
        `capability ${capability.id} schema has ${canonical}`,
      );
      continue;
    }
    const digest = digestOf(schema);
    const problem =
      digest !== capability.schemaDigest
        ? "schemaDigest differs from its packaged schema"
        : schemaRefProblems(schema)
          ? "schema uses a non-local $ref"
          : capabilityDocumentProblem(schema);
    if (problem)
      fail("UNSUPPORTED_CAPABILITY", `capability ${capability.id} ${problem}`);
    else
      verdict.capabilitySchemas.set(capability.id, {
        digest,
        bytes: member.data,
      });
  }
  if (failures.size) return finish();
  verdict.identityVerified = true;
  // 7. Compatibility with this Host: platform, OS, protocol, dependencies, launcher.
  const incompatible: string[] = [];
  let incompatibleCode: AdmissionCode = "UNSUPPORTED_VERSION";
  if (manifest.platform !== host.platform || record.platform !== host.platform)
    incompatible.push(
      `platform ${manifest.platform} does not match ${host.platform}`,
    );
  if (!osAtLeast(host.osVersion, manifest.minimumOs))
    incompatible.push(
      `minimumOs ${manifest.minimumOs} is above this system ${host.osVersion}`,
    );
  if (
    !manifest.protocols.some(
      (p) =>
        p.version === contractVersion && p.contractDigest === contractDigest,
    )
  )
    incompatible.push(
      "manifest does not offer Contract 0.1.0 at the frozen contractDigest",
    );
  if (manifest.dependencies.length)
    incompatible.push(
      "dependencies are not provided; the Host does not complete them from the development machine",
    );
  if (needsResourceHandle(manifest.argv))
    incompatible.push(
      "argv template uses ${resourceHandle}; this Host starts one instance per installation before any resource is registered, so it has no resource handle to pass at launch",
    );
  const entry = verdict.members.get(manifest.entrypoint)!;
  const launcher = verdict.launch
    ? resolveLauncher(verdict.launch.launcher, host, entry.mode === "0755")
    : { identity: null, reasons: ["launch configuration invalid"] };
  if (!launcher.identity) {
    incompatible.push(...launcher.reasons);
    incompatibleCode = "UNSUPPORTED_VERSION";
  }
  verdict.launcher = launcher.identity;
  if (incompatible.length)
    verdict.incompatibility = { code: incompatibleCode, reasons: incompatible };
  verdict.code = verdict.incompatibility?.code ?? null;
  verdict.reasons = verdict.incompatibility?.reasons ?? [];
  return verdict;
}
/**
 * Whether a schema value holds a key anywhere below it. Like schemaRefProblems this
 * does not tell keywords from property names, so a property literally named $ref or
 * $id is refused too (fail closed).
 */
function holdsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => holdsKey(v, key));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([k, v]) => k === key || holdsKey(v, key));
}
/**
 * OD-425 R2: a payload schema under a capability document's root `definitions` stands
 * alone, without $ref and without a nested $id; "" when it does.
 */
export function selfContainedProblem(entry: unknown): string {
  if (!isRecord(entry)) return "is not a schema object";
  for (const key of ["$ref", "$id"])
    if (holdsKey(entry, key)) return `is not self-contained: it holds ${key}`;
  return "";
}
/**
 * OD-425 R3: the payload schemas a capability document carries under its root
 * `definitions` (R1 locates an action's schema there by digest). Each entry is
 * self-contained (R2) and every entry digest is unique, so one digest names at most
 * one schema. An entry's digest also differs from the document's own: the entry is a
 * strict part of the document, so its canonical JSON is strictly shorter and equal
 * digests would be a SHA-256 collision.
 */
function capabilityDocumentProblem(schema: unknown): string {
  if (!isRecord(schema) || !("definitions" in schema)) return "";
  const definitions = schema.definitions;
  if (!isRecord(definitions))
    return "definitions is not an object of named schemas (OD-425 R3)";
  const seen = new Map<string, string>();
  for (const [name, entry] of Object.entries(definitions)) {
    const alone = selfContainedProblem(entry);
    if (alone) return `definitions entry ${name} ${alone} (OD-425 R2, R3)`;
    const entryDigest = digestOf(entry);
    const other = seen.get(entryDigest);
    if (other !== undefined)
      return `definitions entries ${other} and ${name} have the same digest (OD-425 R3)`;
    seen.set(entryDigest, name);
  }
  return "";
}
/** Only local "#/..." references may appear inside a capability schema. */
function schemaRefProblems(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(schemaRefProblems);
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && (!isString(child) || !child.startsWith("#/")))
      return true;
    if (schemaRefProblems(child)) return true;
  }
  return false;
}

/** Package root layout under the per-user runtime root (${runtimeRoot}). */
export function packageDir(
  runtimeRoot: string,
  runtimeId: string,
  artifactDigest: string,
) {
  return join(
    runtimeRoot,
    "packages",
    runtimeId.replace(/[^A-Za-z0-9._-]/g, "_"),
    artifactDigest,
  );
}
/** Unpacks a verified, compatible bundle into an immutable package directory (atomic rename). */
export function installPackage(
  verdict: AdmissionVerdict,
  runtimeRoot: string,
  sourceDir: string,
) {
  if (
    !verdict.identityVerified ||
    verdict.incompatibility ||
    !verdict.release ||
    !verdict.manifest
  )
    throw new Error("refusing to install an unverified or incompatible bundle");
  const target = packageDir(
    runtimeRoot,
    verdict.release.runtimeId,
    verdict.artifactDigest,
  );
  if (existsSync(target)) return target;
  const staging = join(
    runtimeRoot,
    "staging",
    verdict.artifactDigest + "-" + process.pid,
  );
  rmSync(staging, { recursive: true, force: true });
  try {
    for (const [name, member] of verdict.members) {
      const path = join(staging, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, member.data, {
        mode: member.mode === "0755" ? 0o755 : 0o644,
      });
    }
    mkdirSync(join(staging, ".install"), { recursive: true });
    writeFileSync(
      join(staging, ".install", "files.json"),
      JSON.stringify(
        {
          artifactDigest: verdict.artifactDigest,
          releaseRecordDigest: verdict.releaseRecordDigest,
          files: verdict.release.files,
        },
        null,
        1,
      ),
    );
    writeFileSync(
      join(staging, ".install", "release.json"),
      readFileSync(join(sourceDir, "release.json")),
    );
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staging, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return target;
}
/** Re-verifies the installed package bytes against its signed file list before any launch. */
export function verifyInstalledPackage(dir: string): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!existsSync(join(dir, ".install", "files.json")))
    return {
      ok: false,
      reasons: ["package directory or its install listing is missing"],
    };
  let listing: { files: ReleaseRecord["files"] };
  try {
    listing = JSON.parse(
      readFileSync(join(dir, ".install", "files.json"), "utf8"),
    );
  } catch {
    return { ok: false, reasons: ["install listing is unreadable"] };
  }
  for (const file of listing.files) {
    const path = join(dir, file.path);
    if (!existsSync(path)) reasons.push("missing " + file.path);
    else if (sha256(readFileSync(path)) !== file.sha256)
      reasons.push("digest mismatch " + file.path);
  }
  return { ok: reasons.length === 0, reasons };
}
export const isAdmissionCode = (value: string): value is AdmissionCode =>
  admissionCodes.includes(value as AdmissionCode);
export type { Capability as RuntimeCapability };
