/**
 * Shared contract of the Runtime Host (feature-t29): the identity of the frozen
 * Runtime Contract 0.1.0, the persisted records the business service keeps for
 * installations and instances, and the extension card state derived from them.
 * Wire-level objects follow docs/design/runtime-contract-v0/schema.json; only the
 * subset the Host consumes is typed here, unknown fields are never accepted.
 */

/** Contract 0.1.0 is draft.5 frozen byte for byte (OD-307); the wire version string stays. */
import {
  executionEventKinds,
  validHostExecutionRecord,
  validRuntimeRoleBinding,
  type ExecutionEventKind,
  type HostExecutionRecord,
  type RuntimeRoleBinding,
} from "./runtime-execution";

export const contractVersion = "0.1.0-draft.5";
/** SHA-256 of docs/design/runtime-contract-v0/contract-manifest.json; a unit test pins it. */
export const contractDigest =
  "9d6e6af19a39cc52d0b86f7ce610b44d4b21517feebecf5d88df05f73b83a352";
export const hostPlatform = "darwin-arm64";

/** Design-verification profile of the Contract "传输与消息边界" table. */
export interface RuntimeLimits {
  frameBytes: number;
  depth: number;
  members: number;
  inFlight: number;
  bufferBytes: number;
  eventWindow: number;
  pageObjects: number;
  textCharacters: number;
}
export const runtimeLimits: RuntimeLimits = {
  frameBytes: 1_048_576,
  depth: 32,
  members: 1000,
  inFlight: 32,
  bufferBytes: 4_194_304,
  eventWindow: 128,
  pageObjects: 100,
  textCharacters: 65_536,
};
/** Initialize and ordinary RPC answers: a timeout is a transport result, not a domain outcome. */
export const rpcTimeoutMs = 10_000;
export const healthIntervalMs = 30_000;
/** Diagnostics (stderr) retention per instance directory. */
export const diagnosticsRetainDays = 7;
export const diagnosticsRetainBytes = 50 * 1024 * 1024;

export interface Protocol {
  version: string;
  contractDigest: string;
}
export interface Capability {
  id: string;
  version: string;
  schemaDigest: string;
  required: boolean;
}
export interface ExecutionProfileRef {
  id: string;
  version: string;
  digest: string;
}
export interface ProfileRequirement {
  capabilityId: string;
  profile: ExecutionProfileRef;
}
export interface Context {
  protocolVersion: string;
  contractDigest: string;
  controlGeneration: string;
  installationId: string;
  instanceId: string;
  incarnationId: string;
  connectionId: string;
}
/** Manifest member of a bundle; every field is required by the Contract schema. */
export interface Manifest {
  manifestVersion: string;
  runtimeId: string;
  publisher: string;
  version: string;
  entrypoint: string;
  argv: string[];
  platform: string;
  minimumOs: string;
  protocols: Protocol[];
  capabilities: Capability[];
  permissionProfileDigest: string;
  executionProfileRequirements: ProfileRequirement[];
  dataFormat: string;
  dependencies: { id: string; version: string; digest: string }[];
}
/** Launcher closed set of the bundle's launch configuration (launch.json member). */
export type Launcher = "direct" | "electron-node" | "python3";
export const launchers: Launcher[] = ["direct", "electron-node", "python3"];
/** Closed set of argv template placeholders (Contract RC-02). */
export const argvPlaceholders = [
  "${runtimeRoot}",
  "${instanceDir}",
  "${contractDigest}",
  "${resourceHandle}",
] as const;
export interface LaunchConfiguration {
  schema: "csthink-runtime-launch/v1";
  entrypoint: string;
  argv: string[];
  environmentAllowList: string[];
  dependencies: { id: string; version: string; digest: string }[];
  launcher: Launcher;
  trustModel: "current-user";
}
/** Program identity of the launcher actually used (Contract ProgramIdentity). */
export interface ProgramIdentity {
  launcher: string;
  binaryDigest: string;
  version: string;
}

/** Host-side admission outcome codes; they are records, not wire error frames. */
export type AdmissionCode =
  | "INVALID_SOURCE"
  | "INTEGRITY_MISMATCH"
  | "UNSUPPORTED_VERSION"
  | "UNSUPPORTED_CAPABILITY"
  | "RESOURCE_LIMIT";
export const admissionCodes: AdmissionCode[] = [
  "INVALID_SOURCE",
  "INTEGRITY_MISMATCH",
  "UNSUPPORTED_VERSION",
  "UNSUPPORTED_CAPABILITY",
  "RESOURCE_LIMIT",
];
export const admissionCodeLabels: Record<AdmissionCode, string> = {
  INVALID_SOURCE: "来源签名或发布者不可信",
  INTEGRITY_MISMATCH: "包内容与发布记录不一致",
  UNSUPPORTED_VERSION: "平台、系统或协议版本不匹配",
  UNSUPPORTED_CAPABILITY: "能力声明与包内 schema 不一致",
  RESOURCE_LIMIT: "超过包体积或成员数量上限",
};

/**
 * A verified installation. Only bundles whose identity verified (signature, file
 * list, manifest) are recorded; a platform or protocol mismatch is still recorded
 * so the card can show the incompatibility instead of an installable entry.
 */
export interface RuntimeInstallation {
  installationId: string;
  runtimeId: string;
  version: string;
  publisherId: string;
  publicKeyDigest: string;
  artifactDigest: string;
  releaseRecordDigest: string;
  manifestDigest: string;
  permissionProfileDigest: string;
  platform: string;
  minimumOs: string;
  dataFormat: string;
  protocols: Protocol[];
  capabilities: Capability[];
  executionProfileRequirements: ProfileRequirement[];
  launcher: ProgramIdentity;
  /** Bundle-relative entrypoint and the argv template with placeholders unexpanded. */
  entrypoint: string;
  argv: string[];
  source: { kind: "offline-import"; reference: string };
  /** Verified identity but not usable here: platform, OS or protocol mismatch. */
  incompatibility: { code: AdmissionCode; reasons: string[] } | null;
  checkedFiles: number;
  expandedBytes: number;
  importedAt: string;
}

export interface LaunchDirectories {
  runtimeRoot: string;
  packageDir: string;
  instanceDir: string;
}
export type InstanceState =
  "stopped" | "starting" | "ready" | "failed" | "exited";
export type HealthResult = "ok" | "degraded" | "failed" | "timeout";
export interface RuntimeInstance {
  instanceId: string;
  installationId: string;
  createdAt: string;
  state: InstanceState;
  incarnationId: string | null;
  connectionId: string | null;
  controlGeneration: string | null;
  pid: number | null;
  startedAt: string | null;
  /** Placeholder-expanded argv actually passed to the process (launch record). */
  launchArgv: string[];
  /**
   * Directories of the latest launch as the Host resolved them (Contract: the expanded
   * placeholder values go into the Host launch record): the per-user runtime root
   * (${runtimeRoot}), the installed package directory and this instance's directory
   * (${instanceDir}). Absent until the first launch; records written before
   * feature-t31 S-06 have none (OD-412: the receiving machine reads them here).
   */
  launchDirectories?: LaunchDirectories;
  exit: { code: number | null; signal: string | null; at: string } | null;
  negotiation: {
    selectedProtocol: Protocol;
    capabilities: Capability[];
    executionProfiles: ExecutionProfileRef[];
    limits: RuntimeLimits;
  } | null;
  /** Why the instance is not ready: negotiation refusal, transport loss or exit. */
  failure: { code: string; message: string; at: string } | null;
  health: { result: HealthResult; reason: string; at: string } | null;
  updatedAt: string;
}

export type ExtensionState =
  | "not-installed"
  | "available"
  | "connection-error"
  | "incompatible"
  | "unverified";
