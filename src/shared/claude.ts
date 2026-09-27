import {
  validCodexConnection,
  validCodexRun,
  type CodexConnection,
  type CodexRun,
} from "./codex";
import type { EffortRecord } from "./protocol";
/** Non-secret installation and protocol metadata. Versions never gate availability. */
export interface ClaudeInstallation {
  path: string;
  resolvedPath: string;
  version: string;
}
export interface ClaudeSettings {
  enabled: boolean;
  path: string | null;
  revision: number;
}
export const defaultClaudeSettings: ClaudeSettings = {
  enabled: true,
  path: null,
  revision: 0,
};
export interface ClaudeStatus {
  installation: ClaudeInstallation | null;
  detection: "found" | "missing" | "failed";
  authentication:
    "subscription" | "apiKey" | "external" | "signedOut" | "unknown";
  protocol: "available" | "unavailable" | "unknown";
  model: string | null;
  provider: string | null;
  models: string[];
  /** Effort levels per resolved model, only where this detection read them back. */
  efforts: Record<string, EffortRecord>;
  restriction: "unchecked" | "verified" | "conflict";
  invocation: "untested";
  checkedAt: string;
  message: string;
  identity?: string;
  configurationSources: string[];
}
export const claudeAuthenticationLabels: Record<
  ClaudeStatus["authentication"],
  string
> = {
  subscription: "Claude 订阅登录",
  apiKey: "API key 登录",
  external: "其他提供方认证",
  signedOut: "未登录",
  unknown: "认证来源未知",
};
export function validClaudePath(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.startsWith("/") &&
      value.length <= 4096 &&
      !/[\x00-\x1f\x7f]/.test(value))
  );
}
/** Claude model identifiers can contain a context-window qualifier. */
export function validClaudeModel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*(?:\[[a-zA-Z0-9]+\])?$/.test(value) &&
    value.length <= 200
  );
}

export interface ClaudeConnection extends Omit<
  CodexConnection,
  "authentication"
> {
  authentication: "subscription" | "apiKey" | "external";
}
export type ClaudeRun = CodexRun;
export interface ClaudeSetup {
  token: string;
  model: string;
  configuration: ClaudeConnection;
  /** Record read back at preparation; the level itself is chosen per conversation. */
  effortRecord: EffortRecord | null;
}
export type ClaudeSetupReply =
  { ok: true; setup: ClaudeSetup } | { ok: false; message: string };
export function validClaudeConnection(
  value: unknown,
): value is ClaudeConnection {
  if (!value || typeof value !== "object") return false;
  const c = value as ClaudeConnection;
  return (
    ["subscription", "apiKey", "external"].includes(c.authentication) &&
    validCodexConnection({
      ...c,
      authentication:
        c.authentication === "subscription" ? "chatgpt" : c.authentication,
    })
  );
}
export const validClaudeRun = validCodexRun;
export function sameClaudeOrigin(
  a: ClaudeConnection,
  b: ClaudeConnection,
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
