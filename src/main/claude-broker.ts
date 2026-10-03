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
export const claudeWidgetTool =
  "mcp__csthink_assistant__submit_widget_candidate";
export const claudeReadTool = "mcp__csthink_assistant__read_material";
/** Private local channel owned by one product execution. The model never chooses its identity. */
export async function createClaudeBroker(
  helper: string,
  runTool: (call: ToolCall, signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
  generation = false,
) {
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
                (generation ? "id,package,token" : "attachmentId,id,token") ||
              value.token !== token ||
              typeof value.id !== "string" ||
              value.id.length > 200 ||
              (generation
                ? !validWidgetSubmission({ package: value.package })
                : typeof value.attachmentId !== "string" ||
                  !/^[a-zA-Z0-9_-]{1,200}$/.test(value.attachmentId)) ||
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
                  name: generation ? widgetSubmitToolName : readToolName,
                  arguments: JSON.stringify(
                    generation
                      ? { package: value.package }
                      : { attachmentId: value.attachmentId },
                  ),
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
            ...(generation ? ["generation"] : []),
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
