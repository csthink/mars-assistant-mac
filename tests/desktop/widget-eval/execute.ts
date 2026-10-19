/**
 * Runs one evaluation attempt through the product's own generation path: the business
 * service Store, the main-process WidgetGenerationRunner (deadline, progress, fixed-tool
 * invoke with validWidgetSubmission and compileWidget, candidate receipt) and the API
 * executor runApiWidgetGeneration, exactly as the client dispatches an API connection.
 * Only observation is added around the product calls; nothing here decides acceptance.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { Store } from "../../../src/service/store";
import type { Command, HostCommand } from "../../../src/shared/protocol";
import {
  WidgetGenerationRunner,
  runApiWidgetGeneration,
  widgetGenerationTool,
  type GenerationExecution,
} from "../../../src/main/widget-generation";
import { compileWidget } from "../../../src/main/widget-build";
import {
  streamChat,
  TransportError,
  type Endpoint,
} from "../../../src/main/transport";
import {
  validWidgetSubmission,
  widgetSubmitToolName,
  widgetToolWireLimit,
} from "../../../src/shared/widget-generation-tool";
import type { BuiltWidget } from "../../../src/shared/widget";
import type { ModelResponse } from "./model";

export const buildWorker = () => resolve("dist/widget-build-worker.cjs");

/** Serves one recorded or synthesized provider response to every request, byte for byte. */
export async function responseServer(response: ModelResponse) {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests++;
      res.writeHead(response.status, { "content-type": response.contentType });
      if (response.truncated) {
        res.write(response.body);
        // Let the bytes leave before the connection is cut, as a dropped provider stream would.
        setTimeout(() => res.socket?.destroy(), 20);
      } else res.end(response.body);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    get requests() {
      return requests;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** What the product's stream parser sees in a response: tool calls and text, or its error. */
export interface ResponseView {
  calls: { name: string; argumentBytes: number }[];
  textChars: number;
}
export async function inspectResponse(
  response: ModelResponse,
): Promise<ResponseView | null> {
  const server = await responseServer(response);
  try {
    let text = 0;
    const result = await streamChat(
      { baseUrl: server.baseUrl, model: "inspect", apiKey: "inspect" },
      [{ role: "user", content: "inspect" }],
      new AbortController().signal,
      (delta) => (text += delta.length),
      {
        tools: [widgetGenerationTool],
        toolArgumentsLimit: widgetToolWireLimit,
        managedDeadline: true,
      },
    );
    return {
      calls: result.calls.map((c) => ({
        name: c.function.name,
        argumentBytes: Buffer.byteLength(c.function.arguments),
      })),
      textChars: text,
    };
  } catch {
    return null;
  } finally {
    await server.close();
  }
}

export interface Execution {
  /** The fixed tool reached the product's candidate receiver. */
  invoked: boolean;
  argumentsValid: boolean | null;
  packageSource: string | null;
  compile:
    | { ok: true; digest: string; build: BuiltWidget }
    | { ok: false; message: string }
    | null;
  taskState: string;
  taskError: string | null;
  candidateDigest: string | null;
  /** Error class of a TransportError leaving the API executor, when one did. */
  thrownClass: string | null;
  durationMs: number;
}

export async function executeAttempt(input: {
  prompt: string;
  endpoint: Endpoint;
  waitMinutes?: number;
}): Promise<Execution> {
  mkdirSync(".test-data/disposable", { recursive: true });
  const root = mkdtempSync(resolve(".test-data/disposable/widget-eval-"));
  const store = new Store(root);
  const command = (c: Command) => {
    const r = store.execute(c, "main");
    if (!r.ok) throw new Error(`evaluation setup: ${r.message}`);
    return r;
  };
  const host = async (c: HostCommand) => store.execute(c, "main", "host");
  const connectionId = randomUUID(),
    draftId = randomUUID();
  let invoked = false,
    argumentsValid: boolean | null = null,
    packageSource: string | null = null,
    compile: Execution["compile"] = null,
    thrownClass: string | null = null;
  const run = async (options: GenerationExecution) => {
    try {
      await runApiWidgetGeneration(input.endpoint, {
        ...options,
        invoke: async (call, signal) => {
          if (call.function.name === widgetSubmitToolName && !invoked) {
            invoked = true;
            try {
              const args: unknown = JSON.parse(call.function.arguments);
              argumentsValid = validWidgetSubmission(args);
              if (argumentsValid)
                packageSource = (args as { package: string }).package;
            } catch {
              argumentsValid = false;
            }
          }
          return options.invoke(call, signal);
        },
      });
    } catch (error) {
      if (error instanceof TransportError) thrownClass = error.errorClass;
      throw error;
    }
  };
  const build = async (source: string) => {
    try {
      const built = await compileWidget(source, buildWorker());
      compile ??= { ok: true, digest: built.digest, build: built };
      return built;
    } catch (error) {
      compile ??= {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  };
  const runner = new WidgetGenerationRunner(host, run, () => {}, build);
  try {
    command({
      type: "upsertConnection",
      id: connectionId,
      name: "Evaluation",
      provider: "custom",
      baseUrl: input.endpoint.baseUrl,
      model: input.endpoint.model,
      secretRef: randomUUID(),
      imageInput: "unknown",
      contextChars: null,
      revision: 0,
    });
    if (input.waitMinutes !== undefined)
      command({ type: "setWidgetGenerationWait", minutes: input.waitMinutes });
    command({
      type: "createWidgetDraft",
      id: draftId,
      name: "Evaluation",
      sourceConversationId: null,
    });
    command({
      type: "saveWidgetDraft",
      id: draftId,
      name: "Evaluation",
      input: input.prompt,
      revision: 0,
    });
    command({
      type: "submitWidgetGeneration",
      draftId,
      connectionId,
      model: input.endpoint.model,
      revision: 1,
      requestId: randomUUID(),
    });
    const started = performance.now();
    runner.adopt(store.snapshot(), 0);
    const task = () => store.snapshot().widgetGeneration!.tasks[0];
    while (runner.active) await wait(5);
    const durationMs = Math.round(performance.now() - started);
    const t = task();
    const candidate = store
      .snapshot()
      .widgetGeneration!.candidates.find((c) => c.taskId === t.id);
    return {
      invoked,
      argumentsValid,
      packageSource,
      compile,
      taskState: t.state,
      taskError: t.error,
      candidateDigest: candidate?.digest ?? null,
      thrownClass,
      durationMs,
    };
  } finally {
    await runner.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
