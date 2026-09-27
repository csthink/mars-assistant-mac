/**
 * Physical Agent execution records shared by the main process (embedded execution port),
 * the business service (single SQLite writer) and the renderer (feature-t30). A
 * HostExecutionRecord is the Contract `PhysicalExecution` plus the Host facts behind it:
 * the registered target and descendant identities, release and cancel times, the exit
 * classification, the session parameters actually passed, the stop-unconfirmed fact and
 * the operations it blocks (RUNTIME-04, LOG-01).
 */
import { refPattern, seqPattern } from "./runtime-host";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const validRef = (value: unknown): value is string =>
  isString(value) && value.length <= 256 && refPattern.test(value);
const isDigest = (value: unknown): value is string =>
  isString(value) && /^[0-9a-f]{64}$/.test(value);
const isInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

export const physicalStates = [
  "queued",
  "reserved",
  "running",
  "stopping",
  "stopped",
  "completed",
  "failed",
  "unknown",
] as const;
export type PhysicalState = (typeof physicalStates)[number];
export const terminalPhysicalStates: PhysicalState[] = [
  "stopped",
  "completed",
  "failed",
  "unknown",
];
export const stopReasons = [
  "cancelled",
  "timeout",
  "tool-call-budget",
  "output-limit",
  "signal",
] as const;
export type StopReason = (typeof stopReasons)[number];
/** Operations a stop-unconfirmed execution blocks until the target's descendants are gone (RUNTIME-04). */
export const blockedOperations = [
  "release-resource",
  "switch-entry",
  "upgrade-extension",
  "update-application",
] as const;
export type BlockedOperation = (typeof blockedOperations)[number];
export const blockedOperationLabels: Record<BlockedOperation, string> = {
  "release-resource": "释放资源",
  "switch-entry": "切换入口",
  "upgrade-extension": "扩展升级",
  "update-application": "应用更新",
};
/** Contract ProcessIdentity. */
export interface ContractProcessIdentity {
  pid: number;
  startTime: string;
  image: string;
}
export interface ExecutionAccounting {
  toolCalls: number;
  runSeconds: number;
  outputBytes: number;
  waited: boolean;
  pidGoneAfterExit: boolean;
}
export interface ProcessExit {
  code: number | null;
  signal: string | null;
  pipesClosed: boolean;
}
export interface ActualBinding {
  model: string;
  source: "protocol-init" | "protocol-result" | "adapter-report";
  observedModels: string[];
}
export interface HostEvidenceRef {
  authority: "host";
  resourceHandle: string;
  scopeRef: string;
  objectRef: string;
  revision: string;
  mediaType:
    | "text/plain"
    | "text/markdown"
    | "text/html"
    | "application/json"
    | "application/octet-stream";
  bytes: number;
  digest: string;
}
/** Contract PhysicalExecution (without Context). */
export interface PhysicalExecution {
  executionRef: string;
  scopeRef: string;
  state: PhysicalState;
  connectionRef: string;
  configurationRevision: string;
  model: string;
  requestIdentity: {
    operationId: string;
    requestDigest: string;
    profileDigest: string;
  };
  supervisor: ContractProcessIdentity | null;
  approvalDecisionRefs: string[];
  actualBinding: ActualBinding | null;
  stopReason: StopReason | null;
  accounting: ExecutionAccounting | null;
  exit: ProcessExit | null;
  observationCompleteness: "complete" | "partial" | "unknown";
  resultRef: HostEvidenceRef | null;
  reason: string;
}
/** A registered process: the identity tuple plus its placement when registered. */
export interface RegisteredProcessIdentity {
  pid: number;
  uid: number;
  startSeconds: number;
  startMicros: number;
  path: string;
  parent: number;
  group: number;
  session: number;
  registeredAt: string;
}
/** A process seen under the target that could not be registered (another uid, KB-213); never signalled. */
export interface UnregisteredObservation {
  pid: number;
  uid: number;
  parent: number;
  observedAt: string;
}
export interface EscapedProcess {
  identity: ContractProcessIdentity;
  session: number;
  kind: "registered" | "unregistered";
}
/** The stop-unconfirmed Host fact (RUNTIME-04): the target exited, registered descendants outside its session live on. */
export interface StopUnconfirmed {
  since: string;
  targetIdentity: ContractProcessIdentity;
  escaped: EscapedProcess[];
  /** Explicit rechecks (the pending item's action) on top of the Host's own periodic checks. */
  checks: number;
  lastCheckedAt: string;
  resolvedAt: string | null;
}
export interface ExecutionBudget {
  maxToolCalls: number;
  maxRunSeconds: number;
  maxOutputBytes: number;
  cleanupSeconds: number;
}
export const exitClassifications = [
  "exited",
  "signaled",
  "zombie",
  "eperm",
  "pid-reused",
  "observer-lost",
  "children-remaining",
] as const;
export type ExitClassification = (typeof exitClassifications)[number];
/** Human-facing names of the exit classifications (the task's 退出分类 list). */
export const exitClassificationLabels: Record<ExitClassification, string> = {
  exited: "正常退出",
  signaled: "信号退出",
  zombie: "僵尸待回收",
  eperm: "观察被拒绝（EPERM）",
  "pid-reused": "PID 复用",
  "observer-lost": "观察器失联",
  "children-remaining": "尚存子进程",
};
export const stopReasonLabels: Record<StopReason, string> = {
  cancelled: "已取消",
  timeout: "时长超限",
  "tool-call-budget": "工具调用超限",
  "output-limit": "输出超限",
  signal: "信号",
};
export interface HostExecutionRecord extends PhysicalExecution {
  installationId: string;
  instanceId: string;
  operationId: string;
  portId: string;
  profileId: string;
  roleIntent: string;
  domainNodeRef: string;
  domainOperationId: string;
  resourceHandle: string;
  targetBinding: { resourceHandle: string; relativePath: string } | null;
  /** The Agent named by the execution binding (J-04 tuple), as requested. */
  agent: string;
  /** The product connection behind connectionRef, when it exists. */
  connectionId: string | null;
  /** The business `executions` row that carries this execution's run events and pending items. */
  executionId: string;
  target: RegisteredProcessIdentity | null;
  children: RegisteredProcessIdentity[];
  unregisteredObservations: UnregisteredObservation[];
  releasedAt: string | null;
  cancelRequestedAt: string | null;
  exitClassification: ExitClassification | null;
  /** Reasoning effort level passed as a session parameter; null means none was passed ("未记录"). */
  effort: string | null;
  budget: ExecutionBudget;
  stopUnconfirmed: StopUnconfirmed | null;
  blockedOperations: BlockedOperation[];
  /** Digest of the shared observation record directory path (never the path itself). */
  recordLocator: string | null;
  createdAt: string;
  updatedAt: string;
}
export const hostExecutionKeys = [
  "executionRef",
  "scopeRef",
  "state",
  "connectionRef",
  "configurationRevision",
  "model",
  "requestIdentity",
  "supervisor",
  "approvalDecisionRefs",
  "actualBinding",
  "stopReason",
  "accounting",
  "exit",
  "observationCompleteness",
  "resultRef",
  "reason",
  "installationId",
  "instanceId",
  "operationId",
  "portId",
  "profileId",
  "roleIntent",
  "domainNodeRef",
  "domainOperationId",
  "resourceHandle",
  "targetBinding",
  "agent",
  "connectionId",
  "executionId",
  "target",
  "children",
  "unregisteredObservations",
  "releasedAt",
  "cancelRequestedAt",
  "exitClassification",
  "effort",
  "budget",
  "stopUnconfirmed",
  "blockedOperations",
  "recordLocator",
  "createdAt",
  "updatedAt",
] as const;
export const physicalExecutionKeys = hostExecutionKeys.slice(0, 16);

