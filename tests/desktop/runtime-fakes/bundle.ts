/**
 * Test-only bundle builder: writes a ustar archive, the release record of the
 * candidate schema, an Ed25519 signature and the publisher key into a directory.
 * The signing key lives only in the calling test process; nothing here ships.
 */
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  contractDigest,
  contractVersion,
  type Capability,
  type LaunchConfiguration,
  type Manifest,
} from "../../../src/shared/runtime-host";

export const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const digestOf = (value: unknown) => sha256(canonicalJson(value));

export interface Member {
  name: string;
  data: Buffer;
  mode?: "0644" | "0755";
  /** Test injection: write a symlink or hard link entry instead of a regular file. */
  type?: "0" | "2" | "1";
  linkname?: string;
}
function header(member: Member) {
  const block = Buffer.alloc(512, 0);
  const write = (offset: number, length: number, value: string) =>
    block.write(value.slice(0, length), offset, "utf8");
  let name = member.name;
  let prefix = "";
  if (name.length > 100) {
    const cut = name.lastIndexOf("/", 155);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  write(0, 100, name);
  write(100, 8, (member.mode === "0755" ? "0000755" : "0000644") + "\0");
  write(108, 8, "0000000\0");
  write(116, 8, "0000000\0");
  write(124, 12, member.data.length.toString(8).padStart(11, "0") + "\0");
  write(136, 12, "00000000000\0");
  block.write("        ", 148, "utf8");
  block[156] = (member.type ?? "0").charCodeAt(0);
  write(157, 100, member.linkname ?? "");
  write(257, 6, "ustar\0");
  write(263, 2, "00");
  write(345, 155, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  return block;
}
export function writeTar(members: Member[]): Buffer {
  const blocks: Buffer[] = [];
  for (const member of members) {
    blocks.push(header(member));
    if (member.type && member.type !== "0") continue;
    blocks.push(member.data);
    const pad = (512 - (member.data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

export interface Publisher {
  id: string;
  privateKey: KeyObject;
  publicKeyPem: string;
  publicKeyDigest: string;
}
export function newPublisher(id = "publisher:csthink-test"): Publisher {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    id,
    privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    publicKeyDigest: sha256(
      publicKey.export({ type: "spki", format: "der" }) as Buffer,
    ),
  };
}

export interface BundleSpec {
  runtimeId: string;
  version: string;
  entrypoint: string;
  entrypointBytes: Buffer;
  entrypointMode?: "0644" | "0755";
  launcher: LaunchConfiguration["launcher"];
  argv: string[];
  /** `bytes` packages exact member bytes (strict-parse and I-JSON cases) instead of `schema`'s JSON. */
  capabilities: { capability: Capability; schema: unknown; bytes?: Buffer }[];
  extraMembers?: Member[];
  dataFormat?: string;
  platform?: string;
  minimumOs?: string;
  protocols?: Manifest["protocols"];
  dependencies?: Manifest["dependencies"];
  executionProfileRequirements?: Manifest["executionProfileRequirements"];
  /** Mutates the launch configuration before hashing (test injection). */
  launchOverride?: (launch: LaunchConfiguration) => LaunchConfiguration;
  /** Mutates the manifest before hashing (test injection); the record is built from the result. */
  manifestOverride?: (manifest: Manifest) => Manifest;
  membersMax?: number;
  expandedBytesMax?: number;
}
export interface BuiltBundle {
  dir: string;
  archive: Buffer;
  release: Record<string, unknown>;
  releaseBytes: Buffer;
  manifest: Manifest;
  members: Member[];
  artifactDigest: string;
}
/** Builds the members, record and signature; `mutate` lets a test tamper with the pieces before writing. */
export function buildBundle(
  dir: string,
  publisher: Publisher,
  spec: BundleSpec,
  mutate: {
    members?: (members: Member[]) => Member[];
    release?: (release: Record<string, unknown>) => Record<string, unknown>;
    signWith?: KeyObject;
    signature?: (signature: string) => string;
    publisherPem?: string;
  } = {},
): BuiltBundle {
  const launchBase: LaunchConfiguration = {
    schema: "csthink-runtime-launch/v1",
    entrypoint: spec.entrypoint,
    argv: spec.argv,
    environmentAllowList: ["PATH", "HOME", "PYTHONDONTWRITEBYTECODE"],
    dependencies: spec.dependencies ?? [],
    launcher: spec.launcher,
    trustModel: "current-user",
  };
  const launch = spec.launchOverride
    ? spec.launchOverride(launchBase)
    : launchBase;
  const launchBytes = Buffer.from(JSON.stringify(launch, null, 1));
  const manifestBase: Manifest = {
    manifestVersion: contractVersion,
    runtimeId: spec.runtimeId,
    publisher: publisher.id,
    version: spec.version,
    entrypoint: spec.entrypoint,
    argv: spec.argv,
    platform: spec.platform ?? "darwin-arm64",
    minimumOs: spec.minimumOs ?? "26.6.2",
    protocols: spec.protocols ?? [{ version: contractVersion, contractDigest }],
    capabilities: spec.capabilities.map((c) => c.capability),
    permissionProfileDigest: sha256(launchBytes),
    executionProfileRequirements: spec.executionProfileRequirements ?? [],
    dataFormat: spec.dataFormat ?? "test.f1",
    dependencies: spec.dependencies ?? [],
  };
  const manifest = spec.manifestOverride
    ? spec.manifestOverride(manifestBase)
    : manifestBase;
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 1));
  let members: Member[] = [
    { name: "manifest.json", data: manifestBytes },
    { name: "launch.json", data: launchBytes },
    {
      name: spec.entrypoint,
      data: spec.entrypointBytes,
      mode: spec.entrypointMode ?? "0644",
    },
    ...spec.capabilities.map((c) => ({
      name: `capabilities/${c.capability.id}.json`,
      data: c.bytes ?? Buffer.from(JSON.stringify(c.schema)),
    })),
    ...(spec.extraMembers ?? []),
  ];
  const listed = members.map((m) => ({
    path: m.name,
    bytes: m.data.length,
    sha256: sha256(m.data),
    mode: m.mode ?? ("0644" as const),
  }));
  if (mutate.members) members = mutate.members(members);
  const archive = writeTar(members);
  let release: Record<string, unknown> = {
    schema: "csthink-runtime-release/v1-candidate",
    runtimeId: manifest.runtimeId,
    publisher: {
      id: publisher.id,
      signatureAlgorithm: "ed25519",
      publicKeyDigest: publisher.publicKeyDigest,
    },
    version: manifest.version,
    platform: manifest.platform,
    dataFormat: manifest.dataFormat,
    archive: {
      digest: sha256(archive),
      bytes: archive.length,
      format: "ustar",
    },
    manifest: {
      path: "manifest.json",
      digest: sha256(manifestBytes),
      bytes: manifestBytes.length,
    },
    files: listed,
    limits: {
      expandedBytesMax: spec.expandedBytesMax ?? 64 * 1024 * 1024,
      membersMax: spec.membersMax ?? 512,
    },
    dependencies: manifest.dependencies,
    permissionProfileDigest: manifest.permissionProfileDigest,
    maintenance: null,
    source: {
      kind: "offline-import",
      reference: "tests/desktop/runtime-fakes",
    },
  };
  if (mutate.release) release = mutate.release(release);
  const releaseBytes = Buffer.from(JSON.stringify(release, null, 1));
  let signature = sign(
    null,
    releaseBytes,
    mutate.signWith ?? publisher.privateKey,
  ).toString("hex");
  if (mutate.signature) signature = mutate.signature(signature);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bundle.tar"), archive);
  writeFileSync(join(dir, "release.json"), releaseBytes);
  writeFileSync(join(dir, "release.sig"), signature + "\n");
  writeFileSync(
    join(dir, "publisher.pub"),
    mutate.publisherPem ?? publisher.publicKeyPem,
  );
  return {
    dir,
    archive,
    release,
    releaseBytes,
    manifest,
    members,
    artifactDigest: sha256(archive),
  };
}
