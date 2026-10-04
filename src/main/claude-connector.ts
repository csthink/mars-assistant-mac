import { widgetToolWireLimit } from "../shared/widget-generation-tool";
import { assertClaudePolicy } from "./claude-policy";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  realpath,
  lstat,
} from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import {
  defaultClaudeSettings,
  type ClaudeSettings,
  type ClaudeConnection,
  type ClaudeSetup,
  type ClaudeRun,
  type ClaudeStatus,
} from "../shared/claude";
import { ClaudeDetector } from "./claude";
import { sameEffort } from "../shared/protocol";
import { claudeEnvironment } from "./claude-discovery";
import { ClaudeRpc, ClaudeProtocolError } from "./claude-rpc";
import { claudeRunArgs, verifyClaudeRuntime } from "./claude-contract";
import { createClaudeBroker } from "./claude-broker";
import { runClaudeSession, claudeInput } from "./claude-session";
import { TransportError, type ChatMessage, type ToolCall } from "./transport";
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = () =>
  new TransportError(
    "auth",
    "Claude Code 的模型或认证来源与已确认配置不一致，请在设置中重新核对。",
  );
/**
 * The connection origin and fingerprint one detection yields for a model (the same record the
 * settings page confirms and the execution adapter compares against); throws the auth conflict
 * when the detection is not a usable connection.
 */