export function validContractIdentity(
  value: unknown,
): value is ContractProcessIdentity {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    isInt(value.pid) &&
    isString(value.startTime) &&
    isString(value.image) &&
    value.image.length <= 1024
  );
}
export function validRegisteredIdentity(
  value: unknown,
): value is RegisteredProcessIdentity {
  return (
    isRecord(value) &&
    Object.keys(value).length === 9 &&
    isInt(value.pid) &&
    isInt(value.uid) &&
    isInt(value.startSeconds) &&
    isInt(value.startMicros) &&
    isString(value.path) &&
    isInt(value.parent) &&
    isInt(value.group) &&
    Number.isSafeInteger(value.session) &&
    isString(value.registeredAt)
  );
}
export function validHostEvidenceRef(value: unknown): value is HostEvidenceRef {
  return (
    isRecord(value) &&
    Object.keys(value).length === 8 &&
    value.authority === "host" &&
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
    isInt(value.bytes) &&
    isDigest(value.digest)
  );
}
function validAccounting(value: unknown): value is ExecutionAccounting {
  return (
    isRecord(value) &&
    Object.keys(value).length === 5 &&
    isInt(value.toolCalls) &&
    isInt(value.runSeconds) &&
    isInt(value.outputBytes) &&
    typeof value.waited === "boolean" &&
    typeof value.pidGoneAfterExit === "boolean"
  );
}
function validExit(value: unknown): value is ProcessExit {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    (value.code === null || (isInt(value.code) && value.code <= 255)) &&
    (value.signal === null ||
      (isString(value.signal) && value.signal.length <= 32)) &&
    typeof value.pipesClosed === "boolean"
  );
}
function validActualBinding(value: unknown): value is ActualBinding {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    isString(value.model) &&
    value.model.length > 0 &&
    value.model.length <= 256 &&
    ["protocol-init", "protocol-result", "adapter-report"].includes(
      value.source as string,
    ) &&
    Array.isArray(value.observedModels) &&
    value.observedModels.length <= 8 &&
    value.observedModels.every(
      (m) => isString(m) && m.length > 0 && m.length <= 256,
    )
  );
}
function validStopUnconfirmed(value: unknown): value is StopUnconfirmed {
  return (
    isRecord(value) &&
    Object.keys(value).length === 6 &&
    isString(value.since) &&
    validContractIdentity(value.targetIdentity) &&
    Array.isArray(value.escaped) &&
    value.escaped.length <= 64 &&
    value.escaped.every(
      (e) =>
        isRecord(e) &&
        Object.keys(e).length === 3 &&
        validContractIdentity(e.identity) &&
        Number.isSafeInteger(e.session) &&
        (e.kind === "registered" || e.kind === "unregistered"),
    ) &&
    isInt(value.checks) &&
    isString(value.lastCheckedAt) &&
    (value.resolvedAt === null || isString(value.resolvedAt))
  );
}
export function validExecutionBudget(value: unknown): value is ExecutionBudget {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    isInt(value.maxToolCalls) &&
    value.maxToolCalls >= 1 &&
    value.maxToolCalls <= 20 &&
    isInt(value.maxRunSeconds) &&
    value.maxRunSeconds >= 1 &&
    value.maxRunSeconds <= 600 &&
    isInt(value.maxOutputBytes) &&
    value.maxOutputBytes >= 1 &&
    value.maxOutputBytes <= 16777216 &&
    isInt(value.cleanupSeconds) &&
    value.cleanupSeconds >= 1 &&
    value.cleanupSeconds <= 60
  );
}
/**
 * Structural validity plus the Contract's state conditions: stopped needs a stopReason,
 * queued/reserved/running/completed have none; queued/reserved have no binding, accounting
 * or exit; completed has an exit; unknown is never observed completely.
 */
