/**
 * Execution port interface (Contract `host.execution.*`, OD-323): the Host validates
 * every execution request, persists the operation and its reservation, and hands the
 * physical work to a registered port. The product build registers no port, so
 * preflight answers "unsupported" and start is refused; feature-t30 registers the
 * embedded port for Claude Code and Codex. Only structural validation lives here.
 */
import {
  validGrantRef,
  validRef,
  validSeq,
  type GrantRef,
  type RuntimeResource,
} from "../shared/runtime-host";
import type {
  ExecutionEventKind,
  HostEvidenceRef,
  HostExecutionRecord,
  RuntimeRoleBinding,
} from "../shared/runtime-execution";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

export interface ExecutionProfile {
  id: string;
  version: string;
  digest: string;
  trustModel: "current-user";
  purpose: "chat" | "widget-generation" | "coding-implementer" | "review";
  programIdentity: { launcher: string; binaryDigest: string; version: string };
  nativeApprovalPolicy:
    "auto-deny" | "expected-range-gate" | "trusted-ui-prompt";
  configurationDigest: string;
  capabilities: string[];
  limitations: string[];
  /** Public summary of the policy (Contract ExecutionProfile); the digest binds the full policy bytes. */
  operations: string[];
  maxContextBytes: number;
  maxToolCalls: number;
  maxRunSeconds: number;
}
export interface ExecutionBinding {
  profileDigest: string;
  agent: string;
  model: string;
  modelVendor: string;
  routeVendor: string | null;
  credentialRef: string;
  configurationRevision: string;
}
export interface ExecutionConstraint {
  kind: "resource" | "tool" | "network" | "path" | "budget";
  value: string;
  enforcer: "host" | "runtime" | "agent";
  guarantee: "interface-enforced" | "agent-declared";
}
export interface TargetBinding {
  resourceHandle: string;
  relativePath: string;
}
/** Contract ExecutionStart without the Context. */
export interface ExecutionStartRequest {
  operationId: string;
  idempotencyKey: string;
  requestDigest: string;
  scopeRef: string;
  profileId: string;
  profileDigest: string;
  domainOperationId: string;
  domainNodeRef: string;
  roleIntent: string;
  resourceHandle: string;
  targetBinding: TargetBinding | null;
  connectionRef: string;
  configurationRevision: string;
  model: string;
  executionBinding: ExecutionBinding;
  constraints: ExecutionConstraint[];
  decisionRef: string | null;
  grantRefs: GrantRef[];
  contextRefs: Json[];
  budget: Json;
}
export interface PreflightRequest {
  scopeRef: string;
  profileId: string;
  profileDigest: string;
  connectionRef: string;
  configurationRevision: string;
  executionBinding: ExecutionBinding;
  constraints: ExecutionConstraint[];
}
export interface PreflightCheck {
  id: string;
  passed: boolean;
  detail: string;
}
/**
 * What the Host hands a port with an accepted reservation (feature-t30): the persisted
 * record, the resource behind the request and the transition reporter. A transition
 * commits the record change, the start operation's status, the run event and the pending
 * item in one business transaction; ports that keep their own physical memory (the test
 * fake) may ignore it.
 */
export interface ExecutionContext {
  installationId: string;
  instanceId: string;
  record: HostExecutionRecord;
  resource: RuntimeResource | null;
  connectionId: string | null;
  /**
   * The context snapshots named by contextRefs, in request order, each verified against the
   * stored snapshot (scope, revision, digest, length) and the covering grant before the
   * reservation; the Host never parses their bytes.
   */
  materials: ExecutionMaterial[];
  /** The local role selection for (scopeRef, roleIntent), written by the project UI (feature-t31); null when none. */
  roleBinding(): Promise<RuntimeRoleBinding | null>;
  transition(update: ExecutionTransition): Promise<HostExecutionRecord>;
  /** The persisted record as the business service holds it now (the store is the source, not port memory). */
  current(): Promise<HostExecutionRecord | null>;
}
export interface ExecutionMaterial {
  ref: HostEvidenceRef;
  bytes: Buffer;
}
export interface ExecutionTransition {
  record: HostExecutionRecord;
  event: { kind: ExecutionEventKind; payload: Json } | null;
  pending: "open" | "resolve" | null;
}
/** Fixed result storage failures; absence of bytes does not prove absence of the execution. */
export class ExecutionResultReadError extends Error {
  constructor(
    readonly code: "RESULT_UNKNOWN" | "INTEGRITY_MISMATCH",
    message: string,
  ) {
    super(message);
  }
}
/** A physical execution port; feature-t30 supplies the real one, tests a fake-agent one. */
export interface ExecutionPort {
  readonly id: string;
  profiles(): ExecutionProfile[];
  preflight(request: PreflightRequest): Promise<PreflightCheck[]>;
  /** Starts the physical execution for an accepted reservation; resolves once the target is created. */
  start(
    executionRef: string,
    request: ExecutionStartRequest,
    context: ExecutionContext,
  ): Promise<Json>;
  /** Contract PhysicalExecution only; internal observation fields never cross this boundary. */
  get(executionRef: string): Promise<Json | null>;
  cancel(executionRef: string, operationId: string): Promise<Json>;
  /** Host-authorized persisted result only; validate the full fixed content before returning a chunk. No execution or current profile discovery. */
  readResult?(
    record: HostExecutionRecord,
    offset: number,
    length: number,
  ): Buffer;
}

