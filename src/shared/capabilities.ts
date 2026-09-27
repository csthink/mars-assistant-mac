import { validId } from "./protocol";
/** Wire contract for the one capability delivered by feature-t5. */
export const readToolName = "read_selected_material";
/**
 * First-phase trust boundary shown on the access permission page. The wording is spec
 * ACCESS-02's own sentence; a unit test keeps the two byte for byte identical.
 */
export const trustBoundaryNotice =
  "本地 Agent 以当前 macOS 账户运行。Assistant 只对自身入口执行授权校验；不承诺阻止任意同账户进程读取文件、凭据或访问网络，也不承诺 Agent 首个模型请求前的操作系统级隔离。撤销权限只影响经 Assistant 发起的后续操作。";
export const authorizationWindowMs = 5 * 60_000;
export const grantLifetimeMs = 30 * 86_400_000;
export const toolRoundsLimit = 4;
export const toolsPerRoundLimit = 5;
export const toolArgumentsLimit = 4096;
export const toolResultLimit = 64_000;
export type ToolState =
  | "pending"
  | "approved"
  | "executing"
  | "completed"
  | "denied"
  | "cancelled"
  | "expired"
  | "failed"
  | "unknown"
  | "acknowledged";
export type PermissionBlocker =
  | "execution_ended"
  | "conversation_deleted"
  | "connection_unavailable"
  | "destination_changed"
  | "model_unavailable"
  | "material_unavailable";
export interface Permission {
  id: string;
  conversationId: string;
  conversationTitle: string;
  connectionId: string;
  connectionName: string;
  baseUrl: string;
  model: string;
  attachmentId: string;
  attachmentName: string;
  sha256: string;
  purpose: string;
  executionId: string | null;
  revision: number;
  enabled: boolean;
  expiresAt: string;
  valid: boolean;
  blocker: PermissionBlocker | null;
}
export interface ToolOperation {
  id: string;
  executionId: string;
  conversationId: string;
  conversationTitle: string;
  connectionName: string;
  baseUrl: string;
  model: string;
  callId: string;
  attachmentId: string;
  attachmentName: string;
  sha256: string;
  purpose: string;
  state: ToolState;
  revision: number;
  expiresAt: string;
  permissionId: string | null;
  permissionRevision: number | null;
}
export type CapabilityCommand =
  | {
      type: "resolveToolAuthorization";
      id: string;
      revision: number;
      action: "once" | "persist" | "deny" | "cancel";
      expiresAt: string;
    }
  | {
      type: "setPermission";
      id: string;
      revision: number;
      enabled: boolean;
      expiresAt: string;
      confirmUntil: string;
    }
  | { type: "acknowledgeToolResult"; id: string; revision: number };
export type CapabilityHostCommand =
  | {
      type: "requestTool";
      executionId: string;
      callId: string;
      tool: string;
      arguments: string;
    }
  | {
      type: "beginTool" | "consumeTool" | "failTool";
      executionId: string;
      id: string;
    };
const id = validId;
const callId = (v: unknown) =>
  typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const revision = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const date = (v: unknown) =>
  typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
export function validCapabilityCommand(
  value: unknown,
): value is CapabilityCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>,
    keys = Object.keys(c).sort().join(",");
  if (!id(c.id) || !revision(c.revision)) return false;
  if (c.type === "resolveToolAuthorization")
    return (
      keys === "action,expiresAt,id,revision,type" &&
      ["once", "persist", "deny", "cancel"].includes(String(c.action)) &&
      date(c.expiresAt)
    );
  if (c.type === "setPermission")
    return (
      keys === "confirmUntil,enabled,expiresAt,id,revision,type" &&
      typeof c.enabled === "boolean" &&
      date(c.expiresAt) &&
      date(c.confirmUntil)
    );
  return c.type === "acknowledgeToolResult" && keys === "id,revision,type";
}
export function validCapabilityHostCommand(
  value: unknown,
): value is CapabilityHostCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>,
    keys = Object.keys(c).sort().join(",");
  if (!id(c.executionId)) return false;
  if (c.type === "requestTool")
    return (
      keys === "arguments,callId,executionId,tool,type" &&
      callId(c.callId) &&
      typeof c.tool === "string" &&
      c.tool.length <= 100 &&
      typeof c.arguments === "string" &&
      c.arguments.length <= toolArgumentsLimit
    );
  return (
    (c.type === "beginTool" ||
      c.type === "consumeTool" ||
      c.type === "failTool") &&
    keys === "executionId,id,type" &&
    id(c.id)
  );
}
