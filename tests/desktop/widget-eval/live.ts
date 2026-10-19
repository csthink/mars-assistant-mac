/**
 * Live evaluation against real providers, only under an explicit authorization file and
 * CSTHINK_REAL_CALLS_AUTHORIZED=1. Every attempt goes through the same product path as replay;
 * a local forwarding proxy between the executor and the provider records the provider's
 * response (never the request headers), so each live attempt also becomes a replayable fixture.
 * The API key is read from the environment variable the authorization names, is held in memory
 * only and is removed from anything recorded.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute } from "node:path";
import { validGenerationMinutes } from "../../../src/shared/widget-generation";
import { endpointUrl } from "../../../src/main/transport";
import { scoreExecution, type Executed } from "./evaluate";
import { executeAttempt, inspectResponse } from "./execute";
import type {
  Fixture,
  ModelResponse,
  RecordedOutcome,
  RequirementSet,
} from "./model";

export interface LiveSelection {
  provider: string;
  baseUrl: string;
  model: string;
  /** Name of the environment variable holding the key; the value is never written anywhere. */
  keyEnv: string;
}
export interface LiveAuthorization {
  task: "widget-generation-evaluation";
  authorized: true;
  evidence: string;
  requirements: string[];
  repeats: number;
  waitMinutes: number;
  /** Exactly selections × requirements × repeats: one provider request per attempt, no retries. */
  maxCalls: number;
  /**
   * After this many consecutive provider-stage failures (timeouts, refusals, broken streams) a
   * selection's remaining attempts are not sent, so an outage does not spend the whole budget.
   */
  stopAfterProviderFailures: number;
  selections: LiveSelection[];
}

const notRun = (reason: string): never => {
  throw new Error(`NOT RUN: ${reason}`);
};
/** Validates the complete authorization before any client, request or evidence write. */
export function liveAuthorization(
  value: unknown,
  enabled: string | undefined,
  env: Record<string, string | undefined>,
  set: RequirementSet,
): LiveAuthorization {
  if (enabled !== "1") notRun("CSTHINK_REAL_CALLS_AUTHORIZED=1 is required");
  const a = value as Partial<LiveAuthorization>;
  if (!a || typeof a !== "object" || Array.isArray(a))
    notRun("authorization must be an object");
  if (a.task !== "widget-generation-evaluation" || a.authorized !== true)
    notRun("authorization is for another task or not granted");
  if (typeof a.evidence !== "string" || !isAbsolute(a.evidence))
    notRun("evidence must be an absolute directory");
  const ids = set.requirements.map((r) => r.id);
  if (
    !Array.isArray(a.requirements) ||
    !a.requirements.length ||
    new Set(a.requirements).size !== a.requirements.length ||
    a.requirements.some((r) => !ids.includes(r))
  )
    notRun("requirements must be distinct ids of the standard set");
  if (!Number.isInteger(a.repeats) || a.repeats! < 1 || a.repeats! > 5)
    notRun("repeats must be 1 to 5");
  if (!validGenerationMinutes(a.waitMinutes))
    notRun("waitMinutes must be the product's 5 to 30 minutes");
  if (!Array.isArray(a.selections) || !a.selections.length)
    notRun("at least one provider selection is required");
  const seen = new Set<string>();
  for (const s of a.selections!) {
    if (
      !s ||
      typeof s.provider !== "string" ||
      !/^[a-z][a-z0-9-]{1,31}$/.test(s.provider) ||
      typeof s.model !== "string" ||
      !s.model.trim() ||
      typeof s.baseUrl !== "string" ||
      !/^(https:\/\/|http:\/\/127\.0\.0\.1:\d+\/)/.test(s.baseUrl) ||
      typeof s.keyEnv !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(s.keyEnv)
    )
      notRun("each selection needs provider, https baseUrl, model and keyEnv");
    if (seen.has(`${s.provider}/${s.model}`))
      notRun("duplicate provider and model selection");
    seen.add(`${s.provider}/${s.model}`);
    if (!env[s.keyEnv]) notRun(`${s.keyEnv} is not set`);
  }
  if (
    !Number.isInteger(a.stopAfterProviderFailures) ||
    a.stopAfterProviderFailures! < 1
  )
    notRun("stopAfterProviderFailures must be a positive integer");
  if (a.maxCalls !== a.selections!.length * a.requirements!.length * a.repeats!)
    notRun("maxCalls must equal selections x requirements x repeats");
  return a as LiveAuthorization;
}

/**
 * Removes the key from recorded text. Error bodies and messages also lose anything shaped like
 * a provider key, since providers echo masked keys there; a successful model output keeps its
 * exact bytes apart from the key itself, so that it still replays to the same judgement.
 */
export function redact(text: string, key: string, errorText = true) {
  const exact = key ? text.split(key).join("[redacted]") : text;
  return errorText
    ? exact.replace(/\b(sk-or-v1|sk)-[A-Za-z0-9_-]{8,}/g, "$1-[redacted]")
    : exact;
}

/** Token usage when the provider reports it in the stream; null otherwise. */
export function streamUsage(body: string) {
  let usage: { promptTokens: number; completionTokens: number } | null = null;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    try {
      const u = (
        JSON.parse(line.slice(6)) as { usage?: Record<string, unknown> }
      ).usage;
      if (
        u &&
        Number.isInteger(u.prompt_tokens) &&
        Number.isInteger(u.completion_tokens)
      )
        usage = {
          promptTokens: Number(u.prompt_tokens),
          completionTokens: Number(u.completion_tokens),
        };
    } catch {
      // A malformed line is the product parser's concern, not usage accounting.
    }
  }
  return usage;
}