export function validExecutionBinding(
  value: unknown,
): value is ExecutionBinding {
  return (
    isRecord(value) &&
    Object.keys(value).length === 7 &&
    isDigest(value.profileDigest) &&
    validRef(value.agent) &&
    validRef(value.model) &&
    validRef(value.modelVendor) &&
    (value.routeVendor === null || validRef(value.routeVendor)) &&
    validRef(value.credentialRef) &&
    validSeq(value.configurationRevision)
  );
}
export function validExecutionConstraint(
  value: unknown,
): value is ExecutionConstraint {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    ["resource", "tool", "network", "path", "budget"].includes(
      value.kind as string,
    ) &&
    typeof value.value === "string" &&
    value.value.length <= 1024 &&
    ["host", "runtime", "agent"].includes(value.enforcer as string) &&
    ["interface-enforced", "agent-declared"].includes(
      value.guarantee as string,
    ) &&
    // An agent can only declare; the closed set has no operating-system guarantee.
    (value.enforcer !== "agent" || value.guarantee === "agent-declared")
  );
}
const relativePathPattern =
  /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_./-]+$/;
export function validTargetBinding(value: unknown): value is TargetBinding {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    validRef(value.resourceHandle) &&
    typeof value.relativePath === "string" &&
    value.relativePath.length > 0 &&
    value.relativePath.length <= 1024 &&
    relativePathPattern.test(value.relativePath)
  );
}
export function validPreflightRequest(
  value: unknown,
): value is PreflightRequest & { context?: unknown } {
  if (!isRecord(value)) return false;
  const keys = [
    "scopeRef",
    "profileId",
    "profileDigest",
    "connectionRef",
    "configurationRevision",
    "executionBinding",
    "constraints",
  ];
  return (
    keys.every((k) => k in value) &&
    Object.keys(value).every((k) => keys.includes(k) || k === "context") &&
    validRef(value.scopeRef) &&
    validRef(value.profileId) &&
    isDigest(value.profileDigest) &&
    validRef(value.connectionRef) &&
    validSeq(value.configurationRevision) &&
    validExecutionBinding(value.executionBinding) &&
    Array.isArray(value.constraints) &&
    value.constraints.length <= 64 &&
    value.constraints.every(validExecutionConstraint)
  );
}
/** Structural and cross-field checks of ExecutionStart; the Host's authorization checks follow separately. */
export function executionStartProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["request is not an object"];
  const problems: string[] = [];
  const keys = [
    "operationId",
    "idempotencyKey",
    "requestDigest",
    "scopeRef",
    "profileId",
    "profileDigest",
    "domainOperationId",
    "domainNodeRef",
    "roleIntent",
    "resourceHandle",
    "targetBinding",
    "connectionRef",
    "configurationRevision",
    "model",
    "executionBinding",
    "constraints",
    "decisionRef",
    "grantRefs",
    "contextRefs",
    "budget",
  ];
  for (const key of keys) if (!(key in value)) problems.push("missing " + key);
  for (const key of Object.keys(value))
    if (!keys.includes(key) && key !== "context")
      problems.push("unexpected " + key);
  if (problems.length) return problems;
  for (const key of [
    "operationId",
    "idempotencyKey",
    "scopeRef",
    "profileId",
    "domainOperationId",
    "domainNodeRef",
    "roleIntent",
    "resourceHandle",
    "connectionRef",
    "model",
  ])
    if (!validRef(value[key])) problems.push("invalid " + key);
  if (!isDigest(value.requestDigest)) problems.push("invalid requestDigest");
  if (!isDigest(value.profileDigest)) problems.push("invalid profileDigest");
  if (!validSeq(value.configurationRevision))
    problems.push("invalid configurationRevision");
  if (value.targetBinding !== null && !validTargetBinding(value.targetBinding))
    problems.push("invalid targetBinding");
  if (!validExecutionBinding(value.executionBinding))
    problems.push("invalid executionBinding");
  else {
    const binding = value.executionBinding;
    if (binding.profileDigest !== value.profileDigest)
      problems.push(
        "executionBinding.profileDigest differs from profileDigest",
      );
    if (binding.model !== value.model)
      problems.push("executionBinding.model differs from model");
    if (binding.configurationRevision !== value.configurationRevision)
      problems.push(
        "executionBinding.configurationRevision differs from configurationRevision",
      );
  }
  if (
    !Array.isArray(value.constraints) ||
    value.constraints.length > 64 ||
    !value.constraints.every(validExecutionConstraint)
  )
    problems.push("invalid constraints");
  if (value.decisionRef !== null && !validRef(value.decisionRef))
    problems.push("invalid decisionRef");
  if (
    !Array.isArray(value.grantRefs) ||
    value.grantRefs.length > 100 ||
    !value.grantRefs.every(validGrantRef)
  )
    problems.push("invalid grantRefs");
  if (
    !Array.isArray(value.contextRefs) ||
    value.contextRefs.length > 32 ||
    !value.contextRefs.every(isRecord)
  )
    problems.push("invalid contextRefs");
  if (!isRecord(value.budget)) problems.push("invalid budget");
  return problems;
}
