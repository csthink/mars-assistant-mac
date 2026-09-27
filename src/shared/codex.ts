import type { EffortRecord } from "./protocol";
export interface CodexSettings {
  enabled: boolean;
  path: string | null;
  revision: number;
}
export const defaultCodexSettings: CodexSettings = {
  enabled: true,
  path: null,
  revision: 0,
};
export function validCodexPath(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.startsWith("/") &&
      value.length <= 4096 &&
      !/[\x00-\x1f]/.test(value))
  );
}
/** Public diagnostics contain no raw account, configuration, or protocol data. */
export interface CodexInstallation {
  path: string;
  resolvedPath: string;
  version: string;
}
export interface CodexStatus {
  installation: CodexInstallation | null;
  detection: "found" | "missing" | "failed";
  authentication: "chatgpt" | "apiKey" | "external" | "signedOut" | "unknown";
  protocol: "available" | "unavailable" | "unknown";
  model: string | null;
  provider: string | null;
  models: string[];
  /** Effort levels per model, only where this detection read them back. */
  efforts: Record<string, EffortRecord>;
  configurationSources: string[];
  restriction: "unchecked" | "verified" | "conflict";
  invocation: "untested";
  checkedAt: string;
  message: string;
}
export const codexAuthenticationLabels: Record<
  CodexStatus["authentication"],
  string
> = {
  chatgpt: "ChatGPT 登录",
  apiKey: "API key 登录",
  external: "其他提供方认证",
  signedOut: "未登录",
  unknown: "认证来源未知",
};
/** Approved, non-secret connection origin. Binary versions are intentionally excluded. */
export interface CodexConnection {
  provider: string;
  endpoint: string;
  authentication: "chatgpt" | "apiKey" | "external";
  identity: string;
  fingerprint: string;
  instructions: Array<{ path: string; sha256: string }>;
  configurationInstructions: Array<{ field: string; sha256: string }>;
}
/** Model identity has its own fingerprint; consent is reusable only for the same account and rule sources. */
export function sameCodexOrigin(
  a: CodexConnection,
  b: CodexConnection,
): boolean {
  return (
    [
      "provider",
      "endpoint",
      "authentication",
      "identity",
      "instructions",
      "configurationInstructions",
    ] as const
  ).every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}
export function validCodexConnection(value: unknown): value is CodexConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>,
    hash = (s: unknown) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
  return (
    Object.keys(v).sort().join(",") ===
      "authentication,configurationInstructions,endpoint,fingerprint,identity,instructions,provider" &&
    typeof v.endpoint === "string" &&
    v.endpoint.length <= 2048 &&
    !/[\x00-\x1f]/.test(v.endpoint) &&
    typeof v.provider === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(v.provider) &&
    ["chatgpt", "apiKey", "external"].includes(String(v.authentication)) &&
    hash(v.identity) &&
    hash(v.fingerprint) &&
    Array.isArray(v.configurationInstructions) &&
    v.configurationInstructions.length <= 3 &&
    v.configurationInstructions.every(
      (i) =>
        i &&
        typeof i === "object" &&
        Object.keys(i).sort().join(",") === "field,sha256" &&
        ["instructions", "developer_instructions", "compact_prompt"].includes(
          i.field,
        ) &&
        hash(i.sha256),
    ) &&
    Array.isArray(v.instructions) &&
    v.instructions.length <= 32 &&
    v.instructions.every(
      (i) =>
        i &&
        typeof i === "object" &&
        Object.keys(i).sort().join(",") === "path,sha256" &&
        typeof i.path === "string" &&
        i.path.startsWith("/") &&
        i.path.length <= 4096 &&
        !i.path.includes("\0") &&
        hash(i.sha256),
    )
  );
}
export interface CodexSetup {
  token: string;
  model: string;
  configuration: CodexConnection;
  /** Record read back at preparation; the level itself is chosen per conversation. */
  effortRecord: EffortRecord | null;
}
export type CodexSetupReply =
  { ok: true; setup: CodexSetup } | { ok: false; message: string };
/** Only host-owned thread identities are eligible for protocol recovery. */
export interface CodexRun {
  threadId: string;
  turnId: string | null;
  cwd: string;
  model: string;
  provider: string;
  fingerprint: string;
  installation: CodexInstallation;
}
export function validCodexRun(value: unknown): value is CodexRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>,
    id = (s: unknown) =>
      typeof s === "string" && /^[^\s\x00-\x1f]{1,200}$/.test(s);
  const path = (s: unknown) =>
    typeof s === "string" &&
    s.startsWith("/") &&
    s.length <= 4096 &&
    !s.includes("\0");
  const i = v.installation as Record<string, unknown> | null;
  return (
    Object.keys(v).sort().join(",") ===
      "cwd,fingerprint,installation,model,provider,threadId,turnId" &&
    id(v.threadId) &&
    (v.turnId === null || id(v.turnId)) &&
    path(v.cwd) &&
    id(v.model) &&
    id(v.provider) &&
    typeof v.fingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(v.fingerprint) &&
    !!i &&
    Object.keys(i).sort().join(",") === "path,resolvedPath,version" &&
    path(i.path) &&
    path(i.resolvedPath) &&
    id(i.version)
  );
}
