import {
  validWidgetStopEvidence,
  type WidgetStopEvidence,
} from "../shared/widget-generation";
import { execFile } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
export interface CodexProcessIdentity {
  pid: number;
  parent: number;
  group: number;
  startSeconds: number;
  startMicros: number;
  path: string;
}
export class CodexProcessError extends Error {
  /** The underlying failure (exit status, timeout or malformed output) for diagnostics; never interpreted. */
  constructor(
    cause?: unknown,
    readonly stopEvidence?: WidgetStopEvidence,
  ) {
    super("Codex process identity or exit could not be confirmed", { cause });
  }
}
let helper: string | undefined;
const helperTimeoutMs = 5000;
/** Main supplies the bundled helper; detection/unit fixtures do not infer a global helper installation. */
export function configureCodexProcessHelper(path: string) {
  helper = path;
}
/** The configured helper path, shared with the execution port's process observer (feature-t30). */
export function processHelperPath(): string | undefined {
  return helper;
}
/** Runs one helper command and parses its JSON line; any failure is a CodexProcessError. */
export function invokeProcessHelper(
  binary: string,
  args: string[],
): Promise<unknown> {
  return invoke(binary, args);
}
function invoke(binary: string, args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        env: { PATH: "/usr/bin:/bin" },
        // 5 s like the discovery probes (KB-228): a freshly built helper's first launch is
        // assessed by macOS and can exceed 1.5 s under load (KB-233); a budget hit is an
        // observation failure, never an inferred state.
        timeout: helperTimeoutMs,
        maxBuffer: 256 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) return reject(new CodexProcessError(error));
        try {
          resolve(JSON.parse(stdout));
        } catch (parse) {
          reject(new CodexProcessError(parse));
        }
      },
    );
  });
}
export class CodexProcessOwner {
  private timer: NodeJS.Timeout | undefined;
  private scan: Promise<void> | undefined;
  private entries = new Map<string, CodexProcessIdentity>();
  private failed = false;
  private binary: string;
  constructor(
    private pid: number,
    private isAlive: () => boolean,
  ) {
    if (!helper) throw new Error("Missing bundled process helper");
    this.binary = helper;
    this.timer = setInterval(() => void this.refresh(), 80);
    this.timer.unref();
    void this.refresh();
  }
  static create(pid: number, isAlive: () => boolean) {
    return helper ? new CodexProcessOwner(pid, isAlive) : undefined;
  }
  private refresh() {
    if (!this.isAlive()) return Promise.resolve();
    return (this.scan ??= (async () => {
      try {
        const rows = await invoke(this.binary, ["scan", String(this.pid)]);
        if (!Array.isArray(rows) || rows.length > 128) throw new Error();
        const root = rows.find((row) => row.pid === this.pid);
        const known = [...this.entries.values()].find(
          (row) => row.pid === this.pid,
        );
        if (!root) {
          if (known || !this.isAlive()) return;
          throw new CodexProcessError();
        }
        if (
          root.parent !== process.pid ||
          (known &&
            (known.startSeconds !== root.startSeconds ||
              known.startMicros !== root.startMicros))
        )
          throw new CodexProcessError();
        for (const row of rows) {
          if (
            !row ||
            ![
              row.pid,
              row.parent,
              row.group,
              row.startSeconds,
              row.startMicros,
            ].every(Number.isSafeInteger) ||
            typeof row.path !== "string"
          )
            throw new Error();
          this.entries.set(
            `${row.pid}:${row.startSeconds}:${row.startMicros}`,
            row,
          );
        }
      } catch {
        this.failed = true;
      }
    })().finally(() => {
      this.scan = undefined;
    }));
  }
  async ready() {
    await this.refresh();
    if (this.failed || !this.entries.size) throw new CodexProcessError();
  }
  identities() {
    return [...this.entries.values()];
  }
  async close() {
    try {
      await this.finishClose();
    } catch (error) {
      throw new CodexProcessError(error, {
        complete: !this.failed && this.entries.size > 0,
        processes: [...this.entries.values()].map(
          ({ pid, startSeconds, startMicros }) => ({
            pid,
            startSeconds,
            startMicros,
          }),
        ),
      });
    }
  }
  private async finishClose() {
    clearInterval(this.timer);
    await this.scan;
    const args = (row: CodexProcessIdentity) => [
      String(row.pid),
      String(row.startSeconds),
      String(row.startMicros),
    ];
    for (const row of this.entries.values())
      if (await invoke(this.binary, ["check", ...args(row)]))
        await invoke(this.binary, ["stop", ...args(row)]);
    const deadline = Date.now() + 2000;
    for (;;) {
      const alive = await Promise.all(
        [...this.entries.values()].map((row) =>
          invoke(this.binary, ["check", ...args(row)]),
        ),
      );
      if (alive.every((value) => value === false)) {
        if (this.failed) throw new CodexProcessError();
        return;
      }
      if (Date.now() > deadline) throw new CodexProcessError();
      await wait(30);
    }
  }
}

/** A check of exact owned identities only. It never sends signals or scans unrelated processes. */
export async function checkOwnedProcessExit(
  evidence: WidgetStopEvidence,
  inspect: (args: string[]) => Promise<unknown> = (args) =>
    helper ? invoke(helper, args) : Promise.reject(new CodexProcessError()),
): Promise<boolean> {
  if (
    !validWidgetStopEvidence(evidence) ||
    !evidence.complete ||
    !evidence.processes.length
  )
    return false;
  try {
    const results = await Promise.all(
      evidence.processes.map((p) =>
        inspect([
          "check",
          String(p.pid),
          String(p.startSeconds),
          String(p.startMicros),
        ]),
      ),
    );
    return results.every((value) => value === false);
  } catch {
    return false;
  }
}
