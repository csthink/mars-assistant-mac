import type { ClaudeRun } from "../shared/claude";
import { ClaudeRpc } from "./claude-rpc";
import { claudeReadTool } from "./claude-broker";
import {
  TransportError,
  validateInputBudget,
  type ChatMessage,
} from "./transport";
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function claudeInput(messages: ChatMessage[], budget: number) {
  validateInputBudget(messages, budget);
  return messages.flatMap((message) => {
    const prefix = {
      type: "text",
      text: `Conversation message (${message.role}):`,
    };
    if (!Array.isArray(message.content))
      return [prefix, { type: "text", text: message.content ?? "" }];
    return [
      prefix,
      ...message.content.map((part) => {
        if (part.type === "text") return part;
        const match =
          /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
            part.image_url.url,
          );
        if (!match)
          throw new TransportError(
            "unsupported",
            "Claude Code 仅支持已导入的图片副本。",
          );
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: match[1],
            data: match[2],
          },
        };
      }),
    ];
  });
}
function claudeFailure(
  code: string,
  detail: string,
  model: string,
  partial: boolean,
) {
  const value = `${code} ${detail}`.toLowerCase();
  let failure: TransportError;
  const prefix = `模型 ${model}：`;
  if (/rate.?limit|quota|usage.?limit|reached.*limit|429/.test(value))
    failure = new TransportError(
      "rate_limit",
      prefix + "用量已达上限或请求受到限流，请稍后重试，或选择其他模型。",
    );
  else if (/auth|not logged in|login|401/.test(value))
    failure = new TransportError(
      "auth",
      prefix + "认证失败，请在终端核对 Claude Code 登录状态后重试。",
    );
  else if (/context|too many tokens|prompt.*long/.test(value))
    failure = new TransportError(
      "context",
      prefix + "内容超过上下文限制，请减少资料或新建对话。",
    );
  else if (
    /image|图片|图像/.test(value) &&
    /size|dimension|resolution|width|height|large|格式|尺寸/.test(value)
  )
    failure = new TransportError(
      "provider",
      prefix + "图片格式、尺寸或大小不符合要求，请调整图片后重试。",
    );
  else if (
    /image|vision|图片|图像/.test(value) &&
    /not support|unsupported|not accept|不支持/.test(value)
  ) {
    failure = new TransportError(
      "unsupported",
      prefix + "提供方明确不支持图片输入，请移除图片或选择其他模型。",
    );
    failure.imageUnsupported = true;
  } else if (/network|connection|timeout|timed.out|overloaded/.test(value))
    failure = new TransportError(
      "network",
      prefix + "连接失败或服务暂时不可用，请稍后重试。",
    );
  else if (/permission|denied/.test(value))
    failure = new TransportError(
      "permission",
      prefix + "本次操作未获允许，请核对授权。",
    );
  else
    failure = new TransportError(
      "provider",
      prefix + "提供方未能完成本次请求，请稍后重试或选择其他模型。",
    );
  if (partial) failure.message += " 已收到的部分回答已保留。";
  return failure;
}
export async function runClaudeSession(options: {
  rpc: ClaudeRpc;
  run: ClaudeRun;
  messages: ChatMessage[];
  tools: boolean;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onSession: (run: ClaudeRun) => Promise<void>;
  budget: number;
}) {
  const { rpc, signal, run } = options;
  signal.throwIfAborted();
  const content = claudeInput(options.messages, options.budget);
  await rpc.ready();
  let initialized = false,
    resultSeen = false,
    streamed = false,
    count = 0,
    chain = Promise.resolve();
  let settle!: (error?: Error) => void;
  const finished = new Promise<void>((resolve, reject) => {
    let done = false;
    settle = (error) => {
      if (done) return;
      done = true;
      if (error) reject(error);
      else resolve();
    };
  });
  void finished.catch(() => {});
  const failure = () =>
    new TransportError(
      "protocol",
      "Claude Code 回合协议或执行身份核对失败，未继续执行。",
    );
  const stopped = async () => {
    try {
      await rpc.request("interrupt", {}, 2000);
    } catch {
      /* Process close remains mandatory before a stopped result. */
    }
    try {
      await rpc.close();
    } finally {
      settle(new DOMException("Stopped", "AbortError"));
    }
  };
  const abort = () => {
    void stopped().catch((error: Error) => settle(error));
  };
  signal.addEventListener("abort", abort, { once: true });
  rpc.onFailure = (error) => {
    if (!resultSeen && !signal.aborted) settle(error);
  };
  rpc.onMessage = (message) => {
    chain = chain
      .then(async () => {
        if (signal.aborted) return;
        if (message.session_id && message.session_id !== run.threadId)
          throw failure();
        const assistant = record(message.message);
        const refusal = record(assistant.stop_details);
        const resultErrors =
          message.type === "result"
            ? JSON.stringify(message.errors ?? message.error ?? "")
            : "";
        if (
          (message.type === "assistant" &&
            (assistant.stop_reason === "refusal" ||
              refusal.type === "refusal")) ||
          /reasoning_extraction|safeguards flagged/.test(resultErrors)
        ) {
          if (!initialized) throw failure();
          const detail =
            refusal.category === "reasoning_extraction" ||
            resultErrors.includes("reasoning_extraction")
              ? "（reasoning_extraction）"
              : "";
          throw new TransportError(
            "provider",
            `模型服务拒绝了本次请求${detail}，回合已停止。${count > 0 ? "已有部分回答已保留。" : ""}`,
          );
        }
        if (
          message.type === "assistant" &&
          message.isApiErrorMessage === true
        ) {
          if (!initialized) throw failure();
          const blocks = Array.isArray(assistant.content)
            ? assistant.content
            : [];
          const detail = blocks
            .map((b) =>
              typeof record(b).text === "string" ? record(b).text : "",
            )
            .join(" ");
          throw claudeFailure(
            String(message.error ?? ""),
            detail,
            run.model,
            count > 0,
          );
        }
        if (message.type === "system" && message.subtype === "init") {
          if (
            message.session_id !== run.threadId ||
            message.model !== run.model ||
            message.permissionMode !== "dontAsk"
          )
            throw failure();
          const tools = message.tools;
          if (
            !Array.isArray(tools) ||
            tools.some(
              (tool) =>
                typeof tool !== "string" ||
                ![
                  ...(options.tools ? [claudeReadTool] : []),
                  "EndConversation",
                ].includes(tool),
            ) ||
            (options.tools && !tools.includes(claudeReadTool)) ||
            !Array.isArray(message.plugins) ||
            message.plugins.length ||
            !Array.isArray(message.skills) ||
            message.skills.length
          )
            throw failure();
          initialized = true;
          await options.onSession(run);
        } else if (message.type === "stream_event") {
          if (!initialized) throw failure();
          const event = record(message.event),
            delta = record(event.delta);
          if (
            event.type === "content_block_delta" &&
            delta.type === "text_delta"
          ) {
            if (
              typeof delta.text !== "string" ||
              (count += delta.text.length) > 2000000
            )
              throw failure();
            streamed = true;
            options.onDelta(delta.text);
          }
        } else if (message.type === "assistant" && !streamed) {
          if (!initialized) throw failure();
          const content = record(message.message).content;
          if (!Array.isArray(content)) throw failure();
          for (const block of content)
            if (record(block).type === "text") {
              const text = record(block).text;
              if (typeof text !== "string" || (count += text.length) > 2000000)
                throw failure();
              options.onDelta(text);
            }
        } else if (message.type === "result") {
          resultSeen = true;
          if (!initialized) throw failure();
          if (message.subtype === "success" && message.is_error !== true)
            settle();
          else {
            throw claudeFailure(
              String(message.subtype ?? ""),
              JSON.stringify(message.error ?? message.errors ?? ""),
              run.model,
              count > 0,
            );
          }
        }
      })
      .catch((error: Error) => {
        settle(error);
        void rpc.close();
      });
  };
  const timer = setTimeout(() => {
    settle(
      new TransportError(
        "stream",
        "Claude Code 回合等待超时，已保留部分回答。",
      ),
    );
    void rpc.close();
  }, 180000);
  try {
    // The product owns canonical history; it cannot claim that a new native session is a resume.
    signal.throwIfAborted();
    rpc.send({
      type: "user",
      uuid: run.turnId,
      session_id: run.threadId,
      message: {
        role: "user",
        content,
      },
    });
    await finished;
    await chain;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    rpc.onMessage = undefined;
    rpc.onFailure = undefined;
  }
}
