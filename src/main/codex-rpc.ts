import { CodexProcessOwner } from "./codex-process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

export class CodexRpcError extends Error {
  constructor(
    public readonly code:
      number | "closed" | "timeout" | "malformed" | "oversized",
  ) {
    super(`Codex protocol: ${code}`);
  }
}
export interface CodexRpcEvents {
  notification(method: string, params: unknown): void;
  request(
    method: string,
    params: unknown,
    id: string | number,
  ): Promise<unknown>;
  failure(error: Error): void;
}
/** Bounded JSONL transport. It never forwards raw server errors or executes server requests. */
export class CodexRpc {
  private process: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private owner?: CodexProcessOwner;
  private closing?: Promise<void>;
  private buffer = "";
  private closed = false;
  private incoming = new Set<string | number>();
  private events?: CodexRpcEvents;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    binary: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
    private timeout = 5000,
  ) {
    this.process = spawn(binary, args, {
      ...options,
      stdio: "pipe",
      detached: true,
    });
    if (this.process.pid)
      this.owner = CodexProcessOwner.create(
        this.process.pid,
        () =>
          this.process.exitCode === null && this.process.signalCode === null,
      );
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.receive(chunk));
    // Drain without retaining credentials, paths, raw provider errors, or personal instructions.
    this.process.stderr.resume();
    this.process.stdin.on("error", () =>
      this.fail(new CodexRpcError("closed")),
    );
    this.process.on("error", () => this.fail(new CodexRpcError("closed")));
    this.process.on("exit", () => this.fail(new CodexRpcError("closed")));
  }
  /** The app-server's pid and exit, for records that list inspection processes separately (KB-214). */
  get pid(): number | undefined {
    return this.process.pid;
  }
  get exit(): { code: number | null; signal: NodeJS.Signals | null } {
    return { code: this.process.exitCode, signal: this.process.signalCode };
  }
  private signal(signal: NodeJS.Signals) {
    if (
      this.process.pid &&
      this.process.exitCode === null &&
      this.process.signalCode === null
    ) {
      try {
        process.kill(-this.process.pid, signal);
      } catch {
        /* Already exited. */
      }
    }
  }
  private fail(error: Error) {
    const first = !this.closed;
    this.closed = true;
    this.buffer = "";
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    this.signal("SIGKILL");
    if (first) this.events?.failure(error);
  }
  setEvents(events: CodexRpcEvents) {
    if (this.closed) throw new CodexRpcError("closed");
    this.events = events;
  }
  private receive(chunk: string) {
    if (this.closed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024)
      return this.fail(new CodexRpcError("oversized"));
    let position: number;
    while ((position = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, position);
      this.buffer = this.buffer.slice(position + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error();
        message = parsed as Record<string, unknown>;
      } catch {
        return this.fail(new CodexRpcError("malformed"));
      }
      if (typeof message.method === "string") {
        if (typeof message.id === "number" || typeof message.id === "string") {
          const id = message.id;
          if (!this.events) {
            this.send({
              id,
              error: {
                code: -32601,
                message:
                  "This client does not execute server requests during detection",
              },
            });
          } else if (this.incoming.has(id) || this.incoming.size >= 16) {
            return this.fail(new CodexRpcError("malformed"));
          } else {
            this.incoming.add(id);
            Promise.resolve()
              .then(() =>
                this.events!.request(
                  message.method as string,
                  message.params,
                  id,
                ),
              )
              .then(
                (result) => {
                  this.send({ id, result });
                },
                () => {
                  this.send({
                    id,
                    error: {
                      code: -32601,
                      message: "Request refused by the application",
                    },
                  });
                },
              )
              .finally(() => this.incoming.delete(id));
          }
        } else {
          try {
            this.events?.notification(message.method, message.params);
          } catch {
            return this.fail(new CodexRpcError("malformed"));
          }
        }
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = message.error as { code?: unknown };
        pending.reject(
          new CodexRpcError(
            typeof error.code === "number" ? error.code : "malformed",
          ),
        );
      } else if (Object.hasOwn(message, "result"))
        pending.resolve(message.result);
      else pending.reject(new CodexRpcError("malformed"));
    }
  }
  private send(message: unknown) {
    if (!this.closed) this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  async request(method: string, params: unknown = {}): Promise<unknown> {
    await this.owner?.ready();
    if (this.closed) return Promise.reject(new CodexRpcError("closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new CodexRpcError("timeout")),
        this.timeout,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  notify(method: string, params?: unknown) {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }
  close(): Promise<void> {
    return (this.closing ??= this.finishClose());
  }
  private async finishClose() {
    this.events = undefined;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexRpcError("closed"));
    }
    this.pending.clear();
    this.process.stdin.end();
    const end = Date.now() + 1000;
    while (
      this.process.exitCode === null &&
      this.process.signalCode === null &&
      Date.now() < end
    )
      await wait(20);
    this.signal("SIGKILL");
    await this.owner?.close();
  }
}
