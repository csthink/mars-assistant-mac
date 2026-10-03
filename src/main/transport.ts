import { toolArgumentsLimit, toolsPerRoundLimit } from "../shared/capabilities";
import { crc32, deflateSync } from "node:zlib";
import type { ErrorClass } from "../shared/protocol";

/**
 * HTTPS transport for Chat Completions providers. Requests go only to the
 * connection's Base URL; the secret is used for one request and never logged.
 */
export interface Endpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}
export class TransportError extends Error {
  /** Set when the provider refused image content specifically; the connection's capability follows. */
  imageUnsupported = false;
  constructor(
    public errorClass: ErrorClass,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}
/** A solid red 224 × 224 PNG: the probe asks the model for its colour, so acceptance alone cannot pass. */
export const probePng = (() => {
  const size = 224;
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(size * 3, Buffer.from([0xe0, 0x10, 0x10])),
  ]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
})();
export const probeQuestion =
  "这张图片是什么颜色？只用一个颜色词回答，不要解释。";
/** The colour words that count as having seen the red probe image, in Chinese and English. */
export const probeColour = /红|赤|red|crimson|scarlet/i;
const imageRefusal =
  /image|vision|multimodal|multi-modal|视觉|图片|图像|content[.\s]*type|unsupported.*(?:type|input)/i;
const contextExceeded =
  /context.?length|context window|maximum context|max(?:imum)? tokens|too many tokens|token limit|input too long|too long|too large|request entity|exceed|超出|超过|长度/i;
/** Non-streaming requests and the header phase of a stream must answer within this window. */
export const requestTimeoutMs = 45_000;
/** The host tells the transport whether the machine has any network; Node alone cannot distinguish offline DNS failures from bad hosts. */
let isOnline: () => boolean = () => true;
export function configureTransport(options: { isOnline?: () => boolean }) {
  if (options.isOnline) isOnline = options.isOnline;
}
/** A stream that stays silent (no bytes at all, reasoning included) for this long is a network timeout. */
export const streamIdleTimeoutMs = 120_000;