export const extensionStateLabels: Record<ExtensionState, string> = {
  "not-installed": "未安装",
  available: "可用",
  "connection-error": "连接异常",
  incompatible: "版本不兼容",
  unverified: "待核实",
};
export const healthResultLabels: Record<HealthResult, string> = {
  ok: "正常",
  degraded: "降级",
  failed: "失败",
  timeout: "超时",
};
const incompatibleCodes = new Set<string>([
  "UNSUPPORTED_VERSION",
  "UNSUPPORTED_CAPABILITY",
  "INTEGRITY_MISMATCH",
]);
/** The part of a scope record the card state derivation reads. */
export interface ScopeHealth {
  scopeRef: string;
  state: "active" | "inactive";
  freshness: "missing" | "syncing" | "current" | "stale";
  lastError: { code: string; message: string; at: string } | null;
}
/**
 * Card state from the real records: admission incompatibility, negotiation refusal,
 * process or transport loss, a health check that has not completed or failed, and,
 * once the process is healthy, an authorized scope whose projection is not current
 * (still resuming after a reconnect, or stale). Preferences never enter this
 * derivation (RUNTIME-01).
 */
export function extensionState(
  installation: RuntimeInstallation,
  instance: RuntimeInstance | undefined,
  scopes: ScopeHealth[] = [],
): { state: ExtensionState; reason: string } {
  if (installation.incompatibility)
    return {
      state: "incompatible",
      reason: installation.incompatibility.reasons.join("；"),
    };
  if (!instance) return { state: "unverified", reason: "尚未启动可用性检查" };
  if (instance.failure && incompatibleCodes.has(instance.failure.code))
    return { state: "incompatible", reason: instance.failure.message };
  if (instance.state === "exited" || instance.state === "failed")
    return {
      state: "connection-error",
      reason: instance.failure?.message ?? "进程已退出",
    };
  if (instance.state === "stopped")
    return { state: "connection-error", reason: "进程未运行" };
  if (instance.state === "starting")
    return { state: "unverified", reason: "正在协商，尚未完成健康检查" };
  if (!instance.health)
    return { state: "unverified", reason: "健康检查尚未完成" };
  if (instance.health.result !== "ok")
    return {
      state:
        instance.health.result === "degraded"
          ? "unverified"
          : "connection-error",
      reason:
        "健康检查" +
        healthResultLabels[instance.health.result] +
        (instance.health.reason ? "：" + instance.health.reason : ""),
    };
  // Only authorized scopes are expected to be current; an unauthorized scope keeps its old projection.
  const behind = scopes.find(
    (s) =>
      s.state === "active" &&
      (s.freshness === "syncing" || s.freshness === "stale"),
  );
  if (behind)
    return {
      state: "unverified",
      reason:
        behind.freshness === "syncing"
          ? behind.scopeRef + " 的项目投影正在同步，尚未取得完整状态"
          : behind.scopeRef +
            " 的项目投影已过期" +
            (behind.lastError
              ? "（" +
                behind.lastError.code +
                "：" +
                behind.lastError.message +
                "）"
              : ""),
    };
  return { state: "available", reason: "" };
}

export interface RuntimeSnapshot {
  runtimeInstallations: RuntimeInstallation[];
  runtimeInstances: RuntimeInstance[];
  runtimeResources: RuntimeResource[];
  runtimeScopes: RuntimeScope[];
  runtimeGrants: RuntimeGrant[];
  /** Newest first, bounded per instance. */
  runtimeOperations: RuntimeOperation[];
  /** Newest first, bounded per instance; the store keeps every record. */
  runtimeDecisions: RuntimeDecision[];
  runtimeContextSnapshots: RuntimeContextSnapshot[];
  /** Physical Agent executions, newest first, bounded per instance (feature-t30). */
  runtimeExecutions: HostExecutionRecord[];
}

/** Host commands the supervisor reports to the business service (single SQLite writer). */
export type RuntimeHostCommand =
  | { type: "runtimeInstall"; installation: RuntimeInstallation }
  | { type: "runtimeInstanceUpsert"; instance: RuntimeInstance }
  | RuntimeHostCommand2;
/** Renderer-triggered control of an instance, mediated by the main process. */
export type RuntimeControl =
  | { type: "reconnect"; instanceId: string }
  | { type: "reverify"; instanceId: string }
  | { type: "revokeGrant"; instanceId: string; grantId: string }
  /** Revokes every grant of one authorization at once (访问权限, after confirmation). */
  | { type: "revokeGrants"; instanceId: string; grantIds: string[] }
  /** The stop-unconfirmed pending item's only action: one more observation of the escaped processes (feature-t30). */
  | { type: "recheckExecution"; executionRef: string };
export type RuntimeImportReply =
  | {
      ok: true;
      installationId: string;
      incompatible: boolean;
      /** The same version with the same bytes was already recorded: nothing new was installed. */
      existing: boolean;
      /**
       * first-use: no key was pinned for this runtimeId, so this import pinned the key it
       * carried (KB-278 item 7); pinned: the key matched the one already pinned.
       */
      publisherPin: "first-use" | "pinned";
      publicKeyDigest: string;
    }
  | {
      ok: false;
      code: AdmissionCode | "CANCELLED" | "UNAVAILABLE";
      reasons: string[];
    };

