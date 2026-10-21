import {
  widgetSubmitToolName,
  widgetSubmitParameters,
  widgetToolWireLimit,
  validWidgetSubmission,
} from "../shared/widget-generation-tool";
import {
  workbenchTools,
  parseWorkbenchArguments,
} from "../shared/workbench-tools";
/** Product-owned MCP process. The launcher clears its environment before execution. */
import { connect } from "node:net";
const [socketPath, token, mode] = process.argv.slice(2);
// The tool kinds of this execution: "generation" alone, or any of "material" and "workbench".
const kinds = (mode ?? "material").split(",");
const generation = kinds.includes("generation");
const wireLimit = generation ? widgetToolWireLimit : 64 * 1024;
if (
  !socketPath ||
  !token ||
  kinds.some((k) => !["generation", "material", "workbench"].includes(k)) ||
  new Set(kinds).size !== kinds.length ||
  (generation && kinds.length !== 1)
)
  process.exit(2);
const tools = [
  ...(generation
    ? [
        {
          name: widgetSubmitToolName,
          description:
            "Submit a generated widget package for product validation, never retain automatically.",
          inputSchema: widgetSubmitParameters,
        },
      ]
    : []),
  ...(kinds.includes("material")
    ? [
        {
          name: "read_material",
          description:
            "Read a selected material by its attachment identity, subject to user permission.",
          inputSchema: {
            type: "object",
            properties: { attachmentId: { type: "string" } },
            required: ["attachmentId"],
            additionalProperties: false,
          },
        },
      ]
    : []),
  ...(kinds.includes("workbench")
    ? workbenchTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      }))
    : []),
];
/** Whether a call's arguments have the declared shape of its tool. */
function validArguments(name: string, args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (name === widgetSubmitToolName) return validWidgetSubmission(args);
  if (name === "read_material") {
    const a = args as Record<string, unknown>;
    return (
      Object.keys(a).join(",") === "attachmentId" &&
      typeof a.attachmentId === "string" &&
      a.attachmentId.length <= 200
    );
  }
  return parseWorkbenchArguments(name, JSON.stringify(args)) !== null;
}
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
          : "工具调用未获准、参数无效或已取消。",
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
    else if (message.method === "tools/list") send(message.id, { tools });
    else if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (
        typeof name !== "string" ||
        !tools.some((tool) => tool.name === name) ||
        !validArguments(name, args) ||
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
          tool: name,
          arguments: JSON.stringify(args),
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
