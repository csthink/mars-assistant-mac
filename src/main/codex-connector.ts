import { widgetToolWireLimit } from "../shared/widget-generation-tool";
import { defaultCodexSettings, type CodexSettings } from "../shared/codex";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import type { CodexConnection, CodexSetup, CodexRun } from "../shared/codex";
import { codexEnvironment, discoverCodex } from "./codex-discovery";
import { CodexRpc } from "./codex-rpc";
import {
  codexInventory,
  codexPolicyArgs,
  initializeRestrictedCodex,
  type CodexInventory,
} from "./codex-policy";
import { inspectCodex, record } from "./codex";
import { sameEffort } from "../shared/protocol";
import { verifyCodexRuntime } from "./codex-contract";
import {
  codexInstructionSources,
  startCodexThread,
  type CodexThread,
} from "./codex-session";
import { TransportError } from "./transport";
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = () =>
  new TransportError(
    "auth",
    "Codex 的模型、认证来源或个人规则与已确认配置不一致，请在设置中重新核对。",
  );
/**
 * The connection origin and fingerprint one restricted app-server yields for a started thread
 * (the record the settings page confirms and the Reviewer adapter compares after its own
 * thread start): provider, endpoint, authentication, account identity digest and the identities
 * of every instruction source. Throws the auth conflict or an unsupported error like open().
 */