const idPattern = /^[A-Za-z0-9:._-]{1,200}$/;
const digestPattern = /^[0-9a-f]{64}$/;
function isString(value: unknown): value is string {
  return typeof value === "string";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function validProtocol(value: unknown): value is Protocol {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    isString(value.version) &&
    isString(value.contractDigest) &&
    digestPattern.test(value.contractDigest)
  );
}
export function validCapability(value: unknown): value is Capability {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    isString(value.id) &&
    idPattern.test(value.id) &&
    isString(value.version) &&
    isString(value.schemaDigest) &&
    digestPattern.test(value.schemaDigest) &&
    typeof value.required === "boolean"
  );
}
export function validProfileRef(value: unknown): value is ExecutionProfileRef {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    isString(value.id) &&
    isString(value.version) &&
    isString(value.digest) &&
    digestPattern.test(value.digest)
  );
}
export function validContext(value: unknown): value is Context {
  if (!isRecord(value)) return false;
  const keys = [
    "protocolVersion",
    "contractDigest",
    "controlGeneration",
    "installationId",
    "instanceId",
    "incarnationId",
    "connectionId",
  ];
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => isString(value[key]) && value[key] !== "")
  );
}
export function sameContext(a: Context, b: Context) {
  return (
    a.protocolVersion === b.protocolVersion &&
    a.contractDigest === b.contractDigest &&
    a.controlGeneration === b.controlGeneration &&
    a.installationId === b.installationId &&
    a.instanceId === b.instanceId &&
    a.incarnationId === b.incarnationId &&
    a.connectionId === b.connectionId
  );
}
export function validRuntimeLimits(value: unknown): value is RuntimeLimits {
  if (!isRecord(value)) return false;
  const keys = Object.keys(runtimeLimits);
  return (
    Object.keys(value).length === keys.length &&
    keys.every(
      (key) => Number.isSafeInteger(value[key]) && (value[key] as number) > 0,
    )
  );
}
/** Structural check of a persisted installation record before the service stores it. */
export function validRuntimeInstallation(
  value: unknown,
): value is RuntimeInstallation {
  if (!isRecord(value)) return false;
  const strings = [
    "installationId",
    "runtimeId",
    "version",
    "publisherId",
    "publicKeyDigest",
    "artifactDigest",
    "releaseRecordDigest",
    "manifestDigest",
    "permissionProfileDigest",
    "platform",
    "minimumOs",
    "dataFormat",
    "entrypoint",
    "importedAt",
  ];
  if (!strings.every((key) => isString(value[key]) && value[key] !== ""))
    return false;
  if (!idPattern.test(value.installationId as string)) return false;
  const launcher = value.launcher;
  if (
    !isRecord(launcher) ||
    !isString(launcher.launcher) ||
    !isString(launcher.binaryDigest) ||
    !isString(launcher.version)
  )
    return false;
  const source = value.source;
  if (
    !isRecord(source) ||
    source.kind !== "offline-import" ||
    !isString(source.reference)
  )
    return false;
  const incompatibility = value.incompatibility;
  if (
    incompatibility !== null &&
    (!isRecord(incompatibility) ||
      !admissionCodes.includes(incompatibility.code as AdmissionCode) ||
      !Array.isArray(incompatibility.reasons) ||
      !incompatibility.reasons.every(isString))
  )
    return false;
  return (
    Array.isArray(value.protocols) &&
    value.protocols.every(validProtocol) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every(validCapability) &&
    Array.isArray(value.executionProfileRequirements) &&
    value.executionProfileRequirements.every(
      (r) =>
        isRecord(r) && isString(r.capabilityId) && validProfileRef(r.profile),
    ) &&
    Array.isArray(value.argv) &&
    value.argv.every(isString) &&
    Number.isSafeInteger(value.checkedFiles) &&
    Number.isSafeInteger(value.expandedBytes)
  );
}
export function validRuntimeInstance(value: unknown): value is RuntimeInstance {
  if (!isRecord(value)) return false;
  if (
    !isString(value.instanceId) ||
    !idPattern.test(value.instanceId) ||
    !isString(value.installationId) ||
    !isString(value.createdAt) ||
    !isString(value.updatedAt) ||
    !["stopped", "starting", "ready", "failed", "exited"].includes(
      value.state as string,
    )
  )
    return false;
  for (const key of ["incarnationId", "connectionId", "controlGeneration"])
    if (value[key] !== null && !isString(value[key])) return false;
  if (value.pid !== null && !Number.isSafeInteger(value.pid)) return false;
  if (value.startedAt !== null && !isString(value.startedAt)) return false;
  if (!Array.isArray(value.launchArgv) || !value.launchArgv.every(isString))
    return false;
  if (
    value.launchDirectories !== undefined &&
    !validLaunchDirectories(value.launchDirectories)
  )
    return false;
  const exit = value.exit;
  if (
    exit !== null &&
    (!isRecord(exit) ||
      (exit.code !== null && !Number.isSafeInteger(exit.code)) ||
      (exit.signal !== null && !isString(exit.signal)) ||
      !isString(exit.at))
  )
    return false;
  const negotiation = value.negotiation;
  if (
    negotiation !== null &&
    (!isRecord(negotiation) ||
      !validProtocol(negotiation.selectedProtocol) ||
      !Array.isArray(negotiation.capabilities) ||
      !negotiation.capabilities.every(validCapability) ||
      !Array.isArray(negotiation.executionProfiles) ||
      !negotiation.executionProfiles.every(validProfileRef) ||
      !validRuntimeLimits(negotiation.limits))
  )
    return false;
  const failure = value.failure;
  if (
    failure !== null &&
    (!isRecord(failure) ||
      !isString(failure.code) ||
      !isString(failure.message) ||
      !isString(failure.at))
  )
    return false;
  const health = value.health;
  return (
    health === null ||
    (isRecord(health) &&
      ["ok", "degraded", "failed", "timeout"].includes(
        health.result as string,
      ) &&
      isString(health.reason) &&
      isString(health.at))
  );
}
export function validRuntimeHostCommand(
  value: unknown,
): value is RuntimeHostCommand {
  if (!isRecord(value)) return false;
  if (value.type === "runtimeInstall")
    return validRuntimeInstallation(value.installation);
  if (value.type === "runtimeInstanceUpsert")
    return validRuntimeInstance(value.instance);
  return validRuntimeHostCommand2(value);
}
function validLaunchDirectories(value: unknown): value is LaunchDirectories {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    ["runtimeRoot", "packageDir", "instanceDir"].every(
      (key) => isString(value[key]) && (value[key] as string).startsWith("/"),
    )
  );
}
/**
 * A persisted Host fact the renderer asks the main process to copy (OD-412: the
 * receiving machine writes the hp binding file from these). The value is read from
 * the records in the main process, never taken from the renderer.
 */
export type RuntimeCopyTarget =
  | { field: "instanceDir" | "packageDir"; instanceId: string }
  | { field: "publicKeyDigest"; installationId: string }
  | { field: "resourceHandle"; handle: string };
export function validRuntimeCopyTarget(
  value: unknown,
): value is RuntimeCopyTarget {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  if (value.field === "instanceDir" || value.field === "packageDir")
    return isString(value.instanceId) && idPattern.test(value.instanceId);
  if (value.field === "publicKeyDigest")
    return (
      isString(value.installationId) && idPattern.test(value.installationId)
    );
  return value.field === "resourceHandle" && validRef(value.handle);
}
/** The persisted value a copy target names, or null when the records hold none. */
export function runtimeCopyValue(
  records: Pick<
    RuntimeSnapshot,
    "runtimeInstallations" | "runtimeInstances" | "runtimeResources"
  >,
  target: RuntimeCopyTarget,
): string | null {
  if (target.field === "publicKeyDigest")
    return (
      records.runtimeInstallations.find(
        (i) => i.installationId === target.installationId,
      )?.publicKeyDigest ?? null
    );
  if (target.field === "resourceHandle")
    return (
      records.runtimeResources.find((r) => r.handle === target.handle)
        ?.handle ?? null
    );
  const directories = records.runtimeInstances.find(
    (i) => i.instanceId === target.instanceId,
  )?.launchDirectories;
  return directories?.[target.field] ?? null;
}
export function validRuntimeControl(value: unknown): value is RuntimeControl {
  if (!isRecord(value)) return false;
  if (value.type === "recheckExecution")
    return Object.keys(value).length === 2 && validRef(value.executionRef);
  if (!isString(value.instanceId) || !idPattern.test(value.instanceId))
    return false;
  if (value.type === "reconnect" || value.type === "reverify")
    return Object.keys(value).length === 2;
  if (value.type === "revokeGrants")
    return (
      Object.keys(value).length === 3 &&
      Array.isArray(value.grantIds) &&
      value.grantIds.length >= 1 &&
      value.grantIds.length <= 512 &&
      value.grantIds.every((id) => isString(id) && idPattern.test(id)) &&
      new Set(value.grantIds).size === value.grantIds.length
    );
  return (
    value.type === "revokeGrant" &&
    Object.keys(value).length === 3 &&
    isString(value.grantId) &&
    idPattern.test(value.grantId)
  );
}

/**
 * RFC 8785 canonical JSON for the I-JSON subset the Contract allows: object keys
 * sorted by UTF-16 code unit, no whitespace, strings escaped as ECMAScript's
 * JSON.stringify does (quote, backslash and C0 controls only, lower-case hex) and
 * numbers in ECMAScript Number serialization, which RFC 8785 adopts. A non-finite
 * number throws. Outside I-JSON the output is not RFC 8785 (an unpaired surrogate is
 * escaped rather than refused), so a digest another implementation recomputes is
 * taken only over a value that passed iJsonProblem (capability documents at admission,
 * action form input before an Invoke).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(record)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]))
        .join(",") +
      "}"
    );
  }
  if (typeof value === "number" && !Number.isFinite(value))
    throw new TypeError("non-finite number in canonical JSON");
  return JSON.stringify(value);
}

/** An unpaired UTF-16 surrogate: not valid Unicode, so not I-JSON (RFC 7493 section 2.1). */
export function unpairedSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    value,
  );
}
/**
 * Why a value has no RFC 8785 form that every implementation computes alike, or "".
 * RFC 8785 is defined over I-JSON: a string or key with an unpaired surrogate has no
 * canonical form, and the Contract's digest number domain is I-JSON's exact integers
 * (超出精确整数范围的值使用十进制字符串), so a number beyond ±(2^53 - 1), which a
 * parser may already have rounded, is refused as well.
 */
