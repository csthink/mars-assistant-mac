import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { runToolLoop, materialTool } from "../../src/main/tool-loop";
import {
  streamChat,
  TransportError,
  type ChatMessage,
} from "../../src/main/transport";
import { readToolName } from "../../src/shared/capabilities";
const attachmentId = "00000000-0000-4000-8000-000000000001";
async function mock(
  fn: (
    body: { messages: ChatMessage[]; tools?: unknown[] },
    n: number,
  ) => unknown[],
) {
  const requests: { messages: ChatMessage[]; tools?: unknown[] }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of fn(body, requests.length))
        res.write(
          `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`,
        );
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: {
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      model: "test-model",
      apiKey: "synthetic-tool-key",
    },
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function tool(
  id = "call_1",
  args = JSON.stringify({ attachmentId }),
  name = readToolName,
) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: "function",
              function: { name, arguments: args },
            },
          ],
        },
      },
    ],
  };
}
const end = (reason = "tool_calls") => ({
  choices: [{ delta: {}, finish_reason: reason }],
});
test("工具流分片完整组装，续接保留调用身份和推理字段，工具结果仅在执行成功后发送", async () => {
  const args = JSON.stringify({ attachmentId });
  const f = await mock((_body, n) =>
    n === 1
      ? [
          {
            choices: [
              {
                delta: {
                  reasoning_content: "provider-reasoning",
                  content: "准备读取",
                },
              },
            ],
          },
          tool("call_1", args.slice(0, 12)),
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: args.slice(12) } },
                  ],
                },
              },
            ],
          },
          end(),
          "[DONE]",
        ]
      : [
          {
            choices: [
              { delta: { content: "已按资料回答" }, finish_reason: "stop" },
            ],
          },
        ],
  );
  try {
    const invoked: string[] = [],
      text: string[] = [];
    await runToolLoop(
      f.endpoint,
      [{ role: "user", content: "读取已选材料" }],
      new AbortController().signal,
      (t) => text.push(t),
      async (c) => {
        invoked.push(c.function.arguments);
        return "授权后的正文";
      },
      200000,
    );
    assert.deepEqual(invoked, [args]);
    assert.equal(text.join(""), "准备读取已按资料回答");
    assert.ok(!JSON.stringify(f.requests[0]).includes("授权后的正文"));
    const second = f.requests[1];
    assert.ok(second.tools?.length);
    assert.equal(second.messages[1].reasoning_content, "provider-reasoning");
    assert.equal(second.messages[2].tool_call_id, "call_1");
    assert.ok(String(second.messages[2].content).includes("授权后的正文"));
  } finally {
    await f.close();
  }
});
test("截断参数、缺少结束标记和未知工具都不调用处理器，普通问答不启用工具", async () => {
  for (const chunks of [
    [tool("call_1", "{"), end(), "[DONE]"],
    [tool(), "[DONE]"],
    [tool("call_1", undefined, "shell"), end()],
  ]) {
    const f = await mock(() => chunks);
    try {
      let count = 0;
      await assert.rejects(
        runToolLoop(
          f.endpoint,
          [{ role: "user", content: "读取" }],
          new AbortController().signal,
          () => {},
          async () => {
            count++;
            return "";
          },
          200000,
        ),
        TransportError,
      );
      assert.equal(count, 0);
    } finally {
      await f.close();
    }
  }
  const f = await mock(() => [tool(), end()]);
  try {
    await assert.rejects(
      streamChat(
        f.endpoint,
        [{ role: "user", content: "普通问答" }],
        new AbortController().signal,
        () => {},
      ),
      (e) => e instanceof TransportError && e.errorClass === "unsupported",
    );
    assert.equal(f.requests[0].tools, undefined);
  } finally {
    await f.close();
  }
});
test("工具循环和重复身份有界，拒绝结果不再请求模型，超预算不发送正文", async () => {
  const f = await mock((_body, n) => [tool(`call_${n}`), end()]);
  try {
    let count = 0;
    await assert.rejects(
      runToolLoop(
        f.endpoint,
        [{ role: "user", content: "读取" }],
        new AbortController().signal,
        () => {},
        async () => {
          count++;
          return "只读结果";
        },
        200000,
      ),
    );
    assert.equal(count, 4);
    assert.equal(f.requests.length, 5);
  } finally {
    await f.close();
  }
  const duplicate = await mock(() => [tool(), end()]);
  try {
    let count = 0;
    await assert.rejects(
      runToolLoop(
        duplicate.endpoint,
        [{ role: "user", content: "读取" }],
        new AbortController().signal,
        () => {},
        async () => {
          count++;
          return "结果";
        },
        200000,
      ),
    );
    assert.equal(count, 1);
  } finally {
    await duplicate.close();
  }
  const denied = await mock(() => [tool(), end()]);
  try {
    await assert.rejects(
      runToolLoop(
        denied.endpoint,
        [{ role: "user", content: "读取" }],
        new AbortController().signal,
        () => {},
        async () => {
          throw new Error("denied");
        },
        200000,
      ),
    );
    assert.equal(denied.requests.length, 1);
  } finally {
    await denied.close();
  }
  const budget = await mock(() => [tool(), end()]);
  try {
    await assert.rejects(
      runToolLoop(
        budget.endpoint,
        [{ role: "user", content: "读取" }],
        new AbortController().signal,
        () => {},
        async () => "x".repeat(60000),
        1000,
      ),
    );
    assert.equal(budget.requests.length, 1);
  } finally {
    await budget.close();
  }
});
test("工具参数累计超限或调用索引越界拒绝，取消在途授权后不继续模型请求", async () => {
  for (const chunks of [
    [tool("call_1", "x".repeat(5000)), end()],
    [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 9,
                  id: "x",
                  type: "function",
                  function: { name: readToolName, arguments: "{}" },
                },
              ],
            },
          },
        ],
      },
      end(),
    ],
  ]) {
    const f = await mock(() => chunks);
    try {
      await assert.rejects(
        streamChat(
          f.endpoint,
          [{ role: "user", content: "读取" }],
          new AbortController().signal,
          () => {},
          { tools: [materialTool] },
        ),
        TransportError,
      );
    } finally {
      await f.close();
    }
  }
  const f = await mock(() => [tool(), end()]);
  try {
    const controller = new AbortController();
    await assert.rejects(
      runToolLoop(
        f.endpoint,
        [{ role: "user", content: "读取" }],
        controller.signal,
        () => {},
        async () => {
          controller.abort();
          return "不可发送的正文";
        },
        200000,
      ),
    );
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});
