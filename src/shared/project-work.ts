import type {
  RuntimeProjection,
  RuntimeScope,
  RuntimeSnapshot,
} from "./runtime-host";
import { validRef } from "./runtime-host";
import type { RuntimeRoleBinding } from "./runtime-execution";
import type { ProjectionAwaiting } from "./project-actions";
export type ProjectRole = "implementer" | "reviewer";
export interface ProjectRuntimeLink {
  instanceId: string;
  scopeRef: string;
  bindingRef: string;
  resourceHandle: string;
}
export interface ProjectChatContext extends ProjectRuntimeLink {
  objectRef: string;
  revision: string;
  title: string;
  stateLabel: string;
}
export interface ProjectChat {
  conversationId: string;
  context: ProjectChatContext | null;
  revision: number;
}
export interface ProjectWork {
  runtime: ProjectRuntimeLink | null;
  chats: ProjectChat[];
}
export type ProjectRequest =
  | { type: "read"; projectId: string }
  | {
      type: "bind";
      projectId: string;
      instanceId: string;
      scopeRef: string;
      revision: number;
    }
  | {
      type: "role";
      projectId: string;
      role: ProjectRole;
      connectionId: string;
      model: string;
      effort: string | null;
      expectedUpdatedAt: string | null;
    }
  | { type: "chat"; projectId: string; conversationId: string }
  | {
      type: "context";
      projectId: string;
      conversationId: string;
      objectRef: string | null;
      revision: number;
      objectRevision: string | null;
    };
export interface ProjectWorkView {
  scopes: RuntimeScope[];
  scope: RuntimeScope | null;
  projection: RuntimeProjection | null;
  roles: {
    role: ProjectRole;
    binding: RuntimeRoleBinding | null;
    available: boolean;
    reason: string;
  }[];
  unavailable: string;
  /** KB-308: objects shown as 同步中 until the projection moves past their newest succeeded action. */
  awaiting: ProjectionAwaiting[];
}
export type ProjectWorkReply =
  { ok: true; view?: ProjectWorkView } | { ok: false; message: string };
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const exact = (v: Record<string, unknown>, s: string) =>
  Object.keys(v).sort().join(",") === s;
export function validProjectRequest(v: unknown): v is ProjectRequest {
  if (!obj(v) || !uuid(v.projectId)) return false;
  if (v.type === "read") return exact(v, "projectId,type");
  if (v.type === "chat")
    return exact(v, "conversationId,projectId,type") && uuid(v.conversationId);
  if (v.type === "role")
    return (
      exact(
        v,
        "connectionId,effort,expectedUpdatedAt,model,projectId,role,type",
      ) &&
      ["implementer", "reviewer"].includes(String(v.role)) &&
      uuid(v.connectionId) &&
      typeof v.model === "string" &&
      v.model.length > 0 &&
      v.model.length <= 256 &&
      (v.effort === null ||
        (typeof v.effort === "string" && v.effort.length <= 32)) &&
      (v.expectedUpdatedAt === null || typeof v.expectedUpdatedAt === "string")
    );
  if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 0) return false;
  if (v.type === "bind")
    return (
      exact(v, "instanceId,projectId,revision,scopeRef,type") &&
      validRef(v.instanceId) &&
      validRef(v.scopeRef)
    );
  return (
    v.type === "context" &&
    exact(
      v,
      "conversationId,objectRef,objectRevision,projectId,revision,type",
    ) &&
    uuid(v.conversationId) &&
    (v.objectRef === null
      ? v.objectRevision === null
      : validRef(v.objectRef) && validRef(v.objectRevision))
  );
}
/** No cached freshness or old grant can make a scope usable. Also used at dispatch. */
export function projectScopeProblem(
  records: RuntimeSnapshot,
  link: ProjectRuntimeLink,
  requireCurrent = true,
): string {
  const scope = records.runtimeScopes.find(
    (s) => s.instanceId === link.instanceId && s.scopeRef === link.scopeRef,
  );
  if (
    !scope ||
    scope.bindingRef !== link.bindingRef ||
    scope.resourceHandle !== link.resourceHandle
  )
    return "项目关联已变化，请重新核对。";
  if (scope.state !== "active") return "项目访问尚未授权或授权已撤销。";
  const grants = scope.grantRefs.map((ref) =>
    records.runtimeGrants.find(
      (g) =>
        g.instanceId === link.instanceId &&
        g.scopeRef === link.scopeRef &&
        g.ref.id === ref.id &&
        g.ref.revision === ref.revision,
    ),
  );
  if (
    !grants.length ||
    grants.some(
      (g) =>
        !g || g.status !== "active" || Date.parse(g.expiresAt) <= Date.now(),
    )
  )
    return "项目授权已失效，请重新核对访问权限。";
  if (!grants.some((g) => g?.resourceHandle === link.resourceHandle))
    return "项目资源没有适用授权。";
  if (
    records.runtimeInstances.find((i) => i.instanceId === link.instanceId)
      ?.state !== "ready"
  )
    return "扩展未连接，显示最后已知内容。";
  if (requireCurrent && scope.freshness !== "current")
    return "项目数据尚未同步，显示最后已知内容。";
  return "";
}