/** Joins a path onto the Base URL and refuses anything that leaves its origin. */
export function endpointUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const url = new URL(path.replace(/^\//, ""), base);
  if (url.origin !== base.origin)
    throw new TransportError("address", "请求地址离开了连接的 Base URL。");
  return url;
}
/** Provider error text is reduced to a short, single-line, header-free excerpt. */
export function excerpt(body: string): string {
  let text = body;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const candidate =
      typeof parsed.error === "string"
        ? parsed.error
        : (parsed.error?.message ?? parsed.message);
    if (typeof candidate === "string") text = candidate;
  } catch {
    /* Not JSON: use the raw body excerpt. */
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
export function classifyStatus(
  status: number,
  body: string,
  context: "models" | "chat",
): TransportError {
  const detail = excerpt(body);
  const suffix = detail ? `提供方说明：${detail}` : "";
  if (status === 403 && /terms of service/i.test(detail))
    return new TransportError(
      "provider",
      `HTTP 403：提供方策略拒绝了请求，请查看提供方说明。${suffix}`,
      status,
    );
  if (status === 403)
    return new TransportError(
      "provider",
      `HTTP 403：提供方权限或策略拒绝了请求，请查看提供方说明。${suffix}`,
      status,
    );
  if (status === 401)
    return new TransportError(
      "auth",
      `HTTP ${status}：认证失败，请检查 API key 是否正确且仍然有效。${suffix}`,
      status,
    );
  if (status === 429 || status === 402)
    return new TransportError(
      "rate_limit",
      status === 402
        ? `HTTP 402：账户余额或额度不足，请检查提供方账户。${suffix}`
        : `HTTP 429：请求限流，请稍后重试。${suffix}`,
      status,
    );
  if (context === "chat" && status === 413)
    return new TransportError(
      "context",
      `HTTP 413：请求过大，超过了提供方的请求或上下文限制。请移除或缩减资料后重试。${suffix}`,
      status,
    );
  // Input dimensions are a rejected request, not proof that the model lacks vision.
  if (
    context === "chat" &&
    status === 400 &&
    /(?:height|width|resolution|dimensions|base64|encoding|mime|media_type|image.{0,20}size|宽度|高度|分辨率|图片格式)/i.test(
      detail,
    )
  )
    return new TransportError(
      "provider",
      `HTTP 400：图片格式、尺寸或大小不符合提供方要求，请调整图片后重试。${suffix}`,
      status,
    );
  if (
    context === "chat" &&
    ((status === 400 &&
      imageRefusal.test(detail) &&
      /not support|unsupported|not accept|不支持|only.*text|取值范围\s*\[\s*['"]text['"]\s*\]/i.test(
        detail,
      )) ||
      (status === 404 && /no endpoints.*support image input/i.test(detail)))
  ) {
    const error = new TransportError(
      "unsupported",
      `HTTP ${status}：该模型或接口不接受图片输入。请移除图片，或换用支持图片的连接。${suffix}`,
      status,
    );
    error.imageUnsupported = true;
    return error;
  }
  if (context === "chat" && status === 400 && contextExceeded.test(detail))
    return new TransportError(
      "context",
      `HTTP 400：超出模型上下文或请求限制。请移除或缩减资料后重试。${suffix}`,
      status,
    );
  if (
    context === "chat" &&
    (status === 404 || (status === 400 && /model/i.test(detail)))
  )
    return new TransportError(
      "model",
      `HTTP ${status}：模型不存在或不可用，请核对模型 ID。${suffix}`,
      status,
    );
  if (status === 404)
    return new TransportError(
      "address",
      `HTTP 404：地址下没有该接口，请核对 Base URL 是否包含正确的路径前缀。${suffix}`,
      status,
    );
  return new TransportError(
    "provider",
    `HTTP ${status}：提供方拒绝了请求。${suffix}`,
    status,
  );
}
/** Collects codes and messages along the cause chain, including AggregateError members. */
function causeChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 6)
      return;
    seen.add(value);
    const record = value as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof record.code === "string") parts.push(record.code);
    if (typeof record.message === "string") parts.push(record.message);
    visit(record.cause, depth + 1);
    if (Array.isArray(record.errors))
      for (const member of record.errors) visit(member, depth + 1);
  };
  visit(error, 0);
  return parts.join(" ");
}
export function classifyFailure(error: unknown): TransportError {
  if (error instanceof TransportError) return error;
  const name = (error as { name?: string })?.name;
  if (name === "AbortError")
    return new TransportError("stop_timeout", "请求已取消。");
  if (name === "TimeoutError")
    return new TransportError(
      "network",
      `网络超时：${requestTimeoutMs / 1000} 秒内没有收到响应。`,
    );
  const chain = causeChain(error);
  const online = isOnline();
  const code = (chain.match(
    /\b(ENOTFOUND|ECONNREFUSED|EAI_NODATA|ERR_INVALID_URL|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/,
  ) ?? [])[0];
  // Offline, a hostname cannot resolve at all; that is a network condition, not a wrong address.
  if (
    !online &&
    (!code ||
      [
        "ENOTFOUND",
        "EAI_AGAIN",
        "EAI_NODATA",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "ECONNREFUSED",
      ].includes(code))
  )
    return new TransportError(
      "network",
      `当前没有网络连接${code ? `（${code}）` : ""}。请恢复网络后在“待处理”中重试。`,
    );
  if (
    code &&
    ["ENOTFOUND", "ECONNREFUSED", "EAI_NODATA", "ERR_INVALID_URL"].includes(
      code,
    )
  )
    return new TransportError(
      "address",
      `无法连接到该地址（${code}），请核对 Base URL 与网络。`,
    );
  if (code && /CERT|TLS|SELF_SIGNED|VERIFY/.test(code))
    return new TransportError(
      "address",
      `证书校验失败（${code}），该地址的 HTTPS 证书不可信。`,
    );
  if (/bad port/i.test(chain))
    return new TransportError(
      "address",
      "该端口不允许访问，请核对 Base URL 中的端口。",
    );
  if (/unexpected redirect/i.test(chain))
    return new TransportError(
      "protocol",
      "该地址返回了重定向，应用不跟随跨地址跳转；请填写最终的 Base URL。",
    );
  if (code)
    return new TransportError(
      "network",
      `网络错误（${code}），请检查网络连接后重试。`,
    );
  if (error instanceof SyntaxError)
    return new TransportError("protocol", "响应不是有效的 JSON。");
  const detail = chain.replace(/\s+/g, " ").trim().slice(0, 160);
  return new TransportError(
    "network",
    `网络请求失败${detail ? `：${detail}` : ""}。请检查网络连接与地址。`,
  );
}
async function send(
  endpoint: Endpoint,
  path: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  context: "models" | "chat",
): Promise<unknown> {
  const url = endpointUrl(endpoint.baseUrl, path);
  if (!/^[\x21-\x7e]+$/.test(endpoint.apiKey))
    throw new TransportError(
      "auth",
      "已保存的 API key 含有无法放入 HTTP 头的字符，请重新填写密钥。",
    );
  const signals = [AbortSignal.timeout(requestTimeoutMs)];
  if (signal) signals.push(signal);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${endpoint.apiKey}`,
        accept: "application/json",
        ...(init.headers ?? {}),
      },
      redirect: "error",
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    throw classifyFailure(error);
  }
  const body = await response.text().catch(() => "");
  if (!response.ok) throw classifyStatus(response.status, body, context);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json"))
    throw new TransportError(
      "protocol",
      `响应类型不是 JSON（${type || "未知"}），该地址可能不是 Chat Completions 接口。`,
    );
  try {
    return JSON.parse(body);
  } catch {
    throw new TransportError("protocol", "响应不是有效的 JSON。");
  }
}
/** GET /models; returns model ids in provider order. */
export async function listModels(
  endpoint: Endpoint,
  signal?: AbortSignal,
): Promise<string[]> {
  const parsed = (await send(
    endpoint,
    "models",
    { method: "GET" },
    signal,
    "models",
  )) as {
    data?: unknown;
  };
  if (!Array.isArray(parsed.data))
    throw new TransportError("protocol", "模型列表响应缺少 data 数组。");
  const ids = parsed.data
    .map((item) => (item as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string");
  if (ids.length !== parsed.data.length)
    throw new TransportError("protocol", "模型列表条目缺少 id 字段。");
  return ids;
}
/** Minimal non-streaming chat completion proving auth, address, protocol and model. */
export async function probeChat(
  endpoint: Endpoint,
  signal?: AbortSignal,
): Promise<void> {
  const parsed = (await send(
    endpoint,
    "chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
    },
    signal,
    "chat",
  )) as { choices?: unknown };
  if (!Array.isArray(parsed.choices) || !parsed.choices.length)
    throw new TransportError(
      "protocol",
      "问答响应缺少有效的 choices 数组，该地址可能不兼容。",
    );
}
/** Chat Completions content: a plain string, or parts when material or images are attached. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning_details?: unknown[];
}
/** Bound request bytes separately from text context. Image encoding is not text. */
export function validateInputBudget(input: unknown, budget: number) {
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 32 * 1024 * 1024)
    throw new TransportError(
      "context",
      "图片与文本的请求大小超过 32 MB，请减少图片或缩小图片后重试。",
    );
  const text = JSON.stringify(input, (_key, value) =>
    value &&
    typeof value === "object" &&
    ["image", "image_url"].includes(value.type)
      ? { type: "image" }
      : value,
  );
  if (text.length > budget)
    throw new TransportError(
      "context",
      "当前对话超过模型文本上下文预算，请减少文字资料或新建对话。",
    );
}
export function imageProbeMessages(): ChatMessage[] {
  return [
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${probePng}` },
        },
        { type: "text", text: probeQuestion },
      ],
    },
  ];
}
export function requireImageProbeAnswer(answer: string) {
  if (!probeColour.test(answer))
    throw new TransportError(
      "protocol",
      "图片检测未通过：回答未能确认测试图片的颜色，尚不能确认图片能力；可重新检测或直接发送图片尝试。",
    );
}
export interface StreamResult {
  calls: ToolCall[];
  message: ChatMessage;
}
/**
 * Non-streaming request with a solid red image and a colour question. The
 * request being accepted is not enough: the answer must name the colour, since
 * some interfaces accept image parts they never show the model.
 */