export function iJsonProblem(value: unknown): string {
  if (typeof value === "string")
    return unpairedSurrogate(value)
      ? "a string with an unpaired surrogate, which is not I-JSON (RFC 8785)"
      : "";
  if (typeof value === "number")
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
      ? ""
      : "a number outside ±(2^53 - 1), which has no exact canonical form (RFC 8785, I-JSON)";
  if (Array.isArray(value)) {
    for (const v of value) {
      const problem = iJsonProblem(v);
      if (problem) return problem;
    }
    return "";
  }
  if (value !== null && typeof value === "object")
    for (const [key, v] of Object.entries(value)) {
      const problem = iJsonProblem(key) || iJsonProblem(v);
      if (problem) return problem;
    }
  return "";
}

// ---------------------------------------------------------------- S-02: scopes, projection, operations, grants

export const refPattern = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/;
export const seqPattern = /^(0|[1-9][0-9]*)$/;
export function validRef(value: unknown): value is string {
  return isString(value) && value.length <= 256 && refPattern.test(value);
}
export function validSeq(value: unknown): value is string {
  return isString(value) && value.length <= 32 && seqPattern.test(value);
}
/** Sequence numbers compare numerically; they are decimal strings on the wire. */
export function compareSeq(a: string, b: string) {
  return a.length === b.length
    ? a < b
      ? -1
      : a > b
        ? 1
        : 0
    : a.length - b.length;
}
export function nextSeq(seq: string) {
  return (BigInt(seq) + 1n).toString();
}

export interface GrantRef {
  id: string;
  revision: string;
}
export function validGrantRef(value: unknown): value is GrantRef {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    validRef(value.id) &&
    validSeq(value.revision)
  );
}
/** Contract Grant plus the Host's own bookkeeping. */
export interface RuntimeGrant {
  ref: GrantRef;
  installationId: string;
  instanceId: string;
  scopeRef: string;
  resourceHandle: string;
  capability: string;
  operation: string;
  executionRef: string | null;
  bundleDigest: string;
  expiresAt: string;
  status: "active" | "revoked" | "expired";
  purpose: string;
  createdAt: string;
  revokedAt: string | null;
  /**
   * Host bookkeeping, never on the wire: the grants one reviewed authorization created
   * share it (project access, OD-416), so 访问权限 lists and revokes them as one entry.
   */
  authorizationId?: string;
}
export function validRuntimeGrant(value: unknown): value is RuntimeGrant {
  if (!isRecord(value)) return false;
  if ("authorizationId" in value) {
    if (!validRef(value.authorizationId)) return false;
    const { authorizationId: _a, ...rest } = value;
    void _a;
    return validRuntimeGrant(rest);
  }
  const keys = [
    "ref",
    "installationId",
    "instanceId",
    "scopeRef",
    "resourceHandle",
    "capability",
    "operation",
    "executionRef",
    "bundleDigest",
    "expiresAt",
    "status",
    "purpose",
    "createdAt",
    "revokedAt",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((k) => k in value)
  )
    return false;
  return (
    validGrantRef(value.ref) &&
    validRef(value.installationId) &&
    validRef(value.instanceId) &&
    validRef(value.scopeRef) &&
    validRef(value.resourceHandle) &&
    validRef(value.capability) &&
    validRef(value.operation) &&
    (value.executionRef === null || validRef(value.executionRef)) &&
    isString(value.bundleDigest) &&
    /^[0-9a-f]{64}$/.test(value.bundleDigest) &&
    isString(value.expiresAt) &&
    ["active", "revoked", "expired"].includes(value.status as string) &&
    isString(value.purpose) &&
    isString(value.createdAt) &&
    (value.revokedAt === null || isString(value.revokedAt))
  );
}
/** Wire Grant: the Host's bookkeeping fields never leave the Host. */
export function wireGrant(grant: RuntimeGrant) {
  const { createdAt: _c, revokedAt: _r, authorizationId: _a, ...wire } = grant;
  void _a;
  void _c;
  void _r;
  return wire;
}

export interface RuntimeResource {
  handle: string;
  kind: "directory";
  path: string;
  registeredAt: string;
}
export function validRuntimeResource(value: unknown): value is RuntimeResource {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    validRef(value.handle) &&
    value.kind === "directory" &&
    isString(value.path) &&
    value.path.startsWith("/") &&
    isString(value.registeredAt)
  );
}

export type Freshness = "missing" | "syncing" | "current" | "stale";
export interface StreamCursor {
  streamId: string;
  epoch: string;
  seq: string;
}
/** One scope on one instance: binding, authorization state and the projection sync state. */
export interface RuntimeScope {
  instanceId: string;
  installationId: string;
  scopeRef: string;
  bindingRef: string;
  resourceHandle: string;
  state: "inactive" | "active";
  grantRefs: GrantRef[];
  freshness: Freshness;
  cursor: StreamCursor | null;
  revision: string | null;
  snapshotId: string | null;
  subscriptionId: string | null;
  lastError: { code: string; message: string; at: string } | null;
  updatedAt: string;
  /** Derived by the service at snapshot time; ignored on write. */
  counts?: {
    objects: number;
    actions: number;
    actionsEnabled: number;
    pending: number;
    blocking: number;
  };
}
export function validStreamCursor(value: unknown): value is StreamCursor {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    validRef(value.streamId) &&
    validRef(value.epoch) &&
    validSeq(value.seq)
  );
}
export function validRuntimeScope(value: unknown): value is RuntimeScope {
  if (!isRecord(value)) return false;
  const required = [
    "instanceId",
    "installationId",
    "scopeRef",
    "bindingRef",
    "resourceHandle",
    "state",
    "grantRefs",
    "freshness",
    "cursor",
    "revision",
    "snapshotId",
    "subscriptionId",
    "lastError",
    "updatedAt",
  ];
  if (!required.every((k) => k in value)) return false;
  if (Object.keys(value).some((k) => !required.includes(k) && k !== "counts"))
    return false;
  const lastError = value.lastError;
  return (
    validRef(value.instanceId) &&
    validRef(value.installationId) &&
    validRef(value.scopeRef) &&
    validRef(value.bindingRef) &&
    validRef(value.resourceHandle) &&
    (value.state === "inactive" || value.state === "active") &&
    Array.isArray(value.grantRefs) &&
    value.grantRefs.every(validGrantRef) &&
    ["missing", "syncing", "current", "stale"].includes(
      value.freshness as string,
    ) &&
    (value.cursor === null || validStreamCursor(value.cursor)) &&
    (value.revision === null || validRef(value.revision)) &&
    (value.snapshotId === null || validRef(value.snapshotId)) &&
    (value.subscriptionId === null || validRef(value.subscriptionId)) &&
    (lastError === null ||
      (isRecord(lastError) &&
        isString(lastError.code) &&
        isString(lastError.message) &&
        isString(lastError.at))) &&
    isString(value.updatedAt)
  );
}

export const operationStatuses = [
  "accepted",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
] as const;
export type OperationStatus = (typeof operationStatuses)[number];
/**
 * An operation the Host issued (origin host: persisted before the request is sent) or
 * learned about from the Runtime (origin runtime: operation.changed events, replies).
 */
