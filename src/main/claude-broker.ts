import {
  widgetSubmitToolName,
  widgetToolWireLimit,
  validWidgetSubmission,
} from "../shared/widget-generation-tool";
import { createServer, type Socket } from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  readToolName,
  toolRoundsLimit,
  toolResultLimit,
} from "../shared/capabilities";
import type { ToolCall } from "./transport";
import {
  parseWorkbenchArguments,
  workbenchToolNames,
} from "../shared/workbench-tools";
export const claudeWidgetTool =
  "mcp__csthink_assistant__submit_widget_candidate";
export const claudeReadTool = "mcp__csthink_assistant__read_material";
/** The product tools of one Claude Code execution: widget generation alone, or materials and the workbench. */
export type ClaudeToolKind = "generation" | "material" | "workbench";
/** MCP names (inside the product server) of each kind. */
function mcpNames(kinds: ClaudeToolKind[]) {
  return kinds.flatMap((kind) =>
    kind === "generation"
      ? [widgetSubmitToolName]
      : kind === "material"
        ? ["read_material"]
        : workbenchToolNames,
  );
}
/** Tool names as Claude Code reports and allows them. */
export function claudeToolNames(kinds: ClaudeToolKind[]) {
  return mcpNames(kinds).map((name) => `mcp__csthink_assistant__${name}`);
}
/** The relayed arguments have their tool's declared shape; the product still checks them when it runs. */
function validCall(tool: string, text: string) {
  let args: unknown;
  try {
    args = JSON.parse(text);
  } catch {
    return false;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (tool === widgetSubmitToolName) return validWidgetSubmission(args);
  if (tool === "read_material") {
    const a = args as Record<string, unknown>;
    return (
      Object.keys(a).join(",") === "attachmentId" &&
      typeof a.attachmentId === "string" &&
      /^[a-zA-Z0-9_-]{1,200}$/.test(a.attachmentId)
    );
  }
  return parseWorkbenchArguments(tool, text) !== null;
}
/** Private local channel owned by one product execution. The model never chooses its identity. */
export async function createClaudeBroker(
  helper: string,
  runTool: (call: ToolCall, signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
  kinds: ClaudeToolKind[] = ["material"],
) {
  const generation = kinds.includes("generation");
  const allowed = mcpNames(kinds);
  const root = await mkdtemp("/private/tmp/csthink-mcp-");
  await chmod(root, 0o700);
  const path = join(root, "socket"),
    token = randomUUID();
  const sockets = new Set<Socket>();
  const seen = new Set<string>();
  let active = true,
    calls = 0;
  const server = createServer((socket) => {
    if (!active || sockets.size) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (
        Buffer.byteLength(buffer) >
        (generation ? widgetToolWireLimit : 64 * 1024)
      ) {
        socket.destroy();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        void (async () => {
          let id: string | undefined;
          try {
            const value = JSON.parse(line);
            if (
              !active ||
              signal.aborted ||
              !value ||
              Object.keys(value).sort().join(",") !==
                "arguments,id,token,tool" ||
              value.token !== token ||
              typeof value.id !== "string" ||
              value.id.length > 200 ||
              typeof value.tool !== "string" ||
              !allowed.includes(value.tool) ||
              typeof value.arguments !== "string" ||
              !validCall(value.tool, value.arguments) ||
              seen.has(value.id) ||
              ++calls > toolRoundsLimit
            )
              throw new Error();
            id = value.id;
            seen.add(value.id);
            const text = await runTool(
              {
                id: randomUUID(),
                type: "function",
                function: {
                  // The product names: materials keep their product tool name, the others match.
                  name:
                    value.tool === "read_material" ? readToolName : value.tool,
                  arguments: value.arguments,
                },
              },
              signal,
            );
            if (!active || signal.aborted || text.length > toolResultLimit)
              throw new Error();
            socket.write(JSON.stringify({ id, ok: true, text }) + "\n");
          } catch {
            if (id && !socket.destroyed)
              socket.write(JSON.stringify({ id, ok: false }) + "\n");
            else socket.destroy();
          }
        })();
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    server.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const cancel = () => {
    active = false;
    for (const socket of sockets) socket.destroy();
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  return {
    config: {
      mcpServers: {
        csthink_assistant: {
          command: "/usr/bin/env",
          args: [
            "-i",
            "PATH=/usr/bin:/bin",
            "ELECTRON_RUN_AS_NODE=1",
            process.execPath,
            helper,
            path,
            token,
            kinds.join(","),
          ],
        },
      },
    },
    async close() {
      cancel();
      signal.removeEventListener("abort", cancel);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