export async function probeImage(
  endpoint: Endpoint,
  signal?: AbortSignal,
): Promise<{ described: boolean; answer: string }> {
  const parsed = (await send(
    endpoint,
    "chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: probeQuestion },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${probePng}` },
              },
            ],
          },
        ],
        max_tokens: 300,
        stream: false,
      }),
    },
    signal,
    "chat",
  )) as { choices?: { message?: { content?: unknown } }[] };
  if (!Array.isArray(parsed.choices) || !parsed.choices.length)
    throw new TransportError(
      "protocol",
      "问答响应缺少有效的 choices 数组，该地址可能不兼容。",
    );
  const content = parsed.choices[0]?.message?.content;
  const answer = (
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              typeof (part as { text?: unknown })?.text === "string"
                ? (part as { text: string }).text
                : "",
            )
            .join("")
        : ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return { described: probeColour.test(answer), answer };
}
/**
 * Streams a Chat Completions response and forwards text deltas. Resolves when
 * the provider ends the stream normally; a cut stream or tool call is a failure
 * while the delivered text remains with the caller.
 */
export async function streamChat(
  endpoint: Endpoint,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (text: string) => void,
  timeouts: {
    headersMs?: number;
    idleMs?: number;
    tools?: ToolDefinition[];
    toolArgumentsLimit?: number;
    totalMs?: number;
  } = {},
): Promise<StreamResult> {
  const url = endpointUrl(endpoint.baseUrl, "chat/completions");
  if (!/^[\x21-\x7e]+$/.test(endpoint.apiKey))
    throw new TransportError(
      "auth",
      "已保存的 API key 含有无法放入 HTTP 头的字符，请重新填写密钥。",
    );
  const headersMs = timeouts.headersMs ?? requestTimeoutMs;
  const idleMs = timeouts.idleMs ?? streamIdleTimeoutMs;
  const absolute = AbortSignal.timeout(timeouts.totalMs ?? 300_000);
  // The timeout owns its own controller so a user stop and a silence timeout stay distinguishable.
  const timeout = new AbortController();
  let timer = setTimeout(() => timeout.abort("headers"), headersMs);
  const armIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => timeout.abort("idle"), idleMs);
  };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.apiKey}`,
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages,
        stream: true,
        ...(timeouts.tools ? { tools: timeouts.tools } : {}),
      }),
      redirect: "error",
      signal: AbortSignal.any([signal, timeout.signal, absolute]),
    });
  } catch (error) {
    clearTimeout(timer);
    if (signal.aborted) throw classifyFailure({ name: "AbortError" });
    if (absolute.aborted)
      throw new TransportError(
        "network",
        "本次模型请求超过总时限，部分结果已保留。",
      );
    if (timeout.signal.aborted)
      throw new TransportError(
        "network",
        `网络超时：${headersMs / 1000} 秒内没有收到响应头。`,
      );
    throw classifyFailure(error);
  }
  if (!response.ok) {
    clearTimeout(timer);
    throw classifyStatus(
      response.status,
      await response.text().catch(() => ""),
      "chat",
    );
  }
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream") && !type.includes("json")) {
    clearTimeout(timer);
    throw new TransportError(
      "protocol",
      `响应类型不是事件流（${type || "未知"}），该地址可能不是 Chat Completions 接口。`,
    );
  }
  if (!response.body) {
    clearTimeout(timer);
    throw new TransportError("protocol", "响应没有正文。");
  }
  armIdle();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  let sawDelta = false;
  let content = "",
    reasoning = "",
    finishReason = "";
  const reasoningDetails: unknown[] = [];
  const calls = new Map<number, ToolCall>();
  const handle = (payload: string) => {
    if (payload === "[DONE]") {
      finished = true;
      return;
    }
    let parsed: {
      choices?: {
        delta?: {
          content?: unknown;
          reasoning_content?: unknown;
          tool_calls?: unknown;
          reasoning_details?: unknown;
        };
        finish_reason?: string | null;
      }[];
      error?: unknown;
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new TransportError("protocol", "事件流中的数据不是有效的 JSON。");
    }
    if (parsed.error !== undefined)
      throw new TransportError(
        "provider",
        `提供方在流中返回错误。提供方说明：${excerpt(JSON.stringify(parsed.error))}`,
      );
    const choice = parsed.choices?.[0];
    if (!choice) return;
    if (choice.delta?.tool_calls !== undefined) {
      if (!timeouts.tools)
        throw new TransportError(
          "unsupported",
          "本回合未启用按需读取，模型提出的工具未执行。",
        );
      if (!Array.isArray(choice.delta.tool_calls))
        throw new TransportError("protocol", "工具调用不是有效数组，未执行。");
      for (const fragment of choice.delta.tool_calls) {
        const part = fragment as {
          index?: unknown;
          id?: unknown;
          type?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        };
        if (
          !part ||
          !Number.isSafeInteger(part.index) ||
          Number(part.index) < 0 ||
          Number(part.index) >= toolsPerRoundLimit ||
          (part.type !== undefined && part.type !== "function")
        )
          throw new TransportError(
            "protocol",
            "工具调用身份或数量无效，未执行。",
          );
        const index = Number(part.index);
        const call = calls.get(index) ?? {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (
          (part.id !== undefined && typeof part.id !== "string") ||
          (part.function?.name !== undefined &&
            typeof part.function.name !== "string") ||
          (part.function?.arguments !== undefined &&
            typeof part.function.arguments !== "string")
        )
          throw new TransportError(
            "protocol",
            "工具调用片段类型无效，未执行。",
          );
        call.id += (part.id as string | undefined) ?? "";
        call.function.name += (part.function?.name as string | undefined) ?? "";
        call.function.arguments +=
          (part.function?.arguments as string | undefined) ?? "";
        if (
          call.id.length > 100 ||
          call.function.name.length > 100 ||
          call.function.arguments.length >
            (timeouts.toolArgumentsLimit ?? toolArgumentsLimit)
        )
          throw new TransportError("protocol", "工具调用参数超限，未执行。");
        calls.set(index, call);
      }
    }
    if (timeouts.tools && typeof choice.delta?.reasoning_content === "string")
      reasoning += choice.delta.reasoning_content;
    if (timeouts.tools && Array.isArray(choice.delta?.reasoning_details))
      reasoningDetails.push(...choice.delta.reasoning_details);
    if (
      reasoning.length > 128_000 ||
      JSON.stringify(reasoningDetails).length > 128_000
    )
      throw new TransportError(
        "context",
        "工具续接信息超过预算，本回合已停止。",
      );
    // Reasoning deltas are activity but not answer text; thinking models may send them for a long while.
    if (typeof choice.delta?.content === "string" && choice.delta.content) {
      sawDelta = true;
      content += choice.delta.content;
      if (content.length > 1_000_000)
        throw new TransportError("context", "输出超过本回合预算。");
      onDelta(choice.delta.content);
    }
    if (choice.finish_reason) {
      finished = true;
      finishReason = choice.finish_reason;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      if (
        buffer.length >
        Math.max(2_000_000, (timeouts.toolArgumentsLimit ?? 0) + 4096)
      )
        throw new TransportError("protocol", "事件流单条消息超限。");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.startsWith("data:")) handle(line.slice(5).trim());
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) handle(tail.slice(5).trim());
  } catch (error) {
    if (signal.aborted) throw classifyFailure({ name: "AbortError" });
    if (absolute.aborted)
      throw new TransportError(
        "network",
        "本次模型请求超过总时限，部分结果已保留。",
      );
    if (timeout.signal.aborted)
      throw new TransportError(
        "network",
        sawDelta
          ? `输出中途超过 ${idleMs / 1000} 秒没有新数据，已收到的部分内容已保留。`
          : `等待输出超时：${idleMs / 1000} 秒内没有收到任何数据。`,
      );
    if (error instanceof TransportError) throw error;
    // The response had started, so a transport failure here is a cut stream, not an unreachable address.
    throw new TransportError(
      "stream",
      sawDelta
        ? "输出在结束前中断，已收到的部分内容已保留。"
        : "提供方在返回任何内容前断开了连接。",
    );
  } finally {
    clearTimeout(timer);
    // Abort the owned request even when the stream cancellation handshake stalls.
    // Cleanup must never keep a stopped caller waiting for a provider response.
    timeout.abort("cleanup");
    void reader.cancel().catch(() => {});
  }
  if (!finished)
    throw new TransportError(
      "stream",
      sawDelta
        ? "输出在结束前中断，已收到的部分内容已保留。"
        : "提供方在返回任何内容前结束了连接。",
    );
  const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]);
  if (ordered.length) {
    if (
      finishReason !== "tool_calls" ||
      ordered.some(
        ([index, call], i) =>
          index !== i ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(call.id) ||
          !call.function.name ||
          !call.function.arguments,
      ) ||
      new Set(ordered.map(([, c]) => c.id)).size !== ordered.length
    )
      throw new TransportError(
        "protocol",
        "工具调用未完整结束或身份重复，未执行。",
      );
    for (const [, call] of ordered) {
      try {
        JSON.parse(call.function.arguments);
      } catch {
        throw new TransportError("protocol", "工具参数没有完整结束，未执行。");
      }
    }
  } else if (finishReason === "tool_calls")
    throw new TransportError("protocol", "工具结束标记缺少调用，未执行。");
  if (
    ["length", "content_filter", "insufficient_system_resource"].includes(
      finishReason,
    )
  )
    throw new TransportError(
      "stream",
      "提供方未完整完成本回合，部分输出已保留。",
    );
  const toolCalls = ordered.map(([, call]) => call);
  return {
    calls: toolCalls,
    message: {
      role: "assistant",
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(reasoningDetails.length
        ? { reasoning_details: reasoningDetails }
        : {}),
    },
  };
}
