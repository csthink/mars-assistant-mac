import {
  widgetSubmitToolName,
  widgetSubmitParameters,
  widgetToolWireLimit,
  validWidgetSubmission,
} from "../shared/widget-generation-tool";
/** Product-owned MCP process. The launcher clears its environment before execution. */
import { connect } from "node:net";
const [socketPath, token, mode] = process.argv.slice(2);
const generation = mode === "generation";
const wireLimit = generation ? widgetToolWireLimit : 64 * 1024;
if (!socketPath || !token) process.exit(2);
const socket = connect(socketPath);
let buffer = "";
const pending = new Map<string, unknown>();
let count = 0;
function send(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function error(id: unknown) {
  send(id, {
    isError: true,
    content: [
      {
        type: "text",
        text: generation
          ? "控件候选未通过校验或已取消。"
          : "资料读取未获准或已取消。",
      },
    ],
  });
}
socket.setEncoding("utf8");
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(0));
socket.on("data", (chunk: string) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 1024 * 1024) process.exit(1);
  let end: number;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    try {
      const value = JSON.parse(line);
      if (typeof value.id !== "string" || !pending.has(value.id)) continue;
      const original = pending.get(value.id);
      pending.delete(value.id);
      if (value.ok === true && typeof value.text === "string")
        send(original, { content: [{ type: "text", text: value.text }] });
      else error(original);
    } catch {
      process.exit(1);
    }
  }
});
function receive(line: string) {
  if (Buffer.byteLength(line) > wireLimit) process.exit(1);
  try {
    const message = JSON.parse(line);
    if (message.method === "initialize")
      send(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "csthink_assistant", version: "1" },
      });
    else if (message.method === "tools/list")
      send(message.id, {
        tools: [
          {
            name: generation ? widgetSubmitToolName : "read_material",
            description: generation
              ? "Submit a generated widget package for product validation, never retain automatically."
              : "Read a selected material by its attachment identity, subject to user permission.",
            inputSchema: generation
              ? widgetSubmitParameters
              : {
                  type: "object",
                  properties: { attachmentId: { type: "string" } },
                  required: ["attachmentId"],
                  additionalProperties: false,
                },
          },
        ],
      });
    else if (message.method === "tools/call") {
      const args = message.params?.arguments;
      if (
        message.params?.name !==
          (generation ? widgetSubmitToolName : "read_material") ||
        !args ||
        (generation
          ? !validWidgetSubmission(args)
          : Object.keys(args).join(",") !== "attachmentId" ||
            typeof args.attachmentId !== "string" ||
            args.attachmentId.length > 200) ||
        ++count > 16
      )
        return error(message.id);
      const id = String(message.id);
      if (pending.has(id)) return error(message.id);
      pending.set(id, message.id);
      socket.write(
        JSON.stringify({
          id,
          token,
          ...(generation
            ? { package: args.package }
            : { attachmentId: args.attachmentId }),
        }) + "\n",
      );
    } else if (message.id != null)
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method unavailable" },
        }) + "\n",
      );
  } catch {
    process.exit(1);
  }
}
let inputBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  inputBuffer += chunk;
  if (Buffer.byteLength(inputBuffer) > wireLimit) process.exit(1);
  let end: number;
  while ((end = inputBuffer.indexOf("\n")) >= 0) {
    const line = inputBuffer.slice(0, end);
    inputBuffer = inputBuffer.slice(end + 1);
    receive(line);
  }
});
process.stdin.on("end", () => socket.end());
