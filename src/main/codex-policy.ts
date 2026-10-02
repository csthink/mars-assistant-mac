import { isAbsolute } from "node:path";
import type { DetectionRpc } from "./codex";

/** Controls are selected by their behavior, never by the installed version string. */
export const disabledCodexFeatures = [
  "hooks",
  "plugins",
  "remote_plugin",
  "apps",
  "shell_tool",
  "shell_snapshot",
  "memories",
  "computer_use",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "image_generation",
  "multi_agent",
  "multi_agent_v2",
  "workspace_dependencies",
  "skill_mcp_dependency_install",
  "skill_search",
  "unbounded_connection_retries",
  "view_image",
  "goals",
  "sleep_tool",
  "tool_suggest",
  "code_mode",
  "unified_exec",
] as const;
const enabledCodexFeatures = [
  "code_mode_host",
  "skip_host_skill_discovery",
] as const;
export const codexPermissionProfile = "csthink_assistant";
export class CodexPolicyError extends Error {
  constructor(
    public readonly reason: "shape" | "features" | "mcp" | "configuration",
  ) {
    super("Codex configuration boundary: " + reason);
  }
}
export interface CodexInventory {
  features: string[];
  mcp: string[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CodexPolicyError("shape");
  return value as Record<string, unknown>;
}
export function codexInventory(reply: unknown): CodexInventory {
  const config = object(object(reply).config);
  const features = config.features === undefined ? {} : object(config.features);
  if (
    Object.values(features).some(
      (value) => value !== null && typeof value !== "boolean",
    )
  )
    throw new CodexPolicyError("shape");
  const mcp =
    config.mcp_servers === undefined ? {} : object(config.mcp_servers);
  if (
    Object.values(mcp).some(
      (value) => !value || typeof value !== "object" || Array.isArray(value),
    )
  )
    throw new CodexPolicyError("shape");
  if (Object.keys(features).length > 512 || Object.keys(mcp).length > 256)
    throw new CodexPolicyError("shape");
  return {
    features: Object.keys(features).filter((name) => features[name] !== null),
    mcp: Object.keys(mcp),
  };
}
/** Encode nested TOML without interpolating names into dotted configuration keys. */
export function codexToml(value: unknown): string {
  if (value === null || value === undefined)
    throw new CodexPolicyError("shape");
  if (Array.isArray(value)) return "[" + value.map(codexToml).join(",") + "]";
  if (typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .map(([key, item]) => JSON.stringify(key) + "=" + codexToml(item))
        .join(",") +
      "}"
    );
  if (
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    typeof value !== "number"
  )
    throw new CodexPolicyError("shape");
  return JSON.stringify(value);
}
export function codexPolicy(
  binary: string,
  cwd: string,
  inventory: CodexInventory,
) {
  if (!isAbsolute(binary) || !isAbsolute(cwd))
    throw new CodexPolicyError("shape");
  const features = Object.fromEntries(
    [...new Set([...inventory.features, ...disabledCodexFeatures])].map(
      (name) => [name, false],
    ),
  );
  for (const name of enabledCodexFeatures) features[name] = true;
  return {
    features,
    // An empty map merges with user layers. Explicit per-server disable is required.
    mcp_servers: Object.fromEntries(
      inventory.mcp.map((name) => [name, { enabled: false }]),
    ),
    agents: { max_depth: 0 },
    notify: [],
    project_doc_max_bytes: 0,
    web_search: "disabled",
    approval_policy: "never",
    "analytics.enabled": false,
    // Codex 0.159 lists every discoverable skill (name, description and SKILL.md path, the personal
    // ones included) in the model instructions even with host skill discovery skipped; this leaf
    // keeps that list out of every request. A dotted key leaves the user's own skills table intact.
    "skills.include_instructions": false,
    default_permissions: codexPermissionProfile,
    "permissions.csthink_assistant": {
      filesystem: { ":minimal": "read", [binary]: "read", [cwd]: "read" },
      network: { enabled: false },
    },
  };
}
export function codexPolicyArgs(
  binary: string,
  cwd: string,
  inventory: CodexInventory,
): string[] {
  return [
    "app-server",
    ...Object.entries(codexPolicy(binary, cwd, inventory)).flatMap(
      ([key, value]) => ["-c", key + "=" + codexToml(value)],
    ),
  ];
}
/** Check the process that will own the thread, after layered overrides have been applied. */
export function verifyCodexPolicy(
  reply: unknown,
  binary: string,
  cwd: string,
  inventory: CodexInventory,
) {
  const config = object(object(reply).config);
  const effective = codexInventory(reply);
  const expected = codexPolicy(binary, cwd, inventory);
  const flags = object(config.features);
  if (
    Object.entries(expected.features).some(
      ([name, value]) => flags[name] !== value,
    ) ||
    effective.features.some(
      (name) =>
        flags[name] === true &&
        !enabledCodexFeatures.includes(
          name as (typeof enabledCodexFeatures)[number],
        ),
    )
  )
    throw new CodexPolicyError("features");
  const mcp = object(config.mcp_servers);
  if (
    inventory.mcp.some((name) => !Object.hasOwn(mcp, name)) ||
    Object.values(mcp).some((value) => object(value).enabled !== false)
  )
    throw new CodexPolicyError("mcp");
  const profile = object(object(config.permissions)[codexPermissionProfile]);
  const fs = { ...object(profile.filesystem) };
  if (fs.glob_scan_max_depth == null) delete fs.glob_scan_max_depth;
  const expectedFs = expected["permissions.csthink_assistant"].filesystem;
  // A Codex that cannot report the skill instruction control is not known to keep skills out.
  if (object(config.skills).include_instructions !== false)
    throw new CodexPolicyError("configuration");
  if (
    config.web_search !== "disabled" ||
    config.approval_policy !== "never" ||
    config.project_doc_max_bytes !== 0 ||
    object(config.agents).max_depth !== 0 ||
    !Array.isArray(config.notify) ||
    config.notify.length !== 0 ||
    config.default_permissions !== codexPermissionProfile ||
    profile.extends != null ||
    profile.workspace_roots != null ||
    object(profile.network).enabled !== false ||
    Object.keys(fs).length !== Object.keys(expectedFs).length ||
    Object.entries(expectedFs).some(([key, value]) => fs[key] !== value)
  )
    throw new CodexPolicyError("configuration");
}
export async function initializeRestrictedCodex(
  rpc: DetectionRpc,
  binary: string,
  cwd: string,
  inventory: CodexInventory,
) {
  const initialized = object(
    await rpc.request("initialize", {
      clientInfo: { name: "csthink_assistant", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }),
  );
  if (typeof initialized.userAgent !== "string")
    throw new CodexPolicyError("shape");
  rpc.notify("initialized");
  const reply = await rpc.request("config/read", { includeLayers: true, cwd });
  verifyCodexPolicy(reply, binary, cwd, inventory);
  return object(object(reply).config);
}
