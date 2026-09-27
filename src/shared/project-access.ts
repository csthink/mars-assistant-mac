/**
 * Project repository governance access (feature-t31 S-06, OD-416; spec RUNTIME-01,
 * ACCESS-01, PROJECT-01, PROJECT-02): inside a project the user registers the
 * project folder as a Host resource, opens the Runtime scope for it and authorizes
 * the Runtime after reviewing subject, objects, operations, impact and period. The
 * main process re-checks the folder identity and the current records before every
 * step; the renderer only names the project, the instance and the reviewed proposal.
 * A Runtime's own binding file (hp: `hp binding write`, OD-412) is written by the
 * person on the receiving machine; nothing here writes it.
 */
import type { RuntimeResource, RuntimeScope } from "./runtime-host";
import { validRef } from "./runtime-host";

/**
 * Grant operations requested by the project entry. The frozen Contract leaves the
 * vocabulary of Grant.operation to the Runtime; the entry uses the Contract method
 * names a scope-bound request travels on, as the hp Runtime checks them (and as the
 * J-04 acceptance used them).
 */
export const accessOperations = {
  read: [
    "runtime.snapshot.open",
    "runtime.snapshot.next",
    "runtime.events.subscribe",
    "runtime.events.ack",
    "runtime.resource.read",
  ],
  act: [
    "runtime.action.invoke",
    "runtime.operation.get",
    "runtime.operation.cancel",
  ],
} as const;
/** Days an entry authorization lasts; renewal is a new, reviewed authorization. */
export const accessLifetimeDays = 30;
export const accessPurpose = (projectName: string) =>
  "项目仓库治理接入：" + projectName;

/** What the person reviews before authorizing; its canonical digest binds the confirmation. */
export interface AccessProposal {
  projectId: string;
  installationId: string;
  instanceId: string;
  runtimeId: string;
  version: string;
  publisherId: string;
  scopeRef: string;
  resourceHandle: string;
  folder: string;
  capabilities: string[];
  operations: { read: string[]; act: string[] };
  lifetimeDays: number;
}
export interface AccessInstance {
  instanceId: string;
  installationId: string;
  runtimeId: string;
  version: string;
  publisherId: string;
  /** Card state label and reason, the same derivation as 扩展管理. */
  state: string;
  reason: string;
  ready: boolean;
  instanceDir: string | null;
  scope: {
    scopeRef: string;
    state: RuntimeScope["state"];
    freshness: RuntimeScope["freshness"];
    lastError: RuntimeScope["lastError"];
    activeGrants: number;
    /** Latest expiry among the usable grants, when any. */
    expiresAt: string | null;
    /** When no grant is usable: how the latest authorization of this scope ended, and when. */
    ended: { reason: "expired" | "revoked"; at: string } | null;
    /** The project this scope is linked to, when it is another project. */
    linkedElsewhere: { projectId: string; name: string } | null;
    linkedHere: boolean;
  } | null;
  proposal: AccessProposal | null;
  proposalDigest: string | null;
}
export interface ProjectAccessView {
  folder: { path: string; gitRoot: string | null };
  resource: RuntimeResource | null;
  instances: AccessInstance[];
}
export type ProjectAccessRequest =
  | { type: "read"; projectId: string }
  | { type: "register"; projectId: string }
  | { type: "open"; projectId: string; instanceId: string }
  | {
      type: "authorize";
      projectId: string;
      instanceId: string;
      scopeRef: string;
      proposalDigest: string;
    };
export type ProjectAccessReply =
  | { ok: true; view: ProjectAccessView; message?: string }
  | { ok: false; message: string; view?: ProjectAccessView };

const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const keys = (v: Record<string, unknown>, expected: string) =>
  Object.keys(v).sort().join(",") === expected;
export function validProjectAccessRequest(
  v: unknown,
): v is ProjectAccessRequest {
  if (!obj(v) || !uuid(v.projectId)) return false;
  if (v.type === "read" || v.type === "register")
    return keys(v, "projectId,type");
  if (v.type === "open")
    return keys(v, "instanceId,projectId,type") && validRef(v.instanceId);
  return (
    v.type === "authorize" &&
    keys(v, "instanceId,projectId,proposalDigest,scopeRef,type") &&
    validRef(v.instanceId) &&
    validRef(v.scopeRef) &&
    typeof v.proposalDigest === "string" &&
    /^[0-9a-f]{64}$/.test(v.proposalDigest)
  );
}
/** Every (capability, operation) pair a proposal grants, in a stable order. */
export function proposalGrants(proposal: AccessProposal) {
  return proposal.capabilities.flatMap((capability) =>
    [...proposal.operations.read, ...proposal.operations.act].map(
      (operation) => ({ capability, operation }),
    ),
  );
}
