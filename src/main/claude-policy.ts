import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { TransportError } from "./transport";
/** Empty maps merge with CLI defaults; explicitly disable observed built-in plugins.
 * Session init still rejects every loaded plugin, including newly introduced ones. */
export const claudeRestrictedSettings = JSON.stringify({
  disableAllHooks: true,
  enabledPlugins: {
    "cc-plugin-agents-md@builtin": false,
    "cc-plugin-plugin-authoring@builtin": false,
  },
});
const conflict = () =>
  new TransportError(
    "unsupported",
    "检测到管理配置或无法确认其影响，Claude Code 尚未开放调用。请先核对组织策略。",
  );
/** Inspect existence only, never print or copy configuration values or credential files. */
export async function assertClaudePolicy(
  environment: NodeJS.ProcessEnv,
  systemRoot = "/Library",
) {
  const home = environment.HOME ?? homedir();
  const config = environment.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const names = [
    join(systemRoot, "Application Support/ClaudeCode/managed-settings.json"),
    join(systemRoot, "Application Support/ClaudeCode/managed-settings.d"),
    join(systemRoot, "Application Support/ClaudeCode/managed-mcp.json"),
    join(systemRoot, "Managed Preferences/com.anthropic.claudecode.plist"),
    join(
      systemRoot,
      "Managed Preferences",
      userInfo().username,
      "com.anthropic.claudecode.plist",
    ),
    join(home, "Library/Preferences/com.anthropic.claudecode.plist"),
    join(config, "remote-settings.json"),
  ];
  for (const path of names) {
    try {
      await lstat(path);
      throw conflict();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw conflict();
    }
  }
}
/** Remote managed policies can execute at startup. Only prove absence before starting a session. */
export function assertClaudeAccountPolicy(
  auth: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
) {
  if (auth.loggedIn === false) return;
  const endpoint = environment.ANTHROPIC_BASE_URL;
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (url.origin !== "https://api.anthropic.com") return;
    } catch {
      throw conflict();
    }
  }
  if (
    auth.authMethod === "claude.ai" &&
    ["pro", "max"].includes(String(auth.subscriptionType)) &&
    !environment.ANTHROPIC_API_KEY &&
    !environment.ANTHROPIC_AUTH_TOKEN &&
    !environment.CLAUDE_CODE_OAUTH_TOKEN
  )
    return;
  throw conflict();
}
