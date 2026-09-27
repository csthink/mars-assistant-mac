import { CodexProcessOwner } from "./codex-process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

export class ClaudeProtocolError extends Error {
  constructor(readonly code: "timeout" | "closed" | "malformed" | "rejected") {
    super(`Claude Code protocol ${code}`);
  }
}
/** Only host control messages are sent during detection. User prompts are a separate operation. */
export class ClaudeRpc {
  readonly process: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private buffer = "";
  private closed = false;
  private closing?: Promise<void>;
  private owner?: CodexProcessOwner;
  onFailure?: (error: Error) => void;
  onMessage?: (value: Record<string, unknown>) => void;
  constructor(
    binary: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
  ) {
    this.process = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      detached: true,
      signal: options.signal,
    });
    if (this.process.pid)
      this.owner = CodexProcessOwner.create(
        this.process.pid,
        () =>
          this.process.exitCode === null && this.process.signalCode === null,
      );
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.resume();
    this.process.stdin.on("error", () => this.fail("closed"));
    this.process.on("error", () => this.fail("closed"));
    this.process.on("close", () => this.fail("closed"));
    this.process.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) {
        this.fail("malformed");
        void this.close();
        return;
      }
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.fail("malformed");
          void this.close();
          return;
        }
      }
    });
  }
  private receive(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ClaudeProtocolError("malformed");
    const item = value as Record<string, unknown>;
    if (item.type === "control_response") {
      const reply = item.response as Record<string, unknown> | undefined;
      if (!reply || typeof reply.request_id !== "string")
        throw new ClaudeProtocolError("malformed");
      const waiter = this.pending.get(reply.request_id);
      if (!waiter) return;
      this.pending.delete(reply.request_id);
      clearTimeout(waiter.timer);
      if (reply.subtype === "success") waiter.resolve(reply.response);
      else waiter.reject(new ClaudeProtocolError("rejected"));
    } else if (item.type === "control_request") {
      // No permission callback can ever grant an operation during discovery.
      if (typeof item.request_id !== "string")
        throw new ClaudeProtocolError("malformed");
      this.send({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: item.request_id,
          error: "Operation unavailable during connection inspection",
        },
      });
    } else this.onMessage?.(item);
  }
  send(value: unknown) {
    if (this.closed || !this.process.stdin.writable)
      throw new ClaudeProtocolError("closed");
    this.process.stdin.write(JSON.stringify(value) + "\n");
  }
  request(
    subtype: string,
    fields: Record<string, unknown> = {},
    timeout = 5000,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new ClaudeProtocolError("closed"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ClaudeProtocolError("timeout"));
      }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send({
          type: "control_request",
          request_id: requestId,
          request: { ...fields, subtype },
        });
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new ClaudeProtocolError("closed"));
      }
    });
  }
  private fail(code: ClaudeProtocolError["code"]) {
    const first = !this.closed;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new ClaudeProtocolError(code));
    }
    this.pending.clear();
    if (first) this.onFailure?.(new ClaudeProtocolError(code));
  }
  async ready() {
    await this.owner?.ready();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.fail("closed");
    this.closing = new Promise<void>((resolve) => {
      if (this.process.exitCode !== null || this.process.signalCode !== null)
        return resolve();
      const timer = setTimeout(() => {
        this.process.kill("SIGKILL");
      }, 1000);
      this.process.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.process.stdin.end();
    });
    this.closing = this.closing.finally(() => this.owner?.close());
    return this.closing;
  }
}