export interface RuntimeOperation {
  operationId: string;
  installationId: string;
  instanceId: string;
  scopeRef: string;
  method: string;
  origin: "host" | "runtime";
  idempotencyKey: string | null;
  requestDigest: string;
  /** Non-Context request parameters as sent (host origin) or null. */
  request: Record<string, unknown> | null;
  status: OperationStatus;
  resultCode: string | null;
  reason: string;
  resultRef: Record<string, unknown> | null;
  executionRef: string | null;
  revision: string | null;
  /** Host-side receipt for runtime-to-host operations (context capture snapshots, preflight checks). */
  result: Record<string, unknown> | null;
  /** Transport outcome of the Host's own request: sent, answered, lost (no answer), refused (error frame). */
  transport: "sent" | "answered" | "lost" | "refused" | null;
  errorCode: string | null;
  /** The Contract recovery hint of the last refusal (retry-later, query, resync, ...) or null. */
  recovery: Recovery | null;
  createdAt: string;
  updatedAt: string;
}
export const recoveries = [
  "none",
  "resync",
  "query",
  "reauthorize",
  "review",
  "reconnect",
  "retry-later",
] as const;
export type Recovery = (typeof recoveries)[number];
export function validRuntimeOperation(
  value: unknown,
): value is RuntimeOperation {
  if (!isRecord(value)) return false;
  const keys = [
    "operationId",
    "installationId",
    "instanceId",
    "scopeRef",
    "method",
    "origin",
    "idempotencyKey",
    "requestDigest",
    "request",
    "status",
    "resultCode",
    "reason",
    "resultRef",
    "executionRef",
    "revision",
    "result",
    "transport",
    "errorCode",
    "recovery",
    "createdAt",
    "updatedAt",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((k) => k in value)
  )
    return false;
  return (
    validRef(value.operationId) &&
    validRef(value.installationId) &&
    validRef(value.instanceId) &&
    validRef(value.scopeRef) &&
    isString(value.method) &&
    (value.origin === "host" || value.origin === "runtime") &&
    (value.idempotencyKey === null || validRef(value.idempotencyKey)) &&
    isString(value.requestDigest) &&
    /^[0-9a-f]{64}$/.test(value.requestDigest) &&
    (value.request === null || isRecord(value.request)) &&
    operationStatuses.includes(value.status as OperationStatus) &&
    (value.resultCode === null || validRef(value.resultCode)) &&
    isString(value.reason) &&
    (value.resultRef === null || isRecord(value.resultRef)) &&
    (value.executionRef === null || validRef(value.executionRef)) &&
    (value.revision === null || validRef(value.revision)) &&
    (value.result === null || isRecord(value.result)) &&
    (value.transport === null ||
      ["sent", "answered", "lost", "refused"].includes(
        value.transport as string,
      )) &&
    (value.errorCode === null || isString(value.errorCode)) &&
    (value.recovery === null ||
      recoveries.includes(value.recovery as Recovery)) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

/** Wire projection objects the service stores after structural validation. */
export interface ProjectionObject {
  scopeRef: string;
  objectRef: string;
  revision: string;
  title: string;
  stateLabel: string;
  capability: Capability;
  view: Record<string, unknown>;
  evidence: unknown[];
}
export interface ProjectionAction {
  scopeRef: string;
  actionId: string;
  objectRef: string;
  capability: Capability;
  label: string;
  expectedRevision: string;
  candidateRef: string | null;
  payloadSchemaDigest: string;
  enabled: boolean;
  disabledReason: string;
  disabledCode: string | null;
  requiresHumanDecision: boolean;
}
export interface ProjectionPendingItem {
  scopeRef: string;
  itemRef: string;
  revision: string;
  objectRef: string;
  capability: Capability;
  title: string;
  typeId: string;
  typeLabel: string;
  status: "pending" | "processed";
  pendingSince: string;
  updatedAt: string;
  processedAt: string | null;
  blocking: boolean;
  actionIds: string[];
  evidence: unknown[];
}
export interface SnapshotPage {
  scopeRef: string;
  snapshotId: string;
  revision: string;
  streamId: string;
  epoch: string;
  throughSeq: string;
  expiresAt: string;
  objects: ProjectionObject[];
  actions: ProjectionAction[];
  pendingItems: ProjectionPendingItem[];
  nextPageToken: string | null;
}
export const viewKinds = [
  "list",
  "document",
  "graph",
  "diff",
  "trace",
] as const;
const text = (value: unknown, max: number) =>
  isString(value) && value.length <= max;
export function validEvidenceRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 8 &&
    (value.authority === "host" || value.authority === "runtime") &&
    validRef(value.resourceHandle) &&
    validRef(value.scopeRef) &&
    validRef(value.objectRef) &&
    validRef(value.revision) &&
    [
      "text/plain",
      "text/markdown",
      "text/html",
      "application/json",
      "application/octet-stream",
    ].includes(value.mediaType as string) &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) >= 0 &&
    isString(value.digest) &&
    /^[0-9a-f]{64}$/.test(value.digest)
  );
}
function validEvidenceList(value: unknown) {
  return (
    Array.isArray(value) && value.length <= 32 && value.every(validEvidenceRef)
  );
}
/** Views carry no scripts and no write-back; only the five kinds with their fixed fields are accepted. */
export function validView(
  value: unknown,
  limits: RuntimeLimits = runtimeLimits,
): boolean {
  if (!isRecord(value)) return false;
  const rowText = (v: unknown) => text(v, limits.textCharacters);
  switch (value.kind) {
    case "list":
      return (
        Object.keys(value).length === 2 &&
        Array.isArray(value.rows) &&
        value.rows.length <= 100 &&
        value.rows.every(
          (row) =>
            isRecord(row) &&
            Object.keys(row).length === 3 &&
            validRef(row.id) &&
            rowText(row.title) &&
            rowText(row.detail),
        )
      );
    case "document":
      return Object.keys(value).length === 2 && validEvidenceRef(value.content);
    case "graph": {
      if (
        Object.keys(value).length !== 3 ||
        !Array.isArray(value.nodes) ||
        !Array.isArray(value.edges)
      )
        return false;
      if (value.nodes.length > 1000 || value.edges.length > 1000) return false;
      const ids = new Set<string>();
      for (const node of value.nodes) {
        if (
          !isRecord(node) ||
          !validRef(node.id) ||
          !rowText(node.label) ||
          !text(node.stateLabel, 256)
        )
          return false;
        if (
          Object.keys(node).some(
            (k) => !["id", "label", "stateLabel", "kind"].includes(k),
          )
        )
          return false;
        if ("kind" in node && !validRef(node.kind)) return false;
        ids.add(node.id as string);
      }
      return value.edges.every(
        (edge) =>
          isRecord(edge) &&
          Object.keys(edge).every((k) =>
            ["id", "source", "target", "label", "semantics"].includes(k),
          ) &&
          validRef(edge.id) &&
          validRef(edge.source) &&
          validRef(edge.target) &&
          ids.has(edge.source as string) &&
          ids.has(edge.target as string) &&
          text(edge.label, 256) &&
          (!("semantics" in edge) || validRef(edge.semantics)),
      );
    }
    case "diff":
      return (
        Object.keys(value).length === 3 &&
        validEvidenceRef(value.before) &&
        validEvidenceRef(value.after)
      );
    case "trace":
      return (
        Object.keys(value).length === 2 &&
        Array.isArray(value.entries) &&
        value.entries.length <= 1000 &&
        value.entries.every(
          (entry) =>
            isRecord(entry) &&
            Object.keys(entry).every((k) =>
              ["id", "occurredAt", "text", "section"].includes(k),
            ) &&
            validRef(entry.id) &&
            isString(entry.occurredAt) &&
            rowText(entry.text) &&
            (!("section" in entry) || validRef(entry.section)),
        )
      );
    default:
      return false;
  }
}
export function validProjectionObject(
  value: unknown,
  limits?: RuntimeLimits,
): value is ProjectionObject {
  return (
    isRecord(value) &&
    Object.keys(value).length === 8 &&
    validRef(value.scopeRef) &&
    validRef(value.objectRef) &&
    validRef(value.revision) &&
    text(value.title, 1024) &&
    text(value.stateLabel, 256) &&
    validCapability(value.capability) &&
    validView(value.view, limits) &&
    validEvidenceList(value.evidence)
  );
}
export function validProjectionAction(
  value: unknown,
): value is ProjectionAction {
  return (
    isRecord(value) &&
    Object.keys(value).length === 12 &&
    validRef(value.scopeRef) &&
    validRef(value.actionId) &&
    validRef(value.objectRef) &&
    validCapability(value.capability) &&
    text(value.label, 256) &&
    validRef(value.expectedRevision) &&
    (value.candidateRef === null || validRef(value.candidateRef)) &&
    isString(value.payloadSchemaDigest) &&
    /^[0-9a-f]{64}$/.test(value.payloadSchemaDigest) &&
    typeof value.enabled === "boolean" &&
    text(value.disabledReason, 2048) &&
    (value.disabledCode === null || validRef(value.disabledCode)) &&
    (value.enabled || value.disabledCode !== null) &&
    typeof value.requiresHumanDecision === "boolean"
  );
}
export function validProjectionPendingItem(
  value: unknown,
): value is ProjectionPendingItem {
  return (
    isRecord(value) &&
    Object.keys(value).length === 15 &&
    validRef(value.scopeRef) &&
    validRef(value.itemRef) &&
    validRef(value.revision) &&
    validRef(value.objectRef) &&
    validCapability(value.capability) &&
    text(value.title, 1024) &&
    validRef(value.typeId) &&
    text(value.typeLabel, 256) &&
    (value.status === "pending" || value.status === "processed") &&
    isString(value.pendingSince) &&
    isString(value.updatedAt) &&
    (value.processedAt === null || isString(value.processedAt)) &&
    typeof value.blocking === "boolean" &&
    (value.status !== "processed" ||
      (value.processedAt !== null && value.blocking === false)) &&
    Array.isArray(value.actionIds) &&
    value.actionIds.length <= 32 &&
    value.actionIds.every(validRef) &&
    validEvidenceList(value.evidence)
  );
}
export function validSnapshotPage(
  value: unknown,
  limits: RuntimeLimits = runtimeLimits,
): value is SnapshotPage {
  if (!isRecord(value)) return false;
  const keys = [
    "scopeRef",
    "snapshotId",
    "revision",
    "streamId",
    "epoch",
    "throughSeq",
    "expiresAt",
    "objects",
    "actions",
    "pendingItems",
    "nextPageToken",
  ];
  if (
    !keys.every((k) => k in value) ||
    Object.keys(value).some((k) => !keys.includes(k) && k !== "context")
  )
    return false;
  if (
    !Array.isArray(value.objects) ||
    !Array.isArray(value.actions) ||
    !Array.isArray(value.pendingItems)
  )
    return false;
  if (
    value.objects.length + value.actions.length + value.pendingItems.length >
    limits.pageObjects
  )
    return false;
  return (
    validRef(value.scopeRef) &&
    validRef(value.snapshotId) &&
    validRef(value.revision) &&
    validRef(value.streamId) &&
    validRef(value.epoch) &&
    validSeq(value.throughSeq) &&
    isString(value.expiresAt) &&
    value.objects.every((o) => validProjectionObject(o, limits)) &&
    value.actions.every(validProjectionAction) &&
    value.pendingItems.every(validProjectionPendingItem) &&
    (value.nextPageToken === null || validRef(value.nextPageToken))
  );
}