export function validHostExecutionRecord(
  value: unknown,
): value is HostExecutionRecord {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).length !== hostExecutionKeys.length ||
    !hostExecutionKeys.every((k) => k in value)
  )
    return false;
  const state = value.state as PhysicalState;
  const structural =
    validRef(value.executionRef) &&
    validRef(value.scopeRef) &&
    physicalStates.includes(state) &&
    validRef(value.connectionRef) &&
    isString(value.configurationRevision) &&
    seqPattern.test(value.configurationRevision) &&
    validRef(value.model) &&
    isRecord(value.requestIdentity) &&
    Object.keys(value.requestIdentity).length === 3 &&
    validRef(value.requestIdentity.operationId) &&
    isDigest(value.requestIdentity.requestDigest) &&
    isDigest(value.requestIdentity.profileDigest) &&
    (value.supervisor === null || validContractIdentity(value.supervisor)) &&
    Array.isArray(value.approvalDecisionRefs) &&
    value.approvalDecisionRefs.length <= 32 &&
    value.approvalDecisionRefs.every(validRef) &&
    (value.actualBinding === null || validActualBinding(value.actualBinding)) &&
    (value.stopReason === null ||
      stopReasons.includes(value.stopReason as StopReason)) &&
    (value.accounting === null || validAccounting(value.accounting)) &&
    (value.exit === null || validExit(value.exit)) &&
    ["complete", "partial", "unknown"].includes(
      value.observationCompleteness as string,
    ) &&
    (value.resultRef === null || validHostEvidenceRef(value.resultRef)) &&
    isString(value.reason) &&
    value.reason.length <= 2048 &&
    validRef(value.installationId) &&
    validRef(value.instanceId) &&
    validRef(value.operationId) &&
    validRef(value.portId) &&
    validRef(value.profileId) &&
    validRef(value.roleIntent) &&
    validRef(value.domainNodeRef) &&
    validRef(value.domainOperationId) &&
    validRef(value.resourceHandle) &&
    (value.targetBinding === null ||
      (isRecord(value.targetBinding) &&
        Object.keys(value.targetBinding).length === 2 &&
        validRef(value.targetBinding.resourceHandle) &&
        isString(value.targetBinding.relativePath))) &&
    validRef(value.agent) &&
    (value.connectionId === null || isString(value.connectionId)) &&
    isString(value.executionId) &&
    value.executionId.length > 0 &&
    (value.target === null || validRegisteredIdentity(value.target)) &&
    Array.isArray(value.children) &&
    value.children.length <= 64 &&
    value.children.every(validRegisteredIdentity) &&
    Array.isArray(value.unregisteredObservations) &&
    value.unregisteredObservations.length <= 64 &&
    value.unregisteredObservations.every(
      (o) =>
        isRecord(o) &&
        Object.keys(o).length === 4 &&
        isInt(o.pid) &&
        isInt(o.uid) &&
        isInt(o.parent) &&
        isString(o.observedAt),
    ) &&
    (value.releasedAt === null || isString(value.releasedAt)) &&
    (value.cancelRequestedAt === null || isString(value.cancelRequestedAt)) &&
    (value.exitClassification === null ||
      exitClassifications.includes(
        value.exitClassification as ExitClassification,
      )) &&
    (value.effort === null ||
      (isString(value.effort) && value.effort.length <= 32)) &&
    validExecutionBudget(value.budget) &&
    (value.stopUnconfirmed === null ||
      validStopUnconfirmed(value.stopUnconfirmed)) &&
    Array.isArray(value.blockedOperations) &&
    value.blockedOperations.every((b) =>
      blockedOperations.includes(b as BlockedOperation),
    ) &&
    new Set(value.blockedOperations).size === value.blockedOperations.length &&
    (value.recordLocator === null || isDigest(value.recordLocator)) &&
    isString(value.createdAt) &&
    isString(value.updatedAt);
  if (!structural) return false;
  const early = state === "queued" || state === "reserved";
  if (state === "stopped" && value.stopReason === null) return false;
  if (
    ["queued", "reserved", "running", "completed"].includes(state) &&
    value.stopReason !== null
  )
    return false;
  if (
    early &&
    (value.actualBinding !== null ||
      value.accounting !== null ||
      value.exit !== null)
  )
    return false;
  if (state === "completed" && value.exit === null) return false;
  if (state === "unknown" && value.observationCompleteness === "complete")
    return false;
  if (
    state === "stopping" &&
    value.stopUnconfirmed === null &&
    !value.cancelRequestedAt
  )
    return false;
  return true;
}
/** The Contract PhysicalExecution view of a record (the connection adds the Context). */
export function physicalExecutionOf(
  record: HostExecutionRecord,
): PhysicalExecution {
  const view: Record<string, unknown> = {};
  for (const key of physicalExecutionKeys) view[key] = record[key];
  return view as unknown as PhysicalExecution;
}
/** Run event kinds an execution may append through the execution upsert (a closed subset of the run event kinds). */
export const executionEventKinds = [
  "submitted",
  "started",
  "stop_requested",
  "stopped",
  "completed",
  "failed",
  "interrupted",
  "stop_unconfirmed",
  "stop_confirmed",
  "approval_accepted",
  "approval_rejected",
] as const;
export type ExecutionEventKind = (typeof executionEventKinds)[number];

