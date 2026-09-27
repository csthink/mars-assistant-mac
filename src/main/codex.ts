import { defaultCodexSettings, type CodexSettings } from "../shared/codex";
import {
  codexInventory,
  codexPolicyArgs,
  initializeRestrictedCodex,
  type CodexInventory,
} from "./codex-policy";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodexInstallation, CodexStatus } from "../shared/codex";
import {
  effortLevelLimit,
  validEffortLevel,
  type EffortRecord,
} from "../shared/protocol";
import { codexEnvironment, discoverCodex } from "./codex-discovery";
import { CodexRpc, CodexRpcError } from "./codex-rpc";

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function label(value: unknown): string | null {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:\/()+\[\]-]{0,159}$/.test(value)
    ? value
    : null;
}
/**
 * Levels come from the model entry of model/list. The default honours the user's configured
 * model_reasoning_effort when the model advertises that level, else the model's own default;
 * a default outside the advertised set stays unrecorded rather than guessed.
 */
export function codexEffortRecord(
  item: Record<string, unknown>,
  configured: unknown,
  at: string,
): EffortRecord | null {
  const options = item.supportedReasoningEfforts;
  if (
    !Array.isArray(options) ||
    !options.length ||
    options.length > effortLevelLimit
  )
    return null;
  const levels = options.map((option) => record(option).reasoningEffort);
  if (!levels.every(validEffortLevel) || new Set(levels).size !== levels.length)
    return null;
  const defaultLevel = [configured, item.defaultReasoningEffort].find(
    (value): value is string =>
      typeof value === "string" && levels.includes(value),
  );
  return {
    levels,
    defaultLevel: defaultLevel ?? null,
    source: "codex-model-list",
    recordedAt: at,
  };
}
export interface DetectionRpc {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string): void;
  close(): Promise<void>;
}
/** No threads, model turns, token refreshes, login writes, or MCP connections are requested here. */
export async function inspectCodex(
  installation: CodexInstallation,
  rpc: DetectionRpc,
): Promise<CodexStatus> {
  const status: CodexStatus = {
    installation,
    detection: "found",
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
  try {
    const initialized = record(
      await rpc.request("initialize", {
        clientInfo: { name: "csthink_assistant", version: "0.1.0" },
      }),
    );
    if (typeof initialized.userAgent !== "string")
      throw new CodexRpcError("malformed");
    rpc.notify("initialized");
    status.protocol = "available";
    const configReply = record(
      await rpc.request("config/read", { includeLayers: true }),
    );
    codexInventory(configReply);
    const config = record(configReply.config);
    status.model = label(config.model);
    status.provider = label(config.model_provider);
    status.configurationSources = [
      ...new Set(
        (Array.isArray(configReply.layers) ? configReply.layers : [])
          .map((layer) => label(record(record(layer).name).type))
          .filter((v): v is string => !!v),
      ),
    ];
    try {
      const account = record(
        await rpc.request("account/read", { refreshToken: false }),
      );
      const type = record(account.account).type;
      if (type === "apiKey") status.authentication = "apiKey";
      else if (type === "chatgpt") status.authentication = "chatgpt";
      else if (type === "amazonBedrock") status.authentication = "external";
      else if (account.account === null && account.requiresOpenaiAuth === true)
        status.authentication = "signedOut";
      // A custom provider must not be mislabeled as the unrelated cached ChatGPT account.
      if (
        status.provider &&
        status.provider !== "openai" &&
        (status.authentication === "chatgpt" ||
          status.authentication === "apiKey")
      )
        status.authentication = "unknown";
    } catch (error) {
      if (!(error instanceof CodexRpcError) || error.code !== -32601)
        throw error;
    }
    try {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 8; page++) {
        const reply = record(
          await rpc.request("model/list", {
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        );
        for (const model of Array.isArray(reply.data) ? reply.data : []) {
          const item = record(model);
          const id = label(item.model);
          if (id && !status.models.includes(id)) status.models.push(id);
          if (!status.model && item.isDefault === true) status.model = id;
          const effort = id
            ? codexEffortRecord(
                item,
                config.model_reasoning_effort,
                status.checkedAt,
              )
            : null;
          if (id && effort && !(id in status.efforts))
            status.efforts[id] = effort;
        }
        if (typeof reply.nextCursor !== "string" || !reply.nextCursor) break;
        if (seen.has(reply.nextCursor)) break;
        cursor = reply.nextCursor;
        seen.add(cursor);
      }
    } catch (error) {
      if (!(error instanceof CodexRpcError) || error.code !== -32601)
        throw error;
    }
    status.message =
      status.authentication === "signedOut"
        ? "请先在终端完成 Codex 登录。"
        : status.authentication === "unknown"
          ? "已找到 Codex，认证来源暂无法确认。"
          : "已读取本地登录信息，尚未测试模型调用。";
  } catch (error) {
    status.protocol = "unavailable";
    status.message =
      error instanceof CodexRpcError && error.code === "timeout"
        ? "Codex 检测超时，请稍后重新检测。"
        : "Codex 未能完成连接检测，请检查本地安装或配置后重试。";
  } finally {
    await rpc.close();
  }
  return status;
}
export class CodexDetector {
  private pending: Promise<CodexStatus> | undefined;
  private pendingRevision = -1;
  private active = new Set<CodexRpc>();
  cancel() {
    for (const rpc of this.active) void rpc.close().catch(() => {});
    this.active.clear();
  }
  private track(rpc: CodexRpc) {
    this.active.add(rpc);
    return rpc;
  }
  private async close(rpc: CodexRpc) {
    try {
      await rpc.close();
    } finally {
      this.active.delete(rpc);
    }
  }

  constructor(
    private cwd: string,
    private environment = process.env,
    private settings: () => CodexSettings = () => defaultCodexSettings,
  ) {}
  detect(): Promise<CodexStatus> {
    const settings = this.settings();
    if (this.pending && this.pendingRevision === settings.revision)
      return this.pending;
    const pending = this.run(settings).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pendingRevision = settings.revision;
    this.pending = pending;
    return pending;
  }
  private async run(settings: CodexSettings): Promise<CodexStatus> {
    const installation = settings.enabled
      ? await discoverCodex({
          environment: this.environment,
          home: this.environment.HOME,
          ...(settings.path ? { candidates: [settings.path] } : {}),
        })
      : null;
    if (
      settings.revision !== this.settings().revision ||
      settings.enabled !== this.settings().enabled
    )
      return this.detect();
    if (!installation)
      return {
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
        message: !settings.enabled
          ? "Codex 整合已关闭。"
          : settings.path
            ? "指定的 Codex 路径不可用，请修改路径或重置为系统识别。"
            : "未找到可运行的 Codex。安装完成后重新检测。",
      };
    await mkdir(this.cwd, { recursive: true, mode: 0o700 });
    if (
      settings.revision !== this.settings().revision ||
      !this.settings().enabled
    )
      return this.detect();
    const rpc = this.track(
      new CodexRpc(installation.resolvedPath, ["app-server"], {
        cwd: this.cwd,
        env: codexEnvironment(this.environment, dirname(installation.path)),
      }),
    );
    let inventory: CodexInventory | undefined;
    const status = await inspectCodex(installation, {
      request: async (method, params) => {
        const reply = await rpc.request(method, params);
        if (method === "config/read") inventory = codexInventory(reply);
        return reply;
      },
      notify: (method) => rpc.notify(method),
      close: () => this.close(rpc),
    });
    if (
      settings.revision !== this.settings().revision ||
      !this.settings().enabled
    )
      return this.detect();
    if (status.protocol !== "available" || !inventory) return status;
    const restricted = this.track(
      new CodexRpc(
        installation.resolvedPath,
        codexPolicyArgs(installation.resolvedPath, this.cwd, inventory),
        {
          cwd: this.cwd,
          env: codexEnvironment(this.environment, dirname(installation.path)),
        },
      ),
    );
    try {
      await initializeRestrictedCodex(
        restricted,
        installation.resolvedPath,
        this.cwd,
        inventory,
      );
      status.restriction = "verified";
    } catch {
      status.restriction = "conflict";
      status.message =
        "Codex 配置限制未能通过核对，暂不能发起会话。请检查配置后重新检测。";
    } finally {
      await this.close(restricted);
    }
    return status;
  }
}