export type ProjectionEventKind =
  | "object.upsert"
  | "object.remove"
  | "action.upsert"
  | "action.remove"
  | "pending.upsert"
  | "pending.remove"
  | "operation.changed";
export interface ProjectionEvent {
  subscriptionId: string;
  eventId: string;
  scopeRef: string;
  streamId: string;
  epoch: string;
  seq: string;
  domainRevision: string;
  causationId: string | null;
  kind: ProjectionEventKind;
  payload: Record<string, unknown>;
}
export interface CaughtUpEvent {
  kind: "stream.caughtUp";
  subscriptionId: string;
  scopeRef: string;
  streamId: string;
  epoch: string;
  throughSeq: string;
}
/** Wire Operation object (runtime.operation.get result, operation.changed payload, invoke result). */
export interface WireOperation {
  operationId: string;
  scopeRef: string;
  requestDigest: string;
  status: OperationStatus;
  resultRef: Record<string, unknown> | null;
  executionRef: string | null;
  reason: string;
  resultCode: string | null;
  revision: string;
}
export function validWireOperation(value: unknown): value is WireOperation {
  return (
    isRecord(value) &&
    Object.keys(value).every((k) =>
      [
        "operationId",
        "scopeRef",
        "requestDigest",
        "status",
        "resultRef",
        "executionRef",
        "reason",
        "resultCode",
        "revision",
        "context",
      ].includes(k),
    ) &&
    validRef(value.operationId) &&
    validRef(value.scopeRef) &&
    isString(value.requestDigest) &&
    /^[0-9a-f]{64}$/.test(value.requestDigest) &&
    operationStatuses.includes(value.status as OperationStatus) &&
    (value.resultRef === null || validEvidenceRef(value.resultRef)) &&
    (value.executionRef === null || validRef(value.executionRef)) &&
    text(value.reason, 2048) &&
    (value.resultCode === null || validRef(value.resultCode)) &&
    (!["accepted", "running"].includes(value.status as string) ||
      value.resultCode === null) &&
    validRef(value.revision)
  );
}
export function validCaughtUpEvent(value: unknown): value is CaughtUpEvent {
  return (
    isRecord(value) &&
    value.kind === "stream.caughtUp" &&
    Object.keys(value).length === 6 &&
    validRef(value.subscriptionId) &&
    validRef(value.scopeRef) &&
    validRef(value.streamId) &&
    validRef(value.epoch) &&
    validSeq(value.throughSeq)
  );
}
export function validProjectionEvent(
  value: unknown,
  limits?: RuntimeLimits,
): value is ProjectionEvent {
  if (!isRecord(value) || Object.keys(value).length !== 10) return false;
  if (
    !validRef(value.subscriptionId) ||
    !validRef(value.eventId) ||
    !validRef(value.scopeRef) ||
    !validRef(value.streamId) ||
    !validRef(value.epoch) ||
    !validSeq(value.seq) ||
    !validRef(value.domainRevision) ||
    !(value.causationId === null || validRef(value.causationId)) ||
    !isRecord(value.payload)
  )
    return false;
  const payload = value.payload;
  switch (value.kind) {
    case "object.upsert":
      return (
        validProjectionObject(payload, limits) &&
        payload.scopeRef === value.scopeRef
      );
    case "action.upsert":
      return (
        validProjectionAction(payload) && payload.scopeRef === value.scopeRef
      );
    case "pending.upsert":
      return (
        validProjectionPendingItem(payload) &&
        payload.scopeRef === value.scopeRef
      );
    case "object.remove":
      return Object.keys(payload).length === 1 && validRef(payload.objectRef);
    case "action.remove":
      return Object.keys(payload).length === 1 && validRef(payload.actionId);
    case "pending.remove":
      return Object.keys(payload).length === 1 && validRef(payload.itemRef);
    case "operation.changed":
      return validWireOperation(payload);
    default:
      return false;
  }
}
/** A Host-private immutable copy of runtime evidence made for one domain operation (host.context.capture). */
export interface RuntimeContextSnapshot {
  handle: string;
  instanceId: string;
  installationId: string;
  scopeRef: string;
  operationId: string;
  domainOperationId: string;
  /** The runtime evidence it was copied from; the snapshot inherits its authorization constraints. */
  source: Record<string, unknown>;
  objectRef: string;
  revision: string;
  mediaType: string;
  bytes: number;
  digest: string;
  /** Path relative to the runtime root's context directory. */
  file: string;
  createdAt: string;
}
export function validRuntimeContextSnapshot(
  value: unknown,
): value is RuntimeContextSnapshot {
  return (
    isRecord(value) &&
    Object.keys(value).length === 14 &&
    validRef(value.handle) &&
    validRef(value.instanceId) &&
    validRef(value.installationId) &&
    validRef(value.scopeRef) &&
    validRef(value.operationId) &&
    validRef(value.domainOperationId) &&
    validEvidenceRef(value.source) &&
    validRef(value.objectRef) &&
    validRef(value.revision) &&
    isString(value.mediaType) &&
    Number.isSafeInteger(value.bytes) &&
    isString(value.digest) &&
    /^[0-9a-f]{64}$/.test(value.digest) &&
    isString(value.file) &&
    !value.file.includes("..") &&
    isString(value.createdAt)
  );
}
/**
 * Contract DecisionRecord plus the Host's bookkeeping: an immutable record of a human
 * decision made through a trusted Host entry, bound to the exact Invoke it authorizes.
 * Revocation appends a status; the confirmed content never changes.
 */
