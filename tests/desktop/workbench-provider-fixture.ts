import { createServer } from "node:http";

/** The placeholder key of the local stand-in; it is not a credential and no provider sees it. */
export const workbenchProviderSecret = "test-secret-workbench-not-a-real-key";

/**
 * A local Chat Completions stand-in: "agent" answers the tool call check by echoing its token, and in a turn
 * offering the workbench tools moves 汇率 to the front with the revision the conversation listed; "notools"
 * refuses the tools parameter. No real provider is reached.
 */
export function workbenchProvider() {
  const requests: { route: string; body: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (part) => (text += part));
    request.on("end", () => {
      const body = JSON.parse(text || "{}") as {
        stream?: boolean;
        tools?: { function: { name: string } }[];
        messages?: { role: string; content: unknown; tool_call_id?: string }[];
      };
      const route = (request.url ?? "").split("/")[1];
      requests.push({ route, body: body as Record<string, unknown> });
      if (route === "notools" && body.tools) {
        response.writeHead(400, { "content-type": "application/json" });
        return response.end(
          JSON.stringify({
            error: { message: "This model does not support tools" },
          }),
        );
      }
      if (body.stream === false) {
        const ask = String(body.messages?.at(-1)?.content ?? "");
        const token = /token 为 (\w+)/.exec(ask)?.[1];
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(
          JSON.stringify({
            choices: [
              {
                message: token
                  ? {
                      content: null,
                      tool_calls: [
                        {
                          id: "probe_1",
                          type: "function",
                          function: {
                            name: "report_tool_probe",
                            arguments: JSON.stringify({ token }),
                          },
                        },
                      ],
                    }
                  : { content: "连接测试成功" },
              },
            ],
          }),
        );
      }
      const tools = (body.tools ?? []).map((t) => t.function.name);
      const answered = (body.messages ?? []).filter((m) => m.role === "tool");
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (value: unknown) =>
        response.write(`data: ${JSON.stringify(value)}\n\n`);
      if (tools.includes("move_workbench_widget") && !answered.length) {
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "move_workbench_widget",
                      arguments: JSON.stringify({
                        name: "汇率",
                        toPosition: 1,
                        orderRevision: 5,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
        send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      } else {
        send({
          choices: [
            {
              delta: {
                content: answered.length ? "已按要求调整。" : "收到。",
              },
            },
          ],
        });
        send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      }
      response.end("data: [DONE]\n\n");
    });
  });
  return { server, requests };
}