export async function codexConnectionOf(options: {
  effectiveConfig: Record<string, unknown>;
  account: Record<string, unknown>;
  thread: CodexThread;
  authentication: CodexConnection["authentication"];
  environment: NodeJS.ProcessEnv;
}): Promise<CodexConnection> {
  const { effectiveConfig, account, thread } = options;
  for (const key of [
    "model_instructions_file",
    "experimental_compact_prompt_file",
  ]) {
    const path = effectiveConfig[key];
    if (typeof path === "string" && path) {
      const resolved = await realpath(path);
      if (
        !thread.instructions.some(
          (source) => source.path === path || source.path === resolved,
        )
      ) {
        thread.instructions.push(
          ...(await codexInstructionSources([resolved])),
        );
      }
    }
  }
  const configurationInstructions = [
    "instructions",
    "developer_instructions",
    "compact_prompt",
  ].flatMap((field) => {
    const value = effectiveConfig[field];
    if (value == null || value === "") return [];
    if (typeof value !== "string") throw conflict();
    return [
      { field, sha256: createHash("sha256").update(value).digest("hex") },
    ];
  });
  const providerConfig = record(
    record(effectiveConfig.model_providers)[thread.provider],
  );
  if (record(providerConfig.auth).command != null)
    throw new TransportError(
      "unsupported",
      "该 Codex 提供方配置了额外认证命令，尚未完成受控接入核对。",
    );
  const configuredEndpoint =
    providerConfig.base_url ??
    (options.authentication === "chatgpt"
      ? effectiveConfig.chatgpt_base_url
      : effectiveConfig.openai_base_url);
  let endpoint = "CLI 未报告默认地址";
  if (configuredEndpoint != null) {
    if (typeof configuredEndpoint !== "string") throw conflict();
    const url = new URL(configuredEndpoint);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new TransportError(
        "unsupported",
        "Codex 连接地址包含尚未支持的配置，请先核对提供方设置。",
      );
    endpoint = url.origin + url.pathname;
  }
  const identity = digest({
    type: account.type,
    workspace: effectiveConfig.forced_chatgpt_workspace_id ?? null,
    email: typeof account.email === "string" ? account.email : null,
    home: options.environment.HOME ?? null,
    codexHome: options.environment.CODEX_HOME ?? null,
  });
  const origin = {
    provider: thread.provider,
    endpoint,
    authentication: options.authentication,
    identity,
    instructions: thread.instructions,
    configurationInstructions,
  };
  return { ...origin, fingerprint: digest({ origin, model: thread.model }) };
}
export class CodexConnector {
  private pending?: {
    setup: CodexSetup;
    expires: number;
    settingsRevision: number;
  };
  constructor(
    private root: string,
    private environment = process.env,
    private settings: () => CodexSettings = () => defaultCodexSettings,
  ) {}
  async open(
    expectedModel?: string,
    tools: boolean | "generation" = false,
    resume?: CodexRun,
    effort: string | null = null,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const preferences = this.settings();
    if (!preferences.enabled)
      throw new TransportError(
        "unsupported",
        "Codex 整合已关闭，请先在设置中启用。",
      );
    const installation = await discoverCodex({
      ...(preferences.path ? { candidates: [preferences.path] } : {}),
      environment: this.environment,
      home: this.environment.HOME,
    });
    if (!installation)
      throw new TransportError(
        "unsupported",
        "未找到可运行的 Codex，请安装后重新检测。",
      );
    const cwd = resume?.cwd ?? join(this.root, randomUUID());
    const rel = relative(this.root, cwd);
    if (isAbsolute(rel) || rel.startsWith("..") || !rel) throw conflict();
    if (resume && (await realpath(cwd)) !== cwd) throw conflict();
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const env = codexEnvironment(this.environment, dirname(installation.path));
    const inspection = new CodexRpc(installation.resolvedPath, ["app-server"], {
      cwd,
      env,
    });
    let inventory: CodexInventory | undefined;
    const closeInspection = () => {
      void inspection.close().catch(() => {});
    };
    signal?.addEventListener("abort", closeInspection, { once: true });
    const status = await inspectCodex(installation, {
      request: async (method, params) => {
        const r = await inspection.request(method, params);
        if (method === "config/read") inventory = codexInventory(r);
        return r;
      },
      notify: (method) => inspection.notify(method),
      close: () => inspection.close(),
    }).finally(() => signal?.removeEventListener("abort", closeInspection));
    signal?.throwIfAborted();
    if (
      status.protocol !== "available" ||
      !inventory ||
      !status.model ||
      !["chatgpt", "apiKey", "external"].includes(status.authentication)
    )
      throw conflict();
    if (
      expectedModel &&
      expectedModel !== status.model &&
      !status.models.includes(expectedModel)
    )
      throw conflict();
    const selectedModel = expectedModel ?? status.model;
    // Re-checked against this detection's model/list on every start.
    if (
      effort !== null &&
      !status.efforts[selectedModel]?.levels.includes(effort)
    )
      throw new TransportError(
        "unsupported",
        `当前 Codex 安装的模型 ${selectedModel} 不支持所选推理强度档位 ${effort}，未发送。请在设置中重新检测，或为该对话改选档位。`,
      );
    await verifyCodexRuntime(installation, selectedModel, this.environment);
    signal?.throwIfAborted();
    const rpc = new CodexRpc(
      installation.resolvedPath,
      codexPolicyArgs(installation.resolvedPath, cwd, inventory),
      { cwd, env },
      5000,
      tools === "generation" ? widgetToolWireLimit : undefined,
    );
    const closeOnAbort = () => {
      void rpc.close().catch(() => {});
    };
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    try {
      signal?.throwIfAborted();
      const effectiveConfig = await initializeRestrictedCodex(
        rpc,
        installation.resolvedPath,
        cwd,
        inventory,
      );
      const accountReply = record(
        await rpc.request("account/read", { refreshToken: false }),
      );
      const account = record(accountReply.account);
      if (
        account.type !== status.authentication &&
        !(
          account.type === "amazonBedrock" &&
          status.authentication === "external"
        )
      )
        throw conflict();
      const thread = await startCodexThread(
        rpc,
        cwd,
        selectedModel,
        status.provider ?? undefined,
        tools,
        resume,
        effort,
      );
      if (thread.provider !== "openai" && status.authentication === "chatgpt")
        throw conflict();
      const configuration = await codexConnectionOf({
        effectiveConfig,
        account,
        thread,
        authentication:
          status.authentication as CodexConnection["authentication"],
        environment: this.environment,
      });
      if (
        this.settings().revision !== preferences.revision ||
        !this.settings().enabled
      )
        throw conflict();
      signal?.throwIfAborted();
      return {
        rpc,
        thread,
        configuration,
        installation,
        cwd,
        settingsRevision: preferences.revision,
        effort: status.efforts[thread.model] ?? null,
      };
    } catch (error) {
      await rpc.close();
      throw error;
    } finally {
      signal?.removeEventListener("abort", closeOnAbort);
    }
  }
  async prepare(model?: string): Promise<CodexSetup> {
    this.pending = undefined;
    const connection = await this.open(model);
    try {
      const setup = {
        token: randomUUID(),
        model: connection.thread.model,
        configuration: connection.configuration,
        effortRecord: connection.effort,
      };
      this.pending = {
        setup,
        expires: Date.now() + 5 * 60_000,
        settingsRevision: connection.settingsRevision,
      };
      return setup;
    } finally {
      await connection.rpc.close();
    }
  }
  async accept(token: string): Promise<CodexSetup> {
    const pending = this.pending;
    this.pending = undefined;
    if (
      !pending ||
      pending.setup.token !== token ||
      pending.expires < Date.now() ||
      pending.settingsRevision !== this.settings().revision
    )
      throw conflict();
    const current = await this.open(pending.setup.model);
    try {
      if (
        current.configuration.fingerprint !==
        pending.setup.configuration.fingerprint
      )
        throw conflict();
    } finally {
      await current.rpc.close();
    }
    // The acceptance-time read-back decides the record; an unchanged record keeps the prepared copy.
    return sameEffort(pending.setup.effortRecord, current.effort)
      ? pending.setup
      : { ...pending.setup, effortRecord: current.effort };
  }
  async openApproved(
    model: string,
    configuration: CodexConnection,
    tools: boolean | "generation",
    resume?: CodexRun,
    effort: string | null = null,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (
      resume &&
      (resume.fingerprint !== configuration.fingerprint ||
        resume.model !== model ||
        resume.provider !== configuration.provider)
    )
      throw conflict();
    const connection = await this.open(model, tools, resume, effort, signal);
    if (connection.configuration.fingerprint !== configuration.fingerprint) {
      await connection.rpc.close();
      throw conflict();
    }
    return connection;
  }
}