export interface RuntimeDecision {
  decisionRef: string;
  installationId: string;
  instanceId: string;
  scopeRef: string;
  /** Equals the operationId of the Invoke the decision authorizes. */
  domainOperationId: string;
  method: "runtime.action.invoke";
  requestDigest: string;
  actionId: string;
  objectRef: string;
  candidateRef: string | null;
  expectedRevision: string;
  /** The fixed EvidenceRefs the actor actually viewed. */
  evidence: Record<string, unknown>[];
  actorRef: string;
  source: "host-trusted-ui";
  recordedAt: string;
  status: "valid" | "revoked";
  revokedAt: string | null;
}
export function validRuntimeDecision(value: unknown): value is RuntimeDecision {
  if (!isRecord(value)) return false;
  const keys = [
    "decisionRef",
    "installationId",
    "instanceId",
    "scopeRef",
    "domainOperationId",
    "method",
    "requestDigest",
    "actionId",
    "objectRef",
    "candidateRef",
    "expectedRevision",
    "evidence",
    "actorRef",
    "source",
    "recordedAt",
    "status",
    "revokedAt",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((k) => k in value)
  )
    return false;
  return (
    validRef(value.decisionRef) &&
    validRef(value.installationId) &&
    validRef(value.instanceId) &&
    validRef(value.scopeRef) &&
    validRef(value.domainOperationId) &&
    value.method === "runtime.action.invoke" &&
    isString(value.requestDigest) &&
    digestPattern.test(value.requestDigest) &&
    validRef(value.actionId) &&
    validRef(value.objectRef) &&
    (value.candidateRef === null || validRef(value.candidateRef)) &&
    validRef(value.expectedRevision) &&
    Array.isArray(value.evidence) &&
    value.evidence.length <= 32 &&
    value.evidence.every(validEvidenceRef) &&
    validRef(value.actorRef) &&
    value.source === "host-trusted-ui" &&
    isString(value.recordedAt) &&
    (value.status === "valid" || value.status === "revoked") &&
    (value.revokedAt === null || isString(value.revokedAt)) &&
    (value.status === "revoked") === (value.revokedAt !== null)
  );
}
/** Wire DecisionRecord (host.decision.get result): the Host's bookkeeping never leaves the Host. */
export function wireDecision(decision: RuntimeDecision) {
  const {
    installationId: _i,
    instanceId: _n,
    revokedAt: _r,
    ...wire
  } = decision;
  void _i;
  void _n;
  void _r;
  return wire;
}

/** Contract UpgradeState as the Runtime answers runtime.upgrade.prepare and runtime.upgrade.get. */
export interface UpgradeState {
  operationId: string;
  requestDigest: string;
  sourceBundleDigest: string;
  targetBundleDigest: string;
  sourceDataFormat: string;
  targetDataFormat: string;
  status: "prepared" | "blocked" | "released" | "unknown";
  barrierRef: string | null;
  domainRevision: string;
  preparedGeneration: string;
  protectedReferences: {
    scopeRef: string;
    objectRef: string;
    revision: string;
    reason: string;
  }[];
  reason: string;
  releasedDomainRevision?: string | null;
}
export function validUpgradeState(value: unknown): value is UpgradeState {
  if (!isRecord(value)) return false;
  const keys = [
    "operationId",
    "requestDigest",
    "sourceBundleDigest",
    "targetBundleDigest",
    "sourceDataFormat",
    "targetDataFormat",
    "status",
    "barrierRef",
    "domainRevision",
    "preparedGeneration",
    "protectedReferences",
    "reason",
  ];
  if (
    !keys.every((k) => k in value) ||
    !Object.keys(value).every(
      (k) =>
        keys.includes(k) || k === "releasedDomainRevision" || k === "context",
    )
  )
    return false;
  const status = value.status as UpgradeState["status"];
  return (
    validRef(value.operationId) &&
    isString(value.requestDigest) &&
    digestPattern.test(value.requestDigest) &&
    isString(value.sourceBundleDigest) &&
    digestPattern.test(value.sourceBundleDigest) &&
    isString(value.targetBundleDigest) &&
    digestPattern.test(value.targetBundleDigest) &&
    validRef(value.sourceDataFormat) &&
    validRef(value.targetDataFormat) &&
    ["prepared", "blocked", "released", "unknown"].includes(status) &&
    (value.barrierRef === null || validRef(value.barrierRef)) &&
    validRef(value.domainRevision) &&
    validSeq(value.preparedGeneration) &&
    Array.isArray(value.protectedReferences) &&
    value.protectedReferences.length <= 1000 &&
    value.protectedReferences.every(
      (r) =>
        isRecord(r) &&
        Object.keys(r).length === 4 &&
        validRef(r.scopeRef) &&
        validRef(r.objectRef) &&
        validRef(r.revision) &&
        isString(r.reason) &&
        r.reason.length <= 2048,
    ) &&
    isString(value.reason) &&
    value.reason.length <= 2048 &&
    (!("releasedDomainRevision" in value) ||
      value.releasedDomainRevision === null ||
      validRef(value.releasedDomainRevision)) &&
    // prepared carries a barrier and no protected reference; blocked carries no barrier; released names the revision.
    (status !== "prepared" ||
      (value.barrierRef !== null &&
        (value.protectedReferences as unknown[]).length === 0)) &&
    (status !== "blocked" || value.barrierRef === null) &&
    (status !== "released" || validRef(value.releasedDomainRevision))
  );
}

export type EventOutcome =
  "applied" | "duplicate" | "conflict" | "gap" | "epoch" | "no-projection";
export interface RuntimeProjection {
  objects: ProjectionObject[];
  actions: ProjectionAction[];
  pendingItems: ProjectionPendingItem[];
}
/** Authoritative lookup of one operation by id or by its dedupe key (the snapshot is bounded, the store is not). */
export interface OperationKey {
  scopeRef: string;
  method: string;
  idempotencyKey: string;
}