/** Forwards the executor's one request to the provider and records the response bytes. */
export async function recordingProxy(upstreamBase: string, key: string) {
  const upstream = endpointUrl(upstreamBase, "chat/completions");
  let requests = 0;
  let captured: {
    response: ModelResponse;
    firstByteMs: number | null;
  } | null = null;
  const server = createServer((req, res) => {
    requests++;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const started = performance.now();
      if (req.method !== "POST" || req.url !== "/p/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      const headers: Record<string, string> = { "accept-encoding": "identity" };
      for (const name of ["authorization", "content-type", "accept"])
        if (typeof req.headers[name] === "string")
          headers[name] = req.headers[name] as string;
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      let body = "";
      let firstByteMs: number | null = null;
      let status = 0;
      let contentType = "";
      try {
        const reply = await fetch(upstream, {
          method: "POST",
          headers,
          body: Buffer.concat(chunks),
          signal: abort.signal,
        });
        status = reply.status;
        contentType = reply.headers.get("content-type") ?? "";
        res.writeHead(status, { "content-type": contentType });
        res.flushHeaders();
        const decoder = new TextDecoder();
        const reader = reply.body?.getReader();
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          firstByteMs ??= Math.round(performance.now() - started);
          body += decoder.decode(value, { stream: true });
          res.write(value);
        }
        body += decoder.decode();
        captured = {
          response: {
            status,
            contentType,
            body: redact(body, key, status >= 400),
          },
          firstByteMs,
        };
        res.end();
      } catch {
        // The provider or the executor ended the exchange early: keep what arrived.
        if (status)
          captured = {
            response: {
              status,
              contentType,
              body: redact(body, key, status >= 400),
              truncated: true,
            },
            firstByteMs,
          };
        res.destroy();
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/p`,
    get requests() {
      return requests;
    },
    get captured() {
      return captured;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

const timeoutMessage = "控件生成已达到本次等待时限";
export interface SkippedAttempt {
  provider: string;
  model: string;
  requirement: string;
  repeat: number;
  reason: string;
}
/**
 * Runs every authorized attempt once, in order. The call count is checked and reported before
 * each send; a provider failure is recorded as that attempt's outcome and never retried. A
 * selection that fails at the provider stage stopAfterProviderFailures times in a row stops;
 * its remaining attempts are reported as skipped, never sent.
 */
export async function runLive(
  auth: LiveAuthorization,
  set: RequirementSet,
  env: Record<string, string | undefined>,
  hooks: {
    beforeCall: (calls: number) => void;
    onAttempt: (fixture: Fixture, executed: Executed) => void;
  },
) {
  let calls = 0;
  const results: Executed[] = [];
  const skipped: SkippedAttempt[] = [];
  for (const selection of auth.selections) {
    let consecutive = 0;
    for (const requirementId of auth.requirements)
      for (let repeat = 1; repeat <= auth.repeats; repeat++) {
        const requirement = set.requirements.find(
          (r) => r.id === requirementId,
        )!;
        if (consecutive >= auth.stopAfterProviderFailures) {
          skipped.push({
            provider: selection.provider,
            model: selection.model,
            requirement: requirement.id,
            repeat,
            reason: `${consecutive} consecutive provider-stage failures`,
          });
          continue;
        }
        if (++calls > auth.maxCalls)
          throw new Error("authorized call budget exhausted");
        hooks.beforeCall(calls);
        const key = env[selection.keyEnv]!;
        const proxy = await recordingProxy(selection.baseUrl, key);
        let fixture: Fixture;
        let executed: Executed;
        try {
          const execution = await executeAttempt({
            prompt: requirement.prompt,
            endpoint: {
              baseUrl: proxy.baseUrl,
              model: selection.model,
              apiKey: key,
            },
            waitMinutes: auth.waitMinutes,
          });
          if (proxy.requests > 1)
            throw new Error("the executor sent more than one request");
          const captured = proxy.captured;
          const outcome: RecordedOutcome = execution.taskError?.startsWith(
            timeoutMessage,
          )
            ? { kind: "timeout" }
            : captured
              ? { kind: "response" }
              : {
                  kind: "transport",
                  errorClass: execution.thrownClass ?? "network",
                  message: redact(execution.taskError ?? "", key),
                };
          fixture = {
            schemaVersion: 1,
            id: `${selection.provider}.${selection.model
              .toLowerCase()
              .replace(/[^a-z0-9.-]+/g, "-")}.${requirement.id}.r${repeat}`,
            requirement: requirement.id,
            source: "recorded",
            provider: selection.provider,
            model: selection.model,
            repeat,
            recorded: {
              outcome,
              durationMs: execution.durationMs,
              firstByteMs: captured?.firstByteMs ?? null,
              usage: captured ? streamUsage(captured.response.body) : null,
            },
            response: captured?.response ?? null,
          };
          const view =
            outcome.kind === "response" && captured
              ? await inspectResponse(captured.response)
              : null;
          executed = scoreExecution(
            requirement,
            fixture,
            {
              ...execution,
              taskError:
                execution.taskError && redact(execution.taskError, key),
            },
            view,
          );
        } finally {
          await proxy.close();
        }
        results.push(executed);
        consecutive =
          executed.product.failure?.stage === "provider" ? consecutive + 1 : 0;
        hooks.onAttempt(fixture, executed);
      }
  }
  return { executed: results, skipped };
}