export function claudeConnectionOf(
  status: ClaudeStatus,
  environment: NodeJS.ProcessEnv,
  model: string,
): ClaudeConnection {
  if (
    status.protocol !== "available" ||
    !status.installation ||
    !status.identity ||
    !status.provider ||
    !["subscription", "apiKey", "external"].includes(status.authentication)
  )
    throw conflict();
  if (!status.models.includes(model)) throw conflict();
  let endpoint = "CLI 未报告默认地址";
  if (environment.ANTHROPIC_BASE_URL) {
    const url = new URL(environment.ANTHROPIC_BASE_URL);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw conflict();
    endpoint = url.origin + url.pathname;
  }
  const origin = {
    provider: status.provider,
    endpoint,
    authentication: status.authentication as ClaudeConnection["authentication"],
    identity: status.identity,
    instructions: [],
    configurationInstructions: [],
  };
  return { ...origin, fingerprint: digest({ origin, model }) };
}
/** The journal is product-owned. Unknown native execution state is never retried automatically. */
export class ClaudeConnector {
  private pending?: { setup: ClaudeSetup; expires: number; revision: number };
  constructor(
    private root: string,
    private helper: string,
    private environment = process.env,
    private settings: () => ClaudeSettings = () => defaultClaudeSettings,
  ) {}
  private async inspect(model?: string, effort: string | null = null) {
    const preferences = this.settings();
    if (!preferences.enabled)
      throw new TransportError("unsupported", "Claude Code 整合已关闭。");
    const status = await new ClaudeDetector(
      join(this.root, "inspection"),
      this.environment,
      this.settings,
    ).detect();
    const selected = model ?? status.model;
    if (!selected) throw conflict();
    const configuration = claudeConnectionOf(
      status,
      this.environment,
      selected,
    );
    // Re-checked against this detection's help text and metadata on every start: a level the
    // installation no longer offers stops the operation instead of running without it.
    if (effort !== null && !status.efforts[selected]?.levels.includes(effort))
      throw new TransportError(
        "unsupported",
        `当前 Claude Code 安装不支持所选推理强度档位 ${effort}，未发送。请在设置中重新检测，或为该对话改选档位。`,
      );
    await verifyClaudeRuntime(
      status.installation!,
      selected,
      this.helper,
      undefined,
      effort,
    );
    if (
      preferences.revision !== this.settings().revision ||
      !this.settings().enabled
    )
      throw conflict();
    return {
      installation: status.installation!,
      model: selected,
      configuration,
      revision: preferences.revision,
      effort: status.efforts[selected] ?? null,
    };
  }
  async prepare(model?: string): Promise<ClaudeSetup> {
    this.pending = undefined;
    const current = await this.inspect(model);
    const setup = {
      token: randomUUID(),
      model: current.model,
      configuration: current.configuration,
      effortRecord: current.effort,
    };
    this.pending = {
      setup,
      expires: Date.now() + 300000,
      revision: current.revision,
    };
    return setup;
  }
  async accept(token: string): Promise<ClaudeSetup> {
    const pending = this.pending;
    this.pending = undefined;
    if (
      !pending ||
      pending.setup.token !== token ||
      pending.expires < Date.now() ||
      pending.revision !== this.settings().revision
    )
      throw conflict();
    const current = await this.inspect(pending.setup.model);
    if (
      current.configuration.fingerprint !==
      pending.setup.configuration.fingerprint
    )
      throw conflict();
    // The acceptance-time read-back decides the record; an unchanged record keeps the prepared copy.
    return sameEffort(pending.setup.effortRecord, current.effort)
      ? pending.setup
      : { ...pending.setup, effortRecord: current.effort };
  }
  async run(options: {
    model: string;
    configuration: ClaudeConnection;
    messages: ChatMessage[];
    signal: AbortSignal;
    onDelta: (text: string) => void;
    onSession: (run: ClaudeRun) => Promise<void>;
    budget: number;
    invoke?: (call: ToolCall, signal: AbortSignal) => Promise<string>;
    generation?: boolean;
    onProgress?: () => void;
    resume?: ClaudeRun;
    /** Level fixed in the turn snapshot; null runs at the CLI's own default. */
    effort?: string | null;
  }) {
    options.signal.throwIfAborted();
    claudeInput(options.messages, options.budget);
    const effort = options.effort ?? null;
    const current = await this.inspect(options.model, effort);
    if (current.configuration.fingerprint !== options.configuration.fingerprint)
      throw conflict();
    options.signal.throwIfAborted();
    const previous = options.resume;
    const canonicalRoot = await realpath(this.root);
    const cwd = previous?.cwd ?? join(canonicalRoot, randomUUID());
    const rel = relative(canonicalRoot, cwd);
    if (isAbsolute(rel) || rel.startsWith("..") || !rel || rel.includes("/"))
      throw conflict();
    if (
      previous &&
      (previous.fingerprint !== current.configuration.fingerprint ||
        previous.model !== current.model ||
        previous.provider !== current.configuration.provider ||
        (await realpath(cwd)) !== cwd)
    )
      throw conflict();
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const journalPath = join(cwd, "outcome.json");
    let resume = false;
    if (previous) {
      let saved: { run: ClaudeRun; state: string; text: string };
      try {
        if (
          !(await lstat(journalPath)).isFile() ||
          (await lstat(journalPath)).isSymbolicLink()
        )
          throw conflict();
        saved = JSON.parse(await readFile(journalPath, "utf8"));
      } catch {
        throw new TransportError(
          "protocol",
          "无法确认原 Claude Code 回合的执行状态，未自动重放。请保留部分回答并新建对话。",
        );
      }
      if (
        JSON.stringify(saved.run) !== JSON.stringify(previous) ||
        typeof saved.text !== "string" ||
        saved.text.length > 2000000
      )
        throw conflict();
      if (saved.state === "completed") {
        await options.onSession(previous);
        options.onDelta(saved.text);
        return;
      }
      if (saved.state !== "stopped" && saved.state !== "failed")
        throw new TransportError(
          "protocol",
          "原 Claude Code 回合状态尚未确认，未自动重放。请保留部分回答并新建对话。",
        );
      resume = true;
    }
    const run: ClaudeRun = {
      threadId: previous?.threadId ?? randomUUID(),
      turnId: randomUUID(),
      cwd,
      model: current.model,
      provider: current.configuration.provider,
      fingerprint: current.configuration.fingerprint,
      installation: current.installation,
    };
    let text = "";
    const save = async (state: string) => {
      const temporary = join(cwd, `outcome-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify({ run, state, text }), {
        mode: 0o600,
      });
      await rename(temporary, journalPath);
    };
    await save("running");
    const broker = options.invoke
      ? await createClaudeBroker(
          this.helper,
          options.invoke,
          options.signal,
          options.generation,
        )
      : undefined;
    let rpc: ClaudeRpc | undefined;
    const closeOnAbort = () => {
      void rpc?.close().catch(() => {});
    };
    try {
      await assertClaudePolicy(this.environment);
      options.signal.throwIfAborted();
      rpc = new ClaudeRpc(
        current.installation.resolvedPath,
        claudeRunArgs(
          current.model,
          run.threadId,
          broker?.config ?? { mcpServers: {} },
          resume,
          effort,
          options.generation,
        ),
        {
          cwd,
          frameLimit: options.generation ? widgetToolWireLimit : undefined,
          env: claudeEnvironment(
            this.environment,
            dirname(current.installation.path),
          ),
        },
      );
      options.signal.addEventListener("abort", closeOnAbort, { once: true });
      options.signal.throwIfAborted();
      await rpc.request("initialize");
      await options.onSession(run);
      await runClaudeSession({
        rpc,
        run,
        messages: options.messages,
        tools: !!broker,
        generation: options.generation,
        onProgress: options.onProgress,
        signal: options.signal,
        budget: options.budget,
        onSession: async () => {},
        onDelta: (delta) => {
          text += delta;
          options.onDelta(delta);
        },
      });
      await rpc.close();
      await save("completed");
    } catch (error) {
      // A terminal journal requires verified process exit; a failed close leaves running/unknown.
      await rpc?.close();
      await save(options.signal.aborted ? "stopped" : "failed");
      if (error instanceof ClaudeProtocolError)
        throw new TransportError(
          "protocol",
          "Claude Code 进程或协议连接已中断，已保留部分回答。请核对运行记录后重试。",
        );
      throw error;
    } finally {
      options.signal.removeEventListener("abort", closeOnAbort);
      try {
        await rpc?.close();
      } finally {
        await broker?.close();
      }
    }
  }
}
