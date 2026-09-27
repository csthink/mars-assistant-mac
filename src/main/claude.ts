import { dirname } from "node:path";
import { assertClaudePolicy, assertClaudeAccountPolicy } from "./claude-policy";
import { TransportError } from "./transport";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  defaultClaudeSettings,
  validClaudeModel,
  type ClaudeSettings,
  type ClaudeStatus,
} from "../shared/claude";
import {
  effortLevelLimit,
  validEffortLevel,
  type EffortRecord,
} from "../shared/protocol";
import {
  claudeCommand,
  claudeEnvironment,
  discoverClaude,
} from "./claude-discovery";
import { ClaudeRpc } from "./claude-rpc";
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export function claudeInspectionArgs() {
  return [
    "-p",
    "--restricted",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--settings",
    '{"disableAllHooks":true,"enabledPlugins":{}}',
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}
/** The help text of this installation names the flag; the initialize model entry lists the levels. */
export function claudeHelpHasEffort(help: string): boolean {
  return /^\s*--effort\s+<[^>]+>/m.test(help);
}
/**
 * A record exists only when the current help text exposes --effort and the model entry itself
 * advertises its levels. No default is stated by the installation, so it stays unrecorded.
 */
export function claudeEffortRecord(
  help: string,
  item: Record<string, unknown>,
  at: string,
): EffortRecord | null {
  if (!claudeHelpHasEffort(help) || item.supportsEffort !== true) return null;
  const levels = item.supportedEffortLevels;
  if (
    !Array.isArray(levels) ||
    !levels.length ||
    levels.length > effortLevelLimit ||
    !levels.every(validEffortLevel) ||
    new Set(levels).size !== levels.length
  )
    return null;
  return {
    levels: [...levels],
    defaultLevel: null,
    source: "claude-initialize",
    recordedAt: at,
  };
}
export function claudeAuthentication(
  auth: unknown,
  account: unknown,
): ClaudeStatus["authentication"] {
  const a = object(auth),
    c = object(account);
  if (a.loggedIn === false) return "signedOut";
  if (a.loggedIn !== true) return "unknown";
  const provider = c.apiProvider;
  if (a.apiProvider && provider && a.apiProvider !== provider) return "unknown";
  // Newer initialization metadata identifies the account directly instead of naming token sources.
  if (!("tokenSource" in c) && !("apiKeySource" in c)) {
    if (
      a.authMethod === "claude.ai" &&
      typeof a.email === "string" &&
      a.email === c.email &&
      typeof a.subscriptionType === "string" &&
      typeof c.subscriptionType === "string" &&
      a.subscriptionType.toLowerCase() ===
        c.subscriptionType.replace(/^Claude /i, "").toLowerCase() &&
      provider === "firstParty"
    )
      return "subscription";
    if (
      a.authMethod === "api_key" &&
      a.apiProvider === provider &&
      provider === "firstParty"
    )
      return "apiKey";
    return "unknown";
  }
  if (provider && provider !== "firstParty")
    return ["bedrock", "vertex", "foundry"].includes(String(provider))
      ? "external"
      : "unknown";
  if (
    a.authMethod === "claude.ai" &&
    c.tokenSource &&
    c.tokenSource !== "none" &&
    (!c.apiKeySource || c.apiKeySource === "none")
  )
    return "subscription";
  if (
    a.authMethod === "api_key" &&
    c.apiKeySource &&
    c.apiKeySource !== "none" &&
    (!c.tokenSource || c.tokenSource === "none")
  )
    return "apiKey";
  return "unknown";
}
export class ClaudeDetector {
  private pending?: Promise<ClaudeStatus>;
  private revision = -1;
  private abort?: AbortController;
  constructor(
    private cwd: string,
    private environment = process.env,
    private settings: () => ClaudeSettings = () => defaultClaudeSettings,
  ) {}
  cancel() {
    this.abort?.abort();
  }
  detect(): Promise<ClaudeStatus> {
    const preferences = this.settings();
    if (this.pending && this.revision === preferences.revision)
      return this.pending;
    this.cancel();
    this.abort = new AbortController();
    this.revision = preferences.revision;
    const pending = this.run(preferences, this.abort.signal).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }
  private async run(
    preferences: ClaudeSettings,
    signal: AbortSignal,
  ): Promise<ClaudeStatus> {
    const status: ClaudeStatus = {
      installation: null,
      detection: "missing",
      authentication: "unknown",
      protocol: "unknown",
      model: null,
      provider: null,
      models: [],
      efforts: {},
      configurationSources: [],
      restriction: "unchecked",
      invocation: "untested",
      checkedAt: new Date().toISOString(),
      message: "",
    };
    let rpc: ClaudeRpc | undefined;
    try {
      if (!preferences.enabled) {
        status.message = "Claude Code 整合已关闭。";
        return status;
      }
      await assertClaudePolicy(this.environment);
      const installation = await discoverClaude({
        environment: this.environment,
        ...(preferences.path ? { candidates: [preferences.path] } : {}),
        signal,
      });
      if (!installation) {
        status.message = preferences.path
          ? "指定的 Claude Code 路径不可用，请修改路径或重置为系统识别。"
          : "未找到可运行的 Claude Code。安装完成后重新检测。";
        return status;
      }
      status.installation = installation;
      status.detection = "found";
      const environment = claudeEnvironment(
        this.environment,
        dirname(installation.path),
      );
      const help = await claudeCommand(
        installation.resolvedPath,
        ["--help"],
        environment,
        { signal },
      );
      const required = [
        "--restricted",
        "--tools",
        "--strict-mcp-config",
        "--mcp-config",
        "--settings",
        "--disable-slash-commands",
        "--no-chrome",
        "--no-session-persistence",
        "--input-format",
        "--output-format",
      ];
      if (help.code || required.some((flag) => !help.stdout.includes(flag))) {
        status.protocol = "unavailable";
        status.message =
          "当前 Claude Code 未提供所需的受限协议，请检查安装与配置。";
        return status;
      }
      if (signal.aborted) throw new Error("cancelled");
      await mkdir(this.cwd, { recursive: true, mode: 0o700 });
      // The CLI owns authentication; do not open credentials or copy them into the product.
      const authReply = await claudeCommand(
        installation.resolvedPath,
        ["auth", "status", "--json"],
        environment,
        { cwd: this.cwd, signal },
      );
      let auth: unknown = null;
      try {
        auth = JSON.parse(authReply.stdout);
      } catch {
        /* malformed and unavailable remain unknown */
      }
      if (![0, 1].includes(authReply.code)) auth = null;
      const a = object(auth);
      status.authentication =
        a.loggedIn === false
          ? "signedOut"
          : a.loggedIn === true && a.authMethod === "api_key"
            ? "apiKey"
            : "unknown";
      assertClaudeAccountPolicy(a, this.environment);
      rpc = new ClaudeRpc(installation.resolvedPath, claudeInspectionArgs(), {
        cwd: this.cwd,
        env: environment,
        signal,
      });
      const initialized = object(await rpc.request("initialize"));
      if (
        !Array.isArray(initialized.models) ||
        !initialized.account ||
        initialized.session_state !== "idle"
      )
        throw new Error("Unsupported initialization metadata");
      status.protocol = "available";
      const account = object(initialized.account);
      status.provider =
        typeof account.apiProvider === "string" &&
        /^[a-zA-Z0-9_-]{1,80}$/.test(account.apiProvider)
          ? account.apiProvider
          : null;
      status.authentication = claudeAuthentication(auth, account);
      const authRecord = object(auth);
      if (
        typeof authRecord.email === "string" ||
        typeof authRecord.organizationUuid === "string"
      )
        status.identity = createHash("sha256")
          .update(
            JSON.stringify({
              authentication: status.authentication,
              email: authRecord.email ?? null,
              organization: authRecord.organizationUuid ?? null,
              home: this.environment.HOME ?? null,
              config: this.environment.CLAUDE_CONFIG_DIR ?? null,
            }),
          )
          .digest("hex");
      status.configurationSources = ["产品受限配置", "CLI 认证状态"];

      for (const model of initialized.models.slice(0, 100)) {
        const item = object(model),
          resolved = item.resolvedModel ?? item.value;
        if (validClaudeModel(resolved) && !status.models.includes(resolved))
          status.models.push(resolved);
        if (item.value === "default" && validClaudeModel(resolved))
          status.model = resolved;
        // Levels come from this installation's own help text and model entry; an alias
        // never lends its record to another resolved model, and absence stays unrecorded.
        if (!validClaudeModel(resolved) || resolved in status.efforts) continue;
        const effort = claudeEffortRecord(help.stdout, item, status.checkedAt);
        if (effort) status.efforts[resolved] = effort;
      }
      // Initialization metadata is not proof of the actual model-visible tool boundary.
      status.message =
        status.authentication === "signedOut"
          ? "请先在终端完成 Claude Code 登录。"
          : status.authentication === "unknown"
            ? "已找到 Claude Code，认证来源暂无法确认。"
            : "已读取本地登录信息，尚未测试模型调用。";
    } catch (error) {
      status.protocol = "unavailable";
      if (!status.installation) status.detection = "failed";
      status.message = signal.aborted
        ? "Claude Code 检测已取消。"
        : error instanceof TransportError
          ? error.message
          : "Claude Code 未能完成连接检测，请检查安装或配置后重试。";
    } finally {
      await rpc?.close();
    }
    if (signal.aborted || preferences.revision !== this.settings().revision) {
      status.protocol = "unknown";
      status.models = [];
      status.efforts = {};
      status.model = null;
      status.authentication = "unknown";
      status.message = "Claude Code 设置已变化，请重新检测。";
    }
    return status;
  }
}