/**
 * The Contract `model` ref of a product model id. Refs allow no brackets, so a trailing
 * context-window qualifier (`claude-opus-5[1m]`) becomes a colon segment
 * (`claude-opus-5:1m`); every other id is its own ref. The inverse is a lookup among the
 * connection's models, never a string transformation (an id may itself contain colons).
 */
export function modelRefOf(modelId: string): string {
  return modelId.replace(/\[([A-Za-z0-9]+)\]$/, ":$1");
}
/** Local role selection (feature-t31 writes it; the Host checks executions against it). */
export interface RuntimeRoleBinding {
  instanceId: string;
  scopeRef: string;
  roleIntent: string;
  connectionId: string;
  model: string;
  /** Explicit level, or null to use the model's recorded default. */
  effort: string | null;
  updatedAt: string;
}
export function validRuntimeRoleBinding(
  value: unknown,
): value is RuntimeRoleBinding {
  return (
    isRecord(value) &&
    Object.keys(value).length === 7 &&
    validRef(value.instanceId) &&
    validRef(value.scopeRef) &&
    validRef(value.roleIntent) &&
    isString(value.connectionId) &&
    value.connectionId.length > 0 &&
    isString(value.model) &&
    value.model.length > 0 &&
    (value.effort === null ||
      (isString(value.effort) && value.effort.length <= 32)) &&
    isString(value.updatedAt)
  );
}