export type RuntimeHostCommand2 =
  | { type: "runtimeResourceRegister"; resource: RuntimeResource }
  | { type: "runtimeScopeUpsert"; scope: RuntimeScope }
  | {
      type: "runtimeProjectionReplace";
      instanceId: string;
      scopeRef: string;
      pages: SnapshotPage[];
    }
  | {
      type: "runtimeEventApply";
      instanceId: string;
      scopeRef: string;
      event: ProjectionEvent;
    }
  | {
      type: "runtimeCaughtUp";
      instanceId: string;
      scopeRef: string;
      streamId: string;
      epoch: string;
      throughSeq: string;
    }
  | { type: "runtimeOperationUpsert"; operation: RuntimeOperation }
  | { type: "runtimeGrantUpsert"; grant: RuntimeGrant }
  /** One authorization (or one revocation) of several grants, written in one transaction: all or none. */
  | { type: "runtimeGrantBatch"; grants: RuntimeGrant[] }
  | { type: "runtimeContextSnapshotUpsert"; snapshot: RuntimeContextSnapshot }
  | { type: "runtimeProjectionRead"; instanceId: string; scopeRef: string }
  /** The decision record and the Invoke it authorizes commit in one transaction, before the Invoke is sent. */
  | {
      type: "runtimeDecisionRecord";
      decision: RuntimeDecision;
      operation: RuntimeOperation;
    }
  | {
      type: "runtimeDecisionRevoke";
      instanceId: string;
      decisionRef: string;
      revokedAt: string;
    }
  | {
      type: "runtimeOperationRead";
      instanceId: string;
      operationId: string | null;
      key: OperationKey | null;
    }
  | { type: "runtimeDecisionRead"; instanceId: string; decisionRef: string }
  /** Every operation of the instance with one of the methods (empty: any); open keeps only unresolved ones. */
  | {
      type: "runtimeOperationList";
      instanceId: string;
      methods: string[];
      open: boolean;
    }
  /**
   * One physical execution transition (feature-t30): the record, the start/cancel
   * operation that moves with it, the run event to append and the pending item to open
   * or resolve commit in one transaction; the first upsert creates the business
   * `executions` row the events and pending items hang on.
   */
  | {
      type: "runtimeExecutionUpsert";
      record: HostExecutionRecord;
      operation: RuntimeOperation | null;
      event: {
        kind: ExecutionEventKind;
        payload: Record<string, unknown>;
      } | null;
      pending: "open" | "resolve" | null;
    }
  | { type: "runtimeExecutionRead"; executionRef: string }
  /** Executions of one instance (null: every instance); open keeps the non-terminal ones. */
  | { type: "runtimeExecutionList"; instanceId: string | null; open: boolean }
  | { type: "runtimeRoleBindingUpsert"; binding: RuntimeRoleBinding }
  | {
      type: "runtimeRoleBindingRead";
      instanceId: string;
      scopeRef: string;
      roleIntent: string;
    };
/** Read-only runtime host commands: answered from the store without a write transaction. */
export const runtimeReadCommands = [
  "runtimeProjectionRead",
  "runtimeOperationRead",
  "runtimeDecisionRead",
  "runtimeOperationList",
  "runtimeExecutionRead",
  "runtimeExecutionList",
  "runtimeRoleBindingRead",
] as const;
export function validRuntimeHostCommand2(
  value: unknown,
): value is RuntimeHostCommand2 {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "runtimeDecisionRecord":
      return (
        Object.keys(value).length === 3 &&
        validRuntimeDecision(value.decision) &&
        validRuntimeOperation(value.operation)
      );
    case "runtimeDecisionRevoke":
      return (
        Object.keys(value).length === 4 &&
        validRef(value.instanceId) &&
        validRef(value.decisionRef) &&
        isString(value.revokedAt)
      );
    case "runtimeOperationRead":
      return (
        Object.keys(value).length === 4 &&
        validRef(value.instanceId) &&
        (value.operationId === null || validRef(value.operationId)) &&
        (value.key === null ||
          (isRecord(value.key) &&
            Object.keys(value.key).length === 3 &&
            validRef(value.key.scopeRef) &&
            isString(value.key.method) &&
            validRef(value.key.idempotencyKey))) &&
        (value.operationId !== null || value.key !== null)
      );
    case "runtimeDecisionRead":
      return (
        Object.keys(value).length === 3 &&
        validRef(value.instanceId) &&
        validRef(value.decisionRef)
      );
    case "runtimeOperationList":
      return (
        Object.keys(value).length === 4 &&
        validRef(value.instanceId) &&
        Array.isArray(value.methods) &&
        value.methods.length <= 8 &&
        value.methods.every(isString) &&
        typeof value.open === "boolean"
      );
    case "runtimeResourceRegister":
      return (
        Object.keys(value).length === 2 && validRuntimeResource(value.resource)
      );
    case "runtimeScopeUpsert":
      return Object.keys(value).length === 2 && validRuntimeScope(value.scope);
    case "runtimeProjectionReplace":
      return (
        Object.keys(value).length === 4 &&
        validRef(value.instanceId) &&
        validRef(value.scopeRef) &&
        Array.isArray(value.pages) &&
        value.pages.length > 0 &&
        value.pages.every((p) => validSnapshotPage(p))
      );
    case "runtimeEventApply":
      return (
        Object.keys(value).length === 4 &&
        validRef(value.instanceId) &&
        validRef(value.scopeRef) &&
        validProjectionEvent(value.event)
      );
    case "runtimeCaughtUp":
      return (
        Object.keys(value).length === 6 &&
        validRef(value.instanceId) &&
        validRef(value.scopeRef) &&
        validRef(value.streamId) &&
        validRef(value.epoch) &&
        validSeq(value.throughSeq)
      );
    case "runtimeOperationUpsert":
      return (
        Object.keys(value).length === 2 &&
        validRuntimeOperation(value.operation)
      );
    case "runtimeGrantUpsert":
      return Object.keys(value).length === 2 && validRuntimeGrant(value.grant);
    case "runtimeGrantBatch":
      return (
        Object.keys(value).length === 2 &&
        Array.isArray(value.grants) &&
        value.grants.length >= 1 &&
        value.grants.length <= 512 &&
        value.grants.every(validRuntimeGrant) &&
        new Set(value.grants.map((g) => (g as RuntimeGrant).ref.id)).size ===
          value.grants.length
      );
    case "runtimeContextSnapshotUpsert":
      return (
        Object.keys(value).length === 2 &&
        validRuntimeContextSnapshot(value.snapshot)
      );
    case "runtimeProjectionRead":
      return (
        Object.keys(value).length === 3 &&
        validRef(value.instanceId) &&
        validRef(value.scopeRef)
      );
    case "runtimeExecutionUpsert":
      return (
        Object.keys(value).length === 5 &&
        validHostExecutionRecord(value.record) &&
        (value.operation === null || validRuntimeOperation(value.operation)) &&
        (value.event === null ||
          (isRecord(value.event) &&
            Object.keys(value.event).length === 2 &&
            executionEventKinds.includes(
              value.event.kind as ExecutionEventKind,
            ) &&
            isRecord(value.event.payload))) &&
        (value.pending === null ||
          value.pending === "open" ||
          value.pending === "resolve")
      );
    case "runtimeExecutionRead":
      return Object.keys(value).length === 2 && validRef(value.executionRef);
    case "runtimeExecutionList":
      return (
        Object.keys(value).length === 3 &&
        (value.instanceId === null || validRef(value.instanceId)) &&
        typeof value.open === "boolean"
      );
    case "runtimeRoleBindingUpsert":
      return (
        Object.keys(value).length === 2 &&
        validRuntimeRoleBinding(value.binding)
      );
    case "runtimeRoleBindingRead":
      return (
        Object.keys(value).length === 4 &&
        validRef(value.instanceId) &&
        validRef(value.scopeRef) &&
        validRef(value.roleIntent)
      );
    default:
      return false;
  }
}
